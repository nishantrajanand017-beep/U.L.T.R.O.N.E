import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getSupabase } from "@/lib/db/deviceStore";

export interface UltronDocument {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  chunkCount?: number;
}

export interface UltronDocumentChunk {
  id: string;
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  createdAt: string;
}

export interface RetrievedChunkResult {
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  score: number;
}

// Local fallback file paths
const DATA_DIR = path.join(process.cwd(), "data");
const LOCAL_DOCUMENTS_FILE = path.join(DATA_DIR, "user_documents.json");
const LOCAL_CHUNKS_FILE = path.join(DATA_DIR, "user_document_chunks.json");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readLocalDocuments(): UltronDocument[] {
  ensureDataDir();
  if (!fs.existsSync(LOCAL_DOCUMENTS_FILE)) return [];
  try {
    const raw = fs.readFileSync(LOCAL_DOCUMENTS_FILE, "utf-8");
    return JSON.parse(raw) as UltronDocument[];
  } catch {
    return [];
  }
}

function writeLocalDocuments(docs: UltronDocument[]): void {
  ensureDataDir();
  fs.writeFileSync(LOCAL_DOCUMENTS_FILE, JSON.stringify(docs, null, 2), "utf-8");
}

function readLocalChunks(): UltronDocumentChunk[] {
  ensureDataDir();
  if (!fs.existsSync(LOCAL_CHUNKS_FILE)) return [];
  try {
    const raw = fs.readFileSync(LOCAL_CHUNKS_FILE, "utf-8");
    return JSON.parse(raw) as UltronDocumentChunk[];
  } catch {
    return [];
  }
}

function writeLocalChunks(chunks: UltronDocumentChunk[]): void {
  ensureDataDir();
  fs.writeFileSync(LOCAL_CHUNKS_FILE, JSON.stringify(chunks, null, 2), "utf-8");
}

/**
 * Creates a new document and stores its pre-computed chunks.
 * If a document with the identical content hash already exists for this user,
 * returns the existing document without creating duplicate rows.
 */
export async function createDocument(
  userId: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
  contentHash: string,
  chunks: Array<{ chunkIndex: number; content: string }>
): Promise<UltronDocument> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("userId is strictly required for document operations.");
  }
  if (!filename || typeof filename !== "string" || !filename.trim()) {
    throw new Error("filename is required.");
  }

  const supabase = getSupabase();

  if (supabase) {
    try {
      // 1. Check for duplicate content hash for this user
      const { data: existing } = await supabase
        .from("ultron_documents")
        .select("*")
        .eq("user_id", userId)
        .eq("content_hash", contentHash)
        .maybeSingle();

      if (existing) {
        return {
          id: existing.id,
          userId: existing.user_id,
          filename: existing.filename,
          mimeType: existing.mime_type,
          sizeBytes: Number(existing.size_bytes),
          contentHash: existing.content_hash,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at,
          chunkCount: chunks.length,
        };
      }

      // 2. Insert document metadata
      const newDocId = crypto.randomUUID();
      const now = new Date().toISOString();

      const { data: docData, error: docError } = await supabase
        .from("ultron_documents")
        .insert({
          id: newDocId,
          user_id: userId,
          filename,
          mime_type: mimeType,
          size_bytes: sizeBytes,
          content_hash: contentHash,
          created_at: now,
          updated_at: now,
        })
        .select()
        .single();

      if (docError || !docData) {
        throw docError || new Error("Failed to insert document metadata");
      }

      // 3. Insert chunks
      if (chunks.length > 0) {
        const chunkRows = chunks.map((c) => ({
          id: crypto.randomUUID(),
          document_id: newDocId,
          user_id: userId,
          chunk_index: c.chunkIndex,
          content: c.content,
          created_at: now,
        }));

        const { error: chunkError } = await supabase
          .from("ultron_document_chunks")
          .insert(chunkRows);

        if (chunkError) {
          // Attempt rollback of document row
          await supabase.from("ultron_documents").delete().eq("id", newDocId);
          throw chunkError;
        }
      }

      return {
        id: docData.id,
        userId: docData.user_id,
        filename: docData.filename,
        mimeType: docData.mime_type,
        sizeBytes: Number(docData.size_bytes),
        contentHash: docData.content_hash,
        createdAt: docData.created_at,
        updatedAt: docData.updated_at,
        chunkCount: chunks.length,
      };
    } catch (err) {
      console.warn("[RAG Supabase Create Error, using local fallback]", err);
    }
  }

  // Local JSON fallback
  const docs = readLocalDocuments();
  const existing = docs.find(
    (d) => d.userId === userId && d.contentHash === contentHash
  );

  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const docId = crypto.randomUUID();
  const newDoc: UltronDocument = {
    id: docId,
    userId,
    filename,
    mimeType,
    sizeBytes,
    contentHash,
    createdAt: now,
    updatedAt: now,
    chunkCount: chunks.length,
  };

  docs.push(newDoc);
  writeLocalDocuments(docs);

  const allChunks = readLocalChunks();
  const newChunks: UltronDocumentChunk[] = chunks.map((c) => ({
    id: crypto.randomUUID(),
    documentId: docId,
    userId,
    chunkIndex: c.chunkIndex,
    content: c.content,
    createdAt: now,
  }));

  allChunks.push(...newChunks);
  writeLocalChunks(allChunks);

  return newDoc;
}

