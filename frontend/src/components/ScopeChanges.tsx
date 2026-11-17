import type { ReactNode } from 'react'
import type { ScopeHistory, ScopeRevision } from '../api/types'
import { formatDateTime } from '../lib/dates'
import { diffScope } from '../lib/scopeDiff'
import type { ScopeChange, ScopeItem } from '../lib/scopeDiff'

const FLAG_LABEL = { mandatory: '★ Mandatoria', tentative: '? Tentative' } as const

const flagText = (item: ScopeItem) => (item.flag ? FLAG_LABEL[item.flag] : 'normale')

function Context({ item }: { item: ScopeItem }) {
  if (!item.context) return null
  return <span className="muted" style={{ fontSize: 12 }}> — in “{item.context}”</span>
}

const MARK: Record<ScopeChange['kind'], { label: string; color: string; background: string }> = {
  added: { label: 'Aggiunta', color: 'var(--success)', background: '#e3f6ea' },
  removed: { label: 'Tolta', color: 'var(--danger)', background: '#fde8e8' },
  modified: { label: 'Modificata', color: 'var(--warning)', background: '#fff2df' },
  flag: { label: 'Priorità', color: 'var(--primary)', background: '#e6eefc' },
}

function ChangeRow({ change }: { change: ScopeChange }) {
  const mark = MARK[change.kind]
  let body: ReactNode
  if (change.kind === 'added') {
    body = (
      <>
        {change.item.text}
        <Context item={change.item} />
      </>
    )
  } else if (change.kind === 'removed') {
    body = (
      <>
        <s>{change.item.text}</s>
        <Context item={change.item} />
      </>
    )
  } else if (change.kind === 'modified') {
    body = (
      <>
        <s className="muted">{change.before.text}</s>
        <br />→ {change.after.text}
        <Context item={change.after} />
      </>
    )
  } else {
    body = (
      <>
        {change.after.text}: {flagText(change.before)} → <strong>{flagText(change.after)}</strong>
        <Context item={change.after} />
      </>
    )
  }
  return (
    <li style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
      <span
        className="badge"
        style={{ color: mark.color, background: mark.background, flex: 'none', minWidth: 78, textAlign: 'center' }}
      >
        {mark.label}
      </span>
      <span>{body}</span>
    </li>
  )
}

export function ChangeList({ changes, empty }: { changes: ScopeChange[]; empty: string }) {
  if (changes.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        {empty}
      </p>
    )
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {changes.map((c, i) => (
        <ChangeRow key={i} change={c} />
      ))}
    </ul>
  )
}

const KIND_LABEL: Record<ScopeRevision['kind'], string> = {
  freeze: '🔒 Congelato',
  change: '✎ Modifica',
  unfreeze: '🔓 Scongelato',
}

function RevisionEntry({ revision: r }: { revision: ScopeRevision }) {
  return (
    <li style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong>{KIND_LABEL[r.kind]}</strong>
        <span className="muted">
          {formatDateTime(r.created_at)}
          {r.user_name && ` · ${r.user_name}`}
        </span>
      </div>
      {r.note && <div style={{ marginTop: 2, fontStyle: 'italic' }}>“{r.note}”</div>}
      {r.kind === 'change' && (
        <div style={{ marginTop: 4 }}>
          <ChangeList
            changes={diffScope(r.previous_html, r.html)}
            empty="Solo formattazione o ordine delle voci cambiati."
          />
        </div>
      )}
    </li>
  )
}

type Props = {
  history: ScopeHistory
  scope: string | null
  busy: boolean
  onRefreeze: () => void
  onUnfreeze: () => void
}

// Scope congelato: cosa e' cambiato rispetto alla baseline (lo Scope al
// momento del freeze) e il registro di ogni modifica, con chi, quando e il
// motivo.
export function ScopeChanges({ history, scope, busy, onRefreeze, onUnfreeze }: Props) {
  const changes = diffScope(history.baseline, scope)
  return (
    <div className="card" style={{ background: 'var(--bg)', boxShadow: 'none', marginBottom: 12 }}>
      <div className="page-header" style={{ marginBottom: 8, alignItems: 'center' }}>
        <div>
          <strong>Modifiche dal freeze</strong>
          <div className="muted" style={{ fontSize: 13 }}>
            Baseline del {formatDateTime(history.frozen_at)}
            {history.frozen_by && ` (${history.frozen_by})`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={busy}
            title="Lo Scope attuale diventa la nuova baseline; il registro resta"
            onClick={onRefreeze}
          >
            Nuova baseline
          </button>
          <button
            className="btn"
            disabled={busy}
            title="Le modifiche allo Scope non si registrano più; il registro resta"
            onClick={onUnfreeze}
          >
            🔓 Scongela
          </button>
        </div>
      </div>
      <ChangeList changes={changes} empty="Nessuna modifica rispetto alla baseline." />
      {history.revisions.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer' }}>Registro ({history.revisions.length})</summary>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
            {history.revisions.map((r) => (
              <RevisionEntry key={r.id} revision={r} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
