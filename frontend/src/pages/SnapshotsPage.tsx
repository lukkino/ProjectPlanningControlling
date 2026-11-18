import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Snapshot } from '../api/types'
import { countBacklogStats } from '../lib/backlogStats'
import { useProjectContext } from './useProjectContext'
import { DateInput } from '../components/DateInput'
import { EarnedValueSection } from '../components/EarnedValue'
import { formatIsoDate } from '../lib/dates'

// Oggi in ora locale, "yyyy-mm-dd" (toISOString darebbe la data UTC).
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function SnapshotsPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()

  const { data: snapshots } = useQuery({
    queryKey: ['snapshots', project.id],
    queryFn: () => api.snapshots.list(project.id),
  })

  // Stessa query cache di BacklogPage: serve solo a precompilare i totali
  // di un nuovo snapshot con lo stato ATTUALE del backlog. Una volta creato,
  // lo snapshot e' un valore congelato nel DB: non si ricalcola piu' da
  // solo, resta com'e' finche' non lo modifichi tu a mano.
  const { data: backlogItems } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })
  // PBI totali/completati (e quindi i rimanenti) contano solo i PBI in scope
  // e con impatto sul code freeze, come le stat in cima al Backlog.
  const { codefreezeCount, doneCount, loggedHoursTotal } = countBacklogStats(backlogItems ?? [])
  // Ore usate: con dei progetti collegati, la somma dei loro ultimi Actual
  // ore (le stesse "Ore usate" della Dashboard).
  const { data: metrics } = useQuery({
    queryKey: ['dashboard', project.id],
    queryFn: () => api.dashboard.get(project.id),
  })
  const progettiHours = metrics?.logged_hours_source === 'progetti' ? metrics.logged_hours_total : null
  // Le ore dei progetti sono aggiornate alla data del loro ultimo snapshot
  // dello Storico: se non e' oggi, vanno aggiornate dal progetto (non a mano
  // qui).
  const today = todayIso()
  const staleProgetti =
    progettiHours === null ? [] : (metrics?.progetti_hours ?? []).filter((p) => p.last_snapshot_date !== today)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['snapshots', project.id] })
    queryClient.invalidateQueries({ queryKey: ['dashboard', project.id] })
  }

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Snapshot> }) => api.snapshots.update(id, data),
    onSuccess: invalidate,
  })
  const add = useMutation({
    mutationFn: () =>
      api.snapshots.create(project.id, {
        snapshot_date: todayIso(),
        logged_hours: loggedHoursTotal,
        actual_hours: progettiHours,
        pbi_total: codefreezeCount,
        pbi_done: doneCount,
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.snapshots.remove(id),
    onSuccess: invalidate,
  })

  const createSnapshot = () => {
    if (staleProgetti.length > 0) {
      const list = staleProgetti
        .map((p) => `• ${p.code}: ${p.last_snapshot_date ? `ultimo snapshot del ${formatIsoDate(p.last_snapshot_date)}` : 'nessuno snapshot'}`)
        .join('\n')
      const ok = window.confirm(
        `Le ore usate dei progetti collegati non sono aggiornate a oggi:\n${list}\n\n` +
          'Aggiornale dallo Storico del progetto, poi crea lo snapshot. Crearlo comunque con le ore attuali?',
      )
      if (!ok) return
    }
    add.mutate()
  }

  return (
    <>
      <EarnedValueSection projectId={project.id} />
      <div className="card">
        <h3>Storico avanzamento</h3>
        <p className="muted">
          Registra periodicamente una fotografia dello stato dell'increment per tracciarne l'andamento nel tempo (mostrato
          nel grafico della Dashboard).
          {progettiHours !== null &&
            ` Le Ore usate vengono dagli ultimi Actual ore dei progetti collegati (oggi ${progettiHours.toLocaleString('it-IT')} h) e si aggiornano solo dallo Storico del progetto.`}
        </p>
        {staleProgetti.length > 0 && (
          <div
            role="alert"
            style={{
              marginBottom: 12,
              padding: '10px 14px',
              border: '1px solid #f1d8a8',
              borderRadius: 'var(--radius)',
              background: '#fffaf0',
              color: '#8a5300',
              fontSize: 13,
            }}
          >
            ⚠ Le ore usate dei progetti collegati non sono aggiornate a oggi: aggiornale dallo Storico del progetto prima
            di creare un nuovo snapshot.
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {staleProgetti.map((p) => (
                <li key={p.id}>
                  <Link to={`/increments/${p.id}`}>
                    {p.code}
                    {p.name && ` · ${p.name}`}
                  </Link>
                  :{' '}
                  {p.last_snapshot_date
                    ? `ultimo snapshot del ${formatIsoDate(p.last_snapshot_date)}`
                    : 'nessuno snapshot nello Storico'}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th title="Ore consuntivate (controlling): con progetti collegati, la somma dei loro Actual ore">Ore usate</th>
                <th title="Ore loggate dagli sviluppatori sulle issue Jira del backlog">Ore Jira</th>
                <th>PBI totali</th>
                <th>PBI completati</th>
                <th title="PBI totali meno PBI completati: si aggiorna da solo modificando le due colonne">PBI rimanenti</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshots?.map((s) => (
                <tr key={s.id}>
                  <td className="editable-cell">
                    <DateInput
                      value={s.snapshot_date}
                      onChange={(value) => value && update.mutate({ id: s.id, data: { snapshot_date: value } })}
                    />
                  </td>
                  {progettiHours !== null ? (
                    <td
                      className="num"
                      title="Dalle ore dei progetti collegati al momento dello snapshot: si aggiornano dallo Storico del progetto, non a mano"
                    >
                      {s.actual_hours == null ? <span className="muted">-</span> : s.actual_hours.toLocaleString('it-IT')}
                    </td>
                  ) : (
                    <td className="editable-cell">
                      <input
                        type="number"
                        defaultValue={s.actual_hours ?? ''}
                        onBlur={(e) => update.mutate({ id: s.id, data: { actual_hours: e.target.value ? Number(e.target.value) : null } })}
                      />
                    </td>
                  )}
                  <td className="editable-cell">
                    <input
                      type="number"
                      defaultValue={s.logged_hours ?? ''}
                      onBlur={(e) => update.mutate({ id: s.id, data: { logged_hours: e.target.value ? Number(e.target.value) : null } })}
                    />
                  </td>
                  <td className="editable-cell">
                    <input
                      type="number"
                      defaultValue={s.pbi_total ?? ''}
                      onBlur={(e) => update.mutate({ id: s.id, data: { pbi_total: e.target.value ? Number(e.target.value) : null } })}
                    />
                  </td>
                  <td className="editable-cell">
                    <input
                      type="number"
                      defaultValue={s.pbi_done ?? ''}
                      onBlur={(e) => update.mutate({ id: s.id, data: { pbi_done: e.target.value ? Number(e.target.value) : null } })}
                    />
                  </td>
                  <td>{s.pbi_total == null ? <span className="muted">-</span> : s.pbi_total - (s.pbi_done ?? 0)}</td>
                  <td className="editable-cell">
                    <input
                      defaultValue={s.note ?? ''}
                      onBlur={(e) => update.mutate({ id: s.id, data: { note: e.target.value || null } })}
                    />
                  </td>
                  <td>
                    <button className="btn btn-danger" onClick={() => remove.mutate(s.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {snapshots?.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    Nessuno snapshot registrato.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-primary" onClick={createSnapshot} disabled={add.isPending}>
            + Nuovo snapshot
          </button>
        </div>
      </div>
    </>
  )
}
