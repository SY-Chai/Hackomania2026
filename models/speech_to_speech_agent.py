"""
Speech-to-Speech Agent
======================
Modal deployment for an end-to-end, multilingual speech-to-speech pipeline
with both a REST API and a WebSocket Realtime API.

Pipeline
--------
  Raw audio (WAV / PCM16 / base64)
    │
    ▼
  FireRedVAD  ← voice activity detection
    │
    ▼
  FireRedLID  ← language identification
    │
    ├─ en / zh* ──► FireRedASR2-AED  ← high-accuracy Chinese / English ASR
    │
    └─ ms / ta / hi / other ──► OpenAI Whisper API  ← multilingual fallback ASR
         │
         ▼
       transcript  (text + detected language)
         │
         ▼
       OpenAI LLM (gpt-4o-mini)  ← generate response in the caller's language
         │                           (streamed token-by-token over WebSocket)
         ▼
       OpenAI TTS (gpt-4o-mini-tts)  ← synthesise speech
         │                              (streamed PCM chunk-by-chunk over WebSocket)
         ▼
       audio response + metadata

  *zh dialects: zh-yue, zh-wu, zh-min, zh-mandarin, zh-north, zh-xinan, zh-xiang …

WebSocket Realtime API  (/realtime)
------------------------------------
Mirrors the OpenAI Realtime API event schema so existing clients work with
minimal changes.

  Client → Server
  ───────────────
  {"type": "session.update",
   "session": {"voice": "alloy", "system_prompt": "…"}}

  {"type": "input_audio_buffer.append",
   "audio": "<base64 PCM16 @ 16 kHz>"}        ← stream audio chunks

  {"type": "input_audio_buffer.commit"}         ← signal end-of-utterance

  Server → Client  (in order)
  ───────────────────────────
  {"type": "session.created",      "session": {…}}
  {"type": "input_audio_buffer.committed"}
  {"type": "input_audio_buffer.speech_started"}
  {"type": "input_audio_buffer.speech_stopped"}
  {"type": "conversation.item.created",
   "item": {"role":"user","content":[{"type":"input_audio",
            "transcript":"…","lang":"…","asr_backend":"…"}]}}
  {"type": "response.created"}
  {"type": "response.audio_transcript.delta", "delta": "…"}  ← LLM text stream
  {"type": "response.audio_transcript.done",  "transcript": "…"}
  {"type": "response.audio.delta",  "delta": "<base64 PCM chunk>"}  ← TTS stream
  {"type": "response.audio.done"}
  {"type": "response.done", "response": {"duration_ms": …}}
  {"type": "error", "error": {"message": "…"}}

Deploy
------
  modal deploy models/speech_to_speech_agent.py

Local test
----------
  modal run models/speech_to_speech_agent.py
  modal run models/speech_to_speech_agent.py --audio-path /path/to/audio.wav

Prerequisites
-------------
  Create a Modal secret named "openai-api-key" with key OPENAI_API_KEY:
    modal secret create openai-api-key OPENAI_API_KEY=sk-...
"""

import base64
import io
import os
import tempfile
import time
import uuid
import wave
from pathlib import Path

import modal

# ---------------------------------------------------------------------------
# App + image
# ---------------------------------------------------------------------------

app = modal.App(name="hackomania-speech-agent")

FIREREDASR_REPO = "https://github.com/FireRedTeam/FireRedASR2S"

# HuggingFace model repos
HF_LID_REPO = "FireRedTeam/FireRedLID"
HF_ASR_REPO = "FireRedTeam/FireRedASR2-AED"

# Local model directories (inside the Modal container Volume)
MODELS_ROOT = "/root/pretrained_models"
LID_DIR = f"{MODELS_ROOT}/FireRedLID"
ASR_DIR = f"{MODELS_ROOT}/FireRedASR2-AED"

# Language codes that FireRedASR2 handles natively
FIRERED_LANGS = frozenset(
    {
        "en",
        "zh",
        "zh-mandarin",
        "zh-yue",
        "zh-wu",
        "zh-min",
        "zh-north",
        "zh-xinan",
        "zh-xiang",
        "bo",
    }
)

