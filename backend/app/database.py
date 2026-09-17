from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# Make sure the data/ directory exists before SQLite tries to create the file.
if settings.database_url.startswith("sqlite:///./"):
    db_path = Path(settings.database_url.replace("sqlite:///./", "", 1))
    db_path.parent.mkdir(parents=True, exist_ok=True)

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def run_lightweight_migrations() -> None:
    """MVP: niente Alembic (vedi commento in main.py), quindi
    Base.metadata.create_all crea le tabelle nuove ma non altera quelle
    esistenti. Le colonne aggiunte dopo il primo deploy vanno quindi
    applicate qui a mano, una tantum e in modo idempotente, per non perdere
    i dati gia' presenti in data/app.db."""
    inspector = inspect(engine)
    table_names = inspector.get_table_names()
    if "projects" not in table_names:
        return  # prima esecuzione: create_all la crea gia' con la colonna

    project_columns = {col["name"] for col in inspector.get_columns("projects")}
    if "increment_id" not in project_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN increment_id INTEGER REFERENCES increments(id)"))

    if "increments" not in table_names:
        return  # prima esecuzione: create_all la crea gia' con le colonne nuove

    increment_columns = {col["name"] for col in inspector.get_columns("increments")}
    if "start_date" not in increment_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE increments ADD COLUMN start_date DATE"))
            conn.execute(text("ALTER TABLE increments ADD COLUMN end_date DATE"))
            conn.execute(text("ALTER TABLE increments ADD COLUMN estimated_budget_hours FLOAT DEFAULT 0"))
            conn.execute(text("ALTER TABLE increments ADD COLUMN estimated_budget_material FLOAT DEFAULT 0"))
            # release_date (rimosso dal modello, ora sostituito da
            # start_date/end_date) potrebbe gia' avere un valore inserito a
            # mano: lo si riporta su end_date per non perderlo.
            if "release_date" in increment_columns:
                conn.execute(text("UPDATE increments SET end_date = release_date WHERE release_date IS NOT NULL"))

    if "project_id" not in increment_columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE increments ADD COLUMN project_id INTEGER REFERENCES projects(id)"))
            # La relazione era al contrario (projects.increment_id): un
            # Project poteva puntare a un solo Increment, mentre in realta'
            # e' un Increment (Progetto) che appartiene al massimo a un
            # Project (Increment in UI). Si riporta qui il collegamento
            # gia' inserito, senza perderlo.
            if "increment_id" in project_columns:
                conn.execute(
                    text(
                        "UPDATE increments SET project_id = ("
                        "SELECT MIN(p.id) FROM projects p WHERE p.increment_id = increments.id"
                        ") WHERE EXISTS (SELECT 1 FROM projects p WHERE p.increment_id = increments.id)"
                    )
                )


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
