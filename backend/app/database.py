import datetime as dt
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

    if "backlog_items" in table_names:
        backlog_columns = {col["name"] for col in inspector.get_columns("backlog_items")}
        if "progetto_id" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN progetto_id INTEGER REFERENCES increments(id)"))

    if "increment_budget_lines" in table_names:
        budget_line_columns = {col["name"] for col in inspector.get_columns("increment_budget_lines")}
        if "actual_hours" not in budget_line_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE increment_budget_lines ADD COLUMN actual_hours FLOAT DEFAULT 0"))

        # "Andamento": role_name/budget_hours diventano nomi generici
        # (category_name/budget_value), perche' ora le voci non sono piu'
        # solo ruoli/ore (es. "Prototype", "Travels" - vedi
        # models.IncrementBudgetLine). L'Actual per voce si sposta dentro
        # gli snapshot (vedi sotto): qui resta solo il target di budget.
        budget_line_columns = {col["name"] for col in inspector.get_columns("increment_budget_lines")}
        if "role_name" in budget_line_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE increment_budget_lines RENAME COLUMN role_name TO category_name"))
                conn.execute(text("ALTER TABLE increment_budget_lines RENAME COLUMN budget_hours TO budget_value"))
                conn.execute(text("ALTER TABLE increment_budget_lines ADD COLUMN is_hours BOOLEAN DEFAULT 0"))
                # Le 4 voci originali (Project Management/Development/
                # Testing/System Testing) erano tutte ore: preserva il loro
                # significato nei totali aggregati esistenti.
                conn.execute(text("UPDATE increment_budget_lines SET is_hours = 1"))

        # Le "Ore Actual" gia' inserite a mano per voce (funzionalita' ormai
        # sostituita dall'Andamento) vanno preservate migrandole in UNO
        # snapshot iniziale per progetto, prima che la colonna diventi
        # orfana. Idempotente: azzera actual_hours dopo averle migrate, cosi'
        # non vengono ricreate ad ogni riavvio.
        budget_line_columns = {col["name"] for col in inspector.get_columns("increment_budget_lines")}
        if "actual_hours" in budget_line_columns:
            with engine.begin() as conn:
                # Solo gli Increment con ALMENO una voce diversa da zero
                # ricevono uno snapshot migrato, ma con un valore per OGNI
                # voce di quell'Increment (anche quelle a zero): la tabella
                # dell'Andamento e' sempre un rettangolo pieno, mai con
                # celle mancanti.
                increments_to_migrate = {
                    row[0]
                    for row in conn.execute(
                        text("SELECT DISTINCT increment_id FROM increment_budget_lines WHERE actual_hours != 0")
                    ).fetchall()
                }
                for increment_id in increments_to_migrate:
                    result = conn.execute(
                        text(
                            "INSERT INTO increment_snapshots (increment_id, snapshot_date, note) "
                            "VALUES (:inc, :date, :note)"
                        ),
                        {"inc": increment_id, "date": dt.date.today().isoformat(), "note": "Migrato da \"Ore Actual\""},
                    )
                    snapshot_id = result.lastrowid
                    all_lines = conn.execute(
                        text("SELECT id, actual_hours FROM increment_budget_lines WHERE increment_id = :inc"),
                        {"inc": increment_id},
                    ).fetchall()
                    for line_id, actual in all_lines:
                        conn.execute(
                            text(
                                "INSERT INTO increment_snapshot_values (snapshot_id, budget_line_id, actual_value) "
                                "VALUES (:snap, :line, :val)"
                            ),
                            {"snap": snapshot_id, "line": line_id, "val": actual or 0},
                        )
                if increments_to_migrate:
                    conn.execute(text("UPDATE increment_budget_lines SET actual_hours = 0"))

    if "increment_snapshot_values" in table_names:
        value_columns = {col["name"] for col in inspector.get_columns("increment_snapshot_values")}
        if "budget_value" not in value_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE increment_snapshot_values ADD COLUMN budget_value FLOAT DEFAULT 0"))
                # Il budget era finora un valore unico per voce (valido per
                # tutta la vita del progetto): diventa anch'esso per
                # snapshot (una revisione budget puo' cambiarlo nel tempo),
                # quindi si riporta su OGNI snapshot esistente il valore
                # attuale della voce, cosi' non sparisce.
                if "increment_budget_lines" in table_names:
                    budget_line_columns = {col["name"] for col in inspector.get_columns("increment_budget_lines")}
                    if "budget_value" in budget_line_columns:
                        conn.execute(
                            text(
                                "UPDATE increment_snapshot_values "
                                "SET budget_value = ("
                                "SELECT budget_value FROM increment_budget_lines "
                                "WHERE increment_budget_lines.id = increment_snapshot_values.budget_line_id"
                                ")"
                            )
                        )

    if "increment_budget_lines" in table_names:
        # budget_value non e' piu' nel modello (vive per snapshot, vedi
        # sopra), ma un colonna orfana con vincolo NOT NULL bloccherebbe ogni
        # nuovo INSERT (SQLAlchemy non la valorizza piu'): a differenza delle
        # altre colonne orfane di questa app, qui va rimossa per davvero.
        budget_line_columns = {col["name"] for col in inspector.get_columns("increment_budget_lines")}
        if "budget_value" in budget_line_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE increment_budget_lines DROP COLUMN budget_value"))

    if "projects" in table_names:
        project_columns = {col["name"] for col in inspector.get_columns("projects")}
        if "is_current" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN is_current BOOLEAN DEFAULT 0"))
        if "gantt_order" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN gantt_order INTEGER"))

        # estimated_budget_hours/estimated_budget_material sono relitti di
        # uno schema precedente allo split Project/Increment (il budget vive
        # solo su Increment ora, vedi models.py): con vincolo NOT NULL e
        # nessun default, bloccavano ogni nuovo INSERT perche' SQLAlchemy non
        # li valorizza piu'. increment_id e' un relitto del verso sbagliato
        # della relazione Project<->Increment (corretto in Increment.project_id).
        project_columns = {col["name"] for col in inspector.get_columns("projects")}
        for orphan_column in ("estimated_budget_hours", "estimated_budget_material", "increment_id"):
            if orphan_column in project_columns:
                with engine.begin() as conn:
                    conn.execute(text(f"ALTER TABLE projects DROP COLUMN {orphan_column}"))

    if "app_settings" in table_names:
        app_settings_columns = {col["name"] for col in inspector.get_columns("app_settings")}
        if "jira_api_token_expires_at" not in app_settings_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE app_settings ADD COLUMN jira_api_token_expires_at DATE"))
        # cycle_time_base_jql copriva solo il Cycle Time; con l'introduzione
        # del Team Embedded diventa la JQL base del Team SW, condivisa da
        # tutti e tre i grafici - rinominata invece di aggiunta da zero per
        # non far riconfigurare a mano una JQL gia' impostata.
        if "cycle_time_base_jql" in app_settings_columns and "team_sw_base_jql" not in app_settings_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE app_settings RENAME COLUMN cycle_time_base_jql TO team_sw_base_jql"))
            app_settings_columns = {col["name"] for col in inspect(engine).get_columns("app_settings")}
        if "team_sw_base_jql" not in app_settings_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE app_settings ADD COLUMN team_sw_base_jql TEXT"))
        if "team_embedded_base_jql" not in app_settings_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE app_settings ADD COLUMN team_embedded_base_jql TEXT"))
        # jira_project_key serviva solo alla query "intero progetto" delle
        # Metriche, ora sostituita dalla JQL base per team (che include gia'
        # "project in (...)"): colonna orfana, rimossa.
        if "jira_project_key" in app_settings_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE app_settings DROP COLUMN jira_project_key"))

        with engine.begin() as conn:
            count = conn.execute(text("SELECT COUNT(*) FROM app_settings")).scalar()
            if not count:
                # Prima esecuzione dopo l'introduzione della sezione
                # Configurazione: semina la riga con gli eventuali valori
                # gia' in .env, cosi' chi ha gia' Jira funzionante non perde
                # la configurazione al primo avvio (vedi models.AppSettings).
                conn.execute(
                    text(
                        "INSERT INTO app_settings (id, jira_base_url, jira_email, jira_api_token, updated_at) "
                        "VALUES (1, :base_url, :email, :token, :now)"
                    ),
                    {
                        "base_url": settings.jira_base_url or None,
                        "email": settings.jira_email or None,
                        "token": settings.jira_api_token or None,
                        "now": dt.datetime.utcnow().isoformat(sep=" "),
                    },
                )


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
