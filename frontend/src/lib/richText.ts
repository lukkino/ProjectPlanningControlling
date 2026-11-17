import { OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import { Extension } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

// Testo formattato (Scope dell'increment), editor TipTap/ProseMirror. Nel DB
// il campo contiene l'HTML prodotto dall'editor; i valori precedenti (testo
// semplice, eventualmente con **grassetto** e righe "- voce" / "1. voce")
// vengono convertiti al volo da toEditorHtml, senza migrazione. L'HTML
// salvato non viene mai inserito nella pagina cosi' com'e': passa sempre dal
// parser dell'editor (anche in sola lettura), che tiene solo i nodi previsti
// dallo schema - niente script, attributi o stili arbitrari.

const BULLET_RE = /^\s*[-*•]\s+(.*)$/
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/
const HTML_RE = /^\s*<(p|h[1-6]|ul|ol|blockquote|pre|hr|table)[\s>]/i

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const inlineHtml = (s: string) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

// Vecchio formato a testo semplice: un paragrafo per riga, righe di elenco
// consecutive raggruppate in <ul>/<ol>.
function plainTextToHtml(text: string): string {
  let html = ''
  let openList: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (openList) html += `</${openList}>`
    openList = null
  }
  for (const line of text.split(/\r?\n/)) {
    const bullet = BULLET_RE.exec(line)
    const numbered = bullet ? null : NUMBERED_RE.exec(line)
    const list = bullet ? 'ul' : numbered ? 'ol' : null
    if (list !== openList) {
      closeList()
      if (list) html += `<${list}>`
      openList = list
    }
    const item = bullet ?? numbered
    html += item ? `<li>${inlineHtml(item[1])}</li>` : `<p>${inlineHtml(line)}</p>`
  }
  closeList()
  return html
}

export function toEditorHtml(text: string | null | undefined): string {
  if (!text) return ''
  return HTML_RE.test(text) ? text : plainTextToHtml(text)
}

// Valore da salvare: null se vuoto; via i paragrafi vuoti in coda (l'editor
// ne tiene sempre uno dopo un elenco o un blocco, per poterci cliccare).
export function editorToStoredHtml(editor: Editor): string | null {
  if (editor.isEmpty) return null
  return editor.getHTML().replace(/(<p><\/p>)+$/, '') || null
}

const isNumbered = (node: PMNode) => node.type.name === 'orderedList'

// Elenco numerato con numerazione "continuata": un elenco con continued=true
// riparte dal numero successivo all'ultimo elenco numerato che lo precede
// allo stesso livello (es. 1. 2. - paragrafo - 3. 4.). Lo start viene
// ricalcolato a ogni modifica del documento, quindi resta corretto anche
// aggiungendo o togliendo voci all'elenco precedente.
const NumberedList = OrderedList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      continued: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-continued') === 'true',
        renderHTML: (attributes: { continued?: boolean }) => (attributes.continued ? { 'data-continued': 'true' } : {}),
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((t) => t.docChanged)) return null
          const tr = state.tr
          // setNodeMarkup non cambia la dimensione dei nodi: le posizioni
          // calcolate sul documento originale restano valide per tutto il giro.
          const visit = (parent: PMNode, contentStart: number) => {
            let next: number | null = null
            parent.forEach((child, offset) => {
              const pos = contentStart + offset
              if (isNumbered(child)) {
                let start = child.attrs.start as number
                if (child.attrs.continued && start !== (next ?? 1)) {
                  start = next ?? 1
                  tr.setNodeMarkup(pos, undefined, { ...child.attrs, start })
                }
                next = start + child.childCount
              }
              if (!child.isTextblock && !child.isLeaf) visit(child, pos + 1)
            })
          }
          visit(state.doc, 0)
          return tr.docChanged ? tr : null
        },
      }),
    ]
  },
})

