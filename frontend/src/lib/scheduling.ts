import type { BacklogItem, NonWorkingDay } from '../api/types'

export function toIsoLocal(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// Giorni non lavorativi (ferie, malattia, chiusure: vedi NonWorkingDay) come
// insieme di date ISO, da passare ai calcoli qui sotto: li saltano come i
// sabati e le domeniche.
export type DaysOff = ReadonlySet<string>
export const NO_DAYS_OFF: DaysOff = new Set()

export function daysOffSet(ranges: Pick<NonWorkingDay, 'start_date' | 'end_date'>[]): Set<string> {
  const result = new Set<string>()
  for (const range of ranges) {
    const cursor = new Date(`${range.start_date}T00:00:00`)
    const end = new Date(`${range.end_date}T00:00:00`)
    while (cursor <= end) {
      result.add(toIsoLocal(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  return result
}

function isWorkingDay(d: Date, off: DaysOff): boolean {
  const day = d.getDay() // 0 = domenica, 6 = sabato
  return day !== 0 && day !== 6 && !off.has(toIsoLocal(d))
}

export function isWorkingDayIso(dateStr: string, off: DaysOff): boolean {
  return isWorkingDay(new Date(`${dateStr}T00:00:00`), off)
}

// Inverso di workingDaysBetween: data di fine tale che ci siano esattamente
// "days" giorni lavorativi da startStr a fine, estremi inclusi (es. days=1 ->
// fine=inizio). Usata per calcolare "Fine pian." da "Start pian." + "Sizing
// (gg)". Uno Start pian. in un giorno non lavorativo conta dal primo giorno
// lavorativo dopo. Restituisce null se manca la data di inizio o i giorni non
// sono un numero positivo.
export function addWorkingDays(startStr: string | null, days: number | null, off: DaysOff = NO_DAYS_OFF): string | null {
  if (!startStr || days == null || days <= 0) return null
  const cursor = new Date(`${startStr}T00:00:00`)
  while (!isWorkingDay(cursor, off)) cursor.setDate(cursor.getDate() + 1)
  let remaining = days - 1
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + 1)
    if (isWorkingDay(cursor, off)) remaining--
  }
  return toIsoLocal(cursor)
}

// Primo giorno lavorativo successivo a startStr - usato per far ripartire un
// item subito dopo la Fine pian. di quello che lo precede (pianificazione a
// cascata e predecessori).
export function nextWorkingDay(startStr: string, off: DaysOff = NO_DAYS_OFF): string {
  const cursor = new Date(`${startStr}T00:00:00`)
  do {
    cursor.setDate(cursor.getDate() + 1)
  } while (!isWorkingDay(cursor, off))
  return toIsoLocal(cursor)
}

// "PTBSYS-12, ptbsys-34" -> ["PTBSYS-12", "PTBSYS-34"]. Separatori accettati:
// virgola, punto e virgola, spazi.
export function parsePredecessors(value: string | null): string[] {
  if (!value) return []
  return [...new Set(value.split(/[,;\s]+/).filter(Boolean).map((k) => k.toUpperCase()))]
}

// Predecessori di un item che esistono davvero in questo backlog: le chiavi
// sconosciute (item tolto dalla sync) e l'item stesso non contano.
export function resolvePredecessors(item: BacklogItem, byKey: Map<string, BacklogItem>): BacklogItem[] {
  return parsePredecessors(item.predecessors)
    .map((key) => byKey.get(key))
    .filter((p): p is BacklogItem => !!p && p.id !== item.id)
}

export function indexByKey(items: BacklogItem[]): Map<string, BacklogItem> {
  return new Map(items.map((i) => [i.jira_key.toUpperCase(), i]))
}

// true se dare a itemKey questi predecessori chiuderebbe un ciclo, cioe' se
// risalendo la catena dei predecessori si torna a itemKey.
export function wouldCreateCycle(items: BacklogItem[], itemKey: string, predecessorKeys: string[]): boolean {
  const byKey = indexByKey(items)
  const target = itemKey.toUpperCase()
  const seen = new Set<string>()
  const stack = [...predecessorKeys]
  while (stack.length > 0) {
    const key = stack.pop()!.toUpperCase()
    if (key === target) return true
    if (seen.has(key)) continue
    seen.add(key)
    const item = byKey.get(key)
    if (item) stack.push(...parsePredecessors(item.predecessors))
  }
  return false
}

export type BacklogPatch = Partial<BacklogItem> & { id: number }

// Applica le modifiche in "patches" (per id) e propaga le date lungo i
// predecessori, come in Project/Wrike con un legame fine-inizio: un item con
// predecessori inizia il primo giorno lavorativo dopo la Fine pian. piu'
// tarda tra i suoi predecessori, e la sua Fine pian. si ricalcola dal Sizing
// (gg) - solo quando lo Start cambia, cosi' una Fine pian. corretta a mano
// resta finche' lo Start non si sposta. Un predecessore senza Fine pian. non
// vincola nulla. Restituisce tutte le modifiche da salvare (quelle richieste
// piu' quelle propagate), pronte per il salvataggio in blocco.
export function scheduleFromPredecessors(
  items: BacklogItem[],
  patches: Map<number, Partial<BacklogItem>>,
  off: DaysOff = NO_DAYS_OFF,
): BacklogPatch[] {
  const changes = new Map<number, Partial<BacklogItem>>()
  for (const [id, patch] of patches) changes.set(id, { ...patch })
  const state = items.map((i) => ({ ...i, ...patches.get(i.id) }))
  const byKey = indexByKey(state)

  const done = new Set<number>()
  const visiting = new Set<number>()
  const resolve = (item: BacklogItem) => {
    if (done.has(item.id) || visiting.has(item.id)) return
    visiting.add(item.id)
    // Prima i predecessori, cosi' la loro Fine pian. e' gia' quella nuova.
    // Un ciclo (non dovrebbe esistere, la UI lo rifiuta) viene spezzato
    // ignorando il predecessore che si sta gia' calcolando.
    const predecessors = resolvePredecessors(item, byKey).filter((p) => !visiting.has(p.id))
    for (const p of predecessors) resolve(p)
    const finishes = predecessors.map((p) => p.expected_finish).filter((f): f is string => !!f)
    if (finishes.length > 0) {
      const planned_start = nextWorkingDay(finishes.reduce((a, b) => (a > b ? a : b)), off)
      if (planned_start !== item.planned_start) {
        const change: Partial<BacklogItem> = { planned_start }
        const expected_finish = addWorkingDays(planned_start, item.planned_duration_days, off)
        if (expected_finish) change.expected_finish = expected_finish
        Object.assign(item, change)
        changes.set(item.id, { ...changes.get(item.id), ...change })
      }
    }
    visiting.delete(item.id)
    done.add(item.id)
  }
  for (const item of state) resolve(item)

  return [...changes].map(([id, change]) => ({ ...change, id }))
}
