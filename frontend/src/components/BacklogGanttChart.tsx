import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type RefObject } from 'react'
import { toPng } from 'html-to-image'
import type { BacklogItem, NonWorkingDay } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, formatIsoDate, toEpochDays } from '../lib/dates'
import { isMilestone } from '../lib/milestone'
import { ACTIVITY_PHASES, activityPhaseInfo } from '../lib/activityPhases'
import { computeCriticalPath } from '../lib/criticalPath'
import { daysOffSet, parsePredecessors, workingDaysShift, type BacklogPatch } from '../lib/scheduling'

// Barre effettive delle attivita' di servizio: arancio come l'Actual in
// IncrementHistoryCard (il pianificato ha il colore della fase, vedi
// lib/activityPhases).
const COLOR_ACTUAL = '#eb6834'
// Stesso rosso di --danger: item "In Progress" con Start eff. ma senza
// ancora una Fine eff. - l'inizio e' certo, la fine no (vedi barra
// sfumata sotto).
const COLOR_IN_PROGRESS = '#d3402f'
// Attivita' di servizio (fuori dal code freeze): barre a righe oblique,
// stesso colore ma riconoscibili anche senza distinguere le tinte.
const activityFill = (color: string) =>
  `repeating-linear-gradient(135deg, ${color} 0 4px, color-mix(in srgb, ${color} 35%, white) 4px 8px)`

// Tutti gli altri item: il colore dice il tipo Jira, la tinta dice cosa e'
// la barra - chiara col bordo = pianificato, piena = effettivo, piena e
// sfumata in coda = in corso. (Le attivita' di servizio restano coi colori
// pianificato/effettivo sopra, a righe.)
const TYPE_COLORS: Record<string, string> = {
  Story: '#2ecc40',
  Bug: '#d3402f',
  Activity: '#2f6fed',
}
const COLOR_OTHER_TYPE = '#5b6472'
const typeColor = (issueType: string | null) => TYPE_COLORS[issueType ?? ''] ?? COLOR_OTHER_TYPE
const plannedFill = (color: string) => `color-mix(in srgb, ${color} 30%, white)`
const inProgressFill = (color: string) => `linear-gradient(to right, ${color} 0%, ${color} 70%, transparent 100%)`

const LABEL_COLUMN_WIDTH = 110
// Barre di un giorno ancora visibili con lo zoom al minimo.
const MIN_BAR_WIDTH = 3
const ROW_HEIGHT = 60
const BAR_HEIGHT = 14
// Distanza della barra "Pianificato" dal bordo superiore della riga.
const PLANNED_BAR_TOP = 22
// Frecce predecessore -> successore.
const COLOR_LINK = '#5b6472'
// Freccia sotto il mouse e collegamento in creazione.
const COLOR_LINK_HOVER = '#2563eb'
// Collegamento in creazione agganciato a un PBI: si puo' fare / non si puo'.
const COLOR_LINK_VALID = '#16a34a'
// Milestone: rombo centrato sulla fine del giorno (come le linee delle fasi);
// meta' della sua larghezza, per agganciare frecce ed etichette.
// Rossa finche' non e' Done, poi verde.
const COLOR_MILESTONE = '#dc2626'
const COLOR_MILESTONE_BORDER = '#991b1b'
const COLOR_MILESTONE_DONE = '#16a34a'
const COLOR_MILESTONE_DONE_BORDER = '#15803d'
// Baseline (date originali), sotto la barra pianificata.
const COLOR_BASELINE = '#6b7280'
const MILESTONE_HALF = 8
// Esporta PNG: giorni prima di oggi da cui parte il calendario dell'immagine.
const EXPORT_DAYS_BEFORE_TODAY = 7
const COLOR_LINK_INVALID = '#dc2626'
// Percorso critico: barre e legami evidenziati, il resto attenuato.
const COLOR_CRITICAL = '#d3402f'
const DIMMED_OPACITY = 0.3
// Frecce dei predecessori: tratto orizzontale all'uscita dalla barra e
// all'arrivo (prima della punta), raggio degli angoli arrotondati.
const LINK_STUB = 12
const LINK_ARRIVAL = 10
const LINK_RADIUS = 5

// Spezzata ortogonale con gli angoli arrotondati (come nei Gantt di
// Wrike/TeamGantt): ogni angolo diventa una curva di raggio al massimo
// LINK_RADIUS, meno se i tratti sono corti.
function roundedPath(points: [number, number][]): string {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1])
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]
    const [x, y] = pts[i]
    const [nx, ny] = pts[i + 1]
    const r = Math.min(LINK_RADIUS, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2)
    const inX = x - Math.sign(x - px) * r
    const inY = y - Math.sign(y - py) * r
    const outX = x + Math.sign(nx - x) * r
    const outY = y + Math.sign(ny - y) * r
    d += ` L${inX},${inY} Q${x},${y} ${outX},${outY}`
  }
  const [lx, ly] = pts[pts.length - 1]
  return `${d} L${lx},${ly}`
}
// Fascia verde sotto l'ultimo item della finestra di forecast, come la riga
// "Forecasting - Code Freeze" nella tabella del Backlog.
const CUTOFF_BAND_HEIGHT = 18
const MONTH_BAND_HEIGHT = 18
const WEEK_ROW_HEIGHT = 20
const HEADER_HEIGHT = MONTH_BAND_HEIGHT + WEEK_ROW_HEIGHT
// Riga del calendario con i nomi di Code Freeze e fasi, sopra le loro linee.
const MARK_ROW_HEIGHT = 16
// Larghezza stimata di un carattere delle etichette (11px, grassetto): solo
// se il browser non sa misurare il testo (vedi markTextWidth).
const MARK_CHAR_WIDTH = 6.5
// Come sopra, per il summary scritto sopra le barre (11px): stima larga,
// cosi' il calendario si allunga abbastanza da non tagliarlo.
const LABEL_CHAR_WIDTH = 6.5
// Distanza dal bordo sinistro del Gantt a cui si ferma il summary scorrendo.
const LABEL_STICKY_OFFSET = 8
// Spazio tra la fine delle barre e il nome dell'assegnatario.
const ASSIGNEE_LABEL_GAP = 6
const COLOR_PHASE = '#7c4dbd'
// Sabato e domenica con lo zoom sui giorni.
const COLOR_WEEKEND = 'color-mix(in srgb, var(--border) 30%, transparent)'
// Giorni non lavorativi (ferie, malattia, chiusure): fasce arancio a righe,
// visibili a ogni zoom.
const NON_WORKING_FILL =
  'repeating-linear-gradient(135deg, rgba(235, 104, 52, 0.16) 0 4px, rgba(235, 104, 52, 0.06) 4px 8px)'
// Linea di oggi: rossa piena, con l'etichetta "Today" su sfondo rosso nel
// calendario (anche nel PNG esportato, che mostra il giorno dell'export).
const COLOR_TODAY = '#d3402f'
const TODAY_LABEL = 'Today'

// Larghezza reale di un'etichetta del calendario (11px, con il font della
// pagina), per capire quando due etichette vicine si sovrapporrebbero: una
// stima per carattere sbaglia con nomi lunghi o pieni di lettere larghe.
let measureContext: CanvasRenderingContext2D | null | undefined
function markTextWidth(text: string, fontWeight: number) {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d')
  if (!measureContext) return text.length * MARK_CHAR_WIDTH
  measureContext.font = `${fontWeight} 11px ${getComputedStyle(document.body).fontFamily}`
  return Math.ceil(measureContext.measureText(text).width)
}
// Modifica col mouse della barra "Pianificato": bordo sinistro = inizio,
// bordo destro = fine, il resto della barra = spostamento. Fascia dei bordi
// in pixel (meno sulle barre corte, cosi' resta sempre un centro da
// afferrare).
const BAR_EDGE_ZONE = 6
type BarDragMode = 'move' | 'start' | 'end'
export type GanttBarChange = { mode: BarDragMode; planned_start: string; expected_finish: string }