// Voci di elenco "Mandatorio" e "Tentative" (es. nello Scope): attributi
// delle voci di elenchi puntati, numerati e di controllo, salvati come
// data-mandatory / data-tentative. Una voce e' l'una o l'altra, non entrambe.
const LIST_ITEM_TYPES = ['listItem', 'taskItem']
// Link a una issue Jira (".../browse/PTBSYS-3416") il cui testo e' l'indirizzo
// stesso: si mostra solo la chiave, il link resta. Vale incollando o
// scrivendo un indirizzo e per i link gia' presenti, alla prima modifica; un
// link con un testo scelto a mano non si tocca.
const JIRA_BROWSE_RE = /^https?:\/\/[^/\s]+\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?(?:[?#]\S*)?$/i

export function jiraKeyOfLink(href: string, text: string): string | null {
  const match = JIRA_BROWSE_RE.exec(href)
  if (!match) return null
  const shown = text.trim().replace(/\/$/, '')
  const bare = href.replace(/\/$/, '')
  const sameAsHref = shown === bare || shown === bare.replace(/^https?:\/\//, '')
  return sameAsHref ? match[1].toUpperCase() : null
}

const JiraLinkText = Extension.create({
  name: 'jiraLinkText',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((t) => t.docChanged)) return null
          const edits: { from: number; to: number; key: string; node: PMNode }[] = []
          state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return
            const link = node.marks.find((m) => m.type.name === 'link')
            const key = link ? jiraKeyOfLink(String(link.attrs.href ?? ''), node.text) : null
            if (key && key !== node.text) edits.push({ from: pos, to: pos + node.nodeSize, key, node })
          })
          if (edits.length === 0) return null
          const tr = state.tr
          // Dal fondo, cosi' le posizioni prima di ogni modifica restano valide.
          for (const e of edits.reverse()) tr.replaceWith(e.from, e.to, state.schema.text(e.key, e.node.marks))
          return tr
        },
      }),
    ]
  },
})

export type ItemFlag = 'mandatory' | 'tentative'

const flagAttribute = (flag: ItemFlag) => ({
  default: false,
  parseHTML: (element: HTMLElement) => element.getAttribute(`data-${flag}`) === 'true',
  renderHTML: (attributes: Partial<Record<ItemFlag, boolean>>) => (attributes[flag] ? { [`data-${flag}`]: 'true' } : {}),
})

const ItemFlags = Extension.create({
  name: 'itemFlags',
  addGlobalAttributes() {
    return [{ types: LIST_ITEM_TYPES, attributes: { mandatory: flagAttribute('mandatory'), tentative: flagAttribute('tentative') } }]
  },
})

// Voci di elenco che citano una issue Jira in lavorazione (stato In Progress
// nel backlog): un razzo dopo il testo, come nella presentazione. Solo
// decorazione, non finisce nell'HTML salvato; le chiavi arrivano da fuori
// (setInProgressKeys). Contano i link alla issue e le chiavi scritte nel
// testo della voce stessa (non quelle delle sotto-voci).
const inProgressKey = new PluginKey<Set<string>>('jiraInProgress')
const BROWSE_KEY_RE = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i
const TEXT_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g

function textblockKeys(block: PMNode): string[] {
  const keys = new Set<string>()
  block.descendants((node) => {
    if (!node.isText) return
    const link = node.marks.find((m) => m.type.name === 'link')
    const match = link ? BROWSE_KEY_RE.exec(String(link.attrs.href ?? '')) : null
    if (match) keys.add(match[1].toUpperCase())
    for (const m of (node.text ?? '').matchAll(TEXT_KEY_RE)) keys.add(m[0])
  })
  return [...keys]
}

