import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api, saveBlob } from '../api/client'

type GeneratedFile = { blob: Blob; filename: string }
type ConflictChoice = 'overwrite' | 'rename' | 'skip'
type Conflict = { filename: string; suggested: string; resolve: (choice: ConflictChoice) => void }

// Consegna dei documenti generati nella sezione Documents: se l'increment ha
// la cartella dei documenti delle review (esistente) li salva li', chiedendo
// cosa fare se un file con lo stesso nome c'e' gia'; altrimenti li scarica
// nel browser come prima. `dialog` va messo in pagina da chi usa l'hook,
// dopo i propri popup, cosi' la conferma resta in primo piano.
export function useReviewDelivery(projectId: number) {
  const { data: folder } = useQuery({
    queryKey: ['review-folder', projectId],
    queryFn: () => api.reviewFolder.status(projectId),
  })
  const inFolder = !!folder?.folder_exists
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [saved, setSaved] = useState<string[] | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  // Restituisce i nomi dei file salvati nella cartella ([] se scaricati nel
  // browser o se l'utente non ha voluto sovrascrivere). showSaved: popup
  // finale coi file salvati e i pulsanti per aprirli.
  const deliver = async (files: GeneratedFile[], { showSaved = true } = {}): Promise<string[]> => {
    if (!inFolder) {
      files.forEach((f) => saveBlob(f.blob, f.filename))
      return []
    }
    const names: string[] = []
    for (const file of files) {
      let result = await api.reviewFolder.save(projectId, file.blob, file.filename, false)
      if (result.status === 'exists') {
        const suggested = result.suggested
        const choice = await new Promise<ConflictChoice>((resolve) =>
          setConflict({ filename: file.filename, suggested, resolve }),
        )
        setConflict(null)
        if (choice === 'skip') continue
        result =
          choice === 'overwrite'
            ? await api.reviewFolder.save(projectId, file.blob, file.filename, true)
            : await api.reviewFolder.save(projectId, file.blob, suggested, false)
      }
      if (result.status === 'saved') names.push(result.filename)
    }
    if (showSaved && names.length > 0) setSaved(names)
    return names
  }

  const open = (filename?: string) => {
    setOpenError(null)
    api.reviewFolder.open(projectId, filename).catch((e: Error) => setOpenError(e.message))
  }

  const dialog: ReactNode = (
    <>
      {conflict && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>File già presente</h3>
            <p style={{ marginTop: 0 }}>
              Nella cartella review esiste già <strong>{conflict.filename}</strong>.
            </p>
            <div className="form-actions">
              <button className="btn" onClick={() => conflict.resolve('skip')}>
                Non salvare
              </button>
              <button className="btn" onClick={() => conflict.resolve('rename')}>
                Salva come {conflict.suggested}
              </button>
              <button className="btn btn-primary" onClick={() => conflict.resolve('overwrite')}>
                Sovrascrivi
              </button>
            </div>
          </div>
        </div>
      )}
      {saved && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setSaved(null)}>
          <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Salvato nella cartella review</h3>
            <ul style={{ paddingLeft: 20 }}>
              {saved.map((name) => (
                <li key={name}>
                  {name}{' '}
                  <button className="link-btn" type="button" onClick={() => open(name)}>
                    Apri
                  </button>
                </li>
              ))}
            </ul>
            {openError && <div className="error-banner">{openError}</div>}
            <div className="form-actions">
              <button className="btn" onClick={() => open()}>
                📂 Apri cartella
              </button>
              <button className="btn btn-primary" onClick={() => setSaved(null)}>
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return { folder, inFolder, deliver, open, dialog }
}
