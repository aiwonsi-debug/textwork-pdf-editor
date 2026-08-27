import { z } from "zod";

export const editSchema = z.object({
  page: z.number().int().min(0).max(1_000),
  oldText: z.string().trim().min(1).max(200),
  newText: z.string().trim().min(1).max(200),
  bbox: z.array(z.number().finite()).length(4).optional(),
  dx: z.number().finite().min(-200).max(200).default(0),
  dy: z.number().finite().min(-200).max(200).default(0),
});

export const editRequestSchema = z.object({
  sourceKey: z.string().min(18).max(320).refine(key => key.startsWith("pdf-editor/") && !key.includes(".."), "Invalid source PDF reference."),
  fileName: z.string().min(1).max(180).optional(),
  edits: z.array(editSchema).min(1).max(12),
});

export type SafeEditInput = z.infer<typeof editSchema>;
export type SafeEditRequest = z.infer<typeof editRequestSchema>;

export type NativeEditResult = {
  success: boolean;
  code: string;
  message: string;
};

export function areAllEditsSafe(results: NativeEditResult[]) {
  return results.length > 0 && results.every(result => result.success && result.code === "applied");
}
