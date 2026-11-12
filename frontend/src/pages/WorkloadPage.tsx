import { Fragment, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { WorkloadAssignee, WorkloadItem } from '../api/types'
import { WorkloadTeam } from '../components/WorkloadTeam'
import { SyncProgressModal } from '../components/SyncProgressModal'
import { useAuth } from '../components/authContext'
import { formatDateTime, formatIsoDate } from '../lib/dates'

// Carico per assegnatario su tutti gli increment: le ore rimanenti degli item
// aperti distribuite sulle settimane del piano (regole in
// backend/app/services/workload.py), confrontate con la capacita' (giorni
// lavorativi x ore al giorno).

const JIRA_BROWSE = 'https://inpeco.atlassian.net/browse/'
const WEEK_OPTIONS = [8, 12, 26]
const HOURS_KEY = 'workload-hours-per-day-v1'
const WEEKS_KEY = 'workload-weeks-v1'
const HIDDEN_KEY = 'workload-hidden-projects-v1'

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // preferenza solo locale: se lo storage non c'e' si perde e basta
  }
}

function loadTone(hours: number, capacity: number): string {
  if (hours < 0.5) return ''
  if (capacity <= 0) return 'wl-over'
  const ratio = hours / capacity
  if (ratio > 1.05) return 'wl-over'
  if (ratio >= 0.8) return 'wl-full'
  if (ratio >= 0.4) return 'wl-mid'
  return 'wl-low'
}

const h = (value: number) => (value < 0.5 ? '' : String(Math.round(value)))

function weekLabel(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

function WorkloadInfoModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wl-info" role="dialog" aria-label="Come è calcolato il carico" onClick={(e) => e.stopPropagation()}>
        <div className="wl-info-head">
          <h3>Come è calcolato il carico</h3>
          <button type="button" className="btn" onClick={onClose} aria-label="Chiudi">
            ✕
          </button>
        </div>

        <h4>Item considerati</h4>
        <p>
          Gli item del piano di tutti i tuoi increment non ancora <b>Done</b>, con lo stesso perimetro dell'Earned Value:
          in scope, nel code freeze o attività per Release, senza milestone e senza item archiviati.
        </p>

        <h4>Ore rimanenti</h4>
        <p>
          <b>budget × (1 − % di completamento)</b>, con le regole dell'Earned Value:
        </p>
        <ul>
          <li>budget = stima dev + stima test; se mancano, Sizing (giorni) × 8 h;</li>
          <li>% di completamento = ore loggate su Jira / budget, al massimo 95% finché l'item non è Done.</li>
        </ul>

        <h4>Distribuzione nelle settimane</h4>
        <p>
          Le ore rimanenti sono spalmate in modo uniforme sui giorni lavorativi tra <b>Start pian.</b> (o oggi, se è già
          passato) e <b>Fine pian.</b>, saltando sabati, domeniche e i giorni non lavorativi dell'increment. Le ore dopo
          l'ultima settimana mostrata finiscono nella colonna <b>Oltre</b>.
        </p>

        <h4>Capacità</h4>
        <p>
          <b>(giorni lavorativi della settimana − assenze) × ore al giorno della persona</b>, per chi è nella scheda{' '}
          <b>Team</b> (ruoli, persone, ore al giorno e ferie). Per chi non c'è valgono i giorni lavorativi × le ore al
          giorno impostate in alto (8 di default): abbassale se le persone non sono dedicate al 100% a questi increment.
        </p>
        <ul>
          <li>
            le ore degli item di una persona del Team vanno solo sui giorni in cui c'è: le ferie spostano le ore sugli
            altri giorni dell'item (se l'item cade tutto nelle ferie, restano lì e la settimana risulta oltre la
            capacità: va ripianificato);
          </li>
          <li>la settimana in corso conta solo i giorni da oggi in poi;</li>
          <li>
            un giorno è libero per una persona solo se è non lavorativo in tutti gli increment su cui ha item.
          </li>
        </ul>

        <h4>Colori</h4>
        <div className="wl-legend wl-info-legend">
          <span className="wl-low">&lt; 40%</span>
          <span className="wl-mid">40–80%</span>
          <span className="wl-full">80–105%</span>
          <span className="wl-over">&gt; 105%</span>
        </div>
        <p>
          Ore della settimana rispetto alla capacità. Passando sopra una cella vedi ore, capacità e percentuale. La riga{' '}
          <i>Non assegnato</i> non ha colori, perché non ha una capacità.
        </p>

        <h4>Scadute</h4>
        <p>
          Le ore degli item con Fine pian. già passata <b>non</b> vanno nella settimana corrente (la riempirebbero di
          colpo) ma nella colonna <b>Scadute</b>: sono item da ripianificare.
        </p>

        <h4>Da sapere</h4>
        <ul>
          <li>
            un item che finisce in questa settimana concentra le ore rimaste nei pochi giorni che mancano, quindi la
            colonna <b>Questa</b> tende a essere più carica;
          </li>
          <li>
            gli item <b>senza date</b> (senza Fine pian.) e <b>senza stima</b> (né stima né Sizing) sono segnalati
            accanto al nome: le loro ore non sono nelle settimane;
          </li>
          <li>se le stime dev/test sono vuote, le ore vengono dal Sizing (indicato «da Sizing» nel dettaglio).</li>
        </ul>

        <h4>Uso</h4>
        <ul>
          <li>
            clicca una persona per vedere i suoi item: la chiave apre il PBI in Jira, il nome dell'increment sotto il PBI
            apre il suo Backlog;
          </li>
          <li>
            <b>⟳ Sincronizza da Jira</b> aggiorna, uno dopo l'altro, il backlog di tutti gli increment spuntati che hanno
            una JQL (come il pulsante del Backlog); accanto c'è la data della sync meno recente;
          </li>
          <li>con le spunte in alto togli singoli increment dal calcolo;</li>
          <li>settimane, ore al giorno e increment nascosti restano memorizzati in questo browser.</li>
        </ul>
      </div>
    </div>
  )
}

