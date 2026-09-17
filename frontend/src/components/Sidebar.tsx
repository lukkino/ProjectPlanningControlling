import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { api } from '../api/client'
import { ProjectFormModal } from './ProjectFormModal'

export function Sidebar() {
  const [showNewProject, setShowNewProject] = useState(false)
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })

  return (
    <aside className="sidebar">
      <h1>Project Controlling</h1>
      <button className="btn btn-primary" onClick={() => setShowNewProject(true)}>
        + Nuovo increment
      </button>
      <NavLink to="/projects-dashboard" className={({ isActive }) => `btn${isActive ? ' active' : ''}`} style={{ marginTop: 8, textAlign: 'center' }}>
        📊 Dashboard increment
      </NavLink>
      <NavLink to="/increments" className={({ isActive }) => `btn${isActive ? ' active' : ''}`} style={{ textAlign: 'center' }}>
        🚀 Progetti
      </NavLink>
      <nav className="project-list">
        {projects?.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Nessun increment ancora.</p>}
        {projects?.map((p) => (
          <NavLink key={p.id} to={`/projects/${p.id}`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="code">{p.code}</span>
            <span className="name">{p.name}</span>
          </NavLink>
        ))}
      </nav>
      {showNewProject && <ProjectFormModal onClose={() => setShowNewProject(false)} />}
    </aside>
  )
}
