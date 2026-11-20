import { describe, expect, it } from 'vitest'
import { splitSpeechSegments, SPEECH_SEGMENT_MAX, SPEECH_SEGMENT_MIN } from '../src/services/speech/segments'

const strip = (value: string) => value.replace(/\s+/g, '')

/** 一段正常的正文：句子长短不一，标点齐全 */
const sample = Array.from(
  { length: 12 },
  (_, index) => `这是第${index + 1}句用来测试分段的内容，它有一点长，大概几十个字，方便凑出合适的段长。`
).join('')

describe('朗读分段', () => {
  it('空文本切出空数组', () => {
    expect(splitSpeechSegments('   ')).toEqual([])
  })

  it('短文本只有一段，不会被切开', () => {
    const segments = splitSpeechSegments('只有一句话。')
    expect(segments).toEqual(['只有一句话。'])
  })

  it('每段都不超过上限', () => {
    const segments = splitSpeechSegments(sample)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(SPEECH_SEGMENT_MAX + SPEECH_SEGMENT_MIN)
    }
  })

  it('不在句子中间断：除最后一段外都以句末标点收尾', () => {
    const segments = splitSpeechSegments(sample)
    for (const segment of segments.slice(0, -1)) {
      expect('。！？!?；;').toContain(segment.at(-1))
    }
  })

  it('顺序拼回去等于原文，不丢字也不重复', () => {
    const segments = splitSpeechSegments(sample)
    expect(strip(segments.join(''))).toBe(strip(sample))
  })

  it('超长单句退到逗号处切，不在词中间硬切', () => {
    const long = Array.from({ length: 40 }, (_, index) => `第${index + 1}个分句内容`).join('，') + '。'
    const segments = splitSpeechSegments(long)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments.slice(0, -1)) {
      // 逗号或句号结尾，说明是在标点处断的
      expect('，。').toContain(segment.at(-1))
    }
    expect(strip(segments.join(''))).toBe(strip(long))
  })

  it('完全没有标点的长串按字数硬切，仍然不超上限', () => {
    const run = '啊'.repeat(500)
    const segments = splitSpeechSegments(run)
    expect(segments.length).toBeGreaterThan(2)
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(SPEECH_SEGMENT_MAX)
    }
    expect(strip(segments.join(''))).toBe(strip(run))
  })

  it('换行也当作句子边界', () => {
    const segments = splitSpeechSegments(`${'甲'.repeat(120)}\n${'乙'.repeat(120)}`)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toBe('甲'.repeat(120))
  })

  it('太短的尾巴并进上一段，不单独占一次请求', () => {
    const head = '丙'.repeat(150) + '。'
    const segments = splitSpeechSegments(`${head}${'丁'.repeat(20)}。`)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toContain('丁'.repeat(20))
  })
})