type Row = WorkloadAssignee & { visibleItems: WorkloadItem[] }

export function WorkloadPage() {
  const [weeks, setWeeks] = useState<number>(() => readStored(WEEKS_KEY, 12))
  const [hoursPerDay, setHoursPerDay] = useState<number>(() => readStored(HOURS_KEY, 8))
  const [hidden, setHidden] = useState<number[]>(() => readStored(HIDDEN_KEY, []))
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showInfo, setShowInfo] = useState(false)
  const [tab, setTab] = useState<'load' | 'team'>('load')
  const { can } = useAuth()
  const queryClient = useQueryClient()
  // Sync in corso: l'increment che si sta sincronizzando (per il popup di
  // avanzamento) e la sua posizione nella sequenza.
  const [syncing, setSyncing] = useState<{ id: number; name: string; index: number; total: number } | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['workload', weeks],
    queryFn: () => api.dashboard.workload(weeks),
  })

  // Il filtro per increment si applica qui: i totali di ogni persona sono
  // ricalcolati dai suoi item visibili.
  const rows: Row[] = useMemo(() => {
    if (!data) return []
    const hiddenSet = new Set(hidden)
    return data.assignees
      .map((a) => {
        const visibleItems = a.items.filter((i) => !hiddenSet.has(i.project_id))
        const sum = (f: (i: WorkloadItem) => number) => visibleItems.reduce((t, i) => t + f(i), 0)
        return {
          ...a,
          visibleItems,
          weeks: a.weeks.map((_, w) => sum((i) => i.weeks[w])),
          beyond_hours: sum((i) => i.beyond_hours),
          remaining_hours: sum((i) => i.remaining_hours ?? 0),
          overdue_hours: sum((i) => (i.overdue ? (i.remaining_hours ?? 0) : 0)),
          overdue_items: visibleItems.filter((i) => i.overdue).length,
          undated_items: visibleItems.filter((i) => !i.finish).length,
          unbudgeted_items: visibleItems.filter((i) => i.remaining_hours === null).length,
        }
      })
      .filter((a) => a.visibleItems.length > 0)
  }, [data, hidden])

  const syncable = (data?.projects ?? []).filter((p) => p.has_jql && !hidden.includes(p.id))
  const lastSync = syncable
    .map((p) => p.last_synced_at)
    .filter((v): v is string => !!v)
    .sort()[0]

  // Sincronizza da Jira, uno dopo l'altro, gli increment spuntati che hanno
  // una JQL: stessa sync del pulsante del Backlog. Un errore su un increment
  // non ferma gli altri.
  const syncAll = useMutation({
    mutationFn: async () => {
      const results: { name: string; ok: boolean; message: string }[] = []
      for (const [index, p] of syncable.entries()) {
        setSyncing({ id: p.id, name: p.name, index: index + 1, total: syncable.length })
        try {
          const r = await api.backlog.sync(p.id)
          results.push({ name: p.name, ok: true, message: `${r.created} nuove, ${r.updated} aggiornate` })
        } catch (e) {
          results.push({ name: p.name, ok: false, message: (e as Error).message })
        }
      }
      return results
    },
    onSettled: () => {
      setSyncing(null)
      void queryClient.invalidateQueries()
    },
  })

  const toggleProject = (id: number) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]
    setHidden(next)
    store(HIDDEN_KEY, next)
  }
  const toggleRow = (name: string) => {
    const next = new Set(open)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpen(next)
  }

  // Ore disponibili della settimana: dal Team se la persona c'e', se no
  // giorni lavorativi x le ore/giorno impostate qui.
  const capacityOf = (r: WorkloadAssignee, w: number) => r.capacity_hours?.[w] ?? r.capacity_days[w] * hoursPerDay
  const overloaded = rows.filter(
    (r) => r.name !== 'Non assegnato' && r.weeks.some((hrs, w) => hrs >= 0.5 && hrs > capacityOf(r, w) * 1.05),
  ).length
  const assigneeNames = (data?.assignees ?? []).map((a) => a.name).filter((n) => n !== 'Non assegnato')
  const outsideTeam = rows.filter((r) => r.name !== 'Non assegnato' && !r.role).length

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Carico per assegnatario</h1>
          <div className="sub">
            Ore rimanenti degli item aperti di tutti gli increment, distribuite tra Start e Fine pianificata, contro la
            capacità della settimana.
          </div>
        </div>
        <div className="wl-actions">
          {can('editor') && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={syncAll.isPending || syncable.length === 0}
              onClick={() => syncAll.mutate()}
              title={`Sincronizza da Jira il backlog di: ${syncable.map((p) => p.name).join(', ') || 'nessun increment con JQL'}`}
            >
              ⟳ Sincronizza da Jira
            </button>
          )}
          <button type="button" className="btn" onClick={() => setShowInfo(true)}>
            ℹ Info
          </button>
          {lastSync && (
            <span className="muted wl-last-sync" title="Sync meno recente tra gli increment spuntati">
              dati Jira del {formatDateTime(lastSync)}
            </span>
          )}
        </div>
      </div>
      {showInfo && <WorkloadInfoModal onClose={() => setShowInfo(false)} />}
      {syncing && (
        <SyncProgressModal
          key={syncing.id}
          title={`Sincronizzazione da Jira — ${syncing.index}/${syncing.total}: ${syncing.name}`}
          queryKey={['backlog-sync-progress', syncing.id]}
          fetchProgress={() => api.backlog.syncProgress(syncing.id)}
        />
      )}
      {syncAll.data && (
        <div className={syncAll.data.every((r) => r.ok) ? 'wl-sync-ok' : 'error-banner'}>
          {syncAll.data.map((r) => (
            <div key={r.name}>
              {r.ok ? '✓' : '✕'} {r.name}: {r.message}
            </div>
          ))}
        </div>
      )}

      <div className="tabs">
        <button type="button" className={tab === 'load' ? 'active' : ''} onClick={() => setTab('load')}>
          Carico
        </button>
        <button type="button" className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}>
          Team (ruoli, ore e ferie)
        </button>
      </div>

      {tab === 'team' && <WorkloadTeam assignees={assigneeNames} />}

      {tab === 'load' && (
      <>
      <div className="card wl-toolbar">
        <label>
          Settimane{' '}
          <select
            value={weeks}
            onChange={(e) => {
              const value = Number(e.target.value)
              setWeeks(value)
              store(WEEKS_KEY, value)
            }}
          >
            {WEEK_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label title="Ore al giorno di chi non è nella scheda Team (per le persone del Team valgono le loro)">
          Ore/giorno (fuori dal Team){' '}
          <input
            type="number"
            min={1}
            max={12}
            step={0.5}
            value={hoursPerDay}
            style={{ width: 64 }}
            onChange={(e) => {
              const value = Number(e.target.value)
              if (value > 0) {
                setHoursPerDay(value)
                store(HOURS_KEY, value)
              }
            }}
          />
        </label>
        {data && (
          <div className="wl-projects">
            {data.projects.map((p) => (
              <label key={p.id}>
                <input type="checkbox" checked={!hidden.includes(p.id)} onChange={() => toggleProject(p.id)} /> {p.name}
              </label>
            ))}
          </div>
        )}
        <div className="wl-legend">
          <span className="wl-low">&lt; 40%</span>
          <span className="wl-mid">40–80%</span>
          <span className="wl-full">80–105%</span>
          <span className="wl-over">&gt; 105%</span>
        </div>
      </div>

      {isLoading && <p className="muted">Caricamento…</p>}
      {error && <p className="error">{(error as Error).message}</p>}

      {data && (
        <>
          {overloaded > 0 && (
            <p className="wl-note">
              ⚠ {overloaded} {overloaded === 1 ? 'persona ha' : 'persone hanno'} almeno una settimana oltre la capacità.
            </p>
          )}
          {outsideTeam > 0 && (
            <p className="muted wl-team-hint">
              {outsideTeam} {outsideTeam === 1 ? 'persona non è' : 'persone non sono'} nel Team: per{' '}
              {outsideTeam === 1 ? 'lei' : 'loro'} la capacità usa {hoursPerDay} h/giorno e nessuna ferie.{' '}
              <button type="button" className="link-btn" onClick={() => setTab('team')}>
                Apri il Team
              </button>
            </p>
          )}
          <div className="table-wrap wl-table">
            <table>
              <thead>
                <tr>
                  <th className="wl-name">Assegnatario</th>
                  <th className="num" title="Ore rimanenti su tutti gli item aperti">Rimanenti</th>
                  <th className="num" title="Ore rimanenti di item con Fine pian. già passata: vanno ripianificati">
                    Scadute
                  </th>
                  {data.week_starts.map((w, i) => (
                    <th key={w} className="num" title={`Settimana dal ${formatIsoDate(w)}`}>
                      {i === 0 ? 'Questa' : weekLabel(w)}
                    </th>
                  ))}
                  <th className="num" title="Ore pianificate dopo l'ultima settimana mostrata">Oltre</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open.has(r.name)
                  const unassigned = r.name === 'Non assegnato'
                  return (
                    <Fragment key={r.name}>
                      <tr className="wl-person" onClick={() => toggleRow(r.name)}>
                        <td className="wl-name">
                          <span className="wl-caret">{isOpen ? '▾' : '▸'}</span>
                          {unassigned ? <em>{r.name}</em> : r.name}
                          <span className="muted"> · {r.visibleItems.length}</span>
                          {r.role && (
                            <span className="wl-role" title={`Team: ${r.role}, ${r.hours_per_day} h/giorno`}>
                              {r.role}
                            </span>
                          )}
                          {r.undated_items > 0 && (
                            <span className="wl-flag" title="Item senza Fine pian.: le loro ore non sono nelle settimane">
                              {r.undated_items} senza date
                            </span>
                          )}
                          {r.unbudgeted_items > 0 && (
                            <span className="wl-flag" title="Item senza stima né Sizing: ore sconosciute">
                              {r.unbudgeted_items} senza stima
                            </span>
                          )}
                        </td>
                        <td className="num">{h(r.remaining_hours)}</td>
                        <td className={`num${r.overdue_hours >= 0.5 ? ' ev-bad' : ''}`} title={`${r.overdue_items} item scaduti`}>
                          {h(r.overdue_hours)}
                        </td>
                        {r.weeks.map((hrs, w) => {
                          const capacity = Math.round(capacityOf(r, w) * 10) / 10
                          const away = r.absence_days[w] ?? 0
                          const awayText = away > 0 ? `, ${away} gg di assenza` : ''
                          return (
                            <td
                              key={w}
                              className={`num wl-cell ${unassigned ? '' : loadTone(hrs, capacity)}${away > 0 ? ' wl-away' : ''}`}
                              title={
                                hrs >= 0.5
                                  ? `${Math.round(hrs)} h su ${capacity} h disponibili (${r.capacity_days[w]} gg${awayText})` +
                                    (capacity > 0 ? ` = ${Math.round((hrs / capacity) * 100)}%` : '')
                                  : `${capacity} h disponibili${awayText}`
                              }
                            >
                              {h(hrs)}
                              {away > 0 && <span className="wl-away-mark">🏖</span>}
                            </td>
                          )
                        })}
                        <td className="num">{h(r.beyond_hours)}</td>
                      </tr>
                      {isOpen &&
                        r.visibleItems.map((i) => (
                          <tr key={`${i.project_id}-${i.jira_key}`} className="wl-item">
                            <td className="wl-name">
                              <a href={`${JIRA_BROWSE}${i.jira_key}`} target="_blank" rel="noreferrer" title="Apri in Jira">
                                {i.jira_key}
                              </a>{' '}
                              <span className="wl-summary" title={i.summary ?? ''}>
                                {i.summary}
                              </span>
                              <span className="muted wl-meta">
                                Increment{' '}
                                <Link to={`/projects/${i.project_id}/backlog`} title="Apri il Backlog dell'increment">
                                  {i.project_code} {i.project_name}
                                </Link>{' '}
                                · {i.status}
                                {i.finish ? ` · fine ${formatIsoDate(i.finish)}` : ' · senza date'}
                                {i.budget_source === 'sizing' ? ' · da Sizing' : ''}
                              </span>
                            </td>
                            <td className="num">{i.remaining_hours === null ? '?' : h(i.remaining_hours)}</td>
                            <td className={`num${i.overdue ? ' ev-bad' : ''}`}>
                              {i.overdue ? h(i.remaining_hours ?? 0) || '0' : ''}
                            </td>
                            {i.weeks.map((hrs, w) => (
                              <td key={w} className="num muted">
                                {h(hrs)}
                              </td>
                            ))}
                            <td className="num muted">{h(i.beyond_hours)}</td>
                          </tr>
                        ))}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="muted wl-footnote">
            Clicca una persona per vedere i suoi item: la chiave apre il PBI in Jira, l'increment il suo Backlog. 🏖 =
            settimana con assenze. Come sono calcolate ore e capacità: pulsante ℹ Info.
          </p>
        </>
      )}
      </>
      )}
    </div>
  )
}
