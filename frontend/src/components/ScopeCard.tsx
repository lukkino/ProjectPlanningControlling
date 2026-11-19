import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, saveBlob } from '../api/client'
import type { ScopeHistory } from '../api/types'
import { formatDateTime } from '../lib/dates'
import { scopeExportDocument, scopeExportHtml } from '../lib/scopeExport'
import { diffScope, scopeCounts } from '../lib/scopeDiff'
import { ScopeBacklogCheck } from './ScopeBacklogCheck'
import { ScopeChanges } from './ScopeChanges'
import {
  editorToStoredHtml,
  hasEarlierNumberedList,
  innermostList,
  richTextExtensions,
  currentListItem,
  setInProgressKeys,
  setTaskCheckedFromDom,
  toEditorHtml,
  toggleItemFlag,
  toggleContinuedNumbering,
  toggleList,
  toggleNumberedList,
} from '../lib/richText'

// onCheck: se presente, le caselle degli elenchi di controllo si possono
// spuntare anche in sola lettura, senza entrare in modifica; riceve il testo
// aggiornato da salvare. syncPaused sospende il riallineamento al valore di
// `text` mentre un salvataggio e' in corso, per non far tornare indietro per
// un attimo una spunta fatta nel frattempo. inProgressKeys: chiavi Jira delle
// issue in lavorazione, le voci che le citano hanno un razzo.
type RichTextProps = {
  text: string | null | undefined
  onCheck?: (value: string | null) => void
  syncPaused?: boolean
  inProgressKeys?: string[]
}

const NO_KEYS: string[] = []

function useInProgressKeys(editor: Editor, keys: string[]) {
  const joined = keys.join(',')
  useEffect(() => {
    setInProgressKeys(editor, joined ? joined.split(',') : [])
  }, [editor, joined])
}

// Sola lettura di un testo formattato (vedi lib/richText): stesso motore e
// stesso CSS dell'editor, cosi' cio' che si vede modificando e' identico a
// cio' che resta dopo il salvataggio.
export function RichText({ text, onCheck, syncPaused = false, inProgressKeys = NO_KEYS }: RichTextProps) {
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
  useInProgressKeys(editor, inProgressKeys)

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

// Totale delle voci dello Scope schematico: e' lo scope confermato, il
// backlog puo' non essere ancora allineato (vedi "Verifica con il backlog").
function ScopeTotals({ scope }: { scope: string | null }) {
  const c = useMemo(() => scopeCounts(scope), [scope])
  if (c.total === 0) return null
  const parts: ReactNode[] = []
  if (c.checkable > 0) {
    parts.push(
      <span key="done" style={{ color: 'var(--success)' }}>
        {c.done} completati
      </span>,
      <span key="todo">{c.total - c.done} da fare</span>,
    )
  }
  if (c.mandatory > 0) parts.push(<span key="m" style={{ color: 'var(--danger)' }}>★ {c.mandatory} mandatori</span>)
  if (c.tentative > 0) parts.push(<span key="t" style={{ color: 'var(--warning)' }}>? {c.tentative} tentative</span>)
  return (
    <div
      style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 10, fontSize: 14 }}
      title="Voci dello Scope confermato, senza contare le voci che raggruppano sotto-voci. Il backlog può non essere ancora allineato: vedi Verifica con il backlog."
    >
      <strong>{c.total} item nello scope</strong>
      {parts.map((part, i) => (
        <span key={i} className="muted">
          · {part}
        </span>
      ))}
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
        listItem: !!currentListItem(e.state),
        mandatory: !!currentListItem(e.state)?.node.attrs.mandatory,
        tentative: !!currentListItem(e.state)?.node.attrs.tentative,
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
        <Tool
          label="★ Mandatorio"
          title="Segna la voce dell'elenco come mandatoria (o togli il segno): le voci mandatorie vanno in cima al loro elenco"
          active={s.mandatory}
          disabled={!s.listItem}
          onClick={() => toggleItemFlag(editor, 'mandatory')}
        />
        <Tool
          label="? Tentative"
          title="Segna la voce dell'elenco come tentative, da fare solo se possibile (o togli il segno): le voci tentative vanno in fondo al loro elenco"
          active={s.tentative}
          disabled={!s.listItem}
          onClick={() => toggleItemFlag(editor, 'tentative')}
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
  inProgressKeys: string[]
  // Scope congelato: la modifica finisce nel registro, con il motivo.
  frozen: boolean
  saving: boolean
  error: Error | null
  onSave: (value: string | null, note: string | null) => void
  onCancel: () => void
}