/**
 * Lists all documents belonging to a user (metadata only, no chunks)
 */
export async function listDocuments(userId: string): Promise<UltronDocument[]> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("userId is strictly required for listDocuments.");
  }

  const supabase = getSupabase();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_documents")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (!error && data) {
        return (data as Array<Record<string, any>>).map((d) => ({
          id: d.id,
          userId: d.user_id,
          filename: d.filename,
          mimeType: d.mime_type,
          sizeBytes: Number(d.size_bytes),
          contentHash: d.content_hash,
          createdAt: d.created_at,
          updatedAt: d.updated_at,
        }));
      }
    } catch (err) {
      console.warn("[RAG Supabase List Error, using local fallback]", err);
    }
  }

  const docs = readLocalDocuments();
  return docs
    .filter((d) => d.userId === userId)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}

/**
 * Retrieves a single document by ID, verifying ownership
 */
export async function getDocument(
  userId: string,
  documentId: string
): Promise<UltronDocument | null> {
  if (!userId || !documentId) return null;

  const supabase = getSupabase();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_documents")
        .select("*")
        .eq("user_id", userId)
        .eq("id", documentId)
        .maybeSingle();

      if (!error && data) {
        return {
          id: data.id,
          userId: data.user_id,
          filename: data.filename,
          mimeType: data.mime_type,
          sizeBytes: Number(data.size_bytes),
          contentHash: data.content_hash,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
        };
      }
    } catch (err) {
      console.warn("[RAG Supabase Get Error, using local fallback]", err);
    }
  }

  const docs = readLocalDocuments();
  const found = docs.find((d) => d.userId === userId && d.id === documentId);
  return found || null;
}

/**
 * Deletes a document and its associated chunks, verifying ownership
 */
export async function deleteDocument(
  userId: string,
  documentId: string
): Promise<boolean> {
  if (!userId || !documentId) return false;

  const supabase = getSupabase();

  if (supabase) {
    try {
      // First verify ownership
      const { data: existing } = await supabase
        .from("ultron_documents")
        .select("id")
        .eq("user_id", userId)
        .eq("id", documentId)
        .maybeSingle();

      if (!existing) {
        return false;
      }

      // Foreign key CASCADE will delete associated chunks
      const { error } = await supabase
        .from("ultron_documents")
        .delete()
        .eq("user_id", userId)
        .eq("id", documentId);

      return !error;
    } catch (err) {
      console.warn("[RAG Supabase Delete Error, using local fallback]", err);
    }
  }

  // Local fallback
  const docs = readLocalDocuments();
  const initialDocCount = docs.length;
  const filteredDocs = docs.filter(
    (d) => !(d.userId === userId && d.id === documentId)
  );

  if (filteredDocs.length === initialDocCount) {
    return false; // Document was not found or did not belong to this user
  }

  writeLocalDocuments(filteredDocs);

  const chunks = readLocalChunks();
  const filteredChunks = chunks.filter(
    (c) => !(c.userId === userId && c.documentId === documentId)
  );
  writeLocalChunks(filteredChunks);

  return true;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "because",
  "as",
  "what",
  "which",
  "this",
  "that",
  "these",
  "those",
  "then",
  "just",
  "so",
  "than",
  "such",
  "both",
  "through",
  "about",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "of",
  "while",
  "during",
  "to",
  "from",
  "in",
  "out",
  "on",
  "off",
  "again",
  "further",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "too",
  "very",
  "can",
  "will",
  "should",
  "now",
  "my",
  "your",
  "tell",
  "say",
  "explain",
]);

