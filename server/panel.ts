/**
 * 上游面板（workbuddy-manager）的管理口，只做一件事：按 key 名查这一条的真实积分。
 *
 * 为什么要走这里：`/v1/usage` 的 `credits` 段没接上（issue #450），恒回 used: 0，
 * 而面板 `/api/keys` 里的 `used_credit` / `quota_credit` 是准的。额度页被它坑的时候
 * 就从这条口子取一次，取不到就照旧显示「读不到」，不编数字。
 *
 * 这个口子只用只读查询。凭据只在服务端环境变量里，不出现在响应、日志和浏览器。
 */

export type PanelKey = {
  name: string
  usedCredit: number | null
  quotaCredit: number | null
  /** 面板自己的 key id，排错用 */
  id: unknown
}

type PanelEnv = {
  /** 面板域名，与聊天链路同一个（隧道域名，不碰裸 IP） */
  UPSTREAM_BASE?: string
  PANEL_ADMIN_USER?: string
  PANEL_ADMIN_PASSWORD?: string
  /** 现有唯一用户绑的那把 key 的名字；多 key 落地后由 D1 逐用户提供 */
  PANEL_KEY_NAME?: string
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const panelBase = (env: PanelEnv): string =>
  (env.UPSTREAM_BASE ?? 'https://api-ds-chat.openfan.dpdns.org').replace(/\/+$/, '')

/**
 * 面板登录拿会话 cookie。
 *
 * 面板所有路径都挂了自己的鉴权，所以除了表单本身，还要带上 ds-chat 的会话票
 * （`x-ds-chat-auth`），否则请求在 proxy 那一层就被挡回来。
 */
const login = async (
  env: PanelEnv,
  cookieToken: string
): Promise<string | null> => {
  const user = env.PANEL_ADMIN_USER
  const password = env.PANEL_ADMIN_PASSWORD
  if (!user || !password) {
    return null
  }
  const response = await fetch(`${panelBase(env)}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ds-chat-auth': cookieToken,
    },
    body: JSON.stringify({ username: user, password }),
  })
  if (!response.ok) {
    return null
  }
  // 只取 wb_session 这一段，别的一律不带回去
  const raw = response.headers.getSetCookie?.() ?? []
  const cookies = raw
    .map((line) => line.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.startsWith('wb_session='))
  return cookies.length > 0 ? cookies.join('; ') : null
}

/** 面板给的 key 列表；字段名两种写法都认，认不出就当没有 */
export const listPanelKeys = async (
  env: PanelEnv,
  cookieToken: string
): Promise<PanelKey[]> => {
  const cookie = await login(env, cookieToken)
  if (!cookie) {
    return []
  }
  const response = await fetch(`${panelBase(env)}/api/keys`, {
    headers: { cookie, 'x-ds-chat-auth': cookieToken, 'cache-control': 'no-store' },
  })
  if (!response.ok) {
    return []
  }
  const payload = (await response.json()) as unknown
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { keys?: unknown }).keys)
      ? ((payload as { keys: unknown[] }).keys)
      : typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
        ? ((payload as { data: unknown[] }).data)
        : []

  return rows.flatMap((row): PanelKey[] => {
    if (typeof row !== 'object' || row === null) {
      return []
    }
    const record = row as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : null
    if (!name) {
      return []
    }
    return [
      {
        name,
        usedCredit: num(record.used_credit ?? record.usedCredit ?? record.used),
        quotaCredit: num(record.quota_credit ?? record.quotaCredit ?? record.quota),
        id: record.id ?? null,
      },
    ]
  })
}

/**
 * 挑出属于这个用户的 key。
 *
 * 现在全站只有一个用户、共用一把 ds-chat key，所以按 key 名精确匹配；
 * 名字没配时只接受「面板里恰好只有一把 ds-chat 开头的 key」这种确定情形，
 * 有多把就返回 null——宁可显示读不到，也不能把别人的用量显示给这个人。
 */
export const pickPanelKey = (keys: PanelKey[], env: PanelEnv): PanelKey | null => {
  const wanted = env.PANEL_KEY_NAME
  if (wanted) {
    return keys.find((key) => key.name === wanted) ?? null
  }
  const candidates = keys.filter((key) => key.name.startsWith('ds-chat'))
  return candidates.length === 1 ? candidates[0] : null
}
