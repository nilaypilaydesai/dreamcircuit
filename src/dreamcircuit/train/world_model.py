"""Train the diffusion world model.

    dreamcircuit train-wm --config configs/wm_base.toml

Resumes automatically from ``<run>/latest.pt``. Every ``eval_every`` steps the EMA model dreams
3-second rollouts on held-out circuits from real context frames and real action sequences; PSNR
against the true simulator frames at several horizons goes to ``eval.csv`` and a filmstrip
(truth row over dream row) to ``samples/``.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, cast

import numpy as np
import torch
from PIL import Image

from dreamcircuit.data.dataset import EpisodeStore, Prefetcher, WindowSampler, to_tensor, to_uint8
from dreamcircuit.model.edm import EDMConfig, WorldModel, count_params, estimate_macs
from dreamcircuit.model.unet import UNetConfig
from dreamcircuit.train.common import (
    EMA,
    CSVLogger,
    cosine_lr,
    dataclass_from,
    load_toml,
    pick_device,
    save_checkpoint,
)

EVAL_HORIZONS = (1, 5, 15, 30, 45)


def build_model(cfg: dict[str, Any]) -> WorldModel:
    ucfg = dataclass_from(UNetConfig, {**cfg["model"], "in_frames": cfg["model"]["context"]})
    return WorldModel(ucfg, dataclass_from(EDMConfig, cfg.get("edm", {})))


def load_world_model(
    path: str | Path, device: torch.device | str = "cpu", ema: bool = True
) -> tuple[WorldModel, dict[str, Any]]:
    ck = torch.load(path, map_location="cpu", weights_only=False)
    model = build_model(ck["config"])
    model.load_state_dict(ck["ema" if ema else "model"])
    return model.to(device).eval(), ck


def psnr(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Per-sample PSNR (dB) for tensors in [-1, 1] with leading batch dims."""
    mse = ((a - b) ** 2).flatten(-3).mean(-1) / 4.0  # rescale to [0, 1] range
    return -10 * torch.log10(mse.clamp_min(1e-10))


