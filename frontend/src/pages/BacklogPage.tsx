import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { api } from '../api/client'
import type { BacklogItem } from '../api/types'
import { BacklogGanttChart } from '../components/BacklogGanttChart'
import { DateOrNaInput } from '../components/DateOrNaInput'
import { StatusBadge } from '../components/StatusBadge'
import { countBacklogStats } from '../lib/backlogStats'
import { formatIsoDate } from '../lib/dates'
import { useProjectContext } from './useProjectContext'

// Giorni lavorativi (lun-ven, festivita' escluse) tra due date, estremi
// inclusi. Restituisce null se una delle due date manca o se fine < inizio.
function workingDaysBetween(startStr: string | null, endStr: string | null): number | null {
  if (!startStr || !endStr) return null
  const start = new Date(`${startStr}T00:00:00`)
  const end = new Date(`${endStr}T00:00:00`)
  if (end < start) return null

  let count = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    const day = cursor.getDay() // 0 = domenica, 6 = sabato
    if (day !== 0 && day !== 6) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

function toIsoLocal(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// Inverso di workingDaysBetween: data di fine tale che ci siano esattamente
// "days" giorni lavorativi da startStr a fine, estremi inclusi (es. days=1 ->
// fine=inizio). Usata per calcolare "Fine pian." da "Start pian." + "Sizing
// (gg)". Restituisce null se manca la data di inizio o i giorni non sono un
// numero positivo.
function addWorkingDays(startStr: string | null, days: number | null): string | null {
  if (!startStr || days == null || days <= 0) return null
  const cursor = new Date(`${startStr}T00:00:00`)
  let remaining = days - 1
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + 1)
    const day = cursor.getDay() // 0 = domenica, 6 = sabato
    if (day !== 0 && day !== 6) remaining--
  }
  return toIsoLocal(cursor)
}

// Primo giorno lavorativo successivo a startStr - usato per far ripartire la
// pianificazione a cascata dell'item successivo subito dopo la Fine pian. di
// quello precedente.
function nextWorkingDay(startStr: string): string {
  const cursor = new Date(`${startStr}T00:00:00`)
  do {
    cursor.setDate(cursor.getDate() + 1)
  } while (cursor.getDay() === 0 || cursor.getDay() === 6)
  return toIsoLocal(cursor)
}

// Ordinamento esplicito (facoltativo) per stato, dall'alto verso il basso:
// Done, In Progress, To Do. Alternativo al drag&drop manuale (che si basa
// sull'ordine di priorita'), non lo sostituisce: quando attivo il
// trascinamento delle righe viene disabilitato, perche' l'ordine visibile
// non corrisponde piu' a priority_order.
const STATUS_SORT_RANK: Record<string, number> = { Done: 0, 'In Progress': 1, 'To Do': 2 }

const COLUMN_ORDER_STORAGE_KEY = 'backlog-column-order-v1'
const COLUMN_WIDTHS_STORAGE_KEY = 'backlog-column-widths-v1'
const MIN_COLUMN_WIDTH = 32

// Larghezza in pixel di default per colonna con table-layout:fixed, cosi' la
// tabella (~22 colonne) parte compatta invece di allargarsi al contenuto.
// L'utente puo' poi trascinare il bordo destro di ogni intestazione per
// regolarla: il valore scelto sovrascrive questo default e resta salvato.
const DEFAULT_COLUMN_WIDTH: Record<string, number> = {
  jira_key: 90,
  summary: 220,
  parent: 110,
  issue_type: 70,
  jira_status: 80,
  in_scope: 60,
  included_in_codefreeze: 80,
  status: 70,
  refinement_date: 130,
  ta_date: 130,
  planned_duration_days: 70,
  dev_estimate_hours: 65,
  test_estimate_hours: 65,
  planned_hours: 70,
  planned_start: 90,
  expected_finish: 90,
  actual_start: 90,
  actual_finish: 90,
  duration: 70,
  logged_hours: 75,
  dev_effort_hours: 90,
  progetto_id: 130,
  notes: 160,
}
const HANDLE_COLUMN_WIDTH = 30
const DELETE_COLUMN_WIDTH = 36

// Colonne "congelate" a sinistra durante lo scroll orizzontale, cosi' si
// riconosce sempre a quale item si riferisce il resto della riga.
const STICKY_COLUMN_KEYS = new Set(['jira_key', 'summary'])

