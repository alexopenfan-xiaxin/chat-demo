import { useCallback, useEffect, useState } from 'react'
import { MEMORY_PATH, useRoute } from './route.js'
import { setLogoutHandler } from './sessionActions.js'
import { MemoryPage } from '../components/memory/MemoryPage.js'
import { useTranslate } from '../i18n/index.js'
import { refreshMemoryAvailability } from '../services/memory/api.js'
import { warmLocalModel } from '../services/memory/localEmbed.js'
import { startReindex } from '../services/memory/reindex.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  newChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { AuthScreen } from '../components/auth/AuthScreen.js'
import {
  ensureAccessToken,
  fetchMe,
  logout as logoutRequest,
  onSessionExpired,
  type AuthUser,
} from '../services/auth.js'
import {
  setServiceUnavailable,
  setSessionExpired,
  useSessionState,
} from '../services/sessionState.js'
import authStyles from '../components/auth/AuthScreen.module.css'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  // undefined = 还在问 /api/auth/me，null = 未登录
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)
  const sessionExpired = useSessionState((state) => state.expired)
  const serviceUnavailable = useSessionState((state) => state.unavailable)
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const importProgress = useChatStore((state) => state.importProgress)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  /** 当前会话是否还在列表里：不在列表时「重试」永远不可能成功，只能回新对话 */
  const activeInList = useChatStore((state) =>
    state.activeId === null ? true : state.sessions.some((item) => item.id === state.activeId)
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => onSessionExpired(() => setSessionExpired(true)), [])

  // 服务不可用是瞬时故障：15 秒没有新的失败就自己收起，别一直挂着吓人
  useEffect(() => {
    if (!serviceUnavailable) {
      return
    }
    const timer = window.setTimeout(() => setServiceUnavailable(false), 15000)
    return () => window.clearTimeout(timer)
  }, [serviceUnavailable])

  // 认人 + 换票都落定才算加载完：否则会先渲染已登录、再翻成过期横幅
  useEffect(() => {
    void (async () => {
      const me = await fetchMe()
      if (!me) {
        setUser(null)
        return
      }
      setUser((await ensureAccessToken()) !== null ? me : null)
    })()
  }, [])

  /**
   * 向量模型是本地的：进页面先看模型下没下，下了就把 Worker 里的图建好，
   * 免得用户第一条消息才付那几百毫秒；没下过就什么都不做——24MB 不替用户决定。
   */
  const memoryOn = useSettings((state) => state.memory)
  useEffect(() => {
    if (!user) {
      return
    }
    let cancelled = false
    void (async () => {
      const ready = await refreshMemoryAvailability()
      if (!cancelled && ready && memoryOn) {
        await warmLocalModel()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, memoryOn])

  /**
   * 索引升级：开记忆、且浏览器空闲时才跑，一次页面只起一轮。
   * 开关还是讯飞时 `startReindex` 直接返回，连一次请求都不发。
   */
  useEffect(() => {
    if (!user || !memoryOn) {
      return
    }
    let cancelled = false
    const run = () => {
      if (!cancelled) {
        void startReindex()
      }
    }
    const idle = window.requestIdleCallback
    if (typeof idle === 'function') {
      const handle = idle(run, { timeout: 5000 })
      return () => {
        cancelled = true
        window.cancelIdleCallback(handle)
      }
    }
    const timer = window.setTimeout(run, 3000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [user, memoryOn])

  // 登录之后才碰聊天数据：未登录时不该读本地会话，也不该弹 API Key 设置
  useEffect(() => {
    if (!user) {
      return
    }
    void initChat()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
  }, [user])

  const route = useRoute()

  const onLogout = useCallback(async () => {
    try {
      await logoutRequest()
      setSessionExpired(false)
      setUser(null)
      showToast({ key: 'authLoggedOut' })
    } catch {
      showToast({ key: 'authNetwork', type: 'error' })
    }
  }, [])

  // 退出登录的入口在设置页（侧边栏不再有），这里把动作登记给设置页调用
  useEffect(() => {
    setLogoutHandler(onLogout)
    return () => setLogoutHandler(null)
  }, [onLogout])

  if (user === undefined) {
    return <div className={authStyles.gateLoading}>正在检查登录状态…</div>
  }

  if (user === null) {
    return (
      <AuthScreen
        onAuthenticated={(next) => {
          setSessionExpired(false)
          setUser(next)
        }}
      />
    )
  }

  const relogin = () => {
    setSessionExpired(false)
    setUser(null)
  }

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider user={user} /> : siderCollapsed ? null : <Sider user={user} />}
        <main className={styles.main}>
          {sessionExpired ? (
            <div className={styles.sessionExpired} role="status">
              <span>{t('authSessionExpired')}</span>
              <Button variant="outlined" size="s" onClick={relogin}>
                {t('authSessionExpiredAction')}
              </Button>
            </div>
          ) : serviceUnavailable ? (
            <div className={styles.serviceUnavailable} role="status">
              <span>{t('authServiceUnavailable')}</span>
              <Button variant="outlined" size="s" onClick={() => setServiceUnavailable(false)}>
                {t('authDismiss')}
              </Button>
            </div>
          ) : null}
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {route === MEMORY_PATH ? (
              <MemoryPage />
            ) : importingHistory ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>{t('historyImporting')}</span>
                  <p className={styles.loadingHint}>
                    {importProgress !== null && importProgress.total !== null
                      ? t('historyImportProgress', {
                          done: importProgress.done,
                          total: importProgress.total,
                        })
                      : t('historyImportApprox')}
                  </p>
                </div>
              </div>
            ) : !ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {!ready && initError
                      ? t('sessionListLoadFailed')
                      : sessionLoadError && !activeInList
                        ? t('sessionMissing')
                        : sessionLoadError
                          ? t('sessionLoadFailed')
                          : t('sessionLoading')}
                  </span>
                  {sessionLoadError && !activeInList ? (
                    <p className={styles.loadingHint}>{t('sessionMissingHint')}</p>
                  ) : null}
                  {!ready && initError ? (
                    <Button variant="outlined" size="m" onClick={() => void initChat()}>
                      {t('retry')}
                    </Button>
                  ) : sessionLoadError && !activeInList ? (
                    // 会话不在列表里：重试没有意义，给一个真能走通的出口
                    <Button variant="outlined" size="m" onClick={newChat}>
                      {t('newChat')}
                    </Button>
                  ) : sessionLoadError && activeId !== null ? (
                    <Button variant="outlined" size="m" onClick={() => selectSession(activeId)}>
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <Toast />
    </>
  )
}
