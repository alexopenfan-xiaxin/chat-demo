import { setStorageScope } from './chat/db.js'
import { resetForAccountSwitch } from './chat/store.js'
import { abortTrackedRequests } from './account-abort.js'
import { setImportReportScope } from './chat/history/importReport.js'
import { setSettingsScope } from './settings.js'

/**
 * 切换账号作用域：A 的数据与 B 的数据彼此不可见。
 *
 * 顺序是死的，换个顺序就会漏数据：
 * 1. 先中止所有在跑的流（并清掉待写队列、草稿、内存态）；
 * 2. 再让存储层换作用域——它内部先把世代推进一步（旧连接的写入口立刻开始拒绝）、
 *    等正在进行的事务收尾，最后才置空连接、按新 user.id 打开新库。
 *
 * 未登录（userId 为 null）时同样走一遍：存储层拒绝一切读写，谁也不建库。
 */
export const applyAccountScope = async (userId: string | null): Promise<void> => {
  resetForAccountSwitch()
  // 摘要、记忆重算、记忆工具的向量请求不在 streaming 表里，这里统一掐断
  abortTrackedRequests()
  setSettingsScope(userId)
  setImportReportScope(userId)
  await setStorageScope(userId)
}
