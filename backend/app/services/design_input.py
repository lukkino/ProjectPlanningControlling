"""Aggiunge le Story di un increment al documento Design Input (TIH-DI),
foglio "Design Input - Stories", in cima a quelle gia' presenti.

Il documento e' un file controllato con loghi, intestazioni/pie' di pagina,
impostazioni di stampa e proprieta' SharePoint che openpyxl perderebbe
riscrivendolo. Per questo NON viene ricaricato e risalvato: si modifica solo
l'XML di quel foglio dentro lo zip (.xlsx), lasciando ogni altra parte del
file identica byte per byte. Le nuove celle usano stringhe "inline", cosi'
non serve toccare nemmeno sharedStrings.xml.
"""

import io
import math
import re
import zipfile
from xml.sax.saxutils import escape

SHEET_NAME = "Design Input - Stories"
COLUMNS = "ABCDEF"  # ID, Title, Description, Components, Label, Notes
EMPTY_COMPONENTS = "N/A"

# Excel non accetta righe piu' alte di cosi': per i testi piu' lunghi il
# documento usa gia' due righe unite (merge) per la stessa story.
MAX_ROW_HEIGHT = 409.0
MIN_ROW_HEIGHT = 45.0

_ILLEGAL_XML_CHARS = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")
_CELL_REF = re.compile(r"([A-Z]+)(\d+)")


class DesignInputError(Exception):
    """Errore con un messaggio presentabile in UI (file non valido, foglio o
    intestazione non trovati)."""


class Story:
    def __init__(self, key: str, title: str, description: str, components: str, labels: str):
        self.key = key
        self.title = title
        self.description = description
        self.components = components
        self.labels = labels


def _sheet_path(archive: zipfile.ZipFile) -> str:
    workbook = archive.read("xl/workbook.xml").decode("utf-8")
    sheet = next(
        (m for m in re.finditer(r"<sheet\b[^>]*>", workbook) if f'name="{escape(SHEET_NAME)}"' in m.group(0)),
        None,
    )
    if sheet is None:
        raise DesignInputError(f'Il file non contiene il foglio "{SHEET_NAME}"')
    rel_id = re.search(r'r:id="([^"]+)"', sheet.group(0)).group(1)
    rels = archive.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    for rel in re.finditer(r"<Relationship\b[^>]*>", rels):
        if f'Id="{rel_id}"' in rel.group(0):
            target = re.search(r'Target="([^"]+)"', rel.group(0)).group(1)
            return target.lstrip("/") if target.startswith("/") else f"xl/{target}"
    raise DesignInputError(f'Foglio "{SHEET_NAME}" non trovato nel file')


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    xml = archive.read("xl/sharedStrings.xml").decode("utf-8")
    strings = []
    for item in re.finditer(r"<si\b[^>]*?(?:/>|>(.*?)</si>)", xml, re.S):
        body = re.sub(r"<rPh\b.*?</rPh>", "", item.group(1) or "", flags=re.S)
        strings.append("".join(re.findall(r"<t\b[^>]*>([^<]*)</t>", body)))
    return strings


def _cell_text(cell_xml: str, shared: list[str]) -> str:
    """Testo di una cella <c>...</c> (stringa condivisa o inline)."""
    if 't="s"' in cell_xml:
        value = re.search(r"<v>(\d+)</v>", cell_xml)
        return shared[int(value.group(1))] if value and int(value.group(1)) < len(shared) else ""
    return "".join(re.findall(r"<t\b[^>]*>([^<]*)</t>", cell_xml))


def _wrapped_lines(text: str, chars_per_line: int) -> int:
    return sum(max(1, math.ceil(len(line) / chars_per_line)) for line in (text or "").split("\n"))


def _row_height(story: Story, notes: str) -> float:
    """Altezza stimata perche' il testo a capo della story si veda per
    intero: (larghezza colonna in caratteri, altezza di una riga di testo)
    tarate sulle righe esistenti del documento (Montserrat 9-11)."""
    heights = [
        _wrapped_lines(story.title, 20) * 17.0,
        _wrapped_lines(story.description, 58) * 13.5,
        _wrapped_lines(story.components, 20) * 15.0,
        _wrapped_lines(story.labels, 15) * 15.0,
        _wrapped_lines(notes, 17) * 15.0,
    ]
    return max(MIN_ROW_HEIGHT, max(heights) + 14.0)


def _cell(column: str, row: int, style: str, text: str | None) -> str:
    style_attr = f' s="{style}"' if style else ""
    if not text:
        return f'<c r="{column}{row}"{style_attr}/>'
    clean = escape(_ILLEGAL_XML_CHARS.sub("", text.replace("\r\n", "\n").replace("\r", "\n")))
    return f'<c r="{column}{row}"{style_attr} t="inlineStr"><is><t xml:space="preserve">{clean}</t></is></c>'


def _shift_ref(ref: str, first_row: int, offset: int) -> str:
    """Sposta in basso di `offset` righe i riferimenti (es. "A9:A10") dalla
    riga `first_row` in giu'."""
    return _CELL_REF.sub(
        lambda m: f"{m.group(1)}{int(m.group(2)) + offset}" if int(m.group(2)) >= first_row else m.group(0), ref
    )


