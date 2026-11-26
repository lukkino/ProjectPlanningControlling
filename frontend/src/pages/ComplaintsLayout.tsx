import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { api } from '../api/client'
import { SyncChangesModal } from '../components/SyncChangesModal'
import { SyncProgressModal } from '../components/SyncProgressModal'
import { parseBackendDateTime } from '../lib/dates'

function formatDateTime(value: string | null): string | null {
  if (!value) return null
  const d = parseBackendDateTime(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Intestazione comune alle sezioni dell'area Complaints (Elenco, KPI): la
// sincronizzazione da Jira vale per entrambe, che leggono gli stessi dati.
export function ComplaintsLayout() {
  const queryClient = useQueryClient()
  const { data: complaints } = useQuery({ queryKey: ['complaints'], queryFn: api.complaints.list })
  // Popup con cio' che la sync (Jira e Salesforce) ha cambiato.
  const [syncChangesOpen, setSyncChangesOpen] = useState(false)

  const sync = useMutation({
    mutationFn: api.complaints.sync,
    onSuccess: () => {
      setSyncChangesOpen(true)
      queryClient.invalidateQueries({ queryKey: ['complaints'] })
      queryClient.invalidateQueries({ queryKey: ['complaint-mismatches'] })
    },
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
          <div className="sub">
            <Link to="/tools">Tools</Link> ›
          </div>
          <h1>📣 Complaints</h1>
          <div className="sub">
            Bug Jira nati da un case Salesforce · Ultima sync: {formatDateTime(lastSyncedAt) ?? 'mai sincronizzato'}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
          {sync.isPending ? 'Sincronizzazione...' : '⟳ Sincronizza da Jira'}
        </button>
      </div>

      <div className="tabs">
        <NavLink to="/tools/complaints" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Elenco
        </NavLink>
        <NavLink to="/tools/complaints/kpi" className={({ isActive }) => (isActive ? 'active' : '')}>
          KPI
        </NavLink>
        <NavLink to="/tools/complaints/disallineamenti" className={({ isActive }) => (isActive ? 'active' : '')}>
          Disallineamenti
        </NavLink>
      </div>

      {sync.isPending && (
        <SyncProgressModal queryKey={['complaints-sync-progress']} fetchProgress={api.complaints.syncProgress} />
      )}
      {sync.isError &&<div className="error-banner">{(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <p className="muted" style={{ marginTop: 0 }}>
          Sync completata: {sync.data.created} nuovi complaint, {sync.data.updated} aggiornati
          {sync.data.removed > 0 && `, ${sync.data.removed} rimossi (non più nella JQL)`} (totale trovati:{' '}
          {sync.data.total_matched})
          {sync.data.salesforce_matched != null &&
            ` · Salesforce: ${sync.data.salesforce_matched} case trovati su ${sync.data.total_matched}`}
          .{' '}
          <button className="btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setSyncChangesOpen(true)}>
            Cosa è cambiato
          </button>
        </p>
      )}
      {sync.isSuccess && syncChangesOpen && (
        <SyncChangesModal
          result={sync.data}
          onClose={() => setSyncChangesOpen(false)}
          summaryLine={
            <>
              {sync.data.total_matched} complaint nella JQL · {sync.data.created} nuovi · {sync.data.removed} rimossi ·{' '}
              {(sync.data.changes ?? []).filter((c) => c.kind === 'updated').length} modificati
              {sync.data.salesforce_matched == null && ' · Salesforce non letto: solo i cambiamenti da Jira'}
            </>
          }
          sectionHelp={{
            new: 'Entrati nella JQL dei complaints',
            removed: 'Non più nella JQL: rimossi',
            updated: 'Campi cambiati su Jira o su Salesforce',
          }}
          emptyText="Nessun cambiamento: i complaint erano già allineati a Jira e Salesforce."
        />
      )}
      {sync.isSuccess &&
        sync.data.errors.map((e) => (
          <div key={e} className="error-banner">
            {e}
          </div>
        ))}

      <Outlet />
    </div>
  )
}
