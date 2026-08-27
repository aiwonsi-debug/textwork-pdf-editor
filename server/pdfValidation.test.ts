import { describe, expect, it } from "vitest";
import { areAllEditsSafe, editRequestSchema } from "./pdfValidation";

describe("PDF safe-edit validation", () => {
  it("accepts a bounded same-document edit request", () => {
    const parsed = editRequestSchema.parse({
      sourceKey: "pdf-editor/session-123/original_a1b2c3d4.pdf",
      edits: [{ page: 2, oldText: "ผัวผัน", newText: "บัวผัน", dx: 0, dy: 0 }],
    });
    expect(parsed.edits[0]?.oldText).toBe("ผัวผัน");
  });

  it("rejects unsafe storage references and excessive movement", () => {
    expect(() => editRequestSchema.parse({
      sourceKey: "../original.pdf",
      edits: [{ page: 2, oldText: "old", newText: "new" }],
    })).toThrow();
    expect(() => editRequestSchema.parse({
      sourceKey: "pdf-editor/session-123/original_a1b2c3d4.pdf",
      edits: [{ page: 2, oldText: "old", newText: "new", dx: 201 }],
    })).toThrow();
  });

  it("requires every native result to be verified as applied", () => {
    expect(areAllEditsSafe([{ success: true, code: "applied", message: "ok" }])).toBe(true);
    expect(areAllEditsSafe([{ success: false, code: "missing_glyph", message: "unsafe" }])).toBe(false);
    expect(areAllEditsSafe([])).toBe(false);
  });
});
