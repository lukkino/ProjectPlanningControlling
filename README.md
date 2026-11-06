# Project Planning & Controlling

Webapp per gestire N progetti con un'interfaccia di controlling ispirata al
foglio Excel `Controlling-MC.xlsm` (Dashboard, Scope Plan/Backlog, KPI,
andamento nel tempo), con sincronizzazione live delle issue da **Jira Cloud**.

- **Backend**: FastAPI + SQLAlchemy, database SQLite (`backend/data/app.db`)
- **Frontend**: React + TypeScript (Vite), React Query, Recharts

## Setup

### 1. Backend

Il virtualenv Python è nella cartella principale del repo (`.venv`), non
dentro `backend`. Da PowerShell, partendo dalla root del progetto:

```powershell
# 1. attiva il virtualenv (nota il puntino iniziale di ".venv")
.venv\Scripts\Activate.ps1

# 2. spostati nella cartella backend e installa le dipendenze
cd backend
pip install -r requirements.txt

# 3. crea il file di configurazione (solo la prima volta)
copy .env.example .env
notepad .env
# nel file compila:
#   JIRA_BASE_URL  -> es. https://inpeco.atlassian.net
#   JIRA_EMAIL     -> la tua email Jira
#   JIRA_API_TOKEN -> genera un token su
#                     https://id.atlassian.com/manage-profile/security/api-tokens
# salva e chiudi notepad

# 4. avvia il server
uvicorn app.main:app --reload --port 8000
```

Se PowerShell rifiuta di eseguire `Activate.ps1` con un errore sulla
"execution policy", puoi saltare l'attivazione e richiamare l'eseguibile del
venv direttamente (da dentro `backend`):

```powershell
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

In entrambi i casi, quando vedi in console `Uvicorn running on
http://127.0.0.1:8000` il backend è avviato: lascia questa finestra aperta e
apri una **nuova** finestra PowerShell per il frontend (punto 2 sotto).
Verifica che funzioni aprendo `http://localhost:8000/api/health` nel
browser: deve rispondere `{"status":"ok"}`.

L'API risponde su `http://localhost:8000` (`GET /api/health` per verificare).
Il database SQLite viene creato automaticamente al primo avvio.

> Nota: `JIRA_API_TOKEN` resta solo nel file locale `.env` (escluso da git) e
> non viene mai salvato nel database: la sincronizzazione backlog funziona
> solo se il processo backend ha queste variabili configurate.

### 2. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Apri `http://localhost:5174`. In sviluppo, Vite fa da proxy delle chiamate
`/api/*` verso il backend su `:8000` (vedi `frontend/vite.config.ts`).

### 3. Utenti e login

L'app richiede il login. Al **primo avvio** (database senza utenti) la pagina
di accesso chiede di creare l'utente **amministratore**; gli altri utenti si
creano poi dalla pagina **Utenti** (in basso nella barra laterale, solo Admin).

| Ruolo  | Cosa può fare |
|--------|---------------|
| Viewer | Consulta tutto; genera documenti e presentazioni; non modifica i dati |
| Editor | Modifica increment, backlog, documenti, releases e il resto dei dati |
| Admin  | Come Editor, più Utenti, Configurazione (token Jira condiviso) e template della Release Notice |

I permessi sono controllati dal backend su ogni chiamata `/api` (vedi
`backend/app/auth.py`, `required_role`). Le password sono salvate cifrate
(scrypt); la sessione è un cookie HttpOnly che dura 7 giorni dall'ultimo uso.

## Installazione su server/VM (multi-utente)

Sul server serve un solo processo: il backend serve anche il frontend
compilato, sulla stessa porta.

```powershell
# 1. codice + dipendenze (come nel Setup sopra)
git clone https://github.com/lukkino/ProjectPlanningControlling.git
cd ProjectPlanningControlling
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt

# 2. frontend compilato in frontend\dist (servito dal backend)
cd frontend
npm install
npm run build
cd ..

# 3. avvio, raggiungibile dalla rete (porta da aprire nel firewall)
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Gli utenti aprono `http://<nome-server>:8000`. Note:

