"""Tool Modulo Spedizioni: il foglio Excel del modulo di spedizione.

Il modulo e' una colonna di riquadri (blocchi) bordati, ognuno una lista di
righe con uno stile: "header" (titolo sezione, allineato a sinistra),
"bold", "normal", "link" (email, cliccabile). I blocchi li compone il
frontend (stessi blocchi dell'anteprima e della copia negli appunti); qui
diventano il file Excel, come nell'app desktop originale."""

from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, Side

LINK_COLOR = "0563C1"
STYLES = ("header", "bold", "normal", "link")


def export_excel(blocks: list[list[tuple[str, str]]]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Modulo spedizione"
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 110

    fonts = {
        "header": Font(name="Calibri", size=11, bold=True),
        "bold": Font(name="Calibri", size=11, bold=True),
        "normal": Font(name="Calibri", size=11),
        "link": Font(name="Calibri", size=11, color=LINK_COLOR, underline="single"),
    }
    thin = Side(style="thin")
    row = 2
    for block in blocks:
        last = len(block) - 1
        for i, (text, style) in enumerate(block):
            cell = ws.cell(row=row, column=2, value=text or None)
            cell.font = fonts[style]
            cell.alignment = Alignment(horizontal="left" if style == "header" else "center", vertical="center")
            cell.border = Border(
                left=thin, right=thin, top=thin if i == 0 else Side(), bottom=thin if i == last else Side()
            )
            if style == "link" and text:
                cell.hyperlink = f"mailto:{text}"
            row += 1

    ws.print_area = f"B2:B{max(row - 1, 2)}"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    out = BytesIO()
    wb.save(out)
    return out.getvalue()
