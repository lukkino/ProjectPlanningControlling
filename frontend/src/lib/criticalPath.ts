import type { BacklogItem } from '../api/types'
import { countWorkingDays, parsePredecessors, type DaysOff, NO_DAYS_OFF } from './scheduling'

// Percorso critico (CPM) del Gantt del backlog, calcolato sulle date
// pianificate gia' presenti (Start pian. / Fine pian.), in giorni lavorativi.
//
// Legami considerati (fine-inizio):
// - i Predecessori espliciti dell'item;
// - con byAssignee, la sequenza di lavoro di ogni assegnatario: una persona
//   fa un item dopo l'altro, quindi l'item successivo nel tempo dello stesso
//   assegnatario dipende da quello prima (vincolo di risorsa, che nel backlog
//   di solito non e' scritto nei Predecessori).
//
// Si considerano solo gli item ancora da finire (senza Fine eff.), con
// entrambe le date pianificate e che non sono attivita' di servizio (fuori
// dal code freeze). La fine del progetto e' la Fine pian. piu' tarda tra
// questi; il margine (float totale) di un item e' di quanti giorni lavorativi
// puo' slittare senza spostare quella fine. Critici = margine <= 0.

export type CriticalLink = { from: number; to: number; implicit: boolean }

export type CriticalPathResult = {
  critical: Set<number>
  // Margine in giorni lavorativi per item considerato.
  float: Map<number, number>
  // Legami tra due item critici in cui il primo "guida" il secondo.
  links: CriticalLink[]
  projectFinish: string | null
  considered: number
}

const EMPTY: CriticalPathResult = { critical: new Set(), float: new Map(), links: [], projectFinish: null, considered: 0 }

export function computeCriticalPath(items: BacklogItem[], byAssignee: boolean, off: DaysOff = NO_DAYS_OFF): CriticalPathResult {
  const nodes = items.filter((i) => !i.is_activity && !i.actual_finish && i.planned_start && i.expected_finish)
  if (nodes.length === 0) return EMPTY

  // Indice in giorni lavorativi rispetto al primo Start pian.: start = primo
  // giorno lavorativo dal suo giorno, fine = ultimo giorno lavorativo fino al
  // suo giorno.
  const base = nodes.map((n) => n.planned_start!).reduce((a, b) => (a < b ? a : b))
  const cache = new Map<string, number>()
  const upTo = (d: string) => {
    let v = cache.get(d)
    if (v === undefined) {
      v = d < base ? 0 : countWorkingDays(base, d, off)
      cache.set(d, v)
    }
    return v
  }
  const span = new Map<number, { s: number; f: number }>()
  for (const n of nodes) {
    const s = upTo(n.planned_start!) + (countWorkingDays(n.planned_start!, n.planned_start!, off) === 1 ? 0 : 1)
    const f = Math.max(upTo(n.expected_finish!), s)
    span.set(n.id, { s, f })
  }

  // Legami predecessore -> successore.
  const byKey = new Map(nodes.map((n) => [n.jira_key.toUpperCase(), n]))
  const successors = new Map<number, { to: number; implicit: boolean }[]>(nodes.map((n) => [n.id, []]))
  const linkSet = new Set<string>()
  const addLink = (from: number, to: number, implicit: boolean) => {
    const key = `${from}-${to}`
    if (from === to || linkSet.has(key)) return
    linkSet.add(key)
    successors.get(from)!.push({ to, implicit })
  }
  for (const n of nodes) {
    for (const key of parsePredecessors(n.predecessors)) {
      const p = byKey.get(key)
      if (p) addLink(p.id, n.id, false)
    }
  }
  if (byAssignee) {
    const groups = new Map<string, BacklogItem[]>()
    for (const n of nodes) {
      if (!n.assignee) continue
      const list = groups.get(n.assignee) ?? []
      list.push(n)
      groups.set(n.assignee, list)
    }
    for (const list of groups.values()) {
      list.sort((a, b) => span.get(a.id)!.s - span.get(b.id)!.s || span.get(a.id)!.f - span.get(b.id)!.f)
      // Ogni item dipende dall'ultimo item della stessa persona finito prima
      // del suo inizio (item sovrapposti = lavoro in parallelo, nessun legame).
      for (let j = 1; j < list.length; j++) {
        const sj = span.get(list[j].id)!.s
        let best: BacklogItem | null = null
        for (let i = 0; i < j; i++) {
          const fi = span.get(list[i].id)!.f
          if (fi < sj && (!best || fi > span.get(best.id)!.f)) best = list[i]
        }
        if (best) addLink(best.id, list[j].id, true)
      }
    }
  }

  // Passo all'indietro: ultima fine ammessa (LF) di ogni item.
  const projectEnd = Math.max(...[...span.values()].map((v) => v.f))
  const lateFinish = new Map<number, number>()
  const visiting = new Set<number>()
  const resolve = (id: number): number => {
    const known = lateFinish.get(id)
    if (known !== undefined) return known
    visiting.add(id)
    let lf = projectEnd
    for (const { to } of successors.get(id)!) {
      if (visiting.has(to)) continue // ciclo: date incoerenti, legame ignorato
      const succ = span.get(to)!
      const lsSucc = resolve(to) - (succ.f - succ.s)
      lf = Math.min(lf, lsSucc - 1)
    }
    visiting.delete(id)
    lateFinish.set(id, lf)
    return lf
  }
  const float = new Map<number, number>()
  const critical = new Set<number>()
  for (const n of nodes) {
    const fl = resolve(n.id) - span.get(n.id)!.f
    float.set(n.id, fl)
    if (fl <= 0) critical.add(n.id)
  }

  // Legami "guida" tra item critici: il successore parte subito dopo
  // (o prima di) la fine del predecessore.
  const links: CriticalLink[] = []
  for (const [from, list] of successors) {
    if (!critical.has(from)) continue
    for (const { to, implicit } of list) {
      if (critical.has(to) && span.get(to)!.s - span.get(from)!.f <= 1) links.push({ from, to, implicit })
    }
  }

  const projectFinish = nodes
    .map((n) => n.expected_finish!)
    .reduce((a, b) => (a > b ? a : b))
  return { critical, float, links, projectFinish, considered: nodes.length }
}
