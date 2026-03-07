export function toPcm16(chunk: ArrayBuffer | Uint8Array): Int16Array {
  if (chunk instanceof ArrayBuffer) {
    return new Int16Array(chunk);
  }
  return new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
}

export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

export function resampleTo24k(input: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 24000) {
    return float32ToInt16(input);
  }

  const ratio = inputSampleRate / 24000;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return float32ToInt16(result);
}

// ---------------------------------------------------------------------------
// Simple energy-based VAD for gating mic audio before sending to the backend.
// Returns true when the chunk likely contains speech.
// ---------------------------------------------------------------------------
const VAD_SPEECH_THRESHOLD = 0.01; // float32 RMS threshold
const VAD_SILENCE_FRAMES = 8;     // ~750 ms at 4096-sample frames @ 48 kHz

let vadSpeechActive = false;
let vadSilenceCount = 0;

export function resetVadState(): void {
  vadSpeechActive = false;
  vadSilenceCount = 0;
}

/**
 * Returns "speech" | "silence_after_speech" | "silence".
 * - "speech": audio contains speech, should be sent
 * - "silence_after_speech": speech just ended, send a commit signal
 * - "silence": no speech, skip sending
 */
export function classifyChunk(float32: Float32Array): "speech" | "silence_after_speech" | "silence" {
  // Compute RMS energy
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  const rms = Math.sqrt(sum / float32.length);

  if (rms > VAD_SPEECH_THRESHOLD) {
    vadSpeechActive = true;
    vadSilenceCount = 0;
    return "speech";
  }

  if (vadSpeechActive) {
    vadSilenceCount++;
    if (vadSilenceCount >= VAD_SILENCE_FRAMES) {
      vadSpeechActive = false;
      vadSilenceCount = 0;
      return "silence_after_speech";
    }
    // Still within the grace period — keep sending (captures trailing audio)
    return "speech";
  }

  return "silence";
}

export function schedulePcm16Playback(
  ctx: AudioContext | null,
  nextPlaybackTimeRef: { current: number },
  pcmChunk: Int16Array,
): void {
  if (!ctx || pcmChunk.length === 0) return;

  const audioBuffer = ctx.createBuffer(1, pcmChunk.length, 24000);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < pcmChunk.length; i++) {
    channel[i] = pcmChunk[i] / 32768;
  }

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);

  const now = ctx.currentTime;
  const startTime = nextPlaybackTimeRef.current > now ? nextPlaybackTimeRef.current : now;

  source.start(startTime);
  nextPlaybackTimeRef.current = startTime + audioBuffer.duration;
}
