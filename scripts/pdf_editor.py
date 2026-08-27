from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import pymupdf as fitz
import pikepdf


HEX_RE = re.compile(rb"<([0-9A-Fa-f]+)>")
TF_RE = re.compile(rb"/([A-Za-z0-9_.-]+)\s+[-+]?\d*\.?\d+\s+Tf\b")
TM_RE = re.compile(
    rb"(?P<a>[-+]?\d*\.?\d+)\s+(?P<b>[-+]?\d*\.?\d+)\s+"
    rb"(?P<c>[-+]?\d*\.?\d+)\s+(?P<d>[-+]?\d*\.?\d+)\s+"
    rb"(?P<x>[-+]?\d*\.?\d+)\s+(?P<y>[-+]?\d*\.?\d+)\s+Tm"
)


@dataclass
class Owner:
    stream: pikepdf.Stream
    resources: pikepdf.Dictionary | None
    objgen: tuple[int, int] | None


@dataclass
class Operand:
    start: int
    end: int
    raw: bytes
    codes: list[int]
    width: int
    resource_name: str
    unicode_text: str


@dataclass
class Match:
    owner: Owner
    operand: Operand
    char_start: int
    char_end: int


@dataclass
class EditResult:
    page: int
    oldText: str
    newText: str
    success: bool
    code: str
    message: str
    fontName: str = ""
    fontPreserved: bool = False
    positionAdjusted: bool = False
    formObject: list[int] | None = None


def _parse_cmap(data: bytes) -> dict[int, str]:
    text = data.decode("latin-1", errors="replace")
    mapping: dict[int, str] = {}
    for source, target in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", text):
        try:
            mapping[int(source, 16)] = bytes.fromhex(target).decode("utf-16-be")
        except (ValueError, UnicodeDecodeError):
            continue
    for source0, source1, target0 in re.findall(
        r"<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>", text
    ):
        try:
            first, last, target = int(source0, 16), int(source1, 16), int(target0, 16)
            for offset, code in enumerate(range(first, last + 1)):
                mapping.setdefault(code, chr(target + offset))
        except (ValueError, OverflowError):
            continue
    return mapping


def _font_info(resources: pikepdf.Dictionary | None, resource_name: str) -> tuple[dict[int, str], int, str, str]:
    if resources is None:
        return {}, 1, resource_name, ""
    fonts = resources.get("/Font")
    if fonts is None:
        return {}, 1, resource_name, ""
    try:
        font = fonts.get(pikepdf.Name("/" + resource_name.lstrip("/")))
    except (TypeError, ValueError):
        font = None
    if font is None:
        return {}, 1, resource_name, ""
    subtype = str(font.get("/Subtype", ""))
    width = 2 if subtype == "/Type0" else 1
    base_font = str(font.get("/BaseFont", resource_name))
    cmap = font.get("/ToUnicode")
    if cmap is None:
        return {}, width, base_font, subtype
    try:
        return _parse_cmap(bytes(cmap.read_bytes())), width, base_font, subtype
    except pikepdf.PdfError:
        return {}, width, base_font, subtype


def _content_streams(value: pikepdf.Object | None) -> Iterable[pikepdf.Stream]:
    if value is None:
        return
    if isinstance(value, pikepdf.Array):
        for item in value:
            if isinstance(item, pikepdf.Stream):
                yield item
    elif isinstance(value, pikepdf.Stream):
        yield value


def _walk_forms(resources: pikepdf.Dictionary | None, seen: set[tuple[int, int]]) -> Iterable[Owner]:
    if resources is None:
        return
    xobjects = resources.get("/XObject")
    if xobjects is None:
        return
    for _name, form in xobjects.items():
        if str(form.get("/Subtype", "")) != "/Form":
            continue
        try:
            objgen = tuple(form.objgen)
        except Exception:
            objgen = None
        if objgen is not None and objgen in seen:
            continue
        if objgen is not None:
            seen.add(objgen)
        form_resources = form.get("/Resources") or resources
        yield Owner(form, form_resources, objgen)
        yield from _walk_forms(form_resources, seen)


def _owners_for_page(pdf: pikepdf.Pdf, page_index: int) -> list[Owner]:
    page = pdf.pages[page_index]
    resources = page.obj.get("/Resources")
    owners = [Owner(stream, resources, tuple(stream.objgen)) for stream in _content_streams(page.obj.get("/Contents"))]
    owners.extend(_walk_forms(resources, set()))
    return owners