// Cursori dei bordi: una parentesi quadra ("[" inizio, "]" fine) con la
// freccia orizzontale, bordata di bianco per vedersi anche sulle barre
// scure; il cursore di sistema e' la riserva se l'SVG non viene caricato.
function bracketCursor(side: 'left' | 'right'): string {
  const bracket = side === 'left' ? 'M15 3 H10 V21 H15' : 'M9 3 H14 V21 H9'
  const arrow = 'M2 12 H22 M5.5 8.5 L2 12 L5.5 15.5 M18.5 8.5 L22 12 L18.5 15.5'
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>` +
    `<path d='${bracket}' fill='none' stroke='white' stroke-width='4.5'/>` +
    `<path d='${arrow}' fill='none' stroke='white' stroke-width='4'/>` +
    `<path d='${bracket}' fill='none' stroke='black' stroke-width='2'/>` +
    `<path d='${arrow}' fill='none' stroke='black' stroke-width='1.5'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ${side === 'left' ? 'w-resize' : 'e-resize'}`
}
const CURSOR_BY_MODE: Record<BarDragMode, string> = {
  move: 'move',
  start: bracketCursor('left'),
  end: bracketCursor('right'),
}
const epochDaysToIso = (day: number) => epochDaysToDate(day).toISOString().slice(0, 10)

// Lato massimo dell'immagine esportata: oltre, i browser rifiutano il canvas.
const EXPORT_MAX_SIDE = 16000
// Margine attorno all'immagine esportata e ingrandimento della legenda.
const EXPORT_PADDING = 16
const EXPORT_LEGEND_ZOOM = 1.6

const MONTH_NAMES = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
]
const WEEKDAY_NAMES = ['Do', 'Lu', 'Ma', 'Me', 'Gi', 'Ve', 'Sa']

// Zoom: larghezza in pixel di un giorno. I pulsanti +/- (e Ctrl + rotellina)
// la moltiplicano/dividono per ZOOM_STEP; il calendario cambia scala da solo
// (vedi buildScale) da giorni singoli fino a trimestri e anni.
// Solo per il primo render: subito dopo si passa a "Oggi ±2 settimane",
// che dipende dalla larghezza della vista.
const DEFAULT_DAY_WIDTH = 22
const MIN_DAY_WIDTH = 0.4
const MAX_DAY_WIDTH = 60
const ZOOM_STEP = 1.5
// Giorni mostrati prima e dopo oggi dallo zoom "Oggi ±2 settimane".
const STANDARD_ZOOM_DAYS = 14
const clampDayWidth = (width: number) => Math.min(MAX_DAY_WIDTH, Math.max(MIN_DAY_WIDTH, width))

type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year'
// Una cella del calendario: dal giorno `day` per `width` pixel.
type Band = { day: number; width: number; label: string; weekend?: boolean }

// Numero di settimana ISO 8601 (lunedi'-domenica, la settimana 1 e' quella
// che contiene il primo giovedi' dell'anno) - lo standard usato in Italia.
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = (d.getUTCDay() + 6) % 7 // lunedi'=0..domenica=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3) // giovedi' della stessa settimana
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3)
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
}

// Primo giorno dell'unita' (giorno, settimana da lunedi', mese, trimestre,
// anno) che contiene `day`, e primo giorno dell'unita' successiva.
function unitStart(day: number, unit: Unit): number {
  const date = epochDaysToDate(day)
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  if (unit === 'day') return day
  if (unit === 'week') return day - ((date.getUTCDay() + 6) % 7)
  if (unit === 'month') return toEpochDays(new Date(Date.UTC(y, m, 1)))
  if (unit === 'quarter') return toEpochDays(new Date(Date.UTC(y, m - (m % 3), 1)))
  return toEpochDays(new Date(Date.UTC(y, 0, 1)))
}
function unitNext(start: number, unit: Unit): number {
  const date = epochDaysToDate(start)
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  if (unit === 'day') return start + 1
  if (unit === 'week') return start + 7
  if (unit === 'month') return toEpochDays(new Date(Date.UTC(y, m + 1, 1)))
  if (unit === 'quarter') return toEpochDays(new Date(Date.UTC(y, m + 3, 1)))
  return toEpochDays(new Date(Date.UTC(y + 1, 0, 1)))
}

// Una cella per ogni unita' coperta dal range (prima e ultima troncate a
// minDay/maxDay se coperte solo in parte); l'etichetta e' calcolata sul primo
// giorno dell'unita' intera.
function buildBands(minDay: number, maxDay: number, unit: Unit, dayWidth: number, label: (start: number) => string): Band[] {
  const bands: Band[] = []
  for (let start = unitStart(minDay, unit); start <= maxDay; start = unitNext(start, unit)) {
    const from = Math.max(start, minDay)
    const to = Math.min(unitNext(start, unit) - 1, maxDay)
    const dow = epochDaysToDate(start).getUTCDay()
    bands.push({ day: from, width: (to - from + 1) * dayWidth, label: label(start), weekend: unit === 'day' && (dow === 0 || dow === 6) })
  }
  return bands
}

// Le righe del calendario secondo lo zoom: sopra il contesto (mesi o anni),
// sotto il dettaglio (giorni, settimane, mesi o trimestri), con etichette
// scelte per stare nella larghezza delle celle. Con i giorni c'e' una riga in
// piu' in mezzo, `weeks`, cosi' le settimane restano sempre visibili.
function buildScale(minDay: number, maxDay: number, dayWidth: number) {
  const weekLabel = (start: number, withDate: boolean) => {
    const week = `W${isoWeekNumber(epochDaysToDate(start))}`
    return withDate ? `${week} · ${formatEpochDaysAsDate(start).slice(0, 5)}` : week
  }
  const monthLabel = (start: number) => {
    const d = epochDaysToDate(start)
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  }
  const yearLabel = (start: number) => String(epochDaysToDate(start).getUTCFullYear())
  if (dayWidth >= 32) {
    return {
      name: 'Giorni',
      top: buildBands(minDay, maxDay, 'month', dayWidth, monthLabel),
      weeks: buildBands(minDay, maxDay, 'week', dayWidth, (d) => weekLabel(d, true)),
      bottom: buildBands(minDay, maxDay, 'day', dayWidth, (d) => `${WEEKDAY_NAMES[epochDaysToDate(d).getUTCDay()]} ${epochDaysToDate(d).getUTCDate()}`),
    }
  }
  if (dayWidth >= 5) {
    const withDate = dayWidth >= 12
    return {
      name: 'Settimane',
      top: buildBands(minDay, maxDay, 'month', dayWidth, monthLabel),
      bottom: buildBands(minDay, maxDay, 'week', dayWidth, (d) => weekLabel(d, withDate)),
    }
  }
  if (dayWidth >= 1.6) {
    const longNames = dayWidth * 30 >= 80
    return {
      name: 'Mesi',
      top: buildBands(minDay, maxDay, 'year', dayWidth, yearLabel),
      bottom: buildBands(minDay, maxDay, 'month', dayWidth, (d) => {
        const name = MONTH_NAMES[epochDaysToDate(d).getUTCMonth()]
        return longNames ? name : name.slice(0, 3)
      }),
    }
  }
  return {
    name: 'Trimestri',
    top: buildBands(minDay, maxDay, 'year', dayWidth, yearLabel),
    bottom: buildBands(minDay, maxDay, 'quarter', dayWidth, (d) => `T${Math.floor(epochDaysToDate(d).getUTCMonth() / 3) + 1}`),
  }
}

type Props = {
  items: BacklogItem[]
  jiraBrowseUrl: string | null
  // Ultimo item della finestra di forecast e testo della fascia disegnata
  // sotto la sua riga; null = nessuna finestra (o item non mostrato).
  forecastCutoffId?: number | null
  forecastCutoffLabel?: string
  // Data di Code Freeze dell'increment (ISO), disegnata come linea verticale.
  codeFreezeDate?: string | null
  // Fasi dell'increment (es. Release to Market) con la loro data ISO: una
  // linea verticale ciascuna, e il calendario arriva fino all'ultima anche
  // senza item che ci arrivano.
  // milestone: la fase ha una milestone collegata, che nel Gantt sta sulla
  // sua data: niente linea tratteggiata, un rombo nel calendario.
  phases?: { name: string; date: string | null; milestone?: boolean; milestoneDone?: boolean }[]
  // Giorni non lavorativi del team: una fascia per periodo.
  nonWorkingDays?: NonWorkingDay[]
  // Prefisso del nome del PNG esportato (es. "Gantt_PTBSYS-123"), seguito
  // dalla data dell'export.
  exportName?: string
  // Modifica delle barre "Pianificato" col mouse (assente = Gantt in sola
  // lettura). planBarChange dice cosa cambierebbe (l'item e quelli che ne
  // dipendono), per l'anteprima durante il trascinamento; onBarChange salva
  // quelle modifiche al rilascio. minStart: primo Start possibile di un item
  // coi predecessori (ISO, null = nessun vincolo): la barra non va piu'
  // indietro di cosi', in avanti si'.
  planBarChange?: (item: BacklogItem, change: GanttBarChange) => BacklogPatch[]
  onBarChange?: (updates: BacklogPatch[]) => void
  minStart?: (item: BacklogItem) => string | null
  // Collegamenti creati trascinando dal pallino a fine barra su un altro PBI
  // (assente = non si creano dal Gantt) e tolti col clic sulla freccia.
  // linkError dice perche' un collegamento non si puo' fare (null = si').
  onAddPredecessor?: (predecessor: BacklogItem, successor: BacklogItem) => void
  onRemovePredecessor?: (predecessor: BacklogItem, successor: BacklogItem) => void
  linkError?: (predecessor: BacklogItem, successor: BacklogItem) => string | null
  // Fase a cui e' collegata una milestone (ne prende la data, quindi nel
  // Gantt non si sposta); null se non collegata.
  milestonePhase?: (item: BacklogItem) => string | null
  // Riga trascinata sulla colonna delle chiavi: l'item prende il posto di
  // quello di destinazione, come nella tabella (assente = ordine fisso).
  onRowMove?: (itemId: number, targetId: number) => void
}

const NO_PHASES: { name: string; date: string | null; milestone?: boolean; milestoneDone?: boolean }[] = []
const NO_NON_WORKING_DAYS: NonWorkingDay[] = []

export function BacklogGanttChart({
  items: allItems,
  jiraBrowseUrl,
  forecastCutoffId = null,
  forecastCutoffLabel,
  codeFreezeDate = null,
  phases = NO_PHASES,
  nonWorkingDays = NO_NON_WORKING_DAYS,
  exportName = 'Gantt',
  planBarChange,
  onBarChange,
  minStart,
  onAddPredecessor,
  onRemovePredecessor,
  linkError,
  milestonePhase,
  onRowMove,
}: Props) {
  // Esporta PNG: l'immagine mostra solo il lavoro ancora da fare (gli item
  // visibili col filtro, senza i Done) e il calendario si stringe sulle loro
  // date, invece di partire dall'inizio dell'increment.
  const [exporting, setExporting] = useState(false)
  const notDone = (item: BacklogItem) => item.status !== 'Done'
  const items = exporting && allItems.some(notDone) ? allItems.filter(notDone) : allItems
  // Tre elementi da tenere sincronizzati in orizzontale: il calendario in
  // alto, la barra "specchio" sopra la tabella e lo scroll vero (sulle
  // righe). Calendario e specchio stanno sopra le righe, fuori da
  // .gantt-outer; in verticale il Gantt non ha scroll proprio (come la
  // tabella del Backlog, si mostra per intero e scorre con la pagina), ma
  // calendario e specchio restano agganciati in alto (.gantt-sticky-header).
  const wrapRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const headerScrollRef = useRef<HTMLDivElement>(null)
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
  // Il calendario non riceve mai input utente diretto (overflow: hidden,
  // nessuna scrollbar propria): va solo tenuto allineato a chi scrolla
  // davvero, senza bisogno della guardia anti-loop di syncScroll.
  const mirrorHeaderScroll = (source: RefObject<HTMLDivElement | null>) => {
    if (headerScrollRef.current && source.current) headerScrollRef.current.scrollLeft = source.current.scrollLeft
  }

  // Trascinamento col mouse (tasto sinistro premuto) su calendario o righe:
  // sposta il Gantt a destra/sinistra, come con la barra di scroll. Solo
  // mouse: col tocco lo scorrimento e' gia' quello nativo. I gestori stanno
  // sul contenuto e non sull'elemento che scrolla, cosi' un clic sulla sua
  // barra di scroll non avvia un trascinamento.
  const dragRef = useRef<{ startX: number; startScroll: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const endDrag = () => {
    dragRef.current = null
    setDragging(false)
  }
  const dragHandlers = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !wrapRef.current) return
      dragRef.current = { startX: e.clientX, startScroll: wrapRef.current.scrollLeft }
      // Il trascinamento continua anche se il puntatore esce dal Gantt.
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag && wrapRef.current) wrapRef.current.scrollLeft = drag.startScroll - (e.clientX - drag.startX)
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }
  const dragClassName = dragging ? 'gantt-draggable gantt-draggable--dragging' : 'gantt-draggable'

  // Trascinamento di una barra "Pianificato" (vedi barHandlers sotto):
  // spostamento in giorni interi dal punto di partenza e modifiche che ne
  // derivano, mostrate in anteprima finche' non si rilascia.
  type BarDrag = {
    item: BacklogItem
    mode: BarDragMode
    startX: number
    start: number
    end: number
    // Primo giorno possibile per lo Start (predecessori), null = libero.
    minStart: number | null
    delta: number
    updates: BacklogPatch[]
  }
  const [barDrag, setBarDrag] = useState<BarDrag | null>(null)
  const barDragRef = useRef<BarDrag | null>(null)
  const updateBarDrag = (next: BarDrag | null) => {
    barDragRef.current = next
    setBarDrag(next)
  }

  // Collegamento in creazione: dal pallino a fine barra di "from" fino al
  // puntatore (coordinate del contenuto del Gantt); target = riga sotto il
  // puntatore, reason = perche' non si puo' collegare (null = si').
  type LinkDrag = {
    from: BacklogItem
    x1: number
    y1: number
    x: number
    y: number
    target: BacklogItem | null
    reason: string | null
  }
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Freccia sotto il mouse e menu aperto col clic su una freccia.
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null)
  const [linkMenu, setLinkMenu] = useState<{
    from: BacklogItem
    to: BacklogItem
    x: number
    y: number
  } | null>(null)
  useEffect(() => {
    if (!linkMenu) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest?.('.gantt-link-menu')) {
        setLinkMenu(null)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [linkMenu])

  // Trascinamento di una riga (vedi rowDragHandlers sotto).
  const [rowDragId, setRowDragId] = useState<number | null>(null)
  const [rowDropId, setRowDropId] = useState<number | null>(null)

  // Esporta PNG: per catturare tutto il Gantt e non solo la parte visibile,
  // durante l'export il componente si allarga all'intero calendario (niente
  // scroll orizzontale ne' intestazione agganciata), poi torna com'era.
  // Percorso critico (vedi lib/criticalPath): calcolato sulle date salvate,
  // non sull'anteprima del trascinamento.
  const [showCritical, setShowCritical] = useState(false)
  // Baseline (date originali): barra grigia sottile sotto quella pianificata,
  // nascosta di default.
  const [showBaseline, setShowBaseline] = useState(false)
  const daysOff = useMemo(() => daysOffSet(nonWorkingDays), [nonWorkingDays])
  const baselineNote = (item: BacklogItem) => {
    if (!item.baseline_start || !item.baseline_finish) return ''
    const shift = workingDaysShift(item.baseline_finish, item.expected_finish, daysOff)
    return (
      `\nBaseline: ${formatIsoDate(item.baseline_start)} → ${formatIsoDate(item.baseline_finish)}` +
      (shift ? ` (fine ${shift > 0 ? '+' : ''}${shift} gg lavorativi)` : ' (in linea)')
    )
  }
  const [criticalByAssignee, setCriticalByAssignee] = useState(true)
  const criticalPath = useMemo(
    () => (showCritical ? computeCriticalPath(items, criticalByAssignee, daysOffSet(nonWorkingDays)) : null),
    [showCritical, criticalByAssignee, items, nonWorkingDays],
  )
  const isDimmed = (item: BacklogItem) => !!criticalPath && !criticalPath.critical.has(item.id)
  const rootRef = useRef<HTMLDivElement>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportPng = async () => {
    const savedScroll = wrapRef.current?.scrollLeft ?? 0
    setExportError(null)
    setExporting(true)
    try {
      // Due frame: il primo applica il layout allargato, il secondo lo disegna.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const node = rootRef.current
      if (!node) return
      const width = node.scrollWidth
      const height = node.scrollHeight
      const dataUrl = await toPng(node, {
        width,
        height,
        pixelRatio: Math.min(2, EXPORT_MAX_SIDE / width, EXPORT_MAX_SIDE / height),
        backgroundColor: getComputedStyle(node).getPropertyValue('--surface').trim() || '#ffffff',
        filter: (n) => !(n instanceof HTMLElement && n.classList.contains('gantt-no-export')),
      })
      const link = document.createElement('a')
      link.download = `${exportName}_${new Date().toLocaleDateString('sv-SE')}.png` // sv-SE = AAAA-MM-GG, data locale
      link.href = dataUrl
      link.click()
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
      // Calendario e barra "specchio" seguono via onScroll.
      requestAnimationFrame(() => {
        if (wrapRef.current) wrapRef.current.scrollLeft = savedScroll
      })
    }
  }

  const allDays: number[] = []
  for (const item of items) {
    for (const field of [item.planned_start, item.expected_finish, item.actual_start, item.actual_finish]) {
      const day = dateStrToEpochDays(field)
      if (day !== null) allDays.push(day)
    }
  }

  // "Oggi" entra sempre nel range (serve anche da fine provvisoria per la
  // barra degli item In Progress ancora senza Fine eff., vedi sotto), cosi'
  // resta sempre visibile invece di sparire quando tutte le date degli item
  // sono lontane da adesso.
  const todayDay = toEpochDays(new Date())
  // Anche il Code Freeze entra sempre nel range, per lo stesso motivo.
  const codeFreezeDay = dateStrToEpochDays(codeFreezeDate)
  // Linee verticali con etichetta nel calendario: Code Freeze e fasi. Quelle
  // nello stesso giorno diventano una linea sola con i nomi uno dopo l'altro
  // (la fase "Code freeze" coincide di norma con il Code Freeze).
  const namesByDay = new Map<number, string[]>()
  const addMark = (day: number | null, name: string) => {
    if (day === null) return
    const names = namesByDay.get(day) ?? []
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
    namesByDay.set(day, names)
  }
  addMark(codeFreezeDay, 'Code Freeze')
  for (const phase of phases) addMark(dateStrToEpochDays(phase.date), phase.name)
  // Fasi con la milestone collegata: rombo nel calendario. La linea
  // tratteggiata resta solo se nello stesso giorno c'e' altro (Code Freeze,
  // fasi senza milestone).
  const milestonePhaseNames = new Set(phases.filter((p) => p.milestone).map((p) => p.name.toLowerCase()))
  const hasMilestone = (day: number) => namesByDay.get(day)!.some((n) => milestonePhaseNames.has(n.toLowerCase()))
  const hasLine = (day: number) => namesByDay.get(day)!.some((n) => !milestonePhaseNames.has(n.toLowerCase()))
  // Rombo verde se tutte le milestone di quel giorno sono Done.
  const milestoneDoneOn = (day: number) =>
    phases
      .filter((p) => p.milestone && dateStrToEpochDays(p.date) === day)
      .every((p) => p.milestoneDone)
  const markDays = [...namesByDay.keys()].sort((a, b) => a - b)
  // Nell'export il calendario parte da una settimana prima di oggi (le barre
  // che iniziano prima si tagliano al bordo) e arriva all'ultima data degli
  // item da fare o all'ultima fase, se viene dopo.
  const exportStartDay = todayDay - EXPORT_DAYS_BEFORE_TODAY
  const rangeDays = exporting
    ? [...allDays.filter((day) => day >= exportStartDay), todayDay, ...markDays.filter((day) => day >= exportStartDay)]
    : [...allDays, todayDay, ...markDays]
  const minDay = exporting ? exportStartDay : Math.min(...rangeDays) - 2
  const rangeMaxDay = Math.max(...rangeDays) + 2

  // Zoom. "Intero progetto" (fit) adatta la larghezza del giorno perche'
  // tutto il range stia nella vista; un qualsiasi altro zoom lo annulla.
  const [dayWidth, setDayWidth] = useState(DEFAULT_DAY_WIDTH)
  const [fit, setFit] = useState(false)
  // Giorno da tenere fermo nello stesso punto della vista dopo il cambio di
  // zoom (il centro, o il puntatore con Ctrl + rotellina): applicato dopo il
  // render, quando la nuova larghezza e' in pagina.
  const zoomAnchorRef = useRef<{ day: number; offset: number } | null>(null)
  // Contatore delle richieste di zoom: l'ancora va applicata anche quando la
  // larghezza non cambia (es. "Oggi ±2 settimane" dopo aver scorso altrove).
  const [zoomRequest, setZoomRequest] = useState(0)
  const zoomTo = (width: number, offset?: number) => {
    const wrap = wrapRef.current
    if (!wrap) return
    const at = offset ?? wrap.clientWidth / 2
    // Piu' eventi della rotellina prima del render: resta l'ancora del primo.
    if (!zoomAnchorRef.current) zoomAnchorRef.current = { day: minDay + (wrap.scrollLeft + at) / dayWidth, offset: at }
    setDayWidth(clampDayWidth(width))
    setFit(false)
    setZoomRequest((n) => n + 1)
  }
  const fitToProject = () => {
    const wrap = wrapRef.current
    if (!wrap) return
    zoomAnchorRef.current = { day: minDay, offset: 0 }
    // -2: senza arrotondamenti che farebbero comparire la barra di scroll.
    setDayWidth(clampDayWidth((wrap.clientWidth - 2) / (rangeMaxDay - minDay + 1)))
    setFit(true)
    setZoomRequest((n) => n + 1)
  }
  // Zoom "standard": le 2 settimane prima e dopo oggi riempiono la vista,
  // con oggi al centro.
  const zoomAroundToday = () => {
    const wrap = wrapRef.current
    if (!wrap) return
    zoomAnchorRef.current = { day: todayDay + 0.5, offset: wrap.clientWidth / 2 }
    setDayWidth(clampDayWidth((wrap.clientWidth - 2) / (2 * STANDARD_ZOOM_DAYS + 1)))
    setFit(false)
    setZoomRequest((n) => n + 1)
  }
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const anchor = zoomAnchorRef.current
    zoomAnchorRef.current = null
    if (wrap && anchor) wrap.scrollLeft = (anchor.day - minDay) * dayWidth - anchor.offset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomRequest])
  // Ctrl + rotellina (o pinch sul touchpad) zooma attorno al puntatore invece
  // di zoomare la pagina: serve un listener non passivo per preventDefault.
  const zoomToRef = useRef(zoomTo)
  zoomToRef.current = zoomTo
  const dayWidthRef = useRef(dayWidth)
  dayWidthRef.current = dayWidth

  // Ultimo giorno coperto dalle barre di un item (pianificato, effettivo o in
  // corso fino a oggi): l'assegnatario si scrive subito dopo.
  const barEndDay = (item: BacklogItem): number | null => {
    const actualStart = dateStrToEpochDays(item.actual_start)
    const ends = [
      item.planned_start ? dateStrToEpochDays(item.expected_finish) : null,
      item.actual_start ? dateStrToEpochDays(item.actual_finish) : null,
      actualStart !== null && !item.actual_finish && item.status === 'In Progress' ? Math.max(actualStart, todayDay) : null,
    ].filter((day): day is number => day !== null)
    return ends.length > 0 ? Math.max(...ends) : null
  }

  // Il summary parte dall'inizio della barra e puo' essere piu' lungo di
  // quanto resta fino all'ultima data: il calendario si allunga dei giorni
  // che servono a leggerlo per intero. Non con "Intero progetto" ne' a scale
  // larghe (mesi, trimestri), dove allungherebbe il calendario di mesi: li'
  // il summary si tronca (testo completo nel tooltip).
  const extendForLabels = !fit && dayWidth >= 5
  const labelEndDays = extendForLabels
    ? items.map((item) => {
        const anchor = dateStrToEpochDays(item.planned_start) ?? dateStrToEpochDays(item.actual_start)
        if (anchor === null) return 0
        return anchor + Math.ceil(((item.summary ?? item.jira_key).length * LABEL_CHAR_WIDTH + 8) / dayWidth)
      })
    : []
  const assigneeEndDays = extendForLabels
    ? items.map((item) => {
        const barEnd = barEndDay(item)
        if (barEnd === null || !item.assignee) return 0
        return barEnd + 1 + Math.ceil((item.assignee.length * LABEL_CHAR_WIDTH + ASSIGNEE_LABEL_GAP * 2) / dayWidth)
      })
    : []
  const maxDay = Math.max(rangeMaxDay, ...labelEndDays, ...assigneeEndDays)

  // All'apertura il Gantt parte dallo zoom "Oggi ±2 settimane", invece che
  // dal primo giorno del range. Solo la prima volta che c'e' qualcosa da
  // mostrare: dopo, zoom e scroll restano dove li ha lasciati l'utente
  // (calendario e barra "specchio" seguono da soli, via onScroll).
  const hasDates = allDays.length > 0
  useLayoutEffect(() => {
    if (hasDates) zoomAroundToday()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDates])
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !wrapRef.current) return
      e.preventDefault()
      const offset = e.clientX - wrapRef.current.getBoundingClientRect().left
      zoomToRef.current(dayWidthRef.current * Math.exp(-e.deltaY * 0.002), offset)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [hasDates])

  if (!hasDates) {
    return (
      <p className="muted">
        Nessun item ha una data (pianificata o effettiva) impostata: aggiungile nelle colonne Start/Fine per vederle
        sul Gantt.
      </p>
    )
  }

  const chartWidth = (maxDay - minDay + 1) * dayWidth
  const dayToX = (day: number) => (day - minDay) * dayWidth
  // Le linee verticali (Today, Code Freeze, fasi) cadono a fine giornata,
  // sul bordo destro del giorno, dove finiscono anche le barre.
  const lineX = (day: number) => dayToX(day) + dayWidth
  // Dove esce una freccia (fine della barra, punta destra del rombo) e dove
  // arriva (inizio della barra, punta sinistra del rombo).
  const linkStartX = (item: BacklogItem, endDay: number) =>
    isMilestone(item) ? lineX(endDay) + MILESTONE_HALF : dayToX(endDay) + dayWidth
  const linkEndX = (item: BacklogItem, startDay: number) =>
    isMilestone(item) ? lineX(startDay) - MILESTONE_HALF : dayToX(startDay)

  // Barre modificabili col mouse: cursore secondo la zona (bordi o centro),
  // trascinamento a giorni interi con anteprima, salvataggio al rilascio.
  const editable = !!planBarChange && !!onBarChange && !exporting
  const barZone = (e: PointerEvent<HTMLDivElement>): BarDragMode | null => {
    const rect = e.currentTarget.getBoundingClientRect()
    const edge = Math.min(BAR_EDGE_ZONE, rect.width / 3)
    const x = e.clientX - rect.left
    return x <= edge ? 'start' : x >= rect.width - edge ? 'end' : 'move'
  }
  const barChange = (drag: BarDrag, rawDelta: number): GanttBarChange => {
    // Coi predecessori lo Start non va prima del loro limite: spostando la
    // barra si ferma li', col bordo sinistro anche.
    const lowest = drag.minStart ?? -Infinity
    const delta = drag.mode === 'move' ? Math.max(rawDelta, Math.min(0, lowest - drag.start)) : rawDelta
    const start =
      drag.mode === 'end'
        ? drag.start
        : drag.mode === 'start'
          ? Math.min(Math.max(drag.start + delta, Math.min(lowest, drag.start)), drag.end)
          : drag.start + delta
    const end = drag.mode === 'start' ? drag.end : Math.max(drag.end + delta, drag.mode === 'end' ? drag.start : -Infinity)
    return { mode: drag.mode, planned_start: epochDaysToIso(start), expected_finish: epochDaysToIso(end) }
  }
  const endBarDrag = () => {
    document.body.style.cursor = ''
    updateBarDrag(null)
  }
  // fixedZone: il rombo di una milestone si sposta soltanto (niente bordi).
  const barHandlers = (item: BacklogItem, start: number, end: number, fixedZone?: BarDragMode) =>
    editable
      ? {
          onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
            const drag = barDragRef.current
            if (!drag) {
              const zone = fixedZone ?? barZone(e)
              e.currentTarget.style.cursor = zone ? CURSOR_BY_MODE[zone] : ''
              return
            }
            if (drag.item.id !== item.id) return
            const delta = Math.round((e.clientX - drag.startX) / dayWidth)
            if (delta === drag.delta) return
            updateBarDrag({ ...drag, delta, updates: delta === 0 ? [] : planBarChange!(item, barChange(drag, delta)) })
          },
          onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
            if (e.pointerType !== 'mouse' || e.button !== 0) return
            const zone = fixedZone ?? barZone(e)
            // Fuori dalle zone modificabili il trascinamento sposta il Gantt.
            if (!zone) return
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            document.body.style.cursor = CURSOR_BY_MODE[zone]
            const min = minStart?.(item)
            updateBarDrag({
              item,
              mode: zone,
              startX: e.clientX,
              start,
              end,
              minStart: min ? dateStrToEpochDays(min) : null,
              delta: 0,
              updates: [],
            })
          },
          onPointerUp: () => {
            const drag = barDragRef.current
            if (drag && drag.updates.length > 0) onBarChange!(drag.updates)
            endBarDrag()
          },
          onPointerCancel: endBarDrag,
        }
      : {}
  // Spostamento delle righe: si afferra la chiave a sinistra e si rilascia su
  // una riga qualsiasi, chiave o timeline. La linea blu indica dove finira'.
  const rowsMovable = !!onRowMove && !exporting
  const endRowDrag = () => {
    setRowDragId(null)
    setRowDropId(null)
  }
  const rowDragHandlers = (item: BacklogItem) =>
    rowsMovable
      ? {
          draggable: true,
          title: 'Trascina per spostare la riga',
          onDragStart: (e: DragEvent<HTMLDivElement>) => {
            setRowDragId(item.id)
            e.dataTransfer.setData('text/plain', String(item.id))
            e.dataTransfer.effectAllowed = 'move'
          },
          onDragEnd: endRowDrag,
        }
      : {}
  const rowDropHandlers = (item: BacklogItem) =>
    rowsMovable
      ? {
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            if (rowDragId === null) return
            e.preventDefault()
            setRowDropId(item.id)
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            e.preventDefault()
            if (rowDragId !== null && rowDragId !== item.id) onRowMove!(rowDragId, item.id)
            endRowDrag()
          },
        }
      : {}
  const rowDragStyle = (item: BacklogItem): CSSProperties | undefined => {
    if (rowDragId === item.id) return { opacity: 0.4 }
    if (rowDragId === null || rowDropId !== item.id) return undefined
    const movingDown = items.findIndex((i) => i.id === rowDragId) < items.findIndex((i) => i.id === item.id)
    return { boxShadow: `inset 0 ${movingDown ? -3 : 3}px 0 var(--primary)` }
  }

  // Durante il trascinamento le barre mostrano gia' le date nuove (l'item e
  // quelli che si spostano con lui); altrimenti quelle salvate.
  const previewById = new Map((barDrag?.updates ?? []).map((u) => [u.id, u]))
  const shownItems = previewById.size > 0 ? items.map((i) => (previewById.has(i.id) ? { ...i, ...previewById.get(i.id) } : i)) : items
  const scale = buildScale(minDay, maxDay, dayWidth)
  const headerHeight = HEADER_HEIGHT + (scale.weeks ? WEEK_ROW_HEIGHT : 0)

  // Etichetta (nomi e data, sempre visibili) a destra della linea, o a
  // sinistra dove a fine calendario non ci starebbe; se toccherebbe quella
  // prima va sulla riga sotto. "Today" e' centrata sulla sua linea e
  // partecipa allo stesso calcolo, cosi' non si sovrappone a Code Freeze e
  // fasi vicine.
  const todayLabelWidth = markTextWidth(TODAY_LABEL, 700) + 8
  // Dentro il calendario anche quando oggi e' vicino a un suo bordo.
  const todayLabelStart = Math.min(Math.max(0, lineX(todayDay) - todayLabelWidth / 2), chartWidth - todayLabelWidth)
  const todaySlot = { start: todayLabelStart, width: todayLabelWidth, lane: 0 }
  const marks = markDays.filter((day) => day >= minDay).map((day) => {
    const label = `${namesByDay.get(day)!.join(' · ')} ${formatEpochDaysAsDate(day)}`
    const width = markTextWidth(label, 600)
    // Con la milestone il testo si scosta dal rombo, centrato sulla data.
    const milestone = hasMilestone(day)
    const gap = milestone ? MILESTONE_HALF + 3 : 6
    const alignRight = lineX(day) + gap + width > chartWidth
    return {
      day,
      label,
      milestone,
      line: hasLine(day),
      start: alignRight ? lineX(day) - (milestone ? gap : 3) - width : lineX(day) - (milestone ? MILESTONE_HALF : 0) + (milestone ? 0 : 6),
      width: width + (milestone ? MILESTONE_HALF + gap : 0),
      lane: 0,
      color: day === codeFreezeDay ? 'var(--success)' : COLOR_PHASE,
      position: alignRight ? { right: chartWidth - lineX(day) + (milestone ? gap : 3) } : { left: lineX(day) + gap },
    }
  })
  const laneEnds: number[] = []
  for (const slot of [...marks, todaySlot].sort((a, b) => a.start - b.start)) {
    let lane = laneEnds.findIndex((end) => end + 8 <= slot.start)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = slot.start + slot.width
    slot.lane = lane
  }

  // Frecce dei predecessori, come in Project/Wrike: dalla fine della barra
  // pianificata del predecessore all'inizio di quella del successore. Solo
  // tra item entrambi visibili nel Gantt e con la barra pianificata.
  const rowByKey = new Map(items.map((item, row) => [item.jira_key.toUpperCase(), row]))
  // Le righe sotto la fascia della finestra di forecast sono piu' in basso.
  const cutoffRow = forecastCutoffId == null ? -1 : items.findIndex((item) => item.id === forecastCutoffId)
  const rowTop = (row: number) => row * ROW_HEIGHT + (cutoffRow >= 0 && row > cutoffRow ? CUTOFF_BAND_HEIGHT : 0)
  const barCenterY = (row: number) => rowTop(row) + PLANNED_BAR_TOP + BAR_HEIGHT / 2
  const linkPath = (predecessorRow: number, successorRow: number) => {
    const predecessor = shownItems[predecessorRow]
    const successor = shownItems[successorRow]
    const sStart = dateStrToEpochDays(successor.planned_start)
    if (sStart === null || dateStrToEpochDays(successor.expected_finish) === null) return null
    {
      const pStart = dateStrToEpochDays(predecessor.planned_start)
      const pEnd = dateStrToEpochDays(predecessor.expected_finish)
      if (pStart === null || pEnd === null) return null
      const x1 = linkStartX(predecessor, Math.max(pStart, pEnd))
      const y1 = barCenterY(predecessorRow)
      const x2 = linkEndX(successor, sStart)
      const y2 = barCenterY(successorRow)
      // Esce a destra dalla fine del predecessore e arriva da sinistra
      // all'inizio del successore. Con spazio tra le due barre basta un
      // gomito; altrimenti (successore che parte subito dopo, il caso
      // normale) la linea rientra a sinistra lungo il bordo tra le righe,
      // sopra la riga del successore (sotto, se il successore sta sopra).
      const below = successorRow > predecessorRow
      const out = x1 + LINK_STUB
      if (x2 - LINK_ARRIVAL >= out) {
        return roundedPath([
          [x1, y1],
          [out, y1],
          [out, y2],
          [x2, y2],
        ])
      }
      const yGap = below ? rowTop(successorRow) + 3 : rowTop(successorRow) + ROW_HEIGHT - 3
      return roundedPath([
        [x1, y1],
        [out, y1],
        [out, yGap],
        [x2 - LINK_ARRIVAL, yGap],
        [x2 - LINK_ARRIVAL, y2],
        [x2, y2],
      ])
    }
  }
  const criticalLinkIds = new Set(criticalPath?.links.map((l) => `${l.from}-${l.to}`))
  const links = shownItems.flatMap((successor, successorRow) =>
    parsePredecessors(successor.predecessors).flatMap((key) => {
      const predecessorRow = rowByKey.get(key)
      if (predecessorRow === undefined || predecessorRow === successorRow) return []
      const path = linkPath(predecessorRow, successorRow)
      if (path === null) return []
      const predecessor = shownItems[predecessorRow]
      const id = `${predecessor.id}-${successor.id}`
      return [
        {
          id,
          path,
          title: `${predecessor.jira_key} → ${successor.jira_key}`,
          critical: criticalLinkIds.has(id),
          implicit: false,
          from: predecessor as BacklogItem | undefined,
          to: successor as BacklogItem | undefined,
        },
      ]
    }),
  )
  // Legami impliciti del percorso critico (stesso assegnatario, uno dopo
  // l'altro): disegnati solo con il percorso critico attivo, tratteggiati.
  const rowById = new Map(items.map((item, row) => [item.id, row]))
  const implicitLinks = (criticalPath?.links ?? []).flatMap((l) => {
    if (!l.implicit) return []
    const from = rowById.get(l.from)
    const to = rowById.get(l.to)
    if (from === undefined || to === undefined) return []
    const path = linkPath(from, to)
    if (path === null) return []
    const title = `${shownItems[from].jira_key} → ${shownItems[to].jira_key} (stesso assegnatario: ${shownItems[to].assignee})`
    return [
      {
        id: `i${l.from}-${l.to}`,
        path,
        title,
        critical: true,
        implicit: true,
        from: undefined as BacklogItem | undefined,
        to: undefined as BacklogItem | undefined,
      },
    ]
  })
  const allLinks = [...links, ...implicitLinks]

  // Creazione di un collegamento trascinando dal pallino a fine barra.
  const linkable = !!onAddPredecessor && !exporting
  const contentPoint = (e: PointerEvent<HTMLElement>) => {
    const rect = contentRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const startLinkDrag = (e: PointerEvent<HTMLDivElement>, item: BacklogItem, row: number, plannedEnd: number) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setLinkMenu(null)
    const x1 = linkStartX(item, plannedEnd)
    const y1 = barCenterY(row)
    setLinkDrag({ from: item, x1, y1, ...contentPoint(e), target: null, reason: null })
  }
  const moveLinkDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!linkDrag) return
    // Vicino ai bordi il Gantt scorre da solo, per arrivare a barre fuori vista.
    const wrap = wrapRef.current
    if (wrap) {
      const rect = wrap.getBoundingClientRect()
      if (e.clientX > rect.right - 40) wrap.scrollLeft += 15
      else if (e.clientX < rect.left + 40) wrap.scrollLeft -= 15
    }
    const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-gantt-item]')
    const targetId = rowEl ? Number(rowEl.dataset.ganttItem) : null
    const target = targetId === null || targetId === linkDrag.from.id ? null : (items.find((i) => i.id === targetId) ?? null)
    setLinkDrag({
      ...linkDrag,
      ...contentPoint(e),
      target,
      reason: target ? (linkError?.(linkDrag.from, target) ?? null) : null,
    })
  }
  const endLinkDrag = () => {
    if (linkDrag?.target && !linkDrag.reason) onAddPredecessor!(linkDrag.from, linkDrag.target)
    setLinkDrag(null)
  }
  const linkTargetColor = linkDrag?.reason ? COLOR_LINK_INVALID : COLOR_LINK_VALID
  const isLinkTarget = (item: BacklogItem) => linkDrag?.target?.id === item.id
  // Riga del PBI di arrivo appena colorata; la barra ha il contorno pieno.
  const linkTargetStyle = (item: BacklogItem): CSSProperties | undefined =>
    isLinkTarget(item) ? { background: linkDrag?.reason ? '#fef2f2' : '#f0fdf4' } : undefined
  // Anteprima del collegamento: sul PBI di arrivo (con la barra pianificata)
  // la freccia si aggancia all'inizio della barra col percorso definitivo;
  // altrimenti segue il puntatore.
  const linkPreview = (() => {
    if (!linkDrag) return null
    const fromRow = shownItems.findIndex((i) => i.id === linkDrag.from.id)
    const targetRow = linkDrag.target ? shownItems.findIndex((i) => i.id === linkDrag.target!.id) : -1
    const snapped = fromRow >= 0 && targetRow >= 0 ? linkPath(fromRow, targetRow) : null
    if (snapped) {
      const start = dateStrToEpochDays(shownItems[targetRow].planned_start)!
      return { path: snapped, anchor: { x: linkEndX(shownItems[targetRow], start), y: barCenterY(targetRow) } }
    }
    return { path: `M${linkDrag.x1},${linkDrag.y1} L${linkDrag.x},${linkDrag.y}`, anchor: null }
  })()
  // Assegnatario di un item da cui parte una freccia: spostato oltre il
  // tratto d'uscita, cosi' la freccia scende prima del testo.
  const linkSourceIds = new Set(allLinks.map((link) => Number(link.id.split('-')[0])))
  const assigneeLabelLeft = (item: BacklogItem, barEnd: number) => {
    const afterBar = linkStartX(item, barEnd) + ASSIGNEE_LABEL_GAP
    const plannedEnd = dateStrToEpochDays(item.expected_finish)
    if (!linkSourceIds.has(item.id) || plannedEnd === null) return afterBar
    return Math.max(afterBar, linkStartX(item, plannedEnd) + LINK_STUB + ASSIGNEE_LABEL_GAP)
  }

  return (
    <div
      ref={rootRef}
      // Nell'export un margine attorno (altrimenti la legenda tocca il bordo
      // dell'immagine) e la legenda piu' grande: l'immagine e' larga quanto
      // tutto il calendario e a 12px la legenda si perdeva.
      style={
        exporting
          ? { width: LABEL_COLUMN_WIDTH + chartWidth + 2, background: 'var(--surface)', padding: EXPORT_PADDING }
          : undefined
      }
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 16px',
          marginBottom: 8,
          fontSize: 12,
          alignItems: 'center',
          // zoom e non fontSize: ingrandisce anche i quadratini colorati.
          zoom: exporting ? EXPORT_LEGEND_ZOOM : undefined,
        }}
      >
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }} />
            {type}
          </span>
        ))}
        {items.some((item) => !item.is_activity && !(item.issue_type && item.issue_type in TYPE_COLORS)) && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: COLOR_OTHER_TYPE, display: 'inline-block' }} />
            Altri tipi
          </span>
        )}
        <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 3,
              background: plannedFill(COLOR_OTHER_TYPE),
              border: `1px solid ${COLOR_OTHER_TYPE}`,
              boxSizing: 'border-box',
              display: 'inline-block',
            }}
          />
          Aggiornato
        </span>
        <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: COLOR_OTHER_TYPE, display: 'inline-block' }} />
          Effettivo
        </span>
        <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{ width: 12, height: 12, borderRadius: 3, background: inProgressFill(COLOR_OTHER_TYPE), display: 'inline-block' }}
          />
          In progress (da inizio a oggi)
        </span>
        <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 0, height: 12, borderLeft: `2px solid ${COLOR_TODAY}`, display: 'inline-block' }} />
          Today {formatEpochDaysAsDate(todayDay)}
        </span>
        {codeFreezeDay !== null && (
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 0, height: 12, borderLeft: '3px dashed var(--success)', display: 'inline-block' }} />
            Code Freeze {formatEpochDaysAsDate(codeFreezeDay)}
          </span>
        )}
        {phases.some((phase) => phase.date !== null) && (
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 0, height: 12, borderLeft: `3px dashed ${COLOR_PHASE}`, display: 'inline-block' }} />
            Fasi dell'increment
          </span>
        )}
        {nonWorkingDays.length > 0 && (
          <span
            className="muted"
            style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'help' }}
            title={nonWorkingDays
              .map((d) => `${formatIsoDate(d.start_date)} → ${formatIsoDate(d.end_date)}${d.description ? `: ${d.description}` : ''}`)
              .join('\n')}
          >
            <span style={{ width: 12, height: 12, borderRadius: 3, background: NON_WORKING_FILL, display: 'inline-block' }} />
            Giorni non lavorativi
          </span>
        )}
        {/* Attivita' di servizio: una voce per fase presente, a strisce col
            colore della fase (pianificato); l'effettivo e' arancio a strisce
            per tutte. */}
        {ACTIVITY_PHASES.filter((phase) => items.some((item) => activityPhaseInfo(item)?.value === phase.value)).map((phase) => (
          <span key={phase.value} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: activityFill(phase.color), display: 'inline-block' }} />
            {phase.label} activities
          </span>
        ))}
        {items.some((item) => item.is_activity) && (
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{ width: 12, height: 12, borderRadius: 3, background: activityFill(COLOR_ACTUAL), display: 'inline-block' }}
            />
            Attività (fuori code freeze): effettivo
          </span>
        )}
        {showBaseline && (
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 4, borderRadius: 2, background: COLOR_BASELINE, display: 'inline-block' }} />
            Baseline (date originali)
          </span>
        )}
        {items.some(isMilestone) && (
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 9,
                height: 9,
                margin: '0 2px',
                transform: 'rotate(45deg)',
                background: COLOR_MILESTONE,
                border: `1.5px solid ${COLOR_MILESTONE_BORDER}`,
                display: 'inline-block',
              }}
            />
            <span
              style={{
                width: 9,
                height: 9,
                margin: '0 2px',
                transform: 'rotate(45deg)',
                background: COLOR_MILESTONE_DONE,
                border: `1.5px solid ${COLOR_MILESTONE_DONE_BORDER}`,
                display: 'inline-block',
              }}
            />
            Milestone (da fare / Done)
          </span>
        )}
        {links.length > 0 && (
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ color: COLOR_LINK, fontWeight: 700 }}>→</span>
            Predecessore → successore
          </span>
        )}
        {cutoffRow >= 0 && (
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 4, background: 'var(--success)', display: 'inline-block' }} />
            Fine della finestra di forecast
          </span>
        )}
        {criticalPath && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                border: `2px solid ${COLOR_CRITICAL}`,
                boxSizing: 'border-box',
                display: 'inline-block',
              }}
            />
            {criticalPath.considered === 0 || !criticalPath.projectFinish
              ? 'Percorso critico: nessun item da finire con date aggiornate'
              : `Percorso critico: ${criticalPath.critical.size} item su ${criticalPath.considered} senza margine, fine ${formatIsoDate(criticalPath.projectFinish)}`}
          </span>
        )}
        <span className="gantt-no-export" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {items.some((i) => i.baseline_start) && (
            <button
              className={showBaseline ? 'btn btn-primary' : 'btn'}
              onClick={() => setShowBaseline((v) => !v)}
              title="Mostra sotto ogni barra le date originali (baseline), fissate col pulsante Fissa baseline"
              aria-pressed={showBaseline}
            >
              Mostra baseline
            </button>
          )}
          <button
            className={showCritical ? 'btn btn-primary' : 'btn'}
            onClick={() => setShowCritical((v) => !v)}
            title="Evidenzia gli item che, se slittano, spostano la fine del progetto (item da finire, con Start e Fine agg.; attività per Release escluse)"
            aria-pressed={showCritical}
          >
            Percorso critico
          </button>
          {showCritical && (
            <label
              className="muted"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
              title="Oltre ai Predecessori, considera che ogni assegnatario fa un item dopo l'altro"
            >
              <input type="checkbox" checked={criticalByAssignee} onChange={(e) => setCriticalByAssignee(e.target.checked)} />
              sequenza per assegnatario
            </label>
          )}
          <span
            className="muted"
            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            title="Zoom: anche con Ctrl + rotellina del mouse sul Gantt"
          >
            Zoom: {scale.name}
            <button
              className="btn"
              disabled={dayWidth <= MIN_DAY_WIDTH}
              onClick={() => zoomTo(dayWidth / ZOOM_STEP)}
              title="Riduci lo zoom: verso mesi, trimestri e anni"
              aria-label="Riduci lo zoom"
            >
              −
            </button>
            <button
              className="btn"
              disabled={dayWidth >= MAX_DAY_WIDTH}
              onClick={() => zoomTo(dayWidth * ZOOM_STEP)}
              title="Aumenta lo zoom: verso i singoli giorni"
              aria-label="Aumenta lo zoom"
            >
              +
            </button>
            <button className="btn" onClick={zoomAroundToday} title="Zoom standard: 2 settimane prima e dopo oggi, con oggi al centro">
              Oggi ±2 settimane
            </button>
            <button className="btn" disabled={fit} onClick={fitToProject} title="Adatta lo zoom per vedere tutto il progetto">
              Intero progetto
            </button>
          </span>
          {exportError && <span style={{ color: 'var(--danger)' }}>Export non riuscito: {exportError}</span>}
          <button className="btn" disabled={exporting} onClick={exportPng} title="Scarica il Gantt come immagine PNG: gli item visibili col filtro senza i Done, da una settimana prima di oggi">
            {exporting ? 'Esportazione…' : 'Esporta PNG'}
          </button>
        </span>
      </div>

      {/* Calendario e barra "specchio": fuori da .gantt-outer (vedi commento
          sopra) e agganciati in cima alla finestra scorrendo la pagina, cosi'
          le date restano visibili anche sulle ultime righe. Il calendario
          scorre in orizzontale solo via JS (nessuna scrollbar propria,
          overflow hidden). */}
      <div className="gantt-sticky-header" style={exporting ? { position: 'static' } : undefined}>
        <div style={{ display: 'flex' }}>
          <div style={{ width: LABEL_COLUMN_WIDTH, flexShrink: 0 }} />
          <div ref={headerScrollRef} style={{ flex: 1, minWidth: 0, overflow: exporting ? 'visible' : 'hidden' }}>
            <div
              className={dragClassName}
              {...dragHandlers}
              style={{
                width: chartWidth,
                height: headerHeight + laneEnds.length * MARK_ROW_HEIGHT,
                position: 'relative',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: MONTH_BAND_HEIGHT,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {scale.top.map((band) => (
                  <div
                    key={band.day}
                    className="muted"
                    style={{
                      position: 'absolute',
                      left: dayToX(band.day),
                      width: band.width,
                      top: 0,
                      height: '100%',
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      borderLeft: '1px solid var(--border)',
                      paddingLeft: 3,
                    }}
                  >
                    {band.label}
                  </div>
                ))}
              </div>
              {scale.weeks && (
                <div
                  style={{
                    position: 'absolute',
                    top: MONTH_BAND_HEIGHT,
                    left: 0,
                    right: 0,
                    height: WEEK_ROW_HEIGHT,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {scale.weeks.map((band) => (
                    <div
                      key={band.day}
                      className="muted"
                      title={band.label}
                      style={{
                        position: 'absolute',
                        left: dayToX(band.day),
                        width: band.width,
                        top: 0,
                        height: '100%',
                        lineHeight: `${WEEK_ROW_HEIGHT}px`,
                        fontSize: 11,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'clip',
                        borderLeft: '1px solid var(--border)',
                        paddingLeft: 3,
                      }}
                    >
                      {band.label}
                    </div>
                  ))}
                </div>
              )}
              <div
                style={{
                  position: 'absolute',
                  top: headerHeight - WEEK_ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: WEEK_ROW_HEIGHT,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {scale.bottom.map((band) => (
                  <div
                    key={band.day}
                    className="muted"
                    title={band.label}
                    style={{
                      position: 'absolute',
                      left: dayToX(band.day),
                      width: band.width,
                      top: 0,
                      height: '100%',
                      lineHeight: `${WEEK_ROW_HEIGHT}px`,
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'clip',
                      textAlign: scale.name === 'Giorni' ? 'center' : undefined,
                      borderLeft: '1px solid var(--border)',
                      paddingLeft: scale.name === 'Giorni' ? 0 : 3,
                      background: band.weekend ? COLOR_WEEKEND : undefined,
                    }}
                  >
                    {band.label}
                  </div>
                ))}
              </div>
              {marks
                .filter((mark) => mark.milestone)
                .map((mark) => (
                  <div
                    key={`milestone-${mark.day}`}
                    title={`Milestone · ${mark.label}`}
                    style={{
                      position: 'absolute',
                      top: headerHeight + mark.lane * MARK_ROW_HEIGHT + MARK_ROW_HEIGHT / 2 - 5.5,
                      left: lineX(mark.day) - 5.5,
                      width: 11,
                      height: 11,
                      transform: 'rotate(45deg)',
                      background: milestoneDoneOn(mark.day) ? COLOR_MILESTONE_DONE : COLOR_MILESTONE,
                      border: `1.5px solid ${milestoneDoneOn(mark.day) ? COLOR_MILESTONE_DONE_BORDER : COLOR_MILESTONE_BORDER}`,
                      borderRadius: 2,
                      boxSizing: 'border-box',
                    }}
                  />
                ))}
              {marks.map((mark) => (
                <div
                  key={mark.day}
                  title={mark.label}
                  style={{
                    position: 'absolute',
                    top: headerHeight + mark.lane * MARK_ROW_HEIGHT,
                    height: MARK_ROW_HEIGHT,
                    ...mark.position,
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: `${MARK_ROW_HEIGHT}px`,
                    whiteSpace: 'nowrap',
                    color: mark.color,
                  }}
                >
                  {mark.label}
                </div>
              ))}
              {/* Today: etichetta su sfondo rosso centrata sulla linea, che
                  la collega alle righe sotto. */}
              <div
                style={{
                  position: 'absolute',
                  left: lineX(todayDay) - 1,
                  top: headerHeight + todaySlot.lane * MARK_ROW_HEIGHT + MARK_ROW_HEIGHT - 2,
                  bottom: 0,
                  borderLeft: `2px solid ${COLOR_TODAY}`,
                }}
              />
              <div
                title={`Today ${formatEpochDaysAsDate(todayDay)}`}
                style={{
                  position: 'absolute',
                  top: headerHeight + todaySlot.lane * MARK_ROW_HEIGHT + 1,
                  left: todaySlot.start,
                  width: todaySlot.width,
                  height: MARK_ROW_HEIGHT - 2,
                  fontSize: 11,
                  fontWeight: 700,
                  lineHeight: `${MARK_ROW_HEIGHT - 2}px`,
                  textAlign: 'center',
                  color: 'white',
                  background: COLOR_TODAY,
                  borderRadius: 3,
                }}
              >
                {TODAY_LABEL}
              </div>
            </div>
          </div>
        </div>

        {/* Spacer della stessa larghezza della colonna ID, cosi' la barra
            "specchio" sotto si allinea esattamente sopra la timeline vera. */}
        <div className="gantt-no-export" style={{ display: 'flex' }}>
          <div style={{ width: LABEL_COLUMN_WIDTH, flexShrink: 0 }} />
          <div
            className="table-scroll-mirror"
            ref={topScrollRef}
            onScroll={() => {
              syncScroll(topScrollRef, wrapRef)
              mirrorHeaderScroll(topScrollRef)
            }}
            style={{ flex: 1, minWidth: 0 }}
          >
            <div style={{ width: chartWidth }} />
          </div>
        </div>
      </div>
      {/* Colonna ID: fuori dall'area di scroll orizzontale (gantt-timeline-col
          sotto), resta quindi sempre visibile scorrendo a destra. */}
      <div className="gantt-outer">
        <div className="gantt-labels-col" style={{ width: LABEL_COLUMN_WIDTH }}>
          {items.map((item, row) => (
            <Fragment key={item.id}>
              <div
                className="gantt-label-row"
                style={{ height: ROW_HEIGHT, ...rowDragStyle(item) }}
                {...rowDragHandlers(item)}
                {...rowDropHandlers(item)}
              >
                {jiraBrowseUrl ? (
                  <a href={`${jiraBrowseUrl}${item.jira_key}`} target="_blank" rel="noreferrer" draggable={false}>
                    {item.jira_key}
                  </a>
                ) : (
                  item.jira_key
                )}
                {item.is_activity && (
                  <span
                    style={{ fontSize: 10, display: 'block', color: activityPhaseInfo(item)?.color }}
                    title={`${activityPhaseInfo(item)?.label} activity: fuori dal code freeze, da fare entro la fase ${activityPhaseInfo(item)?.label}`}
                  >
                    {activityPhaseInfo(item)?.label}
                  </span>
                )}
              </div>
              {row === cutoffRow && <div className="gantt-forecast-cutoff" style={{ height: CUTOFF_BAND_HEIGHT }} />}
            </Fragment>
          ))}
        </div>

        <div
          className="gantt-timeline-col"
          ref={wrapRef}
          style={exporting ? { overflowX: 'visible' } : undefined}
          onScroll={() => {
            syncScroll(wrapRef, topScrollRef)
            mirrorHeaderScroll(wrapRef)
          }}
        >
          <div
            ref={contentRef}
            className={dragClassName}
            {...dragHandlers}
            // Nell'export le barre che iniziano prima del calendario si tagliano al bordo.
            style={{ width: chartWidth, position: 'relative', overflow: exporting ? 'hidden' : undefined }}
          >
            {/* Griglia (una linea per cella del calendario, weekend in grigio
                con lo zoom sui giorni): un solo strato sotto tutte le righe,
                invece di ripeterla in ognuna (con i giorni sarebbero migliaia
                di elementi). */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {scale.bottom.map((band) => (
                <div
                  key={band.day}
                  style={{
                    position: 'absolute',
                    left: dayToX(band.day),
                    width: band.width,
                    top: 0,
                    bottom: 0,
                    borderLeft: '1px solid #f0f0f0',
                    background: band.weekend ? COLOR_WEEKEND : undefined,
                  }}
                />
              ))}
              {nonWorkingDays.map((range) => {
                const from = Math.max(dateStrToEpochDays(range.start_date)!, minDay)
                const to = Math.min(dateStrToEpochDays(range.end_date)!, maxDay)
                if (to < from) return null
                return (
                  <div
                    key={range.id}
                    style={{
                      position: 'absolute',
                      left: dayToX(from),
                      width: (to - from + 1) * dayWidth,
                      top: 0,
                      bottom: 0,
                      background: NON_WORKING_FILL,
                    }}
                  />
                )
              })}
            </div>
            {shownItems.map((item, row) => {
              const pStart = dateStrToEpochDays(item.planned_start)
              const pEnd = dateStrToEpochDays(item.expected_finish)
              const aStart = dateStrToEpochDays(item.actual_start)
              const aEnd = dateStrToEpochDays(item.actual_finish)
              const labelAnchor = pStart ?? aStart
              const barEnd = barEndDay(item)
              const label = item.summary ?? item.jira_key
              const color = typeColor(item.issue_type)

              return (
                <Fragment key={item.id}>
                <div
                  className="gantt-timeline-row"
                  data-gantt-item={item.id}
                  style={{ height: ROW_HEIGHT, ...rowDragStyle(item), ...linkTargetStyle(item) }}
                  {...rowDropHandlers(item)}
                >
                  {marks
                    .filter((mark) => mark.line)
                    .map((mark) => (
                    <div
                      key={mark.day}
                      title={mark.label}
                      style={{
                        position: 'absolute',
                        left: lineX(mark.day) - 2,
                        top: 0,
                        bottom: 0,
                        borderLeft: `3px dashed ${mark.color}`,
                      }}
                    />
                  ))}

                  {/* Il contenitore copre le barre dell'item e il summary vi
                      resta agganciato scorrendo il Gantt: segue la barra fino
                      alla sua fine. Se e' piu' lungo della barra non si muove. */}
                  {/* Testi sopra le frecce dei predecessori, con un alone del
                      colore di sfondo (.gantt-label): le frecce passano sotto. */}
                  {labelAnchor !== null && (
                    <div
                      style={{
                        position: 'absolute',
                        // Nell'export una barra iniziata prima del calendario ha il
                        // titolo dal bordo sinistro, non tagliato.
                        left: Math.max(dayToX(labelAnchor), exporting ? 0 : -Infinity) + 2,
                        top: 2,
                        width:
                          barEnd === null
                            ? undefined
                            : Math.max(0, dayToX(barEnd) + dayWidth - Math.max(dayToX(labelAnchor), exporting ? 0 : -Infinity) - 2),
                        zIndex: 3,
                        pointerEvents: 'none',
                      }}
                    >
                      <div
                        className="muted gantt-label"
                        style={{
                          pointerEvents: 'auto',
                          position: 'sticky',
                          left: LABEL_STICKY_OFFSET,
                          width: 'max-content',
                          fontSize: 11,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          maxWidth: Math.max(0, chartWidth - dayToX(labelAnchor) - 6),
                        }}
                        title={label}
                      >
                        {label}
                      </div>
                    </div>
                  )}

                  {pStart !== null && pEnd !== null && isMilestone(item) && (() => {
                    const phaseName = milestonePhase?.(item) ?? null
                    const done = item.status === 'Done'
                    // Chiusa: sta sulla data effettiva, non si sposta piu'.
                    const movable = !phaseName && !done
                    const highlight = isLinkTarget(item)
                      ? `0 0 0 2px ${linkTargetColor}`
                      : previewById.has(item.id)
                        ? `0 0 0 2px ${COLOR_LINK_HOVER}`
                        : criticalPath?.critical.has(item.id)
                          ? `0 0 0 2px ${COLOR_CRITICAL}`
                          : undefined
                    return (
                      <div
                        title={
                          barDrag
                            ? undefined
                            : `Milestone${done ? ' chiusa' : ''}: ${formatEpochDaysAsDate(pEnd)}` +
                              (done
                                ? '\nData effettiva'
                                : phaseName
                                ? `\nData aggiornata della fase "${phaseName}": si cambia nelle Fasi increment della Dashboard`
                                : editable
                                  ? '\nTrascina per spostarla (o collegala a una fase nella Dashboard)'
                                  : '') +
                              (editable && movable && minStart?.(item)
                                ? `\nPredecessori: non prima del ${formatIsoDate(minStart(item))}`
                                : '')
                        }
                        {...(movable ? barHandlers(item, pStart, pEnd, 'move') : {})}
                        style={{
                          position: 'absolute',
                          left: lineX(pEnd) - MILESTONE_HALF,
                          top: PLANNED_BAR_TOP + BAR_HEIGHT / 2 - MILESTONE_HALF,
                          width: MILESTONE_HALF * 2,
                          height: MILESTONE_HALF * 2,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          zIndex: 2,
                          opacity: isDimmed(item) ? DIMMED_OPACITY : undefined,
                        }}
                      >
                        <div
                          style={{
                            width: 11,
                            height: 11,
                            transform: 'rotate(45deg)',
                            background: done ? COLOR_MILESTONE_DONE : COLOR_MILESTONE,
                            border: `1.5px solid ${done ? COLOR_MILESTONE_DONE_BORDER : COLOR_MILESTONE_BORDER}`,
                            borderRadius: 2,
                            boxShadow: highlight,
                          }}
                        />
                      </div>
                    )
                  })()}

                  {pStart !== null && pEnd !== null && !isMilestone(item) && (
                    <div
                      title={
                        barDrag
                          ? undefined
                          : `Agg.: ${formatEpochDaysAsDate(pStart)} → ${formatEpochDaysAsDate(pEnd)}` +
                            baselineNote(item) +
                            (criticalPath?.float.has(item.id)
                              ? criticalPath.critical.has(item.id)
                                ? '\nCritico: nessun margine, uno slittamento sposta la fine del progetto'
                                : `\nMargine: ${criticalPath.float.get(item.id)} gg lavorativi`
                              : '') +
                            (editable
                              ? '\nTrascina per spostare, i bordi per cambiare inizio o fine' +
                                (minStart?.(item)
                                  ? `\nPredecessori: non prima del ${formatIsoDate(minStart(item))}`
                                  : '')
                              : '')
                      }
                      {...barHandlers(item, pStart, pEnd)}
                      style={{
                        position: 'absolute',
                        left: dayToX(pStart),
                        width: Math.max(MIN_BAR_WIDTH, dayToX(pEnd) - dayToX(pStart) + dayWidth),
                        top: PLANNED_BAR_TOP,
                        height: BAR_HEIGHT,
                        background: item.is_activity ? activityFill(activityPhaseInfo(item)!.color) : plannedFill(color),
                        border: item.is_activity ? undefined : `1px solid ${color}`,
                        boxSizing: 'border-box',
                        borderRadius: 3,
                        // Sopra la linea di oggi, per poterla afferrare anche li'.
                        zIndex: editable ? 2 : undefined,
                        // Item spostati dal trascinamento: contorno tratteggiato.
                        outline: isLinkTarget(item)
                          ? `2px solid ${linkTargetColor}`
                          : previewById.has(item.id)
                          ? `2px dashed ${color}`
                          : criticalPath?.critical.has(item.id)
                            ? `2px solid ${COLOR_CRITICAL}`
                            : undefined,
                        outlineOffset: 1,
                        boxShadow: isLinkTarget(item) ? `0 0 0 5px ${linkTargetColor}33` : undefined,
                        opacity: isDimmed(item) ? DIMMED_OPACITY : undefined,
                      }}
                    />
                  )}

                  {/* Baseline: barra grigia sottile tra la pianificata e
                      l'effettiva, con le date originali. */}
                  {showBaseline &&
                    !isMilestone(item) &&
                    (() => {
                      const bStart = dateStrToEpochDays(item.baseline_start)
                      const bEnd = dateStrToEpochDays(item.baseline_finish)
                      if (bStart === null || bEnd === null) return null
                      return (
                        <div
                          title={baselineNote(item).trim()}
                          style={{
                            position: 'absolute',
                            left: dayToX(bStart),
                            width: Math.max(MIN_BAR_WIDTH, dayToX(bEnd) - dayToX(bStart) + dayWidth),
                            top: PLANNED_BAR_TOP + BAR_HEIGHT + 0.5,
                            height: 3,
                            borderRadius: 2,
                            background: COLOR_BASELINE,
                            opacity: isDimmed(item) ? DIMMED_OPACITY : undefined,
                          }}
                        />
                      )
                    })()}

                  {/* Date nuove sopra la barra trascinata, e quanti altri
                      item si spostano con lei. */}
                  {barDrag?.item.id === item.id && pStart !== null && pEnd !== null && (
                    <div
                      style={{
                        position: 'absolute',
                        left: dayToX(pStart),
                        top: 2,
                        zIndex: 3,
                        padding: '0 6px',
                        borderRadius: 3,
                        fontSize: 11,
                        fontWeight: 600,
                        lineHeight: '16px',
                        whiteSpace: 'nowrap',
                        background: 'var(--text)',
                        color: 'var(--surface)',
                        pointerEvents: 'none',
                      }}
                    >
                      {formatEpochDaysAsDate(pStart)} → {formatEpochDaysAsDate(pEnd)}
                      {barDrag.updates.length > 1 &&
                        ` · ${barDrag.updates.length - 1} ${barDrag.updates.length === 2 ? 'altro item si sposta' : 'altri item si spostano'}`}
                    </div>
                  )}

                  {aStart !== null && aEnd !== null && !isMilestone(item) && (
                    <div
                      title={`Eff.: ${formatEpochDaysAsDate(aStart)} → ${formatEpochDaysAsDate(aEnd)}`}
                      style={{
                        position: 'absolute',
                        left: dayToX(aStart),
                        width: Math.max(MIN_BAR_WIDTH, dayToX(aEnd) - dayToX(aStart) + dayWidth),
                        top: 22 + BAR_HEIGHT + 4,
                        height: BAR_HEIGHT,
                        background: item.is_activity ? activityFill(COLOR_ACTUAL) : color,
                        borderRadius: 3,
                        opacity: isDimmed(item) ? DIMMED_OPACITY : undefined,
                      }}
                    />
                  )}

                  {/* Pallino per collegare: trascinato su un altro PBI ne fa il
                      successore di questo (compare passando sulla riga). */}
                  {linkable && pStart !== null && pEnd !== null && !barDrag && (
                    <div
                      className={linkDrag?.from.id === item.id ? 'gantt-link-handle gantt-link-handle--active' : 'gantt-link-handle'}
                      title="Trascina su un altro PBI per farne il successore"
                      style={{ left: linkStartX(item, pEnd) + 3, top: PLANNED_BAR_TOP + BAR_HEIGHT / 2 - 6 }}
                      onPointerDown={(e) => startLinkDrag(e, item, row, pEnd)}
                      onPointerMove={moveLinkDrag}
                      onPointerUp={endLinkDrag}
                      onPointerCancel={() => setLinkDrag(null)}
                    />
                  )}

                  {/* Assegnatario a destra delle barre, trasparente al mouse per
                      non intralciare il trascinamento. */}
                  {item.assignee && barEnd !== null && (
                    <div
                      className="muted gantt-label"
                      style={{
                        position: 'absolute',
                        left: assigneeLabelLeft(item, barEnd),
                        top: 22,
                        zIndex: 3,
                        fontSize: 11,
                        lineHeight: `${BAR_HEIGHT}px`,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: Math.max(0, chartWidth - assigneeLabelLeft(item, barEnd) - 2),
                        pointerEvents: 'none',
                      }}
                    >
                      {item.assignee}
                    </div>
                  )}

                  {/* In Progress senza Fine eff.: l'inizio e' certo, la fine
                      no - barra fino a oggi (rossa per le attivita' di
                      servizio, del colore del tipo per le altre), sfumata in
                      coda per segnalare che non e' ancora conclusa. */}
                  {aStart !== null && aEnd === null && item.status === 'In Progress' && !isMilestone(item) && (
                    <div
                      title={`In corso dal ${formatEpochDaysAsDate(aStart)} (nessuna Fine eff. impostata)`}
                      style={{
                        position: 'absolute',
                        left: dayToX(aStart),
                        width: Math.max(MIN_BAR_WIDTH, dayToX(Math.max(aStart, todayDay)) - dayToX(aStart) + dayWidth),
                        top: 22 + BAR_HEIGHT + 4,
                        height: BAR_HEIGHT,
                        background: inProgressFill(item.is_activity ? COLOR_IN_PROGRESS : color),
                        borderRadius: 3,
                        opacity: isDimmed(item) ? DIMMED_OPACITY : undefined,
                      }}
                    />
                  )}
                </div>
                {/* Il testo resta agganciato a sinistra scorrendo il Gantt in
                    orizzontale. */}
                {row === cutoffRow && (
                  <div className="gantt-forecast-cutoff" style={{ height: CUTOFF_BAND_HEIGHT }}>
                    <span>{forecastCutoffLabel}</span>
                  </div>
                )}
                </Fragment>
              )
            })}
            {/* Linea di oggi su tutta l'altezza, sopra le barre (sempre
                visibile) ma trasparente al mouse. */}
            <div
              style={{
                position: 'absolute',
                left: lineX(todayDay) - 1,
                top: 0,
                bottom: 0,
                borderLeft: `2px solid ${COLOR_TODAY}`,
                pointerEvents: 'none',
                zIndex: 1,
              }}
            />
            {/* Sopra le righe ma trasparente al mouse: tooltip delle barre e
                trascinamento continuano a funzionare. */}
            {(allLinks.length > 0 || linkDrag) && (
              <svg
                width={chartWidth}
                height={rowTop(items.length)}
                style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
              >
                <defs>
                  {/* Punta di dimensione fissa (non scala con lo spessore della linea). */}
                  <marker
                    id="gantt-link-arrow"
                    markerUnits="userSpaceOnUse"
                    markerWidth="9"
                    markerHeight="10"
                    refX="8"
                    refY="5"
                    orient="auto"
                  >
                    <path d="M0,0.5 L8,5 L0,9.5 Z" fill={COLOR_LINK} stroke="white" strokeWidth="0.75" />
                  </marker>
                  <marker
                    id="gantt-link-arrow-critical"
                    markerUnits="userSpaceOnUse"
                    markerWidth="9"
                    markerHeight="10"
                    refX="8"
                    refY="5"
                    orient="auto"
                  >
                    <path d="M0,0.5 L8,5 L0,9.5 Z" fill={COLOR_CRITICAL} stroke="white" strokeWidth="0.75" />
                  </marker>
                  <marker
                    id="gantt-link-arrow-hover"
                    markerUnits="userSpaceOnUse"
                    markerWidth="9"
                    markerHeight="10"
                    refX="8"
                    refY="5"
                    orient="auto"
                  >
                    <path d="M0,0.5 L8,5 L0,9.5 Z" fill={COLOR_LINK_HOVER} stroke="white" strokeWidth="0.75" />
                  </marker>
                  <marker
                    id="gantt-link-arrow-valid"
                    markerUnits="userSpaceOnUse"
                    markerWidth="9"
                    markerHeight="10"
                    refX="8"
                    refY="5"
                    orient="auto"
                  >
                    <path d="M0,0.5 L8,5 L0,9.5 Z" fill={COLOR_LINK_VALID} stroke="white" strokeWidth="0.75" />
                  </marker>
                </defs>
                {allLinks.map((link) => {
                  const hovered = hoveredLinkId === link.id
                  const removable = !!onRemovePredecessor && !exporting && link.from && link.to
                  return (
                    <g key={link.id} opacity={criticalPath && !link.critical && !hovered ? DIMMED_OPACITY : undefined}>
                      {/* Alone bianco: la linea resta leggibile sopra griglia, testi e barre. */}
                      <path
                        d={link.path}
                        fill="none"
                        stroke="white"
                        strokeWidth={(link.critical ? 2.5 : 2) + 3}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        opacity={0.85}
                      />
                      <path
                        d={link.path}
                        fill="none"
                        stroke={hovered ? COLOR_LINK_HOVER : link.critical ? COLOR_CRITICAL : COLOR_LINK}
                        strokeWidth={(link.critical ? 2.5 : 2) + (hovered ? 1 : 0)}
                        strokeDasharray={link.implicit ? '5 3' : undefined}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        markerEnd={
                          hovered
                            ? 'url(#gantt-link-arrow-hover)'
                            : link.critical
                              ? 'url(#gantt-link-arrow-critical)'
                              : 'url(#gantt-link-arrow)'
                        }
                      />
                      {/* Fascia invisibile piu' larga della linea: si prende col
                          mouse; clic = menu per togliere il collegamento. */}
                      <path
                        d={link.path}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                        style={{ pointerEvents: removable ? 'stroke' : 'none', cursor: removable ? 'pointer' : undefined }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onMouseEnter={() => setHoveredLinkId(link.id)}
                        onMouseLeave={() => setHoveredLinkId((id) => (id === link.id ? null : id))}
                        onClick={(e) => {
                          const rect = contentRef.current!.getBoundingClientRect()
                          setLinkMenu({ from: link.from!, to: link.to!, x: e.clientX - rect.left, y: e.clientY - rect.top })
                        }}
                      >
                        <title>{removable ? `${link.title}\nClic per rimuovere il collegamento` : link.title}</title>
                      </path>
                    </g>
                  )
                })}
                {linkPreview && (
                  <>
                    <path
                      d={linkPreview.path}
                      fill="none"
                      stroke="white"
                      strokeWidth={5}
                      strokeLinejoin="round"
                      opacity={0.85}
                    />
                    <path
                      d={linkPreview.path}
                      fill="none"
                      stroke={linkPreview.anchor ? linkTargetColor : COLOR_LINK_HOVER}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      // Tratteggiata finche' non e' agganciata (o se non si puo').
                      strokeDasharray={linkPreview.anchor && !linkDrag?.reason ? undefined : '6 4'}
                      markerEnd={
                        linkDrag?.reason
                          ? undefined
                          : linkPreview.anchor
                            ? 'url(#gantt-link-arrow-valid)'
                            : 'url(#gantt-link-arrow-hover)'
                      }
                    />
                    {linkPreview.anchor && (
                      <circle
                        cx={linkPreview.anchor.x}
                        cy={linkPreview.anchor.y}
                        r={5}
                        fill={linkTargetColor}
                        stroke="white"
                        strokeWidth={2}
                      />
                    )}
                  </>
                )}
              </svg>
            )}
            {linkDrag?.target && (
              <div
                className={linkDrag.reason ? 'gantt-link-hint gantt-link-hint--error' : 'gantt-link-hint'}
                style={{ left: linkDrag.x + 14, top: linkDrag.y + 14 }}
              >
                {linkDrag.reason ?? `${linkDrag.from.jira_key} → ${linkDrag.target.jira_key}`}
              </div>
            )}
            {linkMenu && (
              <div
                className="gantt-link-menu"
                style={{ left: linkMenu.x, top: linkMenu.y + 8 }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="gantt-link-menu-title">
                  {linkMenu.from.jira_key} → {linkMenu.to.jira_key}
                </div>
                <button
                  type="button"
                  className="gantt-link-menu-item"
                  onClick={() => {
                    onRemovePredecessor!(linkMenu.from, linkMenu.to)
                    setLinkMenu(null)
                  }}
                >
                  Rimuovi collegamento
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
