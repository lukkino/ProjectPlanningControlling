import { useMutation, useQueryClient } from '@tanstack/react-query'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import {
  editorToStoredHtml,
  hasEarlierNumberedList,
  innermostList,
  richTextExtensions,
  setTaskCheckedFromDom,
  toEditorHtml,
  toggleContinuedNumbering,
  toggleList,
  toggleNumberedList,
} from '../lib/richText'

// onCheck: se presente, le caselle degli elenchi di controllo si possono
// spuntare anche in sola lettura, senza entrare in modifica; riceve il testo
// aggiornato da salvare. syncPaused sospende il riallineamento al valore di
// `text` mentre un salvataggio e' in corso, per non far tornare indietro per
// un attimo una spunta fatta nel frattempo.
type RichTextProps = {
  text: string | null | undefined
  onCheck?: (value: string | null) => void
  syncPaused?: boolean
}

// Sola lettura di un testo formattato (vedi lib/richText): stesso motore e
// stesso CSS dell'editor, cosi' cio' che si vede modificando e' identico a
// cio' che resta dopo il salvataggio.
export function RichText({ text, onCheck, syncPaused = false }: RichTextProps) {
  const checkable = !!onCheck
  const editor = useEditor(
    {
      extensions: richTextExtensions({ editable: false, checkable }),
      content: toEditorHtml(text),
      editable: false,
      editorProps: { attributes: { class: checkable ? 'rich-text' : 'rich-text rich-text--static' } },
    },
    [checkable],
  )

  useEffect(() => {
    if (syncPaused || editorToStoredHtml(editor) === (text || null)) return
    editor.commands.setContent(toEditorHtml(text))
  }, [editor, text, syncPaused])

  const onCheckRef = useRef(onCheck)
  useEffect(() => {
    onCheckRef.current = onCheck
  })

  // Listener nativo sul contenitore: le caselle sono create da TipTap fuori
  // da React, che quindi non ne vede gli eventi.
  const wrapperRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const handleChange = (event: Event) => {
      const box = event.target
      if (!onCheckRef.current || !(box instanceof HTMLInputElement) || box.type !== 'checkbox') return
      if (setTaskCheckedFromDom(editor, box)) onCheckRef.current(editorToStoredHtml(editor))
    }
    wrapper.addEventListener('change', handleChange)
    return () => wrapper.removeEventListener('change', handleChange)
  }, [editor])

  return (
    <div ref={wrapperRef}>
      <EditorContent editor={editor} />
    </div>
  )
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

// Colori del testo: i toni gia' usati nell'app (index.css), leggibili sul
// fondo bianco della card.
const TEXT_COLORS = [
  { value: '#66707d', label: 'Grigio' },
  { value: '#2f6fed', label: 'Blu' },
  { value: '#1f7a7a', label: 'Verde acqua' },
  { value: '#1a9c5c', label: 'Verde' },
  { value: '#c97a12', label: 'Arancio' },
  { value: '#d3402f', label: 'Rosso' },
  { value: '#5b3fb0', label: 'Viola' },
]

