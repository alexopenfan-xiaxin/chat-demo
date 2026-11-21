import type { CreateMessageRequest } from '../api/types.js'
import { PROFILE_LIMIT } from './store.js'

/**
 * 工具声明统一用标准 function schema。
 *
 * 旧写法 `{type:'deepseek_web_search', name}` 只给名字不给参数结构，模型收到之后
 * arguments 恒为 `{}`，工具永远执行不起来——那是这套联网能力的根本原因，不是补充。
 * 阅读链接常开；智能搜索关着时不声明搜索工具；记忆关闭时三个记忆工具一个都不声明，
 * 请求体与没有这个功能时完全一致。
 */
export const memoryTools = (): NonNullable<CreateMessageRequest['tools']> => [
  {
    type: 'function',
    function: {
      name: 'memory_update_profile',
      description:
        '整块重写「用户是谁」的画像（偏好、身份、环境事实）。只有发现长期稳定的信息变了才调用；' +
        `最多 ${PROFILE_LIMIT} 字，超限会返回错误，需要自己压缩后整块重写。寒暄与临时任务不要写进来。`,
      parameters: {
        type: 'object',
        properties: {
          full_text: { type: 'string', description: '完整的新画像全文，最多 800 字' },
        },
        required: ['full_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description:
        '新增一条会被长期用到的细节（一个事实、一个结论、一个约定）。不要存寒暄、临时任务过程或当前对话里马上就没用的东西；' +
        '同一件事不要重复存。如果返回里提示「已有一条相近的记忆」，而事实其实发生了变化，请改用 memory_edit。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '一句话，最多 200 字' },
          tags: { type: 'array', description: '可选标签，字符串数组' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_edit',
      description:
        '改写一条已经存在的记忆，用于同一件事发生变化的情况（例如「爱吃草莓蛋糕」后来变成「爱吃芒果布丁」）。' +
        'id 可传记忆编号（如 m3），也可传一句描述来定位；定位不准会返回候选让你重试。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '要改写的记忆编号（如 m3），或一句能定位它的话',
          },
          content: { type: 'string', description: '改写后的整条内容，最多 200 字' },
          tags: { type: 'array', description: '可选标签，字符串数组' },
        },
        required: ['id', 'content'],
      },
    },
  },
]
/**
 * 工具声明统一用标准 function schema。
 *
 * 旧写法 `{type:'deepseek_web_search', name}` 只给名字不给参数结构，模型收到之后
 * arguments 恒为 `{}`，工具永远执行不起来——那是这套联网能力的根本原因，不是补充。
 * 阅读链接常开；智能搜索关着时不声明搜索工具。
 */

export const serverTools = (search: boolean, memory = false): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    {
      type: 'function',
      function: {
        name: 'read_url',
        description: '读取一个网页的正文内容，返回标题和正文纯文本',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要读取的完整网址，以 http 或 https 开头' },
          },
          required: ['url'],
        },
      },
    },
  ]
  if (search) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: '搜索互联网，返回若干条结果的标题、链接和摘要',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    })
  }
  // 记忆关闭时不声明：请求体与没有这个功能时完全一致
  if (memory) {
    tools.push(...memoryTools())
  }
  return tools
}