# Map FireRedLID codes → ISO 639-1 codes for the OpenAI Whisper API
WHISPER_LANG_MAP = {
    "ms": "ms",  # Malay
    "ta": "ta",  # Tamil
    "hi": "hi",  # Hindi
    "id": "id",  # Indonesian
    "th": "th",  # Thai
    "vi": "vi",  # Vietnamese
    "ja": "ja",  # Japanese
    "ko": "ko",  # Korean
    "fr": "fr",
    "de": "de",
    "es": "es",
}

# Default OpenAI models
LLM_MODEL = "gpt-5-mini"
TTS_MODEL = "gpt-4o-mini-tts"
TTS_VOICE = "alloy"

MINUTES = 60

# ---------------------------------------------------------------------------
# Container image
# ---------------------------------------------------------------------------

agent_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg")
    # PyTorch 2.4 + CUDA 12.1 (minimum required by transformers; matches Modal A10G)
    .pip_install(
        "torch==2.4.0",
        "torchaudio==2.4.0",
        extra_options="--extra-index-url https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "numpy==1.26.4",
        "kaldiio==2.18.0",
        "kaldi_native_fbank==1.15",
        "soundfile==0.12.1",
        "huggingface-hub>=0.23.0",
        "fastapi>=0.110.0",
        "python-multipart",
        "websockets>=12.0",
        "openai>=1.30.0",
        "transformers==4.44.0",
        "sentencepiece==0.1.99",
        "accelerate>=0.26.0",
    )
    # Clone FireRedASR2S; no setup.py/pyproject.toml so we add it to PYTHONPATH
    .run_commands(
        f"git clone --depth=1 {FIREREDASR_REPO} /root/FireRedASR2S",
    )
    .env({"PYTHONPATH": "/root/FireRedASR2S"})
)

# Persistent Volume for model weights (survives container restarts)
model_vol = modal.Volume.from_name(
    "hackomania-speech-agent-weights", create_if_missing=True
)
volumes = {MODELS_ROOT: model_vol}


# ---------------------------------------------------------------------------
# Agent class
# ---------------------------------------------------------------------------


