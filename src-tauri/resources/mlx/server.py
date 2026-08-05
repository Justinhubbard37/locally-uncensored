"""MLX-Stable-Diffusion FastAPI sidecar.

Run by `commands::mlx::mlx_start` once the install slot has filled the
venv. Hosts a single POST /generate endpoint that the bridge proxies for
the web UI.

Model-agnostic: every request carries the full load config (repo, dtype,
fp16 variant, cfg kwarg name) resolved by the bridge from its image
catalog (commands/mlx.rs IMAGE_CATALOG). The sidecar keeps exactly one
pipeline in memory and swaps it out when a request names a different
repo — unified memory can't hold two big pipelines at once.
"""

import base64
import gc
import io
import os
import sys
import threading
import time
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


# Lazy: importing torch + diffusers takes ~3 s on a cold start. We defer
# it until the first request so /health stays sub-millisecond, which the
# bridge uses for the "is the MLX server up?" probe in mlx_status.
_pipe = None
_pipe_repo = None
# One lock guards every pipeline mutation (load / release / generate) so the
# idle-unload thread can't free the model out from under an in-flight request,
# and two concurrent requests can't both trigger a load.
_pipe_lock = threading.RLock()
_last_activity = time.monotonic()

# A resident image pipeline pins multiple GB of unified memory. On a local
# machine that must not linger forever after the user walks away, so a
# background thread releases it once idle. 0 disables (set via env for tests).
IDLE_UNLOAD_SECONDS = int(os.environ.get("LU_MLX_IDLE_UNLOAD_SECONDS", "600"))


def _release_pipe():
    global _pipe, _pipe_repo
    with _pipe_lock:
        if _pipe is None:
            return
        import torch

        _pipe = None
        _pipe_repo = None
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()


def _idle_unload_loop():
    """Free the resident pipeline after IDLE_UNLOAD_SECONDS of no requests.
    Keeps the server itself up (fast to reload), just drops the weights."""
    while True:
        time.sleep(30)
        if IDLE_UNLOAD_SECONDS <= 0 or _pipe is None:
            continue
        if time.monotonic() - _last_activity >= IDLE_UNLOAD_SECONDS:
            _release_pipe()


def _ensure_pipe(
    repo: str,
    dtype: str,
    variant: Optional[str],
    disable_safety_checker: bool,
    local_files_only: bool = False,
):
    global _pipe, _pipe_repo
    # Caller already holds _pipe_lock.
    if _pipe is not None and _pipe_repo == repo:
        return _pipe
    _release_pipe()

    import torch
    from diffusers import AutoPipelineForText2Image

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    torch_dtype = torch.float32
    if device == "mps":
        torch_dtype = torch.bfloat16 if dtype == "bfloat16" else torch.float16

    kwargs = {"torch_dtype": torch_dtype}
    # A model the app already installed must load from disk alone. Without
    # this, diffusers re-validates all ~18 files against the hub on every
    # load: measured at 26 s per already-present file when the hub throttles
    # anonymous traffic, and an outright failure with no network — so "local"
    # image generation silently depended on being online.
    if local_files_only:
        kwargs["local_files_only"] = True
    if variant:
        kwargs["variant"] = variant
    if disable_safety_checker:
        # SD1.5 repos bundle a safety_checker component; skipping it here
        # also means the install never had to download its weights.
        kwargs["safety_checker"] = None
        kwargs["requires_safety_checker"] = False

    # No attention/VAE slicing here: on torch 2.12 + MPS it corrupts the
    # forward pass into all-NaN latents (verified live — plain runs are
    # clean, sliced runs decode to black frames).
    _pipe = AutoPipelineForText2Image.from_pretrained(repo, **kwargs).to(device)
    _pipe_repo = repo
    return _pipe


app = FastAPI(title="LU MLX server")


class GenerateRequest(BaseModel):
    prompt: str
    steps: int = 4
    seed: Optional[int] = None
    width: int = 512
    height: int = 512
    negative_prompt: Optional[str] = None
    # Model config resolved by the bridge catalog. Defaults keep the
    # historical sd-turbo behaviour for old callers.
    model_repo: str = "stabilityai/sd-turbo"
    dtype: str = "float16"
    variant: Optional[str] = "fp16"
    guidance: float = 0.0
    cfg_param: str = "guidance_scale"
    disable_safety_checker: bool = False
    # Set by the bridge when it has verified the model is fully on disk.
    local_files_only: bool = False


@app.get("/health")
def health():
    idle = None if _pipe is None else round(time.monotonic() - _last_activity, 1)
    return {
        "ok": True,
        "model_loaded": _pipe is not None,
        "model_repo": _pipe_repo,
        "idle_seconds": idle,
        "idle_unload_seconds": IDLE_UNLOAD_SECONDS,
    }


@app.post("/unload")
def unload():
    """Free the resident model now, keeping the server up. Idempotent — the
    bridge's `mlx_unload` calls this so the UI can reclaim memory on demand."""
    was_loaded = _pipe is not None
    _release_pipe()
    return {"ok": True, "was_loaded": was_loaded}


@app.post("/generate")
def generate(req: GenerateRequest):
    global _last_activity
    import torch

    with _pipe_lock:
        try:
            pipe = _ensure_pipe(
                req.model_repo,
                req.dtype,
                req.variant,
                req.disable_safety_checker,
                req.local_files_only,
            )
        except Exception as exc:
            # A half-loaded pipeline must not shadow the previous model.
            _release_pipe()
            raise HTTPException(status_code=500, detail=f"pipeline init: {exc}") from exc

        # MPS generators are unstable; seeds work better via a CPU generator.
        generator = None
        if req.seed is not None:
            generator = torch.Generator(device="cpu").manual_seed(req.seed)

        gen_kwargs = {
            "prompt": req.prompt,
            "num_inference_steps": req.steps,
            "width": req.width,
            "height": req.height,
            "generator": generator,
            # Turbo/distilled models want 0.0 here; regular models their CFG.
            # Qwen-Image reads "true_cfg_scale" instead of "guidance_scale".
            req.cfg_param: req.guidance,
        }
        if req.negative_prompt:
            gen_kwargs["negative_prompt"] = req.negative_prompt

        try:
            result = pipe(**gen_kwargs)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"generate: {exc}") from exc
        finally:
            # Reset the idle clock AFTER the work, so a slow generation can't be
            # unloaded mid-run and the countdown starts from completion.
            _last_activity = time.monotonic()

    img = result.images[0]
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {
        "image_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": req.width,
        "height": req.height,
        "steps": req.steps,
        "model_repo": req.model_repo,
    }


if __name__ == "__main__":
    port = int(os.environ.get("LU_MLX_PORT", "47712"))
    threading.Thread(target=_idle_unload_loop, daemon=True).start()
    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    except KeyboardInterrupt:
        sys.exit(0)
