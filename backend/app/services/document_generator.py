"""Genera documenti Excel formali a partire da template statici (cartella
app/templates/). Per ora solo il foglio Cover della Regression Analysis; il
foglio dati verra' popolato in un passo successivo."""

import datetime as dt
import json
import re
from copy import copy
from io import BytesIO
from pathlib import Path

import openpyxl

from app import models

# Ordine dei tipi issue nel foglio dati: tutte le Story, poi tutti i Bug.
ISSUE_TYPE_ORDER = {"Story": 0, "Bug": 1}

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

# "ProTube System" e i tre firmatari sono valori fissi per questa linea di
# prodotto (non cambiano da progetto a progetto).
SYSTEM_NAME = "ProTube System"
PROJECT_MANAGER = "Luca Contini"
QUALITY_MANAGER = "Stefania Ingrosso"
DEV_MANAGER = "Alberto Vidili"

CHANGE_ORDER_RE = re.compile(r"^CO(\d{4})-(\d+)$")
# Codice incremento (es. "PTBSYS-03-003") incorporato nel nome del progetto
# ("ProTube Increment PTBSYS-03-003"), usato nel titolo della Cover del
# Release Report (indipendente dal Change Order corrente).
INCREMENT_RE = re.compile(r"PTBSYS-\d{2}-\d{3}")

# Stima dell'altezza riga in base alla lunghezza del testo in colonna D
# (larghezza ~100 unita', wrap_text attivo nel template): non e' un calcolo
# esatto (dipende da font/rendering), ma si avvicina a sufficienza per
# rendere leggibile la description senza doverla ritagliare a mano.
CHARS_PER_LINE = 95
LINE_HEIGHT_PT = 14.5
MIN_ROW_HEIGHT = 15.0
MAX_ROW_HEIGHT = 409.0  # limite massimo di Excel per l'altezza di una riga


