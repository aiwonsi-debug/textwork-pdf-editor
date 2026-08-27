import { describe, expect, it } from "vitest";
import { buildPdfEditResponse } from "./pdfResult";

describe("PDF edit result responses", () => {
  it("creates a downloadable output only when every native edit was applied", () => {
    const result = buildPdfEditResponse([
      { success: true, code: "applied", message: "Font preserved." },
    ], "/manus-storage/pdf-editor/edited.pdf");

    expect(result).toMatchObject({ success: true, outputUrl: "/manus-storage/pdf-editor/edited.pdf", originalPreserved: true });
  });

  it("keeps the original and withholds output for an unsafe edit", () => {
    const result = buildPdfEditResponse([
      { success: false, code: "missing_glyph", message: "Original embedded font has no replacement glyph." },
    ], "/manus-storage/pdf-editor/should-not-exist.pdf");

    expect(result).toMatchObject({ success: false, outputUrl: null, originalPreserved: true });
    expect(result.results[0]?.code).toBe("missing_glyph");
  });
});
