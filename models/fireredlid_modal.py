"""
FireRedLID Modal Service
Deploys FireRedASR2S Language Identification (LID) as a Modal HTTP endpoint.

Usage:
  Deploy:  modal deploy fireredlid_modal.py
  Test:    modal run fireredlid_modal.py --audio-path /path/to/audio.wav

The service accepts PCM16 or WAV audio and returns the detected language + confidence.
Intended to be called from the Node.js server before/during OpenAI Realtime sessions
so the AI assistant can respond in the caller's language.
"""

import base64
import io
import struct
import time
from pathlib import Path

import modal

# ---------------------------------------------------------------------------
# App + Image
# ---------------------------------------------------------------------------

app = modal.App(name="hackomania-fireredlid")

REPO_URL = "https://github.com/FireRedTeam/FireRedASR2S"
MODEL_HF_REPO = "FireRedTeam/FireRedLID"
MODEL_DIR = "/root/pretrained_models/FireRedLID"

lid_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg")
    .pip_install(
        "torch==2.4.0",
        "torchaudio==2.4.0",
        extra_options="--extra-index-url https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "numpy==1.26.1",
        "kaldiio==2.18.0",
        "kaldi_native_fbank==1.15",
        "soundfile==0.12.1",
        "huggingface-hub==0.33.5",
        "fastapi==0.116.1",
        "python-multipart",
    )
    .run_commands(
        # Clone the repo so the fireredasr2s package is available
        f"git clone --depth=1 {REPO_URL} /root/FireRedASR2S",
        "pip install -e /root/FireRedASR2S --no-deps",
    )
)

# Model weights live in a persistent Volume so they survive container restarts
model_vol = modal.Volume.from_name("hackomania-fireredlid-weights", create_if_missing=True)
volumes = {"/root/pretrained_models": model_vol}

MINUTES = 60


# ---------------------------------------------------------------------------
# LID service class
# ---------------------------------------------------------------------------

