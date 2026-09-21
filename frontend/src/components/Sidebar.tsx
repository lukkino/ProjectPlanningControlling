import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { api } from '../api/client'
import { IncrementFormModal } from './IncrementFormModal'
import { ProjectFormModal } from './ProjectFormModal'

export function Sidebar() {
  const [showNewProgetto, setShowNewProgetto] = useState(false)
  const [showNewIncrement, setShowNewIncrement] = useState(false)
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const { data: progetti } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <h1>Project Controlling</h1>
      </div>

      <NavLink to="/dashboard" className={({ isActive }) => `sidebar-dashboard-btn${isActive ? ' active' : ''}`}>
        📊 Dashboard
      </NavLink>

      <div className="sidebar-section">
        <Link to="/increments" className="sidebar-section-title">
          Progetti
        </Link>
        <button className="btn btn-progetto" onClick={() => setShowNewProgetto(true)}>
          + Nuovo Progetto
        </button>
        <nav className="project-list progetti">
          {progetti?.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Nessun progetto ancora.</p>}
          {progetti?.map((p) => (
            <NavLink key={p.id} to={`/increments/${p.id}`} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="code">{p.code}</span>
              {p.notes && <span className="name">{p.notes}</span>}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="sidebar-section">
        <Link to="/projects-dashboard" className="sidebar-section-title">
          Increment
        </Link>
        <button className="btn btn-primary" onClick={() => setShowNewIncrement(true)}>
          + Nuovo Increment
        </button>
        <nav className="project-list">
          {projects?.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Nessun increment ancora.</p>}
          {projects?.map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="code">
                {p.code}
                {p.is_current && (
                  <span style={{ opacity: 0.7 }} title="Increment in corso">
                    {' '}●
                  </span>
                )}
              </span>
              <span className="name">{p.name}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      <NavLink
        to="/settings"
        className={({ isActive }) => `sidebar-settings-link${isActive ? ' active' : ''}`}
        style={{ marginTop: 'auto' }}
      >
        ⚙️ Configurazione
      </NavLink>

      {showNewProgetto && <IncrementFormModal onClose={() => setShowNewProgetto(false)} />}
      {showNewIncrement && <ProjectFormModal onClose={() => setShowNewIncrement(false)} />}
    </aside>
  )
}
