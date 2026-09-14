/**
 * lib/qwenService.ts
 *
 * Dedicated server-side service for local Qwen3-8B LLM generation.
 * Communicates with Ollama's OpenAI-compatible REST endpoint (/v1/chat/completions).
 * Configured with the official ULTRON persona, OpenAI-compatible tool support, and robust error handling.
 */

import type { ToolDefinition, ToolCall } from "./tools/types";

export interface QwenChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface QwenGenerationOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
}

export interface QwenGenerationResult {
  text: string;
  model: string;
  source: "qwen";
  toolCalls?: ToolCall[];
  rawMessage?: QwenChatMessage;
}

export class QwenServiceError extends Error {
  public statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "QwenServiceError";
    this.statusCode = statusCode;
  }
}

export const DEFAULT_QWEN_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_QWEN_MODEL = "qwen3:8b";
export const DEFAULT_TIMEOUT_MS = 120_000; // 120 seconds

/**
 * Standard ULTRON persona system prompt.
 * Ensures the assistant identifies as ULTRON, remains concise and professional,
 * and never exposes internal model or provider details.
 */
export const ULTRON_SYSTEM_PROMPT = `You are ULTRON, a powerful, intelligent personal AI assistant.
Guidelines:
- Identify yourself exclusively as ULTRON, the user's personal assistant.
- Never claim to be Gemini, Qwen, or another entity. Do not mention underlying models or providers unless explicitly asked.
- Speak with confidence, precision, and professional courtesy.
- Be concise, direct, and helpful by default. Avoid unnecessary filler, preamble, or repeating the user's question.
- For conversational questions, respond naturally and politely.
- For technical, mathematical, or coding queries, provide accurate, clean, and efficient solutions with brief explanations.
- Never output internal chain-of-thought, reasoning scratchpads, or hidden tags.
- When the user asks about device status, the current time, or opening an application, use the provided tools.`;

/**
 * Voice Mode specific system instruction.
 * Instructs Qwen to generate concise, spoken-length conversational responses
 * free of markdown, lists, and unnecessary preamble so that local Kokoro TTS
 * synthesizes smoothly and completes well within the 20-second safety timeout.
 */
export const ULTRON_VOICE_SYSTEM_INSTRUCTION = `CRITICAL VOICE MODE INSTRUCTION:
You are currently speaking with the user in hands-free SPOKEN VOICE MODE. Your response will be synthesized directly into spoken audio.
- Respond naturally and conversationally in plain spoken English, as an articulate, helpful voice companion.
- Length guidelines:
  * For simple questions: 1 to 2 concise sentences.
  * For normal questions: enough natural spoken sentences to answer completely and informatively.
  * For detailed or complex questions: provide a clear, useful explanation concise enough for spoken conversation. Aim for approximately 400 to 800 characters for a normal detailed spoken response. Avoid writing giant essays, manuals, or dozens of paragraphs.
- Keep the spoken dialogue focused: avoid excessive repetition and avoid unnecessary examples.
- NEVER use markdown syntax: NO asterisks (* or **), NO bold or italic text, NO headings (#), NO bulleted or numbered lists (e.g. 1. 2. 3.), NO tables, and NO code blocks.
- Speak in continuous narrative sentences rather than bullet points or list items. Express sequences naturally (e.g., "First, ... Next, ... Then, ...").
- Complete all thoughts naturally—never cut an answer off mid-sentence.
- Do not unnecessarily repeat the user's question back to them.`;

/**
 * Strips any stray markdown formatting (e.g. bold asterisks, code ticks, headers, numbered list prefixes)
 * to ensure smooth and natural text-to-speech audio pronunciation.
 */
export function cleanSpokenText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1") // bold
    .replace(/\*(.*?)\*/g, "$1") // italic
    .replace(/_{1,2}(.*?)_{1,2}/g, "$1") // underscores
    .replace(/^#{1,6}\s+/gm, "") // headers
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/^\s*[-*+]\s+/gm, "") // bullets
    .replace(/^\s*\d+\.\s+/gm, "") // numbered list items (e.g. "1. ")
    .replace(/\n{2,}/g, " ") // multi newlines into space
    .replace(/\n/g, " ") // single newline into space
    .replace(/\s{2,}/g, " ") // collapse multiple spaces
    .trim();
}



export function getQwenBaseUrl(): string {
  return (process.env.QWEN_BASE_URL?.trim() || DEFAULT_QWEN_BASE_URL).replace(/\/+$/, "");
}

export function getQwenModel(): string {
  return process.env.QWEN_MODEL?.trim() || DEFAULT_QWEN_MODEL;
}

