"""Esportazione della sezione Releases in Excel: stesse colonne e stesse
posizioni del foglio PTBSYS-03 del file dei componenti (titolo in B1,
intestazioni in riga 3, dati dalla riga 4), cosi' le righe si possono
incollare li'. Il file dei componenti non viene toccato. I componenti
dell'ultimo rilascio completato sono in giallo, come nel foglio."""

from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from app import models

SHEET_NAME = "PTBSYS-03"
TITLE = "Contenuto componenti PTBSYS-03 (New Architecture NA7)"
HEADER_ROW = 3
LATEST_RELEASE_FILL = "FFFF00"
COLUMNS = (
    ("Project ID", 12),
    ("Increment", 23),
    ("PN", 17),
    ("Componente", 30),
    ("Note", 21),
    ("Fix version", 11),
    ("Dettaglio", 33),
    ("Note", 27),
    ("Obbiettivo", 26),
    ("Start Date", 13),
    ("Expected Release Date", 13),
    ("Actual Release Date", 12),
    ("Change Order", 15),
    ("Process", 27),
)
# Colonne dei dati della release (da 1), unite sulle righe dei suoi componenti.
RELEASE_COLUMNS = (1, 2, 9, 10, 11, 12, 13, 14)
DATE_FORMAT = "dd/mm/yyyy"


def latest_completed_release_id(releases: list[models.Release]) -> int | None:
    """L'ultimo rilascio completato: la release con l'Actual Release piu' recente."""
    completed = [release for release in releases if release.actual_release_date]
    return max(completed, key=lambda release: release.actual_release_date).id if completed else None


def export_releases(releases: list[models.Release]) -> bytes:
    workbook = Workbook()
    ws = workbook.active
    ws.title = SHEET_NAME
    ws.cell(1, 2, TITLE).font = Font(bold=True)
    side = Side(style="thin")
    border = Border(left=side, right=side, top=side, bottom=side)

    for index, (label, width) in enumerate(COLUMNS, 1):
        cell = ws.cell(HEADER_ROW, index, label)
        cell.font = Font(bold=True)
        cell.border = border
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(index)].width = width

    latest_id = latest_completed_release_id(releases)
    row = HEADER_ROW + 1
    for release in releases:
        first = row
        fill = PatternFill("solid", fgColor=LATEST_RELEASE_FILL) if release.id == latest_id else None
        for component in release.components or [None]:
            values = {
                3: component.pn,
                4: component.component,
                5: component.note,
                6: component.fix_version,
                7: component.detail,
            } if component else {}
            for column, value in values.items():
                cell = ws.cell(row, column, value)
                if fill:
                    cell.fill = fill
            for column in range(1, len(COLUMNS) + 1):
                ws.cell(row, column).border = border
                ws.cell(row, column).alignment = Alignment(vertical="center", wrap_text=True)
            row += 1

        release_values = (
            release.ptih_code,
            release.increment_code,
            release.objective,
            release.start_date,
            release.expected_release_date,
            release.actual_release_date,
            release.change_order,
            release.process,
        )
        for column, value in zip(RELEASE_COLUMNS, release_values):
            cell = ws.cell(first, column, value)
            if value is not None and column in (10, 11, 12):
                cell.number_format = DATE_FORMAT
            if row - 1 > first:
                ws.merge_cells(start_row=first, start_column=column, end_row=row - 1, end_column=column)

    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
