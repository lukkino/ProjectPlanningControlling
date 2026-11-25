import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { EarnedValue, EarnedValueItem } from '../api/types'
import { dateStrToEpochDays, formatEpochDaysAsDate, formatIsoDate } from '../lib/dates'
import { evTone, formatHours, formatIndex, formatPct, formatSignedHours } from '../lib/earnedValue'

const COLOR_PV = '#8a94a3'
const COLOR_EV = '#1a9c5c'
const COLOR_TODAY = '#d3402f'

const EV_HELP =
  'Earned Value, in ore, sui PBI del piano (in scope, code freeze o attività per Release; milestone escluse).\n\n' +
  '• Budget di un PBI: stima dev + stima test; se mancano, Sizing (gg) × 8 h.\n' +
  '• % completamento: Done = 100%, altrimenti 0%. Solo tempi: le ore loggate su Jira non entrano nel calcolo.\n' +
  '• PV (valore pianificato): il budget distribuito sui giorni lavorativi della baseline (senza baseline, delle date aggiornate).\n' +
  '• EV (valore guadagnato): il budget dei PBI Done, guadagnato il giorno della Fine effettiva.\n\n' +
  'SPI = EV / PV (rispetto dei tempi): sotto 1 si è in ritardo. Verde da 0,95, giallo da 0,85, rosso sotto.\n' +
  'Fine prevista: la durata del piano divisa per l\'SPI sul tempo (Earned Schedule).'

function useEarnedValue(projectId: number) {
  return useQuery({ queryKey: ['earned-value', projectId], queryFn: () => api.dashboard.earnedValue(projectId) })
}

function Kpi({ value, label, tone, note }: { value: string; label: string; tone?: string; note?: string }) {
  return (
    <div className="stat">
      <span className={`value ev-${tone || 'none'}`}>{value}</span>
      <span className="label">{label}</span>
      {note && <span className="muted" style={{ fontSize: 12 }}>{note}</span>}
    </div>
  )
}

function delayNote(ev: EarnedValue): string | undefined {
  if (ev.schedule_delay_days === null) return undefined
  const days = Math.round(ev.schedule_delay_days)
  if (days === 0) return 'in linea col piano'
  return `${Math.abs(days)} gg lav. ${days > 0 ? 'di ritardo' : 'di anticipo'}`
}

// Indicatori principali della sezione Earned Value (Dashboard).
function KpiRow({ ev }: { ev: EarnedValue }) {
  return (
    <div className="grid-4 ev-kpis">
      <Kpi value={formatIndex(ev.spi)} label="SPI (tempi)" tone={evTone(ev.spi)} note={delayNote(ev)} />
      <Kpi
        value={formatIsoDate(ev.forecast_finish) ?? '—'}
        label="Fine prevista"
        tone={
          ev.forecast_finish && ev.plan_finish ? (ev.forecast_finish > ev.plan_finish ? 'bad' : 'good') : undefined
        }
        note={
          ev.forecast_finish
            ? `piano: ${formatIsoDate(ev.plan_finish)}`
            : ev.ev > 0
              ? 'non ancora significativa (valore guadagnato < 10%)'
              : 'nessun valore guadagnato'
        }
      />
      <Kpi
        value={formatPct(ev.bac ? ev.ev / ev.bac : null)}
        label="Completamento guadagnato"
        note={`pianificato a oggi ${formatPct(ev.bac ? ev.pv / ev.bac : null)}`}
      />
      <Kpi value={formatHours(ev.bac)} label="Budget dei PBI" note={`guadagnato ${formatHours(ev.ev)}`} />
    </div>
  )
}

