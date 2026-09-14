export interface DocumentChunkCandidate {
  chunkIndex: number;
  content: string;
  charLength: number;
}

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 150;
export const MAX_CHUNKS_PER_DOCUMENT = 500;

/**
 * Splits normalized text into deterministic overlapping chunks,
 * preferring paragraph, newline, or sentence boundaries.
 */
export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP
): DocumentChunkCandidate[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const trimmed = text.trim();
  if (trimmed.length <= chunkSize) {
    return [
      {
        chunkIndex: 0,
        content: trimmed,
        charLength: trimmed.length,
      },
    ];
  }

  const chunks: DocumentChunkCandidate[] = [];
  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < trimmed.length) {
    if (chunkIndex >= MAX_CHUNKS_PER_DOCUMENT) {
      console.warn(
        `[RAG Chunker] Document exceeded maximum chunk limit of ${MAX_CHUNKS_PER_DOCUMENT}. Truncating remainder.`
      );
      break;
    }

    // Determine target end index
    let targetEnd = startIndex + chunkSize;

    if (targetEnd >= trimmed.length) {
      // Last chunk
      const finalContent = trimmed.slice(startIndex).trim();
      if (finalContent.length > 0) {
        chunks.push({
          chunkIndex,
          content: finalContent,
          charLength: finalContent.length,
        });
      }
      break;
    }

    // Attempt to locate natural boundary near targetEnd within search window
    const searchWindowStart = Math.max(startIndex + chunkSize - overlap, startIndex + 100);
    const searchWindowEnd = Math.min(startIndex + chunkSize + overlap, trimmed.length);
    const windowText = trimmed.slice(searchWindowStart, searchWindowEnd);

    let splitOffset = -1;

    // 1. Paragraph boundary (\n\n)
    const paraIdx = windowText.lastIndexOf("\n\n");
    if (paraIdx !== -1) {
      splitOffset = searchWindowStart + paraIdx + 2;
    } else {
      // 2. Line boundary (\n)
      const lineIdx = windowText.lastIndexOf("\n");
      if (lineIdx !== -1) {
        splitOffset = searchWindowStart + lineIdx + 1;
      } else {
        // 3. Sentence boundary (. or ? or ! followed by space or newline)
        const sentenceMatch = windowText.match(/([.?!])\s+[A-Z0-9]/g);
        if (sentenceMatch && sentenceMatch.length > 0) {
          const lastSentence = sentenceMatch[sentenceMatch.length - 1];
          const sentIdx = windowText.lastIndexOf(lastSentence);
          if (sentIdx !== -1) {
            splitOffset = searchWindowStart + sentIdx + 2;
          }
        }

        // 4. Word boundary (space)
        if (splitOffset === -1) {
          const spaceIdx = windowText.lastIndexOf(" ");
          if (spaceIdx !== -1) {
            splitOffset = searchWindowStart + spaceIdx + 1;
          } else {
            // 5. Fall back to exact target
            splitOffset = targetEnd;
          }
        }
      }
    }

    const chunkContent = trimmed.slice(startIndex, splitOffset).trim();
    if (chunkContent.length > 0) {
      chunks.push({
        chunkIndex,
        content: chunkContent,
        charLength: chunkContent.length,
      });
      chunkIndex++;
    }

    // Next start position with overlap
    let nextStart = splitOffset - overlap;
    if (nextStart <= startIndex) {
      nextStart = startIndex + Math.max(1, Math.floor(chunkSize / 2));
    }

    // Snap nextStart to start of word if in middle of word
    while (nextStart < trimmed.length && nextStart > 0 && trimmed[nextStart - 1] !== " " && trimmed[nextStart - 1] !== "\n") {
      nextStart++;
    }

    startIndex = nextStart;
  }

  return chunks;
}
