import { useQuery } from '@tanstack/react-query'
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

// Perche' un item citato nello scope non conta nel confronto.
function excludedReason(i: BacklogItem): string {
  if (i.archived_at) return 'archiviato (non più nella JQL)'
  if (!i.in_scope) return 'fuori scope nel backlog'
  if (isMilestone(i)) return 'milestone'
  return 'activity di servizio'
}

function ItemRow({ item, note }: { item: BacklogItem; note?: string }) {
  return (
    <li>
      <a href={`${JIRA_BROWSE}${item.jira_key}`} target="_blank" rel="noreferrer">
        {item.jira_key}
      </a>{' '}
      {item.summary}
      <span className="muted">
        {' '}
        · {item.issue_type ?? '-'} · {item.jira_status ?? item.status}
        {note ? ` · ${note}` : ''}
      </span>
    </li>
  )
}

export function ScopeBacklogCheck({ projectId, scope, onClose }: { projectId: number; scope: string | null; onClose: () => void }) {
  const { data: backlog, isLoading, error } = useQuery({
    queryKey: ['backlog', projectId],
    queryFn: () => api.backlog.list(projectId),
  })
  if (isLoading) return <div className="scope-check">Verifica in corso…</div>
  if (error || !backlog) return <div className="error-banner">Backlog non letto: {(error as Error | null)?.message}</div>

  const keys = scopeKeys(scope)
  const byKey = new Map(backlog.map((i) => [i.jira_key.toUpperCase(), i]))
  const relevant = backlog.filter(compared)
  const coveredByParent = relevant.filter(
    (i) => !keys.has(i.jira_key.toUpperCase()) && i.parent_key && keys.has(i.parent_key.toUpperCase()),
  )
  const extra = relevant.filter(
    (i) => !keys.has(i.jira_key.toUpperCase()) && !(i.parent_key && keys.has(i.parent_key.toUpperCase())),
  )
  const missing = [...keys].filter((k) => !byKey.has(k)).sort()
  const excluded = [...keys].map((k) => byKey.get(k)).filter((i): i is BacklogItem => !!i && !compared(i))
  const matched = relevant.length - extra.length - coveredByParent.length
  const ok = extra.length === 0 && missing.length === 0

  return (
    <div className={`scope-check${ok ? ' scope-check--ok' : ''}`}>
      <div className="scope-check-head">
        <b>{ok ? '✓ Scope e backlog coerenti' : '⚠ Scope e backlog non del tutto coerenti'}</b>
        <span className="muted">
          {keys.size} chiavi Jira nello scope · {relevant.length} item del backlog confrontati (in scope, senza milestone
          e activity di servizio) · {matched} citati nello scope
        </span>
        <button type="button" className="link-btn" onClick={onClose}>
          Chiudi
        </button>
      </div>

      <h4>Nel backlog ma non nello scope ({extra.length})</h4>
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
              <ItemRow key={i.id} item={i} note={excludedReason(i)} />
            ))}
          </ul>
        </>
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
