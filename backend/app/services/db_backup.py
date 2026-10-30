"""Copie di sicurezza del database SQLite, fatte prima delle operazioni che
possono togliere dati (sync da Jira). Stanno in una sottocartella accanto al
database: per tornare a una copia basta fermare il backend e rimetterla al
posto di app.db."""

import contextlib
import datetime as dt
import re
import sqlite3
from pathlib import Path

from app.database import engine

BACKUP_FOLDER_NAME = "backups"
KEEP_BACKUPS = 20


class DatabaseBackupError(Exception):
    pass


def backup_database(reason: str) -> Path | None:
    """Copia il database in backups/app_<data-ora>_<motivo>.db e tiene solo le
    ultime KEEP_BACKUPS. Usa l'API di backup di SQLite, sicura anche con il
    backend in funzione. Ritorna None se il database non e' un file SQLite
    (nessuna copia da fare)."""
    if engine.url.get_backend_name() != "sqlite" or engine.url.database in (None, "", ":memory:"):
        return None

    source_path = Path(engine.url.database)
    folder = source_path.parent / BACKUP_FOLDER_NAME
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = re.sub(r"[^A-Za-z0-9-]+", "-", reason).strip("-")
    target = folder / f"app_{stamp}_{slug}.db"
    try:
        folder.mkdir(exist_ok=True)
        with contextlib.closing(sqlite3.connect(source_path)) as source, contextlib.closing(sqlite3.connect(target)) as copy:
            source.backup(copy)
        # Il nome inizia con data e ora: l'ordine alfabetico e' quello cronologico.
        for old_backup in sorted(folder.glob("app_*.db"))[:-KEEP_BACKUPS]:
            old_backup.unlink()
    except (sqlite3.Error, OSError) as exc:
        raise DatabaseBackupError(f"Copia di sicurezza del database non riuscita: {exc}") from exc
    return target
