import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router-dom'
import { api } from '../api/client'
import { parseBackendDateTime } from '../lib/dates'

function formatDateTime(value: string | null): string | null {
  if (!value) return null
  const d = parseBackendDateTime(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
}

// Intestazione comune alle sezioni dell'area Complaints (Elenco, KPI): la
// sincronizzazione da Jira vale per entrambe, che leggono gli stessi dati.
export function ComplaintsLayout() {
  const queryClient = useQueryClient()
  const { data: complaints } = useQuery({ queryKey: ['complaints'], queryFn: api.complaints.list })

  const sync = useMutation({
    mutationFn: api.complaints.sync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['complaints'] }),
  })

  // La sync valorizza lo stesso timestamp su ogni complaint.
  const lastSyncedAt = (complaints ?? []).reduce<string | null>(
    (latest, c) => (c.last_synced_at && (!latest || c.last_synced_at > latest) ? c.last_synced_at : latest),
    null,
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Complaints</h1>
          <div className="sub">
            Bug Jira nati da un case Salesforce · Ultima sync: {formatDateTime(lastSyncedAt) ?? 'mai sincronizzato'}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
          {sync.isPending ? 'Sincronizzazione...' : '⟳ Sincronizza da Jira'}
        </button>
      </div>

      <div className="tabs">
        <NavLink to="/complaints" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Elenco
        </NavLink>
        <NavLink to="/complaints/kpi" className={({ isActive }) => (isActive ? 'active' : '')}>
          KPI
        </NavLink>
      </div>

      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <p className="muted" style={{ marginTop: 0 }}>
          Sync completata: {sync.data.created} nuovi complaint, {sync.data.updated} aggiornati
          {sync.data.removed > 0 && `, ${sync.data.removed} rimossi (non più nella JQL)`} (totale trovati:{' '}
          {sync.data.total_matched}).
        </p>
      )}

      <Outlet />
    </div>
  )
}
