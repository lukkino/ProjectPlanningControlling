"""Aggiunge le Story di un increment al documento Design Input (TIH-DI),
foglio "Design Input - Stories", in cima a quelle gia' presenti - e, con lo
stesso meccanismo, le User Need al documento User Needs (TIH-UN), foglio
"User Needs". Quando aggiunge righe porta anche avanti la versione del
documento: nuova riga nella revision history della Cover e numero di
versione aggiornato nei titoli.

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
# Colonne che identificano il contenuto di una riga: una story nuova con
# Title e Description uguali a una gia' nel foglio e' un duplicato, anche se
# ha un ID diverso.
CONTENT_COLUMNS = "BC"
EMPTY_COMPONENTS = "N/A"

USER_NEEDS_SHEET_NAME = "User Needs"
USER_NEEDS_COLUMNS = "ABCDE"  # ID, Text, Components, Project Name, Notes
USER_NEEDS_CONTENT_COLUMNS = "B"
USER_NEEDS_MIN_ROW_HEIGHT = 34.9

COVER_SHEET_NAME = "Cover"
# Codice del documento come compare nei titoli, seguito da ".<versione>"
# (es. "TIH-UN-PTBSYS.28").
_DOC_CODE = r"[A-Z]{2,}(?:-[A-Z0-9]+)+"
MIN_REVISION_ROW_HEIGHT = 19.5

_ROW = re.compile(r'<row\b[^>]*\br="(\d+)"[^>]*?(?:/>|>.*?</row>)', re.S)
_CELL = re.compile(r'<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?(?:/>|>.*?</c>)', re.S)

# Valore di una cella nuova da copiare dalla riga esistente presa a modello
# (es. "Project Name", uguale per tutte le righe del foglio User Needs).
COPY_FROM_TEMPLATE = object()

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


class UserNeed:
    def __init__(self, key: str, text: str):
        self.key = key
        self.text = text


class ExportResult:
    """Esito di un'esportazione: `added_keys` sono gli ID delle righe
    aggiunte, `skipped` le righe con un ID gia' nel foglio, `duplicates`
    quelle lasciate fuori perche' il foglio contiene gia' lo stesso contenuto
    sotto un altro ID - coppie (ID nuovo, ID gia' presente). `removed` sono
    le righe obsolete presenti nel foglio e scritte come "Removed" nella
    nuova riga di revision history: le righe NON vengono cancellate, vanno
    tolte a mano. `still_present` sono le obsolete ancora nel foglio ma gia'
    scritte come "Removed" in una revisione precedente. `version` e' la nuova
    versione del documento, None se la Cover non e' stata aggiornata."""

    def __init__(
        self,
        content: bytes,
        added_keys: list[str],
        skipped: int,
        duplicates: list[tuple[str, str]],
        version: int | None,
        removed: list[str],
        still_present: list[str],
    ):
        self.content = content
        self.added_keys = added_keys
        self.skipped = skipped
        self.duplicates = duplicates
        self.version = version
        self.removed = removed
        self.still_present = still_present

    @property
    def added(self) -> int:
        return len(self.added_keys)


def _normalized(text: str) -> str:
    """Testo ridotto all'essenziale per riconoscere due righe uguali: senza
    differenze di maiuscole, spazi, a capo o punto finale."""
    return re.sub(r"\s+", " ", text or "").strip().rstrip(".").strip().lower()


def _sheet_path(archive: zipfile.ZipFile, sheet_name: str) -> str:
    workbook = archive.read("xl/workbook.xml").decode("utf-8")
    sheet = next(
        (m for m in re.finditer(r"<sheet\b[^>]*>", workbook) if f'name="{escape(sheet_name)}"' in m.group(0)),
        None,
    )
    if sheet is None:
        raise DesignInputError(f'Il file non contiene il foglio "{sheet_name}"')
    rel_id = re.search(r'r:id="([^"]+)"', sheet.group(0)).group(1)
    rels = archive.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    for rel in re.finditer(r"<Relationship\b[^>]*>", rels):
        if f'Id="{rel_id}"' in rel.group(0):
            target = re.search(r'Target="([^"]+)"', rel.group(0)).group(1)
            return target.lstrip("/") if target.startswith("/") else f"xl/{target}"
    raise DesignInputError(f'Foglio "{sheet_name}" non trovato nel file')


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


def _cell_number(cell_xml: str) -> int | None:
    """Valore di una cella numerica intera (es. il numero di versione nella
    revision history), None se la cella contiene altro."""
    value = re.search(r"<v>(\d+)</v>", cell_xml)
    return int(value.group(1)) if value and 't="' not in cell_xml else None


def _cells_of(row_xml: str) -> dict[str, str]:
    return {m.group(1): m.group(0) for m in _CELL.finditer(row_xml)}


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


def _sentences(*parts: str) -> str:
    return " ".join(part for part in parts if part)


def add_stories(workbook_bytes: bytes, stories: list[Story], notes: str, obsolete: set[str] = frozenset()) -> ExportResult:
    """Aggiunge al documento le story non ancora presenti. `stories`
    nell'ordine in cui devono comparire dall'alto. `obsolete` sono gli ID
    delle story obsolete: quelle presenti nel foglio vengono scritte come
    "Removed" nella revision history (vedi ExportResult.removed)."""
    entries = [
        (
            story.key,
            [story.key, story.title, story.description, story.components, story.labels, notes],
            _row_height(story, notes),
        )
        for story in stories
    ]
    return _export(
        workbook_bytes,
        SHEET_NAME,
        COLUMNS,
        CONTENT_COLUMNS,
        entries,
        obsolete,
        lambda added, removed: _sentences(
            f"Added the following new stories for {notes}: {', '.join(added)}." if added else "",
            f"Removed the following obsolete stories: {', '.join(removed)}." if removed else "",
        ),
    )


def add_user_needs(
    workbook_bytes: bytes, user_needs: list[UserNeed], notes: str, obsolete: set[str] = frozenset()
) -> ExportResult:
    """Come add_stories, per il foglio "User Needs" del documento TIH-UN:
    colonne ID, Text, Components (sempre "N/A"), Project Name (copiato dalle
    righe esistenti) e Notes."""
    entries = [
        (
            need.key,
            [need.key, need.text, EMPTY_COMPONENTS, COPY_FROM_TEMPLATE, notes],
            # Colonna Text: ~40 caratteri per riga, Montserrat 10.
            max(USER_NEEDS_MIN_ROW_HEIGHT, _wrapped_lines(need.text, 40) * 16.5 + 6.0),
        )
        for need in user_needs
    ]
    return _export(
        workbook_bytes,
        USER_NEEDS_SHEET_NAME,
        USER_NEEDS_COLUMNS,
        USER_NEEDS_CONTENT_COLUMNS,
        entries,
        obsolete,
        lambda added, removed: _sentences(
            f"Added new UN {', '.join(added)} for {notes}." if added else "",
            f"Removed obsolete UN {', '.join(removed)}." if removed else "",
        ),
    )


def read_ids(workbook_bytes: bytes, sheet_name: str) -> list[str]:
    """ID (colonna A) delle righe di un foglio ("User Needs" o "Design Input
    - Stories"), nell'ordine in cui compaiono e con le eventuali ripetizioni:
    serve a confrontare il documento con le issue presenti su Jira."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(workbook_bytes))
        xml = archive.read(_sheet_path(archive, sheet_name)).decode("utf-8")
        shared = _shared_strings(archive)
    except (zipfile.BadZipFile, KeyError, AttributeError, UnicodeDecodeError) as exc:
        raise DesignInputError("Il file selezionato non è un file Excel (.xlsx) valido") from exc

    ids = [_cell_text(_cells_of(m.group(0)).get("A", ""), shared).strip() for m in _ROW.finditer(xml)]
    if "ID" not in ids:
        raise DesignInputError(f'Nel foglio "{sheet_name}" non trovo la riga di intestazione (colonna A = "ID")')
    return [row_id for row_id in ids[ids.index("ID") + 1 :] if row_id]


def _export(
    workbook_bytes: bytes,
    sheet_name: str,
    columns: str,
    content_columns: str,
    entries: list[tuple[str, list, float]],
    obsolete: set[str],
    revision_text,
) -> ExportResult:
    """Aggiunge le righe al foglio e, se ne ha aggiunte o se il foglio
    contiene righe obsolete non ancora dichiarate, porta avanti la versione
    del documento con una nuova riga di revision history."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(workbook_bytes))
        sheet_path = _sheet_path(archive, sheet_name)
        xml = archive.read(sheet_path).decode("utf-8")
        shared = _shared_strings(archive)
    except (zipfile.BadZipFile, KeyError, AttributeError, UnicodeDecodeError) as exc:
        raise DesignInputError("Il file selezionato non è un file Excel (.xlsx) valido") from exc

    new_xml, added_keys, skipped, duplicates, existing_ids = _add_rows(
        xml, shared, sheet_name, columns, content_columns, entries
    )
    try:
        cover_path = _sheet_path(archive, COVER_SHEET_NAME)
        cover_xml = archive.read(cover_path).decode("utf-8")
    except (DesignInputError, KeyError, UnicodeDecodeError):
        cover_path = cover_xml = None

    # Righe obsolete presenti nel foglio: non vengono cancellate (vanno tolte
    # a mano), ma la nuova revisione le dichiara "Removed". Quelle gia'
    # dichiarate in una revisione precedente non vengono ripetute, cosi'
    # esportare di nuovo lo stesso file non crea un'altra revisione.
    present = [key for key in existing_ids if key in obsolete]
    announced = _removed_in_revisions(cover_xml, shared) if cover_xml else set()
    removed = [key for key in present if key not in announced]
    still_present = [key for key in present if key in announced]
    if not added_keys and not (removed and cover_xml):
        return ExportResult(workbook_bytes, [], skipped, duplicates, None, [], present)
    parts = {sheet_path: new_xml}

    # Versione e revision history: se la Cover manca o non ha una revision
    # history riconoscibile le righe vengono aggiunte lo stesso, e la
    # versione resta da aggiornare a mano (version = None).
    version = None
    try:
        revised = _add_revision(cover_xml, shared, revision_text(added_keys, removed)) if cover_xml else None
    except (KeyError, AttributeError):
        revised = None
    if revised:
        cover_xml, old_version, version = revised
        parts[cover_path] = _bump_version(cover_xml, shared, old_version, version)
        parts[sheet_path] = _bump_version(new_xml, shared, old_version, version)
    else:
        # Niente revisione scritta: le obsolete non risultano dichiarate.
        removed, still_present = [], present
        if not added_keys:
            return ExportResult(workbook_bytes, [], skipped, duplicates, None, [], present)

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as result:
        for info in archive.infolist():
            content = parts[info.filename].encode("utf-8") if info.filename in parts else archive.read(info.filename)
            result.writestr(info, content, compress_type=info.compress_type)
    return ExportResult(output.getvalue(), added_keys, skipped, duplicates, version, removed, still_present)


def _add_rows(
    xml: str,
    shared: list[str],
    sheet_name: str,
    columns: str,
    content_columns: str,
    entries: list[tuple[str, list, float]],
) -> tuple[str, list[str], int, list[tuple[str, str]], list[str]]:
    """Inserisce sotto l'intestazione del foglio una riga per ogni elemento
    di `entries` - (ID, valori delle colonne, altezza della riga) - senza
    creare duplicati rispetto a cio' che il foglio contiene gia': salta gli
    ID gia' presenti in colonna A e le righe il cui contenuto (colonne
    `content_columns`) e' gia' nel foglio sotto un altro ID. Restituisce (XML
    del foglio aggiornato, ID aggiunti, righe saltate per ID, duplicati per
    contenuto come coppie (ID nuovo, ID gia' presente), ID che il foglio
    conteneva gia', dall'alto)."""
    data = re.search(r"<sheetData>(.*)</sheetData>", xml, re.S)
    if data is None:
        raise DesignInputError(f'Il foglio "{sheet_name}" è vuoto: intestazione non trovata')
    rows = [(int(m.group(1)), m.group(0)) for m in _ROW.finditer(data.group(1))]

    # Riga di intestazione: quella con "ID" in colonna A. Le nuove righe
    # vanno subito sotto.
    header = next((r for r in rows if _cell_text(_cells_of(r[1]).get("A", ""), shared).strip() == "ID"), None)
    if header is None:
        raise DesignInputError(f'Nel foglio "{sheet_name}" non trovo la riga di intestazione (colonna A = "ID")')
    insert_row = header[0] + 1
    data_rows = [r for r in rows if r[0] >= insert_row]

    existing_ids: dict[str, None] = {}  # insieme ordinato: dall'alto
    existing_content: dict[tuple[str, ...], str] = {}
    for _number, row_xml in data_rows:
        cells = _cells_of(row_xml)
        row_id = _cell_text(cells.get("A", ""), shared).strip()
        if not row_id:
            continue  # seconda riga di una story su due righe unite
        existing_ids[row_id] = None
        content = tuple(_normalized(_cell_text(cells.get(c, ""), shared)) for c in content_columns)
        if content[0]:
            existing_content.setdefault(content, row_id)

    new_entries = []
    skipped = 0
    duplicates: list[tuple[str, str]] = []
    for entry in entries:
        key, values, _height = entry
        content = tuple(_normalized(values[columns.index(c)]) for c in content_columns)
        if key in existing_ids:
            skipped += 1
        elif content[0] and content in existing_content:
            duplicates.append((key, existing_content[content]))
        else:
            new_entries.append(entry)
            # Anche tra le righe nuove lo stesso contenuto entra una volta sola.
            if content[0]:
                existing_content[content] = key
    if not new_entries:
        return xml, [], skipped, duplicates, list(existing_ids)

    # Stile delle nuove celle: quello della prima riga esistente su una riga
    # singola (quelle su due righe unite hanno bordi diversi tra la riga
    # sopra e quella sotto).
    merged_rows = {
        row
        for m in re.finditer(r'<mergeCell\b[^>]*\bref="[A-Z]+(\d+):[A-Z]+(\d+)"', xml)
        if int(m.group(1)) >= insert_row
        for row in range(int(m.group(1)), int(m.group(2)) + 1)
    }
    template = next((r for r in data_rows if r[0] not in merged_rows), data_rows[0] if data_rows else None)
    styles: dict[str, str] = {}
    template_texts: dict[str, str] = {}
    if template:
        for column, cell_xml in _cells_of(template[1]).items():
            template_texts[column] = _cell_text(cell_xml, shared)
            style = re.search(r'\bs="(\d+)"', cell_xml)
            if style:
                styles[column] = style.group(1)

    new_rows_xml = []
    new_merges = []
    row = insert_row
    for _key, raw_values, height in new_entries:
        values = [
            template_texts.get(column, "") if value is COPY_FROM_TEMPLATE else value
            for column, value in zip(columns, raw_values)
        ]
        span = math.ceil(height / MAX_ROW_HEIGHT)
        for i in range(span):
            cells = "".join(
                _cell(column, row + i, styles.get(column, ""), value if i == 0 else None)
                for column, value in zip(columns, values)
            )
            new_rows_xml.append(
                f'<row r="{row + i}" spans="1:{len(columns)}" ht="{round(height / span, 2)}" customHeight="1">{cells}</row>'
            )
        if span > 1:
            new_merges += [f'<mergeCell ref="{c}{row}:{c}{row + span - 1}"/>' for c in columns]
        row += span

    return (
        _insert_rows(xml, insert_row, new_rows_xml, new_merges),
        [e[0] for e in new_entries],
        skipped,
        duplicates,
        list(existing_ids),
    )


def _insert_rows(xml: str, insert_row: int, new_rows_xml: list[str], new_merges: list[str]) -> str:
    """Inserisce le righe (gia' numerate da `insert_row` in poi) nel foglio:
    quelle esistenti da li' in giu' scendono, insieme a tutti i riferimenti
    che le riguardano."""
    offset = len(new_rows_xml)
    data = re.search(r"<sheetData>(.*)</sheetData>", xml, re.S)
    data_xml = data.group(1)
    first_below = next((m for m in _ROW.finditer(data_xml) if int(m.group(1)) >= insert_row), None)
    split = first_below.start() if first_below else len(data_xml)
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

    # L'area usata del foglio scende con le righe, e si allunga se le nuove
    # sono in coda (dopo l'ultima riga esistente).
    last_new_row = insert_row + offset - 1

    def grow(m: re.Match) -> str:
        ref = _shift_ref(m.group(2), insert_row, offset)
        end = re.fullmatch(r"(.*:[A-Z]+)(\d+)", ref)
        if end and int(end.group(2)) < last_new_row:
            ref = f"{end.group(1)}{last_new_row}"
        return m.group(1) + ref + m.group(3)

    head = re.sub(r'(<dimension\b[^>]*\bref=")([^"]+)(")', grow, head)
    return head + data_xml[:split] + "".join(new_rows_xml) + shifted + tail


def _removed_in_revisions(cover_xml: str, shared: list[str]) -> set[str]:
    """ID che una riga della Cover dichiara gia' "Removed" (es. "Removed
    obsolete UN PTBSYS-1, PTBSYS-2.")."""
    removed: set[str] = set()
    for row in _ROW.finditer(cover_xml):
        for cell_xml in _cells_of(row.group(0)).values():
            for sentence in re.findall(r"(?i)removed[^.]*", _cell_text(cell_xml, shared)):
                removed.update(re.findall(r"[A-Z][A-Z0-9]+-\d+", sentence))
    return removed


def _add_revision(cover_xml: str, shared: list[str], text: str) -> tuple[str, int, int] | None:
    """Aggiunge una riga in fondo alla revision history della Cover (colonne
    Version / Author / Change Description), copiando formato e autore
    dall'ultima revisione. Restituisce (XML aggiornato, versione precedente,
    nuova versione), o None se la revision history non si riconosce."""
    data = re.search(r"<sheetData>(.*)</sheetData>", cover_xml, re.S)
    if data is None:
        return None
    rows = [(int(m.group(1)), m.group(0)) for m in _ROW.finditer(data.group(1))]
    header = next((r for r in rows if _cell_text(_cells_of(r[1]).get("B", ""), shared).strip() == "Version"), None)
    if header is None:
        return None
    revisions = [
        (number, row_xml, version)
        for number, row_xml in rows
        if number > header[0] and (version := _cell_number(_cells_of(row_xml).get("B", ""))) is not None
    ]
    if not revisions:
        return None
    last_row, last_xml, old_version = max(revisions)
    new_row, new_version = last_row + 1, old_version + 1

    # Stessa riga dell'ultima revisione (stili, celle vuote con i bordi,
    # autore), con numero di versione e descrizione nuovi.
    row_xml = re.sub(rf'\br="([A-Z]*){last_row}"', rf'r="\g<1>{new_row}"', last_xml)
    cells = _cells_of(row_xml)
    description = cells.get("E")
    if "B" not in cells or description is None:
        return None
    style = re.search(r'\bs="(\d+)"', description)
    row_xml = row_xml.replace(cells["B"], re.sub(r"<v>\d+</v>", f"<v>{new_version}</v>", cells["B"]))
    row_xml = row_xml.replace(description, _cell("E", new_row, style.group(1) if style else "", text))

    # Altezza: quante righe di testo servono nella larghezza delle colonne
    # unite della descrizione (es. E:L).
    merges = re.findall(rf'<mergeCell\b[^>]*\bref="([A-Z]+){last_row}:([A-Z]+){last_row}"', cover_xml)
    last_column = next((end for start, end in merges if start == "E"), "E")
    widths = _column_widths(cover_xml)
    width = sum(widths.get(i, 9.14) for i in range(_column_index("E"), _column_index(last_column) + 1))
    height = max(MIN_REVISION_ROW_HEIGHT, _wrapped_lines(text, max(20, int(width * 0.95))) * 15.0 + 6.0)
    opening = re.match(r"<row\b[^>]*>", row_xml).group(0)
    resized = re.sub(r'\s(?:ht|customHeight)="[^"]*"', "", opening)[:-1] + f' ht="{round(height, 2)}" customHeight="1">'
    row_xml = resized + row_xml[len(opening) :]

    new_merges = [f'<mergeCell ref="{start}{new_row}:{end}{new_row}"/>' for start, end in merges]
    return _insert_rows(cover_xml, new_row, [row_xml], new_merges), old_version, new_version


def _column_index(letters: str) -> int:
    index = 0
    for letter in letters:
        index = index * 26 + ord(letter) - ord("A") + 1
    return index


def _column_widths(sheet_xml: str) -> dict[int, float]:
    widths: dict[int, float] = {}
    for col in re.finditer(r"<col\b[^>]*>", sheet_xml):
        first, last, width = (re.search(rf'\b{name}="([^"]+)"', col.group(0)) for name in ("min", "max", "width"))
        if first and last and width:
            # Solo le prime colonne: l'ultimo <col> arriva di solito alla 16384.
            for index in range(int(first.group(1)), min(int(last.group(1)), 64) + 1):
                widths[index] = float(width.group(1))
    return widths


def _bump_version(sheet_xml: str, shared: list[str], old_version: int, new_version: int) -> str:
    """Porta da "<codice>.<old>" a "<codice>.<new>" i titoli del foglio che
    riportano la versione corrente del documento (celle e intestazione/pie'
    di pagina). I riferimenti a versioni diverse da quella corrente (es. i
    fogli storici fermi a una versione precedente) non vengono toccati."""
    pattern = re.compile(rf"({_DOC_CODE})\.{old_version}(?!\d)")
    replacement = rf"\g<1>.{new_version}"

    def fix_cell(m: re.Match) -> str:
        cell_xml = m.group(0)
        text = _cell_text(cell_xml, shared)
        if not pattern.search(text):
            return cell_xml
        ref = re.search(r'\br="([A-Z]+)(\d+)"', cell_xml)
        style = re.search(r'\bs="(\d+)"', cell_xml)
        return _cell(ref.group(1), int(ref.group(2)), style.group(1) if style else "", pattern.sub(replacement, text))

    data = re.search(r"<sheetData>(.*)</sheetData>", sheet_xml, re.S)
    if data is None:
        return sheet_xml
    tail = re.sub(
        r"<headerFooter\b.*?</headerFooter>", lambda m: pattern.sub(replacement, m.group(0)), sheet_xml[data.end(1) :], flags=re.S
    )
    return sheet_xml[: data.start(1)] + _CELL.sub(fix_cell, data.group(1)) + tail
