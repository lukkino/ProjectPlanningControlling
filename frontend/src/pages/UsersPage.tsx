import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { authApi, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role, type User } from '../api/auth'
import { useAuth } from '../components/authContext'
import { formatDateTime } from '../lib/dates'

const ROLES: Role[] = ['viewer', 'editor', 'admin']

// Gestione utenti (solo Admin): creazione, ruolo, attivazione, reset password.
export function UsersPage() {
  const { user: me } = useAuth()
  const queryClient = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: authApi.users.list })
  const [showNew, setShowNew] = useState(false)
  const [resetFor, setResetFor] = useState<User | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] })

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof authApi.users.update>[1] }) =>
      authApi.users.update(id, data),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: authApi.users.remove, onSuccess: refresh })
  const error = (update.error ?? remove.error) as Error | null

  return (
    <div>
      <div className="page-header">
        <h1>Utenti</h1>
        <div className="sub">Chi può accedere all'app e con quale ruolo.</div>
      </div>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {ROLES.map((r) => (
              <div key={r}>
                <strong>{ROLE_LABELS[r]}</strong>: {ROLE_DESCRIPTIONS[r]}
              </div>
            ))}
          </div>
          <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setShowNew(true)}>
            + Nuovo utente
          </button>
        </div>
        {error && <div className="error-banner">{error.message}</div>}
        {users.isLoading && <p className="muted">Caricamento…</p>}
        {users.error && <div className="error-banner">{(users.error as Error).message}</div>}
        {users.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Ruolo</th>
                  <th>Attivo</th>
                  <th>Ultimo accesso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => {
                  const self = u.id === me.id
                  return (
                    <tr key={u.id} style={u.is_active ? undefined : { opacity: 0.55 }}>
                      <td>
                        <input
                          defaultValue={u.display_name}
                          aria-label="Nome"
                          onBlur={(e) => {
                            if (e.target.value.trim() !== u.display_name) update.mutate({ id: u.id, data: { display_name: e.target.value } })
                          }}
                        />
                        {self && <span className="muted"> (tu)</span>}
                      </td>
                      <td>{u.username}</td>
                      <td>
                        <input
                          defaultValue={u.email ?? ''}
                          aria-label="Email"
                          placeholder="—"
                          onBlur={(e) => {
                            if (e.target.value.trim() !== (u.email ?? '')) update.mutate({ id: u.id, data: { email: e.target.value } })
                          }}
                        />
                      </td>
                      <td>
                        <select
                          value={u.role}
                          aria-label="Ruolo"
                          onChange={(e) => update.mutate({ id: u.id, data: { role: e.target.value as Role } })}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={u.is_active}
                          disabled={self}
                          aria-label="Attivo"
                          title={self ? 'Non puoi disattivare il tuo utente' : 'Un utente disattivato non può più accedere'}
                          onChange={(e) => update.mutate({ id: u.id, data: { is_active: e.target.checked } })}
                        />
                      </td>
                      <td className="muted">{u.last_login_at ? formatDateTime(u.last_login_at) : 'mai'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn" onClick={() => setResetFor(u)}>
                          Imposta password
                        </button>{' '}
                        {!self && (
                          <button
                            className="btn"
                            title="Elimina l'utente"
                            onClick={() => {
                              if (window.confirm(`Eliminare l'utente ${u.display_name}?`)) remove.mutate(u.id)
                            }}
                          >
                            🗑
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {showNew && <NewUserModal onClose={() => setShowNew(false)} onCreated={refresh} />}
      {resetFor && <SetPasswordModal user={resetFor} onClose={() => setResetFor(null)} />}
    </div>
  )
}

function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [password, setPassword] = useState('')
  const create = useMutation({
    mutationFn: () => authApi.users.create({ username, display_name: displayName, email: email || null, role, password }),
    onSuccess: () => {
      onCreated()
      onClose()
    },
  })
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <h3 style={{ marginTop: 0 }}>Nuovo utente</h3>
        <div className="form-row">
          <label>Username (per l'accesso)</label>
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Nome e cognome</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Email (facoltativa)</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Ruolo</label>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]} — {ROLE_DESCRIPTIONS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>Password iniziale (almeno 8 caratteri, da comunicare all'utente)</label>
          <input type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {create.isError && <div className="error-banner">{(create.error as Error).message}</div>}
        <div className="form-actions">
          <button className="btn" type="button" onClick={onClose}>
            Annulla
          </button>
          <button className="btn btn-primary" type="submit" disabled={create.isPending || !username || !password}>
            Crea
          </button>
        </div>
      </form>
    </div>
  )
}

function SetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const save = useMutation({ mutationFn: () => authApi.users.update(user.id, { password }), onSuccess: onClose })
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
        <h3 style={{ marginTop: 0 }}>Nuova password per {user.display_name}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Le sessioni aperte dell'utente vengono chiuse: dovrà accedere con la nuova password.
        </p>
        <div className="form-row">
          <label>Nuova password (almeno 8 caratteri)</label>
          <input type="text" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}
        <div className="form-actions">
          <button className="btn" type="button" onClick={onClose}>
            Annulla
          </button>
          <button className="btn btn-primary" type="submit" disabled={save.isPending || !password}>
            Salva
          </button>
        </div>
      </form>
    </div>
  )
}
