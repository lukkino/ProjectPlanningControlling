"""Modello Excel per le righe di una RDA: lo si scarica dal tool RDA, lo si
compila (una riga per oggetto da acquistare) e lo si carica su una RDA in
bozza, che l'app completa in Dynamics (purchase_requisition_writer.py).

Progetto e motivo non sono nel foglio: si scelgono una volta sola quando si
crea la RDA in Dynamics e ogni riga li prende dall'intestazione.

I menu a tendina (categorie, unita', valute, fornitori) vengono dalle RDA
gia' lette dall'utente: sono un aiuto, non un vincolo (si puo' scrivere
anche un valore nuovo, Dynamics lo controlla)."""

import datetime as dt
import re
from io import BytesIO

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

LINES_SHEET = "Righe"
LISTS_SHEET = "Elenchi"

# (chiave, intestazione, larghezza, obbligatoria, elenco del menu a tendina)
COLUMNS = [
    ("category", "Categoria approvvigionamento", 34, True, "categories"),
    ("product", "Nome prodotto", 44, True, None),
    ("quantity", "Quantità", 11, True, None),
    ("unit", "Unità", 10, True, "units"),
    ("price", "Prezzo unitario", 15, True, None),
    ("currency", "Valuta", 9, False, "currencies"),
    ("vendor", "Fornitore", 40, False, "vendors"),
    ("requested_date", "Data richiesta", 15, False, None),
]
HEADERS = {header.lower(): key for key, header, *_ in COLUMNS}

NOTES = [
    "Una riga per ogni oggetto da acquistare; le righe vuote vengono saltate.",
    "Obbligatori: Categoria approvvigionamento, Nome prodotto, Quantità, Unità, Prezzo unitario.",
    "Valuta vuota = EUR. Fornitore: il codice (es. F03056) o la voce del menu «F03056 - Nome».",
    "Data richiesta vuota = quella dell'intestazione della RDA.",
    "Progetto, Motivo e Dettagli motivo non sono nel foglio: le righe li prendono dall'intestazione della RDA,"
    " da compilare in Dynamics quando la crei.",
    "I menu a tendina vengono dalle tue RDA già lette: puoi scrivere anche un valore nuovo, lo controlla Dynamics.",
    "Indirizzo di consegna, dimensioni finanziarie e gruppi IVA li completa Dynamics; la categoria di progetto"
    " (PRJMCO, FC-MATERIE PRIME…) l'app la ricava dalle tue righe passate con la stessa categoria.",
    "Nel tool RDA apri una RDA in bozza e usa «Carica righe da Excel»: vedrai l'anteprima prima di scrivere in Dynamics.",
]


