import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react'
import { api } from '../api/client'
import { richTextToHtml, serializeRichText } from '../lib/richText'

// Sola lettura di un testo formattato (vedi lib/richText). L'HTML e' generato
// da richTextToHtml a partire da testo con escape, mai salvato ne' preso
// dall'utente cosi' com'e'.
export function RichText({ text }: { text: string | null | undefined }) {
  return <div className="rich-text" dangerouslySetInnerHTML={{ __html: richTextToHtml(text) }} />
}

type Format = 'bold' | 'insertUnorderedList' | 'insertOrderedList'

const NO_FORMAT: Record<Format, boolean> = { bold: false, insertUnorderedList: false, insertOrderedList: false }

type Props = { projectId: number; scope: string | null }

// Scope dell'increment modificabile direttamente dalla Dashboard, senza
// passare dal modale "Modifica increment", con grassetto ed elenchi
// puntati/numerati.
export function ScopeCard({ projectId, scope }: Props) {
  const [editing, setEditing] = useState(false)
  const [active, setActive] = useState(NO_FORMAT)
  const editorRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (value: string | null) => api.projects.update(projectId, { scope: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      // Lo Scope compare anche nella pagina del Progetto collegato.
      queryClient.invalidateQueries({ queryKey: ['increment'] })
      setEditing(false)
    },
  })

  // Contenuto iniziale scritto a mano nel DOM (non via JSX): da li' in poi
  // l'editor e' gestito dal browser e React non deve piu' toccarlo, o un
  // re-render azzererebbe testo e posizione del cursore.
  const initialHtml = useRef('')
  useLayoutEffect(() => {
    if (!editing || !editorRef.current) return
    editorRef.current.innerHTML = initialHtml.current
    editorRef.current.focus()
  }, [editing])

  const refreshActive = () =>
    setActive({
      bold: document.queryCommandState('bold'),
      insertUnorderedList: document.queryCommandState('insertUnorderedList'),
      insertOrderedList: document.queryCommandState('insertOrderedList'),
    })

  const applyFormat = (format: Format) => {
    editorRef.current?.focus()
    document.execCommand(format)
    refreshActive()
  }

  // Ctrl+B funziona gia' da solo; corsivo e sottolineato invece non vengono
  // salvati, quindi le loro scorciatoie sono disattivate per non mostrare
  // una formattazione che sparirebbe al salvataggio.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && ['i', 'u'].includes(e.key.toLowerCase())) e.preventDefault()
  }

  // Incolla sempre come testo semplice: niente font/colori/tabelle da Word,
  // Jira o pagine web.
  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
  }

  const startEditing = () => {
    save.reset()
    initialHtml.current = richTextToHtml(scope)
    setActive(NO_FORMAT)
    setEditing(true)
  }

  const handleSave = () => {
    if (editorRef.current) save.mutate(serializeRichText(editorRef.current) || null)
  }

  // onMouseDown + preventDefault: il click sul pulsante non deve togliere il
  // focus (e la selezione) all'editor, altrimenti il comando non avrebbe
  // nulla a cui applicarsi.
  const toolbarButton = (format: Format, label: ReactNode, title: string) => (
    <button
      type="button"
      className={`btn rich-text-tool${active[format] ? ' active' : ''}`}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        applyFormat(format)
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 10, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Scope</h3>
        {!editing && (
          <button className="btn" onClick={startEditing}>
            Modifica
          </button>
        )}
      </div>

      {!editing && (scope ? <RichText text={scope} /> : <p className="muted" style={{ margin: 0 }}>Nessuno scope definito.</p>)}

      {editing && (
        <>
          <div className="rich-text-toolbar">
            {toolbarButton('bold', <strong>G</strong>, 'Grassetto (Ctrl+B)')}
            {toolbarButton('insertUnorderedList', '• Elenco puntato', 'Elenco puntato')}
            {toolbarButton('insertOrderedList', '1. Elenco numerato', 'Elenco numerato')}
          </div>
          <div
            ref={editorRef}
            className="rich-text rich-text-editor"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Scope"
            onKeyDown={handleKeyDown}
            onKeyUp={refreshActive}
            onMouseUp={refreshActive}
            onPaste={handlePaste}
          />
          {save.isError && (
            <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
              Salvataggio non riuscito: {(save.error as Error).message}
            </div>
          )}
          <div className="form-actions">
            <button className="btn" onClick={() => setEditing(false)} disabled={save.isPending}>
              Annulla
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={save.isPending}>
              {save.isPending ? 'Salvataggio...' : 'Salva'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
