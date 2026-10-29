import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Label,
  LabelList,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '../api/client'
import type { ForecastSimulation, Project } from '../api/types'
import { NewSimulationModal } from '../components/NewSimulationModal'
import { dateStrToEpochDays, formatEpochDaysAsDate, formatIsoDate, parseBackendDateTime } from '../lib/dates'
import { parseMcParams, recalcForDeadline } from '../lib/forecastParams'
import { useProjectContext } from './useProjectContext'

// Palette categorica validata del progetto (vedi skill data-viz), ordine
// fisso dei primi 6 slot: blu, arancio, aqua, giallo, magenta, verde.
const COLOR_PBI_REMAINING = '#2a78d6'
const COLOR_PLANNED_DONE = '#eb6834'
const COLOR_UNPLANNED_DONE = '#1baf7a'
const COLOR_CODE_FREEZE = '#eda100'
const COLOR_MONTE_CARLO = '#e87ba4'
const COLOR_TRADITIONAL = '#008300'

function formatKeysTooltip(keys: string | null): string {
  if (!keys) return 'Nessun dettaglio disponibile (simulazione creata prima di questa funzione, o nessun PBI trovato)'
  return keys.split(', ').join('\n')
}

export function ForecastingPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()

  const { data: simulations } = useQuery({
    queryKey: ['forecasting', project.id],
    queryFn: () => api.forecasting.list(project.id),
  })

  // "+ Aggiungi simulazione": popup che aggiorna i dati da Jira e calcola le
  // colonne della nuova riga (vedi NewSimulationModal).
  const [adding, setAdding] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['forecasting', project.id] })

  const updateProject = useMutation({
    mutationFn: (data: Partial<Project>) => api.projects.update(project.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', project.id] })
      queryClient.invalidateQueries({ queryKey: ['phases', project.id] })
    },
  })

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<ForecastSimulation> }) => api.forecasting.update(id, data),
    onSuccess: invalidate,
  })
  // Deadline di una riga cambiata: se la riga e' stata calcolata da "+
  // Aggiungi simulazione" si ricalcolano anche Chance to meet the deadline e
  // 85% #PBI entro la deadline (vedi recalcForDeadline), altrimenti cambia
  // solo la data.
  const [recalcError, setRecalcError] = useState<string | null>(null)
  const changeDeadline = async (sim: ForecastSimulation, deadline: string | null) => {
    if (deadline === sim.code_freeze_deadline) return
    setRecalcError(null)
    let data: Partial<ForecastSimulation> = { code_freeze_deadline: deadline }
    try {
      data = (await recalcForDeadline(sim, deadline)) ?? data
    } catch (e) {
      setRecalcError(`Previsioni non ricalcolate: ${(e as Error).message}`)
    }
    update.mutate({ id: sim.id, data })
  }
  // Nota sulla riga ricalcolata, con lo storico usato se diverso da quello
  // della creazione.
  const recalcInfo = (sim: ForecastSimulation): string | null => {
    const params = parseMcParams(sim.mc_params)
    if (!params?.recalculatedAt) return null
    const when = (value: string | null | undefined, utc: boolean) =>
      value
        ? (utc ? parseBackendDateTime(value) : new Date(value)).toLocaleString('it-IT', {
            dateStyle: 'short',
            timeStyle: 'short',
          })
        : 'n.d.'
    let text = `Ricalcolata il ${when(params.recalculatedAt, false)} per la nuova deadline.`
    if (params.recalcHistoryFetchedAt !== params.historyFetchedAt)
      text += `\nStorico Jira usato: estratto il ${when(params.recalcHistoryFetchedAt, true)} (alla creazione: ${when(params.historyFetchedAt, true)}), quindi i valori possono differire leggermente.`
    return text
  }

  const remove = useMutation({
    mutationFn: (id: number) => api.forecasting.remove(id),
    onSuccess: invalidate,
  })

  const num = (v: string) => (v === '' ? null : Number(v))
  const dateOrNull = (v: string) => v || null
  const textOrNull = (v: string) => v.trim() || null

  const chartData = (simulations ?? []).map((sim) => ({
    label: formatIsoDate(sim.simulation_date) ?? `#${sim.id}`,
    pbi_remaining: sim.pbi_remaining ?? 0,
    planned_pbi_done: sim.planned_pbi_done ?? 0,
    unplanned_pbi_done: sim.unplanned_pbi_done ?? 0,
    code_freeze: dateStrToEpochDays(sim.code_freeze_deadline),
    monte_carlo: dateStrToEpochDays(sim.completion_date_85pct),
    traditional: dateStrToEpochDays(sim.traditional_forecasting),
  }))

  const dateEpochs = chartData
    .flatMap((r) => [r.code_freeze, r.monte_carlo, r.traditional])
    .filter((v): v is number => v !== null)
  const dateAxisDomain: [number, number] =
    dateEpochs.length > 0 ? [Math.min(...dateEpochs) - 5, Math.max(...dateEpochs) + 5] : [0, 1]

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Forecasting</h3>
          <span className="sub muted">
            Simulazioni periodiche di throughput usate per proiettare la data di completamento dell'increment.
          </span>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span className="muted">Inizio sviluppi effettivo</span>
          <input
            type="date"
            defaultValue={project.dev_start_date ?? ''}
            onBlur={(e) => {
              const value = e.target.value || null
              if (value !== project.dev_start_date) updateProject.mutate({ dev_start_date: value })
            }}
          />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 12 }}>
        Una nuova simulazione conta come Planned/Unplanned #PBI Done solo i PBI completati da questa data in poi
        (label "planned" → Planned, label "oos" → Unplanned; se presenti entrambe vince "oos").
      </p>

      {recalcError && <div className="error-banner">{recalcError}</div>}
      <div className="table-wrap table-wrap--sticky-head">
        <table className="forecast-table">
          <colgroup>
            <col style={{ width: '14%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '2%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Note</th>
              <th>Simulation Date</th>
              <th>#PBI Remaining</th>
              <th>#PBI Done</th>
              <th>Planned #PBI Done</th>
              <th>Unplanned #PBI Done</th>
              <th>Traditional Forecasting</th>
              <th>Code Freeze Deadline (100% PBIs Done)</th>
              <th>Chance to meet the deadline (Completion Likelihood)</th>
              <th>85% Completion Date Forecasting</th>
              <th>85% #PBI Completed by Release Deadline Forecasting</th>
              <th>85% Completion Date Forecasting w/ Holidays</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {simulations?.map((sim) => (
              <tr key={sim.id}>
                <td className="editable-cell" style={{ whiteSpace: 'normal', minWidth: 220 }}>
                  <textarea
                    rows={2}
                    defaultValue={sim.note ?? ''}
                    style={{ width: '100%', resize: 'vertical', font: 'inherit', border: 'none', background: 'transparent' }}
                    onBlur={(e) => {
                      const value = textOrNull(e.target.value)
                      if (value !== sim.note) update.mutate({ id: sim.id, data: { note: value } })
                    }}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.simulation_date ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { simulation_date: dateOrNull(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={sim.pbi_remaining ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { pbi_remaining: num(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    defaultValue={sim.pbi_done ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { pbi_done: num(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="number"
                      defaultValue={sim.planned_pbi_done ?? ''}
                      onBlur={(e) => update.mutate({ id: sim.id, data: { planned_pbi_done: num(e.target.value) } })}
                    />
                    <span className="info-icon" title={formatKeysTooltip(sim.planned_pbi_keys)}>
                      i
                    </span>
                  </div>
                </td>
                <td className="editable-cell">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="number"
                      defaultValue={sim.unplanned_pbi_done ?? ''}
                      onBlur={(e) => update.mutate({ id: sim.id, data: { unplanned_pbi_done: num(e.target.value) } })}
                    />
                    <span className="info-icon" title={formatKeysTooltip(sim.unplanned_pbi_keys)}>
                      i
                    </span>
                  </div>
                </td>
                <td className="editable-cell">
                  <input
                    defaultValue={sim.traditional_forecasting ?? ''}
                    placeholder="gg/mm/aaaa o n.a."
                    onBlur={(e) => {
                      const value = textOrNull(e.target.value)
                      if (value !== sim.traditional_forecasting)
                        update.mutate({ id: sim.id, data: { traditional_forecasting: value } })
                    }}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.code_freeze_deadline ?? ''}
                    onBlur={(e) => changeDeadline(sim, dateOrNull(e.target.value))}
                  />
                </td>
                <td className="editable-cell">
                  <div className="pct-cell">
                    {recalcInfo(sim) && (
                      <span className="info-icon" title={recalcInfo(sim) ?? undefined}>
                        ↻
                      </span>
                    )}
                    <input
                      // key: ricreato quando il valore cambia da un ricalcolo.
                      key={`likelihood-${sim.completion_likelihood}`}
                      type="number"
                      step="0.01"
                      min={0}
                      max={100}
                      defaultValue={sim.completion_likelihood ?? ''}
                      onBlur={(e) => update.mutate({ id: sim.id, data: { completion_likelihood: num(e.target.value) } })}
                    />
                    <span>%</span>
                  </div>
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.completion_date_85pct ?? ''}
                    onBlur={(e) => update.mutate({ id: sim.id, data: { completion_date_85pct: dateOrNull(e.target.value) } })}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    key={`howmany-${sim.pbi_completed_by_deadline_85pct}`}
                    type="number"
                    defaultValue={sim.pbi_completed_by_deadline_85pct ?? ''}
                    onBlur={(e) =>
                      update.mutate({ id: sim.id, data: { pbi_completed_by_deadline_85pct: num(e.target.value) } })
                    }
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="date"
                    defaultValue={sim.completion_date_85pct_with_holidays ?? ''}
                    onBlur={(e) =>
                      update.mutate({ id: sim.id, data: { completion_date_85pct_with_holidays: dateOrNull(e.target.value) } })
                    }
                  />
                </td>
                <td>
                  <button className="btn btn-danger" onClick={() => remove.mutate(sim.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {simulations?.length === 0 && (
              <tr>
                <td colSpan={13} className="muted">
                  Nessuna simulazione registrata.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + Aggiungi simulazione
        </button>
      </div>
      {adding && <NewSimulationModal project={project} onClose={() => setAdding(false)} />}

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Andamento simulazioni</h3>
        {chartData.length === 0 ? (
          <p className="muted">Aggiungi almeno una simulazione per vedere il grafico.</p>
        ) : (
          <div style={{ height: 400 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                <CartesianGrid stroke="#e1e0d9" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }}>
                  <Label value="Simulation Date" position="insideBottom" offset={-4} style={{ fontSize: 12, fill: '#898781' }} />
                </XAxis>
                <YAxis
                  yAxisId="pbi"
                  allowDecimals={false}
                  tick={{ fontSize: 12 }}
                  label={{ value: '#PBI', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#898781' } }}
                />
                <YAxis
                  yAxisId="date"
                  orientation="right"
                  domain={dateAxisDomain}
                  tickFormatter={formatEpochDaysAsDate}
                  tick={{ fontSize: 12 }}
                  label={{
                    value: 'Forecasting Date',
                    angle: 90,
                    position: 'insideRight',
                    style: { fontSize: 12, fill: '#898781' },
                  }}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(11,11,11,0.04)' }}
                  formatter={(value, name) =>
                    ['Code Freeze Deadline', 'Monte Carlo 85% Forecast', 'Traditional Forecasting'].includes(String(name))
                      ? [formatEpochDaysAsDate(Number(value)), name]
                      : [value, name]
                  }
                />
                <Legend verticalAlign="top" height={48} wrapperStyle={{ fontSize: 12 }} />

                <Bar
                  yAxisId="pbi"
                  dataKey="pbi_remaining"
                  name="#PBI Remaining"
                  stackId="pbi"
                  fill={COLOR_PBI_REMAINING}
                  stroke="#fcfcfb"
                  strokeWidth={2}
                >
                  <LabelList dataKey="pbi_remaining" position="inside" fill="#fff" fontSize={11} />
                </Bar>
                <Bar
                  yAxisId="pbi"
                  dataKey="planned_pbi_done"
                  name="Planned #PBI Done"
                  stackId="pbi"
                  fill={COLOR_PLANNED_DONE}
                  stroke="#fcfcfb"
                  strokeWidth={2}
                >
                  <LabelList dataKey="planned_pbi_done" position="inside" fill="#fff" fontSize={11} />
                </Bar>
                <Bar
                  yAxisId="pbi"
                  dataKey="unplanned_pbi_done"
                  name="Unplanned #PBI Done"
                  stackId="pbi"
                  fill={COLOR_UNPLANNED_DONE}
                  stroke="#fcfcfb"
                  strokeWidth={2}
                >
                  <LabelList dataKey="unplanned_pbi_done" position="inside" fill="#fff" fontSize={11} />
                </Bar>

                <Line
                  yAxisId="date"
                  dataKey="code_freeze"
                  name="Code Freeze Deadline"
                  stroke={COLOR_CODE_FREEZE}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  activeDot={{ r: 6 }}
                  connectNulls
                >
                  <LabelList
                    dataKey="code_freeze"
                    position="top"
                    fontSize={11}
                    fill={COLOR_CODE_FREEZE}
                    formatter={(v) => (typeof v === 'number' ? formatEpochDaysAsDate(v) : '')}
                  />
                </Line>
                <Line
                  yAxisId="date"
                  dataKey="monte_carlo"
                  name="Monte Carlo 85% Forecast"
                  stroke={COLOR_MONTE_CARLO}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  activeDot={{ r: 6 }}
                  connectNulls
                >
                  <LabelList
                    dataKey="monte_carlo"
                    position="top"
                    fontSize={11}
                    fill={COLOR_MONTE_CARLO}
                    formatter={(v) => (typeof v === 'number' ? formatEpochDaysAsDate(v) : '')}
                  />
                </Line>
                <Line
                  yAxisId="date"
                  dataKey="traditional"
                  name="Traditional Forecasting"
                  stroke={COLOR_TRADITIONAL}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  activeDot={{ r: 6 }}
                  connectNulls
                >
                  <LabelList
                    dataKey="traditional"
                    position="bottom"
                    fontSize={11}
                    fill={COLOR_TRADITIONAL}
                    formatter={(v) => (typeof v === 'number' ? formatEpochDaysAsDate(v) : '')}
                  />
                </Line>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}
