import { describe, expect, it } from 'vitest'
import { parseUsage, resolveUpstreamKey } from '../functions/api/credits'
import { pickPanelKey, type PanelKey } from '../server/panel'

/** 2026-11 实测的上游原始结构，字段位置就是这三处踩过坑的地方 */
const upstream = {
  key: { models: ['deepseek-v4.1-flash'], expires_at: 0 },
  tokens: { used: 2837, limit: null, remaining: null },
  credits: { used: 0, limit: null, remaining: null },
  daily_tokens: { used: 2837, limit: null, remaining: null },
}

describe('parseUsage', () => {
  it('daily_tokens 取对象而不是数字，models 与 expires_at 从 key 下取', () => {
    const snapshot = parseUsage(upstream, true)
    expect(snapshot.dailyTokens).toEqual({ used: 2837, limit: null, remaining: null })
    expect(snapshot.models).toEqual(['deepseek-v4.1-flash'])
    // 0 表示长期有效，不能当成「没有这个字段」
    expect(snapshot.expiresAt).toBe(0)
  })

  it('credits 是有用量却回 0（issue #450）时整段判为不可信', () => {
    const snapshot = parseUsage(upstream, true)
    expect(snapshot.credits).toBeNull()
    expect(snapshot.creditsReliable).toBe(false)
  })

  it('credits 有真实值时原样保留', () => {
    const snapshot = parseUsage(
      {
        ...upstream,
        credits: { used: 12.7, limit: 100, remaining: 87.3 },
      },
      false
    )
    expect(snapshot.credits).toEqual({ used: 12.7, limit: 100, remaining: 87.3 })
    expect(snapshot.creditsReliable).toBe(true)
  })

  it('全新账号 tokens 与 credits 都是 0 时不算「假 0」', () => {
    const snapshot = parseUsage(
      { tokens: { used: 0 }, credits: { used: 0, limit: 100, remaining: 100 } },
      false
    )
    expect(snapshot.creditsReliable).toBe(true)
    expect(snapshot.credits?.remaining).toBe(100)
  })

  it('daily_tokens 退化成裸数字时也能读', () => {
    const snapshot = parseUsage({ tokens: { used: 10 }, daily_tokens: 42 }, false)
    expect(snapshot.dailyTokens).toEqual({ used: 42, limit: null, remaining: null })
  })
})

describe('pickPanelKey', () => {
  const keys: PanelKey[] = [
    { name: 'ds-chat', usedCredit: 0.48, quotaCredit: 0, id: 16 },
    { name: 'ds-chat-f9j1', usedCredit: 0.19, quotaCredit: 10, id: 29 },
    { name: 'ds-bot', usedCredit: 1, quotaCredit: 0, id: 13 },
  ]

  it('按名字精确匹配，面板里有多把 ds-chat 时也不会挑错', () => {
    expect(pickPanelKey(keys, 'ds-chat')?.id).toBe(16)
    expect(pickPanelKey(keys, 'ds-chat-f9j1')?.id).toBe(29)
  })

  it('名字为空或面板里查不到时返回 null，不猜', () => {
    expect(pickPanelKey(keys, null)).toBeNull()
    expect(pickPanelKey(keys, 'ds-chat-missing')).toBeNull()
  })
})

describe('resolveUpstreamKey', () => {
  const decryptOk = async () => 'wbk_user_own_key'

  it('解出 key 且 quota > 0 时按有限额度处理', async () => {
    const result = await resolveUpstreamKey({ enc: 'cipher', quota: 10 }, { KEY_ENC_SECRET: 's' }, decryptOk)
    expect(result.key).toBe('wbk_user_own_key')
    expect(result.unlimited).toBe(false)
  })

  it('quota 0 表示不限额', async () => {
    const result = await resolveUpstreamKey({ enc: 'cipher', quota: 0 }, { KEY_ENC_SECRET: 's' }, decryptOk)
    expect(result.unlimited).toBe(true)
  })

  it('没有密文时返回空 key：这就是 no_key 那条路径，绝不回落到管理员 key', async () => {
    const result = await resolveUpstreamKey(null, { KEY_ENC_SECRET: 's', UPSTREAM_KEY_UNLIMITED: '1' }, decryptOk)
    expect(result.key).toBe('')
  })

  it('解密失败同样返回空 key', async () => {
    const result = await resolveUpstreamKey(
      { enc: 'broken', quota: 10 },
      { KEY_ENC_SECRET: 'rotated' },
      async () => null
    )
    expect(result.key).toBe('')
  })
})
