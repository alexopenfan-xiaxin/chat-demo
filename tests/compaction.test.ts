import { describe, expect, it } from 'vitest'

const {
  CONTEXT_WINDOW,
  KEEP_TOKENS,
  SUMMARY_MAX_TOKENS,
  applyCompaction,
  contextTier,
  estimateTokens,
  formatTokenCount,
  planCompaction,
  readContextUsage,
  roundTokenCosts,
  shouldAutoCompact,
  truncateSummary,
} = await import('../src/services/chat/compaction')

const { getContextRounds } = await import('../src/services/chat/reply')

let seq = 0
const userId = () => `u${++seq}`

const user = (content: string, files: unknown[] = []) =>
  ({ id: userId(), role: 'user', content, files, createdAt: 0 }) as never

const assistant = (text: string, inputTokens: number, outputTokens = 10) =>
  ({
    id: `a${++seq}`,
    role: 'assistant',
    createdAt: 0,
    model: null,
    prefix: true,
    status: 'done',
    blocks: [{ type: 'text', text, citations: [] }],
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: Math.round(inputTokens / 2),
      output_tokens: outputTokens,
    },
  }) as never

/** 造 n 轮，第 i 轮的累计 input 是 (i+1)*STEP */
const makeRounds = (n: number, step = 1_000) =>
  Array.from(
    { length: n },
    (_, i) => [user(`问题${i}`), assistant(`回答${i}`, (i + 1) * step)] as const
  )

const flat = (rounds: readonly (readonly [unknown, unknown])[]) =>
  rounds.flatMap(([u, a]) => [u, a])

describe('按预算切分，不切断轮次', () => {
  it('从尾部累计到预算为止，切分点落在整轮开头', () => {
    const rounds = makeRounds(5)
    const plan = planCompaction(rounds, 2_500)
    expect(plan).not.toBeNull()
    // 每轮约 1010 token：留 2 轮（2020），第 3 轮就超了
    expect(plan?.kept).toBe(2)
    expect(plan?.dropped).toBe(3)
    expect(plan?.keepFrom).toBe(3)
    const kept = flat(rounds.slice(plan?.keepFrom ?? 0))
    expect(kept[0]).toBe(rounds[3][0])
    expect(kept[0]).toMatchObject({ role: 'user' })
    expect(kept[1]).toMatchObject({ role: 'assistant' })
  })

  it('保留部分的总量不超过预算（单轮超预算时例外）', () => {
    const rounds = makeRounds(10)
    const plan = planCompaction(rounds, 5_000)
    expect(plan?.keptTokens).toBeLessThanOrEqual(5_000)
  })

  it('最后一轮永远保留，哪怕它自己就超预算', () => {
    const rounds = makeRounds(3, 500_000)
    const plan = planCompaction(rounds, KEEP_TOKENS)
    expect(plan?.kept).toBe(1)
    expect(plan?.keepFrom).toBe(2)
  })

  it('全部都在预算内时不压缩', () => {
    expect(planCompaction(makeRounds(3), 1_000_000)).toBeNull()
  })

  it('空历史返回 null', () => {
    expect(planCompaction([], KEEP_TOKENS)).toBeNull()
  })

  it('每轮体积按累计 input 的差值算，不重复计算缓存部分', () => {
    const costs = roundTokenCosts(makeRounds(3))
    expect(costs).toEqual([1_010, 1_010, 1_010])
  })
})

describe('四档配色阈值', () => {
  it('45% 起黄、65% 起橙、80% 起红', () => {
    expect(contextTier(0.44)).toBe('normal')
    expect(contextTier(0.45)).toBe('warn')
    expect(contextTier(0.64)).toBe('warn')
    expect(contextTier(0.65)).toBe('high')
    expect(contextTier(0.79)).toBe('high')
    expect(contextTier(0.8)).toBe('critical')
    expect(contextTier(1)).toBe('critical')
  })
})