function Warnings({ ev }: { ev: EarnedValue }) {
  const notes: string[] = []
  if (!ev.has_baseline)
    notes.push('Baseline non fissata: il PV usa le date aggiornate (pulsante "Fissa baseline" nel Backlog).')
  if (ev.items_without_budget > 0)
    notes.push(
      `${ev.items_without_budget} PBI senza stima né Sizing: fuori dal calcolo.`,
    )
  if (ev.items_without_plan > 0) notes.push(`${ev.items_without_plan} PBI senza date: non entrano nel PV.`)
  if (notes.length === 0) return null
  return (
    <ul className="ev-warnings">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}

type SortKey = 'sv' | 'completion' | 'budget'

// Dettaglio per PBI nascosto o visibile: preferenza del browser, uguale per
// tutti gli increment.
const PBI_DETAIL_STORAGE_KEY = 'ev-pbi-detail-hidden'

function readDetailHidden(): boolean {
  try {
    return localStorage.getItem(PBI_DETAIL_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function EarnedValueSection({ projectId }: { projectId: number }) {
  const { data: ev, isLoading, isError } = useEarnedValue(projectId)
  const [sort, setSort] = useState<SortKey>('sv')
  const [detailHidden, setDetailHidden] = useState(readDetailHidden)
  const toggleDetail = () => {
    const next = !detailHidden
    setDetailHidden(next)
    try {
      localStorage.setItem(PBI_DETAIL_STORAGE_KEY, next ? '1' : '0')
    } catch {
      // localStorage non disponibile: la scelta vale solo per questa visita
    }
  }

  const chartData = useMemo(
    () =>
      (ev?.curve ?? []).map((p) => ({
        x: dateStrToEpochDays(p.day),
        pv: Math.round(p.pv),
        ev: p.ev === null ? null : Math.round(p.ev),
      })),
    [ev],
  )

  const rows = useMemo(() => {
    const items = (ev?.items ?? []).filter((i) => i.budget !== null)
    const value = (i: EarnedValueItem): number => {
      if (sort === 'sv') return i.sv
      if (sort === 'completion') return i.completion ?? 0
      return -(i.budget ?? 0)
    }
    return [...items].sort((a, b) => value(a) - value(b))
  }, [ev, sort])

  if (isLoading) return <div className="card muted">Calcolo Earned Value…</div>
  if (isError || !ev) return <div className="card muted">Earned Value non disponibile.</div>

  const todayX = dateStrToEpochDays(ev.today)
  const sortHeader = (key: SortKey, label: string, title?: string) => (
    <th
      className={`ev-sortable${sort === key ? ' active' : ''}`}
      title={title ? `${title} (clic per ordinare)` : 'Clic per ordinare'}
      onClick={() => setSort(key)}
    >
      {label}
      {sort === key ? ' ▲' : ''}
    </th>
  )

  return (
    <div className="card">
      <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        Earned Value
        <span className="info-icon" title={EV_HELP} aria-label={EV_HELP}>
          i
        </span>
      </h3>
      {ev.bac === 0 ? (
        <p className="muted">Nessun PBI con stima (dev + test) o Sizing: serve almeno uno dei due per il budget.</p>
      ) : (
        <>
          <KpiRow ev={ev} />
          <div className="ev-progress">
            <span>
              Completamento pianificato <strong>{formatPct(ev.bac ? ev.pv / ev.bac : null)}</strong>
            </span>
            <span>
              guadagnato <strong>{formatPct(ev.bac ? ev.ev / ev.bac : null)}</strong>
            </span>
            <span>
              PV <strong>{formatHours(ev.pv)}</strong> · EV <strong>{formatHours(ev.ev)}</strong>
            </span>
            <span>
              SV <strong>{formatSignedHours(ev.sv)}</strong>
              {ev.earned_schedule && ` (lavoro fatto = piano al ${formatIsoDate(ev.earned_schedule)})`}
            </span>
          </div>
          <Warnings ev={ev} />
          {chartData.length > 1 && (
            <div style={{ height: 300, marginTop: 8 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="x"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={formatEpochDaysAsDate}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    label={{ value: 'Ore', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#898781' } }}
                  />
                  <Tooltip
                    labelFormatter={(v) => formatEpochDaysAsDate(Number(v))}
                    formatter={(v) => `${Number(v).toLocaleString('it-IT')} h`}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {todayX !== null && (
                    <ReferenceLine
                      x={todayX}
                      stroke={COLOR_TODAY}
                      strokeDasharray="4 4"
                      label={{ value: 'Oggi', position: 'top', fill: COLOR_TODAY, fontSize: 12 }}
                    />
                  )}
                  <Line
                    type="linear"
                    dataKey="pv"
                    name="PV pianificato"
                    stroke={COLOR_PV}
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    dot={false}
                  />
                  <Line type="linear" dataKey="ev" name="EV guadagnato" stroke={COLOR_EV} strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            L'EV nel passato è ricostruito: il budget di ogni PBI Done è guadagnato il giorno della sua Fine effettiva.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, marginBottom: 6 }}>
            <h4 style={{ margin: 0 }}>Dettaglio per PBI ({rows.length})</h4>
            <button
              type="button"
              className="btn"
              aria-expanded={!detailHidden}
              title={detailHidden ? 'Mostra la tabella con il dettaglio dei PBI' : 'Nascondi la tabella con il dettaglio dei PBI'}
              onClick={toggleDetail}
            >
              {detailHidden ? '▼ Mostra' : '▲ Nascondi'}
            </button>
          </div>
          {!detailHidden && (
          <>
          <div className="table-wrap">
            <table className="ev-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Titolo</th>
                  <th>Stato</th>
                  {sortHeader('budget', 'Budget', 'Stima dev + test, altrimenti Sizing × 8 h')}
                  {sortHeader('completion', '% compl.')}
                  <th title="Valore pianificato a oggi">PV</th>
                  <th title="Valore guadagnato">EV</th>
                  {sortHeader('sv', 'SV', 'EV − PV: negativo = in ritardo')}
                  <th title="Date usate per il PV">Piano</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{i.jira_key}</td>
                    <td className="ev-summary" title={i.summary ?? ''}>
                      {i.summary}
                    </td>
                    <td>{i.status}</td>
                    <td className="num" title={i.budget_source === 'sizing' ? 'Da Sizing × 8 h' : 'Stima dev + test'}>
                      {formatHours(i.budget)}
                      {i.budget_source === 'sizing' && <span className="muted"> *</span>}
                    </td>
                    <td className="num">
                      <span className="ev-bar">
                        <span style={{ width: `${Math.round((i.completion ?? 0) * 100)}%` }} />
                      </span>
                      {formatPct(i.completion)}
                    </td>
                    <td className="num">{formatHours(i.pv)}</td>
                    <td className="num">{formatHours(i.ev)}</td>
                    <td className={`num ev-${i.sv < -0.5 ? 'bad' : i.sv > 0.5 ? 'good' : 'none'}`}>
                      {formatSignedHours(i.sv)}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }} title={i.plan_source ? `Date ${i.plan_source}` : 'Senza date'}>
                      {i.plan_start ? `${formatIsoDate(i.plan_start)} → ${formatIsoDate(i.plan_finish)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>* budget dal Sizing (gg × 8 h): manca la stima dev + test.</p>
          </>
          )}
        </>
      )}
    </div>
  )
}
