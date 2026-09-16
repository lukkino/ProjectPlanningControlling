"""Genera documenti Excel formali a partire da template statici (cartella
app/templates/): Regression Analysis, Release Report e i verbali di review
Planning/Execution/Deployment/Release to Market."""

import datetime as dt
import json
import re
from copy import copy
from io import BytesIO
from pathlib import Path

import openpyxl
from openpyxl.utils.cell import get_column_letter, range_boundaries

from app import models

# Ordine dei tipi issue nel foglio dati: tutte le Story, poi tutti i Bug.
ISSUE_TYPE_ORDER = {"Story": 0, "Bug": 1}

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

# "ProTube System" e i firmatari sono valori fissi per questa linea di
# prodotto (non cambiano da progetto a progetto).
SYSTEM_NAME = "ProTube System"
PROJECT_MANAGER = "Luca Contini"
QUALITY_MANAGER = "Stefania Ingrosso"
DEV_MANAGER = "Alberto Vidili"
# Firmatari specifici della Cover Planning/Execution/Deployment/Release to
# Market Review (ruoli diversi da quelli della Regression Analysis).
PRODUCT_COMPLIANCE_ENGINEER_SENIOR = "Francesca Marchese"
PRODUCT_MANAGER_TTP = "Antimo Bianco"
HEAD_OF_SW_INTEGRATED_SYSTEM = "Elisa Simoncini"
HEAD_OF_MECHATRONICS = "n.a."

CHANGE_ORDER_RE = re.compile(r"^CO(\d{4})-(\d+)$")
# Codice del Release Report: sempre lo stesso (non dipende dal Change
# Order), e' anche il nome con cui il file va salvato.
RELEASE_REPORT_CODE = "TIH-RR-PTBSYS"
# Codice incremento (es. "PTBSYS-03-003") incorporato nel nome del progetto
# ("ProTube Increment PTBSYS-03-003"), usato nel titolo della Cover del
# Release Report (indipendente dal Change Order corrente).
INCREMENT_RE = re.compile(r"PTBSYS-\d{2}-\d{3}")

# Riga di intestazione ("Version"/"Export executor"/"Change Description") e
# prima riga dati della tabella Revision History nella Cover del Release
# Report: layout fisso del template, come le altre celle hardcoded qui sopra.
REVISION_HISTORY_HEADER_ROW = 28
REVISION_HISTORY_FIRST_ROW = 29

# Master corporate (blank) da cui si generano i verbali di review
# Planning/Execution/Deployment/Release to Market: a differenza di REA/RR
# non c'e' uno storico reale da cui dedurre il formato, e i fogli di review
# sono verbali di riunione da compilare a mano (partecipanti, minute,
# domande SI/NO che richiedono giudizio umano) quindi generiamo solo la
# Cover, lasciando le review cosi' come sono nel template.
PPR_TEMPLATE_FILENAME = "ppr_template.xlsx"

# Ogni tipo di documento include cumulativamente le review dei tipi
# precedenti, oltre a Task Guideline/Cover (sempre in testa) e Action Items
# (sempre in coda), nell'ordine originale del master.
PPR_DOCUMENT_TYPES = {
    "planning": {
        "reviews": ["Planning Review"],
        "title_word": "PLANNING REVIEW",
        "filename": "TIH-PLANNING-PTBSYS",
    },
    "execution": {
        "reviews": ["Planning Review", "Execution Review"],
        "title_word": "EXECUTION REVIEW",
        "filename": "TIH-EXECUTION-PTBSYS",
    },
    "deployment": {
        "reviews": ["Planning Review", "Execution Review", "Deployment Review"],
        "title_word": "DEPLOYMENT REVIEW",
        "filename": "TIH-DEPLOYMENT-PTBSYS",
    },
    "release-to-market": {
        "reviews": ["Planning Review", "Execution Review", "Deployment Review", "Release to Market Review"],
        "title_word": "RELEASE TO MARKET REVIEW",
        "filename": "TIH-RELEASE_TO_MARKET-PTBSYS",
    },
}
PPR_LEADING_SHEETS = ["Task Guideline", "Cover"]
PPR_TRAILING_SHEETS = ["Action Items"]
# Riga della Cover in cui scrivere la prima (e unica, per ora) voce della
# Revision History: A=Version, B:C=Author (merged), D:L=Change Description
# (merged) - stesso layout osservato nel master.
PPR_REVISION_ROW = 31

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