@app.cls(
    image=lid_image,
    gpu="T4",
    volumes=volumes,
    timeout=5 * MINUTES,
    # Keep one warm container to avoid cold-start latency on every call
    min_containers=0,
)
class LID:
    @modal.enter()
    def load_model(self):
        from huggingface_hub import snapshot_download
        from fireredasr2s.fireredlid.lid import FireRedLid, FireRedLidConfig

        # Download model weights if not already cached in the Volume
        model_path = Path(MODEL_DIR)
        if not (model_path / "model.pth.tar").exists():
            print("Downloading FireRedLID weights from Hugging Face…")
            snapshot_download(MODEL_HF_REPO, local_dir=MODEL_DIR)
            model_vol.commit()
            print("Weights downloaded and committed to Volume.")
        else:
            print("Using cached weights from Volume.")

        config = FireRedLidConfig(use_gpu=True, use_half=False)
        self.model = FireRedLid.from_pretrained(MODEL_DIR, config)
        print("FireRedLID model ready.")

    # ------------------------------------------------------------------
    # Core inference – accepts raw (sample_rate, numpy_array) pairs
    # ------------------------------------------------------------------

    def _run_lid(self, audio_pairs: list[tuple]) -> list[dict]:
        """
        audio_pairs: list of (sample_rate: int, wav_np: np.ndarray[float32, shape=(N,)])
        Returns list of dicts with keys: lang, confidence, dur_s
        """
        uttids = [f"utt_{i}" for i in range(len(audio_pairs))]
        results = self.model.process(uttids, audio_pairs)
        return [
            {
                "lang": r.get("lang", ""),
                "confidence": r.get("confidence", 0.0),
                "dur_s": r.get("dur_s", 0.0),
            }
            for r in results
        ]

    # ------------------------------------------------------------------
    # Modal method for Python clients
    # ------------------------------------------------------------------

    @modal.method()
    def identify_pcm(
        self,
        pcm_bytes: bytes,
        sample_rate: int = 16000,
        channels: int = 1,
    ) -> dict:
        """
        Identify language from raw PCM16 audio bytes.

        Args:
            pcm_bytes:   Raw signed 16-bit PCM audio bytes (little-endian).
            sample_rate: Sample rate of the audio (default 16000).
            channels:    Number of channels – mixed down to mono if > 1.

        Returns:
            {"lang": str, "confidence": float, "dur_s": float}
        """
        import numpy as np

        wav_np = _pcm16_bytes_to_float32(pcm_bytes, channels)
        wav_np = _maybe_resample(wav_np, sample_rate, target_sr=16000)

        results = self._run_lid([(16000, wav_np)])
        return results[0]

    @modal.method()
    def identify_wav_bytes(self, wav_bytes: bytes) -> dict:
        """
        Identify language from WAV file bytes (any sample rate).

        Returns:
            {"lang": str, "confidence": float, "dur_s": float}
        """
        import numpy as np
        import soundfile as sf

        buf = io.BytesIO(wav_bytes)
        wav_np, sr = sf.read(buf, dtype="float32", always_2d=False)
        if wav_np.ndim == 2:
            wav_np = wav_np.mean(axis=1)  # stereo → mono
        wav_np = _maybe_resample(wav_np, sr, target_sr=16000)

        results = self._run_lid([(16000, wav_np)])
        return results[0]

    # ------------------------------------------------------------------
    # FastAPI HTTP endpoint
    # ------------------------------------------------------------------

    @modal.asgi_app()
    def api(self):
        from fastapi import FastAPI, File, Form, HTTPException, UploadFile
        from fastapi.responses import JSONResponse

        web_app = FastAPI(title="FireRedLID", version="1.0")

        @web_app.get("/health")
        async def health():
            return {"status": "ok"}

        @web_app.post("/identify/wav")
        async def identify_wav(file: UploadFile = File(...)):
            """
            POST a WAV file to detect its language.
            Returns: {"lang": str, "confidence": float, "dur_s": float}
            """
            import numpy as np
            import soundfile as sf

            wav_bytes = await file.read()
            buf = io.BytesIO(wav_bytes)
            try:
                wav_np, sr = sf.read(buf, dtype="float32", always_2d=False)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid audio: {e}")

            if wav_np.ndim == 2:
                wav_np = wav_np.mean(axis=1)
            wav_np = _maybe_resample(wav_np, sr, target_sr=16000)

            results = self._run_lid([(16000, wav_np)])
            return JSONResponse(results[0])

        @web_app.post("/identify/pcm")
        async def identify_pcm(
            file: UploadFile = File(...),
            sample_rate: int = Form(16000),
            channels: int = Form(1),
        ):
            """
            POST raw PCM16 audio bytes to detect its language.
            Form fields:
              - sample_rate (int, default 16000)
              - channels    (int, default 1)
            Returns: {"lang": str, "confidence": float, "dur_s": float}
            """
            pcm_bytes = await file.read()
            wav_np = _pcm16_bytes_to_float32(pcm_bytes, channels)
            wav_np = _maybe_resample(wav_np, sample_rate, target_sr=16000)

            results = self._run_lid([(16000, wav_np)])
            return JSONResponse(results[0])

        @web_app.post("/identify/base64")
        async def identify_base64(payload: dict):
            """
            POST JSON with base64-encoded audio:
            {
              "audio_b64": "<base64>",
              "format":    "wav" | "pcm16"  (default "wav"),
              "sample_rate": 16000,          (only for pcm16)
              "channels":    1               (only for pcm16)
            }
            Returns: {"lang": str, "confidence": float, "dur_s": float}
            """
            import numpy as np
            import soundfile as sf

            audio_b64 = payload.get("audio_b64", "")
            fmt = payload.get("format", "wav")
            try:
                raw = base64.b64decode(audio_b64)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid base64 data")

            if fmt == "wav":
                buf = io.BytesIO(raw)
                wav_np, sr = sf.read(buf, dtype="float32", always_2d=False)
                if wav_np.ndim == 2:
                    wav_np = wav_np.mean(axis=1)
                wav_np = _maybe_resample(wav_np, sr, target_sr=16000)
            elif fmt == "pcm16":
                sr = int(payload.get("sample_rate", 16000))
                channels = int(payload.get("channels", 1))
                wav_np = _pcm16_bytes_to_float32(raw, channels)
                wav_np = _maybe_resample(wav_np, sr, target_sr=16000)
            else:
                raise HTTPException(status_code=400, detail="format must be 'wav' or 'pcm16'")

            results = self._run_lid([(16000, wav_np)])
            return JSONResponse(results[0])

        return web_app


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def _pcm16_bytes_to_float32(pcm_bytes: bytes, channels: int = 1):
    """Convert raw PCM16 LE bytes to a float32 mono numpy array in [-1, 1]."""
    import numpy as np

    n_samples = len(pcm_bytes) // 2
    wav_np = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        wav_np = wav_np.reshape(-1, channels).mean(axis=1)
    return wav_np


def _maybe_resample(wav_np, src_sr: int, target_sr: int = 16000):
    """Resample audio if src_sr != target_sr using torchaudio."""
    if src_sr == target_sr:
        return wav_np
    import numpy as np
    import torch
    import torchaudio

    tensor = torch.from_numpy(wav_np).unsqueeze(0)  # (1, N)
    resampled = torchaudio.functional.resample(tensor, src_sr, target_sr)
    return resampled.squeeze(0).numpy()


# ---------------------------------------------------------------------------
# Local entrypoint for quick testing
# ---------------------------------------------------------------------------

@app.local_entrypoint()
def test(
    audio_path: str = "",
    sample_rate: int = 16000,
):
    """
    Quick smoke test.
      modal run fireredlid_modal.py
      modal run fireredlid_modal.py --audio-path /path/to/audio.wav
    """
    import os

    lid = LID()

    if audio_path and os.path.exists(audio_path):
        print(f"Testing with WAV file: {audio_path}")
        with open(audio_path, "rb") as f:
            wav_bytes = f.read()
        result = lid.identify_wav_bytes.remote(wav_bytes)
    else:
        # Generate 2 seconds of silence as a fallback test
        print("No audio path provided – using 2s of silence as test input.")
        import struct
        n_samples = 16000 * 2
        pcm_bytes = struct.pack(f"<{n_samples}h", *([0] * n_samples))
        result = lid.identify_pcm.remote(pcm_bytes, sample_rate=16000, channels=1)

    print("LID result:", result)
