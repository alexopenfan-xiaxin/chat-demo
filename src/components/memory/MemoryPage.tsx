import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { navigateTo } from '../../app/route.js'
import { useTranslate } from '../../i18n/index.js'
import { useMemoryStatus } from '../../services/memory/api.js'
import {
  MEMORY_ITEM_LIMIT,
  MEMORY_THRESHOLD,
  MEMORY_TOP_K,
  PROFILE_LIMIT,
  addMemoryManually,
  clearAllMemories,
  editMemoryFromPage,
  exportMemories,
  listMemories,
  loadProfile,
  removeMemory,
  searchMemory,
  updateProfile,
  type MemoryHit,
} from '../../services/memory/store.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import type { MemoryEntry } from '../../services/chat/db.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { IconArrowLeftOutline16, IconMemoryOutline14, IconSearchOutline16 } from '../base/icons.js'
import styles from './MemoryPage.module.css'

/**
 * 记忆空间 v2：画像是无条件带上的一段文字，条目是带向量的事实；两者都只存在这台设备。
 * 页面本身不访问服务端，只有「检索预览」会算一次向量。
 *
 * 版式按 /root/work/ds-chat-memory-page-v2.md：Hero 数字三连、画像场域、条目时间轴、
 * 检索相似度条、危险区；桌面 ≥768 变两栏且左栏 sticky（画像常驻，对应「每轮都带上」）。
 */
const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

/** 相对时间：一周内说「几天前」，更久给日期；1 分钟内「刚刚」 */
const relativeTimeKey = (at: number, now: number) => {
  const diff = Math.max(0, now - at)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) {
    return { key: 'memoryTimeJustNow' as const, count: 0 }
  }
  if (diff < hour) {
    return { key: 'memoryTimeMinutes' as const, count: Math.floor(diff / minute) }
  }
  if (diff < day) {
    return { key: 'memoryTimeHours' as const, count: Math.floor(diff / hour) }
  }
  if (diff < 7 * day) {
    return { key: 'memoryTimeDays' as const, count: Math.floor(diff / day) }
  }
  return null
}

