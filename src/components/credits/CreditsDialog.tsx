import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { fetchCredits, type CreditsSnapshot } from '../../services/api/credits.js'
import {
  barWidthPercent,
  creditTone,
  displayRatio,
  formatCredits,
  formatPercent,
} from '../../services/credits/format.js'
import { loadConversationUsage, type ConversationUsage } from '../../services/credits/usageStats.js'
import { Modal } from '../base/Modal.js'
import { IconChevronDownOutline14, IconRefreshOutline16 } from '../base/icons.js'
import styles from './CreditsDialog.module.css'

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
  const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  if (!Number.isFinite(time)) {
    return null
  }
  return new Date(time).toLocaleDateString()
}

type Status = 'loading' | 'ready' | 'unavailable' | 'nokey'

export const CreditsDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [status, setStatus] = useState<Status>('loading')
  const [snapshot, setSnapshot] = useState<CreditsSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [usage, setUsage] = useState<ConversationUsage[]>([])
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (fresh = false) => {
    setRefreshing(true)
    try {
      const next = await fetchCredits(undefined, fresh)
      setSnapshot(next)
      // 「不限额」比「积分读不到」重要：只要知道账号不限额度，页面就不该整块变成读不到
      setStatus(next.noKey ? 'nokey' : next.unlimited || next.credits ? 'ready' : 'unavailable')
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

  /**
   * 警示档按剩余比例算，且「渲染成 <0.01」也算用完：
   * 否则卡片会同时说「剩余 0.00」「棕条」「没有用完提示」三件矛盾的话。
   */
  const tone = creditTone(limit, remaining)
  const exhausted = !unlimited && tone === 'error'
  /**
   * 比例按「显示出来的数字」算：10 / 共 10 必须是 100%，不能是 99%。
   * 超额时比例大于 1（文案写 104%），条本身钳在 100% 不溢出。
   */
  const shownRatio = displayRatio(used, limit)
  const hasBar = shownRatio !== null
  const barWidth = barWidthPercent(used, limit)
  const percentText =
    shownRatio === null || used === null || used <= 0 ? null : formatPercent(shownRatio)
  const barTone = tone === 'error' ? styles.fillError : tone === 'warn' ? styles.fillWarn : ''

  // 不限额时唯一有意义的数字是「用掉多少」；读不到时主数字位留一个破折号，不留空
  const mainValue =
    status === 'loading' || status === 'unavailable' || status === 'nokey'
      ? null
      : unlimited
        ? used
        : remaining
  const mainText = mainValue === null ? '——' : formatCredits(mainValue)
  // 数字都没有时不留单位，只留破折号
  const mainUnit =
    mainValue === null ? '' : unlimited ? t('creditsUnitUsed') : t('creditsUnitRemaining')

  // 上游没给 daily_tokens（或段内没有 used）时不能拿累计值冒充「今日」，换标签
  const todayTokens = snapshot?.dailyTokens?.used ?? null
  const totalTokens = snapshot?.tokens?.used ?? null
  const expires = formatDate(snapshot?.expiresAt ?? null)
  const snapshotText = snapshot ? relativeTime(snapshot.snapshotAt, now) : ''
  const snapshotLabel = snapshotText === 'relJustNow' ? t('creditsJustNow') : snapshotText

  return (
    <Modal
      title={
        <span className={styles.titleRow}>
          <span>{t('creditsTitle')}</span>
          {/* 快照时间和刷新贴着标题右缘同一行，别在标题下再撑出一个空块 */}
          <span className={styles.titleMeta}>
            <span className={styles.snapshot}>{snapshotLabel}</span>
            <button
              type="button"
              className={styles.refresh}
              // 刷新按钮绕过 30 秒缓存，直接读上游
              onClick={() => void load(true)}
              aria-label={t('creditsRefresh')}
              disabled={refreshing}
            >
              <span className={refreshing ? styles.refreshSpin : undefined}>
                <IconRefreshOutline16 />
              </span>
            </button>
          </span>
        </span>
      }
      closable
      onClose={onClose}
    >
      <div className={styles.panel}>
        {status === 'loading' ? (
          <>
            <div className={styles.skeletonAmount} />
            <div className={styles.skeletonTrack} />
          </>
        ) : (
          <>
            <div className={styles.main}>
              <span
                className={[
                  styles.amount,
                  status === 'unavailable' || status === 'nokey' ? styles.amountMuted : '',
                  exhausted ? styles.amountError : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {mainText}
              </span>
              <span className={styles.unit}>{status === 'unavailable' ? '' : mainUnit}</span>
            </div>

            {status === 'ready' && !unlimited && hasBar ? (
              <>
                <div className={styles.track}>
                  <div
                    className={[styles.fill, barTone].filter(Boolean).join(' ')}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <p className={styles.meta}>
                  {t('creditsProgress', {
                    used: used === null ? '—' : formatCredits(used),
                    limit: limit === null ? '—' : formatCredits(limit),
                  })}
                  {percentText === null ? null : ` · ${percentText}`}
                </p>
              </>
            ) : null}

            {status === 'ready' && unlimited ? (
              <p className={styles.meta}>{t('creditsUnlimited')}</p>
            ) : null}
            {status === 'unavailable' ? (
              <p className={styles.meta}>{t('creditsUnavailable')}</p>
            ) : null}
            {status === 'nokey' ? <p className={styles.meta}>{t('creditsNoKey')}</p> : null}
            {exhausted ? (
              <p className={[styles.notice, styles.noticeError].join(' ')}>
                {t('creditsExhausted')}
              </p>
            ) : null}
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
