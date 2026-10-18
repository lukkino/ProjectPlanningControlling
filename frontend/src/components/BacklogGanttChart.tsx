import { Fragment, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
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

const DAY_WIDTH = 22
const LABEL_COLUMN_WIDTH = 110
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

type Tick = { day: number; label: string }
type MonthBand = { day: number; width: number; label: string }

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

// Un tick per ogni lunedi' nel range, sempre (a qualunque estensione del
// Gantt - tanto si scorre in orizzontale), con numero di settimana ISO e
// data, per il massimo dettaglio richiesto.
function buildWeekTicks(minDay: number, maxDay: number): Tick[] {
  const ticks: Tick[] = []
  const startDate = epochDaysToDate(minDay)
  const dow = startDate.getUTCDay() // 0=domenica..6=sabato
  const offsetToMonday = dow === 0 ? 1 : (8 - dow) % 7
  for (let day = minDay + offsetToMonday; day <= maxDay; day += 7) {
    const label = `S${isoWeekNumber(epochDaysToDate(day))} · ${formatEpochDaysAsDate(day).slice(0, 5)}`
    ticks.push({ day, label })
  }
  return ticks
}

// Una fascia per ogni mese coperto dal range, per dare contesto sopra le
// settimane (prima e ultima fascia troncate a minDay/maxDay se il mese e'
// solo parzialmente coperto).
function buildMonthBands(minDay: number, maxDay: number): MonthBand[] {
  const bands: MonthBand[] = []
  const startDate = epochDaysToDate(minDay)
  let monthStart = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1))
  let bandStartDay = minDay
  while (toEpochDays(monthStart) <= maxDay) {
    const nextMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1))
    const bandEndDay = Math.min(toEpochDays(nextMonthStart) - 1, maxDay)
    bands.push({
      day: bandStartDay,
      width: (bandEndDay - bandStartDay + 1) * DAY_WIDTH,
      label: `${MONTH_NAMES[monthStart.getUTCMonth()]} ${monthStart.getUTCFullYear()}`,
    })
    bandStartDay = toEpochDays(nextMonthStart)
    monthStart = nextMonthStart
  }
  return bands
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
  // Il summary parte dall'inizio della barra e puo' essere piu' lungo di
  // quanto resta fino all'ultima data: il calendario si allunga dei giorni
  // che servono a leggerlo per intero.
  const labelEndDays = items.map((item) => {
    const anchor = dateStrToEpochDays(item.planned_start) ?? dateStrToEpochDays(item.actual_start)
    if (anchor === null) return 0
    return anchor + Math.ceil(((item.summary ?? item.jira_key).length * LABEL_CHAR_WIDTH + 8) / DAY_WIDTH)
  })
  const maxDay = Math.max(Math.max(...rangeDays) + 2, ...labelEndDays)

  // All'apertura del Gantt la vista e' centrata su oggi, invece di partire
  // dal primo giorno del range. Solo la prima volta che c'e' qualcosa da
  // mostrare: dopo, lo scroll resta dove l'ha lasciato l'utente (calendario
  // e barra "specchio" seguono da soli, via onScroll).
  const hasDates = allDays.length > 0
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    wrap.scrollLeft = (todayDay - minDay + 0.5) * DAY_WIDTH - wrap.clientWidth / 2
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDates])

  if (!hasDates) {
    return (
      <p className="muted">
        Nessun item ha una data (pianificata o effettiva) impostata: aggiungile nelle colonne Start/Fine per vederle
        sul Gantt.
      </p>
    )
  }

  const chartWidth = (maxDay - minDay + 1) * DAY_WIDTH
  const dayToX = (day: number) => (day - minDay) * DAY_WIDTH
  const ticks = buildWeekTicks(minDay, maxDay)
  const monthBands = buildMonthBands(minDay, maxDay)

  // Etichetta (nomi e data, sempre visibili) a destra della linea, o a
  // sinistra dove a fine calendario non ci starebbe; se toccherebbe quella
  // prima va sulla riga sotto. "Today" e' centrata sulla sua linea e
  // partecipa allo stesso calcolo, cosi' non si sovrappone a Code Freeze e
  // fasi vicine.
  const todayLabelWidth = markTextWidth(TODAY_LABEL, 700) + 8
  const todaySlot = { start: dayToX(todayDay) - todayLabelWidth / 2, width: todayLabelWidth, lane: 0 }
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
      const x1 = dayToX(Math.max(pStart, pEnd)) + DAY_WIDTH
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
                {monthBands.map((band) => (
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
                {ticks.map((t) => (
                  <div
                    key={t.day}
                    className="muted"
                    style={{
                      position: 'absolute',
                      left: dayToX(t.day) + 3,
                      top: 4,
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                      borderLeft: '1px solid var(--border)',
                      paddingLeft: 3,
                    }}
                  >
                    {t.label}
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
                  {ticks.map((t) => (
                    <div
                      key={t.day}
                      style={{ position: 'absolute', left: dayToX(t.day), top: 0, bottom: 0, borderLeft: '1px solid #f0f0f0' }}
                    />
                  ))}
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
                        maxWidth: Math.max(60, chartWidth - dayToX(labelAnchor) - 6),
                      }}
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
                        width: Math.max(DAY_WIDTH, dayToX(pEnd) - dayToX(pStart) + DAY_WIDTH),
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
                        width: Math.max(DAY_WIDTH, dayToX(aEnd) - dayToX(aStart) + DAY_WIDTH),
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
                        width: Math.max(DAY_WIDTH, dayToX(Math.max(aStart, todayDay)) - dayToX(aStart) + DAY_WIDTH),
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
