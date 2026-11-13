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

    if "phases" in table_names:
        phase_columns = {col["name"] for col in inspector.get_columns("phases")}
        if "original_date" not in phase_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE phases ADD COLUMN original_date DATE"))
                # La pianificata di oggi diventa la baseline delle fasi esistenti.
                conn.execute(text("UPDATE phases SET original_date = planned_date"))

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

    # Calcolatore ore progetto. La tabella increment_resource_types e' nuova
    # (gia' creata da create_all, che gira prima di questa funzione): i
    # progetti gia' esistenti ricevono qui, una volta sola, le stesse
    # tipologie di default di un progetto nuovo.
    if "calc_vacation_days" not in increment_columns:
        from app.models import DEFAULT_RESOURCE_TYPES  # import locale: models importa Base da qui

        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE increments ADD COLUMN calc_start_date DATE"))
            conn.execute(text("ALTER TABLE increments ADD COLUMN calc_end_date DATE"))
            conn.execute(text("ALTER TABLE increments ADD COLUMN calc_vacation_days FLOAT DEFAULT 0"))
            for (increment_id,) in conn.execute(text("SELECT id FROM increments")).fetchall():
                for order, name in enumerate(DEFAULT_RESOURCE_TYPES, start=1):
                    conn.execute(
                        text(
                            "INSERT INTO increment_resource_types "
                            '(increment_id, name, resource_count, hours_per_day, "order") '
                            "VALUES (:inc, :name, 1, 8, :order)"
                        ),
                        {"inc": increment_id, "name": name, "order": order},
                    )

    # Ruoli del Calcolatore e del Dettaglio budget ore: i vecchi nomi di
    # default (PJM, Dev, ...) diventano quelli della ripartizione
    # dell'Actual. Idempotente: dopo la prima volta non trova piu' nulla.
    from app.models import LEGACY_RESOURCE_TYPE_NAMES  # import locale: models importa Base da qui

    for table in ("increment_resource_types", "increment_hours_detail_rows"):
        if table in table_names:
            with engine.begin() as conn:
                for old, new in LEGACY_RESOURCE_TYPE_NAMES.items():
                    conn.execute(text(f"UPDATE {table} SET name = :new WHERE name = :old"), {"old": old, "new": new})

    # Parametri Monte Carlo di una simulazione del Forecasting, per poterla
    # ricalcolare quando se ne cambia la deadline.
    if "forecast_simulations" in table_names:
        forecast_columns = {col["name"] for col in inspector.get_columns("forecast_simulations")}
        if "mc_params" not in forecast_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE forecast_simulations ADD COLUMN mc_params TEXT"))

    # Tipo di assenza (Ferie/Malattia/Altro) delle persone del Capacity
    # Planner: la tabella esisteva gia' senza.
    if "increment_member_absences" in table_names:
        absence_columns = {col["name"] for col in inspector.get_columns("increment_member_absences")}
        if "kind" not in absence_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE increment_member_absences ADD COLUMN kind VARCHAR(32) DEFAULT 'Ferie'"))

    if "user_settings" in table_names:
        settings_columns = {col["name"] for col in inspector.get_columns("user_settings")}
        if "d365_requisitions_url" not in settings_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE user_settings ADD COLUMN d365_requisitions_url TEXT"))

    if "complaints" in table_names:
        complaint_columns = {col["name"] for col in inspector.get_columns("complaints")}
        if "sf_status" not in complaint_columns:
            with engine.begin() as conn:
                for column, kind in (
                    ("sf_record_id", "VARCHAR(32)"),
                    ("sf_status", "VARCHAR(64)"),
                    ("sf_account", "VARCHAR(255)"),
                    ("sf_inpeco_priority", "VARCHAR(32)"),
                    ("sf_customer_impact", "VARCHAR(16)"),
                    ("sf_safety", "VARCHAR(32)"),
                    ("sf_severity", "VARCHAR(64)"),
                    ("sf_synced_at", "DATETIME"),
                ):
                    conn.execute(text(f"ALTER TABLE complaints ADD COLUMN {column} {kind}"))
        if "architecture_manual" not in complaint_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE complaints ADD COLUMN architecture_manual BOOLEAN DEFAULT 0"))
        if "rejection_reason" not in complaint_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE complaints ADD COLUMN rejection_reason TEXT"))
        if "sf_jira_key" not in complaint_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE complaints ADD COLUMN sf_jira_key VARCHAR(64)"))
        if "jira_resolved" not in complaint_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE complaints ADD COLUMN jira_resolved DATE"))
        if "severity" not in complaint_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE complaints ADD COLUMN severity VARCHAR(64)"))
        if "fix_versions" not in complaint_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE complaints ADD COLUMN fix_versions VARCHAR(255)"))
        if "tsb_activities" not in complaint_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE complaints ADD COLUMN tsb_activities TEXT"))

    if "backlog_items" in table_names:
        backlog_columns = {col["name"] for col in inspector.get_columns("backlog_items")}
        if "progetto_id" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN progetto_id INTEGER REFERENCES increments(id)"))
        if "predecessors" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN predecessors VARCHAR(512)"))
        if "is_activity" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN is_activity BOOLEAN DEFAULT 0"))
        if "baseline_start" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN baseline_start DATE"))
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN baseline_finish DATE"))
        if "milestone_phase_id" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN milestone_phase_id INTEGER REFERENCES phases(id)"))
        if "activity_phase" not in backlog_columns:
            # Le attivita' di servizio esistenti diventano attivita' di Execution.
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN activity_phase VARCHAR(32)"))
                conn.execute(text("UPDATE backlog_items SET activity_phase = 'execution' WHERE is_activity = 1"))
        if "scenarios_link" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN scenarios_link TEXT"))
        if "impacts_on" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN impacts_on TEXT"))
        if "assignee" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN assignee VARCHAR(255)"))
        if "archived_at" not in backlog_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE backlog_items ADD COLUMN archived_at DATETIME"))

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
        if "start_phase_id" not in project_columns:
            # Fasi che danno le date dell'increment, prima riconosciute dal
            # nome: si collegano una volta quelle di oggi (prima fase, "Code
            # freeze", "Release to Market"), poi le sceglie l'utente.
            norm = "lower(replace(trim(name), '-', ' '))"
            with engine.begin() as conn:
                for column in ("start_phase_id", "code_freeze_phase_id", "finish_phase_id"):
                    conn.execute(text(f"ALTER TABLE projects ADD COLUMN {column} INTEGER"))
                conn.execute(text(
                    "UPDATE projects SET start_phase_id = (SELECT id FROM phases WHERE project_id = projects.id "
                    'ORDER BY "order", id LIMIT 1)'
                ))
                conn.execute(text(
                    "UPDATE projects SET code_freeze_phase_id = (SELECT id FROM phases WHERE project_id = projects.id "
                    f"AND {norm} = 'code freeze' ORDER BY \"order\", id LIMIT 1)"
                ))
                conn.execute(text(
                    "UPDATE projects SET finish_phase_id = (SELECT id FROM phases WHERE project_id = projects.id "
                    f"AND {norm} = 'release to market' ORDER BY \"order\", id LIMIT 1)"
                ))
        if "is_current" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN is_current BOOLEAN DEFAULT 0"))
        if "gantt_order" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN gantt_order INTEGER"))
        if "release_date" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN release_date DATE"))
        if "scenarios_folder" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN scenarios_folder TEXT"))
                conn.execute(text("ALTER TABLE projects ADD COLUMN review_documents_folder TEXT"))
        if "scope_narrative" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN scope_narrative TEXT"))
        if "co_status" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN co_status VARCHAR(64)"))
                conn.execute(text("ALTER TABLE projects ADD COLUMN co_status_checked_at DATETIME"))
        if "co_software_involved" not in project_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN co_software_involved BOOLEAN"))

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

    # Multi-utente: ogni increment/progetto/release/complaint/snapshot della
    # dashboard/componente del catalogo ha un proprietario (users.id). I dati
    # esistenti vengono assegnati al primo Admin (ownership.claim_orphans).
    for owned in ("projects", "increments", "releases", "complaints", "dashboard_snapshots", "component_catalog"):
        if owned in table_names and "owner_id" not in {c["name"] for c in inspector.get_columns(owned)}:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {owned} ADD COLUMN owner_id INTEGER REFERENCES users(id)"))
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{owned}_owner_id ON {owned} (owner_id)"))
    if "complaints" in table_names:
        # jira_key era unico: ora unico per proprietario.
        indexes = {i["name"]: i for i in inspect(engine).get_indexes("complaints")}
        if indexes.get("ix_complaints_jira_key", {}).get("unique"):
            with engine.begin() as conn:
                conn.execute(text("DROP INDEX ix_complaints_jira_key"))
                conn.execute(text("CREATE INDEX ix_complaints_jira_key ON complaints (jira_key)"))
                conn.execute(text("CREATE UNIQUE INDEX uq_complaints_owner_key ON complaints (owner_id, jira_key)"))
    if "component_catalog" in table_names:
        # UNIQUE(name) e' nella definizione della tabella: la si ricrea con
        # UNIQUE(owner_id, name).
        sql = inspect(engine).get_unique_constraints("component_catalog")
        if any(c["column_names"] == ["name"] for c in sql):
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE component_catalog RENAME TO component_catalog_old"))
                conn.execute(text(
                    "CREATE TABLE component_catalog (id INTEGER NOT NULL, owner_id INTEGER REFERENCES users(id), "
                    "name VARCHAR(255) NOT NULL, pn_family VARCHAR(64), PRIMARY KEY (id), "
                    "CONSTRAINT uq_component_catalog_owner_name UNIQUE (owner_id, name))"
                ))
                conn.execute(text(
                    "INSERT INTO component_catalog (id, owner_id, name, pn_family) "
                    "SELECT id, owner_id, name, pn_family FROM component_catalog_old"
                ))
                conn.execute(text("DROP TABLE component_catalog_old"))
                conn.execute(text("CREATE INDEX ix_component_catalog_owner_id ON component_catalog (owner_id)"))

    if "release_components" in table_names:
        component_columns = {col["name"] for col in inspector.get_columns("release_components")}
        if "abbreviation" not in component_columns:
            # Sigle note dei componenti (dalla Release Notice di PTBSYS-03-002).
            known = {
                "ProTube smart Device App": "PSDA",
                "ProTube Service": "PTBS",
                "Traceability Service": "TS",
                "Interoperability Service": "INTS",
                "DAS Connector": "DASC",
                "QMS": "QMS",
                "ProTube THUB (System Installer)": "PTHUB",
                "PAS (Keycloak)": "PAS",
                "Hub Manager": "HUBM",
                "Check-in station": "PCIS",
            }
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE release_components ADD COLUMN abbreviation VARCHAR(32)"))
                for name, abbreviation in known.items():
                    conn.execute(
                        text("UPDATE release_components SET abbreviation = :a WHERE lower(component) = lower(:n)"),
                        {"a": abbreviation, "n": name},
                    )
        if "artifactory_url" not in component_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE release_components ADD COLUMN artifactory_url TEXT"))

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

        if "complaints_base_jql" not in app_settings_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE app_settings ADD COLUMN complaints_base_jql TEXT"))

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


