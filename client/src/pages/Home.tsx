import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Move,
  Plus,
  RotateCcw,
  ScanText,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type TextHit = {
  id: string;
  text: string;
  bbox: [number, number, number, number];
};

type Page = {
  number: number;
  width: number;
  height: number;
  rotation: number;
  textHits: TextHit[];
  native: { nestedFormCount: number; nativeTextTokenCount: number; fontResources: string[] };
};

type PdfDocument = {
  sourceKey: string;
  sourceUrl: string;
  fileName: string;
  pageCount: number;
  pages: Page[];
};

type PendingEdit = {
  id: string;
  page: number;
  oldText: string;
  newText: string;
  bbox: [number, number, number, number];
  dx: number;
  dy: number;
};

type Result = {
  page: number;
  oldText: string;
  newText: string;
  success: boolean;
  code: string;
  message: string;
  fontName?: string;
  fontPreserved?: boolean;
  positionAdjusted?: boolean;
};

type EditResponse = {
  success: boolean;
  results: Result[];
  outputUrl?: string;
  outputKey?: string;
  error?: string;
};

const MAX_FILE_SIZE = 18 * 1024 * 1024;

function formatBytes(size: number) {
  return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function codePointLength(value: string) {
  return Array.from(value.trim()).length;
}

function StatusDot({ tone = "mint" }: { tone?: "mint" | "amber" | "slate" }) {
  return <span className={cn("status-dot", `status-dot--${tone}`)} aria-hidden="true" />;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [selectedHit, setSelectedHit] = useState<TextHit | null>(null);
  const [replacement, setReplacement] = useState("");
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([]);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [previewToken, setPreviewToken] = useState(0);
  const [previewSourceKey, setPreviewSourceKey] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const page = pdf?.pages[selectedPage];
  const previewUrl = pdf ? `/api/pdf/render?sourceKey=${encodeURIComponent(previewSourceKey ?? pdf.sourceKey)}&page=${selectedPage}&v=${previewToken}` : "";
  const selectedKey = selectedHit ? `${selectedPage}:${selectedHit.id}` : "";
  const currentPending = pendingEdits.find(edit => edit.id === selectedKey);
  const isSameLength = selectedHit ? codePointLength(selectedHit.text) === codePointLength(replacement) : false;
  const activeResult = selectedHit ? results.find(result => result.page === selectedPage && result.oldText === selectedHit.text && result.newText === replacement) : undefined;

  const currentPageEdits = useMemo(
    () => pendingEdits.filter(edit => edit.page === selectedPage),
    [pendingEdits, selectedPage],
  );

  function clearSelection() {
    setSelectedHit(null);
    setReplacement("");
    setDx(0);
    setDy(0);
  }

  function navigateToPage(nextPage: number) {
    setSelectedPage(nextPage);
    clearSelection();
    setOutputUrl(null);
    setPreviewSourceKey(pdf?.sourceKey ?? null);
    setResults([]);
  }

  function invalidateGeneratedOutput() {
    setOutputUrl(null);
    setPreviewSourceKey(pdf?.sourceKey ?? null);
    setResults([]);
  }

  function handleReplacementChange(value: string) {
    setReplacement(value);
    invalidateGeneratedOutput();
  }

  function handlePositionChange(axis: "x" | "y", value: string) {
    const nextValue = Number(value) || 0;
    if (axis === "x") setDx(nextValue);
    else setDy(nextValue);
    invalidateGeneratedOutput();
  }

  async function readJsonResponse<T>(response: Response): Promise<T> {
    const body = await response.text();
    if (!body) throw new Error(response.ok ? "The PDF service returned an empty response." : "The PDF service is unavailable. Please try again.");
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(response.ok ? "The PDF service returned an unexpected response." : "The PDF service is unavailable. Please try again.");
    }
  }

  async function inspectFile(file: File) {
    setDragActive(false);
    if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
      toast.error("Choose a PDF file.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error("Choose a PDF smaller than 18 MB for this first version.");
      return;
    }
    setUploading(true);
    setPdf(null);
    setPendingEdits([]);
    clearSelection();
    setResults([]);
    setOutputUrl(null);
    setPreviewSourceKey(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/pdf/inspect", { method: "POST", body });
      const payload = await readJsonResponse<PdfDocument & { error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || "The PDF could not be inspected.");
      setPdf(payload);
      setPreviewSourceKey(payload.sourceKey);
      setSelectedPage(0);
      toast.success("PDF ready. Select a highlighted text item to begin.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The PDF could not be inspected.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function chooseHit(hit: TextHit) {
    const existing = pendingEdits.find(edit => edit.id === `${selectedPage}:${hit.id}`);
    setSelectedHit(hit);
    setReplacement(existing?.newText ?? hit.text);
    setDx(existing?.dx ?? 0);
    setDy(existing?.dy ?? 0);
    invalidateGeneratedOutput();
  }

  function queueEdit() {
    if (!selectedHit || !replacement.trim()) return;
    if (replacement.trim() === selectedHit.text) {
      toast.message("Change the replacement text before adding an edit.");
      return;
    }
    if (!isSameLength) {
      toast.error("This first version permits only same-length replacements. It will not guess at reflow.");
      return;
    }
    const edit: PendingEdit = {
      id: selectedKey,
      page: selectedPage,
      oldText: selectedHit.text,
      newText: replacement.trim(),
      bbox: selectedHit.bbox,
      dx,
      dy,
    };
    setPendingEdits(edits => [...edits.filter(item => item.id !== edit.id), edit]);
    invalidateGeneratedOutput();
    toast.success("Edit queued for native-font verification at save time.");
  }

  function removeEdit(id: string) {
    setPendingEdits(edits => edits.filter(edit => edit.id !== id));
    if (id === selectedKey) {
      setReplacement(selectedHit?.text ?? "");
      setDx(0);
      setDy(0);
    }
    invalidateGeneratedOutput();
  }

  async function generatePdf() {
    if (!pdf || pendingEdits.length === 0) {
      toast.message("Queue at least one text replacement first.");
      return;
    }
    setProcessing(true);
    setOutputUrl(null);
    setResults([]);
    try {
      const response = await fetch("/api/pdf/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: pdf.sourceKey, fileName: pdf.fileName, edits: pendingEdits }),
      });
      const payload = await readJsonResponse<EditResponse>(response);
      setResults(payload.results || []);
      if (!response.ok || !payload.success || !payload.outputUrl) {
        setPreviewSourceKey(pdf.sourceKey);
        toast.error(payload.error || "No new PDF was generated. Review the exact safety result below.");
        return;
      }
      setOutputUrl(payload.outputUrl);
      setPreviewSourceKey(payload.outputKey || pdf.sourceKey);
      setPreviewToken(token => token + 1);
      toast.success("All edits were verified. Your new PDF is ready for download.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The PDF could not be edited safely.");
    } finally {
      setProcessing(false);
    }
  }

  function changeFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void inspectFile(file);
  }

  function dropFile(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void inspectFile(file);
  }

  function moveSelection(horizontal: number, vertical: number) {
    setDx(value => Number((value + horizontal).toFixed(1)));
    setDy(value => Number((value + vertical).toFixed(1)));
    invalidateGeneratedOutput();
  }

  return (
    <div className="tool-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <div className="brand-name">Textwork</div>
            <div className="brand-caption">PDF text fidelity studio</div>
          </div>
        </div>
        <div className="header-assurance">
          <div className="assurance-chip"><LockKeyhole size={13} /> Original stays untouched</div>
          <Button className="open-file-button" onClick={() => inputRef.current?.click()} disabled={uploading || processing}>
            {uploading || processing ? <LoaderCircle className="animate-spin" /> : <Upload />}
            {processing ? "Working…" : pdf ? "Replace PDF" : "Open PDF"}
          </Button>
          <input ref={inputRef} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={changeFile} />
          <span className="sr-only" aria-live="polite">{uploading ? "Inspecting PDF" : processing ? "Verifying edits" : outputUrl ? "Edited PDF ready for download" : ""}</span>
        </div>
      </header>

      {!pdf ? (
        <main className="welcome-stage">
          <section className="welcome-copy">
            <div className="eyebrow"><StatusDot /> Native editing, not a visual overlay</div>
            <h1>Correct the words.<br /><em>Keep the document.</em></h1>
            <p>Textwork edits verified PDF text objects directly. It protects font fidelity and reports every unsafe case instead of making a visual approximation.</p>
            <div className="principle-row">
              <div><ShieldCheck /><span><b>Verified only</b> Embedded glyphs and text objects are checked before export.</span></div>
              <div><ScanText /><span><b>Selectable text</b> Click detected words in a rendered page workspace.</span></div>
            </div>
          </section>
          <button className={cn("drop-panel", dragActive && "drop-panel--active")} onClick={() => inputRef.current?.click()} onDragOver={event => { event.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={dropFile} disabled={uploading || processing}>
            <div className="drop-icon">{uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}</div>
            <strong>{uploading ? "Inspecting your document…" : dragActive ? "Release to inspect PDF" : "Open a PDF to begin"}</strong>
            <span>Drop a file here, or browse your computer</span>
            <small>PDF only · up to 18 MB · original never overwritten</small>
          </button>
          <section className="safety-pledge">
            <div className="pledge-number">01</div>
            <div><h2>Fidelity is a gate, not a promise.</h2><p>We require an unambiguous text match, a supported text matrix, and every replacement glyph in the original embedded font. If any check fails, no edit is applied.</p></div>
          </section>
        </main>
      ) : (
        <main className="workspace">
          <aside className="page-rail" aria-label="Document pages">
            <div className="rail-heading"><span>Pages</span><b>{pdf.pageCount}</b></div>
            <div className="page-list">
              {pdf.pages.map(item => (
                <button key={item.number} className={cn("page-tab", item.number === selectedPage && "page-tab--active")} onClick={() => navigateToPage(item.number)} disabled={processing} aria-current={item.number === selectedPage ? "page" : undefined}>
                  <span className="page-mini"><FileText size={16} /><i>{item.number + 1}</i></span>
                  <span>Page {item.number + 1}</span>
                  {pendingEdits.some(edit => edit.page === item.number) && <em>{pendingEdits.filter(edit => edit.page === item.number).length}</em>}
                </button>
              ))}
            </div>
            <div className="rail-footer"><StatusDot tone="slate" /> {pendingEdits.length} pending {pendingEdits.length === 1 ? "edit" : "edits"}</div>
          </aside>

          <section className="canvas-region">
            <div className="document-bar">
              <div className="document-title"><FileText /><div><b>{pdf.fileName}</b><span>{pdf.pageCount} pages · secure session</span></div></div>
              <div className="page-switcher"><Button variant="ghost" size="icon" aria-label="Previous page" disabled={processing || selectedPage === 0} onClick={() => navigateToPage(selectedPage - 1)}><ChevronLeft /></Button><span>{selectedPage + 1} / {pdf.pageCount}</span><Button variant="ghost" size="icon" aria-label="Next page" disabled={processing || selectedPage === pdf.pageCount - 1} onClick={() => navigateToPage(selectedPage + 1)}><ChevronRight /></Button></div>
            </div>
            <div className="viewer-scroll">
              <div className="viewer-hint"><ScanText size={15} /> {page?.textHits.length ? "Click a subtle text boundary to select an original word" : "No selectable text detected on this page"} <span>·</span> {page?.native.nestedFormCount ? `${page.native.nestedFormCount} nested form objects inspected` : "direct text stream"}</div>
              <div className="paper-frame">
                {page && <div className="page-stage" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
                  <img src={previewUrl} alt={`PDF page ${selectedPage + 1}`} />
                  <div className="text-hit-layer" aria-label="Detected PDF text">
                    {page.textHits.map(hit => {
                      const [x0, y0, x1, y1] = hit.bbox;
                      const isSelected = selectedHit?.id === hit.id;
                      const isEdited = currentPageEdits.some(edit => edit.id === `${selectedPage}:${hit.id}`);
                      return <button key={hit.id} className={cn("text-hit", isSelected && "text-hit--selected", isEdited && "text-hit--edited")} style={{ left: `${(x0 / page.width) * 100}%`, top: `${(y0 / page.height) * 100}%`, width: `${((x1 - x0) / page.width) * 100}%`, height: `${((y1 - y0) / page.height) * 100}%` }} onClick={() => chooseHit(hit)} aria-label={`Select text: ${hit.text}`} aria-pressed={isSelected} disabled={processing}><span>{hit.text}</span></button>;
                    })}
                  </div>
                  {page.textHits.length === 0 && <div className="no-text-state" role="status"><ScanText size={20} /><strong>No selectable text on this page</strong><span>It may be scanned, outlined, or encoded in an unsupported way.</span></div>}
                </div>}
              </div>
            </div>
          </section>

          <aside className="inspector" aria-label="Text edit inspector">
            <div className="inspector-heading"><div><span className="eyebrow"><StatusDot tone={selectedHit ? "mint" : "slate"} /> {selectedHit ? "Selection ready" : "No selection"}</span><h2>Edit inspector</h2></div><ShieldCheck /></div>
            {!selectedHit ? (
              <div className="empty-inspector"><div className="selection-glyph"><ScanText /></div><h3>Select detected text</h3><p>Click a word on the page to inspect its original PDF text object and prepare a safe replacement.</p><div className="empty-rule"><span>Safe only</span><span>Clear results</span></div></div>
            ) : (
              <div className="inspector-body">
                <div className="field-label">Original text <span>native</span></div>
                <div className="source-text">{selectedHit.text}</div>
                <label className="field-label" htmlFor="replacement">Replacement text <span>{codePointLength(replacement)}/{codePointLength(selectedHit.text)} chars</span></label>
                <Input id="replacement" value={replacement} onChange={event => handleReplacementChange(event.target.value)} className="replacement-input" autoComplete="off" disabled={processing} />
                <div className={cn("safety-readout", isSameLength ? "safety-readout--ready" : "safety-readout--blocked")}>
                  {isSameLength ? <Check size={16} /> : <AlertTriangle size={16} />}
                  <span>{isSameLength ? "Same-length candidate. Font and object safety will be verified at save time." : "Length changes need reflow. This version will not apply them."}</span>
                </div>
                <div className="position-block">
                  <div className="field-label"><Move size={14} /> Position adjustment <span>PDF points</span></div>
                  <div className="nudge-grid"><Button variant="outline" size="icon" aria-label="Move text up" onClick={() => moveSelection(0, 2)} disabled={processing}>↑</Button><Button variant="outline" size="icon" aria-label="Move text left" onClick={() => moveSelection(-2, 0)} disabled={processing}>←</Button><Button variant="outline" size="icon" aria-label="Move text right" onClick={() => moveSelection(2, 0)} disabled={processing}>→</Button><Button variant="outline" size="icon" aria-label="Move text down" onClick={() => moveSelection(0, -2)} disabled={processing}>↓</Button></div>
                  <div className="coordinate-row"><label>X <Input type="number" step="0.5" value={dx} onChange={event => handlePositionChange("x", event.target.value)} disabled={processing} /></label><label>Y <Input type="number" step="0.5" value={dy} onChange={event => handlePositionChange("y", event.target.value)} disabled={processing} /></label><Button variant="ghost" size="icon" aria-label="Reset position" onClick={() => { setDx(0); setDy(0); invalidateGeneratedOutput(); }} disabled={processing}><RotateCcw size={16} /></Button></div>
                </div>
                <Button className="queue-button" onClick={queueEdit} disabled={processing || !isSameLength || replacement.trim() === selectedHit.text}><Plus /> {currentPending ? "Update safe edit" : "Queue safe edit"}</Button>
                {currentPending && <button className="remove-current" onClick={() => removeEdit(currentPending.id)} disabled={processing}><X size={14} /> Remove this edit</button>}
                {activeResult && <div className={cn("result-callout", activeResult.success ? "result-callout--success" : "result-callout--warning")}><div>{activeResult.success ? <Check size={16} /> : <AlertTriangle size={16} />}</div><p><b>{activeResult.success ? "Verified" : "Not applied"}</b>{activeResult.message}</p></div>}
              </div>
            )}
            {results.length > 0 && <div className="verification-report"><div className="report-heading"><span className="eyebrow"><StatusDot tone={outputUrl ? "mint" : "amber"} /> Verification report</span><b>{outputUrl ? "Output ready" : "Output withheld"}</b></div>{results.map((result, index) => <div className={cn("report-row", result.success ? "report-row--safe" : "report-row--blocked")} key={`${result.page}-${result.oldText}-${index}`}><div>{result.success ? <Check size={15} /> : <AlertTriangle size={15} />}</div><p><span>Page {result.page + 1} · <code>{result.code}</code></span><b>{result.oldText} → {result.newText}</b><small>{result.message}</small></p></div>)}</div>}
            <div className="inspector-footnote"><LockKeyhole size={14} /> Your original file is immutable. A separate PDF is created only after every queued change passes verification.</div>
          </aside>

          <section className="save-tray">
            <div className="tray-summary"><div className="tray-count">{pendingEdits.length}</div><div><b>{pendingEdits.length === 1 ? "One native edit is ready" : `${pendingEdits.length} native edits are ready`}</b><span>All edits must pass before a new file is generated.</span></div></div>
            <div className="tray-actions">{results.length > 0 && !outputUrl && <span className="blocked-note"><AlertTriangle /> Review unsupported edits</span>}{outputUrl ? <Button asChild className="download-button"><a href={outputUrl} download><ArrowDownToLine /> Download edited PDF</a></Button> : <Button className="generate-button" onClick={generatePdf} disabled={processing || pendingEdits.length === 0}>{processing ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{processing ? "Verifying edits…" : "Verify & generate PDF"}</Button>}</div>
          </section>
        </main>
      )}
    </div>
  );
}
