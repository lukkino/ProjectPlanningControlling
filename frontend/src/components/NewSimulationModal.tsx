import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
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
  historyStartDay,
  type HistoryOptions,
} from '../lib/monteCarlo'
import type { McParams } from '../lib/forecastParams'
import { daysOffSet } from '../lib/scheduling'
import { useCycleTimeData } from '../lib/useCycleTimeData'
import { SyncProgressModal } from './SyncProgressModal'
import { DateInput } from './DateInput'
import { HistoryWindowSelect } from './HistoryWindowSelect'
import { coverageWarning, readStoredOptions, storeOptions, windowLabel } from '../lib/historyWindow'

const ISSUE_TYPES = ['Story', 'Bug', 'Activity', 'Task']
const TEAM_LABEL: Record<Team, string> = { sw: 'Team SW', embedded: 'Team Embedded' }

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const epochToIso = (day: number | null) => (day === null ? null : epochDaysToDate(day).toISOString().slice(0, 10))
const formatDateTime = (value: string) =>
  parseBackendDateTime(value).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
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
  // Parametri dello storico: gli ultimi scelti (qui o in Monte Carlo), dal
  // browser, cosi' le due pagine usano gli stessi.
  const [options, setOptions] = useState<HistoryOptions>(() => readStoredOptions(DEFAULT_HISTORY_OPTIONS))
  useEffect(() => storeOptions(options), [options])
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

  const { data: phases } = useQuery({
    queryKey: ['phases', project.id],
    queryFn: () => api.phases.list(project.id),
  })
  const codeFreezePhase = phases?.find((p) => p.name.trim().toLowerCase().replace('-', ' ') === 'code freeze')
  const { data: backlogItems } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })
  const { data: nonWorkingDays } = useQuery({
    queryKey: ['non-working-days', project.id],
    queryFn: () => api.nonWorkingDays.list(project.id),
  })
  const cycleTime = useCycleTimeData(team, options.historyFrom)

  const lastSyncedAt = (backlogItems ?? []).reduce<string | null>(
    (latest, i) => (i.last_synced_at && (!latest || i.last_synced_at > latest) ? i.last_synced_at : latest),
    null,
  )
  const historyData = cycleTime.data && !cycleTime.data.error ? cycleTime.data : undefined
  const syncBacklog = syncBacklogChoice ?? !isToday(lastSyncedAt)
  // Storico da un file CSV: la riestrazione da Jira lo sostituirebbe, quindi
  // non si propone da sola (si avvisa nei Controlli se il file e' vecchio).
  const historyFromFile = !!historyData?.source
  const refreshHistory = refreshHistoryChoice ?? (!historyFromFile && !isToday(historyData?.fetched_at))

  // Conteggi del backlog: come prima di questo popup.
  const items = backlogItems ?? []
  const { remainingCount } = countBacklogStats(items)
  // Planned/Unplanned PBI Done: dalle JQL (dell'increment o predefinite,
  // come nel foglio Excel), altrimenti dalle label del backlog. Senza JQL il
  // backend risponde subito, senza chiamare Jira.
  const doneJql = useQuery({
    queryKey: ['done-counts', project.id],
    queryFn: () => api.forecasting.doneCounts(project.id),
  })
  const byLabels = countPlannedUnplannedDone(items, project.dev_start_date)
  const plannedKeys = doneJql.data?.planned.keys ?? byLabels.plannedKeys
  const unplannedKeys = doneJql.data?.unplanned.keys ?? byLabels.unplannedKeys
  const done = { planned: plannedKeys.length, unplanned: unplannedKeys.length, plannedKeys, unplannedKeys }
  const doneSource = (part: 'planned' | 'unplanned') => {
    const source = doneJql.data?.[part].source
    return source === 'increment' ? "JQL dell'increment" : source === 'default' ? 'JQL predefinita' : 'label'
  }
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
        await doneJql.refetch()
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

  const windowText = windowLabel(options)
  const coverage = coverageWarning(
    historyData,
    epochDaysToDate(historyStartDay(options, dateStrToEpochDays(todayIso()) as number)).toISOString().slice(0, 10),
  )
  const paramsNote =
    `Monte Carlo: ${TEAM_LABEL[team]} · ${options.issueTypes.join('+')}` +
    `${options.excludeCve ? ' (CVE esclusi)' : ''} · ${windowText}` +
    `${options.workingDaysOnly ? ' · solo giorni lavorativi' : ''} · ${DEFAULT_ITERATIONS.toLocaleString('it-IT')} simulazioni`

  const create = useMutation({
    mutationFn: async () => {
      // La nuova deadline diventa anche il code freeze ufficiale (data
      // aggiornata della fase Code freeze: Backlog, Gantt, Dashboard...),
      // solo se richiesto.
      if (deadlineChanged && updateIncrementDeadline && codeFreezePhase) {
        await api.phases.update(codeFreezePhase.id, { planned_date: deadline || null })
        queryClient.invalidateQueries({ queryKey: ['project', project.id] })
        queryClient.invalidateQueries({ queryKey: ['projects'] })
        queryClient.invalidateQueries({ queryKey: ['phases', project.id] })
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

  // Controlli prima di creare la riga: dati di oggi, storico che copre la
  // finestra, da dove vengono i PBI Done e i parametri usati (in vista).
  const checks: { label: string; ok: boolean; detail: string; action?: React.ReactNode }[] = [
    {
      label: 'Backlog',
      ok: isToday(lastSyncedAt),
      detail: lastSyncedAt
        ? `sincronizzato ${isToday(lastSyncedAt) ? 'oggi' : 'il ' + formatDateTime(lastSyncedAt)}`
        : 'mai sincronizzato',
    },
    {
      label: 'Storico',
      ok: !!historyData && isToday(historyData.fetched_at),
      detail: !historyData
        ? 'non caricato'
        : `${historyFromFile ? `file ${historyData.source}` : 'Jira'}, ${
            isToday(historyData.fetched_at) ? 'aggiornato oggi' : `del ${historyData.fetched_at ? formatDateTime(historyData.fetched_at) : "?"}`
          }${history ? ` · ${history.itemCount} item nella finestra` : ''}`,
    },
    ...(coverage ? [{ label: 'Finestra storica', ok: false, detail: coverage }] : []),
    {
      label: 'PBI Done',
      ok: !doneJql.isError,
      detail: doneJql.isError
        ? 'JQL non eseguita, si usano le label del backlog'
        : `Planned da ${doneSource('planned')}, Unplanned da ${doneSource('unplanned')}`,
    },
    {
      label: 'Parametri',
      ok: true,
      detail: paramsNote.replace(/^Monte Carlo: /, ''),
      action: (
        <>
          {' '}
          <button type="button" className="link-btn" onClick={() => setShowParams(true)}>
            modifica
          </button>
        </>
      ),
    },
  ]
  const warnings = checks.filter((c) => !c.ok).length
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
            <strong>Storico del team</strong> — riestrai da Jira i PBI chiusi dal {TEAM_LABEL[team]}
            <span className="muted">
              {' '}
              (
              {historyData?.fetched_at
                ? historyFromFile
                  ? `ora dal file ${historyData.source}, caricato il ${formatDateTime(historyData.fetched_at)}: riestraendo da Jira lo sostituisci`
                  : `estratto da Jira il ${formatDateTime(historyData.fetched_at)}`
                : 'mai estratto'}
              )
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
          <label
            className="btn"
            title="Storico da un file CSV pre-elaborato (ID, Developing, Done, Issue Type), come nella pagina Monte Carlo"
            style={{ cursor: updating || cycleTime.isImporting ? 'default' : 'pointer' }}
          >
            {cycleTime.isImporting ? 'Caricamento…' : '📄 Carica storico da file'}
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              disabled={updating || cycleTime.isImporting}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) {
                  cycleTime.importFile(file)
                  setRefreshHistoryChoice(false)
                }
                e.target.value = ''
              }}
            />
          </label>
          {!syncBacklog && !refreshHistory && !updating && (
            <span className="muted" style={{ fontSize: 12 }}>
              Si usano i dati attuali.
            </span>
          )}
        </div>
        {cycleTime.importError && <div className="error-banner">File non caricato: {cycleTime.importError}</div>}
        {(updateError || cycleTime.error) && (
          <div className="error-banner">Aggiornamento non riuscito: {updateError ?? cycleTime.error}</div>
        )}

        <h4 style={{ margin: '14px 0 6px' }}>2. Deadline</h4>
        <div className="sim-params" style={{ marginTop: 0 }}>
          <label>
            Code freeze deadline della simulazione{' '}
            <DateInput value={deadline} onChange={(value) => setDeadline(value ?? '')} />
            {deadlineChanged && (
              <button type="button" className="link-btn" onClick={() => setDeadline(project.code_freeze_date ?? '')}>
                ripristina ({formatIsoDate(project.code_freeze_date) ?? 'nessuna'})
              </button>
            )}
          </label>
          {deadlineChanged && codeFreezePhase && (
            <label>
              <input
                type="checkbox"
                checked={updateIncrementDeadline}
                onChange={(e) => setUpdateIncrementDeadline(e.target.checked)}
              />{' '}
              Aggiorna anche il code freeze ufficiale, cioè la data aggiornata della fase Code freeze (oggi{' '}
              {formatIsoDate(project.code_freeze_date) ?? 'non impostato'}): vale per Backlog, Gantt e Dashboard
            </label>
          )}
        </div>

        <h4 style={{ margin: '14px 0 6px' }}>3. Anteprima della riga</h4>
        {doneJql.isError && (
          <div className="error-banner">
            {(doneJql.error as Error).message} — per i PBI Done si usano le label del backlog.
          </div>
        )}
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
                {doneJql.isLoading ? (
                  'lettura delle JQL…'
                ) : (
                  <>
                    {done.planned + done.unplanned} ({done.planned} / {done.unplanned})
                    <span className="muted sim-done-source">
                      {' '}
                      · Planned da {doneSource('planned')}, Unplanned da {doneSource('unplanned')}
                    </span>
                  </>
                )}
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
              <HistoryWindowSelect
                compact
                value={options}
                onChange={(value) => setOptions((o) => ({ ...o, ...value }))}
              />
            </label>
            {coverage && <div className="history-coverage">⚠ {coverage}</div>}
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

        <h4 style={{ margin: '14px 0 6px' }}>Controlli prima di creare</h4>
        <ul className="sim-checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? 'ok' : 'warn'}>
              <span className="sim-check-icon">{c.ok ? '✓' : '⚠'}</span>
              <span>
                <b>{c.label}</b> — {c.detail}
                {c.action}
              </span>
            </li>
          ))}
        </ul>

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
            {create.isPending
              ? 'Creazione…'
              : !forecast
                ? 'Crea senza previsioni'
                : warnings > 0
                  ? `Crea comunque (${warnings} ${warnings === 1 ? 'avviso' : 'avvisi'})`
                  : 'Crea simulazione'}
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