const JiraInProgress = Extension.create({
  name: 'jiraInProgress',
  addProseMirrorPlugins() {
    return [
      new Plugin<Set<string>>({
        key: inProgressKey,
        state: {
          init: () => new Set<string>(),
          apply: (tr, keys) => (tr.getMeta(inProgressKey) as Set<string> | undefined) ?? keys,
        },
        props: {
          decorations: (state) => {
            const keys = inProgressKey.getState(state)
            if (!keys?.size) return null
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!LIST_ITEM_TYPES.includes(node.type.name)) return
              const first = node.firstChild
              if (!first?.isTextblock) return
              const found = textblockKeys(first).filter((k) => keys.has(k))
              if (found.length === 0) return
              const from = pos + 1
              decorations.push(
                Decoration.node(from, from + first.nodeSize, {
                  class: 'scope-in-progress',
                  title: `In progress su Jira: ${found.join(', ')}`,
                }),
              )
            })
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})

export function setInProgressKeys(editor: Editor, keys: Iterable<string>) {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(inProgressKey, new Set(keys)))
}

// Voce di elenco piu' interna attorno al cursore.
export function currentListItem(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (LIST_ITEM_TYPES.includes(node.type.name)) return { node, pos: $from.before(depth) }
  }
  return null
}

// Attiva/toglie "Mandatorio" o "Tentative" sulla voce del cursore (attivarne
// uno toglie l'altro) e riordina il suo elenco: prima le voci mandatorie, poi
// le normali, in fondo le tentative, ognuna nel suo ordine di prima (le
// sotto-voci annidate si spostano con la loro voce). Gli elenchi dello stesso
// tipo attaccati a quello della voce (separati al piu' da righe vuote: capita
// premendo due volte Invio) vengono prima riuniti in uno solo, cosi' la voce
// sale davvero in cima; un titolo o un paragrafo con testo li tiene separati.
export function toggleItemFlag(editor: Editor, flag: ItemFlag) {
  const item = currentListItem(editor.state)
  if (!item) return
  const on = !item.node.attrs[flag]
  const other: ItemFlag = flag === 'mandatory' ? 'tentative' : 'mandatory'
  const attrs = { ...item.node.attrs, [flag]: on, ...(on ? { [other]: false } : {}) }
  const tr = editor.state.tr.setNodeMarkup(item.pos, undefined, attrs)
  const toggled = tr.doc.nodeAt(item.pos)
  const $item = tr.doc.resolve(item.pos)
  const listDepth = $item.depth
  const list = $item.parent
  const container = $item.node(listDepth - 1)
  const listIndex = $item.index(listDepth - 1)
  const isEmptyParagraph = (n: PMNode) => n.type.name === 'paragraph' && n.textContent.trim() === '' && n.childCount === 0
  const sameList = (n: PMNode) => n.type === list.type

  // Gruppo di elenchi da riunire: indici [first, last] nel contenitore.
  let first = listIndex
  for (let i = listIndex - 1; i >= 0; i--) {
    const n = container.child(i)
    if (sameList(n)) first = i
    else if (!isEmptyParagraph(n)) break
  }
  let last = listIndex
  for (let i = listIndex + 1; i < container.childCount; i++) {
    const n = container.child(i)
    if (sameList(n)) last = i
    else if (!isEmptyParagraph(n)) break
  }
  const items: PMNode[] = []
  for (let i = first; i <= last; i++) {
    const n = container.child(i)
    if (sameList(n)) n.forEach((child) => items.push(child))
  }
  const rank = (c: PMNode) => (c.attrs.mandatory ? 0 : c.attrs.tentative ? 2 : 1)
  const sorted = [0, 1, 2].flatMap((r) => items.filter((c) => rank(c) === r))

  // Posizione del primo elenco del gruppo e fine dell'ultimo.
  const containerStart = listDepth - 1 === 0 ? 0 : $item.start(listDepth - 1)
  let from = containerStart
  for (let i = 0; i < first; i++) from += container.child(i).nodeSize
  let to = from
  for (let i = first; i <= last; i++) to += container.child(i).nodeSize

  const merged = first !== last
  if (merged || sorted.some((c, i) => c !== items[i])) {
    // Un solo elenco, con gli attributi di quello della voce.
    tr.replaceWith(from, to, list.type.create(list.attrs, Fragment.fromArray(sorted), list.marks))
    // Il cursore resta sulla voce appena cambiata, nella sua nuova posizione.
    let offset = from + 1
    for (const child of sorted) {
      if (child === toggled) break
      offset += child.nodeSize
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(offset + 1)))
  }
  editor.view.dispatch(tr)
  editor.commands.focus()
}

// editable=false: sola lettura (senza il paragrafo vuoto di coda che l'editor
// aggiunge dopo elenchi e blocchi). I link non si aprono mai via JS: in sola
// lettura sono normali <a target="_blank">, in modifica un click posiziona
// solo il cursore.
// checkable: in sola lettura le caselle degli elenchi di controllo restano
// spuntabili (senza, TipTap annulla il click); chi monta l'editor deve poi
// riportare la spunta nel documento e salvarla, vedi setTaskCheckedFromDom.
export function richTextExtensions({ editable, checkable = false }: { editable: boolean; checkable?: boolean }) {
  return [
    StarterKit.configure({
      orderedList: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, defaultProtocol: 'https' },
      trailingNode: editable ? {} : false,
    }),
    NumberedList,
    TaskList,
    TaskItem.configure({
      nested: true,
      onReadOnlyChecked: checkable ? () => true : undefined,
      a11y: { checkboxLabel: (node) => `Completato: ${node.textContent || 'voce vuota'}` },
    }),
    TextStyle,
    Color,
    TableKit.configure({ table: { resizable: false } }),
    ItemFlags,
    JiraLinkText,
    JiraInProgress,
  ]
}

