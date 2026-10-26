"""Cartelle dell'increment su file system (Project.scenarios_folder,
Project.review_documents_folder): create a mano dall'utente, l'app ne
conosce solo il percorso."""

import re
from pathlib import Path

from fastapi import HTTPException


def clean_path(value: str) -> Path:
    # "Copia come percorso" di Esplora risorse lo mette tra virgolette.
    return Path(value.strip().strip('"'))


def existing_folder(value: str | None) -> Path | None:
    """La cartella, se impostata ed esistente."""
    if not value:
        return None
    folder = clean_path(value)
    return folder if folder.is_dir() else None


def require_folder(value: str | None, label: str) -> Path:
    folder = existing_folder(value)
    if folder is None:
        detail = (
            f"La cartella {label} non esiste: {value}"
            if value
            else f"Cartella {label} non impostata: impostala da Modifica increment"
        )
        raise HTTPException(status_code=400, detail=detail)
    return folder


def file_in_folder(folder: Path, filename: str) -> Path:
    """Il file `filename` direttamente dentro folder: niente percorsi, cosi'
    da qui non si scrive o legge fuori dalla cartella."""
    name = Path(filename).name
    if not name or name != filename or name in (".", ".."):
        raise HTTPException(status_code=400, detail=f"Nome file non valido: {filename}")
    return folder / name


def free_filename(folder: Path, filename: str) -> str:
    """Primo nome libero nella cartella: "X.xlsx", poi "X (2).xlsx", ..."""
    stem, suffix = Path(filename).stem, Path(filename).suffix
    stem = re.sub(r" \(\d+\)$", "", stem)
    candidate, n = filename, 1
    while (folder / candidate).exists():
        n += 1
        candidate = f"{stem} ({n}){suffix}"
    return candidate
