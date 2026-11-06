// Login, utente corrente e gestione utenti (vedi backend app/auth.py e
// app/routers/users.py). La sessione e' un cookie HttpOnly: il browser lo
// manda da solo a ogni chiamata /api.

export type Role = 'viewer' | 'editor' | 'admin'

export const ROLE_LABELS: Record<Role, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' }

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Solo consultazione (può generare documenti e presentazioni)',
  editor: 'Modifica increment, backlog, documenti e il resto dei dati',
  admin: 'Come Editor, più utenti, Configurazione (token Jira) e template',
}

export type User = {
  id: number
  username: string
  display_name: string
  email: string | null
  role: Role
  is_active: boolean
  auth_provider: string
  created_at: string
  last_login_at: string | null
}

export type UserCreate = { username: string; display_name: string; email: string | null; role: Role; password: string }
export type UserUpdate = Partial<{ display_name: string; email: string | null; role: Role; is_active: boolean; password: string }>

// Evento lanciato quando una chiamata /api risponde 401 (sessione scaduta o
// utente disattivato): AuthGate torna alla pagina di login.
export const AUTH_REQUIRED_EVENT = 'auth:required'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = await response.json()
      detail = body.detail ?? detail
    } catch {
      // ignore, keep statusText
    }
    throw new Error(detail)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const authApi = {
  status: () => call<{ setup_required: boolean }>('/auth/status'),
  // null = non loggato.
  me: async (): Promise<User | null> => {
    const response = await fetch('/api/auth/me')
    if (response.status === 401) return null
    if (!response.ok) throw new Error(response.statusText)
    return response.json()
  },
  login: (username: string, password: string) =>
    call<User>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  setup: (data: { username: string; display_name: string; password: string }) =>
    call<User>('/auth/setup', { method: 'POST', body: JSON.stringify(data) }),
  logout: () => call<void>('/auth/logout', { method: 'POST' }),
  changePassword: (current_password: string, new_password: string) =>
    call<void>('/auth/password', { method: 'POST', body: JSON.stringify({ current_password, new_password }) }),
  users: {
    list: () => call<User[]>('/users'),
    create: (data: UserCreate) => call<User>('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: UserUpdate) => call<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: number) => call<void>(`/users/${id}`, { method: 'DELETE' }),
  },
}

// "Dati di" (solo Admin): l'utente di cui l'Admin sta guardando/modificando
// increment, progetti, releases, complaints e JQL. null = i propri. Va al
// backend in ogni chiamata come header X-Scope-User (ignorato per i non
// Admin); ricordato nel browser.
const SCOPE_KEY = 'ppc-scope-user'
let scopeUserId: number | null = (() => {
  try {
    const value = Number(localStorage.getItem(SCOPE_KEY))
    return value > 0 ? value : null
  } catch {
    return null
  }
})()

export const getScopeUser = () => scopeUserId

export function setScopeUser(userId: number | null) {
  scopeUserId = userId
  try {
    if (userId) localStorage.setItem(SCOPE_KEY, String(userId))
    else localStorage.removeItem(SCOPE_KEY)
  } catch {
    // storage non disponibile: vale solo per questa pagina
  }
}

// Intercetta tutte le fetch dell'app: aggiunge lo scope e, se una chiamata
// /api (fuori da /api/auth) risponde 401, la sessione e' scaduta e si torna
// al login.
export function installAuthInterceptor() {
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url, window.location.origin).pathname
    if (scopeUserId && path.startsWith('/api/')) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('X-Scope-User', String(scopeUserId))
      init = { ...init, headers }
    }
    const response = await original(input, init)
    if (response.status === 401 && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    }
    return response
  }
}