def add_stories(workbook_bytes: bytes, stories: list[Story], notes: str) -> tuple[bytes, int, int]:
    """Restituisce (file aggiornato, story aggiunte, story saltate perche'
    gia' presenti nel foglio). `stories` nell'ordine in cui devono comparire
    dall'alto."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(workbook_bytes))
        sheet_path = _sheet_path(archive)
        xml = archive.read(sheet_path).decode("utf-8")
        shared = _shared_strings(archive)
    except (zipfile.BadZipFile, KeyError, AttributeError, UnicodeDecodeError) as exc:
        raise DesignInputError("Il file selezionato non è un file Excel (.xlsx) valido") from exc

    data = re.search(r"<sheetData>(.*)</sheetData>", xml, re.S)
    if data is None:
        raise DesignInputError(f'Il foglio "{SHEET_NAME}" è vuoto: intestazione non trovata')
    rows = [
        (int(m.group(1)), m.group(0), m.start())
        for m in re.finditer(r'<row\b[^>]*\br="(\d+)"[^>]*?(?:/>|>.*?</row>)', data.group(1), re.S)
    ]

    def cells_of(row_xml: str) -> dict[str, str]:
        return {
            m.group(1): m.group(0)
            for m in re.finditer(r'<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?(?:/>|>.*?</c>)', row_xml, re.S)
        }

    # Riga di intestazione: quella con "ID" in colonna A. Le story vanno
    # subito sotto.
    header = next((r for r in rows if _cell_text(cells_of(r[1]).get("A", ""), shared).strip() == "ID"), None)
    if header is None:
        raise DesignInputError(f'Nel foglio "{SHEET_NAME}" non trovo la riga di intestazione (colonna A = "ID")')
    insert_row = header[0] + 1
    data_rows = [r for r in rows if r[0] >= insert_row]

    existing_ids = {_cell_text(cells_of(r[1]).get("A", ""), shared).strip() for r in data_rows}
    new_stories = [s for s in stories if s.key not in existing_ids]
    skipped = len(stories) - len(new_stories)
    if not new_stories:
        return workbook_bytes, 0, skipped

    # Stile delle nuove celle: quello della prima story esistente su una
    # riga singola (le story su due righe unite hanno bordi diversi tra la
    # riga sopra e quella sotto).
    merged_rows = {
        row
        for m in re.finditer(r'<mergeCell\b[^>]*\bref="[A-Z]+(\d+):[A-Z]+(\d+)"', xml)
        if int(m.group(1)) >= insert_row
        for row in range(int(m.group(1)), int(m.group(2)) + 1)
    }
    template = next((r for r in data_rows if r[0] not in merged_rows), data_rows[0] if data_rows else None)
    styles: dict[str, str] = {}
    if template:
        for column, cell_xml in cells_of(template[1]).items():
            style = re.search(r'\bs="(\d+)"', cell_xml)
            if style:
                styles[column] = style.group(1)

    new_rows_xml = []
    new_merges = []
    row = insert_row
    for story in new_stories:
        values = [story.key, story.title, story.description, story.components, story.labels, notes]
        height = _row_height(story, notes)
        span = math.ceil(height / MAX_ROW_HEIGHT)
        for i in range(span):
            cells = "".join(
                _cell(column, row + i, styles.get(column, ""), value if i == 0 else None)
                for column, value in zip(COLUMNS, values)
            )
            new_rows_xml.append(
                f'<row r="{row + i}" spans="1:{len(COLUMNS)}" ht="{round(height / span, 2)}" customHeight="1">{cells}</row>'
            )
        if span > 1:
            new_merges += [f'<mergeCell ref="{c}{row}:{c}{row + span - 1}"/>' for c in COLUMNS]
        row += span
    offset = row - insert_row

    # Le righe esistenti dal punto di inserimento in giu' scendono di `offset`.
    data_xml = data.group(1)
    split = data_rows[0][2] if data_rows else len(data_xml)
    shifted = re.sub(r'(<row\b[^>]*\br=")(\d+)(")', lambda m: f"{m.group(1)}{int(m.group(2)) + offset}{m.group(3)}", data_xml[split:])
    shifted = re.sub(
        r'(<c\b[^>]*\br=")([A-Z]+)(\d+)(")',
        lambda m: f"{m.group(1)}{m.group(2)}{int(m.group(3)) + offset}{m.group(4)}",
        shifted,
    )
    head = xml[: data.start(1)]
    tail = xml[data.end(1) :]

    # Dopo sheetData: celle unite, formattazione condizionale, convalide,
    # collegamenti... tutti i riferimenti dal punto di inserimento in giu'
    # scendono insieme alle righe.
    tail = re.sub(
        r'\b(ref|sqref)="([^"]+)"', lambda m: f'{m.group(1)}="{_shift_ref(m.group(2), insert_row, offset)}"', tail
    )
    if new_merges:
        merge_block = re.search(r'<mergeCells\b[^>]*>', tail)
        if merge_block:
            total = len(re.findall(r"<mergeCell\b", tail)) + len(new_merges)
            tail = tail[: merge_block.start()] + f'<mergeCells count="{total}">' + "".join(new_merges) + tail[merge_block.end() :]
        else:
            # mergeCells va subito dopo sheetData (prima di ogni altro blocco
            # che puo' seguirlo nello schema del foglio).
            tail = "</sheetData>" + f'<mergeCells count="{len(new_merges)}">{"".join(new_merges)}</mergeCells>' + tail[len("</sheetData>") :]

    head = re.sub(
        r'(<dimension\b[^>]*\bref=")([^"]+)(")',
        lambda m: m.group(1) + _shift_ref(m.group(2), insert_row, offset) + m.group(3),
        head,
    )
    new_xml = head + data_xml[:split] + "".join(new_rows_xml) + shifted + tail

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as result:
        for info in archive.infolist():
            content = new_xml.encode("utf-8") if info.filename == sheet_path else archive.read(info.filename)
            result.writestr(info, content, compress_type=info.compress_type)
    return output.getvalue(), len(new_stories), skipped
