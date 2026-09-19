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
        <NavLink to={`/projects/${id}/documents`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Documents
        </NavLink>
        <NavLink to={`/projects/${id}/progetti`} className={({ isActive }) => (isActive ? 'active' : '')}>
          Progetti
        </NavLink>
      </div>

      <Outlet context={{ project } satisfies { project: ProjectDetail }} />

      {showEdit && <ProjectFormModal project={project} onClose={() => setShowEdit(false)} />}
    </div>
  )
}
