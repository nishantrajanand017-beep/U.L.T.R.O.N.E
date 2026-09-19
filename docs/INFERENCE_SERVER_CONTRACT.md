# ULTRON Remote Inference Server Contract

This document specifies the technical and security contract between the Vercel-hosted ULTRON web application and the dedicated remote private AI inference server hosting Qwen3-8B, Whisper large-v3-turbo, and Kokoro-82M.

---

## 1. Architectural Boundary

```
[ Client / Browser ]
         │
         │ (Session Cookie / CSRF Same-Origin / Verified Identity)
         ▼
[ Vercel ULTRON Backend ]  (Server-to-Server boundary)
         │
         │ Authorization: Bearer <AI_INFERENCE_API_KEY>
         ▼
[ Authenticated Private AI Inference Server ]
   ├── Qwen3-8B (/v1/chat/completions)
   ├── Whisper large-v3-turbo (/v1/audio/transcriptions)
   └── Kokoro-82M (/v1/audio/speech)
```

> **Security Distinction**:
> - **Client → Vercel**: Authenticated via Supabase user session token. Clients have zero awareness of the remote inference infrastructure.
> - **Vercel → Inference Server**: Server-to-server authenticated private communication via `AI_INFERENCE_API_KEY`. Secrets are never exposed to browser bundles or client responses.

---

## 2. Authentication & Authorization

All requests originating from the Vercel backend to any inference endpoint MUST include the standard HTTP `Authorization` header:

```http
Authorization: Bearer <AI_INFERENCE_API_KEY>
X-Ultron-Client: ultron-backend
X-Inference-Provider: <qwen | whisper | kokoro>
```

### Rejection Contract
The inference server MUST validate the Bearer token before processing any request.
- **Missing credentials**: HTTP `401 Unauthorized` with JSON `{ "error": "unauthorized", "message": "Missing Bearer token." }`
- **Invalid credentials**: HTTP `401 Unauthorized` with JSON `{ "error": "unauthorized", "message": "Invalid API key." }`
- **Forbidden access**: HTTP `403 Forbidden` with JSON `{ "error": "forbidden", "message": "Access denied." }`

---

## 3. Endpoints Specification

### 3.1. Qwen3-8B LLM Service

- **Method**: `POST`
- **Path**: `/v1/chat/completions` (OpenAI-compatible)
- **Environment Variable**: `QWEN_INFERENCE_URL` (Defaults locally to `http://127.0.0.1:11434/v1`)
- **Headers**:
  ```http
  Content-Type: application/json
  Authorization: Bearer <AI_INFERENCE_API_KEY>
  X-Ultron-Client: ultron-backend
  X-Inference-Provider: qwen
  ```
- **Timeout**: 120 seconds (enforced on Vercel client).
- **Request Payload**:
  ```json
  {
    "model": "qwen3:8b",
    "messages": [
      { "role": "system", "content": "You are ULTRON..." },
      { "role": "user", "content": "Hello ULTRON" }
    ],
    "temperature": 0.6,
    "max_tokens": 2048,
    "stream": false,
    "tools": [...]
  }
  ```
- **Response**: Standard OpenAI-compatible `chat.completion` response with `choices[0].message.content` or `choices[0].message.tool_calls`.

---

### 3.2. Whisper large-v3-turbo STT Service

- **Method**: `POST`
- **Path**: `/v1/audio/transcriptions` (OpenAI-compatible)
- **Environment Variable**: `WHISPER_INFERENCE_URL` (Defaults locally to `http://127.0.0.1:8881/v1/audio/transcriptions`)
- **Headers**:
  ```http
  Authorization: Bearer <AI_INFERENCE_API_KEY>
  X-Ultron-Client: ultron-backend
  X-Inference-Provider: whisper
  Content-Type: multipart/form-data; boundary=...
  ```
- **Timeout**: 20 seconds (enforced on Vercel client).
- **Request Body**: Multi-part form data containing:
  - `file`: Audio binary (`audio/webm`, `audio/wav`, `audio/ogg`, or `audio/mp4`). Max 10MB.
  - `model`: Optional string (default: `large-v3-turbo`).
  - `language`: Optional language code (default: `en`).
- **Response**:
  ```json
  {
    "text": "Hello, how can I help you?",
    "language": "en",
    "duration": 2.45,
    "inference_time_ms": 312.0
  }
  ```

---

### 3.3. Kokoro-82M TTS Service

- **Method**: `POST`
- **Path**: `/v1/audio/speech` (OpenAI-compatible)
- **Environment Variable**: `KOKORO_INFERENCE_URL` (Defaults locally to `http://127.0.0.1:8880/v1/audio/speech`)
- **Headers**:
  ```http
  Content-Type: application/json
  Accept: audio/wav
  Authorization: Bearer <AI_INFERENCE_API_KEY>
  X-Ultron-Client: ultron-backend
  X-Inference-Provider: kokoro
  ```
- **Timeout**: 30 seconds (enforced on Vercel client).
- **Request Payload**:
  ```json
  {
    "model": "kokoro",
    "input": "Text to synthesize into natural audio.",
    "voice": "am_adam",
    "response_format": "wav",
    "speed": 1.0
  }
  ```
- **Response**: Binary WAV audio payload with `Content-Type: audio/wav`. Optional response headers: `x-inference-time-ms`, `x-audio-duration-sec`.

---

## 4. Health Check Contract

The inference server MUST provide health verification endpoints for diagnostic monitoring:

- **Path**: `/health` or `HEAD /` on the root domain or `/v1/models`
- **Expected Status**: `HTTP 200 OK`
- **Authentication**: When queried, accepts `Authorization: Bearer <AI_INFERENCE_API_KEY>`.
- **Response Payload**:
  ```json
  {
    "status": "healthy",
    "uptime_seconds": 3600,
    "services": {
      "qwen": "ready",
      "whisper": "ready",
      "kokoro": "ready"
    }
  }
  ```

The Vercel health probe (`lib/ai/inferenceHealth.ts`) enforces a 3-second timeout and reports strictly `{ qwen: "healthy" | "unavailable", whisper: "healthy" | "unavailable", kokoro: "healthy" | "unavailable" }` without leaking internal endpoints or auth headers to public consumers.

---

## 5. Security & SSRF Rules

1. **Static Server Resolution**: Upstream endpoints are strictly loaded from server environment variables (`QWEN_INFERENCE_URL`, `WHISPER_INFERENCE_URL`, `KOKORO_INFERENCE_URL`).
2. **No Dynamic URLs**: The application rejects and ignores any user-supplied or client-supplied URL parameters.
3. **Fail Closed in Production**: If `NODE_ENV === "production"` and `AI_INFERENCE_API_KEY` is not defined, all inference calls immediately fail closed with HTTP 500 configuration errors before dispatching any network requests.
4. **Local Loopback Exception**: Local development (`NODE_ENV !== "production"`) permits unauthenticated loopback access to `127.0.0.1` services to maintain developer velocity without requiring cloud credentials.
