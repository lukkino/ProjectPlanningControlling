import { useMutation, useQueryClient } from '@tanstack/react-query'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import {
  editorToStoredHtml,
  hasEarlierNumberedList,
  innermostList,
  richTextExtensions,
  toEditorHtml,
  toggleContinuedNumbering,
  toggleNumberedList,
} from '../lib/richText'

// Sola lettura di un testo formattato (vedi lib/richText): stesso motore e
// stesso CSS dell'editor, cosi' cio' che si vede modificando e' identico a
// cio' che resta dopo il salvataggio.
export function RichText({ text }: { text: string | null | undefined }) {
  const editor = useEditor(
    {
      extensions: richTextExtensions(false),
      content: toEditorHtml(text),
      editable: false,
      editorProps: { attributes: { class: 'rich-text' } },
    },
    [text],
  )
  return <EditorContent editor={editor} />
}

type ToolProps = {
  label: ReactNode
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

// onMouseDown + preventDefault: il click sul pulsante non deve togliere il
// focus (e la selezione) all'editor.
function Tool({ label, title, active = false, disabled = false, onClick }: ToolProps) {
  return (
    <button
      type="button"
      className={`btn rich-text-tool${active ? ' active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

const BLOCK_STYLES = [
  { value: '0', label: 'Testo normale' },
  { value: '1', label: 'Titolo 1' },
  { value: '2', label: 'Titolo 2' },
  { value: '3', label: 'Titolo 3' },
]

function Toolbar({ editor }: { editor: Editor }) {
  // useEditor non fa ri-renderizzare a ogni transazione: lo stato dei
  // pulsanti (attivo/disabilitato) viene letto qui, a ogni cambio di
  // selezione o contenuto.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const list = innermostList(e.state)
      const numbered = list?.node.type.name === 'orderedList'
      return {
        heading: [1, 2, 3].find((level) => e.isActive('heading', { level })) ?? 0,
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        link: e.isActive('link'),
        bullet: list?.node.type.name === 'bulletList',
        numbered,
        continued: numbered && !!list?.node.attrs.continued,
        canContinue: numbered && !!list && (!!list.node.attrs.continued || hasEarlierNumberedList(e.state, list)),
        canIndent: e.can().sinkListItem('listItem'),
        canOutdent: e.can().liftListItem('listItem'),
        blockquote: e.isActive('blockquote'),
        codeBlock: e.isActive('codeBlock'),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      }
    },
  })

  const chain = () => editor.chain().focus()

  const setBlockStyle = (value: string) => {
    const level = Number(value) as 0 | 1 | 2 | 3
    if (level === 0) chain().setParagraph().run()
    else chain().setHeading({ level }).run()
  }

  const editLink = () => {
    const current = editor.getAttributes('link').href as string | undefined
    const input = window.prompt('Indirizzo del link (vuoto per rimuoverlo)', current ?? 'https://')
    if (input === null) return
    const href = input.trim()
    if (!href || href === 'https://') {
      chain().extendMarkRange('link').unsetLink().run()
    } else if (editor.state.selection.empty && !current) {
      // Nessun testo selezionato: inserisce l'indirizzo stesso come link.
      chain().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run()
    } else {
      chain().extendMarkRange('link').setLink({ href }).run()
    }
  }

  return (
    <div className="rich-text-toolbar">
      <select
        className="rich-text-style"
        title="Stile del testo"
        aria-label="Stile del testo"
        value={String(s.heading)}
        onChange={(e) => setBlockStyle(e.target.value)}
      >
        {BLOCK_STYLES.map((b) => (
          <option key={b.value} value={b.value}>
            {b.label}
          </option>
        ))}
      </select>
      <span className="rich-text-sep" />
      <Tool label={<strong>G</strong>} title="Grassetto (Ctrl+B)" active={s.bold} onClick={() => chain().toggleBold().run()} />
      <Tool label={<em>C</em>} title="Corsivo (Ctrl+I)" active={s.italic} onClick={() => chain().toggleItalic().run()} />
      <Tool label={<u>S</u>} title="Sottolineato (Ctrl+U)" active={s.underline} onClick={() => chain().toggleUnderline().run()} />
      <Tool label={<s>ab</s>} title="Barrato (Ctrl+Shift+S)" active={s.strike} onClick={() => chain().toggleStrike().run()} />
      <Tool label="</>" title="Codice (Ctrl+E)" active={s.code} onClick={() => chain().toggleCode().run()} />
      <span className="rich-text-sep" />
      <Tool label="• Elenco" title="Elenco puntato (Ctrl+Shift+8)" active={s.bullet} onClick={() => chain().toggleBulletList().run()} />
      <Tool label="1. Elenco" title="Elenco numerato (Ctrl+Shift+7)" active={s.numbered} onClick={() => toggleNumberedList(editor)} />
      <Tool label="⇥" title="Aumenta rientro: annida la voce nell'elenco (Tab)" disabled={!s.canIndent} onClick={() => chain().sinkListItem('listItem').run()} />
      <Tool label="⇤" title="Riduci rientro (Shift+Tab)" disabled={!s.canOutdent} onClick={() => chain().liftListItem('listItem').run()} />
      <Tool
        label="…2. 3."
        title="Continua la numerazione dell'elenco numerato precedente (disattivato: riparte da 1)"
        active={s.continued}
        disabled={!s.canContinue}
        onClick={() => toggleContinuedNumbering(editor)}
      />
      <span className="rich-text-sep" />
      <Tool label="Link" title="Inserisci o modifica link" active={s.link} onClick={editLink} />
      <Tool label="❝" title="Citazione" active={s.blockquote} onClick={() => chain().toggleBlockquote().run()} />
      <Tool label="{ }" title="Blocco di codice" active={s.codeBlock} onClick={() => chain().toggleCodeBlock().run()} />
      <Tool label="―" title="Linea orizzontale" onClick={() => chain().setHorizontalRule().run()} />
      <span className="rich-text-sep" />
      <Tool label="↶" title="Annulla (Ctrl+Z)" disabled={!s.canUndo} onClick={() => chain().undo().run()} />
      <Tool label="↷" title="Ripeti (Ctrl+Y)" disabled={!s.canRedo} onClick={() => chain().redo().run()} />
      <Tool label="Tx" title="Rimuovi formattazione" onClick={() => chain().unsetAllMarks().clearNodes().run()} />
    </div>
  )
}

type EditorProps = {
  initialText: string | null
  saving: boolean
  error: Error | null
  onSave: (value: string | null) => void
  onCancel: () => void
}

function ScopeEditor({ initialText, saving, error, onSave, onCancel }: EditorProps) {
  const editor = useEditor({
    extensions: richTextExtensions(true),
    content: toEditorHtml(initialText),
    autofocus: 'end',
    editorProps: { attributes: { class: 'rich-text', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Scope' } },
  })

  return (
    <>
      <div className="rich-text-editor">
        <Toolbar editor={editor} />
        <EditorContent editor={editor} />
      </div>
      {error && (
        <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
          Salvataggio non riuscito: {error.message}
        </div>
      )}
      <div className="form-actions">
        <button className="btn" onClick={onCancel} disabled={saving}>
          Annulla
        </button>
        <button className="btn btn-primary" onClick={() => onSave(editorToStoredHtml(editor))} disabled={saving}>
          {saving ? 'Salvataggio...' : 'Salva'}
        </button>
      </div>
    </>
  )
}

type Props = { projectId: number; scope: string | null }

// Scope dell'increment modificabile direttamente dalla Dashboard, senza
// passare dal modale "Modifica increment", con un editor di testo formattato
// (stili, elenchi annidati, link...).
export function ScopeCard({ projectId, scope }: Props) {
  const [editing, setEditing] = useState(false)
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

  const startEditing = () => {
    save.reset()
    setEditing(true)
  }

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
        <ScopeEditor
          initialText={scope}
          saving={save.isPending}
          error={save.error as Error | null}
          onSave={(value) => save.mutate(value)}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  )
}
