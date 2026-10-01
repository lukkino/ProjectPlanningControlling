import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { HoursCalculator, IncrementResourceType } from '../api/types'
import { workingDaysBetween } from '../lib/dates'

type Props = {
  incrementId: number
  // Date del progetto: periodo di default finche' non se ne imposta uno
  // proprio del calcolatore.
  projectStartDate: string | null
  projectEndDate: string | null
}

const fmt = (value: number) => value.toLocaleString('it-IT', { maximumFractionDigits: 1 })

// Numero da un campo di input: vuoto o non valido = 0, mai negativo (accetta
// anche la virgola decimale).
function parseNumber(text: string): number {
  const n = Number(text.trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Calcolatore ore progetto: ore lavorative disponibili per tipologia di
// risorsa in un periodo = giorni lavorativi netti (lun-ven tra le due date,
// meno i giorni di ferie) x numero di risorse x ore effettive al giorno.
export function HoursCalculatorCard({ incrementId, projectStartDate, projectEndDate }: Props) {
  const queryClient = useQueryClient()
  const queryKey = ['hours-calculator', incrementId]
  const { data: calc } = useQuery({ queryKey, queryFn: () => api.hoursCalculator.get(incrementId) })

  const invalidate = () => queryClient.invalidateQueries({ queryKey })

  const updateCalc = useMutation({
    mutationFn: (data: Partial<Omit<HoursCalculator, 'resource_types'>>) => api.hoursCalculator.update(incrementId, data),
    onSuccess: invalidate,
  })
  const updateType = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<IncrementResourceType> }) =>
      api.hoursCalculator.updateResourceType(id, data),
    onSuccess: invalidate,
  })
  const addType = useMutation({
    mutationFn: () =>
      api.hoursCalculator.addResourceType(incrementId, {
        name: 'Nuova tipologia',
        resource_count: 1,
        hours_per_day: 8,
        order: Math.max(0, ...(calc?.resource_types ?? []).map((t) => t.order)) + 1,
      }),
    onSuccess: invalidate,
  })
  const removeType = useMutation({
    mutationFn: (id: number) => api.hoursCalculator.removeResourceType(id),
    onSuccess: invalidate,
  })

  const error = updateCalc.error ?? updateType.error ?? addType.error ?? removeType.error

  if (!calc) return null

  const startDate = calc.start_date ?? projectStartDate
  const endDate = calc.end_date ?? projectEndDate
  const workingDays = workingDaysBetween(startDate, endDate)
  const netDays = workingDays === null ? null : Math.max(0, workingDays - calc.vacation_days)
  const invalidRange = !!startDate && !!endDate && endDate < startDate

  const hoursOf = (t: IncrementResourceType) => (netDays === null ? null : netDays * t.resource_count * t.hours_per_day)
  const totalResources = calc.resource_types.reduce((sum, t) => sum + t.resource_count, 0)
  const totalHours = netDays === null ? null : calc.resource_types.reduce((sum, t) => sum + (hoursOf(t) ?? 0), 0)

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Calcolatore ore progetto</h3>
        <button className="btn" onClick={() => addType.mutate()}>
          + Aggiungi tipologia
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Ore disponibili = giorni lavorativi netti × numero di risorse × ore effettive al giorno. I giorni lavorativi
        sono i lunedì-venerdì tra le due date (estremi compresi): festività e chiusure vanno aggiunte ai giorni di
        ferie.
      </p>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}

      {/* key: i campi non controllati vanno ricreati quando il valore salvato cambia. */}
      <div className="grid-3" key={`${calc.start_date}|${calc.end_date}|${calc.vacation_days}`}>
        <div className="form-row">
          <label>Data di inizio{!calc.start_date && projectStartDate && ' (dal progetto)'}</label>
          <input
            type="date"
            defaultValue={startDate ?? ''}
            onBlur={(e) => {
              const value = e.target.value || null
              if (value !== startDate) updateCalc.mutate({ start_date: value })
              // Campo svuotato: si torna alla data del progetto.
              if (!value) e.target.value = projectStartDate ?? ''
            }}
          />
        </div>
        <div className="form-row">
          <label>Data di fine{!calc.end_date && projectEndDate && ' (dal progetto)'}</label>
          <input
            type="date"
            defaultValue={endDate ?? ''}
            onBlur={(e) => {
              const value = e.target.value || null
              if (value !== endDate) updateCalc.mutate({ end_date: value })
              if (!value) e.target.value = projectEndDate ?? ''
            }}
          />
        </div>
        <div className="form-row">
          <label>Giorni di ferie da sottrarre</label>
          <input
            type="number"
            min={0}
            step={0.5}
            defaultValue={calc.vacation_days}
            onBlur={(e) => {
              const value = parseNumber(e.target.value)
              if (value !== calc.vacation_days) updateCalc.mutate({ vacation_days: value })
              else e.target.value = String(calc.vacation_days)
            }}
          />
        </div>
      </div>

      <div className="stat-chips" style={{ marginTop: 6 }}>
        <div className="stat-chip blue">
          <span className="value">{workingDays === null ? '—' : fmt(workingDays)}</span>
          <span className="label">Giorni lavorativi</span>
        </div>
        <div className="stat-chip orange">
          <span className="value">{fmt(calc.vacation_days)}</span>
          <span className="label">Giorni di ferie</span>
        </div>
        <div className="stat-chip green">
          <span className="value">{netDays === null ? '—' : fmt(netDays)}</span>
          <span className="label">Giorni lavorativi netti</span>
        </div>
        <div className="stat-chip violet">
          <span className="value">{totalHours === null ? '—' : fmt(totalHours)}</span>
          <span className="label">Ore disponibili totali</span>
        </div>
      </div>
      {workingDays === null && (
        <p className="muted" style={{ marginTop: 0 }}>
          {invalidRange
            ? 'La data di fine è precedente alla data di inizio.'
            : 'Imposta data di inizio e data di fine per calcolare le ore disponibili.'}
        </p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ minWidth: 180 }}>Tipologia di risorsa (DEV)</th>
              <th className="text-right">N. risorse</th>
              <th className="text-right">Ore effettive / giorno</th>
              <th className="text-right">Ore disponibili per risorsa</th>
              <th className="text-right">Ore disponibili</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {calc.resource_types.map((t) => (
              <tr key={`${t.id}|${t.name}|${t.resource_count}|${t.hours_per_day}`}>
                <td className="editable-cell">
                  <input
                    defaultValue={t.name}
                    onBlur={(e) => {
                      const value = e.target.value.trim()
                      if (value && value !== t.name) updateType.mutate({ id: t.id, data: { name: value } })
                      else e.target.value = t.name
                    }}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    className="text-right"
                    defaultValue={t.resource_count}
                    onBlur={(e) => {
                      const value = parseNumber(e.target.value)
                      if (value !== t.resource_count) updateType.mutate({ id: t.id, data: { resource_count: value } })
                      else e.target.value = String(t.resource_count)
                    }}
                  />
                </td>
                <td className="editable-cell">
                  <input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    className="text-right"
                    defaultValue={t.hours_per_day}
                    onBlur={(e) => {
                      const value = Math.min(24, parseNumber(e.target.value))
                      if (value !== t.hours_per_day) updateType.mutate({ id: t.id, data: { hours_per_day: value } })
                      else e.target.value = String(t.hours_per_day)
                    }}
                  />
                </td>
                <td className="text-right">{netDays === null ? '—' : `${fmt(netDays * t.hours_per_day)} h`}</td>
                <td className="text-right">
                  <strong>{hoursOf(t) === null ? '—' : `${fmt(hoursOf(t) ?? 0)} h`}</strong>
                </td>
                <td>
                  <button
                    className="btn btn-danger"
                    title="Elimina la tipologia"
                    onClick={() => confirm(`Eliminare la tipologia "${t.name}"?`) && removeType.mutate(t.id)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {calc.resource_types.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nessuna tipologia di risorsa definita.
                </td>
              </tr>
            )}
          </tbody>
          {calc.resource_types.length > 0 && (
            <tfoot>
              <tr>
                <td>
                  <strong>Totale</strong>
                </td>
                <td className="text-right">
                  <strong>{fmt(totalResources)}</strong>
                </td>
                <td />
                <td />
                <td className="text-right">
                  <strong>{totalHours === null ? '—' : `${fmt(totalHours)} h`}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