// Il colore torna dal documento salvato come "rgb(r, g, b)" (lo normalizza
// il browser), mentre la tavolozza e' in esadecimale: stesso formato per
// poter riconoscere il colore attivo.
function toRgb(color: string | null): string | null {
  const hex = color && /^#([0-9a-f]{6})$/i.exec(color)
  if (!hex) return color
  const n = parseInt(hex[1], 16)
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`
}

function ColorTool({ editor, current }: { editor: Editor; current: string | null }) {
  const [open, setOpen] = useState(false)

  const apply = (color: string | null) => {
    if (color) editor.chain().focus().setColor(color).run()
    else editor.chain().focus().unsetColor().run()
    setOpen(false)
  }

  return (
    <span className="rich-text-color">
      <Tool
        label={<span style={{ borderBottom: `3px solid ${current ?? 'var(--text)'}`, padding: '0 2px' }}>A</span>}
        title="Colore del testo"
        active={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <>
          <div className="rich-text-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="rich-text-palette" onMouseDown={(e) => e.preventDefault()}>
            <button
              type="button"
              className="rich-text-swatch rich-text-swatch--default"
              title="Colore predefinito"
              onClick={() => apply(null)}
            >
              A
            </button>
            {TEXT_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`rich-text-swatch${toRgb(current) === toRgb(c.value) ? ' active' : ''}`}
                style={{ background: c.value }}
                title={c.label}
                aria-label={c.label}
                onClick={() => apply(c.value)}
              />
            ))}
          </div>
        </>
      )}
    </span>
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
        color: (e.getAttributes('textStyle').color as string | undefined) ?? null,
        bullet: list?.node.type.name === 'bulletList',
        task: list?.node.type.name === 'taskList',
        numbered,
        continued: numbered && !!list?.node.attrs.continued,
        canContinue: numbered && !!list && (!!list.node.attrs.continued || hasEarlierNumberedList(e.state, list)),
        canIndent: e.can().sinkListItem('listItem') || e.can().sinkListItem('taskItem'),
        canOutdent: e.can().liftListItem('listItem') || e.can().liftListItem('taskItem'),
        blockquote: e.isActive('blockquote'),
        codeBlock: e.isActive('codeBlock'),
        table: e.isActive('table'),
        canMergeOrSplit: e.can().mergeOrSplit(),
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

  // Le voci degli elenchi di controllo sono un tipo di nodo diverso da
  // quelle degli elenchi puntati/numerati: si prova prima l'uno, poi l'altro.
  const indent = () => chain().sinkListItem('listItem').run() || chain().sinkListItem('taskItem').run()
  const outdent = () => chain().liftListItem('listItem').run() || chain().liftListItem('taskItem').run()

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
      <div className="rich-text-toolbar-row">
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
        <ColorTool editor={editor} current={s.color} />
        <span className="rich-text-sep" />
        <Tool label="• Elenco" title="Elenco puntato (Ctrl+Shift+8)" active={s.bullet} onClick={() => toggleList(editor, 'bulletList')} />
        <Tool label="1. Elenco" title="Elenco numerato (Ctrl+Shift+7)" active={s.numbered} onClick={() => toggleNumberedList(editor)} />
        <Tool
          label="☑ Elenco"
          title="Elenco di controllo: caselle per marcare le voci completate (Ctrl+Shift+9)"
          active={s.task}
          onClick={() => toggleList(editor, 'taskList')}
        />
        <Tool label="⇥" title="Aumenta rientro: annida la voce nell'elenco (Tab)" disabled={!s.canIndent} onClick={indent} />
        <Tool label="⇤" title="Riduci rientro (Shift+Tab)" disabled={!s.canOutdent} onClick={outdent} />
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
        <Tool
          label="Tabella"
          title="Inserisci tabella (3 x 3, con riga di intestazione)"
          disabled={s.table}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <span className="rich-text-sep" />
        <Tool label="↶" title="Annulla (Ctrl+Z)" disabled={!s.canUndo} onClick={() => chain().undo().run()} />
        <Tool label="↷" title="Ripeti (Ctrl+Y)" disabled={!s.canRedo} onClick={() => chain().redo().run()} />
        <Tool label="Tx" title="Rimuovi formattazione" onClick={() => chain().unsetAllMarks().clearNodes().run()} />
      </div>
      {/* Comandi della tabella: solo col cursore dentro una tabella. */}
      {s.table && (
        <div className="rich-text-toolbar-row">
          <span className="muted rich-text-toolbar-label">Tabella</span>
          <Tool label="+ Riga sopra" title="Aggiungi una riga sopra" onClick={() => chain().addRowBefore().run()} />
          <Tool label="+ Riga sotto" title="Aggiungi una riga sotto" onClick={() => chain().addRowAfter().run()} />
          <Tool label="− Riga" title="Elimina la riga" onClick={() => chain().deleteRow().run()} />
          <span className="rich-text-sep" />
          <Tool label="+ Col. a sinistra" title="Aggiungi una colonna a sinistra" onClick={() => chain().addColumnBefore().run()} />
          <Tool label="+ Col. a destra" title="Aggiungi una colonna a destra" onClick={() => chain().addColumnAfter().run()} />
          <Tool label="− Colonna" title="Elimina la colonna" onClick={() => chain().deleteColumn().run()} />
          <span className="rich-text-sep" />
          <Tool label="Intestazione" title="Attiva/disattiva la riga di intestazione" onClick={() => chain().toggleHeaderRow().run()} />
          <Tool
            label="Unisci / dividi"
            title="Unisci le celle selezionate (trascinando col mouse) o dividi una cella unita"
            disabled={!s.canMergeOrSplit}
            onClick={() => chain().mergeOrSplit().run()}
          />
          <span className="rich-text-sep" />
          <Tool label="Elimina tabella" title="Elimina l'intera tabella" onClick={() => chain().deleteTable().run()} />
        </div>
      )}
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
    extensions: richTextExtensions({ editable: true }),
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
// (stili, colori, elenchi annidati, tabelle, link...). Le caselle degli
// elenchi di controllo si spuntano anche senza entrare in modifica.
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

      {!editing &&
        (scope ? (
          <RichText text={scope} onCheck={(value) => save.mutate(value)} syncPaused={save.isPending} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>Nessuno scope definito.</p>
        ))}
      {!editing && save.isError && (
        <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
          Salvataggio non riuscito: {(save.error as Error).message}
        </div>
      )}

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