function ScopeEditor({ initialText, inProgressKeys, frozen, saving, error, onSave, onCancel }: EditorProps) {
  const [note, setNote] = useState('')
  const editor = useEditor({
    extensions: richTextExtensions({ editable: true }),
    content: toEditorHtml(initialText),
    autofocus: 'end',
    editorProps: { attributes: { class: 'rich-text', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Scope' } },
  })
  useInProgressKeys(editor, inProgressKeys)
  const save = () => onSave(editorToStoredHtml(editor), note.trim() || null)

  return (
    // Ctrl+S (Cmd+S su Mac) salva senza dover scendere al pulsante.
    <div
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          if (!saving) save()
        }
      }}
    >
      {/* Barra degli strumenti e pulsanti restano a vista (sticky) mentre
          si scorre uno Scope lungo. */}
      <div className="rich-text-editor rich-text-editor--sticky">
        <Toolbar editor={editor} />
        <EditorContent editor={editor} />
      </div>
      {frozen && (
        <div style={{ marginTop: 10 }}>
          <label className="muted" style={{ fontSize: 13 }} htmlFor="scope-change-note">
            🔒 Lo Scope è congelato: la modifica verrà registrata. Motivo (facoltativo)
          </label>
          <input
            id="scope-change-note"
            type="text"
            value={note}
            placeholder="Es. richiesta del cliente, CR approvata il..."
            style={{ width: '100%', marginTop: 4 }}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {error && (
        <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
          Salvataggio non riuscito: {error.message}
        </div>
      )}
      <div className="form-actions form-actions--sticky">
        <span className="muted" style={{ fontSize: 12, marginRight: 'auto' }}>
          Ctrl+S per salvare
        </span>
        <button className="btn" onClick={onCancel} disabled={saving}>
          Annulla
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving} title="Salva (Ctrl+S)">
          {saving ? 'Salvataggio...' : 'Salva'}
        </button>
      </div>
    </div>
  )
}

// frozenAt/frozenBy: Scope schematico congelato (vedi ScopeChanges).
// title: intestazione e nome del file dello Scope esportato.
type Props = {
  projectId: number
  title: string
  scope: string | null
  narrative: string | null
  frozenAt: string | null
  frozenBy: string | null
}

type ScopeTab = 'schematic' | 'narrative'

const SCOPE_TABS: { value: ScopeTab; label: string }[] = [
  { value: 'schematic', label: 'Schematico' },
  { value: 'narrative', label: 'Discorsivo' },
]

// Pannello collassato o aperto: preferenza del browser, uguale per tutti
// gli increment.
const COLLAPSED_STORAGE_KEY = 'scope-card-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

// Copia sia il testo formattato, per Word e Outlook, sia quello semplice,
// con una riga vuota tra i blocchi.
async function copyRichText(html: string) {
  const blocks = new DOMParser().parseFromString(html, 'text/html').body.children
  const plain = Array.from(blocks, (block) => block.textContent).join('\n\n')
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    }),
  ])
}

