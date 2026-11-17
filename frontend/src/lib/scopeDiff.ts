// Confronto tra due versioni dello Scope schematico (HTML di lib/richText),
// voce per voce: per lo Scope congelato, cosa e' cambiato rispetto alla
// baseline e in ogni modifica del registro. Le spunte delle caselle non
// contano (sono avanzamento, non scope).

export type ScopeFlag = 'mandatory' | 'tentative' | null

export type ScopeItem = {
  text: string
  // Voce o titolo sotto cui si trova (es. la voce padre di un sotto-elenco).
  context: string | null
  flag: ScopeFlag
}

export type ScopeChange =
  | { kind: 'added'; item: ScopeItem }
  | { kind: 'removed'; item: ScopeItem }
  | { kind: 'modified'; before: ScopeItem; after: ScopeItem }
  | { kind: 'flag'; before: ScopeItem; after: ScopeItem }

const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()

// Testo della voce senza i sotto-elenchi e senza la casella.
function ownText(li: Element): string {
  const copy = li.cloneNode(true) as Element
  copy.querySelectorAll('ul, ol, label').forEach((el) => el.remove())
  return clean(copy.textContent)
}

function flagOf(li: Element): ScopeFlag {
  if (li.getAttribute('data-mandatory') === 'true') return 'mandatory'
  if (li.getAttribute('data-tentative') === 'true') return 'tentative'
  return null
}

export function scopeItems(html: string | null | undefined): ScopeItem[] {
  if (!html) return []
  const items: ScopeItem[] = []
  const body = new DOMParser().parseFromString(html, 'text/html').body
  let heading: string | null = null

  const walk = (el: Element, context: string | null) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'li') {
      const text = ownText(el)
      if (text) items.push({ text, context, flag: flagOf(el) })
      el.querySelectorAll(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol').forEach((list) =>
        walk(list, text || context),
      )
      return
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = clean(el.textContent)
      if (text) items.push({ text, context: null, flag: null })
      heading = text || heading
      return
    }
    if (tag === 'p' || tag === 'pre') {
      const text = clean(el.textContent)
      if (text) items.push({ text, context, flag: null })
      return
    }
    if (tag === 'tr') {
      const text = Array.from(el.children, (cell) => clean(cell.textContent)).filter(Boolean).join(' | ')
      if (text) items.push({ text, context, flag: null })
      return
    }
    for (const child of Array.from(el.children)) walk(child, context ?? heading)
  }

  for (const child of Array.from(body.children)) walk(child, heading)
  return items
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [])
const JIRA_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g

// Quanto si somigliano due voci (0-1): stessa chiave Jira = stessa voce
// riscritta; se no parole in comune (coefficiente di Dice).
function similarity(a: string, b: string): number {
  const keysA = new Set(a.match(JIRA_KEY_RE) ?? [])
  if ((b.match(JIRA_KEY_RE) ?? []).some((k) => keysA.has(k))) return 1
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let common = 0
  for (const w of wa) if (wb.has(w)) common += 1
  return (2 * common) / (wa.size + wb.size)
}

const SIMILAR = 0.5

export function diffScope(beforeHtml: string | null | undefined, afterHtml: string | null | undefined): ScopeChange[] {
  const before = scopeItems(beforeHtml)
  const after = scopeItems(afterHtml)
  const usedAfter = new Set<number>()
  const unmatchedBefore: number[] = []
  const changes: ScopeChange[] = []

  // Stesso testo: la stessa voce (al piu' con il segno cambiato).
  before.forEach((b, i) => {
    const j = after.findIndex((a, k) => !usedAfter.has(k) && a.text === b.text)
    if (j < 0) {
      unmatchedBefore.push(i)
      return
    }
    usedAfter.add(j)
    if (after[j].flag !== b.flag) changes.push({ kind: 'flag', before: b, after: after[j] })
  })

  // Testo diverso ma simile: la voce riscritta.
  const removed: ScopeItem[] = []
  for (const i of unmatchedBefore) {
    let best = -1
    let bestScore = SIMILAR
    after.forEach((a, k) => {
      if (usedAfter.has(k)) return
      const score = similarity(before[i].text, a.text)
      if (score >= bestScore) {
        best = k
        bestScore = score
      }
    })
    if (best < 0) {
      removed.push(before[i])
      continue
    }
    usedAfter.add(best)
    changes.push({ kind: 'modified', before: before[i], after: after[best] })
  }

  const added = after.filter((_, k) => !usedAfter.has(k)).map((item): ScopeChange => ({ kind: 'added', item }))
  return [...added, ...removed.map((item): ScopeChange => ({ kind: 'removed', item })), ...changes]
}

export type ScopeCounts = {
  // Voci "foglia" (senza sotto-voci): le voci padre fanno da gruppo.
  total: number
  // Voci con casella (elenchi di controllo) e quante spuntate.
  checkable: number
  done: number
  mandatory: number
  tentative: number
}

// Conteggio delle voci dello Scope schematico. Una voce padre spuntata o
// segnata (mandatoria/tentative) vale per tutte le sue sotto-voci.
export function scopeCounts(html: string | null | undefined): ScopeCounts {
  const counts: ScopeCounts = { total: 0, checkable: 0, done: 0, mandatory: 0, tentative: 0 }
  if (!html) return counts
  const body = new DOMParser().parseFromString(html, 'text/html').body
  for (const li of Array.from(body.querySelectorAll('li'))) {
    if (li.querySelector('li') || !ownText(li)) continue
    counts.total += 1
    const chain: Element[] = []
    for (let el: Element | null = li; el; el = el.parentElement?.closest('li') ?? null) chain.push(el)
    if (li.getAttribute('data-type') === 'taskItem') {
      counts.checkable += 1
      if (chain.some((el) => el.getAttribute('data-checked') === 'true')) counts.done += 1
    }
    const flag = chain.map(flagOf).find((f) => f !== null) ?? null
    if (flag === 'mandatory') counts.mandatory += 1
    if (flag === 'tentative') counts.tentative += 1
  }
  return counts
}
