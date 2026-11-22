import { migrateLegacyOnce } from './legacy-migrate.js'
import * as db from './chat/db.js'
import { sortSessions, useChatStore } from './chat/store.js'
import { showToast } from '../components/base/toastState.js'

/**
 * 旧库一次性迁移：登录后由 App 触发，后台跑，不挡进聊天。
 *
 * 「后台」的具体含义：不 await 在首屏路径上，界面先用当前账号的空库进来，
 * 迁完把侧栏列表刷新一次。失败重试一次——本机 IndexedDB 偶发失败（配额抖动、
 * 别的标签页占着连接）值得再试；再失败只记日志，不打扰用户：数据还在旧库里，没丢。
 */
export const migrateLegacyHistory = async (userId: string): Promise<void> => {
  if (useChatStore.getState().migratingLegacy) {
    return
  }
  useChatStore.setState({ migratingLegacy: true, legacyProgress: null })
  const run = () =>
    migrateLegacyOnce(userId, (done, total) => useChatStore.setState({ legacyProgress: { done, total } }))
  try {
    let result = await run()
    if (result.status === 'failed') {
      result = await run()
    }
    if (result.status === 'done') {
      const summaries = await db.loadSessionSummaries()
      useChatStore.setState({ sessions: sortSessions(summaries) })
      showToast({
        key: 'legacyMigrated',
        params: { sessions: result.stats.sessions, memories: result.stats.memories },
      })
    } else if (result.status === 'failed') {
      // eslint-disable-next-line no-console
      console.warn('[legacy] migration failed twice, old database kept intact', result.error)
    }
  } finally {
    useChatStore.setState({ migratingLegacy: false, legacyProgress: null })
  }
}

