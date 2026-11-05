import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { BacklogPage } from './pages/BacklogPage'
import { ChangelogPage } from './pages/ChangelogPage'
import { ComplaintsKpiPage } from './pages/ComplaintsKpiPage'
import { ComplaintsLayout } from './pages/ComplaintsLayout'
import { ComplaintsPage } from './pages/ComplaintsPage'
import { ConfigurationPage } from './pages/ConfigurationPage'
import { DashboardPage } from './pages/DashboardPage'
import { DocumentsPage } from './pages/DocumentsPage'
import { ForecastingPage } from './pages/ForecastingPage'
import { IncrementComponentsPage } from './pages/IncrementComponentsPage'
import { IncrementDetailPage } from './pages/IncrementDetailPage'
import { IncrementsPage } from './pages/IncrementsPage'
import { MonteCarloPage } from './pages/MonteCarloPage'
import { OverviewDashboardPage } from './pages/OverviewDashboardPage'
import { ProjectIncrementLinkPage } from './pages/ProjectIncrementLinkPage'
import { ProjectLayout } from './pages/ProjectLayout'
import { ProjectsDashboardPage } from './pages/ProjectsDashboardPage'
import { ProjectsListPage } from './pages/ProjectsListPage'
import { ReleasesPage } from './pages/ReleasesPage'
import { SnapshotsPage } from './pages/SnapshotsPage'
import { ToolsPage } from './pages/ToolsPage'
import { ShippingToolPage } from './pages/tools/ShippingToolPage'
import { WelcomePage } from './pages/WelcomePage'

const WIDE_PAGE_SUFFIXES = ['/backlog', '/forecasting', '/montecarlo', '/documents', '/projects-dashboard', '/dashboard', '/complaints', '/complaints/kpi', '/releases', '/tools/spedizioni']

export default function App() {
  const location = useLocation()
  const isWide =
    WIDE_PAGE_SUFFIXES.some((suffix) => location.pathname.endsWith(suffix)) ||
    // Pagina di dettaglio di un progetto (non la lista /increments): la
    // tabella dello Storico progetto ha bisogno di spazio per non dover
    // scorrere.
    /^\/increments\/\d+$/.test(location.pathname) ||
    // Dashboard dell'increment (rotta index del progetto): la tabella delle
    // fasi, con date, scostamento e note, ha bisogno di tutta la larghezza.
    /^\/projects\/\d+\/?$/.test(location.pathname)

  return (
    <div className="app-shell">
      <Sidebar />
      <main className={isWide ? 'main-content main-content--wide' : 'main-content'}>
        <Routes>
          <Route path="/" element={<WelcomePage />} />
          <Route path="/dashboard" element={<OverviewDashboardPage />} />
          <Route path="/complaints" element={<ComplaintsLayout />}>
            <Route index element={<ComplaintsPage />} />
            <Route path="kpi" element={<ComplaintsKpiPage />} />
          </Route>
          <Route path="/releases" element={<ReleasesPage />} />
          <Route path="/settings" element={<ConfigurationPage />} />
          <Route path="/projects-dashboard" element={<ProjectsDashboardPage />} />
          <Route path="/increments" element={<IncrementsPage />} />
          <Route path="/projects" element={<ProjectsListPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="/tools/spedizioni" element={<ShippingToolPage />} />
          <Route path="/increments/:incrementId" element={<IncrementDetailPage />} />
          <Route path="/projects/:projectId" element={<ProjectLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="backlog" element={<BacklogPage />} />
            <Route path="snapshots" element={<SnapshotsPage />} />
            <Route path="forecasting" element={<ForecastingPage />} />
            <Route path="montecarlo" element={<MonteCarloPage />} />
            <Route path="documents" element={<DocumentsPage />} />
            <Route path="progetti" element={<ProjectIncrementLinkPage />} />
            <Route path="components" element={<IncrementComponentsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