// Scope dell'increment modificabile direttamente dalla Dashboard, senza
// passare dal modale "Modifica increment", con un editor di testo formattato
// (stili, colori, elenchi annidati, tabelle, link...). Le caselle degli
// elenchi di controllo si spuntano anche senza entrare in modifica. Il tab
// Discorsivo tiene una seconda versione, da copiare in Change Order e Release
// Notice: si parte da una proposta ricavata dal backlog, che resta da
// rivedere e diventa definitiva solo col Salva.
export function ScopeCard({ projectId, title, scope, narrative, frozenAt, frozenBy }: Props) {
  const [tab, setTab] = useState<ScopeTab>('schematic')
  const [editing, setEditing] = useState(false)
  const [editorText, setEditorText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  // Verifica di coerenza tra Scope schematico e backlog.
  const [checking, setChecking] = useState(false)
  // Pannello delle modifiche dal freeze.
  const [showChanges, setShowChanges] = useState(false)
  const queryClient = useQueryClient()
  const frozen = !!frozenAt
  const { data: history } = useQuery({
    queryKey: ['scope-history', projectId],
    queryFn: () => api.projects.scopeHistory(projectId),
    enabled: frozen,
  })
  const changeCount = useMemo(
    () => (frozen && history ? diffScope(history.baseline, scope).length : 0),
    [frozen, history, scope],
  )
  const current = tab === 'schematic' ? scope : narrative
  // Stessa query del backlog della Dashboard: issue in lavorazione ora.
  const { data: backlog } = useQuery({
    queryKey: ['backlog', projectId],
    queryFn: () => api.backlog.list(projectId),
  })
  const inProgressKeys = useMemo(
    () => (backlog ?? []).filter((i) => !i.archived_at && i.status === 'In Progress').map((i) => i.jira_key),
    [backlog],
  )

  const save = useMutation({
    mutationFn: ({ value, note = null }: { value: string | null; note?: string | null }) =>
      api.projects.update(
        projectId,
        tab === 'schematic' ? { scope: value, scope_change_note: note } : { scope_narrative: value },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      // Lo Scope compare anche nella pagina del Progetto collegato.
      queryClient.invalidateQueries({ queryKey: ['increment'] })
      queryClient.invalidateQueries({ queryKey: ['scope-history', projectId] })
      setEditing(false)
    },
  })

  const onFrozen = (data: ScopeHistory) => {
    queryClient.setQueryData(['scope-history', projectId], data)
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }
  const freeze = useMutation({
    mutationFn: (note: string | null) => api.projects.freezeScope(projectId, note),
    onSuccess: (data) => {
      onFrozen(data)
      setShowChanges(true)
    },
  })
  const unfreeze = useMutation({
    mutationFn: () => api.projects.unfreezeScope(projectId),
    onSuccess: (data) => {
      onFrozen(data)
      setShowChanges(false)
    },
  })
  const askFreeze = (again: boolean) => {
    const note = window.prompt(
      again
        ? 'Lo Scope attuale diventa la nuova baseline: le modifiche si conteranno da qui. Nota (facoltativa):'
        : 'Congela lo Scope com\'è ora: da qui ogni modifica verrà registrata e confrontata con questa baseline. Nota (facoltativa):',
      '',
    )
    if (note !== null) freeze.mutate(note.trim() || null)
  }
  const askUnfreeze = () => {
    if (window.confirm('Scongelare lo Scope? Le modifiche non verranno più registrate (il registro resta).')) {
      unfreeze.mutate()
    }
  }

  const startEditing = (text: string | null) => {
    save.reset()
    setEditorText(text)
    setEditing(true)
  }

  const generate = useMutation({
    mutationFn: () => api.documents.scopeNarrative(projectId),
    onSuccess: ({ html }) => startEditing(html),
  })

  const copy = useMutation({
    mutationFn: () => copyRichText(narrative ?? ''),
    onSuccess: () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    },
  })

  // Esportazione dello Scope schematico com'e' mostrato (etichette, razzi,
  // spunte e link a Jira): file HTML o copia per Outlook/Word.
  const scopeRef = useRef<HTMLDivElement>(null)
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })
  const exportedScope = () => {
    const source = scopeRef.current?.querySelector<HTMLElement>('.rich-text')
    if (!source) throw new Error('Scope non visibile')
    return scopeExportHtml(source, settings?.jira_base_url ?? null)
  }
  const exportNote = () =>
    `Scope esportato il ${new Date().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}` +
    (inProgressKeys.length ? ' · 🚀 = issue In Progress su Jira' : '')
  const [scopeCopied, setScopeCopied] = useState(false)
  const copyScope = useMutation({
    mutationFn: () => copyRichText(`<p><b>${title}</b></p>${exportedScope()}`),
    onSuccess: () => {
      setScopeCopied(true)
      setTimeout(() => setScopeCopied(false), 2000)
    },
  })
  const downloadScope = () => {
    const html = scopeExportDocument(exportedScope(), `Scope ${title}`, exportNote())
    const day = new Date().toISOString().slice(0, 10)
    saveBlob(new Blob([html], { type: 'text/html' }), `Scope ${title.replace(/[\\/:*?"<>|]/g, '_')} ${day}.html`)
  }

  const chooseTab = (value: ScopeTab) => {
    save.reset()
    generate.reset()
    copy.reset()
    setTab(value)
  }

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? '1' : '0')
    } catch {
      // localStorage non disponibile: la scelta vale solo per questa visita
    }
  }

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: collapsed ? 0 : 10, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>
          Scope
          {frozen && (
            <span
              className="badge ready"
              style={{ marginLeft: 8, verticalAlign: 'middle' }}
              title={`Scope congelato il ${formatDateTime(frozenAt)}${frozenBy ? ` da ${frozenBy}` : ''}: le modifiche vengono registrate`}
            >
              🔒 Congelato
            </span>
          )}
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {!editing && !collapsed && tab === 'schematic' && frozen && (
            <button
              className={`btn${showChanges ? ' active' : ''}`}
              title="Cosa è cambiato rispetto alla baseline e registro delle modifiche"
              aria-expanded={showChanges}
              onClick={() => setShowChanges((v) => !v)}
            >
              Modifiche dal freeze ({changeCount})
            </button>
          )}
          {!editing && !collapsed && tab === 'schematic' && !frozen && (
            <button
              className="btn"
              title="Fissa lo Scope com'è ora come baseline: da qui ogni modifica viene registrata"
              disabled={freeze.isPending || !scope}
              onClick={() => askFreeze(false)}
            >
              🔒 Congela
            </button>
          )}
          {!editing && !collapsed && tab === 'schematic' && scope && (
            <>
              <button
                className="btn"
                title="Scarica lo Scope come pagina HTML (etichette, razzi, spunte e link a Jira), da aprire nel browser o allegare a una mail"
                onClick={downloadScope}
              >
                ⬇ Esporta
              </button>
              <button
                className="btn"
                title="Copia lo Scope formattato, da incollare in Outlook, Word o Teams"
                onClick={() => copyScope.mutate()}
                disabled={copyScope.isPending}
              >
                {scopeCopied ? 'Copiato' : 'Copia'}
              </button>
            </>
          )}
          {!editing && !collapsed && tab === 'narrative' && narrative && (
            <button className="btn" onClick={() => copy.mutate()} disabled={copy.isPending}>
              {copied ? 'Copiato' : 'Copia'}
            </button>
          )}
          {!editing && !collapsed && tab === 'narrative' && (
            <button
              className="btn"
              title="Propone un testo ricavato da Scope, Story e Bug in scope. Si apre in modifica: il testo salvato cambia solo col Salva."
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
            >
              {generate.isPending ? 'Generazione...' : narrative ? 'Rigenera dal backlog' : 'Genera dal backlog'}
            </button>
          )}
          {!editing && !collapsed && tab === 'schematic' && (
            <button
              className="btn"
              title="Confronta le chiavi Jira dello scope con gli item del backlog (in scope, senza milestone e activity di servizio)"
              onClick={() => setChecking((v) => !v)}
            >
              {checking ? 'Chiudi verifica' : 'Verifica con il backlog'}
            </button>
          )}
          {!editing && !collapsed && (
            <button className="btn" onClick={() => startEditing(current)}>
              Modifica
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            style={{ minWidth: 110 }}
            title={collapsed ? 'Mostra lo Scope' : 'Nascondi lo Scope'}
            aria-expanded={!collapsed}
            disabled={editing}
            onClick={toggleCollapsed}
          >
            {collapsed ? '▼ Espandi' : '▲ Comprimi'}
          </button>
        </div>
      </div>

      {!collapsed && (
      <>
      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        {SCOPE_TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={tab === option.value}
            className={tab === option.value ? 'active' : undefined}
            disabled={editing}
            onClick={() => chooseTab(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {!editing && tab === 'schematic' && <ScopeTotals scope={scope} />}
      {showChanges && frozen && history && !editing && tab === 'schematic' && (
        <ScopeChanges
          history={history}
          scope={scope}
          busy={freeze.isPending || unfreeze.isPending}
          onRefreeze={() => askFreeze(true)}
          onUnfreeze={askUnfreeze}
        />
      )}
      {checking && !editing && tab === 'schematic' && (
        <ScopeBacklogCheck projectId={projectId} scope={scope} onClose={() => setChecking(false)} />
      )}
      {!editing &&
        (current ? (
          <div ref={scopeRef}>
            <RichText
              key={tab}
              text={current}
              onCheck={tab === 'schematic' ? (value) => save.mutate({ value }) : undefined}
              syncPaused={save.isPending}
              inProgressKeys={inProgressKeys}
            />
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {tab === 'schematic' ? 'Nessuno scope definito.' : 'Nessun testo discorsivo: generalo dal backlog o scrivilo a mano.'}
          </p>
        ))}
      {!editing && (save.isError || generate.isError || copy.isError || copyScope.isError || freeze.isError || unfreeze.isError) && (
        <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
          {save.isError && `Salvataggio non riuscito: ${(save.error as Error).message}`}
          {freeze.isError && `Congelamento non riuscito: ${(freeze.error as Error).message}`}
          {unfreeze.isError && `Scongelamento non riuscito: ${(unfreeze.error as Error).message}`}
          {generate.isError && `Generazione non riuscita: ${(generate.error as Error).message}`}
          {copy.isError && `Copia non riuscita: ${(copy.error as Error).message}`}
          {copyScope.isError && `Copia non riuscita: ${(copyScope.error as Error).message}`}
        </div>
      )}

      {editing && (
        <ScopeEditor
          initialText={editorText}
          inProgressKeys={inProgressKeys}
          frozen={frozen && tab === 'schematic'}
          saving={save.isPending}
          error={save.error as Error | null}
          onSave={(value, note) => save.mutate({ value, note })}
          onCancel={() => setEditing(false)}
        />
      )}
      </>
      )}
    </div>
  )
}
