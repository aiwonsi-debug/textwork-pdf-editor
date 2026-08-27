import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express, { type Express } from "express";
import multer from "multer";
import { storageGetSignedUrl, storagePut } from "./storage";
import { areAllEditsSafe, editRequestSchema, type SafeEditRequest } from "./pdfValidation";
import { buildPdfEditResponse } from "./pdfResult";

const execFileAsync = promisify(execFile);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 18 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(null, file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")),
});

const PYTHON_SCRIPT = path.resolve(process.cwd(), "scripts", "pdf_editor.py");

type InspectResponse = {
  pageCount: number;
  pages: Array<{ number: number; width: number; height: number; rotation: number; textHits: Array<{ id: string; text: string; bbox: number[] }> }>;
};

type EditResponse = { success: boolean; results: Array<{ success: boolean; code: string; message: string; [key: string]: unknown }> };

function fileStem(fileName: string) {
  return fileName.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 90) || "edited-document";
}

function displayFileName(fileName: string) {
  const decoded = Buffer.from(fileName, "latin1").toString("utf8");
  return decoded.includes("�") ? fileName : decoded;
}

function sourceKeyIsValid(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("pdf-editor/") && !value.includes("..") && value.length < 320;
}

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "focused-pdf-editor-"));
}

async function downloadSource(sourceKey: string, destination: string) {
  const signedUrl = await storageGetSignedUrl(sourceKey);
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error("The original PDF could not be retrieved securely.");
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function runPython(args: string[]) {
  const { stdout } = await execFileAsync("python3", [PYTHON_SCRIPT, ...args], {
    timeout: 110_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function sendProcessError(error: unknown, response: express.Response) {
  console.error("[pdf-editor] processing error", error);
  const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: string }).stdout || "") : "";
  try {
    const payload = JSON.parse(stdout);
    return response.status(422).json({ error: payload.error || "The PDF could not be processed safely." });
  } catch {
    return response.status(422).json({ error: "The PDF could not be processed safely. It may be encrypted, malformed, or unsupported." });
  }
}

export function registerPdfRoutes(app: Express) {
  app.post("/api/pdf/inspect", upload.single("file"), async (request, response) => {
    const file = request.file;
    if (!file || !file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      return response.status(400).json({ error: "Choose a valid PDF file up to 18 MB." });
    }
    const tempDir = await temporaryDirectory();
    try {
      const sourcePath = path.join(tempDir, "source.pdf");
      await writeFile(sourcePath, file.buffer);
      const inspection = await runPython(["inspect", sourcePath]) as InspectResponse;
      const sessionId = randomUUID();
      const stored = await storagePut(`pdf-editor/${sessionId}/original.pdf`, file.buffer, "application/pdf");
      return response.json({ sourceKey: stored.key, sourceUrl: stored.url, fileName: displayFileName(file.originalname), ...inspection });
    } catch (error) {
      return sendProcessError(error, response);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  app.get("/api/pdf/render", async (request, response) => {
    const sourceKey = request.query.sourceKey;
    const page = Number(request.query.page);
    if (!sourceKeyIsValid(sourceKey) || !Number.isInteger(page) || page < 0 || page > 1_000) {
      return response.status(400).json({ error: "Invalid page preview request." });
    }
    const tempDir = await temporaryDirectory();
    try {
      const sourcePath = path.join(tempDir, "source.pdf");
      const renderPath = path.join(tempDir, "page.png");
      await downloadSource(sourceKey, sourcePath);
      await runPython(["render", sourcePath, String(page), renderPath]);
      response.setHeader("Cache-Control", "private, max-age=300");
      response.type("png").send(await readFile(renderPath));
    } catch (error) {
      sendProcessError(error, response);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  app.post("/api/pdf/edit", async (request, response) => {
    const parsed = editRequestSchema.safeParse(request.body as SafeEditRequest);
    if (!parsed.success) {
      return response.status(400).json({ error: "The requested edit is not valid.", details: parsed.error.flatten() });
    }
    const tempDir = await temporaryDirectory();
    try {
      const sourcePath = path.join(tempDir, "source.pdf");
      const requestPath = path.join(tempDir, "edits.json");
      const outputPath = path.join(tempDir, "edited.pdf");
      await downloadSource(parsed.data.sourceKey, sourcePath);
      await writeFile(requestPath, JSON.stringify({ edits: parsed.data.edits }), "utf-8");
      const processed = await runPython(["edit", sourcePath, requestPath, outputPath]) as EditResponse;
      const safeResponse = buildPdfEditResponse(processed.results || []);
      if (!safeResponse.success) {
        return response.status(422).json(safeResponse);
      }
      const output = await storagePut(`pdf-editor/${randomUUID()}/${fileStem(parsed.data.fileName || "edited-document")}-edited.pdf`, await readFile(outputPath), "application/pdf");
      return response.json({ ...buildPdfEditResponse(processed.results || [], output.url), outputKey: output.key });
    } catch (error) {
      return sendProcessError(error, response);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof multer.MulterError) {
      return response.status(400).json({ error: "The PDF is too large. The current limit is 18 MB." });
    }
    next(error);
  });
}
