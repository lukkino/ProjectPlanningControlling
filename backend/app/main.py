from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import models
from app.database import Base, engine
from app.routers import backlog, dashboard, projects, snapshots

# MVP: create tables directly from the models on startup instead of a
# migration tool (Alembic can be introduced later if the schema needs to
# evolve without dropping data).
Base.metadata.create_all(bind=engine)

app = FastAPI(title="Project Planning & Controlling API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(backlog.router)
app.include_router(snapshots.router)
app.include_router(dashboard.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