def build_document_id(project: models.Project, version: int) -> str:
    """"TIH-REA-PTBSYS-{anno CO}-{codice CO}.{versione}", stesso schema del
    numero di documento che compare nell'header di stampa del template
    (es. "TIH-REA-PTBSYS-2026-0129.1" per CO2026-0129). Ricade su
    project.code se il Change Order non e' nel formato "CO<anno>-<codice>"."""
    match = CHANGE_ORDER_RE.match((project.change_order_label or "").strip())
    if match:
        year, code = match.groups()
        return f"TIH-REA-PTBSYS-{year}-{code}.{version}"
    return f"TIH-REA-{project.code}.{version}"


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


def _delete_rows_preserving_merges(ws, rows_to_delete: list[int]) -> None:
    """ws.delete_rows() chiamato piu' volte per righe non contigue lascia a
    volte celle unite non aggiornate (bug osservato in openpyxl 3.1.5:
    alcuni merge non vengono spostati e finiscono per coprire celle di
    un'altra riga, rendendole di fatto non scrivibili). Per sicurezza
    smerge tutto, elimina le righe, poi ricrea le unioni nelle posizioni
    corrette (le righe eliminate stesse non vengono ovviamente ricreate)."""
    original_merges = [str(m) for m in ws.merged_cells.ranges]
    for rng in original_merges:
        ws.unmerge_cells(rng)

    for row in sorted(rows_to_delete, reverse=True):
        ws.delete_rows(row, 1)

    deleted = set(rows_to_delete)
    for rng in original_merges:
        min_col, min_row, max_col, max_row = range_boundaries(rng)
        if min_row in deleted:
            continue  # la riga (e la sua unione) e' stata eliminata
        new_min_row = min_row - sum(1 for r in deleted if r < min_row)
        new_max_row = max_row - sum(1 for r in deleted if r < max_row)
        new_rng = (
            f"{get_column_letter(min_col)}{new_min_row}:{get_column_letter(max_col)}{new_max_row}"
        )
        ws.merge_cells(new_rng)


def _find_last_revision_row(cover) -> tuple[int, int | None, str | None]:
    """Scorre la tabella Revision History della Cover del Release Report
    (colonna B=Version, E=Change Description) finche' trova righe compilate.
    Restituisce (indice ultima riga con dati o header se vuota, ultima
    versione, ultimo testo)."""
    row = REVISION_HISTORY_FIRST_ROW
    last_row = REVISION_HISTORY_HEADER_ROW
    last_version: int | None = None
    last_text: str | None = None
    while cover.cell(row=row, column=2).value not in (None, ""):
        last_row = row
        last_version = cover.cell(row=row, column=2).value
        last_text = cover.cell(row=row, column=5).value
        row += 1
    return last_row, last_version, last_text


def get_release_report_defaults(project: models.Project) -> tuple[int, str]:
    """Prossima versione proposta (ultima usata + 1) e testo di revisione
    proposto (ultimo usato, da modificare) per il form di generazione del
    Release Report. Finche' il progetto non ha mai generato un Release
    Report da questa app, ricade sull'ultima riga gia' presente nel
    template (che nel documento reale contiene lo storico di tutti gli
    incrementi passati)."""
    if project.rr_last_version is not None and project.rr_last_revision_note is not None:
        return project.rr_last_version + 1, project.rr_last_revision_note

    wb = openpyxl.load_workbook(TEMPLATES_DIR / "release_report_template.xlsx", read_only=True)
    try:
        _, last_version, last_text = _find_last_revision_row(wb["Cover"])
    finally:
        wb.close()
    return (last_version or 0) + 1, last_text or ""


