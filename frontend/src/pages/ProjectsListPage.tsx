import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PinButton } from '../components/PinButton'
import { ProjectFormModal } from '../components/ProjectFormModal'
import { api } from '../api/client'
import type { Project } from '../api/types'
import { formatIsoDate } from '../lib/dates'
import { SIDEBAR_RECENT_COUNT, usePinMutation } from '../lib/sidebarPins'

type StateFilter = 'all' | 'open' | 'current' | 'released'

const stateOf = (p: Project) => (p.release_date ? 'released' : p.is_current ? 'current' : 'open')

// Elenco di tutti gli Increment (UI "Increment" = models.Project), con 📌
// per scegliere quali mostrare nella sidebar.
export function ProjectsListPage() {
  const [showNew, setShowNew] = useState(false)
  const [search, setSearch] = useState('')
  const [state, setState] = useState<StateFilter>('all')
  const { data: projects, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const pin = usePinMutation('projects')

  const query = search.trim().toLowerCase()
  const rows = (projects ?? [])
    .filter(
      (p) =>
        (state === 'all' ||
          (state === 'open' ? !p.release_date : stateOf(p) === state)) &&
        (!query || `${p.code} ${p.name}`.toLowerCase().includes(query)),
    )
    // Dal piu' recente: per data di inizio, poi per codice.
    .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '') || b.code.localeCompare(a.code))

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Increment</h1>
          <div className="sub">
            Tutti gli increment. Con 📌 scegli quali mostrare nella sidebar; senza nessun 📌 la sidebar mostra i{' '}
            {SIDEBAR_RECENT_COUNT} modificati più di recente.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/projects-dashboard" className="btn">
            📈 Timeline increment
          </Link>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + Nuovo Increment
          </button>
        </div>
      </div>

      <div className="list-filters">
        <input
          type="search"
          placeholder="Cerca per codice o nome…"
          aria-label="Cerca increment"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="Stato" value={state} onChange={(e) => setState(e.target.value as StateFilter)}>
          <option value="all">Tutti</option>
          <option value="open">Da rilasciare</option>
          <option value="current">In corso</option>
          <option value="released">Rilasciati</option>
        </select>
      </div>

      {isLoading && <p className="muted">Caricamento...</p>}

      {projects?.length === 0 && <div className="card empty-state">Nessun increment ancora.</div>}

      {projects && projects.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }} title="Nella sidebar">
                  📌
                </th>
                <th>Codice</th>
                <th>Nome</th>
                <th>Fase</th>
                <th>Inizio</th>
                <th>Code freeze</th>
                <th>Release to Market</th>
                <th>Rilasciato il</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <PinButton
                      pinned={p.sidebar_pinned}
                      label={p.code}
                      onToggle={() => pin.mutate({ id: p.id, pinned: !p.sidebar_pinned })}
                    />
                  </td>
                  <td>
                    <Link to={`/projects/${p.id}`}>
                      <strong>{p.code}</strong>
                    </Link>
                    {p.is_current && !p.release_date && (
                      <span className="badge current" style={{ marginLeft: 6 }}>
                        In corso
                      </span>
                    )}
                  </td>
                  <td>{p.name}</td>
                  <td>{p.status}</td>
                  <td>{formatIsoDate(p.start_date) ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(p.code_freeze_date) ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(p.planned_finish_date) ?? <span className="muted">-</span>}</td>
                  <td>
                    {p.release_date ? (
                      <span className="badge done">✓ {formatIsoDate(p.release_date)}</span>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    Nessun increment corrisponde ai filtri.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <ProjectFormModal onClose={() => setShowNew(false)} />}
    </div>
  )
}
