"""
Full-duplex "phone call" server — talk to/from the ESP32 in real-time.

Usage:
  pip install websockets pyaudio
  python ws_phone_call.py

Your laptop mic -> ESP32 speaker
ESP32 mic -> your laptop speaker

Both directions run simultaneously, like a phone call.
Audio: 16-bit signed PCM, mono, 24kHz, little-endian.
"""

import asyncio
import collections
import threading
import time
import struct
import pyaudio
import websockets

HOST = "0.0.0.0"
PORT = 8080
SAMPLE_RATE = 24000
CHANNELS = 1
FORMAT = pyaudio.paInt16
# 1920 samples @ 24kHz = 80ms, must match ESP32 MIC_CHUNK_SAMPLES
CHUNK = 1920
MAX_SPEAKER_QUEUE = 10  # must be >= JITTER_MAX for jitter buffer to work
LAPTOP_MIC_GAIN = 1  # software gain for laptop mic (1 = no boost)
LAPTOP_NOISE_GATE = 600  # zero out laptop mic samples below this (prevents ESP32 echo gate locking)

pa = pyaudio.PyAudio()


def list_audio_devices():
    print("Audio devices:")
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        tag = ""
        if i == pa.get_default_input_device_info()["index"]:
            tag += " [DEFAULT INPUT]"
        if i == pa.get_default_output_device_info()["index"]:
            tag += " [DEFAULT OUTPUT]"
        print(
            "  {:2d}: {} (in:{} out:{}){}".format(
                i, info["name"], info["maxInputChannels"], info["maxOutputChannels"], tag
            )
        )
    print()


