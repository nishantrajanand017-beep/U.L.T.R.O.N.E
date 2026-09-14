/**
 * lib/memory/memoryExtractor.ts
 *
 * Deterministic & heuristic memory extraction engine for ULTRON.
 * Extracts persistent user facts without exposing database access to the model.
 *
 * Safety & Quality Controls:
 * 1. High-confidence filter: Only processes clear, declarative personal statements.
 * 2. Whitelist categories: preference, profile, project, instruction.
 * 3. Sanitization & Injection Prevention: Blocks prompt injection payloads, system overrides, and credentials.
 * 4. Zero Latency Impact on standard queries: Non-declarative prompts exit immediately.
 * 5. Fail-safe: Extraction errors never interrupt conversational chat flow.
 */

import type { MemoryCategory } from "./memoryStore";
import { isValidCategory, validateMemoryInput } from "./memoryStore";

export interface MemoryCandidate {
  category: MemoryCategory;
  key: string;
  value: string;
}

// Triggers that indicate a user might be stating a persistent personal fact
const MEMORY_TRIGGER_REGEX =
  /\b(my favorite|i prefer|i like|i love|i hate|i dislike|i am building|i'm building|my name is|call me|i work as|i am an?|i'm an?|i live in|remember that i|remember that my)\b/i;

// Questions and query prefixes that must NEVER be extracted as memories
const NON_MEMORY_QUERY_REGEX =
  /^(what|where|who|when|why|how|can you|could you|tell me|explain|write|generate|open|launch|run|search|show|help)\b/i;

// Dangerous keywords that must be rejected from memory storage
const SUSPICIOUS_CONTENT_REGEX =
  /(ignore\s+(all\s+)?(previous|prior|system)\s+instructions|system\s+prompt|eval\(|<script|override\s+security|sk-[a-zA-Z0-9]|bearer\s+|password\s*[:=]|api[_-]?key\s*[:=])/i;

/**
 * Checks whether a message contains a candidate personal memory worth extracting.
 */
export function containsMemoryCue(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 5 || trimmed.length > 300) return false;

  // If it's a question, do not extract
  if (trimmed.endsWith("?") || NON_MEMORY_QUERY_REGEX.test(trimmed)) {
    return false;
  }

  return MEMORY_TRIGGER_REGEX.test(trimmed);
}

/**
 * Extracts a structured memory candidate from user text.
 * Returns null if no high-confidence fact is found.
 */
export function extractMemoryFromText(text: string): MemoryCandidate | null {
  if (!containsMemoryCue(text)) {
    return null;
  }

  const cleanText = text.trim();

  // Reject malicious injection attempts or sensitive credentials
  if (SUSPICIOUS_CONTENT_REGEX.test(cleanText)) {
    return null;
  }

  // Pattern 1: "My favorite <subject> is <value>"
  const favMatch = cleanText.match(
    /(?:my\s+favorite\s+([a-z0-9_\-\s]{2,40}?)\s+is\s+([^,;.\n]+))/i
  );
  if (favMatch) {
    const rawSubj = favMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
    const val = favMatch[2].trim();
    if (rawSubj && val) {
      try {
        const validated = validateMemoryInput("preference", `favorite_${rawSubj}`, val);
        return validated;
      } catch {
        return null;
      }
    }
  }

  // Pattern 2: "I prefer <value>"
  const preferMatch = cleanText.match(
    /(?:i\s+prefer\s+([^,;.\n]+))/i
  );
  if (preferMatch) {
    const val = preferMatch[1].trim();
    if (val) {
      try {
        // If it looks like an instruction ("short answers", "concise answers", "bullet points")
        const isInstruction = /\b(answers?|responses?|bullet\s*points?|step[- ]by[- ]step|explanations?)\b/i.test(val);
        const category: MemoryCategory = isInstruction ? "instruction" : "preference";
        const key = isInstruction ? "response_style" : "user_preference";
        const validated = validateMemoryInput(category, key, `prefers ${val}`);
        return validated;
      } catch {
        return null;
      }
    }
  }

  // Pattern 3: "I'm building / I am building <project>"
  const buildingMatch = cleanText.match(
    /(?:i(?:\s*am|'m)\s+building\s+(?:a\s+project\s+(?:called\s+)?)?([^,;.\n]+))/i
  );
  if (buildingMatch) {
    const val = buildingMatch[1].trim();
    if (val) {
      try {
        const validated = validateMemoryInput("project", "current_project", `building ${val}`);
        return validated;
      } catch {
        return null;
      }
    }
  }

  // Pattern 4: "My name is <name>" / "Call me <name>"
  const nameMatch = cleanText.match(
    /(?:(?:my\s+name\s+is|call\s+me)\s+([a-zA-Z\s]{2,40}))/i
  );
  if (nameMatch) {
    const val = nameMatch[1].trim();
    if (val) {
      try {
        const validated = validateMemoryInput("profile", "user_name", val);
        return validated;
      } catch {
        return null;
      }
    }
  }

  // Pattern 5: "I work as <occupation>" / "I am a <occupation>"
  const occMatch = cleanText.match(
    /(?:i\s+work\s+as\s+(?:an?\s+)?([a-zA-Z0-9_\-\s]{2,50}))/i
  );
  if (occMatch) {
    const val = occMatch[1].trim();
    if (val) {
      try {
        const validated = validateMemoryInput("profile", "occupation", val);
        return validated;
      } catch {
        return null;
      }
    }
  }

  // Pattern 6: "I live in <location>"
  const locMatch = cleanText.match(
    /(?:i\s+live\s+in\s+([a-zA-Z0-9_\-\s]{2,50}))/i
  );
  if (locMatch) {
    const val = locMatch[1].trim();
    if (val) {
      try {
        const validated = validateMemoryInput("profile", "location", val);
        return validated;
      } catch {
        return null;
      }
    }
  }

  // Pattern 7: "Remember that I <preference/fact>"
  const rememberMatch = cleanText.match(
    /(?:remember\s+that\s+(?:i\s+)?([^,;.\n]+))/i
  );
  if (rememberMatch) {
    const val = rememberMatch[1].trim();
    if (val) {
      try {
        const validated = validateMemoryInput("preference", "noted_preference", val);
        return validated;
      } catch {
        return null;
      }
    }
  }

  return null;
}
