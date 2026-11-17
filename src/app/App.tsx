import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
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
import { setSessionExpired, useSessionState } from '../services/sessionState.js'
import authStyles from '../components/auth/AuthScreen.module.css'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  // undefined = 还在问 /api/auth/me，null = 未登录
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)
  const sessionExpired = useSessionState((state) => state.expired)
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
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

  // 认人 + 换票都落定才算加载完：否则会先渲染已登录、再翻成过期横幅
  useEffect(() => {
    void (async () => {
      const me = await fetchMe()
      if (!me) {
        setUser(null)
        return
      }
      setUser((await ensureAccessToken()) ? me : null)
    })()
  }, [])

  // 登录之后才碰聊天数据：未登录时不该读本地会话，也不该弹 API Key 设置
  useEffect(() => {
    if (!user) {
      return
    }
    void initChat()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
  }, [user])

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
        {isMobile ? (
          <MobileSider user={user} onLogout={onLogout} />
        ) : siderCollapsed ? null : (
          <Sider user={user} onLogout={onLogout} />
        )}
        <main className={styles.main}>
          {sessionExpired ? (
            <div className={styles.sessionExpired} role="status">
              <span>{t('authSessionExpired')}</span>
              <Button variant="outlined" size="s" onClick={relogin}>
                {t('authSessionExpiredAction')}
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
            {siderCollapsed ? <CollapsedSider onLogout={onLogout} /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
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
