"""File di budget del progetto (templates/budget_template.xlsx, il file
di budget aziendale svuotato): Cover, Co.Ge. (dati contabili fissi, qui
solo codice, nome e date del progetto), Hours e Materials and Expenses col
budget iniziale, Budget Review con le righe extra delle review (fino a 3).

Si usa Excel via COM, come per i documenti PPR: openpyxl scarterebbe il
logo nell'intestazione delle pagine. Le righe si trovano per nome (reparto,
categoria, sezione) e non per posizione fissa."""

import datetime as dt
import shutil
import tempfile
from pathlib import Path

from app import models
from app.services import budget
from app.services.document_generator import TEMPLATES_DIR
from app.services.ppr_document import _excel

BUDGET_TEMPLATE_FILENAME = "budget_template.xlsx"
MAX_REVIEWS = 3
COMPANY_OFFSET = {"SpA": 0, "SA": 1, "TPM": 2}
CATEGORY_LABELS = {
    "Feasibility": "Feasibility Materials",
    "Prototype": "Prototype Materials",
    "Pre Serie": "Pre Serie Materials",
    "Production Testing Tool": "Production Testing Tool Materials",
    "Consultancies": "Consultancies",
    "Travel Expenses": "Travel Expenses",
}
ONLY_PM = "only pm"


class BudgetExportError(ValueError):
    """Messaggio per l'utente."""


def _text(value) -> str:
    return str(value or "").strip()


def _norm(value) -> str:
    return " ".join(_text(value).lower().split())


class _Sheet:
    """Valori di un foglio letti una volta (Range.Value), per trovare le
    righe in Python; la scrittura va cella per cella."""

    def __init__(self, ws):
        self.ws = ws
        used = ws.UsedRange
        self.first_row = used.Row
        values = used.Value or ()
        width = used.Column + used.Columns.Count - 1
        # Righe da 1, colonne da 1 (le colonne prima di UsedRange vuote).
        self.rows: dict[int, list] = {}
        for i, row in enumerate(values):
            cells = [None] * (used.Column - 1) + list(row if isinstance(row, tuple) else (row,))
            self.rows[self.first_row + i] = cells + [None] * (width - len(cells))
        self.last_row = self.first_row + len(values) - 1

    def get(self, row: int, col: int):
        cells = self.rows.get(row)
        return cells[col - 1] if cells and col - 1 < len(cells) else None

    def find(self, col: int, value: str, start: int | None = None, end: int | None = None, extra=None) -> int | None:
        target = _norm(value)
        for row in range(start or self.first_row, (end or self.last_row) + 1):
            if _norm(self.get(row, col)) == target and (extra is None or extra(row)):
                return row
        return None

    def write(self, row: int, col: int, value) -> None:
        self.ws.Cells(row, col).Value = value
        cells = self.rows.setdefault(row, [])
        while len(cells) < col:
            cells.append(None)
        cells[col - 1] = value


def _section_rows(sheet: _Sheet, header_row: int, label_col: int, stop_cols: tuple[int, ...]) -> list[int]:
    """Righe di una sezione: dopo l'intestazione, fino alla prossima riga con
    un'etichetta in una delle colonne stop_cols."""
    rows = []
    row = header_row + 1
    while row <= sheet.last_row and not any(_text(sheet.get(row, c)) for c in stop_cols):
        rows.append(row)
        row += 1
    return rows


def _free_row(sheet: _Sheet, rows: list[int], text_col: int, what: str) -> int:
    for row in rows:
        if not _text(sheet.get(row, text_col)) or _norm(sheet.get(row, text_col)) == ONLY_PM:
            return row
    raise BudgetExportError(f"Nel template non ci sono abbastanza righe libere per {what}")


def _department_block(sheet: _Sheet, code: str) -> tuple[int, int]:
    """(prima, ultima) riga del blocco di un reparto (colonna B = codice DEV)."""
    start = sheet.find(2, code)
    if start is None:
        raise BudgetExportError(f"Reparto {code} non trovato nel template")
    end = start + 1
    while end <= sheet.last_row and not _text(sheet.get(end, 2)).upper().startswith("DEV"):
        end += 1
    return start, end - 1


def _hours_section_rows(sheet: _Sheet, code: str, section: str, label_col: int, text_col: int) -> list[int]:
    start, end = _department_block(sheet, code)
    header = sheet.find(label_col, section, start, end)
    if header is None:
        raise BudgetExportError(f"Sezione {section} di {code} non trovata nel template")
    return [r for r in _section_rows(sheet, header, label_col, (label_col, 2)) if r <= end]


def _material_section_rows(sheet: _Sheet, category: str, section: str | None, label_col: int, total_col: int) -> list[int]:
    label = CATEGORY_LABELS[category]
    start = sheet.find(label_col, label, extra=lambda r: _norm(sheet.get(r, total_col)) == "total")
    if start is None:
        raise BudgetExportError(f"Categoria {label} non trovata nel template")
    # Consultancies e Travel Expenses hanno una sola sezione, subito sotto.
    header = start + 1 if section is None else sheet.find(label_col, section, start + 1)
    if header is None:
        raise BudgetExportError(f"Sezione {section} di {label} non trovata nel template")
    return _section_rows(sheet, header, label_col, (label_col,))


def _department_label(code: str | None) -> str:
    return code or "DEV110"