@app.cls(
    image=agent_image,
    gpu="A10G",
    cpu=2,
    # memory=32768,  # 32 GB RAM
    volumes=volumes,
    timeout=10 * MINUTES,
    min_containers=1,
    secrets=[modal.Secret.from_name("openai-api-key")],
)
class SpeechToSpeechAgent:
    """End-to-end multilingual speech-to-speech pipeline."""

    # ------------------------------------------------------------------
    # Lifecycle: load all models once per container
    # ------------------------------------------------------------------

    @modal.enter()
    def load_models(self):
        from fireredasr2s.fireredasr2.asr import FireRedAsr2, FireRedAsr2Config
        from fireredasr2s.fireredlid.lid import FireRedLid, FireRedLidConfig
        from huggingface_hub import snapshot_download
        from openai import OpenAI

        # ---- FireRedLID ----
        if not (Path(LID_DIR) / "model.pth.tar").exists():
            print("Downloading FireRedLID …")
            snapshot_download(HF_LID_REPO, local_dir=LID_DIR)
            model_vol.commit()
        self.lid = FireRedLid.from_pretrained(
            LID_DIR,
            FireRedLidConfig(use_gpu=True, use_half=False),
        )
        print("FireRedLID ready.")

        # ---- FireRedASR2-AED ----
        if not (Path(ASR_DIR) / "model.pth.tar").exists():
            print("Downloading FireRedASR2-AED …")
            snapshot_download(HF_ASR_REPO, local_dir=ASR_DIR)
            model_vol.commit()
        self.firered_asr = FireRedAsr2.from_pretrained(
            "aed",
            ASR_DIR,
            FireRedAsr2Config(
                use_gpu=True,
                use_half=False,
                beam_size=3,
                return_timestamp=False,
            ),
        )
        print("FireRedASR2-AED ready.")

        # ---- OpenAI client (LLM + TTS + Whisper API) ----
        self.openai = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        print("All models loaded — agent ready.")

    # ------------------------------------------------------------------
    # Audio utilities
    # ------------------------------------------------------------------

    @staticmethod
    def _pcm16_to_wav_bytes(
        pcm_bytes: bytes, sample_rate: int = 16000, channels: int = 1
    ) -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_bytes)
        return buf.getvalue()

    @staticmethod
    def _normalize_to_16k_mono_wav(wav_bytes: bytes) -> bytes:
        """Resample and downmix to 16 kHz mono WAV if needed."""
        import torchaudio

        buf = io.BytesIO(wav_bytes)
        waveform, sr = torchaudio.load(buf)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if sr != 16000:
            waveform = torchaudio.functional.resample(waveform, sr, 16000)
        out = io.BytesIO()
        torchaudio.save(out, waveform, 16000, format="wav")
        return out.getvalue()

    @staticmethod
    def _write_temp_wav(wav_bytes: bytes) -> str:
        fd, path = tempfile.mkstemp(suffix=".wav")
        with os.fdopen(fd, "wb") as f:
            f.write(wav_bytes)
        return path

    # ------------------------------------------------------------------
    # Pipeline stages
    # ------------------------------------------------------------------

    def _run_lid(self, wav_path: str) -> dict:
        results = self.lid.process(["utt0"], [wav_path])
        r = results[0] if results else {}
        return {
            "lang": r.get("lang", "en"),
            "confidence": float(r.get("confidence", 0.0)),
            "dur_s": float(r.get("dur_s", 0.0)),
        }

    def _run_firered_asr(self, seg_wav_list: list[bytes]) -> str:
        tmp_paths: list[str] = []
        try:
            for wav in seg_wav_list:
                tmp_paths.append(self._write_temp_wav(wav))
            uttids = [f"seg_{i}" for i in range(len(tmp_paths))]
            results = self.firered_asr.transcribe(uttids, tmp_paths)
            texts = []
            for r in results:
                text = r.get("text") or r.get("1best") or r.get("hyp") or ""
                if text:
                    texts.append(text.strip())
            return " ".join(texts)
        finally:
            for p in tmp_paths:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    def _run_openai_whisper_asr(self, wav_bytes: bytes, lang: str) -> str:
        whisper_lang = WHISPER_LANG_MAP.get(lang)
        audio_file = io.BytesIO(wav_bytes)
        audio_file.name = "audio.wav"
        response = self.openai.audio.transcriptions.create(
            model="gpt-4o-transcribe",
            file=audio_file,
            language=whisper_lang,
            response_format="text",
        )
        return response.strip() if isinstance(response, str) else response.text.strip()

    def _run_asr(self, wav_norm: bytes) -> tuple[str, str, str, float]:
        """
        Run LID then the appropriate ASR backend.
        Returns (transcript, lang, asr_backend, confidence).
        """
        wav_path = self._write_temp_wav(wav_norm)
        try:
            lid = self._run_lid(wav_path)
        except Exception as exc:
            print(f"[LID] FireRedLID failed ({exc!r}), defaulting to lang='en'")
            lid = {"lang": "en", "confidence": 0.0}
        finally:
            try:
                os.unlink(wav_path)
            except OSError:
                pass

        lang = lid["lang"]
        confidence = lid["confidence"]
        base_lang = lang.split("-")[0]

        if lang in FIRERED_LANGS or base_lang in ("en", "zh"):
            try:
                transcript = self._run_firered_asr([wav_norm])
                asr_backend = "firered"
            except Exception as exc:
                print(f"[ASR] FireRedASR2 failed ({exc!r}), falling back to Whisper")
                transcript = self._run_openai_whisper_asr(wav_norm, lang)
                asr_backend = "openai-whisper-fallback"
        else:
            transcript = self._run_openai_whisper_asr(wav_norm, lang)
            asr_backend = "openai-whisper"

        return transcript, lang, asr_backend, confidence

    LANG_LABELS = {
        "en": "English",
        "zh": "Mandarin Chinese",
        "zh-mandarin": "Mandarin Chinese",
        "zh-yue": "Cantonese",
        "zh-wu": "Shanghainese Wu Chinese",
        "zh-min": "Min Chinese",
        "ms": "Malay",
        "ta": "Tamil",
        "hi": "Hindi",
        "id": "Indonesian",
        "th": "Thai",
        "vi": "Vietnamese",
        "ja": "Japanese",
        "ko": "Korean",
    }

    def _stream_llm(
        self,
        history: list[dict],
        lang: str,
        lang_counts: dict[str, int],
        system_prompt: str | None,
    ):
        """
        Yield (delta_text, full_text_so_far) as the LLM streams tokens.
        Last yield has delta="" and full_text_so_far = complete response.

        ``history`` is the full conversation so far (user + assistant turns).
        ``lang_counts`` tracks how many times each language has been detected.
        """
        lang_label = self.LANG_LABELS.get(lang, lang.upper())

        # Build a language summary from aggregate detections
        if lang_counts:
            sorted_langs = sorted(lang_counts.items(), key=lambda x: -x[1])
            lang_summary = ", ".join(
                f"{self.LANG_LABELS.get(l, l.upper())} ({n}x)" for l, n in sorted_langs
            )
        else:
            lang_summary = lang_label

        default_system = (
            "You are a calm, empathetic voice assistant for an emergency response "
            "service. You help callers—primarily elderly individuals—with urgent "
            "situations. Keep responses concise, clear, and reassuring."
        )
        lang_directive = (
            f"\n\nDetected language for the latest utterance: {lang_label}.\n"
            f"Language detection history across the conversation: {lang_summary}.\n"
            "Always reply in the caller's most likely language based on the above."
        )
        messages = [
            {
                "role": "system",
                "content": (system_prompt or default_system) + lang_directive,
            },
            *history,
        ]
        stream = self.openai.chat.completions.create(
            model=LLM_MODEL,
            messages=messages,
            temperature=0.3,
            stream=True,
        )
        full_text = ""
        for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                full_text += delta
                yield delta, full_text
        yield "", full_text  # final sentinel

    def _stream_tts(self, text: str, voice: str = TTS_VOICE):
        """Yield raw PCM chunks from the OpenAI TTS streaming API."""
        with self.openai.audio.speech.with_streaming_response.create(
            model=TTS_MODEL,
            voice=voice,
            input=text,
            response_format="pcm",  # raw 24 kHz signed-16-bit PCM
        ) as resp:
            yield from resp.iter_bytes(chunk_size=4096)

    def _run_tts(self, text: str, voice: str = TTS_VOICE) -> bytes:
        """Non-streaming TTS, returns full MP3 bytes (used by REST endpoints)."""
        return self.openai.audio.speech.create(
            model=TTS_MODEL,
            voice=voice,
            input=text,
            response_format="mp3",
        ).content

    # ------------------------------------------------------------------
    # Batch pipeline (used by REST endpoints and Modal method)
    # ------------------------------------------------------------------

    def _process(
        self,
        wav_bytes: bytes,
        system_prompt: str | None = None,
        tts_voice: str = TTS_VOICE,
    ) -> dict:
        t0 = time.time()
        wav_norm = self._normalize_to_16k_mono_wav(wav_bytes)

        transcript, lang, asr_backend, confidence = self._run_asr(wav_norm)
        print(
            f"[LID] lang={lang!r} conf={confidence:.3f}  [ASR] {asr_backend}: {transcript!r}"
        )

        # Collect full LLM response (non-streaming for REST)
        base_lang = lang.split("-")[0]
        lang_counts = {base_lang: 1}
        history = [{"role": "user", "content": transcript}]
        llm_response = ""
        for _delta, full in self._stream_llm(history, lang, lang_counts, system_prompt):
            llm_response = full
        print(f"[LLM] {llm_response!r}")

        tts_audio = self._run_tts(llm_response, voice=tts_voice)
        audio_b64 = base64.b64encode(tts_audio).decode()
        duration_ms = int((time.time() - t0) * 1000)
        print(f"[TTS] done | total={duration_ms} ms")

        return {
            "transcript": transcript,
            "lang": lang,
            "confidence": confidence,
            "asr_backend": asr_backend,
            "llm_response": llm_response,
            "audio_b64": audio_b64,
            "duration_ms": duration_ms,
        }

    # ------------------------------------------------------------------
    # Public Modal method (Python SDK callers)
    # ------------------------------------------------------------------

    @modal.method()
    def process_wav(
        self,
        wav_bytes: bytes,
        system_prompt: str | None = None,
        tts_voice: str = TTS_VOICE,
    ) -> dict:
        return self._process(wav_bytes, system_prompt, tts_voice)

    @modal.method()
    def process_pcm(
        self,
        pcm_bytes: bytes,
        sample_rate: int = 16000,
        channels: int = 1,
        system_prompt: str | None = None,
        tts_voice: str = TTS_VOICE,
    ) -> dict:
        wav_bytes = self._pcm16_to_wav_bytes(pcm_bytes, sample_rate, channels)
        return self._process(wav_bytes, system_prompt, tts_voice)

    # ------------------------------------------------------------------
    # HTTP + WebSocket API
    # ------------------------------------------------------------------

    @modal.asgi_app()
    def api(self):
        import asyncio

        from fastapi import (
            FastAPI,
            File,
            Form,
            HTTPException,
            UploadFile,
            WebSocket,
            WebSocketDisconnect,
        )
        from fastapi.responses import JSONResponse, Response
        from pydantic import BaseModel

        web_app = FastAPI(
            title="Speech-to-Speech Agent",
            description="FireRedVAD → FireRedLID → FireRedASR2/Whisper → GPT-4o-mini → TTS",
            version="1.0",
        )

        # ── /health ────────────────────────────────────────────────────
        @web_app.get("/health")
        async def health():
            return {
                "status": "ok",
                "models": {
                    "vad": "FireRedVAD",
                    "lid": "FireRedLID",
                    "asr_primary": "FireRedASR2-AED (en, zh)",
                    "asr_fallback": "OpenAI Whisper API (ms, ta, hi, …)",
                    "llm": LLM_MODEL,
                    "tts": TTS_MODEL,
                },
            }

        # ── REST: /process/wav ─────────────────────────────────────────
        @web_app.post("/process/wav")
        async def process_wav_endpoint(
            file: UploadFile = File(...),
            system_prompt: str = Form(default=""),
            tts_voice: str = Form(default=TTS_VOICE),
        ):
            wav_bytes = await file.read()
            try:
                result = self._process(wav_bytes, system_prompt or None, tts_voice)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=str(exc))
            return JSONResponse(result)

        # ── REST: /process/base64 ──────────────────────────────────────
        class Base64Request(BaseModel):
            audio_b64: str
            format: str = "wav"  # "wav" | "pcm16"
            sample_rate: int = 16000
            channels: int = 1
            system_prompt: str | None = None
            tts_voice: str = TTS_VOICE

        @web_app.post("/process/base64")
        async def process_base64_endpoint(req: Base64Request):
            try:
                raw = base64.b64decode(req.audio_b64)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid base64 data")
            if req.format == "wav":
                wav_bytes = raw
            elif req.format == "pcm16":
                wav_bytes = SpeechToSpeechAgent._pcm16_to_wav_bytes(
                    raw, req.sample_rate, req.channels
                )
            else:
                raise HTTPException(
                    status_code=400, detail="format must be 'wav' or 'pcm16'"
                )
            try:
                result = self._process(wav_bytes, req.system_prompt, req.tts_voice)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=str(exc))
            return JSONResponse(result)

        # ── REST: /process/audio-response (returns raw MP3) ───────────
        @web_app.post("/process/audio-response")
        async def process_audio_response_endpoint(
            file: UploadFile = File(...),
            system_prompt: str = Form(default=""),
            tts_voice: str = Form(default=TTS_VOICE),
        ):
            wav_bytes = await file.read()
            try:
                result = self._process(wav_bytes, system_prompt or None, tts_voice)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=str(exc))
            mp3_bytes = base64.b64decode(result["audio_b64"])
            return Response(
                content=mp3_bytes,
                media_type="audio/mpeg",
                headers={
                    "X-Transcript": result["transcript"],
                    "X-Lang": result["lang"],
                    "X-Confidence": str(result["confidence"]),
                    "X-ASR-Backend": result["asr_backend"],
                    "X-LLM-Response": result["llm_response"],
                    "X-Duration-Ms": str(result["duration_ms"]),
                },
            )

        # ── WebSocket: /realtime  (OpenAI Realtime-compatible) ─────────
        @web_app.websocket("/realtime")
        async def realtime_endpoint(ws: WebSocket):
            """
            WebSocket endpoint that mirrors the OpenAI Realtime API event schema.

            Audio format expected from the client:
              Base64-encoded signed-16-bit PCM, 16 kHz, mono
              (send in chunks via input_audio_buffer.append)

            The server streams back:
              - LLM text deltas (response.audio_transcript.delta)
              - Raw PCM audio chunks at 24 kHz (response.audio.delta, base64)
            """
            await ws.accept()

            session_id = str(uuid.uuid4())
            session_voice = TTS_VOICE
            session_prompt: str | None = None
            audio_buffer = bytearray()  # accumulates PCM16 chunks
            loop = asyncio.get_event_loop()
            conversation_history: list[dict] = []  # multi-turn messages
            lang_counts: dict[str, int] = {}  # aggregate language detections

            # Helper: send a JSON event
            async def send(event: dict):
                await ws.send_json(event)

            await send(
                {
                    "type": "session.created",
                    "session": {
                        "id": session_id,
                        "voice": session_voice,
                        "model": LLM_MODEL,
                        "tts_model": TTS_MODEL,
                        "input_audio_format": "pcm16_24khz",
                        "output_audio_format": "pcm",
                    },
                }
            )

            try:
                while True:
                    msg = await ws.receive_json()
                    event_type = msg.get("type", "")

                    # ── session.update ─────────────────────────────────
                    if event_type == "session.update":
                        sess = msg.get("session", {})
                        if "voice" in sess:
                            session_voice = sess["voice"]
                        if "system_prompt" in sess:
                            session_prompt = sess["system_prompt"]
                        await send(
                            {
                                "type": "session.updated",
                                "session": {
                                    "id": session_id,
                                    "voice": session_voice,
                                },
                            }
                        )

                    # ── input_audio_buffer.append ──────────────────────
                    elif event_type == "input_audio_buffer.append":
                        chunk_b64 = msg.get("audio", "")
                        if chunk_b64:
                            audio_buffer.extend(base64.b64decode(chunk_b64))

                    # ── input_audio_buffer.clear ───────────────────────
                    elif event_type == "input_audio_buffer.clear":
                        audio_buffer.clear()
                        await send({"type": "input_audio_buffer.cleared"})

                    # ── input_audio_buffer.commit ──────────────────────
                    elif event_type == "input_audio_buffer.commit":
                        if not audio_buffer:
                            await send(
                                {
                                    "type": "error",
                                    "error": {"message": "Audio buffer is empty."},
                                }
                            )
                            continue

                        await send({"type": "input_audio_buffer.committed"})
                        t0 = time.time()

                        # Convert buffered PCM16 → WAV (client sends 24 kHz; normalise will resample to 16 kHz)
                        pcm_snapshot = bytes(audio_buffer)
                        audio_buffer.clear()
                        wav_bytes = SpeechToSpeechAgent._pcm16_to_wav_bytes(
                            pcm_snapshot, sample_rate=24000
                        )

                        # LID + ASR  (blocking — run in thread pool; skip VAD since frontend handles it)
                        await send({"type": "input_audio_buffer.speech_started"})
                        try:
                            wav_norm = await loop.run_in_executor(
                                None, self._normalize_to_16k_mono_wav, wav_bytes
                            )
                            (
                                transcript,
                                lang,
                                asr_backend,
                                conf,
                            ) = await loop.run_in_executor(
                                None, self._run_asr, wav_norm
                            )
                        except Exception as exc:
                            await send(
                                {"type": "error", "error": {"message": str(exc)}}
                            )
                            continue

                        await send({"type": "input_audio_buffer.speech_stopped"})
                        await send(
                            {
                                "type": "conversation.item.created",
                                "item": {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "input_audio",
                                            "transcript": transcript,
                                            "lang": lang,
                                            "confidence": conf,
                                            "asr_backend": asr_backend,
                                        }
                                    ],
                                },
                            }
                        )
                        await send({"type": "response.created"})

                        # Track language detections across the session
                        base_lang = lang.split("-")[0]
                        lang_counts[base_lang] = lang_counts.get(base_lang, 0) + 1

                        # Append user turn to conversation history
                        conversation_history.append(
                            {"role": "user", "content": transcript}
                        )

                        # Stream LLM via queue so text arrives in real-time
                        hist_snapshot = list(conversation_history)
                        lc_snapshot = dict(lang_counts)
                        llm_queue: asyncio.Queue = asyncio.Queue()

                        def _produce_llm():
                            full = ""
                            for d, f in self._stream_llm(
                                hist_snapshot, lang, lc_snapshot, session_prompt
                            ):
                                if d:
                                    loop.call_soon_threadsafe(
                                        llm_queue.put_nowait, ("delta", d)
                                    )
                                full = f
                            loop.call_soon_threadsafe(
                                llm_queue.put_nowait, ("done", full)
                            )

                        llm_task = loop.run_in_executor(None, _produce_llm)

                        llm_full = ""
                        while True:
                            kind, value = await llm_queue.get()
                            if kind == "done":
                                llm_full = value
                                break
                            await send(
                                {
                                    "type": "response.audio_transcript.delta",
                                    "delta": value,
                                }
                            )

                        await llm_task

                        await send(
                            {
                                "type": "response.audio_transcript.done",
                                "transcript": llm_full,
                            }
                        )

                        # Append assistant turn to conversation history
                        conversation_history.append(
                            {"role": "assistant", "content": llm_full}
                        )

                        # Stream TTS via queue so audio plays as it's generated
                        tts_queue: asyncio.Queue = asyncio.Queue()

                        def _produce_tts():
                            for pcm_chunk in self._stream_tts(
                                llm_full, voice=session_voice
                            ):
                                loop.call_soon_threadsafe(
                                    tts_queue.put_nowait, pcm_chunk
                                )
                            loop.call_soon_threadsafe(
                                tts_queue.put_nowait, None
                            )  # sentinel

                        tts_task = loop.run_in_executor(None, _produce_tts)

                        while True:
                            pcm_chunk = await tts_queue.get()
                            if pcm_chunk is None:
                                break
                            await send(
                                {
                                    "type": "response.audio.delta",
                                    "delta": base64.b64encode(pcm_chunk).decode(),
                                }
                            )

                        await tts_task  # ensure thread finished cleanly

                        await send({"type": "response.audio.done"})
                        await send(
                            {
                                "type": "response.done",
                                "response": {
                                    "transcript": transcript,
                                    "lang": lang,
                                    "asr_backend": asr_backend,
                                    "llm_response": llm_full,
                                    "duration_ms": int((time.time() - t0) * 1000),
                                },
                            }
                        )

                    else:
                        await send(
                            {
                                "type": "error",
                                "error": {
                                    "message": f"Unknown event type: {event_type!r}"
                                },
                            }
                        )

            except WebSocketDisconnect:
                pass
            except Exception as exc:
                try:
                    await send({"type": "error", "error": {"message": str(exc)}})
                except Exception:
                    pass

        return web_app


