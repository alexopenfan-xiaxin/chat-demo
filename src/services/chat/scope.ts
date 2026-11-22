/**
 * 账号存储作用域的状态与判据。
 *
 * 单独一个模块的原因：`chat/db.ts` 在不少测试里是被 mock 掉的，
 * 而「这次异步结果还属不属于当前账号」这个问题在向量、摘要这些地方也要问。
 * 状态放在这里，两边都能引，不会因为 mock 了 db 就把判据一起 mock 掉。
 */
export class ScopeMismatchError extends Error {
  constructor() {
    super('storage_scope_changed')
    this.name = 'ScopeMismatchError'
  }
}

export const isScopeMismatch = (error: unknown): boolean => error instanceof ScopeMismatchError

export const scopeState: { userId: string | null; generation: number; switching: boolean } = {
  /** 当前账号；未登录为 null，此时一切读写都拒绝 */
  userId: null,
  /** 每次切号 +1；旧连接持有的世代一旦过期，它的写入口全部拒绝 */
  generation: 0,
  /** 正在切换：这期间不发新请求、不开新连接 */
  switching: false,
}

export const currentScopeUserId = (): string | null => scopeState.userId

/** 作用域指纹：异步调用开始时取一次，回来时再比一次 */
export const scopeFingerprint = (): string => `${scopeState.userId ?? ''}:${scopeState.generation}`
