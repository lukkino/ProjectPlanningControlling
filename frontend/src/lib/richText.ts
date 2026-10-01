// Testo formattato "leggero" (Scope dell'increment): nel DB resta testo
// semplice con tre sole convenzioni stile Markdown - **grassetto**, righe
// "- voce" (elenco puntato) e "1. voce" (elenco numerato). Niente HTML
// salvato: i testi gia' esistenti restano validi cosi' come sono e l'HTML
// mostrato a schermo e' sempre generato qui a partire da testo con escape.

const BULLET_RE = /^\s*[-*•]\s+(.*)$/
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const inlineHtml = (s: string) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

// Una <div> per riga (vuota = <div><br></div>) e <ul>/<ol> per le righe di
// elenco consecutive: e' la stessa struttura che produce il browser in un
// contentEditable, quindi vale sia per la sola lettura sia come contenuto
// iniziale dell'editor.
export function richTextToHtml(text: string | null | undefined): string {
  let html = ''
  let openList: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (openList) html += `</${openList}>`
    openList = null
  }
  for (const line of (text ?? '').split(/\r?\n/)) {
    const bullet = BULLET_RE.exec(line)
    const numbered = bullet ? null : NUMBERED_RE.exec(line)
    const list = bullet ? 'ul' : numbered ? 'ol' : null
    if (list !== openList) {
      closeList()
      if (list) html += `<${list}>`
      openList = list
    }
    const item = bullet ?? numbered
    html += item ? `<li>${inlineHtml(item[1])}</li>` : `<div>${inlineHtml(line) || '<br>'}</div>`
  }
  closeList()
  return html
}

function isBold(el: HTMLElement, inherited: boolean): boolean {
  if (el.tagName === 'B' || el.tagName === 'STRONG') return true
  const weight = el.style.fontWeight
  if (!weight) return inherited
  return weight === 'bold' || Number(weight) >= 600
}

const nodeText = (node: Node) => (node.textContent ?? '').replace(/ /g, ' ').replace(/\n/g, ' ')

const markBold = (text: string, bold: boolean) => (bold && text.trim() ? `**${text}**` : text)

// Testo di una voce di elenco: tutto sulla stessa riga, gli elenchi annidati
// sono esclusi (li aggiunge serializeRichText come voci a se').
function listItemText(node: Node, bold: boolean): string {
  let out = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) out += markBold(nodeText(child), bold)
    else if (child instanceof HTMLElement) {
      if (child.tagName === 'UL' || child.tagName === 'OL') return
      out += child.tagName === 'BR' ? ' ' : listItemText(child, isBold(child, bold))
    }
  })
  return out
}

// Inverso di richTextToHtml: dal DOM dell'editor (contentEditable) al testo
// da salvare. Tutto cio' che non e' grassetto o elenco viene perso di
// proposito (corsivo, colori, ecc.).
export function serializeRichText(root: HTMLElement): string {
  const lines: string[] = []
  let current: string | null = null
  const flush = () => {
    if (current !== null) lines.push(current)
    current = null
  }

  // Gli elenchi annidati (dentro una voce o direttamente nell'elenco) sono
  // appiattiti: diventano voci dello stesso livello, subito dopo la voce che
  // li contiene.
  const walkList = (list: HTMLElement, bold: boolean) => {
    const isList = (el: Element) => el.tagName === 'UL' || el.tagName === 'OL'
    let n = 0
    Array.from(list.children).forEach((child) => {
      if (!(child instanceof HTMLElement)) return
      if (isList(child)) return walkList(child, bold)
      const itemBold = isBold(child, bold)
      const text = listItemText(child, itemBold).trim()
      if (text) lines.push(`${list.tagName === 'OL' ? `${++n}.` : '-'} ${text}`)
      Array.from(child.querySelectorAll('ul, ol'))
        .filter((nested) => nested.parentElement?.closest('ul, ol') === list)
        .forEach((nested) => walkList(nested as HTMLElement, itemBold))
    })
  }

  const walk = (node: Node, bold: boolean) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        current = (current ?? '') + markBold(nodeText(child), bold)
        return
      }
      if (!(child instanceof HTMLElement)) return
      const tag = child.tagName
      if (tag === 'BR') {
        current = current ?? ''
        flush()
      } else if (tag === 'UL' || tag === 'OL') {
        flush()
        walkList(child, bold)
      } else if (tag === 'DIV' || tag === 'P' || tag === 'LI') {
        flush()
        walk(child, isBold(child, bold))
        flush()
      } else {
        walk(child, isBold(child, bold))
      }
    })
  }
  walk(root, false)
  flush()

  return lines
    // Due tratti in grassetto adiacenti ("**a****b**") sono un grassetto solo.
    .map((l) => l.replace(/\*\*\*\*/g, '').trimEnd())
    .join('\n')
    .trim()
}
