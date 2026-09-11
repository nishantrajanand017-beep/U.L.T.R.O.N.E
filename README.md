# ULTRON — Personal AI Assistant

A futuristic multimodal AI assistant built around an Iron Man–inspired holographic orb interface.

ULTRON combines a real-time 3D interface with AI conversation, voice interaction, hand gestures, secure user API-key management, and an Android companion architecture.

The project is designed as a personal AI system that can eventually understand natural language, communicate through voice, and securely interact with connected devices.

---

## ✨ Features

### 🔮 Holographic Orb Interface

- Interactive Three.js 3D orb
- Futuristic HUD interface
- Real-time orb state changes
- Listening, thinking, executing, speaking and error states
- Audio-reactive visual effects
- Mouse and touch interaction
- Zoom and rotation controls

### 🧠 Gemini AI

ULTRON uses **Google Gemini** as its primary intelligence layer.

- Gemini 3.6 Flash
- Natural-language conversations
- Context-aware chat
- User-provided Gemini API keys
- Secure server-side API-key handling
- Developer fallback key support
- API-key validation and testing

Normal text chat uses Gemini directly and does not activate voice output.

### 🎙️ Voice Mode

ULTRON supports real-time voice interaction:

```text
User Speech
     ↓
Speech-to-Text
     ↓
Gemini 3.6 Flash
     ↓
ElevenLabs Text-to-Speech
     ↓
ULTRON Voice