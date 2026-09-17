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
          <h1>Increment</h1>
          <div className="sub">Rilasci: contenuto e data, indipendentemente da quanti progetti li compongono.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + Nuovo increment
        </button>
      </div>

      {isLoading && <p className="muted">Caricamento...</p>}

      {increments?.length === 0 && (
        <div className="card empty-state">Nessun increment ancora. Creane uno per raggruppare i progetti di un rilascio.</div>
      )}

      {increments && increments.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Codice</th>
                <th>Nome</th>
                <th>Data di rilascio</th>
              </tr>
            </thead>
            <tbody>
              {increments.map((inc) => (
                <tr key={inc.id}>
                  <td>
                    <Link to={`/increments/${inc.id}`}>{inc.code}</Link>
                  </td>
                  <td>{inc.name ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(inc.release_date) ?? <span className="muted">-</span>}</td>
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
