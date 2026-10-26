import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import type { Project, Team } from '../api/types'
import { countBacklogStats, countPlannedUnplannedDone, countsForCodefreeze } from '../lib/backlogStats'
import {
  dateStrToEpochDays,
  epochDaysToDate,
  formatEpochDaysAsDate,
  formatIsoDate,
  parseBackendDateTime,
  toEpochDays,
} from '../lib/dates'
import {
  buildHistory,
  DEFAULT_HISTORY_OPTIONS,
  DEFAULT_ITERATIONS,
  forecastIncrement,
  type HistoryOptions,
} from '../lib/monteCarlo'
import type { McParams } from '../lib/forecastParams'
import { daysOffSet } from '../lib/scheduling'
import { useCycleTimeData } from '../lib/useCycleTimeData'
import { SyncProgressModal } from './SyncProgressModal'

const ISSUE_TYPES = ['Story', 'Bug', 'Activity', 'Task']
const HISTORY_WINDOWS = [
  { days: 90, label: 'ultimi 3 mesi' },
  { days: 180, label: 'ultimi 6 mesi' },
  { days: 365, label: 'ultimo anno' },
]
const TEAM_LABEL: Record<Team, string> = { sw: 'Team SW', embedded: 'Team Embedded' }

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const epochToIso = (day: number | null) => (day === null ? null : epochDaysToDate(day).toISOString().slice(0, 10))
const formatDateTime = (value: string) =>
  parseBackendDateTime(value).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
// Fatto oggi (ora locale)? Serve a proporre l'aggiornamento solo se i dati
// non sono gia' di oggi.
const isToday = (value: string | null | undefined) => {
  if (!value) return false
  const d = parseBackendDateTime(value)
  return d.toDateString() === new Date().toDateString()
}

