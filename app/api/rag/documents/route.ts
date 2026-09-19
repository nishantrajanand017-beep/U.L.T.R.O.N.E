import { NextRequest, NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import {
  extractTextFromDocument,
  MAX_DOCUMENT_FILE_SIZE,
} from "@/lib/rag/documentExtractor";
import { chunkText } from "@/lib/rag/chunker";
import {
  createDocument,
  listDocuments,
  deleteDocument,
} from "@/lib/rag/ragStore";

/**
 * GET /api/rag/documents
 * Lists all documents belonging to the authenticated user.
 */
export async function GET(req: NextRequest) {
  try {
    const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(req);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    if (isAnonymous) {
      return NextResponse.json(
        { error: "Forbidden: Guest sessions cannot access or search private documents." },
        { status: 403 }
      );
    }
    const documents = await listDocuments(userId);

    const resp = NextResponse.json({
      documents: documents.map((d) => ({
        id: d.id,
        filename: d.filename,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
    });

    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err) {
    console.error("[GET /api/rag/documents Error]", err);
    return NextResponse.json(
      { error: "Failed to retrieve documents." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/rag/documents
 * Accepts multipart/form-data with a "file" field, extracts text, chunks, and indexes.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(req);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    if (isAnonymous) {
      return NextResponse.json(
        { error: "Forbidden: Guest sessions cannot upload or store private documents." },
        { status: 403 }
      );
    }

    const formData = await req.formData().catch(() => null);
    if (!formData) {
      const resp = NextResponse.json(
        { error: "Invalid form data submission." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      const resp = NextResponse.json(
        { error: "Missing required 'file' upload in form data." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    if (file.size > MAX_DOCUMENT_FILE_SIZE) {
      const resp = NextResponse.json(
        {
          error: `File exceeds maximum allowed size of 10 MB (received ${(file.size / (1024 * 1024)).toFixed(2)} MB).`,
        },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extracted;
    try {
      extracted = await extractTextFromDocument(buffer, file.name, file.type);
    } catch (extractErr) {
      const resp = NextResponse.json(
        {
          error:
            extractErr instanceof Error
              ? extractErr.message
              : "Failed to extract readable text from document.",
        },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    // Generate bounded chunks
    const chunks = chunkText(extracted.text);
    if (chunks.length === 0) {
      const resp = NextResponse.json(
        { error: "Document produced no usable text chunks." },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    // Persist document and chunks
    const document = await createDocument(
      userId,
      file.name,
      file.type || "application/octet-stream",
      file.size,
      extracted.contentHash,
      chunks
    );

    const resp = NextResponse.json({
      success: true,
      document: {
        id: document.id,
        filename: document.filename,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        chunkCount: document.chunkCount || chunks.length,
        createdAt: document.createdAt,
      },
    });

    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err) {
    console.error("[POST /api/rag/documents Error]", err);
    return NextResponse.json(
      { error: "Internal server error processing document upload." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/rag/documents?id=<documentId>
 * Deletes a document and its chunks, verifying ownership.
 */
export async function DELETE(req: NextRequest) {
  try {
    const { userId, isAuthenticated, isAnonymous, isNew } = await resolveUserSession(req);
    if (!userId || !isAuthenticated) {
      return NextResponse.json(
        { error: "Unauthorized: Authentication required." },
        { status: 401 }
      );
    }
    if (isAnonymous) {
      return NextResponse.json(
        { error: "Forbidden: Guest sessions cannot delete private documents." },
        { status: 403 }
      );
    }
    const documentId = req.nextUrl.searchParams.get("id");

    if (!documentId || !documentId.trim()) {
      const resp = NextResponse.json(
        { error: "Document ID is required via ?id=<uuid>" },
        { status: 400 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const deleted = await deleteDocument(userId, documentId.trim());
    if (!deleted) {
      // If not found or belongs to another user, return 404 without leaking existence
      const resp = NextResponse.json(
        { error: "Document not found or access denied." },
        { status: 404 }
      );
      if (isNew) attachSessionCookie(resp, userId);
      return resp;
    }

    const resp = NextResponse.json({
      success: true,
      message: "Document deleted successfully.",
    });

    if (isNew) attachSessionCookie(resp, userId);
    return resp;
  } catch (err) {
    console.error("[DELETE /api/rag/documents Error]", err);
    return NextResponse.json(
      { error: "Failed to delete document." },
      { status: 500 }
    );
  }
}
