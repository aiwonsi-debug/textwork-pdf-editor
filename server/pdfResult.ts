import { areAllEditsSafe, type NativeEditResult } from "./pdfValidation";

export type PdfEditResponse<T extends NativeEditResult = NativeEditResult> = {
  success: boolean;
  results: T[];
  outputUrl: string | null;
  originalPreserved: true;
};

export function buildPdfEditResponse<T extends NativeEditResult>(results: T[], outputUrl: string | null = null): PdfEditResponse<T> {
  const safe = areAllEditsSafe(results);
  return {
    success: safe,
    results,
    outputUrl: safe ? outputUrl : null,
    originalPreserved: true,
  };
}
