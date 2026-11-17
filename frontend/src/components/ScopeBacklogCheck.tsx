import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { BacklogItem } from '../api/types'
import { isMilestone } from '../lib/milestone'

// Verifica di coerenza tra lo Scope schematico e il backlog dell'increment.
// Chiavi dello scope: quelle dei link a Jira e quelle scritte nel testo.
// Item del backlog confrontati: in scope, non archiviati, senza milestone e
// senza activity di servizio per i rilasci. Un item il cui padre e' citato
// nello scope e' coperto (mostrato a parte).

const JIRA_BROWSE = 'https://inpeco.atlassian.net/browse/'
const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g

function scopeKeys(html: string | null): Set<string> {
  const keys = new Set<string>()
  if (!html) return keys
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const a of doc.querySelectorAll('a[href]')) {
    const match = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i.exec(a.getAttribute('href') ?? '')
    if (match) keys.add(match[1].toUpperCase())
  }
  // Testo nodo per nodo: unito tutto insieme, la chiave a fine riga si
  // attaccherebbe alla riga dopo ("PTBSYS-5036Inpeco") e non verrebbe trovata.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const match of (node.textContent ?? '').matchAll(KEY_RE)) keys.add(match[0])
  }
  return keys
}

const compared = (i: BacklogItem) => !i.archived_at && i.in_scope && !isMilestone(i) && !i.is_activity

// Vulnerabilita' da scansione ("[CVE-2026-9256] The remote Red Hat host...",
// label vuln_from_scan): di norma non sono nello scope, si possono escludere
// dal confronto.
const CVE_RE = /\bCVE-\d{4}-\d+/i
const isCve = (i: BacklogItem) =>
  CVE_RE.test(i.summary ?? '') || (i.labels ?? '').split(';').some((l) => l.trim() === 'vuln_from_scan')

// Scelta del browser, uguale per tutti gli increment.
const IGNORE_CVE_STORAGE_KEY = 'scope-check-ignore-cve'

