import crypto from "crypto";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export const MAX_DOCUMENT_FILE_SIZE = 10 * 1024 * 1024; // 10 MB limit
export const MAX_EXTRACTED_TEXT_LENGTH = 1_000_000; // 1M characters safety bound

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export const FORBIDDEN_EXTENSIONS = [
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".sh",
  ".ps1",
  ".msi",
  ".js",
  ".ts",
  ".py",
  ".vbs",
  ".bin",
  ".elf",
  ".so",
];

export interface ExtractedDocumentResult {
  text: string;
  contentHash: string;
  charCount: number;
}

/**
 * Normalizes extracted text:
 * - standardizes line breaks to \n
 * - collapses redundant spaces and horizontal tabs
 * - collapses excessive blank lines (>2 down to 2)
 * - strips null bytes and unprintable control characters
 * - trims leading/trailing whitespace
 */
export function normalizeText(text: string): string {
  if (!text) return "";

  return text
    .replace(/\0/g, "") // remove null bytes
    .replace(/\r\n|\r/g, "\n") // normalize line breaks
    .replace(/[\t ]+/g, " ") // collapse multiple horizontal spaces
    .replace(/ +\n/g, "\n") // strip trailing spaces on lines
    .replace(/\n +/g, "\n") // strip leading spaces on lines
    .replace(/\n{3,}/g, "\n\n") // collapse excessive blank lines
    .trim();
}

/**
 * Computes deterministic SHA-256 hash of normalized text
 */
export function computeContentHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Validates document metadata before attempting extraction
 */
export function validateDocumentFile(
  filename: string,
  bufferSize: number,
  mimeType?: string
): void {
  if (bufferSize > MAX_DOCUMENT_FILE_SIZE) {
    throw new Error(
      `File size exceeds maximum limit of 10 MB (received ${(bufferSize / (1024 * 1024)).toFixed(2)} MB)`
    );
  }

  const lowerName = filename.toLowerCase();
  for (const forbidden of FORBIDDEN_EXTENSIONS) {
    if (lowerName.endsWith(forbidden)) {
      throw new Error(`Forbidden executable/script file type: ${forbidden}`);
    }
  }

  const hasSupportedExt = SUPPORTED_EXTENSIONS.some((ext) =>
    lowerName.endsWith(ext)
  );

  if (!hasSupportedExt) {
    throw new Error(
      `Unsupported file format: ${filename}. Supported formats are PDF, DOCX, TXT, MD.`
    );
  }
}

/**
 * Extracts normalized plain text from a supported document buffer
 */
export async function extractTextFromDocument(
  buffer: Buffer,
  filename: string,
  mimeType?: string
): Promise<ExtractedDocumentResult> {
  validateDocumentFile(filename, buffer.length, mimeType);

  const lowerName = filename.toLowerCase();
  let rawText = "";

  try {
    if (lowerName.endsWith(".pdf") || mimeType === "application/pdf") {
      try {
        const parser = new PDFParse({ data: buffer });
        const res = await parser.getText();
        rawText = res?.text || "";
        try {
          await parser.destroy();
        } catch {
          // ignore cleanup error
        }
      } catch (err: unknown) {
        throw new Error(
          `Failed to parse PDF document: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else if (
      lowerName.endsWith(".docx") ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      try {
        const { value } = await mammoth.extractRawText({ buffer });
        rawText = value || "";
      } catch (err: unknown) {
        throw new Error(
          `Failed to parse DOCX document: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else if (
      lowerName.endsWith(".txt") ||
      lowerName.endsWith(".md") ||
      mimeType === "text/plain" ||
      mimeType === "text/markdown" ||
      mimeType === "text/x-markdown"
    ) {
      rawText = buffer.toString("utf-8");
    } else {
      throw new Error(`Unsupported document extension for ${filename}`);
    }
  } catch (err: unknown) {
    if (err instanceof Error) throw err;
    throw new Error(`Failed to extract text from ${filename}: ${String(err)}`);
  }

  const text = normalizeText(rawText);

  if (!text || text.length < 5) {
    throw new Error("Document contains no readable text or is empty.");
  }

  if (text.length > MAX_EXTRACTED_TEXT_LENGTH) {
    throw new Error(
      `Document text exceeds safety limit of ${MAX_EXTRACTED_TEXT_LENGTH} characters.`
    );
  }

  const contentHash = computeContentHash(text);

  return {
    text,
    contentHash,
    charCount: text.length,
  };
}
