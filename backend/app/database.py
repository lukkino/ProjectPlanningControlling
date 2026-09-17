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
    if "projects" not in inspector.get_table_names():
        return  # prima esecuzione: create_all la crea gia' con la colonna
    columns = {col["name"] for col in inspector.get_columns("projects")}
    if "increment_id" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN increment_id INTEGER REFERENCES increments(id)"))


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
