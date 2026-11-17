import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { fetchCredits, type CreditsSnapshot } from '../../services/api/credits.js'
import { loadConversationUsage, type ConversationUsage } from '../../services/credits/usageStats.js'
import { useSettings } from '../../services/settings.js'
import { Modal } from '../base/Modal.js'
import { IconChevronDownOutline14, IconRefreshOutline16 } from '../base/icons.js'
import styles from './CreditsDialog.module.css'

/** 一位小数（积分口径），整数时不留 .0 */
const formatCredits = (value: number) => {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** token 数：过万用「万」，保留一位小数 */
const formatTokens = (value: number) => {
  if (value >= 10000) {
    return `${(Math.round(value / 1000) / 10).toFixed(1)} 万`
  }
  return String(Math.round(value))
}

/** 相对时间：一分钟内「刚刚」，一小时内按分钟，之后给绝对时间 */
const relativeTime = (iso: string, now: number) => {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) {
    return ''
  }
  const diff = Math.max(0, now - time)
  if (diff < 60_000) {
    return 'relJustNow'
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m`
  }
  return new Date(time).toLocaleString()
}

/** 到期时间：0 与 null 都算「长期有效」，数字按 unix 秒/毫秒区分 */
const formatDate = (value: string | number | null) => {
  if (value === null || value === 0 || value === '') {
    return null
  }
  const time =
    typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  if (!Number.isFinite(time)) {
    return null
  }
  return new Date(time).toLocaleDateString()
}

type Status = 'loading' | 'ready' | 'unavailable'

export const CreditsDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [status, setStatus] = useState<Status>('loading')
  const [snapshot, setSnapshot] = useState<CreditsSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [usage, setUsage] = useState<ConversationUsage[]>([])
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      // 服务端配了统一 key 就用它；没配时带上用户自己在设置里填的那把，只用于查额度
      const next = await fetchCredits(useSettings.getState().apiKey ?? undefined)
      setSnapshot(next)
      setStatus(next.credits ? 'ready' : 'unavailable')
    } catch {
      // 网络或上游失败都落到「读不到」：页面主体照样在，只是没有数字
      setStatus((current) => (current === 'ready' ? current : 'unavailable'))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 使用详情全在本机算，不经过后端
    void loadConversationUsage()
      .then(setUsage)
      .catch(() => setUsage([]))
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const credits = snapshot?.credits ?? null
  const unlimited = snapshot?.unlimited === true
  const remaining = credits?.remaining ?? null
  const used = credits?.used ?? null
  const limit = credits?.limit ?? null

  const exhausted = !unlimited && remaining !== null && remaining <= 0
  const ratio = limit && limit > 0 && used !== null ? Math.min(1, used / limit) : null

  // 不限额时唯一有意义的数字是「用掉多少」；读不到时主数字位留一个破折号，不留空
  const mainValue =
    status === 'loading' ? null : status === 'unavailable' ? null : unlimited ? used : remaining
  const mainText = mainValue === null ? '——' : formatCredits(mainValue)
  const mainUnit = unlimited ? t('creditsUnitUsed') : t('creditsUnitRemaining')

  // 上游没给 daily_tokens（或段内没有 used）时不能拿累计值冒充「今日」，换标签
  const todayTokens = snapshot?.dailyTokens?.used ?? null
  const totalTokens = snapshot?.tokens?.used ?? null
  const expires = formatDate(snapshot?.expiresAt ?? null)
  const snapshotText = snapshot ? relativeTime(snapshot.snapshotAt, now) : ''
  const snapshotLabel = snapshotText === 'relJustNow' ? t('creditsJustNow') : snapshotText

  return (
    <Modal title={t('creditsTitle')} closable onClose={onClose}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.snapshot}>{snapshotLabel}</span>
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void load()}
            aria-label={t('creditsRefresh')}
            disabled={refreshing}
          >
            <span className={refreshing ? styles.refreshSpin : undefined}>
              <IconRefreshOutline16 />
            </span>
          </button>
        </div>

        {status === 'loading' ? (
          <>
            <div className={styles.skeletonAmount} />
            <div className={styles.skeletonTrack} />
          </>
        ) : (
          <>
            <div className={styles.main}>
              <span className={[styles.amount, status === 'unavailable' ? styles.amountMuted : ''].join(' ')}>
                {mainText}
              </span>
              <span className={styles.unit}>{status === 'unavailable' ? '' : mainUnit}</span>
            </div>

            {status === 'ready' && !unlimited && ratio !== null ? (
              <>
                <div className={styles.track}>
                  <div
                    className={[styles.fill, exhausted ? styles.fillWarn : ''].join(' ')}
                    style={{ width: `${Math.round(ratio * 100)}%` }}
                  />
                </div>
                <p className={styles.meta}>
                  {t('creditsProgress', {
                    used: used === null ? '—' : formatCredits(used),
                    limit: limit === null ? '—' : formatCredits(limit),
                  })}
                </p>
              </>
            ) : null}

            {status === 'ready' && unlimited ? <p className={styles.meta}>{t('creditsUnlimited')}</p> : null}
            {status === 'unavailable' ? <p className={styles.meta}>{t('creditsUnavailable')}</p> : null}
            {exhausted ? <p className={[styles.notice, styles.noticeWarn].join(' ')}>{t('creditsExhausted')}</p> : null}
          </>
        )}

        {todayTokens !== null || totalTokens !== null ? (
          <div className={styles.todayRow}>
            <p className={styles.todayLine}>
              {todayTokens !== null
                ? t('creditsToday', { value: formatTokens(todayTokens) })
                : t('creditsTotal', { value: formatTokens(totalTokens ?? 0) })}
            </p>
          </div>
        ) : null}

        {usage.length > 0 ? (
          <details className={styles.usageBlock}>
            <summary>
              {t('creditsUsageTitle')}
              <IconChevronDownOutline14 />
            </summary>
            <ul className={styles.usageList}>
              {usage.map((conversation) => (
                <li key={conversation.id} className={styles.usageItem}>
                  <details>
                    <summary className={styles.usageRow}>
                      <span className={styles.usageTitle} title={conversation.title}>
                        {conversation.title}
                      </span>
                      <span className={styles.usageMeta}>
                        {t('creditsUsageRounds', { count: conversation.rounds.length })} ·{' '}
                        {formatTokens(conversation.totalTokens)} token ·{' '}
                        {conversation.hitRate === null
                          ? t('creditsHitNA')
                          : t('creditsHit', { percent: Math.round(conversation.hitRate * 100) })}
                      </span>
                    </summary>
                    <ul className={styles.roundList}>
                      {conversation.rounds.map((round, index) => (
                        <li key={round.id} className={styles.roundRow}>
                          <span className={styles.roundIndex}>
                            {t('creditsRoundIndex', { index: index + 1 })}
                          </span>
                          <span>
                            {t('creditsRoundDetail', {
                              input: formatTokens(round.inputTokens),
                              cached: formatTokens(round.cachedTokens),
                              output: formatTokens(round.outputTokens),
                            })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
            <p className={styles.usageHint}>{t('creditsUsageHint')}</p>
          </details>
        ) : null}

        {snapshot ? (
          <details className={styles.details}>
            <summary>
              {t('creditsDetails')}
              <IconChevronDownOutline14 />
            </summary>
            {snapshot.models.length > 0 ? (
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t('creditsModels')}</span>
                <span className={styles.detailValue}>{snapshot.models.join('、')}</span>
              </div>
            ) : null}
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>{t('creditsExpires')}</span>
              <span className={styles.detailValue}>
                {expires ? t('creditsExpiresAt', { date: expires }) : t('creditsForever')}
              </span>
            </div>
          </details>
        ) : null}
      </div>
    </Modal>
  )
}
