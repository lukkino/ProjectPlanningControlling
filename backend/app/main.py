from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from app import auth, models, ownership
from app.database import Base, SessionLocal, engine, run_budget_migrations, run_lightweight_migrations
from app.routers import app_info, backlog, change_order, complaints, dashboard, dashboard_snapshots, documents, forecasting, increment_components, increments, project_budget, projects, releases, review_folder, scenarios, settings, snapshots, suggestions, team, tools_certifications, tools_purchase_requisitions, tools_shipping, users

# MVP: create tables directly from the models on startup instead of a
# migration tool (Alembic can be introduced later if the schema needs to
# evolve without dropping data).
Base.metadata.create_all(bind=engine)
run_lightweight_migrations()
run_budget_migrations()
# Il code freeze ufficiale e' la fase "Code freeze": ogni increment deve
# averla e la copia sull'increment deve coincidere.
with SessionLocal() as _db:
    projects.ensure_date_phases(_db)
    # Dati di prima del multi-utente: al primo Admin (vedi ownership.py).
    ownership.claim_orphans_for_first_admin(_db)

# Login e ruolo minimo su ogni chiamata /api (vedi auth.required_role).
app = FastAPI(
    title="Project Planning & Controlling API",
    dependencies=[Depends(auth.authorize), Depends(auth.apply_scope)],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
# Prima di increments: /api/increments/budget-catalog non e' un id.
app.include_router(project_budget.router)
app.include_router(increments.router)
app.include_router(backlog.router)
app.include_router(scenarios.router)
app.include_router(review_folder.router)
app.include_router(change_order.router)
app.include_router(snapshots.router)
app.include_router(dashboard.router)
app.include_router(dashboard_snapshots.router)
app.include_router(forecasting.router)
app.include_router(documents.router)
app.include_router(settings.router)
app.include_router(complaints.router)
app.include_router(releases.router)
app.include_router(increment_components.router)
app.include_router(tools_shipping.router)
app.include_router(tools_certifications.router)
app.include_router(tools_purchase_requisitions.router)
app.include_router(team.router)
app.include_router(app_info.router)
app.include_router(users.router)
app.include_router(suggestions.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Installazione su server: se il frontend e' stato compilato (npm run build in
# frontend/), lo serve direttamente il backend sulla stessa porta, cosi' basta
# un solo processo. In sviluppo la cartella non c'e' e si usa Vite (:5174).
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

if FRONTEND_DIST.is_dir():

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        file = (FRONTEND_DIST / path).resolve()
        if path and file.is_file() and FRONTEND_DIST in file.parents:
            return FileResponse(file)
        # Rotte della single page app (es. /projects/1/backlog): index.html.
        return FileResponse(FRONTEND_DIST / "index.html")

