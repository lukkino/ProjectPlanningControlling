import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { SyncItemChange, SyncResult } from '../api/types'

// Popup dopo la sync del backlog da Jira: cosa e' cambiato, issue per issue
// (nuove, rientrate dall'archivio, archiviate, modificate con il valore
// prima e dopo di ogni campo). Le sole ore registrate cambiano spesso: si
// possono nascondere.
const SECTIONS: { kind: SyncItemChange['kind']; title: string; help: string }[] = [
  { kind: 'new', title: 'Nuove', help: 'Entrate nella JQL dell’increment' },
  { kind: 'restored', title: 'Rientrate', help: 'Erano archiviate e sono tornate nella JQL' },
  { kind: 'removed', title: 'Archiviate', help: 'Non più nella JQL: restano nell’archivio con i loro dati' },
  { kind: 'updated', title: 'Modificate', help: 'Campi cambiati su Jira' },
]
const HOURS_FIELD = 'Ore registrate'

export function SyncChangesModal({ result, onClose }: { result: SyncResult; onClose: () => void }) {
  const [hideHours, setHideHours] = useState(true)
  const all = result.changes ?? []
  const visible = all
    .map((c) => (hideHours && c.kind === 'updated' ? { ...c, changes: c.changes.filter((f) => f.field !== HOURS_FIELD) } : c))
    .filter((c) => c.kind !== 'updated' || c.changes.length > 0)
  const hoursOnly = all.filter((c) => c.kind === 'updated' && c.changes.every((f) => f.field === HOURS_FIELD)).length

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sync-changes" style={{ width: 760 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Cosa è cambiato con la sincronizzazione</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          {result.total_matched} issue nella JQL · {result.created} nuove · {result.removed} archiviate
          {result.restored > 0 && ` · ${result.restored} rientrate`} ·{' '}
          {all.filter((c) => c.kind === 'updated').length} modificate
        </p>
        {hoursOnly > 0 && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={hideHours} onChange={(e) => setHideHours(e.target.checked)} />
            Nascondi le sole ore registrate ({hoursOnly} issue con solo questo cambiamento)
          </label>
        )}
        <div className="sync-changes-body">
          {visible.length === 0 ? (
            <p className="muted">Nessun cambiamento: il backlog era già allineato a Jira.</p>
          ) : (
            SECTIONS.map((section) => {
              const items = visible.filter((c) => c.kind === section.kind)
              if (items.length === 0) return null
              return (
                <div key={section.kind} className="sync-changes-section">
                  <h4>
                    {section.title} ({items.length}) <span className="muted">· {section.help}</span>
                  </h4>
                  <ul>
                    {items.map((c) => (
                      <li key={c.jira_key}>
                        <a href={`https://inpeco.atlassian.net/browse/${c.jira_key}`} target="_blank" rel="noreferrer">
                          {c.jira_key}
                        </a>{' '}
                        {c.issue_type && <span className="muted">{c.issue_type} · </span>}
                        {c.summary ?? ''}
                        {c.changes.length > 0 && (
                          <table className="sync-changes-fields">
                            <tbody>
                              {c.changes.map((f) => (
                                <tr key={f.field}>
                                  <td className="muted">{f.field}</td>
                                  {c.kind === 'new' ? (
                                    <td colSpan={3}>{f.new ?? '—'}</td>
                                  ) : f.field === 'Descrizione' ? (
                                    <td colSpan={3}>modificata</td>
                                  ) : (
                                    <>
                                      <td className="sync-old">{f.old ?? '—'}</td>
                                      <td className="muted">→</td>
                                      <td className="sync-new">{f.new ?? '—'}</td>
                                    </>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })
          )}
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
