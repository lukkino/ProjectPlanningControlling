import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { ChangelogEntry } from '../api/types'
import { APP_VERSION } from '../lib/version'

const dayKey = (iso: string) => iso.slice(0, 10)
const fmtDay = (iso: string) =>
  new Date(`${dayKey(iso)}T12:00:00`).toLocaleDateString('it-IT', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
const fmtTime = (iso: string) => iso.slice(11, 16)

// Una riga del messaggio: "- testo" diventa una voce di elenco.
function Body({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  const bullets = lines.every((l) => /^\s*[-*•]\s/.test(l))
  return bullets ? (
    <ul className="changelog-body">
      {lines.map((l, i) => (
        <li key={i}>{l.replace(/^\s*[-*•]\s/, '')}</li>
      ))}
    </ul>
  ) : (
    <div className="changelog-body">
      {lines.map((l, i) => (
        <p key={i}>{l.replace(/^\s*[-*•]\s/, '• ')}</p>
      ))}
    </div>
  )
}

// Storia delle modifiche dell'applicazione: tutti i commit, dal piu' recente,
// letti dalla storia git dal backend.
export function ChangelogPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['changelog'], queryFn: api.app.changelog })
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const entries = (data ?? []).filter(
    (e) => !query || `${e.subject}\n${e.body.join('\n')}\n${e.short_hash}\n${e.version ?? ''}`.toLowerCase().includes(query),
  )
  const days: [string, ChangelogEntry[]][] = []
  for (const entry of entries) {
    const key = dayKey(entry.date)
    const last = days[days.length - 1]
    if (last && last[0] === key) last[1].push(entry)
    else days.push([key, [entry]])
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Versione {APP_VERSION}</h1>
          <div className="sub">
            Storia delle modifiche dell'applicazione: ogni commit con data e cosa cambia
            {data ? ` · ${data.length} modifiche` : ''}.
          </div>
        </div>
      </div>

      <div className="list-filters">
        <input
          type="search"
          placeholder="Cerca nelle modifiche…"
          aria-label="Cerca nelle modifiche"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {query && data && (
          <span className="muted" style={{ fontSize: 13 }}>
            {entries.length} di {data.length}
          </span>
        )}
      </div>

      {isLoading && <p className="muted">Caricamento...</p>}
      {error && <div className="error-banner">{(error as Error).message}</div>}

      {days.map(([day, list]) => (
        <section key={day} className="changelog-day">
          <h3>{fmtDay(list[0].date)}</h3>
          {list.map((e) => (
            <article key={e.hash} className="card changelog-entry">
              <div className="changelog-head">
                <span>
                  {e.version && (
                    <span className="badge ready changelog-version" title="Versione dell'app introdotta da questa modifica">
                      v{e.version}
                    </span>
                  )}
                  <strong>{e.subject}</strong>
                </span>
                <span className="muted changelog-meta">
                  {fmtTime(e.date)} · <code title={e.hash}>{e.short_hash}</code>
                  {e.files_changed > 0 && (
                    <>
                      {' '}
                      · {e.files_changed} file <span className="changelog-add">+{e.insertions}</span>{' '}
                      <span className="changelog-del">−{e.deletions}</span>
                    </>
                  )}
                </span>
              </div>
              <Body lines={e.body} />
            </article>
          ))}
        </section>
      ))}
      {data && entries.length === 0 && <p className="muted">Nessuna modifica corrisponde alla ricerca.</p>}
    </div>
  )
}
