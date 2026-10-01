import { OrderedList } from '@tiptap/extension-list'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
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
const HTML_RE = /^\s*<(p|h[1-6]|ul|ol|blockquote|pre|hr)[\s>]/i

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

// editable=false: sola lettura (senza il paragrafo vuoto di coda che l'editor
// aggiunge dopo elenchi e blocchi). I link non si aprono mai via JS: in sola
// lettura sono normali <a target="_blank">, in modifica un click posiziona
// solo il cursore.
export function richTextExtensions(editable: boolean) {
  return [
    StarterKit.configure({
      orderedList: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, defaultProtocol: 'https' },
      trailingNode: editable ? {} : false,
    }),
    NumberedList,
  ]
}

type ListAt = { node: PMNode; pos: number }

// Elenco piu' interno attorno al cursore: con elenchi annidati di tipo
// diverso e' quello su cui agiscono i pulsanti della toolbar.
export function innermostList(state: EditorState): ListAt | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (isNumbered(node) || node.type.name === 'bulletList') return { node, pos: $from.before(depth) }
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

// Pulsante "Elenco numerato": come toggleOrderedList, ma un elenco appena
// creato prosegue la numerazione di quello che lo precede, se c'e'. Per
// ripartire da 1: pulsante "Continua numerazione" (o scrivere "1. " a mano).
export function toggleNumberedList(editor: Editor) {
  const before = innermostList(editor.state)
  editor.chain().focus().toggleOrderedList().run()
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
