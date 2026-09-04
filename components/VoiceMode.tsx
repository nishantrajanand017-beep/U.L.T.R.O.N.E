"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceState =
  | "IDLE"
  | "LISTENING"
  | "PROCESSING"
  | "THINKING"
  | "SPEAKING"
  | "ERROR";

interface VoiceModeProps {
  onClose: () => void;
}

interface ConversationTurn {
  id: string;
  role: "user" | "model";
  text: string;
  time: string;
}

const SILENCE_THRESHOLD_MS = 1100; // Silence time before concluding speech turn
const SPEECH_VOLUME_THRESHOLD = 0.032; // RMS amplitude threshold for user speech
const BARGE_IN_VOLUME_THRESHOLD = 0.085; // Higher RMS threshold to interrupt during active TTS playback (prevents speaker echo)
const MIN_SPEECH_DURATION_MS = 350; // Minimum speech length to submit to STT

export default function VoiceMode({ onClose }: VoiceModeProps) {
  const [state, setState] = useState<VoiceState>("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [latestUserText, setLatestUserText] = useState<string>("");
  const [latestUltronText, setLatestUltronText] = useState<string>("");

  const stateRef = useRef<VoiceState>("IDLE");
  stateRef.current = state;

  const historyRef = useRef<ConversationTurn[]>([]);
  historyRef.current = history;

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrlRef = useRef<string | null>(null);

  const isSpeakingRef = useRef<boolean>(false);
  const speechStartTimeRef = useRef<number>(0);
  const lastSpeechTimeRef = useRef<number>(0);
  const speakingStartTimeRef = useRef<number>(0);
  const interruptionCounterRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);

  // Stop active TTS audio immediately (used for interruption or cleanup)
  const stopTTSAudio = useCallback(() => {
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
        activeAudioRef.current.currentTime = 0;
      } catch {
        // ignore
      }
      activeAudioRef.current = null;
    }
    if (activeAudioUrlRef.current) {
      try {
        URL.revokeObjectURL(activeAudioUrlRef.current);
      } catch {
        // ignore
      }
      activeAudioUrlRef.current = null;
    }
  }, []);

  // Complete cleanup function on exit
  const cleanupAllResources = useCallback(() => {
    stopTTSAudio();

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
  const processTurnPipeline = useRef<((audioBlob: Blob) => Promise<void>) | null>(null);

  // Start continuous recording session
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

        if (totalBlob.size >= 1200 && processTurnPipeline.current) {
          processTurnPipeline.current(totalBlob);
        } else {
          // Audio too small or empty -> automatically resume listening
          if (
            stateRef.current === "PROCESSING" ||
            stateRef.current === "THINKING" ||
            stateRef.current === "LISTENING"
          ) {
            setState("LISTENING");
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
    }
  }, []);

  // Implementation of the turn processing pipeline: STT -> Gemini -> TTS -> Play -> Loop
  processTurnPipeline.current = async (audioBlob: Blob) => {
    if (!isMountedRef.current) return;

    try {
      // 1. STT Phase (ElevenLabs Scribe v2)
      setState("PROCESSING");
      setError(null);

      const ext = audioBlob.type.includes("mp4") ? "mp4" : "webm";
      const audioFile = new File([audioBlob], `speech.${ext}`, {
        type: audioBlob.type || "audio/webm",
      });

      const formData = new FormData();
      formData.append("file", audioFile);

      const sttRes = await fetch("/api/voice/stt", {
        method: "POST",
        body: formData,
      });

      if (!sttRes.ok) {
        const sttErr = await sttRes.json().catch(() => ({}));
        throw new Error(sttErr.error || `STT HTTP error ${sttRes.status}`);
      }

      const sttData = await sttRes.json();
      const userTranscript = (sttData.text || "").trim();

      if (!userTranscript) {
        // No speech detected -> automatically resume listening
        console.log("[VoiceMode] Empty transcript, returning to LISTENING.");
        setState("LISTENING");
        startRecordingSession();
        return;
      }

      console.log(`[VoiceMode] User said: "${userTranscript}"`);
      setLatestUserText(userTranscript);

      const userTurn: ConversationTurn = {
        id: Date.now().toString(),
        role: "user",
        text: userTranscript,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      const updatedHistory = [...historyRef.current, userTurn];
      setHistory(updatedHistory);

      // 2. Gemini Thinking Phase
      setState("THINKING");

      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userTranscript,
          history: updatedHistory.map((h) => ({ role: h.role, text: h.text })),
        }),
      });

      if (!chatRes.ok) {
        const chatErr = await chatRes.json().catch(() => ({}));
        throw new Error(chatErr.error || `Gemini error (${chatRes.status})`);
      }

      const chatData = await chatRes.json();
      const ultronReply = (chatData.text || chatData.reply || "").trim();

      if (!ultronReply) {
        throw new Error("No response generated by Gemini.");
      }

      console.log(`[VoiceMode] Gemini reply: "${ultronReply}"`);
      setLatestUltronText(ultronReply);

      const ultronTurn: ConversationTurn = {
        id: (Date.now() + 1).toString(),
        role: "model",
        text: ultronReply,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setHistory([...updatedHistory, ultronTurn]);

      // 3. ElevenLabs TTS Phase & Playback
      setState("SPEAKING");
      speakingStartTimeRef.current = Date.now();

      const ttsRes = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ultronReply }),
      });

      if (!ttsRes.ok) {
        const ttsErr = await ttsRes.json().catch(() => ({}));
        throw new Error(ttsErr.error || `TTS HTTP error ${ttsRes.status}`);
      }

      const audioBlobResult = await ttsRes.blob();
      const audioUrl = URL.createObjectURL(audioBlobResult);
      activeAudioUrlRef.current = audioUrl;

      const audio = new Audio(audioUrl);
      activeAudioRef.current = audio;

      audio.onended = () => {
        if (!isMountedRef.current) return;
        console.log("[VoiceMode] Audio playback finished. Returning to LISTENING.");
        stopTTSAudio();

        // 4. Automatic Loop: Transition back to LISTENING seamlessly
        setState("LISTENING");
        startRecordingSession();
      };

      audio.onerror = (e) => {
        console.error("[VoiceMode] Audio playback error:", e);
        stopTTSAudio();
        if (isMountedRef.current) {
          setState("LISTENING");
          startRecordingSession();
        }
      };

      await audio.play().catch((playErr) => {
        console.warn("[VoiceMode] Autoplay failed or interrupted:", playErr);
        stopTTSAudio();
        if (isMountedRef.current) {
          setState("LISTENING");
          startRecordingSession();
        }
      });
    } catch (err: unknown) {
      console.error("[VoiceMode] Error in pipeline:", err);
      const msg = err instanceof Error ? err.message : "Voice transaction failed.";
      setError(msg);

      // Return to listening after displaying error briefly
      setTimeout(() => {
        if (isMountedRef.current) {
          setError(null);
          setState("LISTENING");
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
      setAudioLevel(rms);

      const now = Date.now();

      // Handle Barge-in / Interruption while ULTRON is speaking
      if (stateRef.current === "SPEAKING") {
        const timeSinceSpeakingStart = now - speakingStartTimeRef.current;

        // Barge-in guard: require 400ms grace period and higher volume to avoid speaker feedback
        if (timeSinceSpeakingStart > 400 && rms > BARGE_IN_VOLUME_THRESHOLD) {
          interruptionCounterRef.current++;
          if (interruptionCounterRef.current >= 4) {
            console.log("[VoiceMode] User interruption confirmed! Stopping TTS.");
            stopTTSAudio();
            setState("LISTENING");
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
  }, [startRecordingSession, stopTTSAudio]);

  // Initialize Microphone & AudioContext on Mount
  useEffect(() => {
    isMountedRef.current = true;

    async function initVoice() {
      try {
        setState("IDLE");
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

        setState("LISTENING");
        startRecordingSession();
        runVADLoop();
      } catch (err: unknown) {
        console.error("Microphone initialization error:", err);
        const isDenied =
          err instanceof DOMException && err.name === "NotAllowedError";
        setError(
          isDenied
            ? "MICROPHONE ACCESS DENIED"
            : "FAILED TO INITIALIZE MICROPHONE"
        );
        setState("ERROR");
      }
    }

    void initVoice();

    return () => {
      isMountedRef.current = false;
      cleanupAllResources();
    };
  }, [cleanupAllResources, runVADLoop, startRecordingSession]);

  // Handle manual interrupt button
  const handleManualInterrupt = () => {
    if (state === "SPEAKING") {
      stopTTSAudio();
      setState("LISTENING");
      startRecordingSession();
    }
  };

  // State badge styling and label
  const getStateMeta = () => {
    switch (state) {
      case "LISTENING":
        return { label: "LISTENING // SPEAK NOW", class: "voice-listening" };
      case "PROCESSING":
        return { label: "PROCESSING SPEECH…", class: "voice-processing" };
      case "THINKING":
        return { label: "GEMINI THINKING…", class: "voice-thinking" };
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

      {/* Live Transcript Display */}
      <div className="voice-transcript-area">
        {latestUserText && (
          <div className="voice-card voice-card-user">
            <span className="voice-card-sender">YOU:</span>
            <span className="voice-card-text">{latestUserText}</span>
          </div>
        )}

        {latestUltronText && (
          <div className="voice-card voice-card-ultron">
            <span className="voice-card-sender">ULTRON:</span>
            <span className="voice-card-text">{latestUltronText}</span>
          </div>
        )}

        {!latestUserText && !latestUltronText && state !== "ERROR" && (
          <div className="voice-placeholder">
            Speak naturally. ULTRON is listening continuously.
          </div>
        )}

        {error && <div className="voice-error-bar">{error}</div>}
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
