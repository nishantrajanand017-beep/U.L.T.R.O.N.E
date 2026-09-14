"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { splitTextForTTS } from "@/lib/ttsChunker";

export type VoiceState =
  | "IDLE"
  | "LISTENING"
  | "PROCESSING"
  | "THINKING"
  | "SPEAKING"
  | "ERROR";

// Module-level runtime concurrency and buffer instrumentation
let activeTtsRequests = 0;
let maxConcurrentTtsRequests = 0;
let bufferedAudioChunks = 0;
let maxBufferedAudioChunks = 0;
let lastAudioGapMs = 0;

export function getTtsConcurrencyStats() {
  return {
    activeTtsRequests,
    maxConcurrentTtsRequests,
    bufferedAudioChunks,
    maxBufferedAudioChunks,
    lastAudioGapMs,
  };
}

export function resetTtsConcurrencyStats() {
  activeTtsRequests = 0;
  maxConcurrentTtsRequests = 0;
  bufferedAudioChunks = 0;
  maxBufferedAudioChunks = 0;
  lastAudioGapMs = 0;
}

interface VoiceModeProps {
  onClose: () => void;
  onStateChange?: (state: VoiceState) => void;
  onAudioLevel?: (level: number) => void;
}

interface ConversationTurn {
  id: string;
  role: "user" | "model";
  text: string;
  time: string;
}

const SILENCE_THRESHOLD_MS = 1100; // Silence duration before concluding speech turn
const SPEECH_VOLUME_THRESHOLD = 0.032; // RMS amplitude threshold to detect user speech in LISTENING
const BARGE_IN_VOLUME_THRESHOLD = 0.18; // Strict RMS threshold to interrupt during active TTS (prevents speaker feedback)
const BARGE_IN_GRACE_PERIOD_MS = 1000; // Grace period before voice-based barge-in is armed
const MIN_SPEECH_DURATION_MS = 350; // Minimum speech duration to submit to STT

export const GREETING_TEXT = "Hello Sir, how may I assist you?";