def _operands(owner: Owner) -> list[Operand]:
    data = bytes(owner.stream.read_bytes())
    operands: list[Operand] = []
    for text_block in re.finditer(rb"BT(?P<body>.*?)ET", data, re.DOTALL):
        body = text_block.group("body")
        body_start = text_block.start("body")
        for hex_match in HEX_RE.finditer(body):
            font_matches = list(TF_RE.finditer(body[: hex_match.start()]))
            if not font_matches:
                continue
            resource_name = font_matches[-1].group(1).decode("latin-1")
            cmap, width, _font, _subtype = _font_info(owner.resources, resource_name)
            try:
                raw = bytes.fromhex(hex_match.group(1).decode("ascii"))
            except ValueError:
                continue
            if not cmap or len(raw) % width:
                continue
            codes = [int.from_bytes(raw[index : index + width], "big") for index in range(0, len(raw), width)]
            decoded = "".join(cmap.get(code, "") for code in codes)
            if decoded:
                operands.append(
                    Operand(
                        start=body_start + hex_match.start(),
                        end=body_start + hex_match.end(),
                        raw=raw,
                        codes=codes,
                        width=width,
                        resource_name=resource_name,
                        unicode_text=decoded,
                    )
                )
    return operands


def _find_matches(pdf: pikepdf.Pdf, page_index: int, old_text: str) -> list[Match]:
    matches: list[Match] = []
    for owner in _owners_for_page(pdf, page_index):
        for operand in _operands(owner):
            start = 0
            while True:
                found = operand.unicode_text.find(old_text, start)
                if found < 0:
                    break
                matches.append(Match(owner, operand, found, found + len(old_text)))
                start = found + len(old_text)
    return matches


def _format_number(value: float) -> bytes:
    return (f"{value:.6f}".rstrip("0").rstrip(".") or "0").encode("ascii")


def _adjust_tm(data: bytes, operand_start: int, dx: float, dy: float) -> tuple[bytes, bool]:
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return data, False
    begin = data.rfind(b"BT", 0, operand_start)
    end = data.find(b"ET", operand_start)
    if begin < 0 or end < 0:
        raise ValueError("no_text_block_for_position_adjustment")
    matches = list(TM_RE.finditer(data[begin:end]))
    if not matches:
        raise ValueError("no_supported_text_matrix")
    matrix = matches[-1]
    a, b, c, d = [float(matrix.group(name)) for name in ("a", "b", "c", "d")]
    if abs(b) > 1e-8 or abs(c) > 1e-8 or abs(a - 1) > 1e-8 or abs(d - 1) > 1e-8:
        raise ValueError("unsupported_text_matrix")
    x = float(matrix.group("x")) + dx
    y = float(matrix.group("y")) + dy
    replacement = b" ".join([_format_number(a), _format_number(b), _format_number(c), _format_number(d), _format_number(x), _format_number(y), b"Tm"])
    absolute_start = begin + matrix.start()
    absolute_end = begin + matrix.end()
    return data[:absolute_start] + replacement + data[absolute_end:], True


def _native_page_metadata(source: Path) -> list[dict]:
    pages: list[dict] = []
    with pikepdf.open(source) as pdf:
        for page_index in range(len(pdf.pages)):
            page = pdf.pages[page_index]
            direct_streams = list(_content_streams(page.obj.get("/Contents")))
            owners = _owners_for_page(pdf, page_index)
            font_names: set[str] = set()
            token_count = 0
            for owner in owners:
                for operand in _operands(owner):
                    _cmap, _width, font_name, _subtype = _font_info(owner.resources, operand.resource_name)
                    font_names.add(font_name)
                    token_count += 1
            pages.append({
                "nestedFormCount": max(0, len(owners) - len(direct_streams)),
                "nativeTextTokenCount": token_count,
                "fontResources": sorted(font_names),
            })
    return pages


def inspect_pdf(source: Path) -> dict:
    native_pages = _native_page_metadata(source)
    document = fitz.open(source)
    try:
        pages = []
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            hits = []
            for word_index, word in enumerate(page.get_text("words")):
                x0, y0, x1, y1, text, _block, _line, _word = word
                text = text.strip()
                if text:
                    hits.append({"id": f"{page_index}-{word_index}", "text": text, "bbox": [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)]})
            pages.append({"number": page_index, "width": round(page.rect.width, 3), "height": round(page.rect.height, 3), "rotation": page.rotation, "textHits": hits, "native": native_pages[page_index]})
        return {"pageCount": document.page_count, "pages": pages}
    finally:
        document.close()