@torch.no_grad()
def evaluate_rollouts(
    model: WorldModel,
    store: EpisodeStore,
    device: torch.device,
    n: int = 16,
    horizon: int = 45,
    steps: int = 3,
    seed: int = 123,
) -> tuple[dict[str, float], np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    l = model.context_frames
    e = rng.choice(store.n_episodes, n, replace=False)
    k = rng.integers(0, store.n_frames - l - horizon, n)
    t = k[:, None] + np.arange(l + horizon)[None, :]
    frames = to_tensor(store.frames[e[:, None], t], device)  # (n, L+H, 3, 64, 64)
    acts = torch.from_numpy(np.asarray(store.actions[e[:, None], t[:, :-1]])).to(device)
    torch.manual_seed(seed)
    dream = model.rollout(frames[:, :l], acts[:, : l - 1], acts[:, l - 1 :], steps=steps)
    truth = frames[:, l:]
    p = psnr(dream, truth).mean(0).cpu().numpy()  # (H,)
    copy_last = psnr(frames[:, l - 1 : l].expand_as(truth), truth).mean(0).cpu().numpy()
    metrics = {f"psnr@{h}": float(p[h - 1]) for h in EVAL_HORIZONS if h <= horizon}
    metrics.update({f"copy@{h}": float(copy_last[h - 1]) for h in EVAL_HORIZONS if h <= horizon})
    return metrics, to_uint8(truth[:4]), to_uint8(dream[:4])


def filmstrip(
    truth: np.ndarray, dream: np.ndarray, picks: tuple[int, ...] = (0, 4, 9, 14, 19, 29, 44)
) -> Image.Image:
    rows = []
    for i in range(truth.shape[0]):
        rows.append(np.concatenate([truth[i, j] for j in picks if j < truth.shape[1]], axis=1))
        rows.append(np.concatenate([dream[i, j] for j in picks if j < dream.shape[1]], axis=1))
        rows.append(np.full((2, rows[-1].shape[1], 3), 255, np.uint8))
    img = np.concatenate(rows, axis=0)
    return Image.fromarray(img).resize(
        (img.shape[1] * 3, img.shape[0] * 3), Image.Resampling.NEAREST
    )


def train(
    config_path: str | Path, run_dir: str | Path | None = None, max_steps: int | None = None
) -> Path:
    cfg = load_toml(config_path)
    tc = cfg["train"]
    run = Path(run_dir or tc.get("run_dir", f"runs/{Path(config_path).stem}"))
    (run / "samples").mkdir(parents=True, exist_ok=True)
    (run / "config.json").write_text(json.dumps(cfg, indent=2))
    device = pick_device(tc.get("device", "auto"))
    torch.manual_seed(tc.get("seed", 0))

    model = build_model(cfg).to(device)
    ema = EMA(model, tc["ema"])
    opt = torch.optim.AdamW(
        model.parameters(), lr=tc["lr"], weight_decay=tc["weight_decay"], betas=(0.9, 0.99)
    )
    step = 0
    latest = run / "latest.pt"
    if latest.exists():
        ck = torch.load(latest, map_location="cpu", weights_only=False)
        model.load_state_dict(ck["model"])
        ema.model.load_state_dict(ck["ema"])
        opt.load_state_dict(ck["opt"])
        step = ck["step"]
        print(f"resumed from step {step}")
    total = tc["steps"] if max_steps is None else min(tc["steps"], max_steps)
    print(
        f"world model: {count_params(model) / 1e6:.2f}M params, "
        f"{estimate_macs(build_model(cfg)) / 1e9:.2f} GMACs per denoiser call, device {device}"
    )

    store = EpisodeStore(tc["data"])
    test_store = EpisodeStore(tc["test_data"]) if tc.get("test_data") else store
    pre = Prefetcher(
        WindowSampler(store, model.context_frames, tc["batch_size"], seed=tc.get("seed", 0) + step)
    )
    log = CSVLogger(run / "train.csv", ["step", "loss", "lr", "grad_norm", "steps_per_s"])
    ev_cols = ["step"] + [f"{m}@{h}" for m in ("psnr", "copy") for h in EVAL_HORIZONS]
    elog = CSVLogger(run / "eval.csv", ev_cols)

    model.train()
    t0 = time.time()
    loss_sum = torch.zeros((), device=device)  # accumulate on-device: no per-step GPU sync
    while step < total:
        frames_np, actions_np = pre.next()
        frames = to_tensor(frames_np, device)
        actions = torch.from_numpy(actions_np).to(device)
        lr = cosine_lr(step, tc["lr"], tc["warmup"], tc["steps"])
        for g in opt.param_groups:
            g["lr"] = lr
        loss = model.loss(frames[:, -1], frames[:, :-1], actions)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        gn = torch.nn.utils.clip_grad_norm_(model.parameters(), tc["grad_clip"])
        opt.step()
        ema.update(model, step)
        step += 1
        loss_sum += loss.detach()

        if step % tc["log_every"] == 0:
            mean_loss = loss_sum.item() / tc["log_every"]
            sps = tc["log_every"] / (time.time() - t0)
            log.log(
                step=step,
                loss=f"{mean_loss:.5f}",
                lr=f"{lr:.2e}",
                grad_norm=f"{float(gn):.3f}",
                steps_per_s=f"{sps:.2f}",
            )
            print(f"step {step:6d}  loss {mean_loss:.4f}  lr {lr:.2e}  {sps:.2f} it/s", flush=True)
            t0 = time.time()
            loss_sum.zero_()
        if step % tc["eval_every"] == 0 or step == total:
            metrics, truth, dream = evaluate_rollouts(
                cast(WorldModel, ema.model), test_store, device
            )
            elog.log(step=step, **{k: f"{v:.3f}" for k, v in metrics.items()})
            filmstrip(truth, dream).save(run / "samples" / f"step_{step:06d}.png")
            print(
                "eval", step, json.dumps({k: round(v, 2) for k, v in metrics.items()}), flush=True
            )
            model.train()
            t0 = time.time()
        if step % tc["ckpt_every"] == 0 or step == total:
            state = {
                "model": model.state_dict(),
                "ema": ema.model.state_dict(),
                "opt": opt.state_dict(),
                "step": step,
                "config": cfg,
            }
            save_checkpoint(latest, **state)
            if step % (tc["ckpt_every"] * 2) == 0 or step == total:
                save_checkpoint(run / f"ckpt_{step:06d}.pt", **{**state, "opt": None})
    pre.close()
    return run
