import { Fragment, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { toPng } from 'html-to-image'
import type { BacklogItem } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, toEpochDays } from '../lib/dates'
import { parsePredecessors } from '../lib/scheduling'

// Stessa coppia di colori usata per Budget/Actual in IncrementHistoryCard:
// blu = valore pianificato, arancio = valore effettivo.
const COLOR_PLANNED = '#2f6fed'
const COLOR_ACTUAL = '#eb6834'
// Stesso rosso di --danger: item "In Progress" con Start eff. ma senza
// ancora una Fine eff. - l'inizio e' certo, la fine no (vedi barra
// sfumata sotto).
const COLOR_IN_PROGRESS = '#d3402f'
// Attivita' di servizio (fuori dal code freeze): barre a righe oblique,
// stesso colore ma riconoscibili anche senza distinguere le tinte.
const activityFill = (color: string) =>
  `repeating-linear-gradient(135deg, ${color} 0 4px, color-mix(in srgb, ${color} 35%, white) 4px 8px)`

const LABEL_COLUMN_WIDTH = 110
// Barre di un giorno ancora visibili con lo zoom al minimo.
const MIN_BAR_WIDTH = 3
const ROW_HEIGHT = 60
const BAR_HEIGHT = 14
// Distanza della barra "Pianificato" dal bordo superiore della riga.
const PLANNED_BAR_TOP = 22
// Frecce predecessore -> successore.
const COLOR_LINK = '#5b6472'
const LINK_STUB = 8
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
const COLOR_PHASE = '#7c4dbd'
// Sabato e domenica con lo zoom sui giorni.
const COLOR_WEEKEND = 'color-mix(in srgb, var(--border) 30%, transparent)'
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
// Lato massimo dell'immagine esportata: oltre, i browser rifiutano il canvas.
const EXPORT_MAX_SIDE = 16000

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

