import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { BacklogPage } from './pages/BacklogPage'
import { DashboardPage } from './pages/DashboardPage'
import { DocumentsPage } from './pages/DocumentsPage'
import { ForecastingPage } from './pages/ForecastingPage'
import { IncrementDetailPage } from './pages/IncrementDetailPage'
import { IncrementsPage } from './pages/IncrementsPage'
import { ProjectLayout } from './pages/ProjectLayout'
import { ProjectsDashboardPage } from './pages/ProjectsDashboardPage'
import { SnapshotsPage } from './pages/SnapshotsPage'
import { WelcomePage } from './pages/WelcomePage'

const WIDE_PAGE_SUFFIXES = ['/backlog', '/forecasting', '/documents', '/projects-dashboard']

export default function App() {
  const location = useLocation()
  const isWide = WIDE_PAGE_SUFFIXES.some((suffix) => location.pathname.endsWith(suffix))

  return (
    <div className="app-shell">
      <Sidebar />
      <main className={isWide ? 'main-content main-content--wide' : 'main-content'}>
        <Routes>
          <Route path="/" element={<WelcomePage />} />
          <Route path="/projects-dashboard" element={<ProjectsDashboardPage />} />
          <Route path="/increments" element={<IncrementsPage />} />
          <Route path="/increments/:incrementId" element={<IncrementDetailPage />} />
          <Route path="/projects/:projectId" element={<ProjectLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="backlog" element={<BacklogPage />} />
            <Route path="snapshots" element={<SnapshotsPage />} />
            <Route path="forecasting" element={<ForecastingPage />} />
            <Route path="documents" element={<DocumentsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