// "+ Aggiungi simulazione" del Forecasting: propone di aggiornare da Jira il
// backlog (#PBI Remaining/Done) e lo storico Monte Carlo se non sono gia' di
// oggi, poi crea la riga con tutte le colonne calcolate - le stesse della
// pagina Monte Carlo (stessa funzione, stessi parametri di default):
// Completion Likelihood, data all'85%, #PBI entro il code freeze all'85% e
// data all'85% saltando i giorni non lavorativi del team (Backlog).
export function NewSimulationModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [team, setTeam] = useState<Team>('sw')
  const [options, setOptions] = useState<HistoryOptions>(DEFAULT_HISTORY_OPTIONS)
  const [showParams, setShowParams] = useState(false)
  // null = scelta di default (aggiorna se i dati non sono di oggi).
  const [syncBacklogChoice, setSyncBacklogChoice] = useState<boolean | null>(null)
  const [refreshHistoryChoice, setRefreshHistoryChoice] = useState<boolean | null>(null)
  const [step, setStep] = useState<'backlog' | 'history' | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  // Deadline della simulazione: di default il code freeze dell'increment,
  // modificabile per provare scenari senza toccare l'increment.
  const [deadline, setDeadline] = useState<string>(project.code_freeze_date ?? '')
  const [updateIncrementDeadline, setUpdateIncrementDeadline] = useState(false)
  const deadlineChanged = (deadline || null) !== project.code_freeze_date

  const { data: backlogItems } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })
  const { data: nonWorkingDays } = useQuery({
    queryKey: ['non-working-days', project.id],
    queryFn: () => api.nonWorkingDays.list(project.id),
  })
  const cycleTime = useCycleTimeData(team)

  const lastSyncedAt = (backlogItems ?? []).reduce<string | null>(
    (latest, i) => (i.last_synced_at && (!latest || i.last_synced_at > latest) ? i.last_synced_at : latest),
    null,
  )
  const historyData = cycleTime.data && !cycleTime.data.error ? cycleTime.data : undefined
  const syncBacklog = syncBacklogChoice ?? !isToday(lastSyncedAt)
  const refreshHistory = refreshHistoryChoice ?? !isToday(historyData?.fetched_at)

  // Conteggi del backlog: come prima di questo popup.
  const items = backlogItems ?? []
  const { remainingCount } = countBacklogStats(items)
  const done = countPlannedUnplannedDone(items, project.dev_start_date)
  const traditionalForecastIso = items
    .filter((i) => countsForCodefreeze(i) && i.status !== 'Done')
    .reduce<string | null>(
      (latest, i) => (i.expected_finish && (!latest || i.expected_finish > latest) ? i.expected_finish : latest),
      null,
    )

  const today = toEpochDays(new Date(`${todayIso()}T00:00:00Z`))
  const history = useMemo(
    () => (historyData ? buildHistory(historyData.points, options, today) : null),
    [historyData, options, today],
  )
  const daysOff = useMemo(
    () =>
      new Set(
        [...daysOffSet(nonWorkingDays ?? [])].map((iso) => dateStrToEpochDays(iso)).filter((d): d is number => d !== null),
      ),
    [nonWorkingDays],
  )
  const forecast = useMemo(
    () =>
      history && history.itemCount > 0
        ? forecastIncrement({
            samples: history.samples,
            remaining: remainingCount,
            startDay: today,
            deadlineDay: dateStrToEpochDays(deadline || null),
            iterations: DEFAULT_ITERATIONS,
            workingDaysOnly: options.workingDaysOnly,
            daysOff,
          })
        : null,
    [history, remainingCount, today, deadline, options.workingDaysOnly, daysOff],
  )

  // Aggiornamenti da Jira scelti, uno dopo l'altro (ognuno col suo popup di
  // avanzamento). Alla fine le caselle si spengono: i dati sono di oggi.
  const runUpdates = async () => {
    setUpdateError(null)
    try {
      if (syncBacklog) {
        setStep('backlog')
        await api.backlog.sync(project.id)
        await queryClient.refetchQueries({ queryKey: ['backlog', project.id] })
        setSyncBacklogChoice(false)
      }
      if (refreshHistory) {
        setStep('history')
        const fresh = await cycleTime.refresh()
        if (fresh?.error) throw new Error(fresh.error)
        setRefreshHistoryChoice(false)
      }
    } catch (e) {
      setUpdateError((e as Error).message)
    } finally {
      setStep(null)
    }
  }

  const windowLabel = HISTORY_WINDOWS.find((w) => w.days === options.historyDays)?.label ?? `${options.historyDays} giorni`
  const paramsNote =
    `Monte Carlo: ${TEAM_LABEL[team]} · ${options.issueTypes.join('+')}` +
    `${options.excludeCve ? ' (CVE esclusi)' : ''} · ${windowLabel}` +
    `${options.workingDaysOnly ? ' · solo giorni lavorativi' : ''} · ${DEFAULT_ITERATIONS.toLocaleString('it-IT')} simulazioni`

  const create = useMutation({
    mutationFn: async () => {
      // La nuova deadline diventa anche il code freeze dell'increment (Backlog,
      // Gantt, Dashboard...), solo se richiesto.
      if (deadlineChanged && updateIncrementDeadline) {
        await api.projects.update(project.id, { code_freeze_date: deadline || null })
        queryClient.invalidateQueries({ queryKey: ['project', project.id] })
        queryClient.invalidateQueries({ queryKey: ['projects'] })
      }
      return api.forecasting.create(project.id, {
        note: paramsNote,
        simulation_date: todayIso(),
        pbi_remaining: remainingCount,
        pbi_done: done.planned + done.unplanned,
        planned_pbi_done: done.planned,
        unplanned_pbi_done: done.unplanned,
        planned_pbi_keys: done.plannedKeys.join(', ') || null,
        unplanned_pbi_keys: done.unplannedKeys.join(', ') || null,
        code_freeze_deadline: deadline || null,
        traditional_forecasting: formatIsoDate(traditionalForecastIso),
        completion_likelihood: forecast?.likelihood == null ? null : Math.round(forecast.likelihood * 100) / 100,
        completion_date_85pct: epochToIso(forecast?.date85 ?? null),
        pbi_completed_by_deadline_85pct: forecast?.howMany85 ?? null,
        completion_date_85pct_with_holidays: epochToIso(forecast?.date85WithHolidays ?? null),
        // Per ricalcolare le previsioni se poi si cambia la deadline della riga.
        mc_params: forecast
          ? JSON.stringify({
              team,
              options,
              iterations: DEFAULT_ITERATIONS,
              historyFetchedAt: historyData?.fetched_at ?? null,
            } satisfies McParams)
          : null,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forecasting', project.id] })
      onClose()
    },
  })

  const updating = step !== null
  const toggleIssueType = (t: string) =>
    setOptions((o) => ({
      ...o,
      issueTypes: o.issueTypes.includes(t) ? o.issueTypes.filter((x) => x !== t) : [...o.issueTypes, t],
    }))
  const fmtDay = (day: number | null | undefined) => (day == null ? '—' : formatEpochDaysAsDate(day))

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !updating && onClose()}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Nuova simulazione</h3>

        <h4 style={{ margin: '0 0 2px' }}>1. Dati da Jira</h4>
        <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
          Le spunte sono già attive per i dati non aggiornati oggi.
        </p>
        <label className="sim-check">
          <input
            type="checkbox"
            checked={syncBacklog}
            disabled={updating}
            onChange={(e) => setSyncBacklogChoice(e.target.checked)}
          />
          <span>
            <strong>PBI dell'increment</strong> — sincronizza il backlog di questo increment
            <span className="muted"> (ultima sync: {lastSyncedAt ? formatDateTime(lastSyncedAt) : 'mai'})</span>
            <br />
            <span className="muted" style={{ fontSize: 12 }}>
              Quanti PBI restano da chiudere e quanti sono già Done: #PBI Remaining, #PBI Done, Planned/Unplanned e
              Traditional Forecasting. Sono anche il numero di PBI che la simulazione deve chiudere.
            </span>
          </span>
        </label>
        <label className="sim-check">
          <input
            type="checkbox"
            checked={refreshHistory}
            disabled={updating}
            onChange={(e) => setRefreshHistoryChoice(e.target.checked)}
          />
          <span>
            <strong>Storico del team</strong> — riestrai i PBI chiusi dal {TEAM_LABEL[team]} negli ultimi 12 mesi
            <span className="muted">
              {' '}
              ({historyData?.fetched_at ? `estratto il ${formatDateTime(historyData.fetched_at)}` : 'mai estratto'})
            </span>
            <br />
            <span className="muted" style={{ fontSize: 12 }}>
              Il ritmo reale del team (quanti PBI chiude al giorno), di tutti gli increment: Monte Carlo lo usa per
              stimare date e probabilità. È la stessa estrazione della pagina Monte Carlo; è lenta.
            </span>
          </span>
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 4px' }}>
          <button className="btn" disabled={updating || (!syncBacklog && !refreshHistory)} onClick={runUpdates}>
            {updating ? 'Aggiornamento…' : '⟳ Aggiorna da Jira'}
          </button>
          {!syncBacklog && !refreshHistory && !updating && (
            <span className="muted" style={{ fontSize: 12 }}>
              Si usano i dati attuali.
            </span>
          )}
        </div>
        {(updateError || cycleTime.error) && (
          <div className="error-banner">Aggiornamento non riuscito: {updateError ?? cycleTime.error}</div>
        )}

        <h4 style={{ margin: '14px 0 6px' }}>2. Deadline</h4>
        <div className="sim-params" style={{ marginTop: 0 }}>
          <label>
            Code freeze deadline della simulazione{' '}
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            {deadlineChanged && (
              <button type="button" className="link-btn" onClick={() => setDeadline(project.code_freeze_date ?? '')}>
                ripristina ({formatIsoDate(project.code_freeze_date) ?? 'nessuna'})
              </button>
            )}
          </label>
          {deadlineChanged && (
            <label>
              <input
                type="checkbox"
                checked={updateIncrementDeadline}
                onChange={(e) => setUpdateIncrementDeadline(e.target.checked)}
              />{' '}
              Aggiorna anche il code freeze dell'increment (oggi {formatIsoDate(project.code_freeze_date) ?? 'non impostato'}
              ): vale per Backlog, Gantt e Dashboard
            </label>
          )}
        </div>

        <h4 style={{ margin: '14px 0 6px' }}>3. Anteprima della riga</h4>
        {!historyData ? (
          <p className="muted" style={{ margin: 0 }}>
            Storico Monte Carlo non ancora estratto: premi "Aggiorna da Jira" per calcolare le previsioni.
          </p>
        ) : (
          <>
            {history && history.itemCount === 0 && (
              <div className="error-banner">Nessun item completato nello storico scelto: previsioni non calcolabili.</div>
            )}
            <div className="sim-preview">
              <span>#PBI Remaining</span>
              <strong>{remainingCount}</strong>
              <span>#PBI Done (Planned / Unplanned)</span>
              <strong>
                {done.planned + done.unplanned} ({done.planned} / {done.unplanned})
              </strong>
              <span>Code Freeze Deadline</span>
              <strong>{formatIsoDate(deadline || null) ?? '—'}</strong>
              <span>Chance to meet the deadline</span>
              <strong>{forecast?.likelihood == null ? '—' : `${forecast.likelihood.toFixed(0)}%`}</strong>
              <span>85% Completion Date</span>
              <strong>{fmtDay(forecast?.date85)}</strong>
              <span>85% #PBI Completed by Deadline</span>
              <strong>{forecast?.howMany85 ?? '—'}</strong>
              <span>85% Completion Date w/ Holidays</span>
              <strong>
                {fmtDay(forecast?.date85WithHolidays)}
                {daysOff.size === 0 && (
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {' '}
                    (nessun giorno non lavorativo nel Backlog)
                  </span>
                )}
              </strong>
              <span>Traditional Forecasting</span>
              <strong>{formatIsoDate(traditionalForecastIso) ?? '—'}</strong>
            </div>
            {!deadline && (
              <p className="muted" style={{ fontSize: 12 }}>
                Senza deadline, Chance to meet the deadline e #PBI entro la scadenza restano vuoti.
              </p>
            )}
          </>
        )}

        <button type="button" className="link-btn" style={{ marginTop: 10 }} onClick={() => setShowParams((v) => !v)}>
          {showParams ? '▾' : '▸'} Parametri della simulazione
        </button>
        {showParams && (
          <div className="sim-params">
            <label>
              Team{' '}
              <select value={team} disabled={updating} onChange={(e) => setTeam(e.target.value as Team)}>
                <option value="sw">Team SW</option>
                <option value="embedded">Team Embedded</option>
              </select>
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {ISSUE_TYPES.map((t) => (
                <label key={t}>
                  <input type="checkbox" checked={options.issueTypes.includes(t)} onChange={() => toggleIssueType(t)} />{' '}
                  {t}
                </label>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={options.excludeCve}
                  onChange={(e) => setOptions((o) => ({ ...o, excludeCve: e.target.checked }))}
                />{' '}
                Escludi Bug CVE
              </label>
            </div>
            <label>
              Finestra storica{' '}
              <select
                value={options.historyDays}
                onChange={(e) => setOptions((o) => ({ ...o, historyDays: Number(e.target.value) }))}
              >
                {HISTORY_WINDOWS.map((w) => (
                  <option key={w.days} value={w.days}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.workingDaysOnly}
                onChange={(e) => setOptions((o) => ({ ...o, workingDaysOnly: e.target.checked }))}
              />{' '}
              Solo giorni lavorativi
            </label>
          </div>
        )}

        {create.isError && <div className="error-banner">{(create.error as Error).message}</div>}
        <div className="form-actions">
          <button className="btn" disabled={updating} onClick={onClose}>
            Annulla
          </button>
          <button
            className="btn btn-primary"
            disabled={updating || create.isPending || !backlogItems}
            title={!forecast ? 'Senza storico Monte Carlo le colonne delle previsioni restano vuote' : undefined}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creazione…' : forecast ? 'Crea simulazione' : 'Crea senza previsioni'}
          </button>
        </div>
      </div>

      {step === 'backlog' && (
        <SyncProgressModal
          title="Sincronizzazione del backlog da Jira"
          queryKey={['backlog-sync-progress', project.id]}
          fetchProgress={() => api.backlog.syncProgress(project.id)}
        />
      )}
      {step === 'history' && (
        <SyncProgressModal
          title="Estrazione dello storico Monte Carlo da Jira"
          queryKey={['cycle-time-progress', team]}
          fetchProgress={() => api.dashboard.cycleTimeProgress(team)}
        />
      )}
    </div>
  )
}
