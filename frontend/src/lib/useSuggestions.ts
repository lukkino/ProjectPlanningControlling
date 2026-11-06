import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

// Suggerimenti per i campi vuoti: i valori dell'Admin che ha gia' configurato
// l'app (vedi backend routers/suggestions.py). Cache lunga: cambiano di rado.
export function useSuggestions() {
  return useQuery({ queryKey: ['suggestions'], queryFn: api.suggestions.get, staleTime: 5 * 60_000 }).data
}
