import { useEffect, useMemo, useState } from 'react'
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
import type { MemoryEntry } from '../../services/chat/db.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './MemoryPage.module.css'

/**
 * 记忆空间：画像是无条件带上的一段文字，条目是带向量的事实；两者都只存在这台设备。
 * 页面本身不访问服务端，只有「检索预览」会算一次向量。
 */
const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

const formatDate = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const MemoryPage = () => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const available = useMemoryStatus((state) => state.available)
  const [profile, setProfile] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [draft, setDraft] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryHit[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [clearing, setClearing] = useState(false)

  const reload = async () => {
    const [text, list] = await Promise.all([loadProfile(), listMemories()])
    setProfile(text)
    setEntries(list)
  }

  useEffect(() => {
    void reload()
  }, [])

  const sessionTitle = useMemo(() => {
    const map = new Map(sessions.map((session) => [session.id, session.title || '']))
    return (id: string | null) => (id ? map.get(id) || id : '')
  }, [sessions])

  const size = useMemo(
    () => entries.reduce((total, entry) => total + entry.content.length + entry.vec.byteLength, 0),
    [entries]
  )

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

  const add = async () => {
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
      await reload()
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
    if (!query.trim()) {
      return
    }
    setPreviewBusy(true)
    try {
      setHits(await searchMemory(query, null))
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

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{t('memoryTitle')}</h1>
          <Button variant="outlined" size="s" onClick={() => navigateTo('/')}>
            {t('memoryBack')}
          </Button>
        </div>
        <div className={styles.stats}>
          <span>
            {t('memoryStatCount')} {entries.length}
          </span>
          <span>
            {t('memoryStatSize')} {formatBytes(size)}
          </span>
          {available === false ? (
            <span className={styles.warn}>{t('settingsMemoryUnavailable')}</span>
          ) : null}
        </div>
      </header>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('memoryProfileTitle')}</h2>
          <span className={styles.meta}>
            {[...profile].length} / {PROFILE_LIMIT}
          </span>
        </div>
        <p className={styles.hint}>{t('memoryProfileHint')}</p>
        <textarea
          className={styles.textarea}
          value={profile}
          placeholder={t('memoryProfilePlaceholder')}
          onChange={(event) => setProfile(event.target.value)}
        />
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="m"
            disabled={profileBusy}
            onClick={() => void saveProfile()}
          >
            {t('memoryProfileSave')}
          </Button>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('memoryListTitle')}</h2>
          <span className={styles.meta}>{entries.length}</span>
        </div>
        {entries.length === 0 ? (
          <p className={styles.hint}>{t('memoryListEmpty')}</p>
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.idTag}>{entry.id}</span>
                  {entry.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                  <span className={styles.meta}>
                    {entry.hitCount > 0
                      ? t('memoryHits', { count: entry.hitCount })
                      : t('memoryNeverUsed')}
                  </span>
                </div>
                {editing === entry.id ? (
                  <>
                    <textarea
                      className={styles.textarea}
                      value={editingText}
                      maxLength={MEMORY_ITEM_LIMIT}
                      onChange={(event) => setEditingText(event.target.value)}
                    />
                    <div className={styles.actions}>
                      <Button variant="primary" size="s" onClick={() => void commitEdit(entry)}>
                        {t('memorySave')}
                      </Button>
                      <Button variant="outlined" size="s" onClick={() => setEditing(null)}>
                        {t('memoryCancel')}
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
                <div className={styles.itemFoot}>
                  <span className={styles.meta}>
                    {entry.sessionId
                      ? `${t('memoryFromSession')} · ${sessionTitle(entry.sessionId)}`
                      : t('memoryManual')}
                    {' · '}
                    {formatDate(entry.updatedAt)}
                  </span>
                  {editing === entry.id ? null : (
                    <span className={styles.itemActions}>
                      <Button
                        variant="outlined"
                        size="s"
                        onClick={() => {
                          setEditing(entry.id)
                          setEditingText(entry.content)
                        }}
                      >
                        {t('memoryEdit')}
                      </Button>
                      <Button
                        variant="dangerOutlined"
                        size="s"
                        onClick={() => {
                          void removeMemory(entry.id).then(reload)
                          showToast({ key: 'memoryDeleted' })
                        }}
                      >
                        {t('memoryDelete')}
                      </Button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.addBox}>
          <h3 className={styles.cardSubtitle}>{t('memoryAddTitle')}</h3>
          <textarea
            className={styles.textarea}
            value={draft}
            maxLength={MEMORY_ITEM_LIMIT}
            placeholder={t('memoryAddPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <input
            className={styles.input}
            value={draftTags}
            placeholder={t('memoryTagsPlaceholder')}
            onChange={(event) => setDraftTags(event.target.value)}
          />
          <div className={styles.actions}>
            <Button variant="primary" size="m" disabled={!draft.trim()} onClick={() => void add()}>
              {t('memorySave')}
            </Button>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('memoryRetrievalTitle')}</h2>
          <span className={styles.meta}>
            {MEMORY_THRESHOLD.toFixed(2)} · top {MEMORY_TOP_K}
          </span>
        </div>
        <p className={styles.hint}>{t('memoryRetrievalHint')}</p>
        <div className={styles.queryRow}>
          <input
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void preview()
              }
            }}
          />
          <Button
            variant="outlined"
            size="m"
            disabled={previewBusy || !query.trim()}
            onClick={() => void preview()}
          >
            {t('memoryRetrievalTitle')}
          </Button>
        </div>
        {hits === null ? null : hits.length === 0 ? (
          <p className={styles.hint}>{t('memoryRetrievalEmpty')}</p>
        ) : (
          <ul className={styles.list}>
            {hits.map((hit) => (
              <li key={hit.entry.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.idTag}>{hit.entry.id}</span>
                  <span className={styles.meta}>{hit.score.toFixed(3)}</span>
                </div>
                <p className={styles.content}>{hit.entry.content}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className={styles.foot}>
        <Button variant="outlined" size="m" onClick={() => void download()}>
          {t('memoryExport')}
        </Button>
        {clearing ? (
          <>
            <span className={styles.hint}>{t('memoryClearConfirmText')}</span>
            <Button variant="danger" size="m" onClick={() => void clearAll()}>
              {t('memoryClearAll')}
            </Button>
            <Button variant="outlined" size="m" onClick={() => setClearing(false)}>
              {t('memoryCancel')}
            </Button>
          </>
        ) : (
          <Button variant="dangerOutlined" size="m" onClick={() => setClearing(true)}>
            {t('memoryClearAll')}
          </Button>
        )}
      </footer>
    </div>
  )
}
