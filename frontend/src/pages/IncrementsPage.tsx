import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IncrementFormModal } from '../components/IncrementFormModal'
import { PinButton } from '../components/PinButton'
import { api } from '../api/client'
import { formatIsoDate } from '../lib/dates'
import { SIDEBAR_RECENT_COUNT, usePinMutation } from '../lib/sidebarPins'

// Elenco di tutti i Progetti (UI "Progetto" = models.Increment), con 📌
// per scegliere quali mostrare nella sidebar.
export function IncrementsPage() {
  const [showNew, setShowNew] = useState(false)
  const [search, setSearch] = useState('')
  const [onlyPinned, setOnlyPinned] = useState(false)
  const { data: increments, isLoading } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const pin = usePinMutation('increments')

  const query = search.trim().toLowerCase()
  const rows = (increments ?? []).filter(
    (inc) =>
      (!onlyPinned || inc.sidebar_pinned) &&
      (!query || `${inc.code} ${inc.notes ?? ''}`.toLowerCase().includes(query)),
  )
  const pinnedCount = (increments ?? []).filter((i) => i.sidebar_pinned).length
  const projectOf = (id: number | null) => (id === null ? undefined : projects?.find((p) => p.id === id))

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Progetti</h1>
          <div className="sub">
            Tutti i progetti, con durata e budget. Con 📌 scegli quali mostrare nella sidebar; senza nessun 📌 la sidebar
            mostra i {SIDEBAR_RECENT_COUNT} modificati più di recente.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + Nuovo progetto
        </button>
      </div>

      <div className="list-filters">
        <input
          type="search"
          placeholder="Cerca per codice o descrizione…"
          aria-label="Cerca progetti"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label>
          <input type="checkbox" checked={onlyPinned} onChange={(e) => setOnlyPinned(e.target.checked)} /> Solo nella
          sidebar ({pinnedCount})
        </label>
      </div>

      {isLoading && <p className="muted">Caricamento...</p>}

      {increments?.length === 0 && (
        <div className="card empty-state">Nessun progetto ancora. Creane uno per raggruppare gli increment di un rilascio.</div>
      )}

      {increments && increments.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }} title="Nella sidebar">
                  📌
                </th>
                <th>Codice</th>
                <th>Descrizione</th>
                <th>Increment</th>
                <th>Inizio</th>
                <th>Fine</th>
                <th>Budget</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inc) => {
                const project = projectOf(inc.project_id)
                return (
                  <tr key={inc.id}>
                    <td>
                      <PinButton
                        pinned={inc.sidebar_pinned}
                        label={inc.code}
                        onToggle={() => pin.mutate({ id: inc.id, pinned: !inc.sidebar_pinned })}
                      />
                    </td>
                    <td>
                      <Link to={`/increments/${inc.id}`}>
                        <strong>{inc.code}</strong>
                      </Link>
                    </td>
                    <td style={{ whiteSpace: 'normal' }}>{inc.notes ?? <span className="muted">-</span>}</td>
                    <td>
                      {project ? <Link to={`/projects/${project.id}`}>{project.code}</Link> : <span className="muted">-</span>}
                    </td>
                    <td>{formatIsoDate(inc.start_date) ?? <span className="muted">-</span>}</td>
                    <td>{formatIsoDate(inc.end_date) ?? <span className="muted">-</span>}</td>
                    <td>
                      {inc.budget_frozen_at ? (
                        <span title={`Congelato il ${formatIsoDate(inc.budget_frozen_at.slice(0, 10))}`}>🔒 Congelato</span>
                      ) : (
                        <span className="muted">In definizione</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    Nessun progetto corrisponde ai filtri.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <IncrementFormModal onClose={() => setShowNew(false)} />}
    </div>
  )
}
