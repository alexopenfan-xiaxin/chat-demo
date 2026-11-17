import { IconPanelLeftOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import styles from './Sider.module.css'

const IconSignOut16 = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path
      d="M9.5 2.5H4.2c-.66 0-1.2.54-1.2 1.2v8.6c0 .66.54 1.2 1.2 1.2h5.3"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <path d="M7.5 8h6M11 5.6 13.4 8 11 10.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 收起后左上角的按钮组 */
export const CollapsedSider = ({ onLogout }: { onLogout: () => void }) => {
  const t = useTranslate()
  return (
    <div className={styles.collapsed}>
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          onClick={() => setSiderCollapsed(false)}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={newChat}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<IconSignOut16 />}
          tooltip={t('authLogout')}
          onClick={onLogout}
        />
      </div>
    </div>
  )
}
