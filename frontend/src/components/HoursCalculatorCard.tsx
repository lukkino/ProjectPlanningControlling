import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { api } from '../api/client'
import type { AbsenceKind, HoursCalculator, IncrementResourceType, MemberAbsence, TeamMember } from '../api/types'
import { formatIsoDate, workingDaysBetween } from '../lib/dates'

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

const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Giorni lavorativi (lun-ven) di ferie di una persona dentro il periodo:
// intervalli sovrapposti contano una volta sola.
function absenceDaysInPeriod(absences: MemberAbsence[], start: string | null, end: string | null): number {
  if (!start || !end) return 0
  const days = new Set<string>()
  for (const a of absences) {
    const from = a.start_date > start ? a.start_date : start
    const to = a.end_date < end ? a.end_date : end
    const cursor = new Date(`${from}T00:00:00`)
    const last = new Date(`${to}T00:00:00`)
    while (cursor <= last) {
      const day = cursor.getDay()
      if (day !== 0 && day !== 6) days.add(isoOf(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  return days.size
}

const absenceLabel = (a: MemberAbsence) =>
  a.start_date === a.end_date
    ? formatIsoDate(a.start_date)
    : `${formatIsoDate(a.start_date)} – ${formatIsoDate(a.end_date)}`

const ABSENCE_KINDS: AbsenceKind[] = ['Ferie', 'Malattia', 'Altro']

// Assenze di una persona (ferie, malattia...): un'etichetta per intervallo
// (✕ per toglierlo) e un piccolo form con tipo e due date (la fine parte
// uguale all'inizio: un giorno).
function AbsencesCell({
  member,
  periodStart,
  periodEnd,
  onAdd,
  onRemove,
}: {
  member: TeamMember
  periodStart: string | null
  periodEnd: string | null
  onAdd: (start: string, end: string, kind: AbsenceKind) => void
  onRemove: (id: number) => void
}) {
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<AbsenceKind>('Ferie')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const outside = (a: MemberAbsence) =>
    !!periodStart && !!periodEnd && (a.end_date < periodStart || a.start_date > periodEnd)

  return (
    <div className="member-list">
      {member.absences.map((a) => (
        <span
          key={a.id}
          className={`member-chip kind-${a.kind.toLowerCase()}${outside(a) ? ' outside' : ''}`}
          title={outside(a) ? 'Fuori dal periodo: non toglie ore' : (a.note ?? a.kind)}
        >
          {a.kind !== 'Ferie' && <strong>{a.kind}</strong>}
          {absenceLabel(a)}
          <button type="button" title="Togli questa assenza" onClick={() => onRemove(a.id)}>
            ✕
          </button>
        </span>
      ))}
      {adding ? (
        <span className="absence-form">
          <select value={kind} onChange={(e) => setKind(e.target.value as AbsenceKind)}>
            {ABSENCE_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <input
            type="date"
            value={from}
            min={periodStart ?? undefined}
            max={periodEnd ?? undefined}
            onChange={(e) => {
              setFrom(e.target.value)
              if (!to || to < e.target.value) setTo(e.target.value)
            }}
          />
          –
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          <button
            type="button"
            className="btn"
            disabled={!from || !to || to < from}
            onClick={() => {
              onAdd(from, to, kind)
              setFrom('')
              setTo('')
              setKind('Ferie')
              setAdding(false)
            }}
          >
            Aggiungi
          </button>
          <button type="button" className="btn" onClick={() => setAdding(false)}>
            Annulla
          </button>
        </span>
      ) : (
        <button type="button" className="link-btn" onClick={() => setAdding(true)}>
          + ferie / malattia
        </button>
      )}
    </div>
  )
}

// Capacity Planner (ex Calcolatore ore progetto): ore lavorative disponibili
// nel periodo. Ogni tipologia di risorsa si espande nelle persone del team:
// per ognuna (giorni disponibili - sue ferie/malattie) x le sue ore al giorno,
// dove i giorni disponibili (lun-ven tra le due date meno festivita' e
// chiusure comuni) sono gli stessi per tutti. Una
// tipologia senza persone resta stimata come prima: giorni netti x numero di
// risorse x ore al giorno.
export function HoursCalculatorCard({ incrementId, projectStartDate, projectEndDate }: Props) {
  const queryClient = useQueryClient()
  const queryKey = ['hours-calculator', incrementId]
  const { data: calc, error: loadError } = useQuery({ queryKey, queryFn: () => api.hoursCalculator.get(incrementId) })
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

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
  const addMember = useMutation({
    mutationFn: ({ typeId, name }: { typeId: number; name: string }) => api.hoursCalculator.addMember(typeId, { name }),
    onSuccess: invalidate,
  })
  const updateMember = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Pick<TeamMember, 'name' | 'hours_per_day'>> }) =>
      api.hoursCalculator.updateMember(id, data),
    onSuccess: invalidate,
  })
  const removeMember = useMutation({
    mutationFn: (id: number) => api.hoursCalculator.removeMember(id),
    onSuccess: invalidate,
  })
  const addAbsence = useMutation({
    mutationFn: ({ memberId, start, end, kind }: { memberId: number; start: string; end: string; kind: AbsenceKind }) =>
      api.hoursCalculator.addAbsence(memberId, { start_date: start, end_date: end, kind }),
    onSuccess: invalidate,
  })
  const removeAbsence = useMutation({
    mutationFn: (id: number) => api.hoursCalculator.removeAbsence(id),
    onSuccess: invalidate,
  })

  // "Aggiorna ore progetto": copia le ore calcolate nel Dettaglio budget ore
  // progetto (le righe con lo stesso nome tengono le ore delle review).
  const publish = useMutation({
    mutationFn: (rows: { name: string; resource_count: number; hours: number }[]) =>
      api.hoursDetail.setRows(incrementId, rows),
    onSuccess: (saved) => queryClient.setQueryData(['hours-detail', incrementId], saved),
  })

  const error =
    updateCalc.error ??
    updateType.error ??
    addType.error ??
    removeType.error ??
    addMember.error ??
    updateMember.error ??
    removeMember.error ??
    addAbsence.error ??
    removeAbsence.error ??
    publish.error

  // Errore di caricamento: la card resta visibile col messaggio, invece di
  // sparire come durante il caricamento.
  if (loadError)
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Capacity Planner</h3>
        <div className="error-banner">Caricamento non riuscito: {(loadError as Error).message}</div>
      </div>
    )
  if (!calc) return null

  const startDate = calc.start_date ?? projectStartDate
  const endDate = calc.end_date ?? projectEndDate
  const workingDays = workingDaysBetween(startDate, endDate)
  const netDays = workingDays === null ? null : Math.max(0, workingDays - calc.vacation_days)
  const invalidRange = !!startDate && !!endDate && endDate < startDate

  // I giorni disponibili sono quelli lavorativi del periodo, uguali per
  // tutti; ferie e malattie di una persona tolgono solo le sue ore effettive.
  const memberAbsenceDays = (m: TeamMember) => absenceDaysInPeriod(m.absences, startDate, endDate)
  const memberHours = (m: TeamMember) =>
    netDays === null ? null : Math.max(0, netDays - memberAbsenceDays(m)) * m.hours_per_day

  // Valori di una tipologia: dalle persone se ce ne sono, altrimenti stimati.
  const typeResources = (t: IncrementResourceType) => (t.members.length > 0 ? t.members.length : t.resource_count)
  const typeAbsenceDays = (t: IncrementResourceType) => t.members.reduce((sum, m) => sum + memberAbsenceDays(m), 0)
  const hoursOf = (t: IncrementResourceType) =>
    netDays === null
      ? null
      : t.members.length > 0
        ? t.members.reduce((sum, m) => sum + (memberHours(m) ?? 0), 0)
        : netDays * t.resource_count * t.hours_per_day

  // Ore che la tipologia puo' lavorare in un giorno senza ferie: somma delle
  // ore/giorno delle persone, o risorse x ore/giorno se e' solo stimata.
  const typeDailyHours = (t: IncrementResourceType) =>
    t.members.length > 0 ? t.members.reduce((sum, m) => sum + m.hours_per_day, 0) : t.resource_count * t.hours_per_day

  const totalResources = calc.resource_types.reduce((sum, t) => sum + typeResources(t), 0)
  const totalDailyHours = calc.resource_types.reduce((sum, t) => sum + typeDailyHours(t), 0)
  const totalAbsenceDays = calc.resource_types.reduce((sum, t) => sum + typeAbsenceDays(t), 0)
  const totalHours = netDays === null ? null : calc.resource_types.reduce((sum, t) => sum + (hoursOf(t) ?? 0), 0)
  const teamSize = calc.resource_types.reduce((sum, t) => sum + t.members.length, 0)

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handlePublish = () => {
    if (netDays === null) return
    if (!confirm('Aggiornare il Dettaglio budget ore progetto con le ore calcolate qui? Eventuali ore corrette a mano (es. arrotondate) vengono sovrascritte; le ore delle review restano.')) return
    publish.mutate(
      calc.resource_types.map((t) => ({ name: t.name, resource_count: typeResources(t), hours: hoursOf(t) ?? 0 })),
    )
  }

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Capacity Planner</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => addType.mutate()}>
            + Aggiungi tipologia
          </button>
          <button
            className="btn btn-primary"
            disabled={netDays === null || calc.resource_types.length === 0 || publish.isPending}
            title={
              netDays === null
                ? 'Imposta data di inizio e data di fine per calcolare le ore'
                : 'Copia le ore calcolate nel Dettaglio budget ore progetto'
            }
            onClick={handlePublish}
          >
            {publish.isPending ? 'Aggiornamento…' : '↑ Aggiorna ore progetto'}
          </button>
        </div>
      </div>
      {publish.isSuccess && (
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Dettaglio budget ore progetto aggiornato.
        </p>
      )}
      <p className="muted" style={{ marginTop: 0 }}>
        Giorni disponibili = lunedì-venerdì tra le due date (estremi compresi) − festività e chiusure: sono gli stessi
        per tutti. Espandi una tipologia (▸) per inserire le persone del team con le ore disponibili al giorno e le
        loro ferie o malattie: ore effettive di una persona = (giorni disponibili − sue assenze) × sue ore al giorno, e
        le ore della tipologia sono la somma delle loro. Una tipologia senza persone resta stimata: giorni disponibili
        × numero di risorse × ore al giorno.
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
          <label>Festività e chiusure (giorni, per tutti)</label>
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
          <span className="label">Festività e chiusure</span>
        </div>
        <div className="stat-chip green">
          <span className="value">{netDays === null ? '—' : fmt(netDays)}</span>
          <span className="label">Giorni disponibili</span>
        </div>
        <div className="stat-chip orange">
          <span className="value">{fmt(totalAbsenceDays)}</span>
          <span className="label">Giorni di ferie e malattia del team</span>
        </div>
        <div className="stat-chip violet">
          <span className="value">{totalHours === null ? '—' : `${fmt(totalHours)} h`}</span>
          <span className="label">Capacity totale del team</span>
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
              <th style={{ minWidth: 200 }}>Tipologia di risorsa / persona</th>
              <th className="text-right">N. risorse</th>
              <th className="text-right">Ore produttive / giorno</th>
              <th className="text-right">Giorni disponibili</th>
              <th style={{ minWidth: 220 }}>Ferie e malattie</th>
              <th className="text-right">Ore effettive</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {calc.resource_types.map((t) => {
              const open = expanded.has(t.id)
              const hasMembers = t.members.length > 0
              const hours = hoursOf(t)
              return (
                <Fragment key={t.id}>
                  <tr key={`${t.id}|${t.name}|${t.resource_count}|${t.hours_per_day}`} className="capacity-type-row">
                    <td className="editable-cell">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                          type="button"
                          className="expand-btn"
                          title={open ? 'Nascondi le persone' : 'Mostra le persone del team'}
                          onClick={() => toggle(t.id)}
                        >
                          {open ? '▾' : '▸'}
                        </button>
                        <input
                          defaultValue={t.name}
                          onBlur={(e) => {
                            const value = e.target.value.trim()
                            if (value && value !== t.name) updateType.mutate({ id: t.id, data: { name: value } })
                            else e.target.value = t.name
                          }}
                        />
                        {hasMembers && (
                          <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                            {t.members.length} {t.members.length === 1 ? 'persona' : 'persone'}
                          </span>
                        )}
                      </div>
                    </td>
                    {hasMembers ? (
                      <td className="text-right" title="Numero di persone del team in questa tipologia">
                        {t.members.length}
                      </td>
                    ) : (
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
                    )}
                    {hasMembers ? (
                      <td className="text-right" title="Somma delle ore al giorno delle persone">
                        <strong>{fmt(typeDailyHours(t))} h</strong>
                      </td>
                    ) : (
                      <td className="editable-cell" title="Ore al giorno di ciascuna risorsa">
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
                        {t.resource_count !== 1 && (
                          <div className="muted text-right" style={{ fontSize: 11 }}>
                            = {fmt(typeDailyHours(t))} h in tutto
                          </div>
                        )}
                      </td>
                    )}
                    <td className="text-right">{netDays === null ? '—' : fmt(netDays)}</td>
                    <td className="muted">
                      {hasMembers && typeAbsenceDays(t) > 0 && `${fmt(typeAbsenceDays(t))} gg in tutto`}
                    </td>
                    <td className="text-right">
                      <strong>{hours === null ? '—' : `${fmt(hours)} h`}</strong>
                    </td>
                    <td>
                      <button
                        className="btn btn-danger"
                        title="Elimina la tipologia"
                        onClick={() =>
                          confirm(
                            hasMembers
                              ? `Eliminare la tipologia "${t.name}" e le sue ${t.members.length} persone?`
                              : `Eliminare la tipologia "${t.name}"?`,
                          ) && removeType.mutate(t.id)
                        }
                      >
                        ✕
                      </button>
                    </td>
                  </tr>

                  {open &&
                    t.members.map((m) => {
                      const mAbsence = memberAbsenceDays(m)
                      const mHours = memberHours(m)
                      return (
                        <tr key={`${m.id}|${m.name}|${m.hours_per_day}`} className="capacity-member-row">
                          <td className="editable-cell" style={{ paddingLeft: 32 }}>
                            <input
                              defaultValue={m.name}
                              onBlur={(e) => {
                                const value = e.target.value.trim()
                                if (value && value !== m.name) updateMember.mutate({ id: m.id, data: { name: value } })
                                else e.target.value = m.name
                              }}
                            />
                          </td>
                          <td />
                          <td className="editable-cell">
                            <input
                              type="number"
                              min={0}
                              max={24}
                              step={0.5}
                              className="text-right"
                              defaultValue={m.hours_per_day}
                              onBlur={(e) => {
                                const value = Math.min(24, parseNumber(e.target.value))
                                if (value !== m.hours_per_day)
                                  updateMember.mutate({ id: m.id, data: { hours_per_day: value } })
                                else e.target.value = String(m.hours_per_day)
                              }}
                            />
                          </td>
                          <td className="text-right">{netDays === null ? '—' : fmt(netDays)}</td>
                          <td>
                            <AbsencesCell
                              member={m}
                              periodStart={startDate}
                              periodEnd={endDate}
                              onAdd={(start, end, kind) => addAbsence.mutate({ memberId: m.id, start, end, kind })}
                              onRemove={(id) => removeAbsence.mutate(id)}
                            />
                          </td>
                          <td className="text-right">
                            {mHours === null ? '—' : `${fmt(mHours)} h`}
                            {mAbsence > 0 && (
                              <div className="muted" style={{ fontSize: 11 }}>
                                {fmt(mAbsence)} gg di assenza
                              </div>
                            )}
                          </td>
                          <td>
                            <button
                              className="btn btn-danger"
                              title="Togli la persona dal team"
                              onClick={() => confirm(`Togliere ${m.name} dal team?`) && removeMember.mutate(m.id)}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      )
                    })}

                  {open && (
                    <tr className="capacity-member-row">
                      <td className="editable-cell" style={{ paddingLeft: 32 }}>
                        <input
                          placeholder="+ Aggiungi persona (Invio)"
                          onKeyDown={(e) => {
                            const name = e.currentTarget.value.trim()
                            if (e.key === 'Enter' && name) {
                              addMember.mutate({ typeId: t.id, name })
                              e.currentTarget.value = ''
                            }
                          }}
                        />
                      </td>
                      <td />
                      {/* Ore al giorno proposte alle persone nuove della tipologia. */}
                      <td className="editable-cell" title="Ore al giorno proposte per le persone nuove">
                        <input
                          key={`${t.id}|${t.hours_per_day}`}
                          type="number"
                          min={0}
                          max={24}
                          step={0.5}
                          className="text-right muted"
                          defaultValue={t.hours_per_day}
                          onBlur={(e) => {
                            const value = Math.min(24, parseNumber(e.target.value))
                            if (value !== t.hours_per_day) updateType.mutate({ id: t.id, data: { hours_per_day: value } })
                            else e.target.value = String(t.hours_per_day)
                          }}
                        />
                      </td>
                      <td colSpan={4} className="muted" style={{ fontSize: 12 }}>
                        ← ore al giorno proposte per le persone nuove
                        {!hasMembers && `. Con la prima persona le ore di ${t.name} si calcolano dal team.`}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {calc.resource_types.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
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
                  {teamSize > 0 && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      {' '}
                      ({teamSize} {teamSize === 1 ? 'persona' : 'persone'} nel team)
                    </span>
                  )}
                </td>
                <td className="text-right">
                  <strong>{fmt(totalResources)}</strong>
                </td>
                <td className="text-right" title="Ore che il team può lavorare in un giorno senza ferie">
                  <strong>{fmt(totalDailyHours)} h</strong>
                </td>
                <td className="text-right">
                  <strong>{netDays === null ? '—' : fmt(netDays)}</strong>
                </td>
                <td className="muted">{totalAbsenceDays > 0 && `${fmt(totalAbsenceDays)} gg in tutto`}</td>
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