def _estimate_row_height(text: str) -> float:
    if not text:
        return MIN_ROW_HEIGHT
    lines = sum(max(1, -(-len(segment) // CHARS_PER_LINE)) for segment in text.split("\n"))
    return max(MIN_ROW_HEIGHT, min(MAX_ROW_HEIGHT, lines * LINE_HEIGHT_PT))


def build_document_id(project: models.Project, version: int, prefix: str = "TIH-REA-PTBSYS") -> str:
    """"{prefix}-{anno CO}-{codice CO}.{versione}", stesso schema del numero
    di documento che compare nell'header di stampa del template (es.
    "TIH-REA-PTBSYS-2026-0129.1" per CO2026-0129). Ricade su project.code se
    il Change Order non e' nel formato "CO<anno>-<codice>"."""
    match = CHANGE_ORDER_RE.match((project.change_order_label or "").strip())
    if match:
        year, code = match.groups()
        return f"{prefix}-{year}-{code}.{version}"
    return f"{prefix.replace('-PTBSYS', '')}-{project.code}.{version}"


def _increment_code(project: models.Project) -> str:
    """Codice incremento (es. "PTBSYS-03-003") estratto dal nome del
    progetto, per il titolo della Cover del Release Report. Ricade sul nome
    per intero se non trovato."""
    match = INCREMENT_RE.search(project.name or "")
    return match.group(0) if match else (project.name or "")


def _copy_row_style(ws, src_row: int, dst_row: int, max_col: int) -> None:
    """Copia lo stile (font/bordi/riempimento/formato/allineamento) di una
    riga gia' formattata del template su una nuova riga aggiunta oltre il
    range originale, cosi' resta visivamente coerente col resto del foglio."""
    for col in range(1, max_col + 1):
        src = ws.cell(row=src_row, column=col)
        dst = ws.cell(row=dst_row, column=col)
        dst.font = copy(src.font)
        dst.border = copy(src.border)
        dst.fill = copy(src.fill)
        dst.number_format = src.number_format
        dst.alignment = copy(src.alignment)
    if ws.row_dimensions[src_row].height:
        ws.row_dimensions[dst_row].height = ws.row_dimensions[src_row].height


def generate_regression_analysis(project: models.Project) -> tuple[bytes, str]:
    wb = openpyxl.load_workbook(TEMPLATES_DIR / "regression_analysis_template.xlsx")
    cover = wb["Cover"]

    version = 1
    document_id = build_document_id(project, version)

    cover["E2"] = f"REGRESSION ANALYSIS\n {SYSTEM_NAME}\n {project.code} - {project.name}"
    cover["F11"] = PROJECT_MANAGER
    cover["F13"] = QUALITY_MANAGER
    cover["F15"] = DEV_MANAGER

    change_order = project.change_order_label or project.change_order_url or "N/D"
    cover["C24"] = version
    cover["D24"] = dt.date.today()
    cover["F24"] = PROJECT_MANAGER
    cover["G24"] = f"Regression Analysis for Change Order {change_order} for {project.name}"

    # Il foglio dati contiene ancora l'esempio del template (di un altro
    # progetto): lo svuotiamo prima di scrivere le righe vere.
    reg = wb["Regression Analysis"]
    original_last_row = reg.max_row
    for row in reg.iter_rows(min_row=3, max_row=original_last_row, min_col=1, max_col=12):
        for cell in row:
            cell.value = None

    # Una riga per ogni Story/Bug in scope (a prescindere dal codefreeze),
    # Story prima e poi Bug, nell'ordine di priorita' del Backlog.
    items = [i for i in project.backlog_items if i.in_scope and i.issue_type in ISSUE_TYPE_ORDER]
    items.sort(key=lambda i: (ISSUE_TYPE_ORDER[i.issue_type], i.priority_order))

    # Colonna A: esattamente il testo alternativo del Change Order (pagina
    # Documents), non l'URL di fallback usato invece nella Revision History.
    change_order_code = project.change_order_label or ""

    for offset, item in enumerate(items):
        row_idx = 3 + offset
        if row_idx > original_last_row:
            _copy_row_style(reg, 3, row_idx, max_col=12)

        # Per i Bug la colonna D e' il campo Jira "Change Description"
        # (customfield_10130), non la description standard del Bug.
        if item.issue_type == "Bug":
            # Nessun fallback su description/summary: se il campo Jira e'
            # vuoto deve restare visibile come tale ("n.a."), per capire
            # su quali Bug manca ancora la compilazione.
            change_description = item.change_description or "n.a."
        else:
            change_description = item.description or item.summary or ""

        reg.cell(row=row_idx, column=1, value=change_order_code)
        reg.cell(row=row_idx, column=2, value=item.jira_key)
        reg.cell(row=row_idx, column=3, value=item.issue_type)
        reg.cell(row=row_idx, column=4, value=change_description)
        reg.row_dimensions[row_idx].height = _estimate_row_height(change_description)

    # Righe del template rimaste vuote dopo l'ultimo item: eliminate del
    # tutto (non solo svuotate), cosi' la tabella finisce dove finiscono i
    # dati veri invece di lasciare righe fantasma.
    last_data_row = 2 + len(items)
    if last_data_row < original_last_row:
        reg.delete_rows(last_data_row + 1, original_last_row - last_data_row)

    # Header di stampa (angolo in alto a destra) su entrambi i fogli, come
    # nel template originale.
    for sheet in (cover, reg):
        sheet.oddHeader.right.text = document_id

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue(), document_id


def _fix_version_label(version: str | None, labels: str | None) -> str:
    """Colonna "Fix Version + Label" del Release Report, stesso formato
    osservato nel template originale (es. "Version: PTBSYS-03-002, Labels:
    NA7;skip")."""
    return f"Version: {version or 'n.a.'}, Labels: {labels or 'n.a.'}"


def generate_release_report(project: models.Project) -> tuple[bytes, str]:
    """Release Report: come la Regression Analysis ma limitata ai Bug in
    scope (non le Story) piu' una riga per ogni Task collegato via "is
    implemented by" a qualunque Story/Bug in scope (flatten di
    implemented_by_json, gia' usato dalla pagina Documents)."""
    wb = openpyxl.load_workbook(TEMPLATES_DIR / "release_report_template.xlsx")
    cover = wb["Cover"]

    version = 1
    document_id = build_document_id(project, version, prefix="TIH-RR-PTBSYS")
    # Codice incremento (es. "PTBSYS-03-003"), indipendente dal Change
    # Order: usato nel titolo della Cover e come "Version" dei Bug in
    # colonna G (stesso schema osservato nel template originale, dove la
    # versione dei Bug e' l'incremento corrente, non il CO).
    increment = _increment_code(project)
    cover["C3"] = f"RELEASE REPORT\n PROTUBE SYSTEM\nIncrement {increment} "

    report = wb["Release Report"]
    report["A2"] = f"Release Report - {SYSTEM_NAME} - {document_id}"

    # Il foglio dati contiene ancora l'esempio del template (di un altro
    # incremento): lo svuotiamo prima di scrivere le righe vere.
    original_last_row = report.max_row
    for row in report.iter_rows(min_row=4, max_row=original_last_row, min_col=1, max_col=9):
        for cell in row:
            cell.value = None

    # Righe Bug: solo i Bug in scope (non le Story), nell'ordine di
    # priorita' del Backlog.
    bugs = [i for i in project.backlog_items if i.in_scope and i.issue_type == "Bug"]
    bugs.sort(key=lambda i: i.priority_order)

    # Righe Task: flatten di implemented_by_json su tutte le Story/Bug in
    # scope (stesso elenco gia' mostrato nella pagina Documents), una riga
    # per ogni relazione (padre, task) con la Story/Bug padre in colonna I.
    parents = [i for i in project.backlog_items if i.in_scope and i.issue_type in ISSUE_TYPE_ORDER]
    parents.sort(key=lambda i: (ISSUE_TYPE_ORDER[i.issue_type], i.priority_order))
    task_rows: list[tuple[models.BacklogItem, dict]] = []
    for parent in parents:
        if not parent.implemented_by_json:
            continue
        for task in json.loads(parent.implemented_by_json):
            task_rows.append((parent, task))

    row_idx = 4
    for bug in bugs:
        if row_idx > original_last_row:
            _copy_row_style(report, 4, row_idx, max_col=9)
        change_description = bug.change_description or "n.a."
        report.cell(row=row_idx, column=1, value="Bug")
        report.cell(row=row_idx, column=2, value=bug.jira_key)
        report.cell(row=row_idx, column=3, value=bug.summary or "")
        report.cell(row=row_idx, column=4, value=bug.problem_cause or "n.a.")
        report.cell(row=row_idx, column=5, value=change_description)
        report.cell(row=row_idx, column=6, value=bug.components or "n.a.")
        report.cell(row=row_idx, column=7, value=_fix_version_label(increment, bug.labels))
        report.cell(row=row_idx, column=8, value="n.a.")
        report.cell(row=row_idx, column=9, value="n.a.")
        report.row_dimensions[row_idx].height = _estimate_row_height(change_description)
        row_idx += 1

    for parent, task in task_rows:
        if row_idx > original_last_row:
            _copy_row_style(report, 4, row_idx, max_col=9)
        report.cell(row=row_idx, column=1, value="Task")
        report.cell(row=row_idx, column=2, value=task.get("key"))
        report.cell(row=row_idx, column=3, value=task.get("summary") or "")
        report.cell(row=row_idx, column=4, value="n.a.")
        report.cell(row=row_idx, column=5, value="n.a.")
        report.cell(row=row_idx, column=6, value=task.get("components") or "n.a.")
        report.cell(row=row_idx, column=7, value=_fix_version_label(task.get("fix_version"), task.get("labels")))
        report.cell(row=row_idx, column=8, value="n.a.")
        report.cell(row=row_idx, column=9, value=parent.jira_key)
        row_idx += 1

    # Righe del template rimaste vuote dopo l'ultimo item: eliminate del
    # tutto (non solo svuotate), cosi' la tabella finisce dove finiscono i
    # dati veri invece di lasciare righe fantasma.
    last_data_row = row_idx - 1
    if last_data_row < original_last_row:
        report.delete_rows(last_data_row + 1, original_last_row - last_data_row)

    for sheet in (cover, report):
        sheet.oddHeader.right.text = document_id

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue(), document_id