async def handler(websocket):
    addr = websocket.remote_address
    print(f"ESP32 connected from {addr[0]}:{addr[1]}")
    print("  Phone call active! Speak into your laptop mic.")
    print("  Press Ctrl+C to hang up.\n")

    # Open laptop speaker (output) — plays audio FROM the ESP32
    speaker = pa.open(
        format=FORMAT, channels=CHANNELS, rate=SAMPLE_RATE, output=True, frames_per_buffer=CHUNK
    )

    # Open laptop mic (input) — captures audio TO the ESP32
    mic = pa.open(
        format=FORMAT, channels=CHANNELS, rate=SAMPLE_RATE, input=True, frames_per_buffer=CHUNK
    )

    stop_event = threading.Event()

    # Echo suppression: track when speaker last played audio
    # Must be longer than jitter buffer delay (~240ms) + acoustic propagation.
    ECHO_TAIL_S = 0.4
    last_speaker_time = 0.0
    SILENCE_PCM = b"\x00\x00" * CHUNK

    # Bounded speaker queue — drops oldest audio if it falls behind
    spk_queue = collections.deque(maxlen=MAX_SPEAKER_QUEUE)

    # --- Debug counters (reset every second by status_printer) ---
    dbg = {
        "rx_packets": 0,  # packets received from ESP32
        "rx_bytes": 0,  # bytes received from ESP32
        "rx_peak": 0,  # loudest sample seen from ESP32 this interval
        "drops": 0,  # chunks dropped because queue was full
        "underruns": 0,  # times speaker thread found the queue empty
        "suppressed": 0,  # mic chunks suppressed (echo gate)
    }
    esp32_talking = False  # is the ESP32 currently sending loud audio?

    # --- Thread: play audio on laptop speaker (runs in background) ---
    def speaker_thread():
        nonlocal last_speaker_time
        JITTER_TARGET = 3  # prebuffer this many chunks (~240ms)
        JITTER_MAX = 7  # drop oldest if buffer exceeds this
        buffering = True
        while not stop_event.is_set():
            if buffering:
                if len(spk_queue) >= JITTER_TARGET:
                    buffering = False
                else:
                    time.sleep(0.01)
                    continue
            if spk_queue:
                # Skip excess to keep latency bounded
                while len(spk_queue) > JITTER_MAX:
                    spk_queue.popleft()
                    dbg["drops"] += 1
                data = spk_queue.popleft()
                speaker.write(data)
                # Only mark speaker active if audio is loud enough
                samples = struct.unpack("<{}h".format(len(data) // 2), data)
                peak = max(abs(s) for s in samples) if samples else 0
                if peak > 2000:
                    last_speaker_time = time.monotonic()
            else:
                dbg["underruns"] += 1
                buffering = True  # underrun: rebuffer before playing again
                time.sleep(0.005)

    spk_t = threading.Thread(target=speaker_thread, daemon=True)
    spk_t.start()

    # --- Task: read laptop mic and send to ESP32 ---
    # mic.read() blocks for exactly one chunk duration (~40ms) — it IS the clock
    async def send_mic():
        nonlocal last_speaker_time
        loop = asyncio.get_event_loop()
        while not stop_event.is_set():
            try:
                data = await loop.run_in_executor(
                    None, lambda: mic.read(CHUNK, exception_on_overflow=False)
                )
                # Apply software gain
                if LAPTOP_MIC_GAIN != 1:
                    samples = struct.unpack("<{}h".format(len(data) // 2), data)
                    boosted = [max(-32768, min(32767, s * LAPTOP_MIC_GAIN)) for s in samples]
                    data = struct.pack("<{}h".format(len(boosted)), *boosted)
                # Noise gate: zero out quiet samples so ESP32 echo gate doesn't lock
                if LAPTOP_NOISE_GATE > 0:
                    samples = struct.unpack("<{}h".format(len(data) // 2), data)
                    gated = [s if abs(s) >= LAPTOP_NOISE_GATE else 0 for s in samples]
                    data = struct.pack("<{}h".format(len(gated)), *gated)
                # Suppress mic while speaker is active (echo gate)
                if (time.monotonic() - last_speaker_time) < ECHO_TAIL_S:
                    dbg["suppressed"] += 1
                    data = SILENCE_PCM
                await websocket.send(data)
            except Exception:
                break

    # --- Task: receive ESP32 audio and queue for speaker ---
    async def recv_speaker():
        nonlocal esp32_talking
        try:
            async for message in websocket:
                if isinstance(message, bytes):
                    dbg["rx_packets"] += 1
                    dbg["rx_bytes"] += len(message)
                    # Raw PCM16 from ESP32
                    pcm_data = message
                    samples = struct.unpack("<{}h".format(len(pcm_data) // 2), pcm_data)
                    peak = max(abs(s) for s in samples) if samples else 0
                    if peak > dbg["rx_peak"]:
                        dbg["rx_peak"] = peak
                    if len(spk_queue) == MAX_SPEAKER_QUEUE:
                        dbg["drops"] += 1
                    spk_queue.append(pcm_data)  # queue decoded PCM
        except websockets.ConnectionClosed:
            pass

    # --- Task: print ESP32 TX status every second ---
    async def status_printer():
        nonlocal esp32_talking
        SILENT_THRESHOLD = 2000  # peak value below which we consider ESP32 silent
        while not stop_event.is_set():
            await asyncio.sleep(1.0)
            rx = dbg["rx_packets"]
            bps = dbg["rx_bytes"]
            peak = dbg["rx_peak"]
            drop = dbg["drops"]
            undr = dbg["underruns"]
            supp = dbg["suppressed"]
            # reset counters
            dbg["rx_packets"] = dbg["rx_bytes"] = dbg["rx_peak"] = 0
            dbg["drops"] = dbg["underruns"] = dbg["suppressed"] = 0

            was_talking = esp32_talking
            esp32_talking = peak > SILENT_THRESHOLD

            if not was_talking and esp32_talking:
                print("🎙  ESP32 started transmitting")
            elif was_talking and not esp32_talking:
                print("🔇  ESP32 went silent")

            bar = "█" * min(20, peak // 1638)  # 1638 per block = 32768/20
            q = len(spk_queue)
            warn_drop = f"  ⚠ DROPS:{drop}" if drop else ""
            warn_undr = f"  ⚠ UNDERRUNS:{undr}" if undr > 5 else ""
            warn_supp = f"  (mic gated {supp}x)" if supp else ""
            print(
                f"  ESP32→ {rx:3d} pkt  {bps//1000:3d} KB/s  "
                f"peak:{peak:5d} [{bar:<20}]  "
                f"queue:{q:2d}/{MAX_SPEAKER_QUEUE}"
                f"{warn_drop}{warn_undr}{warn_supp}"
            )

    try:
        await asyncio.gather(send_mic(), recv_speaker(), status_printer())
    except Exception:
        pass
    finally:
        stop_event.set()
        mic.stop_stream()
        mic.close()
        speaker.stop_stream()
        speaker.close()
        print("ESP32 disconnected. Call ended.\n")


async def main():
    list_audio_devices()
    print(f"Phone call server listening on ws://{HOST}:{PORT}")
    print("Waiting for ESP32 to connect...\n")

    async with websockets.serve(handler, HOST, PORT):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nHanging up...")
    finally:
        pa.terminate()