def _fill_hours(sheet: _Sheet, increment: models.Increment) -> None:
    """Foglio Hours: una riga per tipologia e societa' nella sezione
    Development del reparto (D attivita', E/F/G ore SpA/SA/TPM)."""
    for row in increment.hours_detail_rows:
        if not row.hours:
            continue
        code = _department_label(row.department)
        rows = _hours_section_rows(sheet, code, "Development", 3, 4)
        target = _free_row(sheet, rows, 4, f"le ore di {code}")
        sheet.write(target, 4, row.name)
        sheet.write(target, 5 + COMPANY_OFFSET.get(row.company, 0), row.hours)


def _fill_materials(sheet: _Sheet, increment: models.Increment) -> None:
    """Foglio Materials and Expenses: C descrizione, D costo unitario, E
    unita' per modulo, F moduli (Consultancies e Travel Expenses: D importo)."""
    for row in increment.material_budget_rows:
        no_sections = row.category in budget.CATEGORIES_WITHOUT_SECTIONS
        rows = _material_section_rows(sheet, row.category, None if no_sections else row.section, 2, 3)
        target = _free_row(sheet, rows, 3, f"i materiali {row.category}")
        sheet.write(target, 3, row.description)
        if no_sections:
            sheet.write(target, 4, budget.material_amount(row))
        else:
            sheet.write(target, 4, row.unit_cost)
            sheet.write(target, 5, row.units)
            sheet.write(target, 6, row.modules)


def _fill_reviews(sheet: _Sheet, reviews: list[models.IncrementBudgetReview]) -> None:
    """Foglio Budget Review: le review in ordine nelle colonne FIRST, SECOND
    e THIRD REVIEW; ogni riga extra in una riga sua, con il nome della
    review davanti alla descrizione."""
    for index, review in enumerate(reviews):
        base = 6 + 5 * index  # F, K, P
        for item in review.hours_items:
            rows = _hours_section_rows(sheet, item.department, "Development", 3, 4)
            target = _free_row(sheet, rows, 4, f"le ore extra di {item.department}")
            sheet.write(target, 4, f"{review.name}: {item.description}")
            for offset, value in enumerate((item.spa, item.sa, item.tpm)):
                if value:
                    sheet.write(target, base + offset, value)
        for item in review.material_items:
            no_sections = item.category in budget.CATEGORIES_WITHOUT_SECTIONS
            rows = _material_section_rows(sheet, item.category, None if no_sections else item.section, 3, 4)
            target = _free_row(sheet, rows, 4, f"i costi extra {item.category}")
            sheet.write(target, 4, f"{review.name}: {item.description}")
            if no_sections:
                sheet.write(target, base, budget.material_amount(item))
            else:
                sheet.write(target, base, item.unit_cost)
                sheet.write(target, base + 1, item.units)
                sheet.write(target, base + 2, item.modules)


def _excel_date(value: dt.date | None):
    """Numero di serie di Excel: un datetime passato via COM verrebbe
    convertito col fuso orario (un giorno prima). La cella e' gia'
    formattata come data nel template."""
    return (value - dt.date(1899, 12, 30)).days if value else None


def _project_title(increment: models.Increment) -> str:
    """"PTIH-PT13 - ProTube Release October 2026": codice e prima riga della
    descrizione del progetto."""
    lines = _text(increment.notes).splitlines()
    return f"{increment.code} - {lines[0].strip()}" if lines else increment.code


def generate_budget_file(increment: models.Increment) -> tuple[bytes, str]:
    if not increment.hours_detail_rows and not increment.material_budget_rows:
        raise BudgetExportError(
            "Il budget è vuoto: compila il Dettaglio budget ore (Aggiorna ore progetto) o il Dettaglio materiali"
        )
    reviews = list(increment.budget_reviews)
    if len(reviews) > MAX_REVIEWS:
        raise BudgetExportError(f"Il file di budget ha posto per {MAX_REVIEWS} review: il progetto ne ha {len(reviews)}")
    title = _project_title(increment)
    template = TEMPLATES_DIR / BUDGET_TEMPLATE_FILENAME
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "budget.xlsx"
        shutil.copyfile(template, path)
        with _excel() as excel:
            wb = excel.Workbooks.Open(str(path))
            cover = wb.Worksheets("Cover")
            cover.Range("D2").Value = f"Project Name\n{title}"
            cover.Range("A19").Value = 1
            cover.Range("B19").Value = "Luca Contini"
            cover.Range("D19").Value = f"First Budget Official for {title}"
            coge = wb.Worksheets("Co.Ge.")
            coge.Range("B11").Value = increment.code
            coge.Range("B12").Value = (
                f"ProTube Increment {increment.project.code}" if increment.project is not None else title
            )
            coge.Range("B14").Value = _excel_date(increment.start_date)
            coge.Range("B15").Value = _excel_date(increment.end_date)
            _fill_hours(_Sheet(wb.Worksheets("Hours")), increment)
            _fill_materials(_Sheet(wb.Worksheets("Materials and Expenses")), increment)
            _fill_reviews(_Sheet(wb.Worksheets("Budget Review")), reviews)
            for ws in wb.Worksheets:
                ws.PageSetup.RightHeader = title
            wb.Worksheets("Cover").Activate()
            wb.Save()
            wb.Close(SaveChanges=False)
        content = path.read_bytes()
    safe = "".join(ch for ch in title.split(" - ", 1)[-1] if ch not in '\\/:*?"<>|').strip()
    filename = f"{increment.code}_Budget {safe}.xlsx" if safe and safe != increment.code else f"{increment.code}_Budget.xlsx"
    return content, filename