export default function VoiceMode({ onClose, onStateChange, onAudioLevel }: VoiceModeProps) {
  const [state, setState] = useState<VoiceState>("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [history, setHistory] = useState<ConversationTurn[]>([
    {
      id: "greeting",
      role: "model",
      text: GREETING_TEXT,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const [latestUserText, setLatestUserText] = useState<string>("");
  const [latestUltronText, setLatestUltronText] = useState<string>(GREETING_TEXT);

  const stateRef = useRef<VoiceState>("IDLE");
  stateRef.current = state;

  const updateVoiceState = useCallback(
    (newState: VoiceState) => {
      setState(newState);
      stateRef.current = newState;
      onStateChange?.(newState);
    },
    [onStateChange]
  );

  const historyRef = useRef<ConversationTurn[]>([]);
  historyRef.current = history;

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Controlled single HTMLAudioElement & Session Tracking
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrlRef = useRef<string | null>(null);
  const bufferedAudioBlobRef = useRef<Blob | null>(null);
  const bufferedAudioUrlRef = useRef<string | null>(null);
  const activeTtsAbortControllerRef = useRef<AbortController | null>(null);
  const currentTurnIdRef = useRef<number>(0);
  const hasGreetedRef = useRef<boolean>(false);
  const lastSpeechEndTimeRef = useRef<number>(0);

  // Diagnostic latency measurement refs
  const t0_ref = useRef<number>(0);
  const t1_ref = useRef<number>(0);
  const t2_ref = useRef<number>(0);
  const t3_ref = useRef<number>(0);
  const t4_ref = useRef<number>(0);
  const t_speaking_ref = useRef<number>(0);
  const t5_ref = useRef<number>(0);
  const t6_ref = useRef<number>(0);
  const t7_ref = useRef<number>(0);
  const t8_ref = useRef<number>(0);
  const hasRecordedFirstAudioPlayRef = useRef<boolean>(false);
  const hasRecordedFirstAudibleRef = useRef<boolean>(false);

  const isSpeakingRef = useRef<boolean>(false);
  const speechStartTimeRef = useRef<number>(0);
  const lastSpeechTimeRef = useRef<number>(0);
  const speakingStartTimeRef = useRef<number>(0);
  const interruptionCounterRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);

  // Transcript container & auto-scroll references
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef<boolean>(true);

  const handleScroll = useCallback(() => {
    const el = transcriptContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceToBottom < 60;
  }, []);

  const scrollToBottom = useCallback((force: boolean = false) => {
    if (force || isNearBottomRef.current) {
      transcriptBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    const lastTurn = history[history.length - 1];
    const isNewUserTurn = lastTurn?.role === "user";
    scrollToBottom(isNewUserTurn || state === "THINKING");
  }, [history, state, scrollToBottom]);

  useEffect(() => {
    scrollToBottom(true);
  }, [scrollToBottom]);

  // Stop active TTS audio cleanly and abort any in-flight synthesis fetch
  const stopTTSAudio = useCallback((reason: string = "manual") => {
    console.log(`[ULTRON TTS] stopTTSAudio called (reason: ${reason})`);

    // Abort active in-flight TTS fetch immediately if running
    if (activeTtsAbortControllerRef.current) {
      try {
        activeTtsAbortControllerRef.current.abort();
      } catch {
        // ignore
      }
      activeTtsAbortControllerRef.current = null;
    }

    const audio = audioElementRef.current;
    if (audio) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (e) {
        console.warn("[ULTRON TTS] Error pausing audio element:", e);
      }
    }

    if (activeAudioUrlRef.current) {
      try {
        URL.revokeObjectURL(activeAudioUrlRef.current);
      } catch (e) {
        console.warn("[ULTRON TTS] Error revoking audio object URL:", e);
      }
      activeAudioUrlRef.current = null;
    }

    // Clear single-item prefetch buffer
    if (bufferedAudioUrlRef.current) {
      try {
        URL.revokeObjectURL(bufferedAudioUrlRef.current);
      } catch (e) {
        console.warn("[ULTRON TTS] Error revoking buffered audio object URL:", e);
      }
      bufferedAudioUrlRef.current = null;
    }
    bufferedAudioBlobRef.current = null;
    bufferedAudioChunks = 0;
  }, []);

  // Complete cleanup function on component unmount
  const cleanupAllResources = useCallback(() => {
    console.log("[ULTRON TTS] Cleaning up all VoiceMode resources");
    stopTTSAudio("cleanupAllResources");

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    recordedChunksRef.current = [];
    isSpeakingRef.current = false;
  }, [stopTTSAudio]);

  // Forward declarations for conversation pipeline
  const processTurnPipeline = useRef<((audioBlob: Blob, explicitT0?: number) => Promise<void>) | null>(null);

  // Start continuous recording session (LISTENING)
  const startRecordingSession = useCallback(() => {
    if (!streamRef.current || !isMountedRef.current) return;

    try {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        return;
      }

      recordedChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : MediaRecorder.isTypeSupported("audio/mp4")
            ? "audio/mp4"
            : "";

      const recorder = mimeType
        ? new MediaRecorder(streamRef.current, { mimeType })
        : new MediaRecorder(streamRef.current);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        if (!isMountedRef.current) return;

        const totalBlob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        recordedChunksRef.current = [];

        console.log(
          `[VoiceMode] Recorded audio captured: size=${totalBlob.size} bytes, type=${totalBlob.type}`
        );

        const speechEndTimestamp = lastSpeechEndTimeRef.current || performance.now();
        lastSpeechEndTimeRef.current = 0;

        if (totalBlob.size >= 1200 && processTurnPipeline.current) {
          processTurnPipeline.current(totalBlob, speechEndTimestamp);
        } else {
          // Audio too small or empty -> automatically resume listening
          if (
            stateRef.current === "PROCESSING" ||
            stateRef.current === "THINKING" ||
            stateRef.current === "LISTENING"
          ) {
            updateVoiceState("LISTENING");
            startRecordingSession();
          }
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      isSpeakingRef.current = false;
      interruptionCounterRef.current = 0;
    } catch (err) {
      console.error("Failed to start MediaRecorder:", err);
      setError("COULD NOT INITIALIZE AUDIO RECORDER");
      updateVoiceState("ERROR");
    }
  }, [updateVoiceState]);

  // Reusable Text -> Qwen -> Chunks -> Sequential Kokoro TTS Pipeline
  const processTextTurn = useCallback(async (userTranscript: string, diagTimestamps?: { t0?: number; t1?: number; t2?: number }) => {
    if (!isMountedRef.current) return;

    const turnId = ++currentTurnIdRef.current;
    console.log(`[ULTRON TTS] Starting pipeline turn #${turnId} for transcript: "${userTranscript}"`);
    stopTTSAudio("new-turn-start");

    const t0 = diagTimestamps?.t0 ?? performance.now();
    const t1 = diagTimestamps?.t1 ?? t0;
    const t2 = diagTimestamps?.t2 ?? t0;
    t0_ref.current = t0;
    t1_ref.current = t1;
    t2_ref.current = t2;
    hasRecordedFirstAudioPlayRef.current = false;
    hasRecordedFirstAudibleRef.current = false;

    try {
      setError(null);
      setLatestUserText(userTranscript);

      const userTurn: ConversationTurn = {
        id: Date.now().toString(),
        role: "user",
        text: userTranscript,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      const updatedHistory = [...historyRef.current, userTurn];
      setHistory(updatedHistory);

      // 2. Qwen Thinking Phase (THINKING)
      updateVoiceState("THINKING");

      const t3 = performance.now();
      t3_ref.current = t3;
      console.log(`[LATENCY] T3 (/api/chat fetch start): ${t3.toFixed(2)}ms (delta T3-T2: ${(t3 - t2).toFixed(2)}ms)`);

      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userTranscript,
          history: updatedHistory.map((h) => ({ role: h.role, text: h.text })),
          voiceMode: true,
        }),
      });

      const t4 = performance.now();
      t4_ref.current = t4;
      console.log(`[LATENCY] T4 (Qwen response received): ${t4.toFixed(2)}ms (Qwen net: ${(t4 - t3).toFixed(2)}ms, elapsed T4-T0: ${(t4 - t0).toFixed(2)}ms)`);

      if (!chatRes.ok) {
        const chatErr = await chatRes.json().catch(() => ({}));
        throw new Error(chatErr.error || `AI Core error (${chatRes.status})`);
      }

      const chatData = await chatRes.json();
      const ultronReply = (chatData.text || chatData.reply || "").trim();

      if (!ultronReply) {
        throw new Error("No response generated by ULTRON AI Core.");
      }

      console.log(`[VoiceMode] [Turn #${turnId}] ULTRON reply: "${ultronReply}"`);
      setLatestUltronText(ultronReply);

      const ultronTurn: ConversationTurn = {
        id: (Date.now() + 1).toString(),
        role: "model",
        text: ultronReply,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setHistory([...updatedHistory, ultronTurn]);

      // Check if turn was superseded
      if (turnId !== currentTurnIdRef.current || !isMountedRef.current) {
        console.log(`[ULTRON TTS] [Turn #${turnId}] Superseded before TTS, cancelling.`);
        return;
      }

      // 3. TTS Request & One-Chunk-Ahead Prefetching / Sequential Playback Phase
      const chunks = splitTextForTTS(ultronReply);
      console.log(
        `[ULTRON TTS] [Turn #${turnId}] Split response (${ultronReply.length} chars) into ${chunks.length} chunks`
      );

      if (chunks.length === 0) {
        if (turnId === currentTurnIdRef.current && isMountedRef.current) {
          updateVoiceState("LISTENING");
          startRecordingSession();
        }
        return;
      }

      const t_speaking = performance.now();
      t_speaking_ref.current = t_speaking;
      console.log(`[LATENCY] State change to SPEAKING at ${t_speaking.toFixed(2)}ms (delta from T4: ${(t_speaking - t4).toFixed(2)}ms, BEFORE audio ready: true)`);
      updateVoiceState("SPEAKING");
      speakingStartTimeRef.current = Date.now();
      interruptionCounterRef.current = 0;

      let turnMaxConcurrent = 0;
      let turnMaxBuffered = 0;

      // Helper function to synthesize a single chunk with strict concurrency tracking
      const fetchChunkTTS = async (
        chunkText: string,
        chunkIndex: number,
        totalChunks: number
      ): Promise<Blob | null> => {
        if (turnId !== currentTurnIdRef.current || !isMountedRef.current) return null;

        if (chunkIndex === 0) {
          const t5 = performance.now();
          t5_ref.current = t5;
          console.log(
            `[LATENCY] T5 (first /api/voice/tts request starts): ${t5.toFixed(2)}ms (delta T5-T4: ${(t5 - (t4_ref.current || 0)).toFixed(2)}ms)`
          );
        }

        const t0_chunk = Date.now();
        const chunkAbortController = new AbortController();
        activeTtsAbortControllerRef.current = chunkAbortController;

        activeTtsRequests++;
        maxConcurrentTtsRequests = Math.max(maxConcurrentTtsRequests, activeTtsRequests);
        turnMaxConcurrent = Math.max(turnMaxConcurrent, activeTtsRequests);

        console.log(
          `[TTS] START turn=${turnId} chunk=${chunkIndex + 1}/${totalChunks} chars=${chunkText.length} active=${activeTtsRequests}`
        );

        let ttsRes: Response;
        try {
          ttsRes = await fetch("/api/voice/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: chunkText }),
            signal: chunkAbortController.signal,
          });
        } catch (fetchErr: unknown) {
          activeTtsRequests--;
          const chunkLatency = Date.now() - t0_chunk;
          const isAbort = (fetchErr as Error)?.name === "AbortError";
          console.log(
            `[TTS] END turn=${turnId} chunk=${chunkIndex + 1}/${totalChunks} chars=${chunkText.length} latency=${chunkLatency}ms active=${activeTtsRequests}${isAbort ? " (ABORTED)" : ""}`
          );
          activeTtsAbortControllerRef.current = null;

          if (isAbort || turnId !== currentTurnIdRef.current || !isMountedRef.current) {
            console.log(`[ULTRON TTS] [Turn #${turnId}] Chunk ${chunkIndex + 1} fetch aborted or superseded.`);
            return null;
          }
          throw fetchErr;
        }

        const chunkLatency = Date.now() - t0_chunk;
        activeTtsRequests--;
        activeTtsAbortControllerRef.current = null;

        console.log(
          `[TTS] END turn=${turnId} chunk=${chunkIndex + 1}/${totalChunks} chars=${chunkText.length} latency=${chunkLatency}ms active=${activeTtsRequests}`
        );

        if (!ttsRes.ok) {
          const ttsErr = await ttsRes.json().catch(() => ({}));
          const errMsg = ttsErr.error || `TTS service error (${ttsRes.status})`;

          if (errMsg.includes("timed out") || ttsRes.status === 504) {
            console.error(
              `[TTS] TIMEOUT turn=${turnId} chunk=${chunkIndex + 1}/${totalChunks} chars=${chunkText.length} elapsed=${chunkLatency}ms maxConcurrent=${turnMaxConcurrent}`
            );
            throw new Error("TTS service timed out.");
          }
          throw new Error(errMsg);
        }

        const audioBlobResult = await ttsRes.blob();
        console.log(
          `[ULTRON TTS] [Turn #${turnId}] Chunk ${chunkIndex + 1}/${totalChunks} audio blob size: ${audioBlobResult.size} bytes`
        );

        if (chunkIndex === 0) {
          const t6 = performance.now();
          t6_ref.current = t6;
          console.log(
            `[LATENCY] T6 (first TTS response received): ${t6.toFixed(2)}ms (first TTS net: ${(t6 - (t5_ref.current || 0)).toFixed(2)}ms, elapsed T6-T0: ${(t6 - (t0_ref.current || 0)).toFixed(2)}ms)`
          );
        }

        if (audioBlobResult.size === 0) {
          return null;
        }

        if (turnId !== currentTurnIdRef.current || !isMountedRef.current) {
          return null;
        }

        return audioBlobResult;
      };

      // Play audio chunk helper with gap timing measurement
      let previousAudioEndedAt: number | null = null;

      const playAudioChunk = async (
        audioBlob: Blob,
        chunkIndex: number
      ): Promise<void> => {
        if (turnId !== currentTurnIdRef.current || !isMountedRef.current) return;

        const nextAudioStartedAt = performance.now();
        if (chunkIndex === 0 && !hasRecordedFirstAudioPlayRef.current) {
          hasRecordedFirstAudioPlayRef.current = true;
          const t7 = nextAudioStartedAt;
          t7_ref.current = t7;
          console.log(
            `[LATENCY] T7 (browser audio.play called): ${t7.toFixed(2)}ms (delta T7-T6: ${(t7 - (t6_ref.current || 0)).toFixed(2)}ms, elapsed T7-T0: ${(t7 - (t0_ref.current || 0)).toFixed(2)}ms)`
          );
        }

        if (previousAudioEndedAt !== null) {
          const gapMs = Math.max(0, nextAudioStartedAt - previousAudioEndedAt);
          lastAudioGapMs = gapMs;
          console.log(
            `[TTS] GAP turn=${turnId} from=${chunkIndex} to=${chunkIndex + 1} gapMs=${Math.round(gapMs)}`
          );
        }

        const audioUrl = URL.createObjectURL(audioBlob);

        if (activeAudioUrlRef.current) {
          try {
            URL.revokeObjectURL(activeAudioUrlRef.current);
          } catch {
            // ignore
          }
          activeAudioUrlRef.current = null;
        }
        activeAudioUrlRef.current = audioUrl;

        await new Promise<void>((resolve) => {
          const audio = audioElementRef.current;
          if (!audio || turnId !== currentTurnIdRef.current || !isMountedRef.current) {
            resolve();
            return;
          }

          audio.src = audioUrl;

          const onEndedOrError = () => {
            audio.removeEventListener("ended", onEndedOrError);
            audio.removeEventListener("error", onEndedOrError);
            audio.removeEventListener("playing", onPlaying);
            previousAudioEndedAt = performance.now();
            resolve();
          };

          const onPlaying = () => {
            if (chunkIndex === 0 && !hasRecordedFirstAudibleRef.current) {
              hasRecordedFirstAudibleRef.current = true;
              const t8 = performance.now();
              t8_ref.current = t8;
              console.log(
                `[LATENCY] T8 (first audible sound / playing event): ${t8.toFixed(2)}ms (startup delay T8-T7: ${(t8 - (t7_ref.current || 0)).toFixed(2)}ms, elapsed T8-T0: ${(t8 - (t0_ref.current || 0)).toFixed(2)}ms)`
              );

              const t0 = t0_ref.current;
              const t1 = t1_ref.current;
              const t2 = t2_ref.current;
              const t3 = t3_ref.current;
              const t4 = t4_ref.current;
              const t5 = t5_ref.current;
              const t6 = t6_ref.current;
              const t7 = t7_ref.current;
              const t_spk = t_speaking_ref.current;

              const latencySummary = {
                t0,
                t1,
                t2,
                t3,
                t4,
                t5,
                t6,
                t7,
                t8,
                t_speaking: t_spk,
                whisper_latency: t2 - t0,
                whisper_net: t2 - t1,
                dispatch_to_stt: t1 - t0,
                qwen_latency: t4 - t2,
                qwen_net: t4 - t3,
                first_tts_latency: t6 - t4,
                first_tts_net: t6 - t5,
                browser_audio_startup: t7 - t6,
                audible_startup: t8 - t7,
                total_to_first_audio: t7 - t0,
                total_to_audible: t8 - t0,
                speaking_set_before_audio: t_spk < t7,
                speaking_to_audio_wait: t7 - t_spk,
                chunks_count: chunks.length,
                ultron_reply_length: ultronReply.length,
                ultron_reply: ultronReply,
              };

              (window as unknown as { __ultronLatestLatency?: typeof latencySummary }).__ultronLatestLatency = latencySummary;
              console.log("[LATENCY SUMMARY]", JSON.stringify(latencySummary, null, 2));
            }
          };

          audio.addEventListener("ended", onEndedOrError);
          audio.addEventListener("error", onEndedOrError);
          audio.addEventListener("playing", onPlaying);

          audio.play().catch((playErr) => {
            console.warn(`[ULTRON TTS] Audio element playback note for chunk ${chunkIndex + 1}:`, playErr);
            onEndedOrError();
          });
        });
      };

      // 1. Synthesize chunk 1 first
      const firstBlob = await fetchChunkTTS(chunks[0], 0, chunks.length);
      if (!firstBlob || turnId !== currentTurnIdRef.current || !isMountedRef.current) {
        return;
      }

      let currentBlob: Blob = firstBlob;

      // 2. Playback and one-chunk-ahead producer/consumer loop
      for (let i = 0; i < chunks.length; i++) {
        if (turnId !== currentTurnIdRef.current || !isMountedRef.current) return;

        // Start playback of chunk i immediately
        const playPromise = playAudioChunk(currentBlob, i);

        // While chunk i is playing, start synthesizing chunk i + 1 (if available)
        let prefetchPromise: Promise<Blob | null> | null = null;
        if (i + 1 < chunks.length) {
          prefetchPromise = fetchChunkTTS(chunks[i + 1], i + 1, chunks.length).then((blob) => {
            if (blob && turnId === currentTurnIdRef.current && isMountedRef.current) {
              bufferedAudioBlobRef.current = blob;
              bufferedAudioChunks = 1;
              maxBufferedAudioChunks = Math.max(maxBufferedAudioChunks, 1);
              turnMaxBuffered = Math.max(turnMaxBuffered, 1);
            }
            return blob;
          });
        }

        // Wait for current chunk i playback to complete
        await playPromise;

        // Verify turn is still current after playback finishes
        if (turnId !== currentTurnIdRef.current || !isMountedRef.current) {
          console.log(
            `[ULTRON TTS] [Turn #${turnId}] Turn superseded/interrupted after chunk ${i + 1}/${chunks.length}. Halting.`
          );
          return;
        }

        // Consume buffered chunk i + 1 for next iteration
        if (prefetchPromise) {
          const nextBlob = await prefetchPromise;

          bufferedAudioBlobRef.current = null;
          bufferedAudioChunks = 0;

          if (!nextBlob || turnId !== currentTurnIdRef.current || !isMountedRef.current) {
            console.log(
              `[ULTRON TTS] [Turn #${turnId}] Prefetched chunk ${i + 2} missing or superseded. Halting.`
            );
            return;
          }

          currentBlob = nextBlob;
        }
      }

      console.log(
        `[TTS] TURN COMPLETE turn=${turnId} maxConcurrent=${turnMaxConcurrent} maxBuffered=${turnMaxBuffered}`
      );

      // All chunks finished naturally
      if (turnId === currentTurnIdRef.current && isMountedRef.current) {
        console.log(`[ULTRON TTS] [Turn #${turnId}] All ${chunks.length} chunks played. Returning to LISTENING.`);
        stopTTSAudio("all-chunks-ended");
        updateVoiceState("LISTENING");
        startRecordingSession();
      }
    } catch (err: unknown) {
      console.error(`[ULTRON TTS] [Turn #${turnId}] Pipeline error:`, err);
      const msg = err instanceof Error ? err.message : "Voice transaction failed.";
      setError(msg);
      updateVoiceState("ERROR");
      onAudioLevel?.(0);

      stopTTSAudio("pipeline-error");

      // Return to listening after displaying error cleanly
      setTimeout(() => {
        if (isMountedRef.current && turnId === currentTurnIdRef.current) {
          setError(null);
          updateVoiceState("LISTENING");
          startRecordingSession();
        }
      }, 3500);
    }
  }, [onAudioLevel, startRecordingSession, stopTTSAudio, updateVoiceState]);

  // Fixed local greeting synthesized via Kokoro (voice=am_adam, speed=1.0)
  const playGreeting = useCallback(async () => {
    if (!isMountedRef.current || hasGreetedRef.current) return;
    hasGreetedRef.current = true;

    const turnId = ++currentTurnIdRef.current;
    console.log(`[ULTRON TTS] Starting greeting turn #${turnId}: "${GREETING_TEXT}"`);

    try {
      updateVoiceState("SPEAKING");
      speakingStartTimeRef.current = Date.now();
      interruptionCounterRef.current = 0;

      const chunkAbortController = new AbortController();
      activeTtsAbortControllerRef.current = chunkAbortController;

      activeTtsRequests++;
      maxConcurrentTtsRequests = Math.max(maxConcurrentTtsRequests, activeTtsRequests);

      console.log(
        `[TTS] START turn=${turnId} chunk=1/1 chars=${GREETING_TEXT.length} active=${activeTtsRequests}`
      );

      const t0 = Date.now();
      let ttsRes: Response;
      try {
        ttsRes = await fetch("/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: GREETING_TEXT,
            voice: "am_adam",
            speed: 1.0,
          }),
          signal: chunkAbortController.signal,
        });
      } catch (fetchErr: unknown) {
        activeTtsRequests--;
        const latency = Date.now() - t0;
        const isAbort = (fetchErr as Error)?.name === "AbortError";
        console.log(
          `[TTS] END turn=${turnId} chunk=1/1 chars=${GREETING_TEXT.length} latency=${latency}ms active=${activeTtsRequests}${isAbort ? " (ABORTED)" : ""}`
        );
        activeTtsAbortControllerRef.current = null;

        if (isAbort || turnId !== currentTurnIdRef.current || !isMountedRef.current) {
          console.log(`[ULTRON TTS] Greeting turn #${turnId} fetch aborted or superseded.`);
          return;
        }
        throw fetchErr;
      }

      const latency = Date.now() - t0;
      activeTtsRequests--;
      activeTtsAbortControllerRef.current = null;

      console.log(
        `[TTS] END turn=${turnId} chunk=1/1 chars=${GREETING_TEXT.length} latency=${latency}ms active=${activeTtsRequests}`
      );

      if (!ttsRes.ok) {
        const ttsErr = await ttsRes.json().catch(() => ({}));
        throw new Error(ttsErr.error || `TTS service error (${ttsRes.status})`);
      }

      const audioBlobResult = await ttsRes.blob();
      if (audioBlobResult.size === 0 || turnId !== currentTurnIdRef.current || !isMountedRef.current) {
        return;
      }

      const audioUrl = URL.createObjectURL(audioBlobResult);
      if (activeAudioUrlRef.current) {
        try {
          URL.revokeObjectURL(activeAudioUrlRef.current);
        } catch {
          // ignore
        }
        activeAudioUrlRef.current = null;
      }
      activeAudioUrlRef.current = audioUrl;

      await new Promise<void>((resolve) => {
        const audio = audioElementRef.current;
        if (!audio || turnId !== currentTurnIdRef.current || !isMountedRef.current) {
          resolve();
          return;
        }

        audio.src = audioUrl;

        const onEndedOrError = () => {
          audio.removeEventListener("ended", onEndedOrError);
          audio.removeEventListener("error", onEndedOrError);
          resolve();
        };

        audio.addEventListener("ended", onEndedOrError);
        audio.addEventListener("error", onEndedOrError);

        audio.play().catch((playErr) => {
          console.warn("[ULTRON TTS] Greeting audio playback note:", playErr);
          onEndedOrError();
        });
      });

      console.log(
        `[TTS] TURN COMPLETE turn=${turnId} maxConcurrent=1 maxBuffered=0`
      );

      if (turnId === currentTurnIdRef.current && isMountedRef.current) {
        console.log("[ULTRON TTS] Greeting completed naturally. Transitioning to LISTENING.");
        stopTTSAudio("greeting-ended");
        updateVoiceState("LISTENING");
        startRecordingSession();
      }
    } catch (err: unknown) {
      console.error("[ULTRON TTS] Greeting error:", err);
      if (turnId === currentTurnIdRef.current && isMountedRef.current) {
        stopTTSAudio("greeting-error");
        updateVoiceState("LISTENING");
        startRecordingSession();
      }
    }
  }, [startRecordingSession, stopTTSAudio, updateVoiceState]);

  // Robust Conversation Pipeline: STT -> processTextTurn
  processTurnPipeline.current = async (audioBlob: Blob, explicitT0?: number) => {
    if (!isMountedRef.current) return;

    try {
      setError(null);
      const t0 = explicitT0 ?? performance.now();
      const t1 = performance.now();
      console.log(`[LATENCY] T0 (speech ended / record stop): ${t0.toFixed(2)}ms`);
      console.log(`[LATENCY] T1 (Whisper STT request start): ${t1.toFixed(2)}ms (recording-to-STT lag T1-T0: ${(t1 - t0).toFixed(2)}ms)`);

      const ext = audioBlob.type.includes("mp4") ? "mp4" : audioBlob.type.includes("wav") ? "wav" : "webm";
      const audioFile = new File([audioBlob], `speech.${ext}`, {
        type: audioBlob.type || "audio/webm",
      });

      const formData = new FormData();
      formData.append("file", audioFile);

      const sttRes = await fetch("/api/voice/stt", {
        method: "POST",
        body: formData,
      });

      const t2 = performance.now();
      console.log(`[LATENCY] T2 (Whisper STT response received): ${t2.toFixed(2)}ms (Whisper net: ${(t2 - t1).toFixed(2)}ms, elapsed T2-T0: ${(t2 - t0).toFixed(2)}ms)`);

      if (!sttRes.ok) {
        const sttErr = await sttRes.json().catch(() => ({}));
        throw new Error(sttErr.error || `STT HTTP error ${sttRes.status}`);
      }

      const sttData = await sttRes.json();
      const userTranscript = (sttData.text || "").trim();

      if (!userTranscript) {
        console.log(`[VoiceMode] Empty transcript, returning to LISTENING.`);
        updateVoiceState("LISTENING");
        startRecordingSession();
        return;
      }

      await processTextTurn(userTranscript, { t0, t1, t2 });
    } catch (err: unknown) {
      console.error("[VoiceMode] Pipeline error:", err);
      const msg = err instanceof Error ? err.message : "Voice transaction failed.";
      setError(msg);
      updateVoiceState("ERROR");
      onAudioLevel?.(0);

      stopTTSAudio("pipeline-error");

      setTimeout(() => {
        if (isMountedRef.current) {
          setError(null);
          updateVoiceState("LISTENING");
          startRecordingSession();
        }
      }, 3500);
    }
  };

  // VAD Loop: Monitors microphone amplitude & manages speech boundary detection
  const runVADLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !isMountedRef.current) return;

    const dataArray = new Uint8Array(analyser.fftSize);

    const checkAudio = () => {
      if (!isMountedRef.current || !analyserRef.current) return;

      analyserRef.current.getByteTimeDomainData(dataArray);

      // Compute RMS volume
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      const now = Date.now();
      let effectiveLevel = rms;

      if (stateRef.current === "SPEAKING") {
        // Speech modulation waveform during TTS playback for lively visual reactivity
        const speechPulse =
          0.38 +
          Math.sin(now * 0.014) * 0.22 +
          Math.cos(now * 0.029) * 0.14 +
          (Math.sin(now * 0.045) > 0.6 ? 0.15 : 0);
        effectiveLevel = Math.max(rms, Math.min(1.0, speechPulse));
      } else if (stateRef.current === "THINKING" || stateRef.current === "ERROR") {
        effectiveLevel = 0;
      }

      setAudioLevel(effectiveLevel);
      onAudioLevel?.(effectiveLevel);

      // Handle Barge-in / Interruption while ULTRON is speaking
      if (stateRef.current === "SPEAKING") {
        const timeSinceSpeakingStart = now - speakingStartTimeRef.current;

        // Barge-in guard: require grace period and high sustained volume to prevent speaker echo feedback
        if (
          timeSinceSpeakingStart > BARGE_IN_GRACE_PERIOD_MS &&
          rms > BARGE_IN_VOLUME_THRESHOLD
        ) {
          interruptionCounterRef.current++;
          if (interruptionCounterRef.current >= 12) {
            console.log("[ULTRON TTS] User voice interruption detected! Stopping TTS.");
            currentTurnIdRef.current++; // Invalidate current turn
            stopTTSAudio("voice-barge-in");
            updateVoiceState("LISTENING");
            startRecordingSession();
            isSpeakingRef.current = true;
            speechStartTimeRef.current = now;
            lastSpeechTimeRef.current = now;
            interruptionCounterRef.current = 0;
          }
        } else {
          interruptionCounterRef.current = Math.max(
            0,
            interruptionCounterRef.current - 1
          );
        }
      }

      // Handle user speech detection while in LISTENING state
      if (stateRef.current === "LISTENING") {
        const isAudible = rms > SPEECH_VOLUME_THRESHOLD;

        if (isAudible) {
          if (!isSpeakingRef.current) {
            isSpeakingRef.current = true;
            speechStartTimeRef.current = now;
          }
          lastSpeechTimeRef.current = now;
        } else if (isSpeakingRef.current) {
          // Check silence duration after speech
          const silenceDuration = now - lastSpeechTimeRef.current;
          const speechDuration = lastSpeechTimeRef.current - speechStartTimeRef.current;

          if (
            silenceDuration >= SILENCE_THRESHOLD_MS &&
            speechDuration >= MIN_SPEECH_DURATION_MS
          ) {
            // User finished speaking turn
            console.log(
              `[VoiceMode] End of speech detected. Duration: ${speechDuration}ms, Silence: ${silenceDuration}ms`
            );
            isSpeakingRef.current = false;
            lastSpeechEndTimeRef.current = performance.now() - silenceDuration;
            if (
              mediaRecorderRef.current &&
              mediaRecorderRef.current.state === "recording"
            ) {
              try {
                mediaRecorderRef.current.stop();
              } catch (e) {
                console.error("Error stopping recorder:", e);
              }
            }
          }
        }
      }

      animationFrameRef.current = requestAnimationFrame(checkAudio);
    };

    animationFrameRef.current = requestAnimationFrame(checkAudio);
  }, [onAudioLevel, startRecordingSession, stopTTSAudio, updateVoiceState]);

  // Initialize Microphone, AudioContext & Unlock Autoplay on Mount
  useEffect(() => {
    isMountedRef.current = true;

    async function initVoice() {
      try {
        updateVoiceState("IDLE");
        setError(null);

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        if (!isMountedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        const AudioCtxClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new AudioCtxClass();
        audioContextRef.current = audioCtx;

        if (audioCtx.state === "suspended") {
          await audioCtx.resume();
        }

        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);
        analyserRef.current = analyser;

        // Pre-create and unlock audio element attached to user gesture
        if (audioElementRef.current) {
          audioElementRef.current.volume = 1.0;
          audioElementRef.current.muted = false;
        }

        runVADLoop();

        // Trigger greeting once on mount, then automatically enter LISTENING
        if (!hasGreetedRef.current) {
          void playGreeting();
        } else {
          updateVoiceState("LISTENING");
          startRecordingSession();
        }
      } catch (err: unknown) {
        console.error("Microphone initialization error:", err);
        const isDenied =
          err instanceof DOMException && err.name === "NotAllowedError";
        setError(
          isDenied
            ? "MICROPHONE ACCESS DENIED"
            : "FAILED TO INITIALIZE MICROPHONE"
        );
        updateVoiceState("ERROR");
      }
    }

    void initVoice();

    return () => {
      isMountedRef.current = false;
      hasGreetedRef.current = false;
      cleanupAllResources();
      onStateChange?.("IDLE");
      onAudioLevel?.(0);
    };
  }, [cleanupAllResources, onAudioLevel, onStateChange, playGreeting, runVADLoop, startRecordingSession, updateVoiceState]);

  // Handle manual interrupt button
  const handleManualInterrupt = () => {
    if (state === "SPEAKING") {
      console.log("[ULTRON TTS] Manual interrupt button clicked");
      currentTurnIdRef.current++;
      stopTTSAudio("manual-button-interrupt");
      updateVoiceState("LISTENING");
      startRecordingSession();
    }
  };

  // Expose test automation hooks on window during development / automated testing
  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as unknown as { __ultronVoiceTurn?: (text: string) => Promise<void> }).__ultronVoiceTurn = processTextTurn;
      (window as unknown as { __ultronPlayGreeting?: () => Promise<void> }).__ultronPlayGreeting = playGreeting;
      (window as unknown as { __ultronSubmitAudioBlob?: (blob: Blob, t0?: number) => Promise<void> }).__ultronSubmitAudioBlob = (blob: Blob, t0?: number) => {
        if (processTurnPipeline.current) {
          return processTurnPipeline.current(blob, t0 ?? performance.now());
        }
        return Promise.resolve();
      };
      (window as unknown as { __ultronGetLatestLatency?: () => unknown }).__ultronGetLatestLatency = () =>
        (window as unknown as { __ultronLatestLatency?: unknown }).__ultronLatestLatency;
      (window as unknown as { __ultronInterrupt?: () => void }).__ultronInterrupt = () => {
        console.log("[ULTRON TTS] Programmatic interrupt invoked");
        currentTurnIdRef.current++;
        stopTTSAudio("programmatic-interrupt");
        updateVoiceState("LISTENING");
        startRecordingSession();
      };
      (window as unknown as { __ultronGetTtsStats?: () => { activeTtsRequests: number; maxConcurrentTtsRequests: number } }).__ultronGetTtsStats = getTtsConcurrencyStats;
      (window as unknown as { __ultronResetTtsStats?: () => void }).__ultronResetTtsStats = resetTtsConcurrencyStats;
    }
    return () => {
      if (typeof window !== "undefined") {
        delete (window as unknown as { __ultronVoiceTurn?: unknown }).__ultronVoiceTurn;
        delete (window as unknown as { __ultronPlayGreeting?: unknown }).__ultronPlayGreeting;
        delete (window as unknown as { __ultronSubmitAudioBlob?: unknown }).__ultronSubmitAudioBlob;
        delete (window as unknown as { __ultronGetLatestLatency?: unknown }).__ultronGetLatestLatency;
        delete (window as unknown as { __ultronInterrupt?: unknown }).__ultronInterrupt;
        delete (window as unknown as { __ultronGetTtsStats?: unknown }).__ultronGetTtsStats;
        delete (window as unknown as { __ultronResetTtsStats?: unknown }).__ultronResetTtsStats;
      }
    };
  }, [playGreeting, processTextTurn, startRecordingSession, stopTTSAudio, updateVoiceState]);

  // State badge styling and label
  const getStateMeta = () => {
    switch (state) {
      case "LISTENING":
        return { label: "LISTENING // SPEAK NOW", class: "voice-listening" };
      case "PROCESSING":
        return { label: "PROCESSING SPEECH…", class: "voice-processing" };
      case "THINKING":
        return { label: "ULTRON THINKING…", class: "voice-thinking" };
      case "SPEAKING":
        return { label: "ULTRON SPEAKING", class: "voice-speaking" };
      case "ERROR":
        return { label: "SYSTEM ERROR", class: "voice-error" };
      default:
        return { label: "STANDBY", class: "voice-idle" };
    }
  };

  const stateMeta = getStateMeta();

  return (
    <div className="voice-panel" role="dialog" aria-label="ULTRON Real-Time Voice Mode">
      {/* Hidden audio element for browser-managed audio playback */}
      <audio
        ref={audioElementRef}
        playsInline
        preload="auto"
        style={{ display: "none" }}
      />

      {/* Header */}
      <div className="voice-header">
        <div className="voice-header-left">
          <span className={`voice-status-dot ${stateMeta.class}`} />
          <span className="voice-title">CONVERSATION // VOICE LINK</span>
        </div>
        <button
          type="button"
          className="voice-close-btn"
          onClick={onClose}
          aria-label="Exit Voice Mode"
          title="Exit Voice Mode (Esc)"
        >
          ✕
        </button>
      </div>

      {/* State Badge & Audio Waveform Visualizer */}
      <div className="voice-visualizer-container">
        <div className={`voice-state-badge ${stateMeta.class}`}>
          {stateMeta.label}
        </div>

        {/* Dynamic Waveform Bars */}
        <div className="voice-waveform" aria-hidden="true">
          {[0.6, 1.2, 0.8, 1.6, 1.0, 1.8, 1.4, 0.9, 1.5, 0.7].map((scale, i) => {
            const heightMultiplier =
              state === "SPEAKING"
                ? 18 + Math.sin(Date.now() / 150 + i) * 14
                : state === "LISTENING"
                  ? Math.min(36, 4 + audioLevel * 140 * scale)
                  : state === "THINKING" || state === "PROCESSING"
                    ? 8 + Math.sin(Date.now() / 200 + i) * 6
                    : 4;

            return (
              <span
                key={i}
                className={`voice-wave-bar ${stateMeta.class}`}
                style={{ height: `${Math.max(4, heightMultiplier)}px` }}
              />
            );
          })}
        </div>
      </div>

      {/* Live Transcript Display - Chronological (Oldest -> Newest) */}
      <div
        ref={transcriptContainerRef}
        className="voice-transcript-area"
        onScroll={handleScroll}
      >
        {history.length === 0 && !latestUserText && state !== "ERROR" && (
          <div className="voice-placeholder">
            Speak naturally. ULTRON is listening continuously.
          </div>
        )}

        {history.map((turn) => (
          <div
            key={turn.id}
            className={`voice-card ${turn.role === "user" ? "voice-card-user" : "voice-card-ultron"}`}
          >
            <span className="voice-card-sender">
              {turn.role === "user" ? "YOU:" : "ULTRON:"}
            </span>
            <span className="voice-card-text">{turn.text}</span>
          </div>
        ))}

        {state === "THINKING" && (
          <div className="voice-card voice-card-ultron" style={{ opacity: 0.8 }}>
            <span className="voice-card-sender">ULTRON:</span>
            <span className="voice-card-text" style={{ fontStyle: "italic", letterSpacing: "0.05em" }}>
              Thinking…
            </span>
          </div>
        )}

        {error && <div className="voice-error-bar">{error}</div>}
        <div ref={transcriptBottomRef} />
      </div>

      {/* Footer Controls */}
      <div className="voice-footer">
        {state === "SPEAKING" && (
          <button
            type="button"
            className="hud-btn voice-action-btn"
            onClick={handleManualInterrupt}
          >
            INTERRUPT
          </button>
        )}
        <button
          type="button"
          className="hud-btn voice-exit-btn"
          onClick={onClose}
        >
          EXIT VOICE MODE
        </button>
      </div>
    </div>
  );
}
