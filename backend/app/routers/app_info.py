"""Informazioni sull'applicazione: elenco delle modifiche (changelog) letto
dalla storia git del repository, cosi' e' sempre aggiornato senza file da
mantenere a mano. La versione di un commit e' il suo tag git "vX.Y.Z[-...]"
(a ogni commit si incrementa l'ultimo numero di frontend/src/lib/version.ts
e si mette il tag corrispondente)."""

import re
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/app", tags=["app"])

REPO_ROOT = Path(__file__).resolve().parents[3]
RECORD, FIELD = "\x1e", "\x1f"
_STAT = re.compile(r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?")
# Righe di servizio del messaggio, non utili a capire cosa cambia.
_SKIP_BODY = re.compile(r"^(Co-Authored-By|Signed-off-by):", re.IGNORECASE)
_VERSION_TAG = re.compile(r"tag: v?(\d+\.\d+\.\d+[^,\s]*)")


class ChangelogEntry(BaseModel):
    hash: str
    short_hash: str
    # Versione dell'app introdotta da questo commit (dal tag git), se c'e'.
    version: str | None = None
    date: str
    author: str
    subject: str
    body: list[str]
    files_changed: int = 0
    insertions: int = 0
    deletions: int = 0


@router.get("/changelog", response_model=list[ChangelogEntry])
def changelog():
    git = shutil.which("git")
    if git is None:
        raise HTTPException(status_code=503, detail="git non trovato: impossibile leggere la storia delle modifiche")
    try:
        out = subprocess.run(
            [
                git,
                "log",
                "--no-merges",
                f"--pretty=format:{RECORD}%H{FIELD}%h{FIELD}%D{FIELD}%aI{FIELD}%an{FIELD}%s{FIELD}%b{FIELD}",
                "--shortstat",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Lettura della storia git non riuscita: {exc}") from exc

    entries = []
    for record in out.split(RECORD):
        if not record.strip():
            continue
        full, short, refs, date, author, subject, body, stat = record.split(FIELD, 7)
        version = _VERSION_TAG.search(refs)
        lines = [line.rstrip() for line in body.strip().splitlines()]
        lines = [line for line in lines if line.strip() and not _SKIP_BODY.match(line.strip())]
        match = _STAT.search(stat)
        entries.append(
            ChangelogEntry(
                hash=full.strip(),
                short_hash=short,
                version=version.group(1) if version else None,
                date=date,
                author=author,
                subject=subject,
                body=lines,
                files_changed=int(match.group(1)) if match else 0,
                insertions=int(match.group(2) or 0) if match else 0,
                deletions=int(match.group(3) or 0) if match else 0,
            )
        )
    return entries
