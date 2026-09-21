import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { AppSettings } from '../api/types'

export function ConfigurationPage() {
  const { data: settings, isLoading } = useQuery({ queryKey: ['app-settings'], queryFn: api.settings.get })

  if (isLoading || !settings) return <p className="muted">Caricamento...</p>

  // key sui valori attuali: se cambiano sotto i piedi (es. un altro
  // salvataggio da un'altra scheda), il form si re-inizializza con quelli
  // nuovi invece di restare fermo su un vecchio stato locale.
  return <ConfigurationForm key={`${settings.jira_base_url}|${settings.jira_email}`} settings={settings} />
}

function ConfigurationForm({ settings }: { settings: AppSettings }) {
  const queryClient = useQueryClient()
  const [baseUrl, setBaseUrl] = useState(settings.jira_base_url ?? '')
  const [email, setEmail] = useState(settings.jira_email ?? '')
  // Il token non viene mai pre-compilato (e' un segreto, il backend non lo
  // restituisce mai): vuoto = "lascialo invariato" al salvataggio.
  const [token, setToken] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.settings.update({
        jira_base_url: baseUrl,
        jira_email: email,
        jira_api_token: token || undefined,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['app-settings'], saved)
      setToken('')
    },
  })

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h3 style={{ marginTop: 0 }}>Configurazione</h3>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        Credenziali usate per sincronizzare il Backlog da Jira. Modificarle qui aggiorna subito il database: non serve
        toccare <code>backend/.env</code> né riavviare il server, utile quando l'API token scade.
      </p>

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
      </div>

      {save.isError && <div className="error-banner" style={{ marginTop: 12 }}>{(save.error as Error).message}</div>}
      {save.isSuccess && (
        <div className="error-banner" style={{ marginTop: 12, background: '#e9f7ee', color: '#1a9c5c', borderColor: '#b8e3c8' }}>
          Configurazione salvata.
        </div>
      )}

      <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? 'Salvataggio...' : 'Salva'}
      </button>
    </div>
  )
}
