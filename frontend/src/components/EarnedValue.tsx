import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { EarnedValue, EarnedValueItem } from '../api/types'
import { dateStrToEpochDays, formatEpochDaysAsDate, formatIsoDate } from '../lib/dates'
import { evTone, formatHours, formatIndex, formatPct, formatSignedHours } from '../lib/earnedValue'

const COLOR_PV = '#8a94a3'
const COLOR_EV = '#1a9c5c'
const COLOR_AC = '#eb6834'
const COLOR_TODAY = '#d3402f'

const EV_HELP =
  'Earned Value, in ore, sui PBI del piano (in scope, code freeze o attività per Release; milestone escluse).\n\n' +
  '• Budget di un PBI: stima dev + stima test; se mancano, Sizing (gg) × 8 h.\n' +
  '• % completamento: Done = 100%; altrimenti ore loggate / budget, al massimo 95% finché non è Done.\n' +
  '• PV (valore pianificato): il budget distribuito sui giorni lavorativi della baseline (senza baseline, delle date aggiornate).\n' +
  '• EV (valore guadagnato): budget × % completamento.\n' +
  '• AC (costo effettivo): ore loggate su Jira.\n\n' +
  'SPI = EV / PV (rispetto dei tempi), CPI = EV / AC (rispetto delle ore): sotto 1 si è in ritardo o si spende di più. ' +
  'Verde da 0,95, giallo da 0,85, rosso sotto.\n' +
  'Stima a finire (EAC) = budget / CPI. Fine prevista: la durata del piano divisa per l\'SPI sul tempo (Earned Schedule).'

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

// Indicatori principali, in comune tra la card della Dashboard e la sezione
// dell'Andamento.
function KpiRow({ ev }: { ev: EarnedValue }) {
  return (
    <div className="grid-4 ev-kpis">
      <Kpi value={formatIndex(ev.spi)} label="SPI (tempi)" tone={evTone(ev.spi)} note={delayNote(ev)} />
      <Kpi
        value={formatIndex(ev.cpi)}
        label="CPI (ore)"
        tone={evTone(ev.cpi)}
        note={ev.cpi === null ? 'nessuna ora loggata' : `CV ${formatSignedHours(ev.cv)}`}
      />
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
        value={formatHours(ev.eac)}
        label="Stima a finire (EAC)"
        tone={ev.vac === null ? undefined : ev.vac < 0 ? 'bad' : 'good'}
        note={`budget ${formatHours(ev.bac)}${ev.vac !== null ? ` · VAC ${formatSignedHours(ev.vac)}` : ''}`}
      />
    </div>
  )
}

function Warnings({ ev }: { ev: EarnedValue }) {
  const notes: string[] = []
  if (!ev.has_baseline)
    notes.push('Baseline non fissata: il PV usa le date aggiornate (pulsante "Fissa baseline" nel Backlog).')
  if (ev.items_without_budget > 0)
    notes.push(
      `${ev.items_without_budget} PBI senza stima né Sizing: fuori dal calcolo` +
        (ev.unbudgeted_logged_hours > 0 ? ` (con ${formatHours(ev.unbudgeted_logged_hours)} loggate).` : '.'),
    )
  if (ev.items_without_plan > 0) notes.push(`${ev.items_without_plan} PBI senza date: non entrano nel PV.`)
  if (ev.done_without_hours > 0)
    notes.push(
      `${ev.done_without_hours} PBI Done senza ore loggate: valore guadagnato senza costo, il CPI risulta ottimistico.`,
    )
  if (notes.length === 0) return null
  return (
    <ul className="ev-warnings">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}

export function EarnedValueCard({ projectId }: { projectId: number }) {
  const { data: ev, isError } = useEarnedValue(projectId)
  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Earned Value
          <span className="info-icon" title={EV_HELP} aria-label={EV_HELP}>
            i
          </span>
        </h3>
        <Link to={`/projects/${projectId}/snapshots`}>Curve e dettaglio per PBI →</Link>
      </div>
      {isError && <p className="muted">Earned Value non disponibile.</p>}
      {ev && (ev.bac > 0 ? <KpiRow ev={ev} /> : <p className="muted">Nessun PBI con stima o Sizing.</p>)}
    </div>
  )
}

type SortKey = 'sv' | 'cpi' | 'completion' | 'budget'

export function EarnedValueSection({ projectId }: { projectId: number }) {
  const { data: ev, isLoading, isError } = useEarnedValue(projectId)
  const [sort, setSort] = useState<SortKey>('sv')

  const chartData = useMemo(
    () =>
      (ev?.curve ?? []).map((p) => ({
        x: dateStrToEpochDays(p.day),
        pv: Math.round(p.pv),
        ev: p.ev === null ? null : Math.round(p.ev),
        ac: p.ac === null ? null : Math.round(p.ac),
      })),
    [ev],
  )

  const rows = useMemo(() => {
    const items = (ev?.items ?? []).filter((i) => i.budget !== null)
    const value = (i: EarnedValueItem): number => {
      if (sort === 'sv') return i.sv
      if (sort === 'cpi') return i.cpi ?? Number.POSITIVE_INFINITY
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
              PV <strong>{formatHours(ev.pv)}</strong> · EV <strong>{formatHours(ev.ev)}</strong> · AC{' '}
              <strong>{formatHours(ev.ac)}</strong>
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
                  <Line type="linear" dataKey="ac" name="AC ore loggate" stroke={COLOR_AC} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            EV e AC nel passato sono ricostruiti: il valore di ogni PBI è distribuito tra Start eff. e Fine eff. (oggi se
            è aperto).
          </p>

          <h4 style={{ marginBottom: 6 }}>Dettaglio per PBI</h4>
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
                  <th title="Ore loggate su Jira">AC</th>
                  {sortHeader('sv', 'SV', 'EV − PV: negativo = in ritardo')}
                  {sortHeader('cpi', 'CPI', 'EV / AC: sotto 1 = più ore del previsto')}
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
                    <td className="num">{formatHours(i.ac)}</td>
                    <td className={`num ev-${i.sv < -0.5 ? 'bad' : i.sv > 0.5 ? 'good' : 'none'}`}>
                      {formatSignedHours(i.sv)}
                    </td>
                    <td className={`num ev-${evTone(i.cpi) || 'none'}`}>{formatIndex(i.cpi)}</td>
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
    </div>
  )
}