type Column = {
  key: string
  label: string
  className?: string
  style?: CSSProperties
  render: (item: BacklogItem) => ReactNode
}

export function BacklogPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()
  const [onlyInScope, setOnlyInScope] = useState(true)
  const [onlyCodefreeze, setOnlyCodefreeze] = useState(true)
  const [sortByStatus, setSortByStatus] = useState(false)
  const [view, setView] = useState<'table' | 'gantt'>('table')
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())
  const [newKey, setNewKey] = useState('')
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [draggedCol, setDraggedCol] = useState<string | null>(null)

  // Barra di scroll orizzontale "specchio" sopra la tabella (vedi CSS
  // .table-scroll-mirror): tiene la stessa scrollLeft di .table-wrap, cosi'
  // si puo' scorrere a destra/sinistra da li' senza dover raggiungere la
  // barra vera in fondo, non sempre visibile con una tabella alta.
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  // Evita il loop infinito: sincronizzare scrollLeft da A a B scatena anche
  // l'evento onScroll di B, che altrimenti tenterebbe di risincronizzare A.
  const syncingScrollRef = useRef(false)
  const syncScroll = (source: RefObject<HTMLDivElement | null>, target: RefObject<HTMLDivElement | null>) => {
    if (syncingScrollRef.current) {
      syncingScrollRef.current = false
      return
    }
    if (!source.current || !target.current) return
    syncingScrollRef.current = true
    target.current.scrollLeft = source.current.scrollLeft
  }

  const { data: items } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })

  // Stessa query cache di ForecastingPage: serve solo a capire quali PBI
  // rientrano nell'ultima previsione, per evidenziarli in tabella.
  const { data: simulations } = useQuery({
    queryKey: ['forecasting', project.id],
    queryFn: () => api.forecasting.list(project.id),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['backlog', project.id] })
    queryClient.invalidateQueries({ queryKey: ['dashboard', project.id] })
  }

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<BacklogItem> }) => api.backlog.update(id, data),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.backlog.remove(id),
    onSuccess: invalidate,
  })
  const create = useMutation({
    mutationFn: () =>
      api.backlog.create(project.id, { jira_key: newKey.trim(), priority_order: (items?.length ?? 0) + 1 }),
    onSuccess: () => {
      setNewKey('')
      invalidate()
    },
  })
  const sync = useMutation({
    mutationFn: () => api.backlog.sync(project.id),
    onSuccess: invalidate,
  })

  // Pianificazione a cascata: partendo dall'item con priorita' piu' alta
  // (che deve gia' avere Start pian./Fine pian. impostati, es. col calcolo
  // automatico da Sizing visto sopra), ogni item successivo riparte dal
  // primo giorno lavorativo dopo la Fine pian. di quello precedente, e la
  // propria Fine pian. si calcola dal suo Sizing (gg). Si ferma al primo
  // item senza Sizing: da li' in poi non c'e' piu' una Fine pian. su cui
  // basare l'item successivo (quell'item resta comunque con un warning in
  // colonna, vedi render di 'expected_finish'). Gli item non "In Scope" sono
  // esclusi del tutto dalla catena (non contano ne' come ancora ne' come
  // anelli): non fanno parte del piano.
  const cascadeSchedule = useMutation({
    mutationFn: async () => {
      const sorted = [...(items ?? [])].filter((i) => i.in_scope).sort((a, b) => a.priority_order - b.priority_order)
      const anchor = sorted[0]
      if (!anchor || !anchor.planned_start || !anchor.expected_finish) {
        throw new Error(
          `Imposta prima Start pian. e Fine pian. per l'item in cima alla lista${anchor ? ` (${anchor.jira_key})` : ''}.`,
        )
      }
      let prevFinish = anchor.expected_finish
      for (const item of sorted.slice(1)) {
        const planned_start = nextWorkingDay(prevFinish)
        if (!item.planned_duration_days) {
          await api.backlog.update(item.id, { planned_start })
          break
        }
        const expected_finish = addWorkingDays(planned_start, item.planned_duration_days)!
        await api.backlog.update(item.id, { planned_start, expected_finish })
        prevFinish = expected_finish
      }
    },
    onSuccess: invalidate,
  })

  const num = (v: string) => (v === '' ? null : Number(v))
  const dateOrNull = (v: string) => v || null

  const columns: Column[] = [
    {
      key: 'jira_key',
      label: 'Jira Key',
      render: (item) =>
        project.jira_jql ? (
          <a href={`https://inpeco.atlassian.net/browse/${item.jira_key}`} target="_blank" rel="noreferrer">
            {item.jira_key}
          </a>
        ) : (
          item.jira_key
        ),
    },
    {
      key: 'summary',
      label: 'Summary',
      style: { whiteSpace: 'normal' },
      render: (item) => item.summary ?? <span className="muted">—</span>,
    },
    {
      key: 'parent',
      label: 'Parent',
      render: (item) =>
        item.parent_key ? (
          project.jira_jql ? (
            <a
              href={`https://inpeco.atlassian.net/browse/${item.parent_key}`}
              target="_blank"
              rel="noreferrer"
              title={item.parent_summary ?? undefined}
            >
              {item.parent_key}
            </a>
          ) : (
            <span title={item.parent_summary ?? undefined}>{item.parent_key}</span>
          )
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'issue_type', label: 'Tipo', render: (item) => item.issue_type ?? '—' },
    { key: 'jira_status', label: 'Stato Jira', render: (item) => item.jira_status ?? '—' },
    {
      key: 'in_scope',
      label: 'In Scope',
      render: (item) => (
        <input
          type="checkbox"
          checked={item.in_scope}
          onChange={(e) => update.mutate({ id: item.id, data: { in_scope: e.target.checked } })}
        />
      ),
    },
    {
      key: 'included_in_codefreeze',
      label: 'Incluso in codefreeze',
      render: (item) => (
        <input
          type="checkbox"
          checked={item.included_in_codefreeze}
          onChange={(e) => update.mutate({ id: item.id, data: { included_in_codefreeze: e.target.checked } })}
        />
      ),
    },
    { key: 'status', label: 'Stato', render: (item) => <StatusBadge status={item.status} /> },
    {
      key: 'refinement_date',
      label: 'Data refinement',
      className: 'editable-cell',
      render: (item) => (
        <DateOrNaInput
          value={item.refinement_date}
          onChange={(value) => update.mutate({ id: item.id, data: { refinement_date: value } })}
        />
      ),
    },
    {
      key: 'ta_date',
      label: 'Data TA',
      className: 'editable-cell',
      render: (item) => (
        <DateOrNaInput
          value={item.ta_date}
          onChange={(value) => update.mutate({ id: item.id, data: { ta_date: value } })}
        />
      ),
    },
    {
      key: 'planned_duration_days',
      label: 'Sizing (gg)',
      className: 'editable-cell',
      // Cambiando il sizing con uno Start pian. gia' presente, ricalcola
      // anche la Fine pian. (stessa formula usata sulla colonna Start pian.),
      // cosi' le due date restano coerenti con il nuovo sizing.
      render: (item) => (
        <input
          type="number"
          defaultValue={item.planned_duration_days ?? ''}
          onBlur={(e) => {
            const planned_duration_days = num(e.target.value)
            const expected_finish = addWorkingDays(item.planned_start, planned_duration_days)
            update.mutate({
              id: item.id,
              data: expected_finish ? { planned_duration_days, expected_finish } : { planned_duration_days },
            })
          }}
        />
      ),
    },
    // Dev (h) / Test (h) / Planned (h) tolte per ora dalla vista - i campi
    // restano sul modello dati, basta ri-aggiungere le colonne qui sotto per
    // rimetterle.
    {
      key: 'planned_start',
      label: 'Start pian.',
      className: 'editable-cell',
      // La Fine pian. si ricalcola da Start pian. + Sizing (gg), in giorni
      // lavorativi (vedi addWorkingDays) - se il sizing non e' ancora
      // impostato, la Fine pian. resta invariata.
      render: (item) => (
        <input
          type="date"
          defaultValue={item.planned_start ?? ''}
          onBlur={(e) => {
            const planned_start = dateOrNull(e.target.value)
            const expected_finish = addWorkingDays(planned_start, item.planned_duration_days)
            update.mutate({
              id: item.id,
              data: expected_finish ? { planned_start, expected_finish } : { planned_start },
            })
          }}
        />
      ),
    },
    {
      key: 'expected_finish',
      label: 'Fine pian.',
      className: 'editable-cell',
      // key sul valore: campo non controllato, serve a rimontarlo quando il
      // valore cambia da fuori (calcolo automatico da Start pian./Sizing),
      // altrimenti l'input non rifletterebbe il nuovo valore in cache.
      render: (item) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            key={item.expected_finish ?? ''}
            type="date"
            defaultValue={item.expected_finish ?? ''}
            onBlur={(e) => update.mutate({ id: item.id, data: { expected_finish: dateOrNull(e.target.value) } })}
          />
          {item.planned_start && !item.planned_duration_days && (
            <span
              title="Sizing (gg) mancante: la Fine pian. non può essere calcolata automaticamente (da Start pian. o dalla pianificazione a cascata) — inseriscila a mano o compila il Sizing."
              style={{ cursor: 'help' }}
            >
              ⚠️
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'actual_start',
      label: 'Start eff.',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="date"
          defaultValue={item.actual_start ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { actual_start: dateOrNull(e.target.value) } })}
        />
      ),
    },
    {
      key: 'actual_finish',
      label: 'Fine eff.',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="date"
          defaultValue={item.actual_finish ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { actual_finish: dateOrNull(e.target.value) } })}
        />
      ),
    },
    {
      key: 'duration',
      label: 'Durata (gg)',
      className: 'text-right',
      render: (item) => workingDaysBetween(item.actual_start, item.actual_finish) ?? <span className="muted">—</span>,
    },
    {
      key: 'logged_hours',
      label: 'Ore loggate',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="number"
          defaultValue={item.logged_hours ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { logged_hours: num(e.target.value) } })}
        />
      ),
    },
    {
      key: 'dev_effort_hours',
      label: 'Ore stimate',
      className: 'text-right',
      // Sincronizzato da Jira (campo "Developer Effort", solo sulle Story):
      // non editabile qui, verrebbe comunque sovrascritto al prossimo sync.
      render: (item) => item.dev_effort_hours ?? <span className="muted">—</span>,
    },
    {
      key: 'progetto_id',
      label: 'Progetto',
      className: 'editable-cell',
      // Progetto su cui rendicontare le ore di questo item: solo tra quelli
      // collegati a questo increment (project.progetti), scelto a mano - mai
      // toccato dal sync.
      render: (item) => (
        <select
          value={item.progetto_id ?? ''}
          onChange={(e) =>
            update.mutate({ id: item.id, data: { progetto_id: e.target.value ? Number(e.target.value) : null } })
          }
        >
          <option value="">—</option>
          {project.progetti.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: 'notes',
      label: 'Note',
      className: 'editable-cell',
      render: (item) => (
        <input
          defaultValue={item.notes ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { notes: e.target.value || null } })}
        />
      ),
    },
  ]
  const defaultColumnOrder = columns.map((c) => c.key)

  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as string[]
        const known = parsed.filter((k) => defaultColumnOrder.includes(k))
        const missing = defaultColumnOrder.filter((k) => !known.includes(k))
        return [...known, ...missing]
      }
    } catch {
      // localStorage non disponibile o dato corrotto: usa l'ordine di default
    }
    return defaultColumnOrder
  })

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder))
    } catch {
      // ignora: e' solo una comodita' per-browser, non deve bloccare l'uso
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnOrder])

  const orderedColumns = columnOrder.map((key) => columns.find((c) => c.key === key)).filter((c): c is Column => !!c)

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY)
      if (stored) return { ...DEFAULT_COLUMN_WIDTH, ...(JSON.parse(stored) as Record<string, number>) }
    } catch {
      // localStorage non disponibile o dato corrotto: usa i default
    }
    return DEFAULT_COLUMN_WIDTH
  })

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths))
    } catch {
      // ignora: e' solo una comodita' per-browser, non deve bloccare l'uso
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnWidths])

  // "left" di ogni colonna congelata = larghezza della maniglia + somma
  // delle colonne congelate che la precedono nell'ordine attuale (che puo'
  // cambiare per drag&drop delle intestazioni o resize).
  const stickyLeftByKey: Record<string, number> = {}
  let stickyCursor = HANDLE_COLUMN_WIDTH
  for (const col of orderedColumns) {
    if (!STICKY_COLUMN_KEYS.has(col.key)) continue
    stickyLeftByKey[col.key] = stickyCursor
    stickyCursor += columnWidths[col.key] ?? DEFAULT_COLUMN_WIDTH[col.key] ?? 80
  }

  // Larghezza totale della tabella (colgroup), per dimensionare lo spacer
  // dentro la barra di scroll "specchio" sopra la tabella.
  const tableScrollWidth =
    HANDLE_COLUMN_WIDTH +
    orderedColumns.reduce((sum, col) => sum + (columnWidths[col.key] ?? DEFAULT_COLUMN_WIDTH[col.key] ?? 80), 0) +
    DELETE_COLUMN_WIDTH

  const handleResizeStart = (e: ReactMouseEvent, key: string) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = columnWidths[key] ?? DEFAULT_COLUMN_WIDTH[key] ?? 80

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX)))
      setColumnWidths((prev) => ({ ...prev, [key]: nextWidth }))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const handleColumnDrop = (targetKey: string) => {
    if (draggedCol === null || draggedCol === targetKey) {
      setDraggedCol(null)
      return
    }
    setColumnOrder((prev) => {
      const list = [...prev]
      const fromIndex = list.indexOf(draggedCol)
      const toIndex = list.indexOf(targetKey)
      if (fromIndex === -1 || toIndex === -1) return prev
      const [moved] = list.splice(fromIndex, 1)
      list.splice(toIndex, 0, moved)
      return list
    })
    setDraggedCol(null)
  }

  const { totalInScopeCount, codefreezeCount, doneCount, remainingCount } = countBacklogStats(items ?? [])

  // PBI che rientrano nell'ultima previsione di Forecasting: i primi N item
  // non-Done (In Progress/To Do), in scope e inclusi nel codefreeze,
  // nell'ordine attuale della tabella, dove N = "85% #PBI Completed by
  // Release Deadline Forecasting" dell'ultima simulazione registrata.
  const latestSimulation = simulations && simulations.length > 0 ? simulations[simulations.length - 1] : null
  const forecastTarget = latestSimulation?.pbi_completed_by_deadline_85pct ?? null
  const forecastCandidates = (items ?? []).filter((i) => i.in_scope && i.included_in_codefreeze && i.status !== 'Done')
  const forecastHighlightIds = new Set(
    forecastTarget != null ? forecastCandidates.slice(0, forecastTarget).map((i) => i.id) : [],
  )
  const forecastCutoffId =
    forecastTarget != null && forecastCandidates.length > 0
      ? forecastCandidates[Math.min(forecastTarget, forecastCandidates.length) - 1]?.id
      : undefined
  const forecastCutoffLabel = `Forecasting - Code Freeze ${formatIsoDate(project.code_freeze_date) ?? '(data non impostata)'}`

  const availableTypes = Array.from(
    new Set((items ?? []).map((i) => i.issue_type).filter((t): t is string => !!t)),
  ).sort()
  const typeCounts = (items ?? []).reduce<Record<string, number>>((acc, i) => {
    if (i.issue_type) acc[i.issue_type] = (acc[i.issue_type] ?? 0) + 1
    return acc
  }, {})
  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const visibleItems = (items ?? []).filter(
    (i) =>
      (!onlyInScope || i.in_scope) &&
      (!onlyCodefreeze || i.included_in_codefreeze) &&
      (!i.issue_type || !hiddenTypes.has(i.issue_type)),
  )

  // Ordinamento per stato su richiesta esplicita: sort stabile, a parita' di
  // stato l'ordine di priorita' esistente resta invariato.
  const displayItems = sortByStatus
    ? [...visibleItems].sort((a, b) => (STATUS_SORT_RANK[a.status] ?? 99) - (STATUS_SORT_RANK[b.status] ?? 99))
    : visibleItems

  const handleDrop = (targetId: number) => {
    if (draggedId === null || draggedId === targetId) {
      setDraggedId(null)
      return
    }
    // displayItems (non visibleItems): con "Ordina per stato" attivo si
    // trascina comunque sull'elenco visibile a schermo, cosi' su/giu'
    // funziona anche li' - il nuovo priority_order si calcola tra i vicini
    // di QUELLA posizione, qualunque sia l'ordinamento in vista in quel
    // momento.
    const list = [...displayItems]
    const fromIndex = list.findIndex((i) => i.id === draggedId)
    const toIndex = list.findIndex((i) => i.id === targetId)
    setDraggedId(null)
    if (fromIndex === -1 || toIndex === -1) return

    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    const newIndex = list.indexOf(moved)
    const prev = list[newIndex - 1]
    const next = list[newIndex + 1]

    let newOrder: number
    if (prev && next) newOrder = (prev.priority_order + next.priority_order) / 2
    else if (prev) newOrder = prev.priority_order + 1
    else if (next) newOrder = next.priority_order - 1
    else newOrder = 1

    update.mutate({ id: moved.id, data: { priority_order: newOrder } })
  }

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Backlog</h3>
          <span className="sub">
            {project.jira_jql ? (
              <span className="muted">JQL: {project.jira_jql}</span>
            ) : (
              <span className="muted">Nessuna JQL configurata — modificala nella scheda increment per abilitare la sync.</span>
            )}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <button
              className="btn"
              style={{ border: 'none', borderRadius: 0, ...(view === 'table' ? { background: 'var(--primary)', color: 'white' } : undefined) }}
              onClick={() => setView('table')}
            >
              📋 Tabella
            </button>
            <button
              className="btn"
              style={{ border: 'none', borderRadius: 0, ...(view === 'gantt' ? { background: 'var(--primary)', color: 'white' } : undefined) }}
              onClick={() => setView('gantt')}
            >
              📊 Gantt
            </button>
          </div>
          <button
            className="btn"
            title="Ricalcola Start pian./Fine pian. di tutti gli item successivi al primo, in cascata dal suo Sizing (gg)"
            onClick={() => cascadeSchedule.mutate()}
            disabled={cascadeSchedule.isPending}
          >
            {cascadeSchedule.isPending ? 'Calcolo...' : '📐 Pianificazione a cascata'}
          </button>
          <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={!project.jira_jql || sync.isPending}>
            {sync.isPending ? 'Sincronizzazione...' : '⟳ Sincronizza da Jira'}
          </button>
        </div>
      </div>

      {cascadeSchedule.isError && <div className="error-banner">{(cascadeSchedule.error as Error).message}</div>}

      <div className="stat-chips">
        <div className="stat-chip blue">
          <span className="value">{totalInScopeCount}</span>
          <span className="label">PBI in Scope</span>
        </div>
        <div className="stat-chip violet">
          <span className="value">{codefreezeCount}</span>
          <span className="label">PBI in Code Freeze</span>
        </div>
        <div className="stat-chip green">
          <span className="value">{doneCount}</span>
          <span className="label">Done</span>
        </div>
        <div className="stat-chip orange">
          <span className="value">{remainingCount}</span>
          <span className="label">Rimanenti (In Progress + To Do)</span>
        </div>
      </div>

      {forecastTarget != null && (
        <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
          Righe evidenziate in verde: i primi {forecastTarget} PBI non ancora Done che, secondo l'ultima simulazione
          di Forecasting ({formatIsoDate(latestSimulation?.simulation_date) ?? '—'}), dovrebbero rientrare entro il
          Code Freeze — la linea
          segna il taglio.
        </p>
      )}

      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <div className="error-banner" style={{ background: '#e9f7ee', color: '#1a9c5c', borderColor: '#b8e3c8' }}>
          Sync completata: {sync.data.created} nuove issue, {sync.data.updated} aggiornate (totale trovate:{' '}
          {sync.data.total_matched}).
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginBottom: 10, fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyInScope} onChange={(e) => setOnlyInScope(e.target.checked)} />
          Mostra solo item "In Scope"
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyCodefreeze} onChange={(e) => setOnlyCodefreeze(e.target.checked)} />
          Mostra solo item "Incluso in codefreeze"
        </label>

        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          title="Puoi ancora trascinare le righe per spostarle su e giu' in questo elenco"
        >
          <input type="checkbox" checked={sortByStatus} onChange={(e) => setSortByStatus(e.target.checked)} />
          Ordina per stato (Done, In Progress, To Do)
        </label>

        {availableTypes.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="muted">Tipo:</span>
            {availableTypes.map((type) => (
              <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={!hiddenTypes.has(type)} onChange={() => toggleType(type)} />
                {type} ({typeCounts[type]})
              </label>
            ))}
          </div>
        )}
      </div>

      {view === 'gantt' && (
        <BacklogGanttChart
          items={displayItems}
          jiraBrowseUrl={project.jira_jql ? 'https://inpeco.atlassian.net/browse/' : null}
        />
      )}

      {view === 'table' && (
      <>
      <div
        className="table-scroll-mirror"
        ref={topScrollRef}
        onScroll={() => syncScroll(topScrollRef, tableWrapRef)}
      >
        <div style={{ width: tableScrollWidth }} />
      </div>
      <div
        className="table-wrap table-wrap--scroll"
        ref={tableWrapRef}
        onScroll={() => syncScroll(tableWrapRef, topScrollRef)}
      >
        <table className="backlog-table backlog-table--fixed">
          <colgroup>
            <col style={{ width: HANDLE_COLUMN_WIDTH }} />
            {orderedColumns.map((col) => (
              <col key={col.key} style={{ width: columnWidths[col.key] ?? DEFAULT_COLUMN_WIDTH[col.key] ?? 80 }} />
            ))}
            <col style={{ width: DELETE_COLUMN_WIDTH }} />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky-col-header" style={{ left: 0 }} />
              {orderedColumns.map((col) => (
                <th
                  key={col.key}
                  draggable
                  onDragStart={(e) => {
                    setDraggedCol(col.key)
                    e.dataTransfer.setData('text/plain', col.key)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleColumnDrop(col.key)}
                  onDragEnd={() => setDraggedCol(null)}
                  className={STICKY_COLUMN_KEYS.has(col.key) ? 'draggable-col sticky-col-header' : 'draggable-col'}
                  style={{
                    ...(draggedCol === col.key ? { opacity: 0.4 } : undefined),
                    ...(stickyLeftByKey[col.key] !== undefined ? { left: stickyLeftByKey[col.key] } : undefined),
                  }}
                  title="Trascina per riordinare la colonna"
                >
                  {col.label}
                  <span
                    className="col-resize-handle"
                    draggable={false}
                    onMouseDown={(e) => handleResizeStart(e, col.key)}
                    onClick={(e) => e.stopPropagation()}
                    title="Trascina per ridimensionare la colonna"
                  />
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {displayItems.map((item) => (
              <Fragment key={item.id}>
              <tr
                className={forecastHighlightIds.has(item.id) ? 'forecast-highlight' : undefined}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(item.id)}
                style={draggedId === item.id ? { opacity: 0.4 } : undefined}
              >
                <td
                  draggable
                  onDragStart={(e) => {
                    setDraggedId(item.id)
                    e.dataTransfer.setData('text/plain', String(item.id))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDraggedId(null)}
                  className="drag-handle sticky-col"
                  style={{ left: 0 }}
                  title="Trascina per riordinare"
                >
                  ⠿
                </td>
                {orderedColumns.map((col) => (
                  <td
                    key={col.key}
                    className={STICKY_COLUMN_KEYS.has(col.key) ? `${col.className ?? ''} sticky-col`.trim() : col.className}
                    style={
                      stickyLeftByKey[col.key] !== undefined
                        ? { ...col.style, left: stickyLeftByKey[col.key] }
                        : col.style
                    }
                  >
                    {col.render(item)}
                  </td>
                ))}
                <td>
                  <button className="btn btn-danger" onClick={() => remove.mutate(item.id)}>
                    ✕
                  </button>
                </td>
              </tr>
              {item.id === forecastCutoffId && (
                <tr className="forecast-cutoff-label-row">
                  <td colSpan={orderedColumns.length + 2}>{forecastCutoffLabel}</td>
                </tr>
              )}
              </Fragment>
            ))}
            {displayItems.length === 0 && (
              <tr>
                <td colSpan={orderedColumns.length + 2} className="muted">
                  Nessun item nel backlog. Sincronizza da Jira o aggiungine uno manualmente.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          placeholder="Chiave Jira (es. PTBSYS-1234)"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          style={{ width: 220 }}
        />
        <button className="btn" disabled={!newKey.trim() || create.isPending} onClick={() => create.mutate()}>
          + Aggiungi manualmente
        </button>
      </div>
    </div>
  )
}