// Sola lettura: riporta nel documento la spunta appena cambiata su una
// casella (in modifica lo fa gia' TipTap). Restituisce false se la casella
// non appartiene a una voce di elenco di controllo.
export function setTaskCheckedFromDom(editor: Editor, checkbox: HTMLInputElement): boolean {
  const content = checkbox.closest('li')?.querySelector(':scope > div')
  if (!content) return false
  const $pos = editor.state.doc.resolve(editor.view.posAtDOM(content, 0))
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (node.type.name !== 'taskItem') continue
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup($pos.before(depth), undefined, { ...node.attrs, checked: checkbox.checked }),
    )
    return true
  }
  return false
}

type ListAt = { node: PMNode; pos: number }

// Elenco piu' interno attorno al cursore: con elenchi annidati di tipo
// diverso e' quello su cui agiscono i pulsanti della toolbar.
export function innermostList(state: EditorState): ListAt | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (isNumbered(node) || node.type.name === 'bulletList' || node.type.name === 'taskList') return { node, pos: $from.before(depth) }
  }
  return null
}

export function hasEarlierNumberedList(state: EditorState, list: ListAt): boolean {
  const $pos = state.doc.resolve(list.pos)
  for (let i = 0; i < $pos.index(); i++) if (isNumbered($pos.parent.child(i))) return true
  return false
}

function setListAttrs(editor: Editor, list: ListAt, attrs: Record<string, unknown>) {
  editor.view.dispatch(editor.state.tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, ...attrs }))
}

const ITEM_TYPE = { bulletList: 'listItem', orderedList: 'listItem', taskList: 'taskItem' } as const
type ListName = keyof typeof ITEM_TYPE

// Pulsanti degli elenchi: attiva/disattiva l'elenco o ne cambia il tipo. Il
// comando standard di TipTap, quando il cambio di tipo cambia anche il tipo
// delle voci (elenco di controllo <-> puntato/numerato), smonta l'elenco e
// lo ricrea al livello superiore, perdendo l'annidamento: in quel caso
// l'elenco viene invece sostituito sul posto, voce per voce.
export function toggleList(editor: Editor, listName: ListName) {
  const list = innermostList(editor.state)
  const current = list?.node.type.name as ListName | undefined
  if (!list || !current || current === listName || ITEM_TYPE[current] === ITEM_TYPE[listName]) {
    editor.chain().focus().toggleList(listName, ITEM_TYPE[listName]).run()
    return
  }
  const { schema, selection, tr } = editor.state
  const items: PMNode[] = []
  list.node.forEach((item) => items.push(schema.nodes[ITEM_TYPE[listName]].create(null, item.content)))
  tr.replaceWith(list.pos, list.pos + list.node.nodeSize, schema.nodes[listName].create(null, items))
  // Stessa struttura, stesse dimensioni: il cursore resta dov'era.
  tr.setSelection(TextSelection.create(tr.doc, selection.from, selection.to))
  editor.view.dispatch(tr)
  editor.commands.focus()
}

// Pulsante "Elenco numerato": un elenco appena creato prosegue la
// numerazione di quello che lo precede, se c'e'. Per ripartire da 1:
// pulsante "Continua numerazione" (o scrivere "1. " a mano).
export function toggleNumberedList(editor: Editor) {
  const before = innermostList(editor.state)
  toggleList(editor, 'orderedList')
  const after = innermostList(editor.state)
  if (!after || !isNumbered(after.node) || (before && isNumbered(before.node))) return
  if (hasEarlierNumberedList(editor.state, after)) setListAttrs(editor, after, { continued: true })
}

export function toggleContinuedNumbering(editor: Editor) {
  const list = innermostList(editor.state)
  if (!list || !isNumbered(list.node)) return
  const continued = !list.node.attrs.continued
  setListAttrs(editor, list, continued ? { continued } : { continued, start: 1 })
  editor.commands.focus()
}
