import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AUTH_REQUIRED_EVENT, authApi, setScopeUser, type User } from '../api/auth'
import { AuthContext, ROLE_ORDER, type AuthContextValue } from './authContext'

// Mostra l'app solo a un utente loggato: altrimenti la pagina di login (o,
// al primo avvio senza utenti, la creazione dell'amministratore).
export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: authApi.me, staleTime: Infinity, retry: false })

  useEffect(() => {
    const onRequired = () => queryClient.setQueryData(['auth', 'me'], null)
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired)
  }, [queryClient])

  // Cambio utente: via i dati in cache dell'utente precedente, tranne le
  // query di login (clear() le staccherebbe dal useQuery qui sopra, che
  // resterebbe sul vecchio valore).
  const switchUser = (user: User | null) => {
    setScopeUser(null)
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
    queryClient.setQueryData(['auth', 'me'], user)
  }
  const onLoggedIn = (user: User) => switchUser(user)

  if (me.isLoading) return <div className="auth-screen muted">Caricamento…</div>
  if (me.isError) {
    return (
      <div className="auth-screen">
        <div className="error-banner">Server non raggiungibile: {(me.error as Error).message}</div>
      </div>
    )
  }
  if (!me.data) return <LoginScreen onLoggedIn={onLoggedIn} />

  const user = me.data
  const value: AuthContextValue = {
    user,
    can: (role) => ROLE_ORDER.indexOf(user.role) >= ROLE_ORDER.indexOf(role),
    logout: () => {
      void authApi.logout().finally(() => switchUser(null))
    },
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: authApi.status, retry: false })
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const setup = status.data?.setup_required ?? false

  const submit = useMutation({
    mutationFn: async () => {
      if (setup) {
        if (password !== confirm) throw new Error('Le due password non coincidono.')
        return authApi.setup({ username, display_name: displayName, password })
      }
      return authApi.login(username, password)
    },
    onSuccess: onLoggedIn,
  })
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit.mutate()
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <img src="/logo_Inpeco.png" alt="Inpeco" style={{ height: 34, alignSelf: 'flex-start' }} />
        <h2 style={{ margin: '4px 0 0' }}>Project Planning &amp; Controlling</h2>
        {setup ? (
          <p className="muted" style={{ marginTop: 0 }}>
            Primo avvio: crea l'utente <strong>amministratore</strong>. Gli altri utenti si aggiungono poi dalla pagina
            Utenti.
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>
            Accedi con le tue credenziali.
          </p>
        )}
        <div className="form-row">
          <label htmlFor="auth-username">Username</label>
          <input id="auth-username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        {setup && (
          <div className="form-row">
            <label htmlFor="auth-name">Nome e cognome</label>
            <input id="auth-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        )}
        <div className="form-row">
          <label htmlFor="auth-password">Password{setup ? ' (almeno 8 caratteri)' : ''}</label>
          <input
            id="auth-password"
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {setup && (
          <div className="form-row">
            <label htmlFor="auth-confirm">Ripeti la password</label>
            <input id="auth-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        )}
        {submit.isError && <div className="error-banner">{(submit.error as Error).message}</div>}
        <button className="btn btn-primary" type="submit" disabled={submit.isPending || !username || !password}>
          {submit.isPending ? 'Accesso…' : setup ? 'Crea amministratore ed entra' : 'Accedi'}
        </button>
      </form>
    </div>
  )
}
