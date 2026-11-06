import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { authApi, getScopeUser, ROLE_LABELS, setScopeUser } from '../api/auth'
import { useAuth } from './authContext'

// Barra in alto a destra (come su Jira): ingranaggio con Configurazione e,
// per l'Admin, Utenti; avatar con utente, "Dati di" (Admin), password, esci.
export function TopBar() {
  const { user, can } = useAuth()
  const users = useQuery({
    queryKey: ['auth', 'users'],
    queryFn: authApi.users.list,
    staleTime: 60_000,
    enabled: user.role === 'admin',
  })
  const scoped = users.data?.find((u) => u.id === getScopeUser() && u.id !== user.id)
  return (
    <header className="topbar">
      {scoped && <ScopeBadge name={scoped.display_name} />}
      {can('editor') && (
        <Dropdown
          label="Impostazioni"
          trigger={<span className="topbar-icon">⚙️</span>}
          render={(close) => (
            <>
              <div className="topbar-menu-title">Impostazioni</div>
              <Link className="topbar-menu-item" to="/settings" onClick={close}>
                Configurazione
              </Link>
              {can('admin') && (
                <Link className="topbar-menu-item" to="/users" onClick={close}>
                  Utenti
                </Link>
              )}
            </>
          )}
        />
      )}
      <UserMenu />
    </header>
  )
}

// Menu a tendina che si chiude cliccando fuori o con Esc.
function Dropdown({
  label,
  trigger,
  render,
}: {
  label: string
  trigger: ReactNode
  render: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="topbar-dropdown" ref={ref}>
      <button
        type="button"
        className={`topbar-button${open ? ' active' : ''}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && <div className="topbar-menu">{render(() => setOpen(false))}</div>}
    </div>
  )
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?'

function UserMenu() {
  const { user, logout } = useAuth()
  const [changing, setChanging] = useState(false)
  return (
    <>
      <Dropdown
        label={`Account: ${user.display_name}`}
        trigger={<span className="topbar-avatar">{initials(user.display_name)}</span>}
        render={(close) => (
          <>
            <div className="topbar-menu-user">
              <span className="topbar-avatar topbar-avatar--large">{initials(user.display_name)}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{user.display_name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {user.username} · {ROLE_LABELS[user.role]}
                </div>
              </div>
            </div>
            {user.role === 'admin' && <ScopeSelector onChanged={close} />}
            <button
              type="button"
              className="topbar-menu-item"
              onClick={() => {
                close()
                setChanging(true)
              }}
            >
              Cambia password
            </button>
            <button type="button" className="topbar-menu-item" onClick={logout}>
              Esci
            </button>
          </>
        )}
      />
      {changing && <ChangePasswordModal onClose={() => setChanging(false)} />}
    </>
  )
}

// Cambia di quale utente mostrare i dati: si svuota la cache (tranne login e
// elenco utenti) e si torna alla home, perche' la pagina aperta puo' essere
// di un altro utente.
function useSwitchScope() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return (userId: number | null) => {
    setScopeUser(userId)
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
    navigate('/')
  }
}

// Si stanno guardando i dati di un altro utente (solo Admin): ben visibile,
// con la x per tornare ai propri.
function ScopeBadge({ name }: { name: string }) {
  const switchScope = useSwitchScope()
  return (
    <span className="topbar-scope-badge" title="Stai vedendo e modificando i dati di un altro utente">
      Dati di <strong>{name}</strong>
      <button type="button" aria-label="Torna ai miei dati" title="Torna ai miei dati" onClick={() => switchScope(null)}>
        ✕
      </button>
    </span>
  )
}

// Solo Admin: di quale utente mostrare increment, progetti, releases,
// complaints e JQL (ognuno ha i suoi).
function ScopeSelector({ onChanged }: { onChanged: () => void }) {
  const { user } = useAuth()
  const switchScope = useSwitchScope()
  const users = useQuery({ queryKey: ['auth', 'users'], queryFn: authApi.users.list, staleTime: 60_000 })
  const others = users.data?.filter((u) => u.id !== user.id) ?? []
  if (others.length === 0) return null
  return (
    <label className="topbar-menu-scope" title="Come Admin puoi vedere e modificare i dati di ogni utente">
      Dati di
      <select
        value={getScopeUser() ?? user.id}
        onChange={(e) => {
          const id = Number(e.target.value)
          switchScope(id === user.id ? null : id)
          onChanged()
        }}
      >
        <option value={user.id}>me ({user.display_name})</option>
        {others.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name}
          </option>
        ))}
      </select>
    </label>
  )
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      if (next !== confirm) throw new Error('Le due nuove password non coincidono.')
      await authApi.changePassword(current, next)
    },
  })
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        style={{ width: 420 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <h3 style={{ marginTop: 0 }}>Cambia password</h3>
        {save.isSuccess ? (
          <p>✓ Password cambiata. Le sessioni aperte su altri PC sono state chiuse.</p>
        ) : (
          <>
            <div className="form-row">
              <label>Password attuale</label>
              <input type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="form-row">
              <label>Nuova password (almeno 8 caratteri)</label>
              <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="form-row">
              <label>Ripeti la nuova password</label>
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}
          </>
        )}
        <div className="form-actions">
          <button className="btn" type="button" onClick={onClose}>
            {save.isSuccess ? 'Chiudi' : 'Annulla'}
          </button>
          {!save.isSuccess && (
            <button className="btn btn-primary" type="submit" disabled={save.isPending || !current || !next}>
              Salva
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
