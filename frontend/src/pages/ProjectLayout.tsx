import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { ProjectFormModal } from '../components/ProjectFormModal'
import { formatIsoDate } from '../lib/dates'
import type { ProjectDetail } from '../api/types'

export function ProjectLayout() {
  const { projectId } = useParams()
  const id = Number(projectId)
  const [showEdit, setShowEdit] = useState(false)
  const [showRelease, setShowRelease] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.projects.get(id),
    enabled: !Number.isNaN(id),
  })

  const remove = useMutation({
    mutationFn: () => api.projects.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate('/')
    },
  })

  // Possono esserci piu' increment "in corso" contemporaneamente: marcarne
  // uno non tocca gli altri.
  const setCurrent = useMutation({
    mutationFn: (isCurrent: boolean) => api.projects.update(id, { is_current: isCurrent }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  // Rilascio: un increment rilasciato non e' piu' "in corso".
  const setRelease = useMutation({
    mutationFn: (releaseDate: string | null) =>
      api.projects.update(id, releaseDate ? { release_date: releaseDate, is_current: false } : { release_date: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowRelease(false)
    },
  })

  if (isLoading || !project) return <p className="muted">Caricamento...</p>

  const handleDelete = () => {
    if (confirm(`Eliminare l'increment "${project.code}"? L'operazione non è reversibile.`)) {
      remove.mutate()
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            Increment
          </div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {project.code} · {project.name}
            {project.is_current && (
              <span className="badge current" style={{ fontSize: 11, fontWeight: 600 }}>
                ● In corso
              </span>
            )}
            {project.release_date && (
              <span className="badge done" style={{ fontSize: 11, fontWeight: 600 }}>
                ✓ Rilasciato il {formatIsoDate(project.release_date)}
              </span>
            )}
          </h1>
          <div className="sub">
            Stato: {project.status}
            {project.start_date && ` · Inizio: ${formatIsoDate(project.start_date)}`}
            {project.code_freeze_date && ` · Code freeze: ${formatIsoDate(project.code_freeze_date)}`}
            {project.planned_finish_date && ` · Planned finish: ${formatIsoDate(project.planned_finish_date)}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            onClick={() => setCurrent.mutate(!project.is_current)}
            disabled={setCurrent.isPending}
            title={project.is_current ? 'Smarca come increment in corso' : 'Segna come increment in corso'}
          >
            {project.is_current ? '★ In corso' : '☆ Segna come in corso'}
          </button>
          <button
            className="btn"
            onClick={() => setShowRelease(true)}
            title={project.release_date ? 'Modifica la data di rilascio o annulla il rilascio' : 'Segna come rilasciato'}
          >
            {project.release_date ? '✓ Rilasciato' : '🚀 Segna come rilasciato'}
          </button>
          <button className="btn" onClick={() => setShowEdit(true)}>
            Modifica
          </button>
          <button className="btn btn-danger" onClick={handleDelete}>
            Elimina
          </button>
        </div>
      </div>

      <div className="tabs">
        <NavLink to={`/projects/${id}`} end className={({ isActive }) => (isActive ? 'active' : '')}>
          Dashboard
        </NavLink>
        <NavLink to={`/projects/${id}/backlog`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Backlog
        </NavLink>
        <NavLink to={`/projects/${id}/snapshots`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Andamento
        </NavLink>
        <NavLink to={`/projects/${id}/forecasting`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Forecasting
        </NavLink>
        <NavLink to={`/projects/${id}/montecarlo`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Monte Carlo
        </NavLink>
        <NavLink to={`/projects/${id}/documents`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Documents
        </NavLink>
        <NavLink to={`/projects/${id}/progetti`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Progetti
        </NavLink>
      </div>

      <Outlet context={{ project } satisfies { project: ProjectDetail }} />

      {showEdit && <ProjectFormModal project={project} onClose={() => setShowEdit(false)} />}
      {showRelease && (
        <ReleaseModal
          project={project}
          saving={setRelease.isPending}
          error={setRelease.error as Error | null}
          onSave={(releaseDate) => setRelease.mutate(releaseDate)}
          onClose={() => setShowRelease(false)}
        />
      )}
    </div>
  )
}

type ReleaseModalProps = {
  project: ProjectDetail
  saving: boolean
  error: Error | null
  onSave: (releaseDate: string | null) => void
  onClose: () => void
}

// Data di rilascio dell'increment: di default oggi; se gia' rilasciato si
// puo' correggere la data o annullare il rilascio.
function ReleaseModal({ project, saving, error, onSave, onClose }: ReleaseModalProps) {
  const [releaseDate, setReleaseDate] = useState(project.release_date ?? new Date().toISOString().slice(0, 10))

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        <h3>{project.release_date ? 'Rilascio increment' : 'Segna come rilasciato'}</h3>
        {error && <div className="error-banner">Salvataggio non riuscito: {error.message}</div>}
        <div className="form-row">
          <label>Data di rilascio</label>
          <input type="date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} />
        </div>
        {!project.release_date && project.is_current && (
          <p className="muted" style={{ fontSize: 12 }}>
            L'increment non sarà più segnato come "in corso".
          </p>
        )}
        <div className="form-actions">
          {project.release_date && (
            <button className="btn btn-danger" style={{ marginRight: 'auto' }} disabled={saving} onClick={() => onSave(null)}>
              Annulla rilascio
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Chiudi
          </button>
          <button className="btn btn-primary" disabled={saving || !releaseDate} onClick={() => onSave(releaseDate)}>
            Salva
          </button>
        </div>
      </div>
    </div>
  )
}
