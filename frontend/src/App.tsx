import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { BacklogPage } from './pages/BacklogPage'
import { DashboardPage } from './pages/DashboardPage'
import { ProjectLayout } from './pages/ProjectLayout'
import { SnapshotsPage } from './pages/SnapshotsPage'
import { WelcomePage } from './pages/WelcomePage'

export default function App() {
  const location = useLocation()
  const isBacklog = location.pathname.endsWith('/backlog')

  return (
    <div className="app-shell">
      <Sidebar />
      <main className={isBacklog ? 'main-content main-content--wide' : 'main-content'}>
        <Routes>
          <Route path="/" element={<WelcomePage />} />
          <Route path="/projects/:projectId" element={<ProjectLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="backlog" element={<BacklogPage />} />
            <Route path="snapshots" element={<SnapshotsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