def template(lists: dict[str, list[str]]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = LINES_SHEET
    header_fill = PatternFill("solid", fgColor="1F4E79")
    optional_fill = PatternFill("solid", fgColor="5B7FA6")
    for index, (_key, header, width, required, _list) in enumerate(COLUMNS, start=1):
        cell = sheet.cell(row=1, column=index, value=f"{header} *" if required else header)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill if required else optional_fill
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        sheet.column_dimensions[get_column_letter(index)].width = width
    sheet.row_dimensions[1].height = 32
    sheet.freeze_panes = "A2"

    last_row = 500
    keys = [c[0] for c in COLUMNS]
    for col in ("quantity", "price"):
        letter = get_column_letter(keys.index(col) + 1)
        for row in range(2, last_row + 1):
            sheet[f"{letter}{row}"].number_format = "#,##0.00"
    date_letter = get_column_letter(keys.index("requested_date") + 1)
    for row in range(2, last_row + 1):
        sheet[f"{date_letter}{row}"].number_format = "DD/MM/YYYY"

    # Elenchi per i menu a tendina, un elenco per colonna del foglio Elenchi.
    lists_sheet = workbook.create_sheet(LISTS_SHEET)
    list_names = [c[4] for c in COLUMNS if c[4]]
    for list_col, name in enumerate(list_names, start=1):
        values = lists.get(name) or []
        lists_sheet.cell(row=1, column=list_col, value=name).font = Font(bold=True)
        for row, value in enumerate(values, start=2):
            lists_sheet.cell(row=row, column=list_col, value=value)
        lists_sheet.column_dimensions[get_column_letter(list_col)].width = 40
        if not values:
            continue
        letter = get_column_letter(list_col)
        validation = DataValidation(
            type="list",
            formula1=f"={LISTS_SHEET}!${letter}$2:${letter}${len(values) + 1}",
            allow_blank=True,
            showErrorMessage=True,
            errorStyle="warning",
            errorTitle="Valore non in elenco",
            error="Il valore non è tra quelli delle tue RDA: va bene se esiste in Dynamics.",
        )
        target = get_column_letter(keys.index(next(c[0] for c in COLUMNS if c[4] == name)) + 1)
        validation.add(f"{target}2:{target}{last_row}")
        sheet.add_data_validation(validation)

    notes = workbook.create_sheet("Istruzioni")
    notes.column_dimensions["A"].width = 120
    notes["A1"] = "Righe RDA da caricare nel tool RDA dell'app"
    notes["A1"].font = Font(bold=True, size=13)
    for row, text in enumerate(NOTES, start=3):
        notes.cell(row=row, column=1, value=f"• {text}").alignment = Alignment(wrap_text=True)

    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def _number(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("€", "").replace(" ", "")
    # 1.234,56 (italiano) o 1234.56
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def _parse_date(value) -> dt.date | None:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    text = _text(value)
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


_VENDOR_RE = re.compile(r"^\s*([A-Za-z]{0,3}\d+)\b")


def parse(content: bytes) -> list[dict]:
    """Righe compilate del foglio: ognuna con "row" (riga Excel), i campi e
    "errors" (vuota se la riga si puo' scrivere)."""
    try:
        workbook = load_workbook(BytesIO(content), data_only=True, read_only=True)
    except Exception as exc:
        raise ValueError("Il file non è un Excel (.xlsx) leggibile") from exc
    sheet = workbook[LINES_SHEET] if LINES_SHEET in workbook.sheetnames else workbook.worksheets[0]
    rows = sheet.iter_rows(values_only=True)
    header = next(rows, None) or ()
    columns: dict[int, str] = {}
    for index, title in enumerate(header):
        key = HEADERS.get(_text(title).rstrip("*").strip().lower())
        if key:
            columns[index] = key
    missing = [h for k, h, _w, required, _l in COLUMNS if required and k not in columns.values()]
    if missing:
        raise ValueError(f"Nel foglio «{sheet.title}» mancano le colonne: {', '.join(missing)}. Usa il modello del tool RDA.")

    result = []
    for row_number, values in enumerate(rows, start=2):
        raw = {key: values[index] if index < len(values) else None for index, key in columns.items()}
        if all(_text(v) == "" for v in raw.values()):
            continue
        errors = []
        line = {"row": row_number}
        for key in ("category", "product", "unit"):
            line[key] = _text(raw.get(key)) or None
        currency = _text(raw.get("currency")).upper()
        line["currency"] = currency or "EUR"
        if not re.fullmatch(r"[A-Z]{3}", line["currency"]):
            errors.append(f"valuta «{currency}» non valida")
        vendor = _text(raw.get("vendor"))
        match = _VENDOR_RE.match(vendor)
        line["vendor"] = match.group(1).upper() if match else (vendor or None)
        for key, label in (("quantity", "Quantità"), ("price", "Prezzo unitario")):
            number = _number(raw.get(key))
            line[key] = number
            if _text(raw.get(key)) and number is None:
                errors.append(f"{label} non è un numero")
        date_value = raw.get("requested_date")
        parsed = _parse_date(date_value) if _text(date_value) else None
        line["requested_date"] = parsed.isoformat() if parsed else None
        if _text(date_value) and not parsed:
            errors.append("Data richiesta non valida (usa gg/mm/aaaa)")
        for key, label in (("category", "Categoria"), ("product", "Nome prodotto"), ("unit", "Unità")):
            if not line[key]:
                errors.append(f"manca {label}")
        if line["quantity"] is None and not any("Quantità" in e for e in errors):
            errors.append("manca Quantità")
        elif line["quantity"] is not None and line["quantity"] <= 0:
            errors.append("Quantità deve essere maggiore di zero")
        if line["price"] is None and not any("Prezzo" in e for e in errors):
            errors.append("manca Prezzo unitario")
        elif line["price"] is not None and line["price"] < 0:
            errors.append("Prezzo unitario negativo")
        line["errors"] = errors
        result.append(line)
    workbook.close()
    return result
