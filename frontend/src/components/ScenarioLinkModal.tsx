import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'

type Props = {
  projectId: number
  jiraKey: string
  onSave: (link: string) => void
  onClose: () => void
}

// Collega a una Story una presentazione degli scenari gia' fatta: percorso di
// un file (scelto con "Sfoglia...", finestra di Windows aperta dal backend) o
// URL, es. SharePoint.
export function ScenarioLinkModal({ projectId, jiraKey, onSave, onClose }: Props) {
  const [link, setLink] = useState('')
  const browse = useMutation({
    mutationFn: () => api.scenarios.browse(projectId),
    onSuccess: (result) => result.path && setLink(result.path),
  })

  return (
    // onMouseDown con target===currentTarget: vedi ProjectFormModal.
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3>Collega scenari a {jiraKey}</h3>
        <div className="form-row">
          <label>Percorso del file pptx o URL</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              autoFocus
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="C:\...\PTBSYS-1234-Scenarios.pptx oppure https://..."
            />
            <button className="btn" disabled={browse.isPending} onClick={() => browse.mutate()}>
              {browse.isPending ? 'Scegli il file...' : 'Sfoglia...'}
            </button>
          </div>
        </div>
        {browse.isError && <div className="error-banner">{(browse.error as Error).message}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button
            className="btn btn-primary"
            disabled={!link.trim()}
            onClick={() => onSave(link.trim().replace(/^"(.*)"$/, '$1'))}
          >
            Collega
          </button>
        </div>
      </div>
    </div>
  )
}
