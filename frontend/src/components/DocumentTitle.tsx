import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../api/client'
import { TOOLS } from '../lib/tools'

// Titolo del tab del browser secondo la pagina principale aperta: il codice
// dell'increment o del progetto (qualunque linguetta), il tool (RDA,
// Complaints...) o la sezione. Con piu' tab aperti si distinguono al volo.
const APP_NAME = 'PP&C'

const STATIC_TITLES: Record<string, string> = {
  '/': 'Home',
  '/dashboard': 'Dashboard',
  '/releases': 'Releases',
  '/workload': 'Carico team',
  '/settings': 'Configurazione',
  '/users': 'Utenti',
  '/projects-dashboard': 'Dashboard increment',
  '/increments': 'Progetti',
  '/projects': 'Increment',
  '/tools': 'Tools',
  '/changelog': 'Versioni',
}

export function DocumentTitle() {
  const { pathname } = useLocation()
  const path = pathname.replace(/\/+$/, '') || '/'

  const projectMatch = /^\/projects\/(\d+)(?:\/([^/]+))?$/.exec(path)
  const incrementMatch = /^\/increments\/(\d+)$/.exec(path)
  const projectId = projectMatch ? Number(projectMatch[1]) : NaN
  const incrementId = incrementMatch ? Number(incrementMatch[1]) : NaN

  // Stesse query delle pagine: i dati arrivano dalla cache, nessuna chiamata in piu'.
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId),
    enabled: !Number.isNaN(projectId),
  })
  const { data: increment } = useQuery({
    queryKey: ['increment', incrementId],
    queryFn: () => api.increments.get(incrementId),
    enabled: !Number.isNaN(incrementId),
  })

  let title: string | undefined
  if (projectMatch) {
    title = project?.code ?? 'Increment'
  } else if (incrementMatch) {
    title = increment?.code ?? 'Progetto'
  } else {
    // Un tool con le sue sotto-pagine (Complaints > KPI): il nome del tool.
    title = STATIC_TITLES[path] ?? TOOLS.find((t) => path === t.path || path.startsWith(`${t.path}/`))?.name
  }

  useEffect(() => {
    document.title = title ? `${title} — ${APP_NAME}` : 'Project Planning & Controlling'
  }, [title])

  return null
}