function tokenizeText(text: string): string[] {
  const matches = text.toLowerCase().match(/\b[a-z0-9_]{2,}\b/g);
  return matches || [];
}

/**
 * Searches chunks strictly scoped to the resolved user using deterministic BM25 lexical ranking.
 */
export async function searchChunks(
  userId: string,
  query: string,
  topK: number = 5
): Promise<RetrievedChunkResult[]> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    return [];
  }
  if (!query || typeof query !== "string" || !query.trim()) {
    return [];
  }

  // 1. Load user documents to build id -> filename map
  const userDocs = await listDocuments(userId);
  if (userDocs.length === 0) {
    return [];
  }
  const docMap = new Map<string, string>();
  for (const d of userDocs) {
    docMap.set(d.id, d.filename);
  }

  // 2. Load all chunks for this user
  let userChunks: UltronDocumentChunk[] = [];
  const supabase = getSupabase();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("ultron_document_chunks")
        .select("*")
        .eq("user_id", userId);

      if (!error && data) {
        userChunks = (data as Array<Record<string, any>>).map((c) => ({
          id: c.id,
          documentId: c.document_id,
          userId: c.user_id,
          chunkIndex: c.chunk_index,
          content: c.content,
          createdAt: c.created_at,
        }));
      }
    } catch (err) {
      console.warn("[RAG Supabase Chunk Search Warning]", err);
    }
  }

  if (userChunks.length === 0) {
    const allLocalChunks = readLocalChunks();
    userChunks = allLocalChunks.filter((c) => c.userId === userId);
  }

  if (userChunks.length === 0) {
    return [];
  }

  // 3. Tokenize query
  const rawTokens = tokenizeText(query);
  const queryTokens = rawTokens.filter((t) => !STOP_WORDS.has(t));
  const effectiveTokens = queryTokens.length > 0 ? queryTokens : rawTokens;

  if (effectiveTokens.length === 0) {
    return [];
  }

  // 4. BM25 parameters
  const k1 = 1.2;
  const b = 0.75;
  const N = userChunks.length;

  // Pre-tokenize chunks and compute document lengths
  const chunkTokensList: string[][] = [];
  let totalTokens = 0;

  for (const chunk of userChunks) {
    const tokens = tokenizeText(chunk.content);
    chunkTokensList.push(tokens);
    totalTokens += tokens.length;
  }

  const avgdl = totalTokens / N || 1;

  // Calculate Document Frequency for each query term
  const dfMap = new Map<string, number>();
  for (const q of effectiveTokens) {
    let df = 0;
    for (const tokens of chunkTokensList) {
      if (tokens.includes(q)) {
        df++;
      }
    }
    dfMap.set(q, df);
  }

  // Compute BM25 score for each chunk
  const scoredChunks: RetrievedChunkResult[] = [];
  const cleanQueryPhrase = query.toLowerCase().trim();

  for (let i = 0; i < userChunks.length; i++) {
    const chunk = userChunks[i];
    const tokens = chunkTokensList[i];
    const dl = tokens.length;

    // Count term frequencies in this chunk
    const tfMap = new Map<string, number>();
    for (const t of tokens) {
      tfMap.set(t, (tfMap.get(t) || 0) + 1);
    }

    let score = 0;
    for (const q of effectiveTokens) {
      const tf = tfMap.get(q) || 0;
      if (tf > 0) {
        const df = dfMap.get(q) || 0;
        // Standard BM25 IDF
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const termScore =
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl))));
        score += termScore;
      }
    }

    // Exact phrase match bonus
    if (chunk.content.toLowerCase().includes(cleanQueryPhrase)) {
      score += 2.5;
    }

    if (score > 0.05) {
      scoredChunks.push({
        documentId: chunk.documentId,
        filename: docMap.get(chunk.documentId) || "document",
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: Math.round(score * 1000) / 1000,
      });
    }
  }

  // Sort descending by score
  scoredChunks.sort((a, b) => b.score - a.score);

  // Return topK
  return scoredChunks.slice(0, topK);
}