/**
 * Generates an assistant response using local Qwen3-8B via Ollama's OpenAI-compatible endpoint.
 * Supports multi-turn conversation and OpenAI-compatible function/tool calling.
 *
 * @param prompt - The current user message string (can be empty if continuing with history).
 * @param history - Preceding conversation history (can include user, assistant, and tool messages).
 * @param options - Generation options (model, system prompt, temperature, maxTokens, timeout, tools, toolChoice).
 */
export async function generateQwenResponse(
  prompt: string,
  history: QwenChatMessage[] = [],
  options: QwenGenerationOptions = {}
): Promise<QwenGenerationResult> {
  const trimmedPrompt = prompt ? prompt.trim() : "";
  if (!trimmedPrompt && history.length === 0) {
    throw new QwenServiceError("Invalid request: prompt or history must not be empty.", 400);
  }

  const baseUrl = getQwenBaseUrl();
  const endpoint = `${baseUrl}/chat/completions`;
  const model = options.model || getQwenModel();
  const systemPrompt = options.systemPrompt ?? ULTRON_SYSTEM_PROMPT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = options.temperature ?? 0.6;
  const maxTokens = options.maxTokens ?? 2048;

  // Filter valid history messages
  const sanitizedHistory = history.filter((m) => {
    if (!m) return false;
    if (m.role === "tool") return Boolean(m.tool_call_id && m.content !== null);
    if (m.tool_calls && m.tool_calls.length > 0) return true;
    return typeof m.content === "string" && m.content.trim().length > 0;
  });

  // Assemble full messages payload with system prompt first
  const messages: QwenChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...sanitizedHistory,
  ];

  if (trimmedPrompt) {
    messages.push({ role: "user", content: trimmedPrompt });
  }

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  // Attach tool schemas if provided
  if (options.tools && options.tools.length > 0) {
    requestBody.tools = options.tools;
    requestBody.tool_choice = options.toolChoice || "auto";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Harmless local auth header for OpenAI compatibility
        Authorization: "Bearer ollama-local",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorDetail = "";
      try {
        const errorJson = await response.json();
        errorDetail = errorJson?.error?.message || errorJson?.error || JSON.stringify(errorJson);
      } catch {
        errorDetail = await response.text().catch(() => "");
      }

      if (response.status === 404) {
        throw new QwenServiceError(
          `Qwen model '${model}' not found in local Ollama library. Please verify with 'ollama list'.`,
          404
        );
      }

      throw new QwenServiceError(
        `Ollama returned HTTP ${response.status}: ${errorDetail || response.statusText}`,
        response.status
      );
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      throw new QwenServiceError("Received malformed or empty JSON from Qwen endpoint.", 502);
    }

    const choice = data.choices?.[0];
    const choiceMessage = choice?.message;
    let replyText = typeof choiceMessage?.content === "string" ? choiceMessage.content : "";

    // Parse tool_calls if present
    const rawToolCalls = choiceMessage?.tool_calls;
    let parsedToolCalls: ToolCall[] | undefined = undefined;

    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      parsedToolCalls = [];
      for (const tc of rawToolCalls) {
        if (tc && tc.function && typeof tc.function.name === "string") {
          const rawArgs = tc.function.arguments;
          const argsString =
            typeof rawArgs === "string"
              ? rawArgs
              : typeof rawArgs === "object" && rawArgs !== null
              ? JSON.stringify(rawArgs)
              : "{}";

          parsedToolCalls.push({
            id:
              typeof tc.id === "string" && tc.id.trim()
                ? tc.id.trim()
                : `call_${Math.random().toString(36).slice(2, 10)}`,
            type: "function",
            function: {
              name: tc.function.name.trim(),
              arguments: argsString,
            },
          });
        }
      }
    }

    // Clean any accidental leading/trailing think tags if present
    replyText = replyText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    // If no text and no tool calls, fallback to friendly standby
    if (!replyText && (!parsedToolCalls || parsedToolCalls.length === 0)) {
      replyText = "I am online and ready to assist you.";
    }

    return {
      text: replyText,
      model,
      source: "qwen",
      toolCalls: parsedToolCalls && parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      rawMessage: {
        role: "assistant",
        content: replyText || null,
        tool_calls: parsedToolCalls && parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      },
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    if (err instanceof QwenServiceError) {
      throw err;
    }

    if (err instanceof Error && err.name === "AbortError") {
      throw new QwenServiceError(
        `Qwen request timed out after ${timeoutMs / 1000}s. The local engine may be under heavy load.`,
        504
      );
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      throw new QwenServiceError(
        "Cannot connect to local Ollama server at 127.0.0.1:11434. Please ensure Ollama is running.",
        503
      );
    }

    throw new QwenServiceError("An unexpected error occurred while communicating with Qwen.", 500);
  }
}