def _append_revision_row(cover, version: int, author: str, text: str) -> None:
    """Aggiunge una riga alla tabella Revision History della Cover, subito
    dopo l'ultima gia' presente, copiandone stile e merge (colonne C:D ed
    E:J unite come nelle righe esistenti)."""
    last_row, _, _ = _find_last_revision_row(cover)
    new_row = last_row + 1
    _copy_row_style(cover, last_row, new_row, max_col=10)
    cover.cell(row=new_row, column=2, value=version)
    cover.cell(row=new_row, column=3, value=author)
    cover.cell(row=new_row, column=5, value=text)
    cover.merge_cells(f"C{new_row}:D{new_row}")
    cover.merge_cells(f"E{new_row}:J{new_row}")
    cover.row_dimensions[new_row].height = _estimate_row_height(text)


def get_regression_analysis_defaults(project: models.Project) -> tuple[int, str]:
    """Versione e testo di revisione proposti (modificabili) per il form di
    generazione: a differenza della RR, la REA non ha una tabella di
    revision history che cresce nel tempo (una sola riga, C24/G24), quindi
    propone sempre versione 1 e un testo composto dal Change Order
    corrente, senza bisogno di leggere uno stato precedente."""
    change_order = project.change_order_label or project.change_order_url or "N/D"
    return 1, f"Regression Analysis for Change Order {change_order} for {project.name}"


def generate_regression_analysis(project: models.Project, version: int, revision_text: str) -> tuple[bytes, str]:
    wb = openpyxl.load_workbook(TEMPLATES_DIR / "regression_analysis_template.xlsx")
    cover = wb["Cover"]

    document_id = build_document_id(project, version)

    cover["E2"] = f"REGRESSION ANALYSIS\n {SYSTEM_NAME}\n {project.code} - {project.name}"
    cover["F11"] = PROJECT_MANAGER
    cover["F13"] = QUALITY_MANAGER
    cover["F15"] = DEV_MANAGER

    cover["C24"] = version
    cover["D24"] = dt.date.today()
    cover["F24"] = PROJECT_MANAGER
    cover["G24"] = revision_text

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


def generate_release_report(project: models.Project, version: int, revision_text: str) -> tuple[bytes, str]:
    """Release Report: come la Regression Analysis ma limitata ai Bug in
    scope (non le Story) piu' una riga per ogni Task collegato via "is
    implemented by" a qualunque Story/Bug in scope (flatten di
    implemented_by_json, gia' usato dalla pagina Documents).

    version e revision_text arrivano dal form di conferma mostrato
    all'utente (proposti di default da get_release_report_defaults, ma
    modificabili): version diventa il nuovo numero di documento e
    revision_text la nuova riga della Revision History della Cover.

    Restituisce (contenuto, nome file senza estensione): per il Release
    Report il nome file e' sempre "TIH-RR-PTBSYS", senza Change Order ne'
    versione."""
    wb = openpyxl.load_workbook(TEMPLATES_DIR / "release_report_template.xlsx")
    cover = wb["Cover"]

    # A differenza della Regression Analysis, il Release Report non e' legato
    # a un Change Order: e' un documento unico del sistema, sempre salvato
    # come "TIH-RR-PTBSYS.xlsx". La versione compare solo nel numero di
    # documento (titolo e header di stampa), non nel nome del file.
    document_id = f"{RELEASE_REPORT_CODE}.{version}"
    # Codice incremento (es. "PTBSYS-03-003"), indipendente dal Change
    # Order: usato nel titolo della Cover e come "Version" dei Bug in
    # colonna G (stesso schema osservato nel template originale, dove la
    # versione dei Bug e' l'incremento corrente, non il CO).
    increment = _increment_code(project)
    cover["C3"] = f"RELEASE REPORT\n PROTUBE SYSTEM\nIncrement {increment} "
    _append_revision_row(cover, version, PROJECT_MANAGER, revision_text)

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
    return buffer.getvalue(), RELEASE_REPORT_CODE


