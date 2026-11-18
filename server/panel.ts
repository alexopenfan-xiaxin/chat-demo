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
  /** proxy 的内部密钥通道，服务端调用面板时用它过门禁 */
  INTERNAL_API_SECRET?: string
  /** 内部通道专用密钥；拆开后 introspect 那扇门用 INTERNAL_API_SECRET */
  PANEL_SECRET?: string
  /** 建 key 时锁定的来源 IP，逗号分隔；默认本机出口 */
  PANEL_KEY_IP_ALLOWLIST?: string
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const panelBase = (env: PanelEnv): string =>
  (env.UPSTREAM_BASE ?? 'https://api-ds-chat.openfan.dpdns.org').replace(/\/+$/, '')

/**
 * 面板登录拿会话 cookie。
 *
 * 面板所有路径都挂在自己的鉴权后面，而我们的 proxy 又给 `/api/` 加了一道会话门禁。
 * 注册那一刻用户还没登录、根本没有会话票，所以这里走 proxy 的内部密钥通道
 * （`x-internal-secret`）：只对 `/api/` 生效，碰不到 `/v1`。
 */
const login = async (env: PanelEnv): Promise<string | null> => {
  const user = env.PANEL_ADMIN_USER
  const password = env.PANEL_ADMIN_PASSWORD
  const internal = env.PANEL_SECRET ?? env.INTERNAL_API_SECRET
  if (!user || !password || !internal) {
    return null
  }
  const response = await fetch(`${panelBase(env)}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': internal,
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

/**
 * 面板管理员会话缓存。
 *
 * 登录 + 拉列表是两次往返，加起来七八秒；而这是一把管理员会话，跟具体用户无关，
 * 所以按「面板会话」缓存 5 分钟，不是按用户缓存 cookie——这里绝不能让 A 的请求
 * 复用成 B 的身份，因为共用的一直是同一个管理员会话，谁查都在服务端这一侧。
 *
 * 存 isolate 内存里，不做持久化：进程换了重新登录一次，代价只是多两秒。
 */
let panelSession: { cookie: string; at: number } | null = null
/** 并发未命中时只放一个人去登录，其余等它的结果 */
let panelLogin: Promise<string | null> | null = null
const PANEL_SESSION_TTL_MS = 5 * 60 * 1000

const panelCookie = async (env: PanelEnv, force = false): Promise<string | null> => {
  if (!force && panelSession && Date.now() - panelSession.at < PANEL_SESSION_TTL_MS) {
    return panelSession.cookie
  }
  if (!force && panelLogin) {
    return panelLogin
  }
  const attempt = login(env).then((cookie) => {
    panelSession = cookie ? { cookie, at: Date.now() } : null
    return cookie
  })
  panelLogin = attempt
  try {
    return await attempt
  } finally {
    if (panelLogin === attempt) {
      panelLogin = null
    }
  }
}

/**
 * 删掉面板上的一把 key。注册在「建了 key 但写库失败」时用它补偿，
 * 否则面板上会留下一把没人用的孤儿 key。
 */
export const deletePanelKey = async (env: PanelEnv, id: number | null): Promise<boolean> => {
  if (id === null) {
    return false
  }
  const cookie = await panelCookie(env)
  if (!cookie) {
    return false
  }
  const response = await fetch(`${panelBase(env)}/api/keys/${id}`, {
    method: 'DELETE',
    headers: { cookie, 'x-internal-secret': env.PANEL_SECRET ?? env.INTERNAL_API_SECRET ?? '' },
  })
  return response.ok
}

/** 面板给的 key 列表；字段名两种写法都认，认不出就当没有 */
export const listPanelKeys = async (env: PanelEnv): Promise<PanelKey[]> => {
  const headers = (cookie: string) => ({
    cookie,
    'x-internal-secret': env.PANEL_SECRET ?? env.INTERNAL_API_SECRET ?? '',
    'cache-control': 'no-store',
  })
  const fetchKeys = async (cookie: string) => fetch(`${panelBase(env)}/api/keys`, { headers: headers(cookie) })

  const cookie = await panelCookie(env)
  if (!cookie) {
    return []
  }
  let response = await fetchKeys(cookie)
  // 会话过期就丢掉重登一次；别让一条失效 cookie 卡住 5 分钟
  if (response.status === 401 || response.status === 403) {
    const refreshed = await panelCookie(env, true)
    if (!refreshed) {
      return []
    }
    response = await fetchKeys(refreshed)
  }
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
 * 挑出属于这个用户的 key：只按 key 名精确匹配。
 *
 * 名字来自 D1 里该用户自己的 `upstream_key_name`，不再按前缀猜——面板里一旦有多把
 * `ds-chat-*`（多用户下必然如此），前缀匹配就会歧义，猜错就是把别人的用量显示给这个人。
 * 名字为空或者面板里查不到，就返回 null，让页面显示「读不到」，不编数字。
 */
export const pickPanelKey = (keys: PanelKey[], name: string | null): PanelKey | null => {
  if (!name) {
    return null
  }
  return keys.find((key) => key.name === name) ?? null
}

/** 首赠额度（积分）。用户拍板 10，改这一个常量即可。 */
export const SIGNUP_CREDIT_QUOTA = 10

const KEY_MODELS = ['deepseek-v4.1-flash']

/**
 * key 名：`ds-chat-` + 邮箱哈希的 4 位 base36。
 * 用哈希而不是邮箱片段，是为了名字里不带个人信息，又能对同一个邮箱稳定复现。
 */
export const keyNameFor = async (email: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)))
  // 取 6 字节（48 位）刚好覆盖 36^8 的空间
  let value = 0
  for (const byte of digest.slice(0, 6)) {
    value = value * 256 + byte
  }
  // 8 位 base36 ≈ 2.8e12：4 位只有 168 万，1000 个用户时生日悖论下碰撞率约 26%。
  // 面板允许重名，重名会让人在额度页看到别人的用量，所以这里必须放宽。
  const suffix = (value % 2821109907456).toString(36).padStart(8, '0')
  return `ds-chat-${suffix}`
}

export type CreatedKey = { id: number | null; name: string; key: string; quota: number }

/**
 * 注册时建一把属于这个用户的上游 key。
 *
 * `quota_credit` 是首赠积分；注意面板里 `quota_credit: 0` 表示**不限额**，不是零额度，
 * 所以赠送额度绝不能是 0。`models` 只给 flash，`max_ips` 限死 1，来源 IP 固定本机出口。
 */
export const createUpstreamKey = async (env: PanelEnv, email: string): Promise<CreatedKey | null> => {
  const cookie = await panelCookie(env)
  if (!cookie) {
    return null
  }
  const name = await keyNameFor(email)
  const body = {
    name,
    quota_credit: SIGNUP_CREDIT_QUOTA,
    models: KEY_MODELS,
    max_ips: 1,
    // 出口 IP 走配置：写死的话，机器换个出口所有已建 key 一起失效，还查不出原因
    ip_allowlist: (env.PANEL_KEY_IP_ALLOWLIST ?? '43.143.237.221')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  }
  const post = async (session: string) =>
    fetch(`${panelBase(env)}/api/keys`, {
      method: 'POST',
      headers: {
        cookie: session,
        'content-type': 'application/json',
        'x-internal-secret': env.PANEL_SECRET ?? env.INTERNAL_API_SECRET ?? '',
      },
      body: JSON.stringify(body),
    })

  let response = await post(cookie)
  if (response.status === 401 || response.status === 403) {
    const refreshed = await panelCookie(env, true)
    if (!refreshed) {
      return null
    }
    response = await post(refreshed)
  }
  if (!response.ok) {
    return null
  }
  const payload = (await response.json()) as unknown
  const record =
    typeof payload === 'object' && payload !== null && typeof (payload as { key?: unknown }).key === 'object'
      ? ((payload as { key: Record<string, unknown> }).key)
      : (payload as Record<string, unknown>)
  const plain =
    typeof record?.key === 'string'
      ? record.key
      : typeof record?.value === 'string'
        ? record.value
        : typeof record?.plaintext === 'string'
          ? record.plaintext
          : null
  if (!plain) {
    return null
  }
  return {
    id: typeof record.id === 'number' ? record.id : null,
    name: typeof record.name === 'string' ? record.name : name,
    key: plain,
    quota: SIGNUP_CREDIT_QUOTA,
  }
}