# ---------------------------------------------------------------------------
# Local test entrypoint
# ---------------------------------------------------------------------------


@app.local_entrypoint()
def test(audio_path: str = ""):
    """
    modal run models/speech_to_speech_agent.py
    modal run models/speech_to_speech_agent.py --audio-path /tmp/hello.wav
    """
    import struct

    agent = SpeechToSpeechAgent()

    if audio_path and os.path.exists(audio_path):
        print(f"Using audio file: {audio_path}")
        with open(audio_path, "rb") as f:
            wav_bytes = f.read()
    else:
        print("No audio file — using 2 s of silence as test input.")
        n_samples = 16000 * 2
        pcm_bytes = struct.pack(f"<{n_samples}h", *([0] * n_samples))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(pcm_bytes)
        wav_bytes = buf.getvalue()

    result = agent.process_wav.remote(wav_bytes)

    print("\n── Pipeline result ──────────────────────────────────")
    print(f"  lang        : {result['lang']}  (confidence {result['confidence']:.3f})")
    print(f"  asr_backend : {result['asr_backend']}")
    print(f"  transcript  : {result['transcript']!r}")
    print(f"  llm         : {result['llm_response']!r}")
    print(f"  latency     : {result['duration_ms']} ms")

    out_path = "/tmp/speech_agent_response.mp3"
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(result["audio_b64"]))
    print(f"  tts audio   : saved to {out_path}")
    print("─────────────────────────────────────────────────────")
