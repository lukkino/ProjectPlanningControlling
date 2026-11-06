import { createContext, useContext } from 'react'
import type { Role, User } from '../api/auth'

export type AuthContextValue = {
  user: User
  can: (role: Role) => boolean
  logout: () => void
}

export const ROLE_ORDER: Role[] = ['viewer', 'editor', 'admin']

export const AuthContext = createContext<AuthContextValue | null>(null)

// Utente collegato e permessi (dentro AuthGate).
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth fuori da AuthGate')
  return value
}
