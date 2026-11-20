import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconBrainOutline, IconPanelLeftOutline16, IconSettingsOutline16, IconWallet16, NewChatIcon } from '../base/icons.js'
import { BrandIcon } from '../base/BrandIcon.js'
import { CreditsDialog } from '../credits/CreditsDialog.js'
import { closeCredits, openCredits, useCreditsDialog } from '../credits/creditsDialogState.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import type { AuthUser } from '../../services/auth.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { MEMORY_PATH, navigateTo } from '../../app/route.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部账号与设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false, user }: { mobile?: boolean; user: AuthUser }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const creditsOpen = useCreditsDialog((state) => state.open)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.titleRow}>
          <BrandIcon size={24} source="small" />
          <div className={styles.appName}>{t('appName')}</div>
        </div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.account}>
        <span className={styles.accountEmail} title={user.email}>
          {user.email}
        </span>
      </div>
      <div className={styles.bottom}>
        <button
          type="button"
          className={styles.settings}
          onClick={() => {
            navigateTo(MEMORY_PATH)
            closeMobileSider()
          }}
        >
          <span className={styles.settingsIcon}>
            <IconBrainOutline size={16} />
          </span>
          <span className={styles.settingsLabel}>{t('memory')}</span>
        </button>
        <button type="button" className={styles.settings} onClick={openCredits}>
          <span className={styles.settingsIcon}>
            <IconWallet16 />
          </span>
          <span className={styles.settingsLabel}>{t('creditsMenu')}</span>
        </button>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {creditsOpen ? <CreditsDialog onClose={closeCredits} /> : null}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    const outcome = await removeSession(deleting.id)
                    if (outcome === 'deleted') {
                      setDeleting(null)
                    } else {
                      // blocked：还在生成，删掉会被随后的保存写回来；busy：正在导入，不是同一种原因
                      showToast({
                        key:
                          outcome === 'blocked'
                            ? 'sessionDeleteBlocked'
                            : outcome === 'busy'
                              ? 'sessionDeleteBusy'
                              : 'sessionDeleteFailed',
                        type: 'error',
                      })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = ({ user }: { user: AuthUser }) => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile user={user} />
      </div>
    </>
  )
}
