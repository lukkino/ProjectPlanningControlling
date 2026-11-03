import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { BudgetCatalog } from '../api/types'

// Budget di progetto (vedi backend services/budget.py): catalogo del file di
// budget, formati e aggiornamento delle viste dopo una modifica.

export const useBudgetCatalog = () =>
  useQuery({ queryKey: ['budget-catalog'], queryFn: api.budget.catalog, staleTime: Infinity })

export const fmtHours = (value: number) => `${value.toLocaleString('it-IT', { maximumFractionDigits: 1 })} h`
export const fmtEuro = (value: number) =>
  `${value.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
export const fmtNumber = (value: number) => value.toLocaleString('it-IT', { maximumFractionDigits: 2 })

// "1.234,50" / "1234.5" / "-200" -> numero; vuoto = 0; null se non valido.
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(/€/g, '').replace(/\s/g, '')
  if (!trimmed) return 0
  const normalized = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

// Dopo una modifica del budget che vale: totali in alto e Consumo risorse
// (l'ultimo snapshot prende il budget) vanno riletti.
export function useRefreshBudget(incrementId: number) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['increment', incrementId] })
    queryClient.invalidateQueries({ queryKey: ['increment-snapshots', incrementId] })
    queryClient.invalidateQueries({ queryKey: ['increment-budget-lines', incrementId] })
  }
}

export const departmentLabel = (catalog: BudgetCatalog | undefined, code: string | null) => {
  const department = catalog?.departments.find((d) => d.code === code)
  return department ? `${department.code} ${department.name}` : (code ?? '—')
}
