import assert from "node:assert/strict";
import { POST as postTTS } from "../app/api/voice/tts/route";

console.log("==========================================");
console.log("   ULTRON KOKORO TTS INTEGRATION TEST     ");
console.log("==========================================\n");

function parseWavHeader(buffer: Buffer) {
  assert.ok(buffer.length >= 44, "Buffer too small to contain valid WAV header");

  const chunkId = buffer.toString("ascii", 0, 4);
  assert.equal(chunkId, "RIFF", "Header must begin with 'RIFF'");

  const format = buffer.toString("ascii", 8, 12);
  assert.equal(format, "WAVE", "File format must be 'WAVE'");

  const subchunk1Id = buffer.toString("ascii", 12, 16);
  assert.equal(subchunk1Id, "fmt ", "Subchunk 1 must be 'fmt '");

  const audioFormat = buffer.readUInt16LE(20);
  assert.equal(audioFormat, 1, "Audio format must be 1 (Linear PCM)");

  const numChannels = buffer.readUInt16LE(22);
  assert.equal(numChannels, 1, "Channel count must be 1 (Mono)");

  const sampleRate = buffer.readUInt32LE(24);
  assert.equal(sampleRate, 24000, "Sample rate must be 24000 Hz");

  const bitsPerSample = buffer.readUInt16LE(34);
  assert.equal(bitsPerSample, 16, "Bit depth must be 16-bit");

  // Locate 'data' subchunk (usually at offset 36, or after extra fmt chunks)
  let dataOffset = 36;
  while (dataOffset < buffer.length - 8) {
    const chunkTag = buffer.toString("ascii", dataOffset, dataOffset + 4);
    if (chunkTag === "data") break;
    const chunkSize = buffer.readUInt32LE(dataOffset + 4);
    dataOffset += 8 + chunkSize;
  }

  const dataTag = buffer.toString("ascii", dataOffset, dataOffset + 4);
  assert.equal(dataTag, "data", "Must find 'data' subchunk");
  const dataSize = buffer.readUInt32LE(dataOffset + 4);
  const durationSec = dataSize / (sampleRate * numChannels * (bitsPerSample / 8));

  return {
    chunkId,
    format,
    audioFormat,
    numChannels,
    sampleRate,
    bitsPerSample,
    dataSize,
    durationSec,
  };
}

async function runKokoroTtsTest() {
  const req = new Request("http://localhost:3000/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Hello, I am Ultron. Local voice system online.",
    }),
  });

  console.log("Sending TTS request to /api/voice/tts...");
  const t0 = Date.now();
  const res = await postTTS(req);
  const latencyMs = Date.now() - t0;

  console.log(`HTTP Status: ${res.status}`);
  assert.equal(res.status, 200, "Route must return HTTP 200");

  const contentType = res.headers.get("content-type");
  console.log(`Content-Type: ${contentType}`);
  assert.ok(contentType?.includes("audio/wav"), "Content-Type must be audio/wav");

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`Received Audio Buffer: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(2)} KB)`);
  assert.ok(buffer.length > 1000, "Audio buffer must be non-empty and substantial");

  const parsed = parseWavHeader(buffer);
  console.log("\nWAV Header Verification:");
  console.log(`- Format: ${parsed.format} (AudioFormat: ${parsed.audioFormat} PCM)`);
  console.log(`- Channels: ${parsed.numChannels} (Mono)`);
  console.log(`- Sample Rate: ${parsed.sampleRate} Hz`);
  console.log(`- Bit Depth: ${parsed.bitsPerSample}-bit`);
  console.log(`- Data Size: ${parsed.dataSize} bytes`);
  console.log(`- Audio Duration: ${parsed.durationSec.toFixed(3)} sec`);
  console.log(`- Total Route Latency: ${latencyMs} ms`);

  console.log("\n==========================================");
  console.log("   KOKORO TTS INTEGRATION TEST: PASSED    ");
  console.log("==========================================");
}

runKokoroTtsTest().catch((err) => {
  console.error("\n==========================================");
  console.error("   KOKORO TTS INTEGRATION TEST: FAILED    ");
  console.error("==========================================");
  console.error(err);
  process.exit(1);
});
