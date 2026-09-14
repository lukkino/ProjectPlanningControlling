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
   da Time Tracking Jira → `logged_hours`, sempre sovrascritte: Jira e' la
   fonte di verita' anche se il valore era stato modificato a mano); gli
   altri campi di pianificazione (date, sizing, note, in-scope) restano
   invece gestiti nell'app e non vengono mai sovrascritti dal sync.
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
