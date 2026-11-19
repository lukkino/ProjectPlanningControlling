// Esportazione dello Scope schematico per condividerlo fuori dall'app: un
// file HTML a se' stante e una copia da incollare in Outlook/Word/Teams.
// Si parte dallo Scope come e' mostrato (DOM dell'editor in sola lettura):
// le etichette Mandatorio/Tentative, il razzo delle voci In Progress e la
// spunta delle voci completate sono disegnati col CSS dell'app, qui
// diventano testo con stili in linea, cosi' restano anche senza quel CSS.

const MUTED = '#6b7280'
const BADGE = 'display:inline-block;margin-right:8px;padding:0 6px;border-radius:8px;font-size:10px;font-weight:700;' +
  'text-transform:uppercase;letter-spacing:0.03em;vertical-align:1px;'
const MANDATORY_STYLE = `${BADGE}background:#fde8e8;color:#d3402f;`
const TENTATIVE_STYLE = `${BADGE}background:#fff2df;color:#c97a12;`
// Chiave Jira (PTBSYS-5740), non un codice come PTBSYS-03-003.
const JIRA_KEY = /\b([A-Z][A-Z0-9]+-\d+)(?![-\d])/g

function span(doc: Document, text: string, style: string): HTMLSpanElement {
  const el = doc.createElement('span')
  el.textContent = text
  el.setAttribute('style', style)
  return el
}

// Chiavi Jira scritte a mano (non gia' link) -> link alla issue.
function linkJiraKeys(root: HTMLElement, jiraBaseUrl: string) {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest('a')) && JIRA_KEY.test(n.nodeValue ?? '')) nodes.push(n as Text)
    JIRA_KEY.lastIndex = 0
  }
  for (const node of nodes) {
    const text = node.nodeValue ?? ''
    const fragment = doc.createDocumentFragment()
    let last = 0
    for (const match of text.matchAll(JIRA_KEY)) {
      fragment.append(text.slice(last, match.index))
      const a = doc.createElement('a')
      a.href = `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${match[1]}`
      a.textContent = match[1]
      fragment.append(a)
      last = (match.index ?? 0) + match[0].length
    }
    fragment.append(text.slice(last))
    node.replaceWith(fragment)
  }
}

// Frammento HTML dello Scope con stili in linea, dal suo elemento .rich-text.
export function scopeExportHtml(source: HTMLElement, jiraBaseUrl: string | null): string {
  const root = source.cloneNode(true) as HTMLElement
  const doc = root.ownerDocument
  root.removeAttribute('contenteditable')
  root.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
  root.querySelectorAll('.ProseMirror-trailingBreak, .ProseMirror-separator').forEach((el) => el.remove())

  // Elenchi di controllo: casella come carattere davanti al testo, voci
  // completate barrate e con la spunta verde.
  root.querySelectorAll<HTMLElement>("ul[data-type='taskList']").forEach((ul) => {
    // Sotto-elenchi rientrati, come nell'app.
    const nested = !!ul.parentElement?.closest('li')
    ul.setAttribute('style', `list-style:none;padding-left:${nested ? 24 : 4}px;margin:4px 0;`)
  })
  root.querySelectorAll<HTMLElement>("ul[data-type='taskList'] > li").forEach((li) => {
    const checked = li.getAttribute('data-checked') === 'true'
    li.querySelector(':scope > label')?.remove()
    const body = li.querySelector<HTMLElement>(':scope > div')
    if (body) {
      li.append(...Array.from(body.childNodes))
      body.remove()
    }
    const first = li.querySelector<HTMLElement>(':scope > p')
    if (first) {
      first.prepend(span(doc, checked ? '☑ ' : '☐ ', `color:${checked ? '#1a7f45' : MUTED};`))
      if (checked) {
        li.querySelectorAll<HTMLElement>(':scope > p').forEach((p) =>
          p.setAttribute('style', `color:${MUTED};text-decoration:line-through;`),
        )
        first.append(span(doc, ' ✓', 'display:inline-block;margin-left:4px;color:#1a7f45;font-weight:700;text-decoration:none;'))
      }
    }
  })

  // Etichette Mandatorio/Tentative davanti al testo della voce.
  root.querySelectorAll<HTMLElement>('li[data-mandatory="true"], li[data-tentative="true"]').forEach((li) => {
    const first = li.querySelector<HTMLElement>(':scope > p')
    if (!first) return
    const mandatory = li.getAttribute('data-mandatory') === 'true'
    const badge = span(doc, mandatory ? 'Mandatorio' : 'Tentative', mandatory ? MANDATORY_STYLE : TENTATIVE_STYLE)
    // Dopo la casella, se c'e'.
    const box = first.firstElementChild
    if (box && /^[☑☐]/.test(box.textContent ?? '')) box.after(badge)
    else first.prepend(badge)
  })

  // Razzo sulle voci con una issue In Progress.
  root.querySelectorAll<HTMLElement>('p.scope-in-progress').forEach((p) => {
    p.classList.remove('scope-in-progress')
    p.append(span(doc, ' 🚀', 'display:inline-block;margin-left:4px;text-decoration:none;'))
  })

  if (jiraBaseUrl) linkJiraKeys(root, jiraBaseUrl)
  root.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
    a.target = '_blank'
    a.rel = 'noreferrer'
    a.style.color = '#2f6fed'
  })
  root.querySelectorAll<HTMLElement>('p').forEach((p) => {
    p.style.margin = p.style.margin || '2px 0'
  })
  root.querySelectorAll<HTMLElement>('table').forEach((t) => t.setAttribute('style', 'border-collapse:collapse;margin:6px 0;'))
  root.querySelectorAll<HTMLElement>('td, th').forEach((c) => {
    c.style.border = '1px solid #d1d5db'
    c.style.padding = '4px 8px'
    c.style.verticalAlign = 'top'
  })
  root.querySelectorAll('[class]').forEach((el) => el.removeAttribute('class'))
  return root.innerHTML
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Pagina HTML completa, da aprire nel browser o allegare a una mail.
export function scopeExportDocument(body: string, title: string, note: string): string {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #1f2937; background: #fff; max-width: 960px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .note { color: ${MUTED}; font-size: 12px; margin: 0 0 20px; }
  ul, ol { padding-left: 22px; }
  @media print { body { margin: 0 auto; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="note">${escapeHtml(note)}</p>
${body}
</body>
</html>
`
}
