import { describe, expect, it } from 'vitest'
import { toSpeechText } from '../src/services/speech/speechText'

describe('朗读文本转换', () => {
  it('去掉加粗、斜体、删除线的定界符，文字照念', () => {
    expect(toSpeechText('这是**很重**要的*一点*，~~不要~~跳过。')).toBe('这是很重要的一点，不要跳过。')
  })

  it('标题只留文字，不带井号', () => {
    expect(toSpeechText('# 一级标题\n\n## 二级标题\n\n正文。')).toBe('一级标题\n二级标题\n正文。')
  })

  it('列表不念圆点和序号', () => {
    expect(toSpeechText('- 第一项\n- 第二项\n\n1. 甲\n2. 乙')).toBe('第一项\n第二项\n甲\n乙')
  })

  it('引用块去掉大于号', () => {
    expect(toSpeechText('> 引用的一句话。\n> 第二句。')).toBe('引用的一句话。\n第二句。')
  })

  it('分隔线直接丢掉', () => {
    expect(toSpeechText('上面。\n\n---\n\n下面。')).toBe('上面。\n下面。')
  })

  it('行内代码是纯标识符就照念，带符号的换成「代码」', () => {
    expect(toSpeechText('用 `useState` 管理状态。')).toBe('用 useState 管理状态。')
    expect(toSpeechText('调 `file.slice().arrayBuffer()` 拿字节。')).toBe('调 代码 拿字节。')
    expect(toSpeechText('装 `p-map` 就行。')).toBe('装 p-map 就行。')
  })

  it('代码块不念代码，只在第一次出现时提示一句', () => {
    const text = toSpeechText('先看代码：\n\n```ts\nconst a = 1\n```\n\n再看：\n\n```ts\nconst b = 2\n```\n\n结束。')
    expect(text).toBe('先看代码：\n代码略。\n再看：\n结束。')
    expect(text).not.toContain('const')
    expect(text.match(/代码略/g)).toHaveLength(1)
  })

  it('链接只留文字，丢掉地址和括号', () => {
    expect(toSpeechText('参考[官方文档](https://example.com/a?b=1)这一节。')).toBe('参考官方文档这一节。')
  })

  it('图片和 HTML 标签整个丢掉', () => {
    expect(toSpeechText('看这张 ![截图](https://example.com/a.png) 和 <br> 这一行。')).toBe('看这张 和 这一行。')
    expect(toSpeechText('<div align="center">居中</div>')).toBe('居中')
  })

  it('表格去掉竖线和对齐符号，每行念成一句', () => {
    const text = toSpeechText('| 阶段 | 耗时 |\n| --- | ---: |\n| 读取 | 41 ms |\n| 写入 | 38410 ms |')
    expect(text).toBe('阶段，耗时\n读取，41 ms\n写入，38410 ms')
    expect(text).not.toContain('|')
  })

  it('来源角标不念', () => {
    expect(toSpeechText('这个结论有出处[citation:3]，可以查。')).toBe('这个结论有出处，可以查。')
  })

  it('公式不念', () => {
    expect(toSpeechText('公式 $E=mc^2$ 和块级：\n\n$$\na+b\n$$\n\n都跳过。')).toBe('公式 和块级：\n都跳过。')
  })

  it('正常标点原样保留，句号逗号都是停顿', () => {
    expect(toSpeechText('先做这个，再做那个；最后收尾。')).toBe('先做这个，再做那个；最后收尾。')
  })

  it('空正文和只有代码的正文', () => {
    expect(toSpeechText('   ')).toBe('')
    expect(toSpeechText('```\nonly code\n```')).toBe('代码略。')
  })
})

/** 真实回复样本：一条带标题、代码块、列表、表格、链接、图片的完整答复 */
const REAL_REPLY = `完成态和失败态的结构我按「标题区 + 明细区 + 按钮区」三段来，只有中间明细区滚动，标题和按钮钉住不动，这样明细再长，关闭按钮也不会被挤出屏幕。

**卡片**

\`\`\`css
.dialog {
  width: 340px;                  /* 不变 */
  padding: 24px;                 /* 不变 */
  border-radius: 20px;           /* 不变 */
  display: flex; flex-direction: column;
  max-height: calc(100dvh - 48px);   /* 上下各留 24，不贴边 */
}
\`\`\`

**标题区**（固定，不滚动）

- 标题：16 / 600 / 行高 24，与准备态同字号
- 副标题：14 / 500 / 行高 20，颜色 \`#8A8A8E\`（沿用现有 meta）
- 标题 → 副标题：4px；副标题 → 明细区：16px

完成态标题用正常 ink（\`#1A1A1A\` / \`#EDEDED\`），**失败态标题改色**：浅色 \`#C0332E\`（白底 5.59:1），深色 \`#FF7878\`（\`#2C2C2E\` 上 5.47:1）。这两组是我按 WCAG 算的，不是估的。

那个 220 是算出来的，没有凭感觉估：明细区上面 88，下面 84，加上视口留白 48，合计 220。用 \`dvh\` 而不是 \`vh\`，是因为安卓地址栏收起时 \`vh\` 会算错，把按钮顶出屏幕。

还有个小取舍说明：完成态**不要保留进度条**。进度条是「过程」的语言，结果页留一条满格蓝条只会多一行无意义元素，用户还会以为还在跑。

参考 [WCAG 对比度说明](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) 和这张 ![示意图](https://example.com/shot.png)。

| 项 | 值 |
| --- | ---: |
| 关闭按钮 | 292 × 44 |
| 明细上限 | calc(100dvh - 220px) |`

describe('真实回复整段转换', () => {
  const spoken = toSpeechText(REAL_REPLY)

  it('正文里不残留任何 Markdown 标记', () => {
    for (const mark of ['**', '#', '|', '](', '`', '~~~', '> ']) {
      expect(spoken).not.toContain(mark)
    }
  })

  it('代码不念，链接只留文字，图片丢掉', () => {
    expect(spoken).toContain('代码略。')
    expect(spoken).not.toContain('border-radius')
    expect(spoken).toContain('WCAG 对比度说明')
    expect(spoken).not.toContain('https://')
    expect(spoken).not.toContain('示意图')
  })

  it('标题/列表/表格都变成能念的句子', () => {
    expect(spoken).toContain('标题区（固定，不滚动）')
    expect(spoken).toContain('副标题：14 / 500 / 行高 20')
    expect(spoken).toContain('关闭按钮，292 × 44')
  })

  it('正文长度和分段都能拿到', () => {
    expect(spoken.length).toBeGreaterThan(400)
  })
})
