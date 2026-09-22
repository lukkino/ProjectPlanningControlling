import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { AppSettings } from '../api/types'
import { formatIsoDate } from '../lib/dates'

const MS_PER_DAY = 86_400_000

function expiryBadge(expiresAt: string | null): { label: string; color: string; bg: string } | null {
  if (!expiresAt) return null
  const days = Math.ceil((new Date(`${expiresAt}T00:00:00`).getTime() - Date.now()) / MS_PER_DAY)
  if (days < 0) return { label: `Scaduto da ${Math.abs(days)} giorni`, color: 'white', bg: 'var(--danger)' }
  if (days <= 7) return { label: `Scade tra ${days} giorni`, color: 'white', bg: 'var(--danger)' }
  if (days <= 30) return { label: `Scade tra ${days} giorni (${formatIsoDate(expiresAt)})`, color: '#7a4a00', bg: '#fff1d6' }
  return { label: `Scade il ${formatIsoDate(expiresAt)} (tra ${days} giorni)`, color: 'var(--success)', bg: '#e3f6ea' }
}

export function ConfigurationPage() {
  const { data: settings, isLoading } = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })

  if (isLoading || !settings) return <p className="muted">Caricamento...</p>

  // key sui valori attuali: se cambiano sotto i piedi (es. un altro
  // salvataggio da un'altra scheda), il form si re-inizializza con quelli
  // nuovi invece di restare fermo su un vecchio stato locale.
  return (
    <ConfigurationForm
      key={`${settings.jira_base_url}|${settings.jira_email}|${settings.jira_api_token_expires_at}|${settings.jira_project_key}`}
      settings={settings}
    />
  )
}

function ConfigurationForm({ settings }: { settings: AppSettings }) {
  const queryClient = useQueryClient()
  const [baseUrl, setBaseUrl] = useState(settings.jira_base_url ?? '')
  const [email, setEmail] = useState(settings.jira_email ?? '')
  // Il token non viene mai pre-compilato (e' un segreto, il backend non lo
  // restituisce mai): vuoto = "lascialo invariato" al salvataggio.
  const [token, setToken] = useState('')
  const [expiresAt, setExpiresAt] = useState(settings.jira_api_token_expires_at ?? '')
  const [projectKey, setProjectKey] = useState(settings.jira_project_key ?? '')

  const save = useMutation({
    mutationFn: () =>
      api.settings.update({
        jira_base_url: baseUrl,
        jira_email: email,
        jira_api_token: token || undefined,
        jira_api_token_expires_at: expiresAt || null,
        jira_project_key: projectKey || null,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['app-settings'], saved)
      setToken('')
    },
  })

  // Testa le credenziali correnti del form (non ancora salvate): utile per
  // verificare un token appena incollato prima di confermarlo con Salva.
  const test = useMutation({
    mutationFn: () => api.settings.test({ jira_base_url: baseUrl, jira_email: email, jira_api_token: token || undefined }),
  })

  const badge = expiryBadge(settings.jira_api_token_expires_at)

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h3 style={{ marginTop: 0 }}>Configurazione</h3>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        Credenziali usate per sincronizzare il Backlog da Jira. Modificarle qui aggiorna subito il database: non serve
        toccare <code>backend/.env</code> né riavviare il server, utile quando l'API token scade.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Stato token:
        </span>
        {badge ? (
          <span
            style={{ background: badge.bg, color: badge.color, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}
          >
            {badge.label}
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            nessuna scadenza impostata
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Jira base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://tuosito.atlassian.net" />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Email account Jira</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome.cognome@inpeco.com" />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Jira API token</span>
          <input
            type="password"
            placeholder={settings.jira_api_token_set ? `Attuale: ${settings.jira_api_token_preview}` : 'Nessun token impostato'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            Lascia vuoto per mantenere il token attuale. Generane uno nuovo su{' '}
            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
              id.atlassian.com
            </a>
            .
          </span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Jira project key</span>
          <input value={projectKey} onChange={(e) => setProjectKey(e.target.value)} placeholder="PTBSYS" style={{ maxWidth: 200 }} />
          <span className="muted" style={{ fontSize: 12 }}>
            Usata per le metriche calcolate sull'intero progetto Jira (es. il grafico "Metriche" nella Dashboard
            generale), a differenza della JQL per-increment del Backlog.
          </span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Scadenza token (facoltativa)</span>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={{ maxWidth: 200 }} />
          <span className="muted" style={{ fontSize: 12 }}>
            Jira non la comunica via API: riportala qui da quella scelta al momento della creazione su
            id.atlassian.com, solo per ricevere un avviso quando si avvicina.
          </span>
        </label>
      </div>

      {test.isSuccess && (
        <div
          className="error-banner"
          style={{
            marginTop: 12,
            background: test.data.ok ? '#e9f7ee' : undefined,
            color: test.data.ok ? '#1a9c5c' : undefined,
            borderColor: test.data.ok ? '#b8e3c8' : undefined,
          }}
        >
          {test.data.message}
        </div>
      )}
      {test.isError && <div className="error-banner" style={{ marginTop: 12 }}>{(test.error as Error).message}</div>}

      {save.isError && <div className="error-banner" style={{ marginTop: 12 }}>{(save.error as Error).message}</div>}
      {save.isSuccess && (
        <div className="error-banner" style={{ marginTop: 12, background: '#e9f7ee', color: '#1a9c5c', borderColor: '#b8e3c8' }}>
          Configurazione salvata.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Verifica...' : '🔌 Testa connessione'}
        </button>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Salvataggio...' : 'Salva'}
        </button>
      </div>
    </div>
  )
}