// Le due righe del calendario secondo lo zoom: sopra il contesto (mesi o
// anni), sotto il dettaglio (giorni, settimane, mesi o trimestri), con
// etichette scelte per stare nella larghezza delle celle.
function buildScale(minDay: number, maxDay: number, dayWidth: number) {
  const monthLabel = (start: number) => {
    const d = epochDaysToDate(start)
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  }
  const yearLabel = (start: number) => String(epochDaysToDate(start).getUTCFullYear())
  if (dayWidth >= 32) {
    return {
      name: 'Giorni',
      top: buildBands(minDay, maxDay, 'month', dayWidth, monthLabel),
      bottom: buildBands(minDay, maxDay, 'day', dayWidth, (d) => `${WEEKDAY_NAMES[epochDaysToDate(d).getUTCDay()]} ${epochDaysToDate(d).getUTCDate()}`),
    }
  }
  if (dayWidth >= 5) {
    const withDate = dayWidth >= 12
    return {
      name: 'Settimane',
      top: buildBands(minDay, maxDay, 'month', dayWidth, monthLabel),
      bottom: buildBands(minDay, maxDay, 'week', dayWidth, (d) =>
        withDate ? `S${isoWeekNumber(epochDaysToDate(d))} · ${formatEpochDaysAsDate(d).slice(0, 5)}` : `S${isoWeekNumber(epochDaysToDate(d))}`,
      ),
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
  phases?: { name: string; date: string | null }[]
  // Prefisso del nome del PNG esportato (es. "Gantt_PTBSYS-123"), seguito
  // dalla data dell'export.
  exportName?: string
}

const NO_PHASES: { name: string; date: string | null }[] = []

export function BacklogGanttChart({
  items,
  jiraBrowseUrl,
  forecastCutoffId = null,
  forecastCutoffLabel,
  codeFreezeDate = null,
  phases = NO_PHASES,
  exportName = 'Gantt',
}: Props) {
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

  // Esporta PNG: per catturare tutto il Gantt e non solo la parte visibile,
  // durante l'export il componente si allarga all'intero calendario (niente
  // scroll orizzontale ne' intestazione agganciata), poi torna com'era.
  const rootRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)
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
  const markDays = [...namesByDay.keys()].sort((a, b) => a - b)
  const rangeDays = [...allDays, todayDay, ...markDays]
  const minDay = Math.min(...rangeDays) - 2
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
  const maxDay = Math.max(rangeMaxDay, ...labelEndDays)

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
  const scale = buildScale(minDay, maxDay, dayWidth)

  // Etichetta (nomi e data, sempre visibili) a destra della linea, o a
  // sinistra dove a fine calendario non ci starebbe; se toccherebbe quella
  // prima va sulla riga sotto. "Today" e' centrata sulla sua linea e
  // partecipa allo stesso calcolo, cosi' non si sovrappone a Code Freeze e
  // fasi vicine.
  const todayLabelWidth = markTextWidth(TODAY_LABEL, 700) + 8
  // Dentro il calendario anche quando oggi e' vicino a un suo bordo.
  const todayLabelStart = Math.min(Math.max(0, dayToX(todayDay) - todayLabelWidth / 2), chartWidth - todayLabelWidth)
  const todaySlot = { start: todayLabelStart, width: todayLabelWidth, lane: 0 }
  const marks = markDays.map((day) => {
    const label = `${namesByDay.get(day)!.join(' · ')} ${formatEpochDaysAsDate(day)}`
    const width = markTextWidth(label, 600)
    const alignRight = dayToX(day) + 6 + width > chartWidth
    return {
      day,
      label,
      start: alignRight ? dayToX(day) - 3 - width : dayToX(day) + 6,
      width,
      lane: 0,
      color: day === codeFreezeDay ? 'var(--success)' : COLOR_PHASE,
      position: alignRight ? { right: chartWidth - dayToX(day) + 3 } : { left: dayToX(day) + 6 },
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
  const links = items.flatMap((successor, successorRow) => {
    const sStart = dateStrToEpochDays(successor.planned_start)
    if (sStart === null || dateStrToEpochDays(successor.expected_finish) === null) return []
    return parsePredecessors(successor.predecessors).flatMap((key) => {
      const predecessorRow = rowByKey.get(key)
      if (predecessorRow === undefined || predecessorRow === successorRow) return []
      const predecessor = items[predecessorRow]
      const pStart = dateStrToEpochDays(predecessor.planned_start)
      const pEnd = dateStrToEpochDays(predecessor.expected_finish)
      if (pStart === null || pEnd === null) return []
      const x1 = dayToX(Math.max(pStart, pEnd)) + dayWidth
      const y1 = barCenterY(predecessorRow)
      const x2 = dayToX(sStart)
      const y2 = barCenterY(successorRow)
      // Con spazio tra le due barre basta un gomito; altrimenti (successore
      // che parte subito sotto la fine del predecessore, il caso normale) la
      // linea rientra a sinistra passando tra le righe, per arrivare alla
      // barra da sinistra.
      const below = successorRow > predecessorRow
      const yGap = below ? y2 - BAR_HEIGHT / 2 - 3 : rowTop(successorRow) + ROW_HEIGHT
      const path =
        x2 >= x1 + 2 * LINK_STUB
          ? `M${x1},${y1} H${x1 + LINK_STUB} V${y2} H${x2}`
          : `M${x1},${y1} H${x1 + LINK_STUB} V${yGap} H${x2 - LINK_STUB} V${y2} H${x2}`
      return [{ id: `${predecessor.id}-${successor.id}`, path, title: `${predecessor.jira_key} → ${successor.jira_key}` }]
    })
  })

  return (
    <div
      ref={rootRef}
      style={exporting ? { width: LABEL_COLUMN_WIDTH + chartWidth + 2, background: 'var(--surface)' } : undefined}
    >
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: COLOR_PLANNED, display: 'inline-block' }} />
          Pianificato
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: COLOR_ACTUAL, display: 'inline-block' }} />
          Effettivo
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 3,
              background: `linear-gradient(to right, ${COLOR_IN_PROGRESS} 0%, ${COLOR_IN_PROGRESS} 55%, transparent 100%)`,
              display: 'inline-block',
            }}
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
        {items.some((item) => item.is_activity) && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{ width: 12, height: 12, borderRadius: 3, background: activityFill(COLOR_PLANNED), display: 'inline-block' }}
            />
            Attività di servizio (fuori code freeze)
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
        <span className="gantt-no-export" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
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
          <button className="btn" disabled={exporting} onClick={exportPng} title="Scarica tutto il Gantt come immagine PNG">
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
                height: HEADER_HEIGHT + laneEnds.length * MARK_ROW_HEIGHT,
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
              {marks.map((mark) => (
                <div
                  key={mark.day}
                  title={mark.label}
                  style={{
                    position: 'absolute',
                    top: HEADER_HEIGHT + mark.lane * MARK_ROW_HEIGHT,
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
                  left: dayToX(todayDay) - 1,
                  top: HEADER_HEIGHT + todaySlot.lane * MARK_ROW_HEIGHT + MARK_ROW_HEIGHT - 2,
                  bottom: 0,
                  borderLeft: `2px solid ${COLOR_TODAY}`,
                }}
              />
              <div
                title={`Today ${formatEpochDaysAsDate(todayDay)}`}
                style={{
                  position: 'absolute',
                  top: HEADER_HEIGHT + todaySlot.lane * MARK_ROW_HEIGHT + 1,
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
              <div className="gantt-label-row" style={{ height: ROW_HEIGHT }}>
                {jiraBrowseUrl ? (
                  <a href={`${jiraBrowseUrl}${item.jira_key}`} target="_blank" rel="noreferrer">
                    {item.jira_key}
                  </a>
                ) : (
                  item.jira_key
                )}
                {item.is_activity && (
                  <span className="muted" style={{ fontSize: 10, display: 'block' }} title="Attività di servizio: fuori dal code freeze">
                    Attività
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
          <div className={dragClassName} {...dragHandlers} style={{ width: chartWidth, position: 'relative' }}>
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
            </div>
            {items.map((item, row) => {
              const pStart = dateStrToEpochDays(item.planned_start)
              const pEnd = dateStrToEpochDays(item.expected_finish)
              const aStart = dateStrToEpochDays(item.actual_start)
              const aEnd = dateStrToEpochDays(item.actual_finish)
              const labelAnchor = pStart ?? aStart
              const label = item.summary ?? item.jira_key

              return (
                <Fragment key={item.id}>
                <div className="gantt-timeline-row" style={{ height: ROW_HEIGHT }}>
                  {marks.map((mark) => (
                    <div
                      key={mark.day}
                      title={mark.label}
                      style={{
                        position: 'absolute',
                        left: dayToX(mark.day),
                        top: 0,
                        bottom: 0,
                        borderLeft: `3px dashed ${mark.color}`,
                      }}
                    />
                  ))}

                  {labelAnchor !== null && (
                    <div
                      className="muted"
                      style={{
                        position: 'absolute',
                        left: dayToX(labelAnchor) + 2,
                        top: 2,
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
                  )}

                  {pStart !== null && pEnd !== null && (
                    <div
                      title={`Pian.: ${formatEpochDaysAsDate(pStart)} → ${formatEpochDaysAsDate(pEnd)}`}
                      style={{
                        position: 'absolute',
                        left: dayToX(pStart),
                        width: Math.max(MIN_BAR_WIDTH, dayToX(pEnd) - dayToX(pStart) + dayWidth),
                        top: PLANNED_BAR_TOP,
                        height: BAR_HEIGHT,
                        background: item.is_activity ? activityFill(COLOR_PLANNED) : COLOR_PLANNED,
                        borderRadius: 3,
                      }}
                    />
                  )}

                  {aStart !== null && aEnd !== null && (
                    <div
                      title={`Eff.: ${formatEpochDaysAsDate(aStart)} → ${formatEpochDaysAsDate(aEnd)}`}
                      style={{
                        position: 'absolute',
                        left: dayToX(aStart),
                        width: Math.max(MIN_BAR_WIDTH, dayToX(aEnd) - dayToX(aStart) + dayWidth),
                        top: 22 + BAR_HEIGHT + 4,
                        height: BAR_HEIGHT,
                        background: item.is_activity ? activityFill(COLOR_ACTUAL) : COLOR_ACTUAL,
                        borderRadius: 3,
                      }}
                    />
                  )}

                  {/* In Progress senza Fine eff.: l'inizio e' certo, la fine
                      no - barra rossa fino a oggi, sfumata in coda per
                      segnalare che non e' ancora conclusa. */}
                  {aStart !== null && aEnd === null && item.status === 'In Progress' && (
                    <div
                      title={`In corso dal ${formatEpochDaysAsDate(aStart)} (nessuna Fine eff. impostata)`}
                      style={{
                        position: 'absolute',
                        left: dayToX(aStart),
                        width: Math.max(MIN_BAR_WIDTH, dayToX(Math.max(aStart, todayDay)) - dayToX(aStart) + dayWidth),
                        top: 22 + BAR_HEIGHT + 4,
                        height: BAR_HEIGHT,
                        background: `linear-gradient(to right, ${COLOR_IN_PROGRESS} 0%, ${COLOR_IN_PROGRESS} 70%, transparent 100%)`,
                        borderRadius: 3,
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
                left: dayToX(todayDay) - 1,
                top: 0,
                bottom: 0,
                borderLeft: `2px solid ${COLOR_TODAY}`,
                pointerEvents: 'none',
                zIndex: 1,
              }}
            />
            {/* Sopra le righe ma trasparente al mouse: tooltip delle barre e
                trascinamento continuano a funzionare. */}
            {links.length > 0 && (
              <svg
                width={chartWidth}
                height={rowTop(items.length)}
                style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
              >
                <defs>
                  <marker id="gantt-link-arrow" markerWidth="7" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0,0 L7,4 L0,8 Z" fill={COLOR_LINK} />
                  </marker>
                </defs>
                {links.map((link) => (
                  <path
                    key={link.id}
                    d={link.path}
                    fill="none"
                    stroke={COLOR_LINK}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    markerEnd="url(#gantt-link-arrow)"
                  >
                    <title>{link.title}</title>
                  </path>
                ))}
              </svg>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
