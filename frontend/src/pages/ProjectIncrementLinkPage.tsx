import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { formatIsoDate } from '../lib/dates'
import { useProjectContext } from './useProjectContext'

// Tab "Progetti" di un increment: mostra/gestisce quali progetti (entita'
// con codice tipo PTIH-PT13, budget e durata) rendicontano le ore su questo
// increment. Un increment puo' averne piu' di uno (es. un progetto
// "principale" + uno di maintenance); ogni progetto appartiene al massimo a
// un increment (il lato singolo si gestisce dalla pagina del progetto).
export function ProjectIncrementLinkPage() {
  const { project } = useProjectContext()
  const [pickedId, setPickedId] = useState('')
  const queryClient = useQueryClient()

  const { data: allProgetti } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })

  const setProgettoProject = useMutation({
    mutationFn: ({ progettoId, projectId }: { progettoId: number; projectId: number | null }) =>
      api.increments.update(progettoId, { project_id: projectId }),
    onSuccess: (_saved, { progettoId }) => {
      queryClient.invalidateQueries({ queryKey: ['project', project.id] })
      queryClient.invalidateQueries({ queryKey: ['increment', progettoId] })
      queryClient.invalidateQueries({ queryKey: ['increments'] })
    },
  })

  const linkedIds = new Set(project.progetti.map((p) => p.id))
  const attachable = (allProgetti ?? []).filter((p) => !linkedIds.has(p.id))

  const handleAttach = () => {
    if (!pickedId) return
    setProgettoProject.mutate({ progettoId: Number(pickedId), projectId: project.id })
    setPickedId('')
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Progetti collegati</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        I progetti su cui vengono rendicontate le ore di questo increment: normalmente uno solo, ma possono essere
        più di uno quando alcune ore vanno rendicontate su un progetto diverso (es. maintenance).
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <select value={pickedId} onChange={(e) => setPickedId(e.target.value)} style={{ flex: 1 }}>
          <option value="">Collega un progetto già creato...</option>
          {attachable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}
              {p.notes ? ` · ${p.notes}` : ''}
              {p.project_id ? ` (già collegato a un altro increment)` : ''}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!pickedId || setProgettoProject.isPending} onClick={handleAttach}>
          Collega
        </button>
      </div>

      {project.progetti.length === 0 && (
        <p className="muted">Nessun progetto collegato ancora: scegline uno esistente qui sopra.</p>
      )}
      {project.progetti.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Progetto</th>
                <th>Descrizione</th>
                <th>Inizio</th>
                <th>Fine</th>
                <th>Budget ore</th>
                <th>Budget materiali</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {project.progetti.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/increments/${p.id}`}>{p.code}</Link>
                  </td>
                  <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{p.notes ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(p.start_date) ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(p.end_date) ?? <span className="muted">-</span>}</td>
                  <td>{p.estimated_budget_hours}</td>
                  <td>{p.estimated_budget_material} €</td>
                  <td>
                    <button
                      className="btn"
                      disabled={setProgettoProject.isPending}
                      onClick={() => setProgettoProject.mutate({ progettoId: p.id, projectId: null })}
                    >
                      Scollega
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