function readIgnoreCve(): boolean {
  try {
    return localStorage.getItem(IGNORE_CVE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

// Perche' un item citato nello scope non conta nel confronto.
function excludedReason(i: BacklogItem, ignoreCve: boolean): string {
  if (ignoreCve && isCve(i)) return 'CVE ignorata'
  if (i.archived_at) return 'archiviato (non più nella JQL)'
  if (!i.in_scope) return 'fuori scope nel backlog'
  if (isMilestone(i)) return 'milestone'
  return 'activity di servizio'
}

// Tipo Jira ben visibile, con gli stessi colori del Gantt del backlog:
// Story verde, Bug rosso, Activity blu, il resto grigio.
const TYPE_STYLES: Record<string, { color: string; icon: string }> = {
  Story: { color: '#1a8a3a', icon: '📗' },
  Bug: { color: '#d3402f', icon: '🐞' },
  Activity: { color: '#2f6fed', icon: '⚙' },
}
const OTHER_TYPE = { color: '#5b6472', icon: '•' }
const TYPE_ORDER = ['Story', 'Bug', 'Activity']
const typeStyle = (type: string | null) => TYPE_STYLES[type ?? ''] ?? OTHER_TYPE
const typeRank = (type: string | null) => {
  const i = TYPE_ORDER.indexOf(type ?? '')
  return i < 0 ? TYPE_ORDER.length : i
}
const byType = (a: BacklogItem, b: BacklogItem) => typeRank(a.issue_type) - typeRank(b.issue_type)

function TypeBadge({ type, count }: { type: string | null; count?: number }) {
  const s = typeStyle(type)
  return (
    <span
      className="scope-check-type"
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 12%, white)`, borderColor: s.color }}
    >
      {s.icon} {type ?? 'Altro'}
      {count !== undefined && ` ${count}`}
    </span>
  )
}

// Quanti item per tipo, nell'ordine Story, Bug, Activity, altri.
function TypeCounts({ items }: { items: BacklogItem[] }) {
  const counts = new Map<string | null, number>()
  for (const i of [...items].sort(byType)) counts.set(i.issue_type, (counts.get(i.issue_type) ?? 0) + 1)
  return (
    <>
      {[...counts].map(([type, n]) => (
        <TypeBadge key={type ?? ''} type={type} count={n} />
      ))}
    </>
  )
}

function ItemRow({ item, note }: { item: BacklogItem; note?: string }) {
  return (
    <li className="scope-check-item" style={{ borderLeftColor: typeStyle(item.issue_type).color }}>
      <TypeBadge type={item.issue_type} />
      <a href={`${JIRA_BROWSE}${item.jira_key}`} target="_blank" rel="noreferrer">
        {item.jira_key}
      </a>{' '}
      {item.summary}
      <span className="muted">
        {' '}
        · {item.jira_status ?? item.status}
        {note ? ` · ${note}` : ''}
      </span>
    </li>
  )
}

export function ScopeBacklogCheck({ projectId, scope, onClose }: { projectId: number; scope: string | null; onClose: () => void }) {
  const [ignoreCve, setIgnoreCve] = useState(readIgnoreCve)
  const toggleIgnoreCve = () => {
    const next = !ignoreCve
    setIgnoreCve(next)
    try {
      localStorage.setItem(IGNORE_CVE_STORAGE_KEY, next ? '1' : '0')
    } catch {
      // localStorage non disponibile: la scelta vale solo per questa visita
    }
  }
  const { data: backlog, isLoading, error } = useQuery({
    queryKey: ['backlog', projectId],
    queryFn: () => api.backlog.list(projectId),
  })
  if (isLoading) return <div className="scope-check">Verifica in corso…</div>
  if (error || !backlog) return <div className="error-banner">Backlog non letto: {(error as Error | null)?.message}</div>

  const keys = scopeKeys(scope)
  const byKey = new Map(backlog.map((i) => [i.jira_key.toUpperCase(), i]))
  const counted = (i: BacklogItem) => compared(i) && !(ignoreCve && isCve(i))
  const relevant = backlog.filter(counted)
  const cves = backlog.filter((i) => compared(i) && isCve(i))
  const coveredByParent = relevant.filter(
    (i) => !keys.has(i.jira_key.toUpperCase()) && i.parent_key && keys.has(i.parent_key.toUpperCase()),
  )
  const extra = relevant
    .filter((i) => !keys.has(i.jira_key.toUpperCase()) && !(i.parent_key && keys.has(i.parent_key.toUpperCase())))
    .sort(byType)
  const missing = [...keys].filter((k) => !byKey.has(k)).sort()
  const excluded = [...keys].map((k) => byKey.get(k)).filter((i): i is BacklogItem => !!i && !counted(i))
  const matched = relevant.length - extra.length - coveredByParent.length
  const ok = extra.length === 0 && missing.length === 0

  return (
    <div className={`scope-check${ok ? ' scope-check--ok' : ''}`}>
      <div className="scope-check-head">
        <b>{ok ? '✓ Scope e backlog coerenti' : '⚠ Scope e backlog non del tutto coerenti'}</b>
        <span className="muted">
          {keys.size} chiavi Jira nello scope · {relevant.length} item del backlog confrontati (in scope, senza milestone
          e activity di servizio{ignoreCve ? ', senza CVE' : ''}) · {matched} citati nello scope
        </span>
        <button
          type="button"
          className={`btn${ignoreCve ? ' active' : ''}`}
          aria-pressed={ignoreCve}
          title={
            ignoreCve
              ? 'Le CVE (vulnerabilità da scansione) sono escluse dal confronto: clicca per includerle'
              : 'Escludi dal confronto le CVE (vulnerabilità da scansione, "[CVE-…]" o label vuln_from_scan)'
          }
          onClick={toggleIgnoreCve}
        >
          {ignoreCve ? `✓ CVE ignorate (${cves.length})` : `Ignora CVE (${cves.length})`}
        </button>
        <button type="button" className="link-btn" onClick={onClose}>
          Chiudi
        </button>
      </div>

      <h4 className="scope-check-title">
        Nel backlog ma non nello scope ({extra.length}) <TypeCounts items={extra} />
      </h4>
      {extra.length === 0 ? (
        <p className="muted">Nessuno.</p>
      ) : (
        <ul>
          {extra.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </ul>
      )}

      <h4>Nello scope ma non nel backlog ({missing.length})</h4>
      {missing.length === 0 ? (
        <p className="muted">Nessuna.</p>
      ) : (
        <>
          <ul>
            {missing.map((k) => (
              <li key={k}>
                <a href={`${JIRA_BROWSE}${k}`} target="_blank" rel="noreferrer">
                  {k}
                </a>
              </li>
            ))}
          </ul>
          <p className="muted">Non risultano nel backlog sincronizzato: fuori dalla JQL dell'increment, o backlog da risincronizzare.</p>
        </>
      )}

      {excluded.length > 0 && (
        <>
          <h4>Nello scope ma esclusi nel backlog ({excluded.length})</h4>
          <ul>
            {excluded.map((i) => (
              <ItemRow key={i.id} item={i} note={excludedReason(i, ignoreCve)} />
            ))}
          </ul>
        </>
      )}

      {ignoreCve && cves.length > 0 && (
        <details>
          <summary>CVE ignorate nel confronto ({cves.length})</summary>
          <ul>
            {cves.map((i) => (
              <ItemRow key={i.id} item={i} />
            ))}
          </ul>
        </details>
      )}

      {coveredByParent.length > 0 && (
        <details>
          <summary>
            Coperti dal padre citato nello scope ({coveredByParent.length})
          </summary>
          <ul>
            {coveredByParent.map((i) => (
              <ItemRow key={i.id} item={i} note={`padre ${i.parent_key}`} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
