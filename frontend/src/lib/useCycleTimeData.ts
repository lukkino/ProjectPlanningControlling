import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Team } from '../api/types'

// Storico Cycle Time (PBI Done degli ultimi 12 mesi) usato da Monte Carlo e
// da "Aggiungi simulazione" del Forecasting. L'estrazione Jira e' lenta (un
// changelog per issue): parte solo da refresh(), mai da sola. Finche' non la
// si rifa' valgono i dati dell'ultima estrazione salvata dal backend, cosi'
// restano disponibili anche ricaricando la pagina o dopo un riavvio. La query
// "live" e' la stessa della Dashboard generale: se li' i dati sono gia' stati
// estratti in questa sessione, qui si vedono subito.
export function useCycleTimeData(team: Team) {
  const live = useQuery({
    queryKey: ['dashboard', 'cycle-time', team],
    queryFn: () => api.dashboard.cycleTime(team),
    staleTime: Infinity,
    enabled: false,
  })
  const cached = useQuery({
    queryKey: ['dashboard', 'cycle-time-cached', team],
    queryFn: () => api.dashboard.cycleTimeCached(team),
    staleTime: Infinity,
  })
  // Un'estrazione live non riuscita (data.error) non nasconde quella salvata.
  const liveOk = live.data && !live.data.error ? live.data : undefined
  const data = liveOk ?? cached.data ?? live.data ?? undefined

  return {
    data,
    // Errore dell'ultima estrazione richiesta (rete o Jira).
    error: live.isError ? (live.error as Error).message : (live.data?.error ?? null),
    isFetching: live.isFetching,
    isLoadingCached: cached.isLoading,
    refresh: async () => (await live.refetch()).data,
  }
}
