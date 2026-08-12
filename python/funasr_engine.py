#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-voice-funasr local ASR engine.

A stdio line-JSON server keeping FunASR models resident in memory.
Runtime: funasr-onnx + onnxruntime ONLY (no torch). Official int8
(quantized) models: paraformer-large / FSMN-VAD / ct-punc.

Protocol (one JSON object per line, both directions):
  request  -> {"action": "...", "id": <int|string>, ...fields}
  response <- {"id": <same>, "ok": bool, "error"?: str, ...fields}

Actions:
  status      -> engine/module health + which model dirs are missing
  transcribe  -> {"audio": {"pcm16_base64": str, "sample_rate": 16000},
                  "vad": bool, "punc": bool}  -> {"text": str, "elapsed_ms": int}
  stats       -> cumulative transcription counters
  cleanup     -> gc.collect()
  exit        -> terminate loop

Startup: the first stdout line is {"type": "boot", "ok": bool, ...} so the
parent can detect readiness before sending requests. Model loading happens
lazily on first transcribe (or eagerly if --eager is passed) so a missing
model is reported per-action, not at boot.
"""

import argparse
import base64
import gc
import json
import os
import sys
import time
import traceback

MODEL_SUBDIRS = {
    "asr": "paraformer",   # paraformer-large int8 onnx
    "vad": "vad",          # FSMN-VAD int8 onnx
    "punc": "punc",        # ct-punc int8 onnx
}

VERSION = "0.1.0"


def log(msg: str) -> None:
    sys.stderr.write(f"[funasr-engine] {msg}\n")
    sys.stderr.flush()


class Engine:
    def __init__(self, model_root: str, eager: bool = False, threads: int = 4):
        self.model_root = model_root
        self.eager = eager
        self.threads = threads
        self.models = {}          # name -> loaded model instance
        self.requests_total = 0
        self.audio_seconds_total = 0.0

    # ---- model management -------------------------------------------------

    def model_dir(self, kind: str) -> str:
        return os.path.join(self.model_root, MODEL_SUBDIRS[kind])

    def is_ready(self, kind: str) -> bool:
        d = self.model_dir(kind)
        return os.path.isdir(d) and any(
            name.endswith(".onnx") for name in os.listdir(d)
        )

    def missing(self):
        return [k for k in MODEL_SUBDIRS if not self.is_ready(k)]

    def load(self, kind: str):
        if kind in self.models:
            return self.models[kind]
        from funasr_onnx import Paraformer, Fsmn_vad, CT_Transformer
        classes = {"asr": Paraformer, "vad": Fsmn_vad, "punc": CT_Transformer}
        d = self.model_dir(kind)
        if not self.is_ready(kind):
            raise RuntimeError(f"model files missing for {kind} under {d}")
        t0 = time.time()
        cls = classes[kind]
        if kind == "punc":
            model = cls(d, quantize=True)
        else:
            model = cls(d, batch_size=1, quantize=True, intra_op_num_threads=self.threads)
        self.models[kind] = model
        log(f"{kind} model loaded in {time.time() - t0:.1f}s from {d}")
        return model

    # ---- actions ----------------------------------------------------------

    def status(self):
        import importlib.metadata
        try:
            version = importlib.metadata.version("funasr-onnx")
        except Exception:
            version = "unknown"
        return {
            "ok": True,
            "engine_version": VERSION,
            "funasr_onnx_version": version,
            "model_root": self.model_root,
            "models": {
                kind: {"ready": self.is_ready(kind), "loaded": kind in self.models,
                       "dir": self.model_dir(kind)}
                for kind in MODEL_SUBDIRS
            },
            "missing": self.missing(),
        }

    def transcribe(self, audio: dict, vad: bool = True, punc: bool = True):
        t0 = time.time()
        pcm = base64.b64decode(audio.get("pcm16_base64", ""))
        if not pcm:
            raise ValueError("empty pcm16_base64")
        rate = int(audio.get("sample_rate", 16000))
        seconds = len(pcm) / 2 / rate
        self.audio_seconds_total += seconds
        if len(pcm) < int(rate * 2 * 0.3):
            return {"ok": True, "text": "", "elapsed_ms": int((time.time() - t0) * 1000)}

        tmp_paths = []

        def wav_path(samples_bytes):
            import tempfile
            import wave as _wave
            fd, path = tempfile.mkstemp(suffix=".wav", prefix="funasr-")
            os.close(fd)
            with _wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes(samples_bytes)
            tmp_paths.append(path)
            return path

        try:
            asr = self.load("asr")
            full_path = wav_path(pcm)
            if vad and self.is_ready("vad"):
                vad_model = self.load("vad")
                raw_segments = vad_model([full_path])
                ranges = []
                try:
                    for pair in raw_segments[0] if raw_segments else []:
                        if isinstance(pair, dict):
                            pair = pair.get("value", pair)
                        if isinstance(pair, (list, tuple)) and len(pair) == 2:
                            ranges.append(pair)
                except Exception:
                    ranges = []
                if not ranges:
                    return {"ok": True, "text": "", "elapsed_ms": int((time.time() - t0) * 1000)}
                texts = []
                for beg_ms, end_ms in ranges:
                    i0 = int(beg_ms / 1000 * rate) * 2
                    i1 = min(len(pcm), int(end_ms / 1000 * rate) * 2)
                    if i1 - i0 < int(rate * 2 * 0.3):
                        continue
                    texts.append(self._asr(asr, wav_path(pcm[i0:i1])))
                raw = "".join(texts)
            else:
                raw = self._asr(asr, full_path)
        finally:
            for path in tmp_paths:
                try:
                    os.unlink(path)
                except OSError:
                    pass

        text = raw
        if punc and self.is_ready("punc") and raw.strip():
            punc_model = self.load("punc")
            try:
                # funasr_onnx CT_Transformer takes a plain string and returns
                # ["punctuated text", [marks...]]
                res = punc_model(raw)
                if res and isinstance(res[0], str):
                    text = res[0]
            except Exception as exc:  # punc failure is non-fatal
                log(f"punc failed, keeping raw text: {exc}")

        self.requests_total += 1
        return {
            "ok": True,
            "text": text,
            "raw_text": raw,
            "duration_s": round(seconds, 2),
            "elapsed_ms": int((time.time() - t0) * 1000),
        }

    @staticmethod
    def _asr(model, wav_path):
        res = model([wav_path])
        if not res:
            return ""
        first = res[0]
        if isinstance(first, dict):
            # funasr_onnx Paraformer returns {"preds": ["text", [tokens...]]}
            if "text" in first:
                return first.get("text", "")
            preds = first.get("preds") or []
            if preds and isinstance(preds[0], str):
                return preds[0]
            return str(first)
        return str(first)

    def stats(self):
        return {
            "ok": True,
            "requests_total": self.requests_total,
            "audio_seconds_total": round(self.audio_seconds_total, 2),
            "models_loaded": sorted(self.models.keys()),
        }

    def warmup(self):
        t0 = time.time()
        loaded = {}
        for kind in MODEL_SUBDIRS:
            if not self.is_ready(kind):
                continue
            try:
                self.load(kind)
                loaded[kind] = "loaded"
            except Exception as exc:
                loaded[kind] = f"failed: {exc}"
        return {
            "ok": True,
            "loaded": loaded,
            "elapsed_ms": int((time.time() - t0) * 1000),
        }

    # ---- main loop --------------------------------------------------------

    def handle(self, msg: dict):
        action = msg.get("action")
        req_id = msg.get("id")
        if action == "status":
            return self.status()
        if action == "transcribe":
            try:
                return self.transcribe(msg.get("audio") or {}, msg.get("vad", True), msg.get("punc", True))
            except Exception as exc:
                log(traceback.format_exc())
                return {"ok": False, "error": str(exc)}
        if action == "stats":
            return self.stats()
        if action == "warmup":
            return self.warmup()
        if action == "cleanup":
            gc.collect()
            return {"ok": True, "message": "cleanup done"}
        if action == "exit":
            return None  # signal to stop the loop
        return {"ok": False, "error": f"unknown action: {action!r}", "_req": req_id}

    def run(self):
        boot = {"type": "boot", "ok": True, "missing": self.missing(),
                "model_root": self.model_root}
        print(json.dumps(boot, ensure_ascii=False), flush=True)
        if self.eager:
            for kind in MODEL_SUBDIRS:
                if self.is_ready(kind):
                    try:
                        self.load(kind)
                    except Exception as exc:
                        log(f"eager load {kind} failed: {exc}")
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                print(json.dumps({"ok": False, "error": "invalid JSON line"}, ensure_ascii=False), flush=True)
                continue
            req_id = msg.get("id")
            try:
                result = self.handle(msg)
            except Exception as exc:
                log(traceback.format_exc())
                result = {"ok": False, "error": str(exc)}
            if result is None:
                print(json.dumps({"id": req_id, "ok": True, "message": "bye"}, ensure_ascii=False), flush=True)
                return
            if "id" not in result:
                result = {"id": req_id, **result}
            print(json.dumps(result, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description="dsh-voice-funasr local ASR engine")
    parser.add_argument("--model-root", default=os.environ.get("FUNASR_MODEL_ROOT"),
                        help="root dir containing paraformer/vad/punc subdirs")
    parser.add_argument("--eager", action="store_true", help="load models at boot")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if not args.model_root:
        home = os.path.expanduser("~")
        args.model_root = os.path.join(home, ".dsh", "voice-funasr", "models")
    engine = Engine(args.model_root, eager=args.eager, threads=args.threads)
    engine.run()


if __name__ == "__main__":
    main()