def get_ppr_defaults(project: models.Project, doc_type: str) -> tuple[int, str]:
    """Versione e testo di revisione proposti (modificabili) per il form di
    generazione: come la REA, ogni tipo di documento PPR e' nuovo per ogni
    incremento (non uno storico cumulativo di sistema come la RR), quindi
    propone sempre versione 1 senza bisogno di un contatore persistito."""
    increment = _increment_code(project)
    return 1, f"Initial issue for increment {increment}"


def generate_ppr_document(project: models.Project, doc_type: str, version: int, revision_text: str) -> tuple[bytes, str]:
    """Planning/Execution/Deployment/Release to Market Review: dal master
    "Copy of MOD-PPR.xlsx" tiene solo i fogli richiesti per questo tipo di
    documento (cumulativi: ogni tipo include anche le review dei tipi
    precedenti) e compila la Cover (titolo, 3 firmatari fissi, prima riga
    di Revision History). I fogli di review restano com'erano nel
    template: sono verbali di riunione da compilare a mano (partecipanti,
    minute, domande SI/NO che richiedono giudizio umano), non dati
    ricavabili dal Backlog Jira come per REA/RR."""
    config = PPR_DOCUMENT_TYPES[doc_type]
    wb = openpyxl.load_workbook(TEMPLATES_DIR / PPR_TEMPLATE_FILENAME)

    keep = set(PPR_LEADING_SHEETS) | set(config["reviews"]) | set(PPR_TRAILING_SHEETS)
    for name in list(wb.sheetnames):
        if name not in keep:
            del wb[name]

    increment = _increment_code(project)
    filename_stem = config["filename"]
    document_id = f"{filename_stem}.{version}"

    cover = wb["Cover"]
    cover["D5"] = f"{config['title_word']}\n {SYSTEM_NAME} - Increment {increment}"
    cover["D12"] = PROJECT_MANAGER
    normal_font = copy(cover["B13"].font)
    cover["B13"] = "Product Compliance Engineer Senior"
    cover["D13"] = PRODUCT_COMPLIANCE_ENGINEER_SENIOR
    cover["D17"] = DEV_MANAGER

    # B15/B17 nel template hanno testo condizionale ("only for...") in un
    # colore diverso (arancione) da B13: essendo sempre applicabili a
    # questo progetto, riportiamo solo il nome del ruolo con lo stesso
    # font "normale" di B13.
    cover["B15"] = "Product Manager TTP"
    cover["B15"].font = copy(normal_font)
    cover["D15"] = PRODUCT_MANAGER_TTP
    cover["B17"] = "Product Development Manager"
    cover["B17"].font = copy(normal_font)
    cover["B19"] = "Head of SW & Integrated System"
    cover["B19"].font = copy(normal_font)
    cover["D19"] = HEAD_OF_SW_INTEGRATED_SYSTEM
    # A differenza delle altre righe firmatario, nel template D19 non e'
    # unita a F19 (probabile disallineamento del template originale): la
    # uniamo qui, il testo eredita l'allineamento gia' centrato di D19.
    cover.merge_cells("D19:F19")
    cover["B20"] = "Head of Mechatronics"
    cover["B20"].font = copy(normal_font)
    cover["D20"] = HEAD_OF_MECHATRONICS

    cover.cell(row=PPR_REVISION_ROW, column=1, value=version)
    cover.cell(row=PPR_REVISION_ROW, column=2, value=PROJECT_MANAGER)
    cover.cell(row=PPR_REVISION_ROW, column=4, value=revision_text)

    # Ruoli non applicabili a questo progetto (Production Quality Manager
    # per la Pre-Serie Launch Review, Head of Development per progetti AP,
    # Medical Affairs, Third Party): rimossi dalla Cover.
    _delete_rows_preserving_merges(cover, [22, 21, 18, 16])

    for sheet in wb.worksheets:
        sheet.oddHeader.right.text = document_id

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue(), filename_stem