def render_page(source: Path, page_index: int, output: Path) -> None:
    document = fitz.open(source)
    try:
        if page_index < 0 or page_index >= document.page_count:
            raise ValueError("page_out_of_range")
        pixmap = document.load_page(page_index).get_pixmap(matrix=fitz.Matrix(1.65, 1.65), alpha=False, annots=False)
        pixmap.save(output)
    finally:
        document.close()


def apply_edits(source: Path, output: Path, raw_edits: list[dict]) -> dict:
    results: list[EditResult] = []
    with pikepdf.open(source) as pdf:
        for edit in raw_edits:
            page = int(edit["page"])
            old_text = str(edit["oldText"])
            new_text = str(edit["newText"])
            dx = float(edit.get("dx", 0))
            dy = float(edit.get("dy", 0))
            if page < 0 or page >= len(pdf.pages):
                results.append(EditResult(page, old_text, new_text, False, "page_out_of_range", "The selected page does not exist."))
                continue
            matches = _find_matches(pdf, page, old_text)
            if not matches:
                results.append(EditResult(page, old_text, new_text, False, "text_not_found", "The original text could not be verified in the PDF content stream."))
                continue
            if len(matches) > 1:
                results.append(EditResult(page, old_text, new_text, False, "ambiguous_match", "This text appears in more than one native PDF text object. No edit was applied."))
                continue
            match = matches[0]
            cmap, width, font_name, subtype = _font_info(match.owner.resources, match.operand.resource_name)
            if subtype == "/Type3":
                results.append(EditResult(page, old_text, new_text, False, "unsupported_font", "Type 3 fonts are not safely editable in this version.", font_name))
                continue
            reverse_map: dict[str, int] = {}
            for code, character in cmap.items():
                reverse_map.setdefault(character, code)
            missing = [character for character in new_text if character not in reverse_map]
            if missing:
                results.append(EditResult(page, old_text, new_text, False, "missing_glyph", "The original embedded font does not contain every replacement character.", font_name))
                continue
            replacement_codes = [reverse_map[character] for character in new_text]
            original_count = match.char_end - match.char_start
            if len(replacement_codes) != original_count:
                results.append(EditResult(page, old_text, new_text, False, "unsafe_reflow", "The replacement changes text length and would require unverified reflow.", font_name))
                continue
            stream_data = bytes(match.owner.stream.read_bytes())
            start_byte = match.char_start * width
            end_byte = match.char_end * width
            encoded = b"".join(f"{code:0{width * 2}X}".encode("ascii") for code in replacement_codes)
            replacement_token = b"<" + match.operand.raw[:start_byte].hex().upper().encode("ascii") + encoded + match.operand.raw[end_byte:].hex().upper().encode("ascii") + b">"
            stream_data = stream_data[: match.operand.start] + replacement_token + stream_data[match.operand.end :]
            try:
                stream_data, moved = _adjust_tm(stream_data, match.operand.start, dx, dy)
            except ValueError as error:
                results.append(EditResult(page, old_text, new_text, False, "unsupported_position_adjustment", "The text uses a matrix that cannot be moved safely.", font_name))
                continue
            match.owner.stream.write(stream_data)
            results.append(EditResult(page, old_text, new_text, True, "applied", "Native text object updated with the original embedded font.", font_name, True, moved, list(match.owner.objgen) if match.owner.objgen else None))
        all_safe = bool(results) and all(result.success for result in results)
        if all_safe:
            output.parent.mkdir(parents=True, exist_ok=True)
            pdf.save(output)
    return {"success": bool(results) and all(result.success for result in results), "results": [asdict(result) for result in results]}


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("Usage: pdf_editor.py inspect|render|edit <input> [arguments]")
    command = sys.argv[1]
    source = Path(sys.argv[2])
    try:
        if command == "inspect":
            payload = inspect_pdf(source)
        elif command == "render":
            if len(sys.argv) != 5:
                raise ValueError("render_requires_page_and_output")
            render_page(source, int(sys.argv[3]), Path(sys.argv[4]))
            payload = {"success": True}
        elif command == "edit":
            if len(sys.argv) != 5:
                raise ValueError("edit_requires_request_and_output")
            request = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
            payload = apply_edits(source, Path(sys.argv[4]), request["edits"])
        else:
            raise ValueError("unsupported_command")
        print(json.dumps(payload, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
