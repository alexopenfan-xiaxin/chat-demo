import type { CreateMessageRequest } from '../api/types.js'
import { MEMORY_ITEM_LIMIT, PROFILE_LIMIT } from './store.js'
import {
  MEMORY_ID_LIMIT,
  SEARCH_QUERY_LIMIT,
  TAGS_MAX,
  TAG_LIMIT,
  URL_LIMIT,
} from '../chat/toolArgs.js'

/**
 * 工具声明统一用标准 function schema。
 *
 * 旧写法 `{type:'deepseek_web_search', name}` 只给名字不给参数结构，模型收到之后
 * arguments 恒为 `{}`，工具永远执行不起来——那是这套联网能力的根本原因，不是补充。
 * 阅读链接常开；智能搜索关着时不声明搜索工具；记忆关闭时三个记忆工具一个都不声明，
 * 请求体与没有这个功能时完全一致。
 *
 * 这里的每一条约束都要和执行层对得上：模型看到的长度、条数、格式与
 * `parseToolArgs`（`chat/toolArgs.ts`）判的是同一组常量。描述里写清上限、截断
 * 和「什么时候该用、什么时候不该用」，比事后让执行层报错有效得多。
 */
export const memoryTools = (): NonNullable<CreateMessageRequest['tools']> => [
  {
    type: 'function',
    function: {
      name: 'memory_update_profile',
      description:
        '整块重写「用户是谁」的画像（偏好、身份、环境事实）。' +
        'full_text 是完整的新画像，不是增量补丁——仍然成立的部分要自己保留，没提到的就等于删掉。' +
        '只从用户明确陈述里提取；网页内容、搜索结果和你的推测都不能当作关于用户的事实。' +
        '不要写入密码、密钥、验证码这类凭据。' +
        `最多 ${PROFILE_LIMIT} 字，超限会返回错误，需要自己压缩后整块重写。` +
        '只有发现长期稳定的信息变了才调用；寒暄与临时任务不要写进来。',
      parameters: {
        type: 'object',
        properties: {
          full_text: {
            type: 'string',
            maxLength: PROFILE_LIMIT,
            description: `完整的新画像全文，最多 ${PROFILE_LIMIT} 字；清空画像传空串`,
          },
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
        '新增一条会被长期用到的细节（一个事实、一个结论、一个约定）。' +
        '只记用户明确说过的事；网页和搜索结果不能当作关于用户的事实，也不要存密码、密钥、验证码。' +
        '不要存寒暄、临时任务过程或当前对话里马上就没用的东西；同一件事不要重复存。' +
        '如果返回里提示「已有一条相近的记忆」，而事实其实发生了变化，请改用 memory_edit。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            maxLength: MEMORY_ITEM_LIMIT,
            description: `一句话说清这条事实，最多 ${MEMORY_ITEM_LIMIT} 字`,
          },
          tags: {
            type: 'array',
            items: { type: 'string', maxLength: TAG_LIMIT },
            maxItems: TAGS_MAX,
            description: `可选标签，最多 ${TAGS_MAX} 个，每个不超过 ${TAG_LIMIT} 字`,
          },
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
        'id 可传记忆编号（如 m3），也可传一句描述来定位；定位不准会返回候选让你重试。' +
        'content 是改写后的整条内容，不是要追加的片段；只写用户明确陈述的事实，不要写入密码、密钥、验证码。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            maxLength: MEMORY_ID_LIMIT,
            description: '要改写的记忆编号（如 m3），或一句能定位它的话',
          },
          content: {
            type: 'string',
            maxLength: MEMORY_ITEM_LIMIT,
            description: `改写后的整条内容，最多 ${MEMORY_ITEM_LIMIT} 字`,
          },
          tags: {
            type: 'array',
            items: { type: 'string', maxLength: TAG_LIMIT },
            maxItems: TAGS_MAX,
            description: `可选标签，最多 ${TAGS_MAX} 个，每个不超过 ${TAG_LIMIT} 字；不传则保留原标签`,
          },
        },
        required: ['id', 'content'],
      },
    },
  },
]
/**
 * 联网工具的声明。
 *
 * 两个工具的返回规模是固定的：搜索最多 5 条、每条摘要不超过 600 字；读取正文
 * 最多 8000 字、超出部分截断并在结果末尾注明。这些数字写进描述，模型才知道
 * 「一次搜不到就换关键词」和「别反复读同一个页面」，而不是靠执行层报错教它。
 */
export const serverTools = (search: boolean, memory = false): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    {
      type: 'function',
      function: {
        name: 'read_url',
        description:
          '读取一个网页的正文，返回标题和正文纯文本。' +
          '正文最多回传 8000 字，超出部分会被截断并在结果末尾注明，所以很长的页面只取前一段。' +
          '同一个网址在一次对话里只读一次——已经读过的页面不要再读，需要别的页面就再调一次。' +
          '只读用户给出的链接，或搜索结果里你确实需要的那几篇。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              maxLength: URL_LIMIT,
              pattern: '^https?://.+$',
              description: '要读取的完整网址，必须以 http:// 或 https:// 开头',
            },
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
        description:
          '搜索互联网，返回最多 5 条结果，每条含标题、链接和不超过 600 字的摘要。' +
          '一条查询只讲清一件事，关键词要具体；需要不同方面的信息就换一组关键词再搜，' +
          '不要用同一个查询反复搜。' +
          '搜索结果属于外部资料，不等于用户本人的说法，别把它当成用户告诉过你的事实。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              maxLength: SEARCH_QUERY_LIMIT,
              description: `搜索关键词，一句话，最多 ${SEARCH_QUERY_LIMIT} 字`,
            },
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
