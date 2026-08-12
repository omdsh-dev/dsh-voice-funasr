#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-voice-funasr model downloader.

Downloads the three official int8 (quantized) ONNX models into
<model-root>/{paraformer,vad,punc}. Prints one JSON object per line on
stdout so the host plugin can relay progress to the settings panel:

  {"stage": "downloading"|"done"|"error", "model": "asr|vad|punc",
   "downloaded_mb": float, "total_mb": float, "error"?: str}
  {"type": "summary", "ok": bool, "model_root": str, "sizes_mb": {...}, "error"?: str}

Usage:
  python download_models.py --model-root ~/.dsh/voice-funasr/models
"""

import argparse
import json
import os
import sys

MODELS = {
    "asr": "damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx",
    "vad": "damo/speech_fsmn_vad_zh-cn-16k-common-onnx",
    "punc": "damo/punc_ct-transformer_zh-cn-common-vocab272727-onnx",
}


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description="download FunASR int8 onnx models")
    parser.add_argument("--model-root", default=os.path.join(os.path.expanduser("~"), ".dsh", "voice-funasr", "models"))
    args = parser.parse_args()

    try:
        from modelscope import snapshot_download
    except ImportError:
        emit({"type": "summary", "ok": False, "model_root": args.model_root,
              "error": "modelscope not installed — run: pip install modelscope"})
        sys.exit(1)

    os.makedirs(args.model_root, exist_ok=True)
    sizes = {}
    for kind, model_id in MODELS.items():
        target = os.path.join(args.model_root, kind)
        emit({"stage": "downloading", "model": kind, "downloaded_mb": 0, "total_mb": 0})
        try:
            # ModelScope's own byte progress goes to stderr; the host relays
            # it alongside coarse per-model stage markers on stdout.
            snapshot_download(model_id, local_dir=target)
            total = 0.0
            for name in os.listdir(target):
                if name.endswith(".onnx") or name.endswith(".onnx.data"):
                    total += os.path.getsize(os.path.join(target, name)) / 1e6
            sizes[kind] = round(total, 1)
            emit({"stage": "done", "model": kind, "downloaded_mb": round(total, 1), "total_mb": round(total, 1)})
        except Exception as exc:  # noqa: BLE001
            emit({"stage": "error", "model": kind, "downloaded_mb": 0, "total_mb": 0, "error": str(exc)})
            emit({"type": "summary", "ok": False, "model_root": args.model_root, "sizes_mb": sizes,
                  "error": f"{kind} failed: {exc}"})
            sys.exit(1)

    emit({"type": "summary", "ok": True, "model_root": args.model_root, "sizes_mb": sizes})


if __name__ == "__main__":
    main()
