"""Dati per utente: ogni increment (Project), progetto (Increment), release,
complaint, snapshot della dashboard e componente del catalogo ha un
proprietario (owner_id). Un utente vede e modifica solo i suoi; l'Admin vede
quelli di tutti, scegliendo di quale utente lavorare (header X-Scope-User,
selettore "Dati di" nella barra laterale).

- scope_user_id(): l'utente i cui dati mostrano le liste e a cui vanno le
  cose create (per tutti tranne l'Admin: se stesso).
- check_path_owner(): per ogni chiamata con un id nel percorso (es.
  /api/projects/12/backlog, /api/backlog/5) risale al proprietario; un
  utente non Admin riceve 404 sui dati altrui. Chiamato da auth.authorize,
  cosi' nessun endpoint resta scoperto.
"""

import re
from contextvars import ContextVar

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import models

SCOPE_HEADER = "X-Scope-User"

_scope_user: ContextVar[int | None] = ContextVar("scope_user", default=None)


def set_scope_user(user_id: int | None) -> None:
    _scope_user.set(user_id)


def scope_user_id() -> int | None:
    return _scope_user.get()


def resolve_scope(db: Session, user: models.User, header_value: str | None) -> int:
    if user.role == "admin" and header_value and header_value.isdigit():
        target = db.get(models.User, int(header_value))
        if target is not None:
            return target.id
    return user.id


# Percorso con id -> SQL che restituisce il proprietario. Il primo che
# corrisponde vince (i piu' specifici prima).
_P = "select owner_id from projects where id = :id"
_I = "select owner_id from increments where id = :id"
_R = "select owner_id from releases where id = :id"


def _via(table: str, fk: str, parent_sql: str) -> str:
    return parent_sql.replace(":id", f"(select {fk} from {table} where id = :id)")


_OWNER_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(p), sql)
    for p, sql in (
        (r"^/api/projects/phases/(\d+)", _via("phases", "project_id", _P)),
        (r"^/api/projects/non-working-days/(\d+)", _via("non_working_days", "project_id", _P)),
        (r"^/api/projects/(\d+)(/|$)", _P),
        (r"^/api/backlog/(\d+)", _via("backlog_items", "project_id", _P)),
        (r"^/api/forecasting/(\d+)", _via("forecast_simulations", "project_id", _P)),
        (r"^/api/snapshots/(\d+)", _via("snapshots", "project_id", _P)),
        (r"^/api/increment-components/(\d+)", _via("release_components", "release_id", _R)),
        (r"^/api/increments/sub-projects/(\d+)", _via("sub_projects", "increment_id", _I)),
        (r"^/api/increments/budget-lines/(\d+)", _via("increment_budget_lines", "increment_id", _I)),
        (r"^/api/increments/snapshots/(\d+)", _via("increment_snapshots", "increment_id", _I)),
        (
            r"^/api/increments/snapshot-values/(\d+)",
            _via("increment_snapshot_values", "snapshot_id", _via("increment_snapshots", "increment_id", _I)),
        ),
        (
            r"^/api/increments/snapshot-value-entries/(\d+)",
            _via(
                "increment_snapshot_value_entries",
                "value_id",
                _via("increment_snapshot_values", "snapshot_id", _via("increment_snapshots", "increment_id", _I)),
            ),
        ),
        (r"^/api/increments/resource-types/(\d+)", _via("increment_resource_types", "increment_id", _I)),
        (
            r"^/api/increments/members/(\d+)",
            _via("increment_team_members", "resource_type_id", _via("increment_resource_types", "increment_id", _I)),
        ),
        (
            r"^/api/increments/absences/(\d+)",
            _via(
                "increment_member_absences",
                "member_id",
                _via("increment_team_members", "resource_type_id", _via("increment_resource_types", "increment_id", _I)),
            ),
        ),
        (r"^/api/increments/hours-detail/rows/(\d+)", _via("increment_hours_detail_rows", "increment_id", _I)),
        (r"^/api/increments/material-costs/(\d+)", _via("increment_material_costs", "increment_id", _I)),
        (r"^/api/increments/budget-reviews/(\d+)", _via("increment_budget_reviews", "increment_id", _I)),
        (
            r"^/api/increments/budget-review-hours/(\d+)",
            _via("increment_budget_review_hours", "review_id", _via("increment_budget_reviews", "increment_id", _I)),
        ),
        (
            r"^/api/increments/budget-review-materials/(\d+)",
            _via("increment_budget_review_materials", "review_id", _via("increment_budget_reviews", "increment_id", _I)),
        ),
        (r"^/api/increments/(\d+)(/|$)", _I),
        (r"^/api/releases/components/(\d+)", _via("release_components", "release_id", _R)),
        (r"^/api/releases/(\d+)(/|$)", _R),
        (r"^/api/complaints/(\d+)", "select owner_id from complaints where id = :id"),
        (r"^/api/dashboard/snapshots/(\d+)", "select owner_id from dashboard_snapshots where id = :id"),
    )
]


def check_path_owner(db: Session, user: models.User, path: str) -> None:
    if user.role == "admin":
        return
    for pattern, sql in _OWNER_RULES:
        m = pattern.match(path)
        if not m:
            continue
        row = db.execute(text(sql), {"id": int(m.group(1))}).first()
        # Riga inesistente: ci pensa l'endpoint (404). Di un altro: 404 uguale.
        if row is not None and row[0] != user.id:
            raise HTTPException(status_code=404, detail="Non trovato")
        return


# --- Dati esistenti -----------------------------------------------------------

OWNED_TABLES = ("projects", "increments", "releases", "complaints", "dashboard_snapshots", "component_catalog")


def claim_orphans(db: Session, user_id: int) -> None:
    """I dati senza proprietario (quelli di prima del multi-utente) vanno a
    user_id, come le JQL che erano nella Configurazione globale."""
    for table in OWNED_TABLES:
        db.execute(text(f"UPDATE {table} SET owner_id = :u WHERE owner_id IS NULL"), {"u": user_id})
    if db.get(models.UserSettings, user_id) is None:
        legacy = db.get(models.AppSettings, 1)
        db.add(
            models.UserSettings(
                user_id=user_id,
                team_sw_base_jql=legacy.team_sw_base_jql if legacy else None,
                team_embedded_base_jql=legacy.team_embedded_base_jql if legacy else None,
                complaints_base_jql=(legacy.complaints_base_jql if legacy else None) or models.DEFAULT_COMPLAINTS_JQL,
            )
        )
    db.commit()


def claim_orphans_for_first_admin(db: Session) -> None:
    admin = db.query(models.User).filter(models.User.role == "admin").order_by(models.User.id).first()
    if admin is not None:
        claim_orphans(db, admin.id)


def user_settings(db: Session, user_id: int | None = None) -> models.UserSettings:
    """Impostazioni personali dell'utente (di default quello dello scope):
    in lettura, una riga vuota (non salvata) se l'utente non ne ha ancora."""
    uid = user_id if user_id is not None else scope_user_id()
    return db.get(models.UserSettings, uid) or models.UserSettings(user_id=uid)


def user_settings_for_update(db: Session, user_id: int | None = None) -> models.UserSettings:
    uid = user_id if user_id is not None else scope_user_id()
    row = db.get(models.UserSettings, uid)
    if row is None:
        row = models.UserSettings(user_id=uid)
        db.add(row)
    return row
