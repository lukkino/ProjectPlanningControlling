import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { SyncProgress } from '../api/types'

const PHASE_LABEL: Record<SyncProgress['phase'], string> = {
  idle: 'Avvio...',
  search: 'Ricerca delle issue su Jira',
  changelog: 'Lettura dello storico delle issue (date effettive)',
  details: 'Lettura dei Task collegati',
  saving: 'Salvataggio nel backlog',
}

// Percentuale complessiva: quasi tutto il tempo va nei changelog (una
// chiamata per issue), quindi e' quella fase a muovere la barra; le altre
// sono poche chiamate e valgono solo l'inizio e la fine.
function percentOf(progress: SyncProgress | undefined): number {
  if (!progress) return 0
  switch (progress.phase) {
    case 'changelog':
      return progress.total > 0 ? 2 + Math.floor((93 * progress.done) / progress.total) : 2
    case 'details':
      return 96
    case 'saving':
      return 99
    default:
      return 0
  }
}

function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Popup bloccante mostrato durante "Sincronizza da Jira" del Backlog:
 *  interroga ogni mezzo secondo l'avanzamento della sync (la POST resta in
 *  attesa) e mostra barra, percentuale e tempo stimato rimanente. */
export function SyncProgressModal({ projectId }: { projectId: number }) {
  const { data: progress } = useQuery({
    queryKey: ['backlog-sync-progress', projectId],
    queryFn: () => api.backlog.syncProgress(projectId),
    refetchInterval: 500,
    gcTime: 0,
  })

  const startedAt = useRef(Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Stima del rimanente dalla velocita' dei changelog, misurata da quando
  // la fase e' iniziata (la ricerca iniziale ha un ritmo diverso).
  const changelogStart = useRef<{ time: number; done: number } | null>(null)
  if (progress?.phase === 'changelog' && changelogStart.current === null) {
    changelogStart.current = { time: Date.now(), done: progress.done }
  }
  let remaining: number | null = null
  if (progress?.phase === 'changelog' && changelogStart.current) {
    const doneSince = progress.done - changelogStart.current.done
    const elapsed = (now - changelogStart.current.time) / 1000
    if (doneSince > 0 && elapsed > 0) remaining = ((progress.total - progress.done) * elapsed) / doneSince
  }

  const percent = percentOf(progress)
  const phase = progress?.phase ?? 'idle'

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 460 }}>
        <h3 style={{ marginTop: 0 }}>Sincronizzazione da Jira</h3>
        <div className="sync-progress-bar">
          <div className="sync-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 13 }}>
          <span>{PHASE_LABEL[phase]}</span>
          <strong>{percent}%</strong>
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          {phase === 'search' && progress && progress.done > 0 && `${progress.done} issue trovate · `}
          {phase === 'changelog' && progress && `${progress.done} di ${progress.total} issue · `}
          Trascorso {formatSeconds((now - startedAt.current) / 1000)}
          {remaining !== null && ` · circa ${formatSeconds(remaining)} rimanenti`}
        </div>
      </div>
    </div>
  )
}
