import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, NavLink, useMatch } from 'react-router-dom'
import { api } from '../api/client'
import { sidebarItems } from '../lib/sidebarPins'
import { APP_VERSION } from '../lib/version'
import { IncrementFormModal } from './IncrementFormModal'
import { ProjectFormModal } from './ProjectFormModal'

export function Sidebar() {
  const [showNewProgetto, setShowNewProgetto] = useState(false)
  const [showNewIncrement, setShowNewIncrement] = useState(false)
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const { data: progetti } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })
  // Nella sidebar solo quelli fissati (📌 dalle pagine elenco) o, se
  // nessuno, i piu' recenti; l'elenco completo e' nelle pagine Progetti
  // e Increment.
  const progettoMatch = useMatch('/increments/:incrementId')
  const incrementMatch = useMatch('/projects/:projectId/*')
  const shownProgetti = sidebarItems(progetti, Number(progettoMatch?.params.incrementId) || null)
  const shownIncrements = sidebarItems(projects, Number(incrementMatch?.params.projectId) || null)
  const listFooter = (to: string, total: number | undefined, pinnedMode: boolean, shown: number) =>
    !!total && (
      <Link to={to} className="sidebar-all-link" title="Elenco completo: con 📌 scegli quali mostrare qui">
        {pinnedMode ? '📌 fissati' : 'recenti'} · {total > shown ? `tutti (${total}) →` : 'elenco →'}
      </Link>
    )

  return (
    <aside className="sidebar">
      <img className="sidebar-logo" src="/logo_Inpeco.png" alt="Inpeco" />
      <div className="sidebar-brand">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <div>
          <h1>Project Controlling</h1>
          <Link to="/changelog" className="sidebar-version" title="Storia delle modifiche">
            v{APP_VERSION}
          </Link>
        </div>
      </div>

      <NavLink to="/dashboard" className={({ isActive }) => `sidebar-dashboard-btn${isActive ? ' active' : ''}`}>
        📊 Dashboard
      </NavLink>

      <NavLink to="/complaints" className={({ isActive }) => `sidebar-dashboard-btn${isActive ? ' active' : ''}`}>
        📣 Complaints
      </NavLink>

      <NavLink to="/releases" className={({ isActive }) => `sidebar-dashboard-btn${isActive ? ' active' : ''}`}>
        📦 Releases
      </NavLink>

      <NavLink to="/tools" className={({ isActive }) => `sidebar-dashboard-btn${isActive ? ' active' : ''}`}>
        🧰 Tools
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
          {shownProgetti.shown.map((p) => (
            <NavLink key={p.id} to={`/increments/${p.id}`} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="code">{p.code}</span>
              {p.notes && <span className="name">{p.notes}</span>}
            </NavLink>
          ))}
        </nav>
        {listFooter('/increments', progetti?.length, shownProgetti.pinnedMode, shownProgetti.shown.length)}
      </div>

      <div className="sidebar-section">
        <Link to="/projects" className="sidebar-section-title">
          Increment
        </Link>
        <button className="btn btn-primary" onClick={() => setShowNewIncrement(true)}>
          + Nuovo Increment
        </button>
        <nav className="project-list">
          {projects?.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Nessun increment ancora.</p>}
          {shownIncrements.shown.map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="code">
                {p.code}
                {p.is_current && (
                  <span style={{ opacity: 0.7 }} title="Increment in corso">
                    {' '}●
                  </span>
                )}
                {p.release_date && (
                  <span style={{ opacity: 0.7 }} title="Increment rilasciato">
                    {' '}✓
                  </span>
                )}
              </span>
              <span className="name">{p.name}</span>
            </NavLink>
          ))}
        </nav>
        {listFooter('/projects', projects?.length, shownIncrements.pinnedMode, shownIncrements.shown.length)}
      </div>


      {showNewProgetto && <IncrementFormModal onClose={() => setShowNewProgetto(false)} />}
      {showNewIncrement && <ProjectFormModal onClose={() => setShowNewIncrement(false)} />}
    </aside>
  )
}
