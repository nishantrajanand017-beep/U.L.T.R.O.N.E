"use client";

import { useEffect, useRef, useState } from "react";

interface PendingConfirmationAction {
  confirmationId: string;
  description: string;
  deviceName?: string;
  appName?: string;
  status: "pending" | "confirmed" | "cancelled" | "executing";
}

interface Message {
  id: string;
  sender: "user" | "gemini";
  text: string;
  time: string;
  confirmation?: PendingConfirmationAction;
}

interface ChatPanelProps {
  onClose?: () => void;
}

// Browser SpeechRecognition interface typing
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export default function ChatPanel({ onClose }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "init",
      sender: "gemini",
      text: "ONLINE. Core link established. How may I assist you, sir?",
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const baseInputRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingDoc(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/rag/documents", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to upload document");
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `rag-${Date.now()}`,
          sender: "gemini",
          text: `[DOCUMENT INGESTED] Successfully indexed "${data.document.filename}" (${data.document.chunkCount} chunks). Knowledge is now available for retrieval.`,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload document");
    } finally {
      setIsUploadingDoc(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Stop speech recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  const toggleListening = () => {
    // If currently listening, stop
    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setIsListening(false);
      return;
    }

    // Check browser support
    const windowObj = window as unknown as {
      SpeechRecognition?: new () => ISpeechRecognition;
      webkitSpeechRecognition?: new () => ISpeechRecognition;
    };

    const SpeechRecognitionClass =
      windowObj.SpeechRecognition || windowObj.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      setError("SPEECH RECOGNITION NOT SUPPORTED IN THIS BROWSER");
      return;
    }

    try {
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      baseInputRef.current = inputMessage;

      recognition.onstart = () => {
        setIsListening(true);
        setError(null);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interimTranscript = "";
        let finalTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0].transcript;
          } else {
            interimTranscript += result[0].transcript;
          }
        }

        const recognized = (finalTranscript || interimTranscript).trim();
        if (recognized) {
          const base = baseInputRef.current.trim();
          const combined = base ? `${base} ${recognized}` : recognized;
          setInputMessage(combined);
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        setIsListening(false);
        recognitionRef.current = null;

        if (event.error === "not-allowed") {
          setError("MICROPHONE PERMISSION DENIED");
        } else if (event.error === "no-speech") {
          setError("NO SPEECH DETECTED");
        } else if (event.error === "audio-capture") {
          setError("NO MICROPHONE FOUND");
        } else if (event.error !== "aborted") {
          setError(`VOICE INPUT ERROR: ${event.error.toUpperCase()}`);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.error("Speech recognition start failed:", err);
      setIsListening(false);
      setError("COULD NOT START MICROPHONE");
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputMessage.trim();
    if (!trimmed || isLoading) return;

    // Stop active listening if sending
    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setIsListening(false);
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      sender: "user",
      text: trimmed,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputMessage("");
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const replyText = data.text || data.reply || "No response received.";
      const geminiMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: "gemini",
        text: replyText,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        confirmation:
          data.requiresConfirmation && data.confirmationId
            ? {
                confirmationId: data.confirmationId,
                description:
                  data.pendingAction?.description || "Execute requested action",
                deviceName: data.pendingAction?.deviceName,
                appName: data.pendingAction?.appName,
                status: "pending",
              }
            : undefined,
      };

      setMessages((prev) => [...prev, geminiMsg]);
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to communicate with ULTRON AI Core.";
      setError(errorMsg);
    } finally {
      setIsLoading(false);
      // Re-focus text input for convenience
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleConfirmAction = async (confirmationId: string, messageId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.confirmation
          ? { ...m, confirmation: { ...m.confirmation, status: "executing" } }
          : m
      )
    );

    try {
      const res = await fetch("/api/tools/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationId }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Confirmation failed");
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.confirmation
            ? { ...m, confirmation: { ...m.confirmation, status: "confirmed" } }
            : m
        )
      );

      const resultMsg: Message = {
        id: (Date.now() + 2).toString(),
        sender: "gemini",
        text: data.result?.message || "Action confirmed and executed successfully.",
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, resultMsg]);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Confirmation failed";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.confirmation
            ? { ...m, confirmation: { ...m.confirmation, status: "cancelled" } }
            : m
        )
      );
      setError(errMsg);
    }
  };

  const handleCancelAction = (confirmationId: string, messageId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.confirmation
          ? { ...m, confirmation: { ...m.confirmation, status: "cancelled" } }
          : m
      )
    );
    const cancelMsg: Message = {
      id: (Date.now() + 2).toString(),
      sender: "gemini",
      text: "Action cancelled by user.",
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages((prev) => [...prev, cancelMsg]);
  };

  return (
    <div className="chat-panel" role="region" aria-label="ULTRON Chat">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-title">
          <span className="chat-indicator" />
          COMMUNICATION // ULTRON
        </div>
        {onClose && (
          <button
            type="button"
            className="chat-close-btn"
            onClick={onClose}
            aria-label="Close Chat"
          >
            ✕
          </button>
        )}
      </div>

      {/* Messages Log */}
      <div className="chat-messages">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-msg ${msg.sender === "user" ? "chat-msg-user" : "chat-msg-gemini"}`}
          >
            <div className="chat-msg-meta">
              <span className="chat-msg-sender">
                {msg.sender === "user" ? "YOU" : "ULTRON"}
              </span>
              <span className="chat-msg-time">{msg.time}</span>
            </div>
            <div className="chat-msg-text">{msg.text}</div>
            {msg.confirmation && msg.confirmation.status === "pending" && (
              <div
                style={{
                  marginTop: "8px",
                  padding: "8px 10px",
                  border: "1px solid rgba(0, 240, 255, 0.4)",
                  borderRadius: "4px",
                  background: "rgba(0, 240, 255, 0.05)",
                }}
              >
                <div
                  style={{
                    fontSize: "10px",
                    letterSpacing: "1px",
                    color: "#00f0ff",
                    marginBottom: "4px",
                    fontWeight: 600,
                  }}
                >
                  SYSTEM ACTION REQUIRES CONFIRMATION
                </div>
                <div style={{ fontSize: "12px", marginBottom: "8px" }}>
                  {msg.confirmation.description}?
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() =>
                      handleConfirmAction(msg.confirmation!.confirmationId, msg.id)
                    }
                    style={{
                      background: "#00f0ff",
                      color: "#000",
                      border: "none",
                      padding: "4px 10px",
                      borderRadius: "3px",
                      cursor: "pointer",
                      fontSize: "11px",
                      fontWeight: 600,
                      letterSpacing: "0.5px",
                    }}
                  >
                    CONFIRM
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleCancelAction(msg.confirmation!.confirmationId, msg.id)
                    }
                    style={{
                      background: "transparent",
                      color: "rgba(255, 255, 255, 0.7)",
                      border: "1px solid rgba(255, 255, 255, 0.3)",
                      padding: "4px 10px",
                      borderRadius: "3px",
                      cursor: "pointer",
                      fontSize: "11px",
                    }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}
            {msg.confirmation && msg.confirmation.status === "executing" && (
              <div style={{ marginTop: "6px", fontSize: "11px", color: "#00f0ff" }}>
                EXECUTING ACTION…
              </div>
            )}
            {msg.confirmation && msg.confirmation.status === "confirmed" && (
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "11px",
                  color: "rgba(0, 255, 128, 0.9)",
                }}
              >
                ✓ ACTION CONFIRMED
              </div>
            )}
            {msg.confirmation && msg.confirmation.status === "cancelled" && (
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "11px",
                  color: "rgba(255, 100, 100, 0.9)",
                }}
              >
                ✕ ACTION CANCELLED
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="chat-msg chat-msg-gemini">
            <div className="chat-msg-meta">
              <span className="chat-msg-sender">ULTRON</span>
              <span className="chat-msg-time">TRANSMITTING…</span>
            </div>
            <div className="chat-msg-text chat-loading-dots">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error display */}
      {error && <div className="chat-error-bar">{error}</div>}

      {/* Voice listening indicator */}
      {isListening && (
        <div className="chat-listening-bar">
          <span className="chat-listening-dot" /> LISTENING... SPEAK NOW
        </div>
      )}

      {/* Input row */}
      <form className="chat-input-row" onSubmit={handleSendMessage}>
        <input
          ref={inputRef}
          type="text"
          className="chat-input"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder={isListening ? "Listening to voice..." : "Type message..."}
          disabled={isLoading}
        />

        {/* Document Upload Button & Hidden Input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          style={{ display: "none" }}
          onChange={handleFileUpload}
          disabled={isLoading || isUploadingDoc}
        />
        <button
          type="button"
          className="chat-btn chat-upload-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Upload document (.pdf, .docx, .txt, .md)"
          disabled={isLoading || isUploadingDoc}
          aria-label="Upload document"
          style={{
            background: "transparent",
            border: "1px solid rgba(0, 240, 255, 0.3)",
            color: isUploadingDoc ? "#ffb700" : "rgba(255, 255, 255, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: isLoading || isUploadingDoc ? "not-allowed" : "pointer",
            width: "36px",
            height: "36px",
            borderRadius: "4px",
            transition: "all 0.2s ease",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            width="15"
            height="15"
          >
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="12" y2="12" />
            <line x1="15" y1="15" x2="12" y2="12" />
          </svg>
        </button>

        {/* Microphone Button */}
        <button
          type="button"
          className={`chat-btn chat-mic-btn${isListening ? " listening" : ""}`}
          onClick={toggleListening}
          title={isListening ? "Stop listening" : "Start voice input"}
          aria-pressed={isListening}
          aria-label={isListening ? "Stop microphone" : "Start microphone"}
        >
          <svg
            className="chat-mic-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            width="16"
            height="16"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        </button>

        {/* Send Button */}
        <button
          type="submit"
          className="chat-btn chat-send-btn"
          disabled={isLoading || !inputMessage.trim()}
          aria-label="Send message"
        >
          SEND
        </button>
      </form>
    </div>
  );
}
