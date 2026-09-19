import { useRef, type RefObject } from 'react'
import type { BacklogItem } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, toEpochDays } from '../lib/dates'

// Stessa coppia di colori usata per Budget/Actual in IncrementHistoryCard:
// blu = valore pianificato, arancio = valore effettivo.
const COLOR_PLANNED = '#2f6fed'
const COLOR_ACTUAL = '#eb6834'
// Stesso rosso di --danger: item "In Progress" con Start eff. ma senza
// ancora una Fine eff. - l'inizio e' certo, la fine no (vedi barra
// sfumata sotto).
const COLOR_IN_PROGRESS = '#d3402f'

const DAY_WIDTH = 22
const LABEL_COLUMN_WIDTH = 110
const ROW_HEIGHT = 60
const BAR_HEIGHT = 14
const MONTH_BAND_HEIGHT = 18
const WEEK_ROW_HEIGHT = 20
const HEADER_HEIGHT = MONTH_BAND_HEIGHT + WEEK_ROW_HEIGHT

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
}

export function BacklogGanttChart({ items, jiraBrowseUrl }: Props) {
  // Tre elementi da tenere sincronizzati in orizzontale: il calendario in
  // alto, la barra "specchio" sopra la tabella e lo scroll vero (sulle
  // righe). Calendario e specchio sono fuori dall'area con scroll
  // verticale (.gantt-outer), quindi restano sempre visibili scorrendo in
  // basso - se il calendario fosse dentro l'elemento con overflow-x:auto,
  // il browser forza anche il suo overflow-y a diventare "auto" (regola
  // dell'overflow CSS quando un solo asse e' 'visible'), rompendo la
  // costrizione verticale del contenitore esterno: e' esattamente il bug
  // per cui il calendario spariva scorrendo in basso.
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

  const allDays: number[] = []
  for (const item of items) {
    for (const field of [item.planned_start, item.expected_finish, item.actual_start, item.actual_finish]) {
      const day = dateStrToEpochDays(field)
      if (day !== null) allDays.push(day)
    }
  }

  if (allDays.length === 0) {
    return (
      <p className="muted">
        Nessun item ha una data (pianificata o effettiva) impostata: aggiungile nelle colonne Start/Fine per vederle
        sul Gantt.
      </p>
    )
  }

  // "Oggi" entra sempre nel range (serve anche da fine provvisoria per la
  // barra degli item In Progress ancora senza Fine eff., vedi sotto), cosi'
  // resta sempre visibile invece di sparire quando tutte le date degli item
  // sono lontane da adesso.
  const todayDay = toEpochDays(new Date())
  const minDay = Math.min(...allDays, todayDay) - 2
  const maxDay = Math.max(...allDays, todayDay) + 2
  const chartWidth = (maxDay - minDay + 1) * DAY_WIDTH
  const dayToX = (day: number) => (day - minDay) * DAY_WIDTH
  const ticks = buildWeekTicks(minDay, maxDay)
  const monthBands = buildMonthBands(minDay, maxDay)

  return (
    <div>
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
          <span style={{ width: 0, height: 12, borderLeft: '1px dashed var(--danger)', display: 'inline-block' }} />
          Oggi
        </span>
      </div>

      {/* Calendario: fuori da .gantt-outer (vedi commento sopra), scroll
          orizzontale solo via JS (nessuna scrollbar propria, overflow
          hidden) in modo da restare sempre visibile scorrendo in basso. */}
      <div style={{ display: 'flex' }}>
        <div style={{ width: LABEL_COLUMN_WIDTH, flexShrink: 0 }} />
        <div ref={headerScrollRef} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <div style={{ width: chartWidth, height: HEADER_HEIGHT, position: 'relative' }}>
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
          </div>
        </div>
      </div>

      {/* Spacer della stessa larghezza della colonna ID, cosi' la barra
          "specchio" sotto si allinea esattamente sopra la timeline vera. */}
      <div style={{ display: 'flex' }}>
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
      {/* Colonna ID: fuori dall'area di scroll orizzontale (gantt-timeline-col
          sotto), resta quindi sempre visibile scorrendo a destra. Scorre in
          verticale insieme alla timeline perche' entrambe vivono dentro lo
          stesso .gantt-outer con overflow-y unico. */}
      <div className="gantt-outer">
        <div className="gantt-labels-col" style={{ width: LABEL_COLUMN_WIDTH }}>
          {items.map((item) => (
            <div key={item.id} className="gantt-label-row" style={{ height: ROW_HEIGHT }}>
              {jiraBrowseUrl ? (
                <a href={`${jiraBrowseUrl}${item.jira_key}`} target="_blank" rel="noreferrer">
                  {item.jira_key}
                </a>
              ) : (
                item.jira_key
              )}
            </div>
          ))}
        </div>

        <div
          className="gantt-timeline-col"
          ref={wrapRef}
          onScroll={() => {
            syncScroll(wrapRef, topScrollRef)
            mirrorHeaderScroll(wrapRef)
          }}
        >
          <div style={{ width: chartWidth }}>
            {items.map((item) => {
              const pStart = dateStrToEpochDays(item.planned_start)
              const pEnd = dateStrToEpochDays(item.expected_finish)
              const aStart = dateStrToEpochDays(item.actual_start)
              const aEnd = dateStrToEpochDays(item.actual_finish)
              const labelAnchor = pStart ?? aStart
              const label = item.summary ?? item.jira_key

              return (
                <div key={item.id} className="gantt-timeline-row" style={{ height: ROW_HEIGHT }}>
                  {ticks.map((t) => (
                    <div
                      key={t.day}
                      style={{ position: 'absolute', left: dayToX(t.day), top: 0, bottom: 0, borderLeft: '1px solid #f0f0f0' }}
                    />
                  ))}
                  {todayDay >= minDay && todayDay <= maxDay && (
                    <div
                      style={{
                        position: 'absolute',
                        left: dayToX(todayDay),
                        top: 0,
                        bottom: 0,
                        borderLeft: '1px dashed var(--danger)',
                      }}
                    />
                  )}

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
                        top: 22,
                        height: BAR_HEIGHT,
                        background: COLOR_PLANNED,
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
                        background: COLOR_ACTUAL,
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
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
