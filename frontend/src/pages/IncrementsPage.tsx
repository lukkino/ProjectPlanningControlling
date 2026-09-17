import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IncrementFormModal } from '../components/IncrementFormModal'
import { api } from '../api/client'
import { formatIsoDate } from '../lib/dates'

export function IncrementsPage() {
  const [showNew, setShowNew] = useState(false)
  const { data: increments, isLoading } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Progetti</h1>
          <div className="sub">Codice, descrizione, durata e budget (ore per ruolo + materiali), indipendentemente da quanti increment li compongono.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + Nuovo progetto
        </button>
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
                <th>Codice</th>
                <th>Descrizione</th>
                <th>Inizio</th>
                <th>Fine</th>
              </tr>
            </thead>
            <tbody>
              {increments.map((inc) => (
                <tr key={inc.id}>
                  <td>
                    <Link to={`/increments/${inc.id}`}>{inc.code}</Link>
                  </td>
                  <td>{inc.notes ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(inc.start_date) ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(inc.end_date) ?? <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <IncrementFormModal onClose={() => setShowNew(false)} />}
    </div>
  )
}
