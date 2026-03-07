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

/**
 * Resample Float32Array from inputSampleRate to 24kHz and return as PCM16 bytes (ArrayBuffer).
 * Convenience wrapper used by the MicVAD onSpeechEnd callback.
 */
export function float32ToPcm16Buffer(input: Float32Array, inputSampleRate: number): ArrayBuffer {
  const pcm16 = resampleTo24k(input, inputSampleRate);
  return pcm16.buffer as ArrayBuffer;
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
