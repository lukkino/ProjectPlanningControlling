"""Storico Cycle Time da un file pre-elaborato (CSV), in alternativa
all'estrazione da Jira (lenta: un changelog per issue).

Il file ha una riga per issue con le date in cui e' entrata negli stati del
flusso, es.:

    ID,link,Title,Backlog,Developing,Done,Issue Type,...,Issue labels,...

Inizio = colonna "Developing" (in lavorazione), fine = colonna "Done": il
cycle time e' la differenza in giorni, come nell'estrazione Jira
(actual_finish - actual_start). Si tengono tutte le issue chiuse (fino a
oggi) con entrambe le date: la finestra storica la sceglie Monte Carlo. I
Bug con "CVE" nel titolo sono i Bug di security scan (esclusi dai
percentili, vedi metrics).
"""

import csv
import datetime as dt
import io

from app import schemas
from app.services.metrics import cycle_time_metrics_from_points

# Colonne cercate (senza distinzione di maiuscole/spazi): la prima trovata.
KEY_COLUMNS = ["id", "key", "issue key"]
START_COLUMNS = ["developing", "in progress", "start", "started"]
FINISH_COLUMNS = ["done", "finish", "finished", "resolved"]
TYPE_COLUMNS = ["issue type", "type", "issuetype"]
TITLE_COLUMNS = ["title", "summary"]
DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y", "%d.%m.%Y"]


class CycleTimeFileError(Exception):
    pass


def _column(header: list[str], names: list[str]) -> str | None:
    by_norm = {" ".join(h.strip().lower().split()): h for h in header}
    return next((by_norm[n] for n in names if n in by_norm), None)


def _date(value: str | None) -> dt.date | None:
    text = (value or "").strip()[:10]
    if not text:
        return None
    for fmt in DATE_FORMATS:
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise CycleTimeFileError(f"data non riconosciuta: «{value}» (formato atteso AAAA-MM-GG)")


def parse_cycle_time_file(content: str, today: dt.date | None = None) -> schemas.CycleTimeMetrics:
    today = today or dt.date.today()
    text = content.lstrip("﻿")
    if not text.strip():
        raise CycleTimeFileError("Il file è vuoto.")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    header = reader.fieldnames or []
    key_col = _column(header, KEY_COLUMNS)
    start_col = _column(header, START_COLUMNS)
    finish_col = _column(header, FINISH_COLUMNS)
    type_col = _column(header, TYPE_COLUMNS)
    title_col = _column(header, TITLE_COLUMNS)
    missing = [
        label
        for label, col in (("ID", key_col), ("Developing", start_col), ("Done", finish_col), ("Issue Type", type_col))
        if col is None
    ]
    if missing:
        raise CycleTimeFileError(
            f"Colonne mancanti nel file: {', '.join(missing)}. Servono almeno ID, Developing, Done e Issue Type."
        )

    points: list[schemas.CycleTimePoint] = []
    for line, row in enumerate(reader, start=2):
        try:
            start, finish = _date(row.get(start_col)), _date(row.get(finish_col))
        except CycleTimeFileError as exc:
            raise CycleTimeFileError(f"Riga {line}: {exc}") from exc
        if start is None or finish is None or finish < start or finish > today:
            continue
        issue_type = (row.get(type_col) or "").strip()
        title = (row.get(title_col) or "") if title_col else ""
        points.append(
            schemas.CycleTimePoint(
                key=(row.get(key_col) or "").strip(),
                issue_type=issue_type,
                finish_date=finish,
                cycle_time_days=(finish - start).days,
                is_cve=issue_type == "Bug" and "CVE" in title.upper(),
            )
        )
    if not points:
        raise CycleTimeFileError(
            "Nel file non c'è nessuna issue chiusa con le date Developing e Done."
        )
    metrics = cycle_time_metrics_from_points(points)
    metrics.data_from = min(p.finish_date for p in points)
    return metrics