- **Database**: `backend\data\app.db` (SQLite, va bene per pochi utenti in
  contemporanea). Per spostare i dati attuali basta copiarlo sul server con
  il backend fermo. Fare backup regolari della cartella `backend\data`.
- **Servizio Windows**: per farlo partire con il server, registrare il comando
  del punto 3 come servizio (es. con NSSM) invece di lasciarlo in una console.
- **HTTPS**: se il server è dietro HTTPS (es. reverse proxy IIS), mettere
  `COOKIE_SECURE=true` in `backend\.env`, così il cookie di sessione viaggia
  solo cifrato.
- **Jira**: il token è unico e condiviso, lo imposta l'Admin in Configurazione.
- **Cartelle** (scenari, documenti di review): i percorsi sono letti **dal
  server**, quindi vanno indicati come cartelle di rete (`\\server\share\...`)
  accessibili all'utente con cui gira il servizio; i pulsanti "Apri cartella"
  aprono Esplora risorse sul server, non sul PC di chi clicca.
- **Documenti PPR**: la generazione usa Excel, che deve essere installato sul
  server.
- **Aggiornamenti**: `git pull`, `pip install -r backend\requirements.txt`,
  `npm run build` in `frontend`, poi riavvio del servizio.

## Come funziona

1. **Progetti**: crea un progetto dalla barra laterale (codice, nome, date,
   budget ore/materiali, e opzionalmente una **JQL Jira** che definisce quali
   issue fanno parte del suo backlog).
2. **Dashboard**: anagrafica, % completamento backlog, ore budget vs loggate,
   SPI semplificato, fasi progetto (Kickoff/Planning/Execution/Deployment),
   budget ore per ruolo, andamento nel tempo.
3. **Backlog**: griglia degli item (equivalente al foglio "scope_plan").
   Il bottone **"Sincronizza da Jira"** esegue la JQL del progetto e crea/
   aggiorna gli item per `jira_key` (summary, tipo, stato Jira, label, ore
   da Time Tracking Jira → `logged_hours`, e le date effettive → `actual_start`/
   `actual_finish` ricavate dal changelog Jira: prima transizione a
   "In Progress" (o "On-Going" per le Activity) e ultima transizione a "Done";
   tutti questi campi sono sempre sovrascritti, Jira e' la fonte di verita'
   anche se il valore era stato modificato a mano); gli altri campi di
   pianificazione (sizing, note, in-scope) restano invece gestiti nell'app e
   non vengono mai sovrascritti dal sync.
4. **Andamento**: storico di snapshot (data, ore, PBI completati) usato per
   il grafico di trend nella Dashboard.

## Roadmap (non incluso nell'MVP)

Il file Excel originale include logiche più avanzate, rimandate a una fase
successiva:

- Cascata automatica delle date di pianificazione tra gli item (`WORKDAY` +
  giorni di ferie)
- Classificazione **Monte Carlo** degli item "To Do" dentro/fuori scope in
  base allo slot residuo prima del code freeze
- Earned Value Management completo per singolo item (ACWP/BCWP/BCWS/EAC/CPI)
- Rendicontazione ore per risorsa
- Autenticazione multi-utente (il modello dati è già strutturato per
  aggiungerla senza cambi radicali: ogni tabella è già scoped su `project_id`)

## Struttura repo

```
backend/app/
  main.py, config.py, database.py, models.py, schemas.py
  routers/     projects.py, backlog.py, dashboard.py, snapshots.py
  services/    jira_client.py, metrics.py
frontend/src/
  api/         client.ts, types.ts
  pages/       ProjectLayout, DashboardPage, BacklogPage, SnapshotsPage, WelcomePage
  components/  Sidebar, ProjectFormModal, PhasesCard, BudgetLinesCard, StatusBadge
```
