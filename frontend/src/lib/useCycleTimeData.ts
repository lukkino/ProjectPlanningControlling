import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Team } from '../api/types'

// Storico Cycle Time (PBI Done degli ultimi 12 mesi) usato da Monte Carlo e
// da "Aggiungi simulazione" del Forecasting. L'estrazione Jira e' lenta (un
// changelog per issue): parte solo da refresh(), mai da sola. Finche' non la
// si rifa' valgono i dati dell'ultima estrazione salvata dal backend, cosi'
// restano disponibili anche ricaricando la pagina o dopo un riavvio. La query
// "live" e' la stessa della Dashboard generale: se li' i dati sono gia' stati
// estratti in questa sessione, qui si vedono subito.
// since: inizio della finestra storica scelta; "Aggiorna da Jira" estrae da
// li' se e' oltre gli ultimi 12 mesi.
export function useCycleTimeData(team: Team, since?: string | null) {
  const queryClient = useQueryClient()
  // In alternativa a Jira: un file pre-elaborato (CSV). Il risultato
  // sostituisce sia l'estrazione salvata sia quella "live" di questa
  // sessione, cosi' tutte le pagine che usano lo storico lo vedono.
  const importFile = useMutation({
    mutationFn: async (file: File) => api.dashboard.importCycleTime(team, file.name, await file.text()),
    onSuccess: (metrics) => {
      queryClient.setQueryData(['dashboard', 'cycle-time', team], metrics)
      queryClient.setQueryData(['dashboard', 'cycle-time-cached', team], metrics)
    },
  })
  const live = useQuery({
    queryKey: ['dashboard', 'cycle-time', team],
    queryFn: () => api.dashboard.cycleTime(team, since),
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
    importFile: (file: File) => importFile.mutate(file),
    isImporting: importFile.isPending,
    importError: importFile.isError ? (importFile.error as Error).message : null,
  }
}