describe('用量读数', () => {
  it('取最后一条回复的 input_tokens，分母按 1M', () => {
    const messages = flat(makeRounds(2)) as never[]
    const usage = readContextUsage(messages)
    expect(usage.inputTokens).toBe(2_000)
    expect(usage.percent).toBeCloseTo(2_000 / CONTEXT_WINDOW)
    expect(usage.rounds).toBe(2)
    expect(usage.cacheHitRate).toBeCloseTo(0.5)
  })

  it('没有用量的历史按 0 处理，不抛错', () => {
    const usage = readContextUsage([
      user('你好'),
      { ...(assistant('嗯', 0) as object), usage: undefined },
    ] as never[])
    expect(usage.inputTokens).toBe(0)
    expect(usage.cacheHitRate).toBeNull()
    expect(usage.tier).toBe('normal')
  })
})

describe('自动触发', () => {
  const session = (compaction?: unknown) =>
    ({ id: 's', title: '', createdAt: 0, updatedAt: 0, messages: [], compaction }) as never
  const big = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => [user(`q${i}`), assistant(`a${i}`, i === n - 1 ? 850_000 : 1_000)] as never
    )

  it('到 85% 才触发', () => {
    expect(shouldAutoCompact(session(), big(6).flat() as never)).toBe(true)
    const small = Array.from(
      { length: 6 },
      (_, i) => [user(`q${i}`), assistant(`a${i}`, 800_000)] as never
    )
    expect(shouldAutoCompact(session(), small.flat() as never)).toBe(false)
  })

  it('轮次太少不触发', () => {
    const few = Array.from(
      { length: 4 },
      (_, i) => [user(`q${i}`), assistant(`a${i}`, 900_000)] as never
    )
    expect(shouldAutoCompact(session(), few.flat() as never)).toBe(false)
  })

  it('压缩后还没测到新的 input_tokens 时不再触发，避免同一轮反复压', () => {
    const record = {
      id: 'c',
      createdAt: 1,
      summary: 's',
      firstKeptMessageId: null,
      rounds: 3,
      beforeInputTokens: 900_000,
      afterInputTokens: null,
      auto: true,
    }
    expect(shouldAutoCompact(session(record), big(6).flat() as never)).toBe(false)
    expect(
      shouldAutoCompact(session({ ...record, afterInputTokens: 120_000 }), big(6).flat() as never)
    ).toBe(true)
  })
})

describe('组装请求时裁剪', () => {
  it('从切分点开始发送，摘要单独返回', () => {
    const rounds = makeRounds(4)
    const messages = flat(rounds)
    const record = {
      firstKeptMessageId: (messages[4] as { id: string }).id,
      summary: '摘要',
    }
    const result = applyCompaction(messages, record as never)
    expect(result.messages).toHaveLength(4)
    expect(result.messages[0]).toBe(messages[4])
    expect(result.summary).toBe('摘要')
  })

  it('撤销（没有记录）时原文全在，一条不少', () => {
    const messages = flat(makeRounds(4))
    const result = applyCompaction(messages, undefined)
    expect(result.messages).toHaveLength(8)
    expect(result.summary).toBeNull()
  })

  it('切分点找不到时不裁剪，避免丢内容', () => {
    const messages = flat(makeRounds(2))
    const result = applyCompaction(messages, {
      firstKeptMessageId: 'missing',
      summary: '摘要',
    } as never)
    expect(result.messages).toHaveLength(4)
    expect(result.summary).toBe('摘要')
  })

  it('裁剪后的历史仍是成对的轮次', () => {
    const rounds = makeRounds(5)
    const messages = flat(rounds)
    const record = { firstKeptMessageId: (messages[6] as { id: string }).id, summary: '摘要' }
    const { messages: kept } = applyCompaction(messages, record as never)
    const pairs = getContextRounds(kept)
    expect(pairs).toHaveLength(2)
    expect(pairs[0][0]).toBe(messages[6])
  })
})

describe('摘要长度兜底', () => {
  it('超长摘要按 token 上限截断，并在句末断开', () => {
    const long = '这是一段很长的摘要。'.repeat(2_000)
    const cut = truncateSummary(long, SUMMARY_MAX_TOKENS)
    expect(estimateTokens(cut)).toBeLessThanOrEqual(SUMMARY_MAX_TOKENS)
    expect(cut.endsWith('。')).toBe(true)
  })

  it('没超长就原样返回', () => {
    expect(truncateSummary('短摘要')).toBe('短摘要')
  })
})

describe('数字展示', () => {
  it('按 K / M 压缩', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_200)).toBe('1.2K')
    expect(formatTokenCount(123_000)).toBe('123K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
  })
})
