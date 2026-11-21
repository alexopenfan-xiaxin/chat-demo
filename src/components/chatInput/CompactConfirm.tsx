import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './CompactConfirm.module.css'

/** 执行 /compact 前的确认：明确告知细节会丢、原文还在本机、可撤销 */
export const CompactConfirm = ({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('compactConfirmTitle')}
      onClose={onCancel}
      footer={
        <div className={styles.actions}>
          <Button variant="outlined" size="m" onClick={onCancel}>
            {t('compactConfirmCancel')}
          </Button>
          <Button variant="primary" size="m" onClick={onConfirm}>
            {t('compactConfirmOk')}
          </Button>
        </div>
      }
    >
      <p className={styles.body}>{t('compactConfirmBody')}</p>
    </Modal>
  )
}
