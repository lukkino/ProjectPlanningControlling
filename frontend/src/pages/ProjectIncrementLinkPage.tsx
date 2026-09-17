import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { formatIsoDate } from '../lib/dates'
import { useProjectContext } from './useProjectContext'

// Tab "Progetti" di un increment: mostra/gestisce a quale progetto (entità
// con codice tipo PTBSYS-03-004, rilascio) questo increment è collegato -
// il lato opposto del picker già presente nella pagina di dettaglio del
// progetto stesso. Un increment appartiene al massimo a un progetto.
export function ProjectIncrementLinkPage() {
  const { project } = useProjectContext()
  const [pickedId, setPickedId] = useState('')
  const queryClient = useQueryClient()

  const { data: allIncrements } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })
  const { data: linked } = useQuery({
    queryKey: ['increment', project.increment_id],
    queryFn: () => api.increments.get(project.increment_id as number),
    enabled: project.increment_id != null,
  })

  const setIncrement = useMutation({
    mutationFn: (incrementId: number | null) => api.projects.update(project.id, { increment_id: incrementId }),
    onSuccess: (_saved, incrementId) => {
      queryClient.invalidateQueries({ queryKey: ['project', project.id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (project.increment_id) queryClient.invalidateQueries({ queryKey: ['increment', project.increment_id] })
      if (incrementId) queryClient.invalidateQueries({ queryKey: ['increment', incrementId] })
    },
  })

  const handleAttach = () => {
    if (!pickedId) return
    setIncrement.mutate(Number(pickedId))
    setPickedId('')
  }

  const siblings = (linked?.projects ?? []).filter((p) => p.id !== project.id)

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Progetto associato</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Il progetto raggruppa più increment sotto lo stesso rilascio (contenuto e data), quando alcune ore vanno
        rendicontate su questo increment e altre su increment diversi dello stesso rilascio.
      </p>

      {!project.increment_id && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={pickedId} onChange={(e) => setPickedId(e.target.value)} style={{ flex: 1 }}>
            <option value="">Collega un progetto già creato...</option>
            {allIncrements?.map((inc) => (
              <option key={inc.id} value={inc.id}>
                {inc.code}
                {inc.notes ? ` · ${inc.notes}` : ''}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!pickedId || setIncrement.isPending} onClick={handleAttach}>
            Collega
          </button>
        </div>
      )}

      {project.increment_id && linked && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Codice</th>
                <th>Descrizione</th>
                <th>Data di rilascio</th>
                <th>Altri increment nello stesso progetto</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Link to={`/increments/${linked.id}`}>{linked.code}</Link>
                </td>
                <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{linked.notes ?? <span className="muted">-</span>}</td>
                <td>{formatIsoDate(linked.release_date) ?? <span className="muted">-</span>}</td>
                <td>
                  {siblings.length === 0 && <span className="muted">-</span>}
                  {siblings.length > 0 && siblings.map((s) => s.code).join(', ')}
                </td>
                <td>
                  <button className="btn" disabled={setIncrement.isPending} onClick={() => setIncrement.mutate(null)}>
                    Scollega
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