export const MemoryPage = () => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const available = useMemoryStatus((state) => state.available)
  const memoryOn = useSettings((state) => state.memory)

  const [profile, setProfile] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [draft, setDraft] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [adding, setAdding] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryHit[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** 删除前要确认：删除不可撤销（prevContent 只覆盖编辑） */
  const [pendingDelete, setPendingDelete] = useState<MemoryEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const profileRef = useRef<HTMLTextAreaElement>(null)
  /** 「3 天前」这类相对时间在进页面时定一次基准，不用定时器重算 */
  const [now] = useState(() => Date.now())

  /** 画像字数三态：≥720（90%）预警、到 800 变色并给竖线换色 */
  const profileCount = [...profile].length
  const countState =
    profileCount >= PROFILE_LIMIT ? 'over' : profileCount >= Math.round(PROFILE_LIMIT * 0.9) ? 'warn' : 'normal'

  const reload = async () => {
    const [text, list] = await Promise.all([loadProfile(), listMemories()])
    setProfile(text)
    setEntries(list)
  }

  // 关闭记忆时这一页不发任何请求、也不读本地记忆：只在打开状态下加载
  useEffect(() => {
    if (!memoryOn) {
      return
    }
    void reload()
  }, [memoryOn])

  // 画像框按内容增高：730 字只显示 4 行的话，用户根本看不见自己写了什么
  useEffect(() => {
    const element = profileRef.current
    if (!element) {
      return
    }
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [profile, memoryOn])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    const onScroll = () => setScrolled(element.scrollTop > 8)
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  const sessionTitle = useMemo(() => {
    const map = new Map(sessions.map((session) => [session.id, session.title || '']))
    return (id: string | null) => (id ? map.get(id) || id : '')
  }, [sessions])

  const size = useMemo(
    () => entries.reduce((total, entry) => total + entry.content.length + entry.vec.byteLength, 0),
    [entries]
  )
  const hitTotal = useMemo(() => entries.reduce((total, entry) => total + entry.hitCount, 0), [entries])

  const saveProfile = async () => {
    setProfileBusy(true)
    try {
      const result = await updateProfile(profile)
      showToast({
        key: result.ok ? 'memorySaved' : 'memorySaveFailed',
        type: result.ok ? undefined : 'error',
      })
    } finally {
      setProfileBusy(false)
    }
  }

  const confirmRemove = async () => {
    const entry = pendingDelete
    if (!entry) {
      return
    }
    setDeleting(true)
    try {
      await removeMemory(entry.id)
      setPendingDelete(null)
      await reload()
      showToast({ key: 'memoryDeleted' })
    } catch {
      // 删失败必须如实说，别让用户以为已经删掉了
      showToast({ key: 'memoryDeleteFailed', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  const add = async () => {
    if (!memoryOn) {
      return
    }
    setDraftBusy(true)
    try {
      const tags = draftTags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
      const result = await addMemoryManually(draft, tags)
      showToast({
        key: result.ok ? 'memorySaved' : 'memorySaveFailed',
        type: result.ok ? undefined : 'error',
      })
      if (result.ok) {
        setDraft('')
        setDraftTags('')
        setAdding(false)
        await reload()
      }
    } finally {
      setDraftBusy(false)
    }
  }

  const commitEdit = async (entry: MemoryEntry) => {
    const ok = await editMemoryFromPage(entry, editingText)
    showToast({ key: ok ? 'memorySaved' : 'memorySaveFailed', type: ok ? undefined : 'error' })
    if (ok) {
      setEditing(null)
      await reload()
    }
  }

  const preview = async () => {
    if (!memoryOn || !query.trim()) {
      return
    }
    setPreviewBusy(true)
    try {
      // 预览必须对应输入的那句话，不许拿上一次的向量冒充
      setHits(await searchMemory(query, null, { staleFallback: false }))
    } finally {
      setPreviewBusy(false)
    }
  }

  const download = async () => {
    const text = await exportMemories()
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'ds-chat-memories.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const clearAll = async () => {
    await clearAllMemories()
    setClearing(false)
    setHits(null)
    await reload()
    showToast({ key: 'memoryCleared' })
  }

  /** 手动新增：时间轴末尾与空状态共用同一份 UI */
  const renderAdd = (centered = false) =>
    adding ? (
      <div className={clsx(styles.addForm, centered && styles.addFormCentered)}>
        <textarea
          className={styles.itemEditor}
          value={draft}
          disabled={!memoryOn}
          maxLength={MEMORY_ITEM_LIMIT}
          placeholder={t('memoryAddPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <input
          className={styles.searchInput}
          value={draftTags}
          disabled={!memoryOn}
          placeholder={t('memoryTagsPlaceholder')}
          onChange={(event) => setDraftTags(event.target.value)}
        />
        <div className={styles.itemEditorActions}>
          <Button variant="outlined" size="s" onClick={() => setAdding(false)}>
            {t('memoryCancel')}
          </Button>
          <Button
            variant="primary"
            size="s"
            disabled={!memoryOn || !draft.trim() || draftBusy}
            onClick={() => void add()}
          >
            {t('memorySave')}
          </Button>
        </div>
      </div>
    ) : (
      <button type="button" className={styles.addTrigger} onClick={() => setAdding(true)}>
        + {t('memoryAddInline')}
      </button>
    )

  return (
    <div className={styles.page} ref={scrollRef}>
      <header className={clsx(styles.topbar, scrolled && styles.topbarScrolled)}>
        <IconButton
          icon={<IconArrowLeftOutline16 />}
          size="m"
          tooltip={t('memoryBack')}
          onClick={() => navigateTo('/')}
        />
        <h1 className={styles.topTitle}>{t('memoryTitle')}</h1>
      </header>

      {memoryOn ? (
        <div className={styles.body}>
          <div className={styles.left}>
            <section className={styles.hero}>
              <h2 className={styles.heroTitle}>{t('memoryTitle')}</h2>
              <p className={styles.heroSub}>{t('memorySubtitle')}</p>
              <div className={styles.stats}>
                <div className={styles.stat}>
                  <span className={styles.statValue}>{entries.length}</span>
                  <span className={styles.statLabel}>{t('memoryStatCountLabel')}</span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statValue}>{formatBytes(size)}</span>
                  <span className={styles.statLabel}>{t('memoryStatSizeLabel')}</span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statValue}>{hitTotal}</span>
                  <span className={styles.statLabel}>{t('memoryStatHitsLabel')}</span>
                </div>
              </div>
            </section>

            <section className={styles.field}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>{t('memoryProfileTitle')}</h3>
                <span
                  className={clsx(
                    styles.sectionMeta,
                    countState === 'warn' && styles.countWarn,
                    countState === 'over' && styles.countOver
                  )}
                >
                  {profileCount} / {PROFILE_LIMIT}
                  {countState === 'over'
                    ? t('memoryOverBy', { count: profileCount - PROFILE_LIMIT })
                    : ''}
                </span>
              </div>
              <textarea
                ref={profileRef}
                className={clsx(
                  styles.profileEditor,
                  countState === 'warn' && styles.countWarn,
                  countState === 'over' && styles.countOver
                )}
                value={profile}
                // 画像上限就是 800，注入时整段带上不截断；输入框直接卡住，边界在打字时就能看见
                maxLength={PROFILE_LIMIT}
                placeholder={t('memoryProfilePlaceholder')}
                onChange={(event) => setProfile(event.target.value)}
              />
              <div className={styles.fieldActions}>
                <Button variant="primary" size="s" disabled={profileBusy} onClick={() => void saveProfile()}>
                  {t('memoryProfileSave')}
                </Button>
              </div>
            </section>
          </div>

          <div className={styles.right}>
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>{t('memoryListTitle')}</h3>
                <span className={styles.sectionMeta}>{entries.length}</span>
              </div>

              {entries.length === 0 ? (
                <div className={styles.empty}>
                  <span className={styles.emptyIcon}>
                    <IconMemoryOutline14 />
                  </span>
                  <p className={styles.emptyTitle}>{t('memoryEmptyTitle')}</p>
                  <p className={styles.emptyHint}>{t('memoryEmptyHint')}</p>
                  <div className={styles.emptyAdd}>{renderAdd(true)}</div>
                </div>
              ) : (
                <div className={styles.timeline}>
                  <span className={styles.track} aria-hidden="true" />
                  {entries.map((entry) => (
                    <article key={entry.id} className={styles.item}>
                      <span
                        className={clsx(styles.node, entry.hitCount > 0 && styles.nodeUsed)}
                        aria-hidden="true"
                      />
                      {/* 元信息左、操作右，同一行：每条各占一行放「编辑/删除」在长列表里是噪音 */}
                      <div className={styles.itemMeta}>
                        <div className={styles.itemMetaText}>
                          <span className={styles.idTag}>{entry.id}</span>
                          <span>·</span>
                          <span className={styles.metaText}>
                            {entry.sessionId ? sessionTitle(entry.sessionId) : t('memoryManual')}
                          </span>
                          <span>·</span>
                          <span>
                            {(() => {
                              const relative = relativeTimeKey(entry.updatedAt, now)
                              if (!relative) {
                                return new Date(entry.updatedAt).toLocaleDateString()
                              }
                              return relative.key === 'memoryTimeJustNow'
                                ? t('memoryTimeJustNow')
                                : t(relative.key, { count: relative.count })
                            })()}
                          </span>
                          {entry.hitCount > 0 ? (
                            <>
                              <span>·</span>
                              <span>{t('memoryHits', { count: entry.hitCount })}</span>
                            </>
                          ) : null}
                        </div>
                        {editing === entry.id ? null : (
                          <div className={styles.itemLinks}>
                            <button
                              type="button"
                              className={styles.textButton}
                              onClick={() => {
                                setEditing(entry.id)
                                setEditingText(entry.content)
                              }}
                            >
                              {t('memoryEdit')}
                            </button>
                            <button
                              type="button"
                              className={clsx(styles.textButton, styles.textButtonDanger)}
                              onClick={() => setPendingDelete(entry)}
                            >
                              {t('memoryDelete')}
                            </button>
                          </div>
                        )}
                      </div>

                      {editing === entry.id ? (
                        <>
                          <textarea
                            className={styles.itemEditor}
                            value={editingText}
                            maxLength={MEMORY_ITEM_LIMIT}
                            onChange={(event) => setEditingText(event.target.value)}
                          />
                          <div className={styles.itemEditorActions}>
                            <Button variant="outlined" size="s" onClick={() => setEditing(null)}>
                              {t('memoryCancel')}
                            </Button>
                            <Button variant="primary" size="s" onClick={() => void commitEdit(entry)}>
                              {t('memorySave')}
                            </Button>
                          </div>
                        </>
                      ) : (
                        <p className={styles.content}>{entry.content}</p>
                      )}

                      {entry.prevContent ? (
                        <p className={styles.prev}>
                          {t('memoryChangedFrom', { prev: entry.prevContent, text: entry.content })}
                        </p>
                      ) : null}

                      {entry.tags.length > 0 ? (
                        <div className={styles.tags}>
                          {entry.tags.map((tag) => (
                            <span key={tag} className={styles.tag}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}

                    </article>
                  ))}

                  {/* 手动新增挂在时间轴末尾：添加也是这条线上的一件事，不是另一张表单 */}
                  <div className={styles.addNode}>{renderAdd()}</div>
                </div>
              )}
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>{t('memoryRetrievalTitle')}</h3>
                <span className={styles.sectionMeta}>
                  {t('memoryThresholdNote', { threshold: MEMORY_THRESHOLD.toFixed(2), count: MEMORY_TOP_K })}
                </span>
              </div>
              <div className={styles.searchWrap}>
                <span className={styles.searchIcon}>
                  <IconSearchOutline16 />
                </span>
                <input
                  className={styles.searchInput}
                  value={query}
                  disabled={!memoryOn}
                  placeholder={t('memorySearchPlaceholder')}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void preview()
                    }
                  }}
                />
              </div>
              {hits === null ? null : hits.length === 0 ? (
                <p className={styles.emptyHits}>
                  {t('memoryNoHitAbove', { threshold: MEMORY_THRESHOLD.toFixed(2) })}
                </p>
              ) : (
                <div className={styles.hits}>
                  {hits.map((hit) => (
                    <div
                      key={hit.entry.id}
                      className={clsx(styles.hit, hit.score < MEMORY_THRESHOLD && styles.hitMiss)}
                    >
                      <span className={styles.hitScore}>{hit.score.toFixed(2)}</span>
                      <span className={styles.hitBar} aria-hidden="true">
                        <span
                          className={styles.hitBarFill}
                          style={{ width: `${Math.min(100, Math.max(0, hit.score * 100))}%` }}
                        />
                      </span>
                      <span className={styles.hitText}>{hit.entry.content}</span>
                    </div>
                  ))}
                </div>
              )}
              {previewBusy ? <p className={styles.emptyHits}>{t('memoryRetrieving')}</p> : null}
            </section>

            <section className={styles.dangerZone}>
              <p className={styles.caption}>{t('memoryDangerHint')}</p>
              <div className={styles.dangerActions}>
                <Button variant="outlined" size="s" onClick={() => void download()}>
                  {t('memoryExport')}
                </Button>
                {clearing ? (
                  <Button variant="danger" size="s" onClick={() => void clearAll()}>
                    {t('memoryClearAll')}
                  </Button>
                ) : (
                  <Button variant="dangerOutlined" size="s" onClick={() => setClearing(true)}>
                    {t('memoryClearAll')}
                  </Button>
                )}
              </div>
              {clearing ? (
                <div className={styles.itemEditorActions}>
                  <span className={styles.caption}>{t('memoryClearConfirmText')}</span>
                  <Button variant="outlined" size="s" onClick={() => setClearing(false)}>
                    {t('memoryCancel')}
                  </Button>
                </div>
              ) : null}
              {available === false ? <p className={styles.caption}>{t('settingsMemoryUnavailable')}</p> : null}
            </section>
          </div>
        </div>
      ) : (
        <div className={styles.guide}>
          <span className={styles.guideMark}>
            <IconMemoryOutline14 />
          </span>
          <h2 className={styles.guideTitle}>{t('memoryGuideTitle')}</h2>
          <p className={styles.guideText}>{t('memoryGuideText')}</p>
          <Button
            variant="primary"
            size="l"
            className={styles.guideButton}
            onClick={() => openSettings('general', 'memory')}
          >
            {t('memoryGuideAction')}
          </Button>
        </div>
      )}

      {pendingDelete ? (
        <Modal
          title={t('memoryDeleteConfirmTitle')}
          onClose={() => setPendingDelete(null)}
          footer={
            <>
              <Button variant="outlined" size="m" autoFocus onClick={() => setPendingDelete(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" size="m" disabled={deleting} onClick={() => void confirmRemove()}>
                {t('memoryDelete')}
              </Button>
            </>
          }
        >
          <p className={styles.caption}>{t('memoryDeleteConfirm')}</p>
          <p className={styles.content} style={{ WebkitLineClamp: 'unset' }}>
            {pendingDelete.content}
          </p>
        </Modal>
      ) : null}
    </div>
  )
}
