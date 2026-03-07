"""
Bidirectional WebSocket audio server for ESP32.

Usage:
  pip install websockets
  python ws_test_server.py [path_to_wav_file]

It will:
  1. Listen on port 8080
  2. Receive mic audio from ESP32 and save to 'recording.wav'
  3. Simultaneously stream a WAV file back to the ESP32 speaker

If no WAV file is specified, it looks for 'tools/playback.wav' or 'playback.wav'.
If no file is found, it runs in receive-only mode (like before).

Audio format: raw 16-bit signed PCM, mono, 16kHz, little-endian
"""

import asyncio
import wave
import struct
import datetime
import sys
import os
import websockets

HOST = "0.0.0.0"
PORT = 8080
SAMPLE_RATE = 8000
SAMPLE_WIDTH = 2  # 16-bit = 2 bytes
CHANNELS = 1
CHUNK_SAMPLES = 1024  # match ESP32 chunk size
CHUNK_BYTES = CHUNK_SAMPLES * SAMPLE_WIDTH

audio_data = bytearray()
chunk_count = 0


def save_wav(filename="recording.wav"):
    if not audio_data:
        print("No audio data received, nothing to save.")
        return
    with wave.open(filename, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(bytes(audio_data))
    duration = len(audio_data) / (SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS)
    print(f"\nSaved {filename} ({duration:.1f}s, {len(audio_data)} bytes)")


def load_playback_wav(path):
    """Load a WAV file and convert to raw 16-bit mono 16kHz PCM."""
    if not os.path.exists(path):
        return None

    with wave.open(path, "rb") as wf:
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        sr = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    print(f"Loaded playback file: {path}")
    print(f"  Format: {ch}ch, {sw*8}-bit, {sr}Hz, {len(frames)} bytes")

    # Convert to mono if stereo
    if ch == 2 and sw == 2:
        samples = struct.unpack(f"<{len(frames)//2}h", frames)
        mono = []
        for i in range(0, len(samples), 2):
            mono.append((samples[i] + samples[i+1]) // 2)
        frames = struct.pack(f"<{len(mono)}h", *mono)
        print(f"  Converted stereo -> mono ({len(frames)} bytes)")

    if sr != SAMPLE_RATE:
        print(f"  WARNING: Sample rate is {sr}Hz, ESP32 expects {SAMPLE_RATE}Hz.")
        print(f"  For best results, convert first: ffmpeg -i {path} -ar 16000 -ac 1 -sample_fmt s16 playback_16k.wav")

    return frames


async def send_audio(websocket, pcm_data):
    """Stream raw PCM data to ESP32 in chunks, paced at real-time."""
    chunk_interval = CHUNK_SAMPLES / SAMPLE_RATE  # seconds per chunk
    offset = 0
    sent = 0
    print(f"  >> Streaming {len(pcm_data)} bytes to ESP32 speaker...")

    while offset < len(pcm_data):
        chunk = pcm_data[offset:offset + CHUNK_BYTES]
        try:
            await websocket.send(chunk)
        except websockets.ConnectionClosed:
            break
        offset += CHUNK_BYTES
        sent += 1
        await asyncio.sleep(chunk_interval)  # pace to real-time so it doesn't overflow

    duration = len(pcm_data) / (SAMPLE_RATE * SAMPLE_WIDTH)
    print(f"  >> Done streaming ({sent} chunks, {duration:.1f}s)")


async def receive_audio(websocket):
    """Receive mic audio from ESP32."""
    global audio_data, chunk_count
    try:
        async for message in websocket:
            if isinstance(message, bytes):
                chunk_count += 1
                audio_data.extend(message)
                samples = len(message) // SAMPLE_WIDTH
                if samples > 0:
                    pcm = struct.unpack(f"<{samples}h", message)
                    peak = max(abs(s) for s in pcm)
                    bar_len = min(peak // 500, 40)
                    bar = "█" * bar_len
                    duration = len(audio_data) / (SAMPLE_RATE * SAMPLE_WIDTH)
                    print(f"  << chunk {chunk_count:5d} | {samples:4d} samples | peak {peak:5d} | {duration:6.1f}s | {bar}")
            else:
                print(f"  [text] {message}")
    except websockets.ConnectionClosed:
        pass


async def handler(websocket):
    global audio_data, chunk_count
    audio_data = bytearray()
    chunk_count = 0

    addr = websocket.remote_address
    print(f"\n[{datetime.datetime.now():%H:%M:%S}] ESP32 connected from {addr[0]}:{addr[1]}")

    # Run receive and (optionally) send concurrently
    tasks = [asyncio.create_task(receive_audio(websocket))]

    if playback_pcm:
        tasks.append(asyncio.create_task(send_audio(websocket, playback_pcm)))

    await asyncio.gather(*tasks)

    print(f"[{datetime.datetime.now():%H:%M:%S}] ESP32 disconnected ({chunk_count} chunks received)")
    save_wav()


# --- Find playback file ---
playback_pcm = None

def find_playback_file():
    """Look for a playback WAV file from CLI arg or default locations."""
    if len(sys.argv) > 1:
        return sys.argv[1]
    for candidate in ["playback.wav", "tools/playback.wav"]:
        if os.path.exists(candidate):
            return candidate
    return None


async def main():
    global playback_pcm

    wav_path = find_playback_file()
    if wav_path:
        playback_pcm = load_playback_wav(wav_path)
    else:
        print("No playback WAV file found. Running in receive-only mode.")
        print("  To stream audio to ESP32, run: python ws_test_server.py yourfile.wav\n")

    print(f"WebSocket server listening on ws://{HOST}:{PORT}")
    print("Waiting for ESP32 to connect...")
    print("Press Ctrl+C to stop\n")

    async with websockets.serve(handler, HOST, PORT):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopping...")
        save_wav()
