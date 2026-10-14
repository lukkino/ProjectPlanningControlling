import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '../api/client'
import type { IncrementBudgetLine, IncrementSnapshot, IncrementSnapshotValue, SubProject } from '../api/types'
import { formatIsoDate } from '../lib/dates'

// subProjects: i sotto-progetti del progetto, di cui ogni snapshot raccoglie
// anche l'Actual ore.
type Props = { incrementId: number; subProjects: SubProject[] }

// Stesso blu/arancio gia' usato altrove nell'app per confrontare due serie
// (es. DashboardPage): qui budget vs actual (dell'ultimo snapshot).
const COLOR_BUDGET = '#2f6fed'
const COLOR_ACTUAL = '#eb6834'

// Quante tabelle snapshot (le piu' recenti) restano visibili senza dover
// espandere "Mostra snapshot precedenti".
const VISIBLE_SNAPSHOTS = 2

function formatValue(value: number, isHours: boolean): string {
  if (isHours) return value.toLocaleString('it-IT')
  return `${value.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function formatDiff(value: number, isHours: boolean): string {
  return value > 0 ? `+${formatValue(value, isHours)}` : formatValue(value, isHours)
}

// Inverso di formatValue per le voci in €: rimuove il simbolo e i separatori
// delle migliaia (".") e converte la virgola decimale in punto, cosi' un
// campo di testo puo' mostrare "310.500,00 €" e restare comunque
// modificabile. Le voci in ore restano un input numerico semplice (vedi
// sotto), che non ne ha bisogno.
function parseCurrencyInput(text: string): number {
  const cleaned = text.trim().replace(/€/g, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

type ChartMode = 'budget' | 'split'

// Voci della ripartizione dell'Actual ore (come ACTUAL_SPLIT_NAMES nel
// backend), ognuna col suo colore fisso: prime quattro tinte della palette
// categoriale, validate per daltonismo.
const SPLIT_SERIES = [
  { name: 'Project Management', color: '#2a78d6' },
  { name: 'Develop', color: '#eb6834' },
  { name: 'Testing', color: '#1baf7a' },
  { name: 'System Testing', color: '#eda100' },
]

// Andamento ad ogni snapshot delle ore per voce di ripartizione, sommate su
// tutte le voci in ore del progetto. Solo gli snapshot con l'Actual
// ripartito: negli altri il dato per voce non esiste.
function SplitTrendChart({ snapshotsAsc, lines }: { snapshotsAsc: IncrementSnapshot[]; lines: IncrementBudgetLine[] }) {
  const hoursLineIds = new Set(lines.filter((l) => l.is_hours).map((l) => l.id))
  const data = snapshotsAsc
    .map((snap) => {
      const entries = snap.values.filter((v) => hoursLineIds.has(v.budget_line_id)).flatMap((v) => v.entries)
      if (entries.length === 0) return null
      const point: Record<string, string | number> = { date: formatIsoDate(snap.snapshot_date) ?? snap.snapshot_date }
      for (const series of SPLIT_SERIES)
        point[series.name] = entries.filter((e) => e.name === series.name).reduce((sum, e) => sum + e.hours, 0)
      return point
    })
    .filter((p): p is Record<string, string | number> => p !== null)

  if (data.length === 0)
    return (
      <p className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
        Nessuno snapshot con l'Actual ore ripartito: apri ▸ accanto all'Actual di una voce in ore e premi "Ripartisci
        l'Actual".
      </p>
    )

  const last = data.length - 1
  return (
    <>
      <h4 style={{ margin: '0 0 8px', fontSize: 13, textAlign: 'center' }}>Andamento Actual ore per voce</h4>
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 40, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip formatter={(value) => `${formatValue(Number(value), true)} h`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {SPLIT_SERIES.map((series) => (
              <Line
                key={series.name}
                type="monotone"
                dataKey={series.name}
                stroke={series.color}
                strokeWidth={2}
                dot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)', fill: series.color }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              >
                {/* Valore solo sull'ultimo snapshot, in colore testo. */}
                <LabelList
                  dataKey={series.name}
                  content={(props) =>
                    props.index === last ? (
                      <text x={Number(props.x) + 8} y={Number(props.y) + 4} fontSize={11} fill="var(--text-muted)">
                        {formatValue(Number(props.value), true)}
                      </text>
                    ) : null
                  }
                />
              </Line>
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

export function IncrementHistoryCard({ incrementId, subProjects }: Props) {
  const [showAll, setShowAll] = useState(false)
  const [chartMode, setChartMode] = useState<ChartMode>('budget')
  const queryClient = useQueryClient()
  const { data: lines } = useQuery({
    queryKey: ['increment-budget-lines', incrementId],
    queryFn: () => api.incrementBudgetLines.list(incrementId),
  })
  const { data: snapshotsAsc } = useQuery({
    queryKey: ['increment-snapshots', incrementId],
    queryFn: () => api.incrementSnapshots.list(incrementId),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['increment-budget-lines', incrementId] })
    queryClient.invalidateQueries({ queryKey: ['increment-snapshots', incrementId] })
    queryClient.invalidateQueries({ queryKey: ['increment', incrementId] })
  }

  const updateLine = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementBudgetLine> }) =>
      api.incrementBudgetLines.update(id, data),
    onSuccess: invalidate,
  })
  const addLine = useMutation({
    mutationFn: () =>
      api.incrementBudgetLines.create(incrementId, {
        category_name: 'Nuova voce',
        is_hours: false,
        order: (lines?.length ?? 0) + 1,
      }),
    onSuccess: invalidate,
  })
  const removeLine = useMutation({
    mutationFn: (id: number) => api.incrementBudgetLines.remove(id),
    onSuccess: invalidate,
  })

  const updateSnapshot = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementSnapshot> }) =>
      api.incrementSnapshots.update(id, data),
    onSuccess: invalidate,
  })
  const addSnapshot = useMutation({
    mutationFn: () =>
      api.incrementSnapshots.create(incrementId, { snapshot_date: new Date().toISOString().slice(0, 10) }),
    onSuccess: invalidate,
  })
  const removeSnapshot = useMutation({
    mutationFn: (id: number) => api.incrementSnapshots.remove(id),
    onSuccess: invalidate,
  })
  const updateValue = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementSnapshotValue> }) =>
      api.incrementSnapshotValues.update(id, data),
    onSuccess: invalidate,
  })

  // Ripartizione dell'Actual ore: righe aperte, per snapshot e voce.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const split = useMutation({
    mutationFn: (valueId: number) => api.incrementSnapshotValues.split(valueId),
    onSuccess: invalidate,
  })
  const removeSplit = useMutation({
    mutationFn: (valueId: number) => api.incrementSnapshotValues.removeSplit(valueId),
    onSuccess: invalidate,
  })
  const setEntryHours = useMutation({
    mutationFn: ({ id, hours }: { id: number; hours: number }) => api.incrementSnapshotValues.setEntryHours(id, hours),
    onSuccess: invalidate,
  })

  const setSubHours = useMutation({
    mutationFn: ({ snapshotId, subProjectId, hours }: { snapshotId: number; subProjectId: number; hours: number }) =>
      api.incrementSnapshots.setSubProjectHours(snapshotId, subProjectId, hours),
    onSuccess: invalidate,
  })

  const error =
    setSubHours.error ??
    updateLine.error ??
    addLine.error ??
    removeLine.error ??
    updateSnapshot.error ??
    addSnapshot.error ??
    removeSnapshot.error ??
    updateValue.error ??
    split.error ??
    removeSplit.error ??
    setEntryHours.error

  // snapshotsAsc e' in ordine cronologico (dal backend): qui serve anche
  // dal piu' recente, sia per decidere quali mostrare di default sia per
  // calcolare il diff di ognuno rispetto al precedente.
  const snapshotsDesc = [...(snapshotsAsc ?? [])].reverse()
  const latestSnapshot = snapshotsDesc[0] ?? null
  const visibleSnapshots = showAll ? snapshotsDesc : snapshotsDesc.slice(0, VISIBLE_SNAPSHOTS)
  const hiddenCount = snapshotsDesc.length - visibleSnapshots.length

  const latestByLine = new Map((latestSnapshot?.values ?? []).map((v) => [v.budget_line_id, v]))
  const chartData = (lines ?? []).map((l) => ({
    name: l.category_name,
    budget: latestByLine.get(l.id)?.budget_value ?? 0,
    actual: latestByLine.get(l.id)?.actual_value ?? 0,
  }))

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Consumo risorse progetto</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => addLine.mutate()}>
            + Aggiungi voce
          </button>
          <button className="btn btn-primary" onClick={() => addSnapshot.mutate()} disabled={(lines?.length ?? 0) === 0}>
            + Nuovo snapshot
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Budget e Actual sono entrambi il totale cumulativo ad oggi per quella voce, non solo del periodo: un nuovo
        snapshot riparte dai valori del precedente (il budget di solito resta costante, ma può cambiare per una
        revisione budget).
      </p>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}

      <div className="grid-3-2">
        <div>
          {snapshotsDesc.length === 0 && (
            <p className="muted">Nessuno snapshot registrato ancora: creane uno con "+ Nuovo snapshot".</p>
          )}

          {visibleSnapshots.map((snap) => {
            const idxAsc = (snapshotsAsc ?? []).findIndex((s) => s.id === snap.id)
            const prev = idxAsc > 0 ? (snapshotsAsc ?? [])[idxAsc - 1] : null
            const prevByLine = new Map((prev?.values ?? []).map((v) => [v.budget_line_id, v]))
            const valueByLine = new Map(snap.values.map((v) => [v.budget_line_id, v]))
            const subHours = new Map(snap.sub_values.map((v) => [v.sub_project_id, v.actual_hours]))
            const prevSubHours = new Map((prev?.sub_values ?? []).map((v) => [v.sub_project_id, v.actual_hours]))
            // Ore del progetto in questo snapshot (voci in ore) e quante di
            // queste sono attribuite ai sotto-progetti.
            const projectHours = (lines ?? [])
              .filter((l) => l.is_hours)
              .reduce((sum, l) => sum + (valueByLine.get(l.id)?.actual_value ?? 0), 0)
            const subHoursTotal = subProjects.reduce((sum, s) => sum + (subHours.get(s.id) ?? 0), 0)
            const subHoursGap = Math.round((projectHours - subHoursTotal) * 100) / 100
            const subHoursMatch = subHoursGap === 0

            return (
              <div key={snap.id} className="table-wrap" style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 0 }}>
                    <input
                      type="date"
                      style={{ flex: '0 0 auto' }}
                      defaultValue={snap.snapshot_date}
                      onBlur={(e) =>
                        e.target.value !== snap.snapshot_date &&
                        updateSnapshot.mutate({ id: snap.id, data: { snapshot_date: e.target.value } })
                      }
                    />
                    <textarea
                      defaultValue={snap.note ?? ''}
                      placeholder="Nota (opzionale, es. revisione budget)"
                      rows={1}
                      style={{ flex: 1, minWidth: 200, minHeight: 30, resize: 'both' }}
                      onBlur={(e) =>
                        e.target.value !== (snap.note ?? '') &&
                        updateSnapshot.mutate({ id: snap.id, data: { note: e.target.value || null } })
                      }
                    />
                  </div>
                  <button className="btn btn-danger" style={{ flex: '0 0 auto' }} onClick={() => removeSnapshot.mutate(snap.id)}>
                    ✕
                  </button>
                </div>
                <table style={{ tableLayout: 'fixed', width: '100%' }}>
                  <colgroup>
                    <col style={{ width: 190 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 150 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 40 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Area</th>
                      <th>Budget</th>
                      <th>Actual</th>
                      <th style={{ whiteSpace: 'normal' }}>Diff previous snapshot</th>
                      <th>% Used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines?.map((line) => {
                      const value = valueByLine.get(line.id)
                      const prevValue = prevByLine.get(line.id)
                      const diff = (value?.actual_value ?? 0) - (prevValue?.actual_value ?? 0)
                      const pctUsed = value && value.budget_value ? (value.actual_value / value.budget_value) * 100 : null
                      const entries = value?.entries ?? []
                      const expandKey = `${snap.id}-${line.id}`
                      const isExpanded = line.is_hours && expanded.has(expandKey)
                      const prevEntryHours = new Map((prevValue?.entries ?? []).map((e) => [e.name, e.hours]))
                      return (
                        <Fragment key={line.id}>
                        <tr>
                          <td style={{ whiteSpace: 'normal' }}>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <input
                                defaultValue={line.category_name}
                                style={{ minWidth: 0 }}
                                onBlur={(e) =>
                                  e.target.value !== line.category_name &&
                                  updateLine.mutate({ id: line.id, data: { category_name: e.target.value } })
                                }
                              />
                              <select
                                value={line.is_hours ? 'hours' : 'money'}
                                onChange={(e) =>
                                  updateLine.mutate({ id: line.id, data: { is_hours: e.target.value === 'hours' } })
                                }
                              >
                                <option value="hours">Ore</option>
                                <option value="money">€</option>
                              </select>
                            </div>
                          </td>
                          <td className="editable-cell">
                            {line.is_hours ? (
                              <input
                                type="number"
                                defaultValue={value?.budget_value ?? 0}
                                onBlur={(e) =>
                                  value && updateValue.mutate({ id: value.id, data: { budget_value: Number(e.target.value) } })
                                }
                              />
                            ) : (
                              <input
                                key={value?.budget_value}
                                defaultValue={formatValue(value?.budget_value ?? 0, false)}
                                onBlur={(e) =>
                                  value &&
                                  updateValue.mutate({ id: value.id, data: { budget_value: parseCurrencyInput(e.target.value) } })
                                }
                              />
                            )}
                          </td>
                          <td className={entries.length > 0 ? undefined : 'editable-cell'}>
                            {line.is_hours ? (
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                {entries.length > 0 ? (
                                  // Somma della ripartizione: si modifica da li'.
                                  <span style={{ flex: 1, fontWeight: 600 }}>{formatValue(value?.actual_value ?? 0, true)}</span>
                                ) : (
                                  <input
                                    key={value?.actual_value}
                                    type="number"
                                    style={{ minWidth: 0 }}
                                    defaultValue={value?.actual_value ?? 0}
                                    onBlur={(e) =>
                                      value && updateValue.mutate({ id: value.id, data: { actual_value: Number(e.target.value) } })
                                    }
                                  />
                                )}
                                <button
                                  className="btn"
                                  style={{ flex: '0 0 auto', padding: '2px 6px' }}
                                  title={
                                    isExpanded
                                      ? 'Chiudi la ripartizione'
                                      : 'Ripartizione: ore di Project Management, Develop, Testing e System Testing, sommate nell\'Actual'
                                  }
                                  aria-expanded={isExpanded}
                                  onClick={() => toggleExpanded(expandKey)}
                                >
                                  {isExpanded ? '▾' : '▸'}
                                </button>
                              </div>
                            ) : (
                              <input
                                key={value?.actual_value}
                                defaultValue={formatValue(value?.actual_value ?? 0, false)}
                                onBlur={(e) =>
                                  value &&
                                  updateValue.mutate({ id: value.id, data: { actual_value: parseCurrencyInput(e.target.value) } })
                                }
                              />
                            )}
                          </td>
                          <td>{formatDiff(diff, line.is_hours)}</td>
                          <td
                            style={{
                              fontWeight: 600,
                              color: pctUsed === null ? undefined : pctUsed > 100 ? 'var(--danger)' : 'var(--success)',
                            }}
                          >
                            {pctUsed === null ? '—' : `${pctUsed.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
                          </td>
                          <td>
                            <button className="btn btn-danger" onClick={() => removeLine.mutate(line.id)}>
                              ✕
                            </button>
                          </td>
                        </tr>
                        {isExpanded &&
                          entries.map((entry) => {
                            const entryDiff = entry.hours - (prevEntryHours.get(entry.name) ?? 0)
                            return (
                              // key: campi non controllati, vanno ricreati quando i valori salvati cambiano.
                              <tr key={`entry-${entry.id}-${entry.hours}`} style={{ background: 'var(--bg)' }}>
                                <td style={{ paddingLeft: 24, whiteSpace: 'normal' }}>{entry.name}</td>
                                <td />
                                <td className="editable-cell">
                                  <input
                                    type="number"
                                    min={0}
                                    defaultValue={entry.hours}
                                    aria-label={`Actual ore di ${entry.name}`}
                                    onBlur={(e) => {
                                      const hours = Math.max(0, Number(e.target.value) || 0)
                                      if (hours !== entry.hours) setEntryHours.mutate({ id: entry.id, hours })
                                    }}
                                  />
                                </td>
                                <td>{formatDiff(entryDiff, true)}</td>
                                <td colSpan={2} />
                              </tr>
                            )
                          })}
                        {isExpanded && value && (
                          <tr>
                            <td colSpan={6} style={{ paddingLeft: 24, whiteSpace: 'normal' }}>
                              {entries.length === 0 ? (
                                <>
                                  <button
                                    className="btn"
                                    disabled={split.isPending}
                                    onClick={() =>
                                      (value.actual_value === 0 ||
                                        window.confirm(
                                          `L'Actual attuale (${formatValue(value.actual_value, true)} h) verrà sostituito dalla somma ` +
                                            'di Project Management, Develop, Testing e System Testing, che partono da 0. Continuare?',
                                        )) &&
                                      split.mutate(value.id)
                                    }
                                  >
                                    Ripartisci l'Actual
                                  </button>
                                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                                    Inserisci le ore di Project Management, Develop, Testing e System Testing: l'Actual
                                    diventa la loro somma.
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="muted" style={{ fontSize: 12 }}>
                                    L'Actual è la somma di queste voci; il nuovo snapshot riparte da questi valori.
                                  </span>
                                  <button
                                    className="btn"
                                    style={{ marginLeft: 8 }}
                                    disabled={removeSplit.isPending}
                                    title="L'Actual resta all'ultimo totale e torna modificabile a mano"
                                    onClick={() =>
                                      window.confirm('Togliere la ripartizione da questo snapshot? L\'Actual resta all\'ultimo totale.') &&
                                      removeSplit.mutate(value.id)
                                    }
                                  >
                                    Togli ripartizione
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      )
                    })}
                    {/* Actual ore dei sotto-progetti: stesse colonne delle
                        voci, col budget (fisso, del sotto-progetto) in sola
                        lettura. */}
                    {subProjects.length > 0 && (
                      <tr>
                        <th colSpan={6}>Sotto-progetti (ore)</th>
                      </tr>
                    )}
                    {subProjects.map((sub) => {
                      const hours = subHours.get(sub.id) ?? 0
                      const diff = hours - (prevSubHours.get(sub.id) ?? 0)
                      const pctUsed = sub.budget_hours ? (hours / sub.budget_hours) * 100 : null
                      return (
                        // key: campo non controllato, va ricreato quando il valore salvato cambia.
                        <tr key={`sub-${sub.id}-${hours}`}>
                          <td style={{ whiteSpace: 'normal' }}>{sub.name}</td>
                          <td>{formatValue(sub.budget_hours, true)}</td>
                          <td className="editable-cell">
                            <input
                              type="number"
                              min={0}
                              defaultValue={hours}
                              aria-label={`Actual ore di ${sub.name}`}
                              onBlur={(e) => {
                                const value = Math.max(0, Number(e.target.value) || 0)
                                if (value !== hours)
                                  setSubHours.mutate({ snapshotId: snap.id, subProjectId: sub.id, hours: value })
                              }}
                            />
                          </td>
                          <td>{formatDiff(diff, true)}</td>
                          <td
                            style={{
                              fontWeight: 600,
                              color: pctUsed === null ? undefined : pctUsed > 100 ? 'var(--danger)' : 'var(--success)',
                            }}
                          >
                            {pctUsed === null ? '—' : `${pctUsed.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
                          </td>
                          <td />
                        </tr>
                      )
                    })}
                    {subProjects.length > 0 && (
                      <tr>
                        <td colSpan={2} style={{ fontWeight: 600 }}>
                          Totale sotto-progetti
                        </td>
                        <td style={{ fontWeight: 600 }}>{formatValue(subHoursTotal, true)}</td>
                        {/* Controllo: la somma deve coincidere con l'Actual
                            ore complessivo del progetto in questo snapshot. */}
                        <td
                          colSpan={3}
                          style={{
                            whiteSpace: 'normal',
                            fontSize: 12,
                            fontWeight: 600,
                            color: subHoursMatch ? 'var(--success)' : 'var(--danger)',
                          }}
                        >
                          {subHoursMatch
                            ? `✓ coincide con l'Actual ore del progetto`
                            : `⚠ non coincide con l'Actual ore del progetto (${formatValue(projectHours, true)}): ` +
                              (subHoursGap > 0
                                ? `mancano ${formatValue(subHoursGap, true)} h`
                                : `${formatValue(-subHoursGap, true)} h di troppo`)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )
          })}

          {hiddenCount > 0 && !showAll && (
            <button className="btn" onClick={() => setShowAll(true)}>
              Mostra {hiddenCount} snapshot precedenti
            </button>
          )}
          {showAll && snapshotsDesc.length > VISIBLE_SNAPSHOTS && (
            <button className="btn" onClick={() => setShowAll(false)}>
              Nascondi snapshot precedenti
            </button>
          )}
        </div>

        {chartData.length > 0 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
              <select
                value={chartMode}
                onChange={(e) => setChartMode(e.target.value as ChartMode)}
                aria-label="Grafico da mostrare"
              >
                <option value="budget">Budget vs Actual</option>
                <option value="split">Andamento ore per voce</option>
              </select>
            </div>
            {chartMode === 'split' ? (
              <SplitTrendChart snapshotsAsc={snapshotsAsc ?? []} lines={lines ?? []} />
            ) : (
            <>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, textAlign: 'center' }}>
              Budget vs Actual — {formatIsoDate(latestSnapshot?.snapshot_date ?? null)}
            </h4>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="budget" name="Budget" fill={COLOR_BUDGET} radius={[0, 4, 4, 0]} />
                  <Bar dataKey="actual" name="Actual" fill={COLOR_ACTUAL} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