def run_budget_migrations() -> None:
    """Colonne del budget di progetto (reparto e societa', congelamento):
    a parte da run_lightweight_migrations, che esce prima in alcuni casi."""
    from app.services.budget import default_department  # import locale: models importa Base da qui

    inspector = inspect(engine)
    added = {
        "increments": [
            ("budget_frozen_at", "DATETIME"),
            ("budget_corrected_at", "DATETIME"),
            ("sidebar_pinned", "BOOLEAN DEFAULT 0"),
        ],
        "projects": [("sidebar_pinned", "BOOLEAN DEFAULT 0")],
        "increment_resource_types": [("department", "VARCHAR(16)"), ("company", "VARCHAR(8) DEFAULT 'SpA'")],
        "increment_team_members": [("company", "VARCHAR(8) DEFAULT 'SpA'")],
        "increment_hours_detail_rows": [("department", "VARCHAR(16)"), ("company", "VARCHAR(8) DEFAULT 'SpA'")],
    }
    for table, columns in added.items():
        existing = {col["name"] for col in inspector.get_columns(table)}
        for name, sql_type in columns:
            if name in existing:
                continue
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))
                if name == "company":
                    conn.execute(text(f"UPDATE {table} SET company = 'SpA' WHERE company IS NULL"))
                if name == "department":
                    # Reparto proposto per le tipologie di default.
                    rows = conn.execute(text(f"SELECT id, name FROM {table}")).fetchall()
                    for row_id, row_name in rows:
                        code = default_department(row_name or "")
                        if code:
                            conn.execute(text(f"UPDATE {table} SET department = :code WHERE id = :id"), {"code": code, "id": row_id})


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
