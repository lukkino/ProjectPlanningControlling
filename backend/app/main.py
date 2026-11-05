from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import models
from app.database import Base, SessionLocal, engine, run_budget_migrations, run_lightweight_migrations
from app.routers import backlog, complaints, dashboard, dashboard_snapshots, documents, forecasting, increment_components, increments, project_budget, projects, releases, review_folder, scenarios, settings, snapshots, tools_shipping

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

app = FastAPI(title="Project Planning & Controlling API")

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


@app.get("/api/health")
def health():
    return {"status": "ok"}
