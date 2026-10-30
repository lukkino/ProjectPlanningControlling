import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { BacklogItem } from '../api/types'
import { formatIsoDate, parseBackendDateTime } from '../lib/dates'

type Props = {
  projectId: number
  items: BacklogItem[]
  onClose: () => void
}

// Item che la sync non ha piu' trovato nella JQL: fuori dal backlog, ma con
// tutti i dati inseriti nell'app. Tornano da soli se rientrano nella JQL.
export function ArchivedItemsModal({ projectId, items, onClose }: Props) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['backlog', projectId] })
    queryClient.invalidateQueries({ queryKey: ['backlog-archived', projectId] })
    queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] })
  }
  const restore = useMutation({ mutationFn: api.backlog.restore, onSuccess: invalidate })
  const remove = useMutation({ mutationFn: api.backlog.remove, onSuccess: invalidate })
  const error = restore.error ?? remove.error

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 900, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
        <h3>Item archiviati</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          La sync non li ha più trovati nella JQL. I loro dati sono conservati e tornano da soli se l'item rientra nella
          JQL. Se ripristini a mano un item che non è nella JQL, la sync successiva lo archivia di nuovo.
        </p>
        {error && <div className="error-banner">{(error as Error).message}</div>}
        {items.length === 0 ? (
          <p className="muted">Nessun item archiviato.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Chiave</th>
                  <th>Summary</th>
                  <th>Pianificato</th>
                  <th>Archiviato il</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <a href={`https://inpeco.atlassian.net/browse/${item.jira_key}`} target="_blank" rel="noreferrer">
                        {item.jira_key}
                      </a>
                    </td>
                    <td style={{ whiteSpace: 'normal' }}>{item.summary}</td>
                    <td>
                      {item.planned_start ? (
                        `${formatIsoDate(item.planned_start)} → ${formatIsoDate(item.expected_finish) ?? '?'}`
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td>{item.archived_at && parseBackendDateTime(item.archived_at).toLocaleDateString('it-IT')}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="btn" disabled={restore.isPending} onClick={() => restore.mutate(item.id)}>
                        Ripristina
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Eliminare definitivamente ${item.jira_key} e i suoi dati?`)) remove.mutate(item.id)
                        }}
                      >
                        Elimina
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  )
}
