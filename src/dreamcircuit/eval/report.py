"""Run every evaluation on a checkpoint and publish the results.

    dreamcircuit report --checkpoint runs/wm_base/latest.pt

Writes
    results/*.json                    raw numbers (audit, probes, steering, autopilot)
    docs/assets/*_{light,dark}.png    README figures, one variant per GitHub theme
    docs/assets/*.gif                 animations (reality vs dream, counterfactuals)
    web/public/results/summary.json   what the website's charts and cards render
    web/public/models/probes.json     the "edit the dream's mind" slider directions

Chart colors are the validated reference palette (categorical slots 1-3, which pass the
all-pairs CVD checks in both modes; see the dataviz notes in docs/DESIGN.md).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw

from dreamcircuit.config import DEFAULT
from dreamcircuit.data.dataset import EpisodeStore, to_tensor, to_uint8
from dreamcircuit.eval.audit import COUNTERFACTUALS, run_audit
from dreamcircuit.eval.probes import LABELS, browser_directions, run_probes, steering_experiment
from dreamcircuit.model.edm import count_params, estimate_macs
from dreamcircuit.train.common import pick_device
from dreamcircuit.train.world_model import build_model, load_world_model

HZ = 1.0 / DEFAULT.dt

THEMES = {
    "light": {
        "surface": "#ffffff",
        "ink": "#0b0b0b",
        "ink2": "#52514e",
        "muted": "#898781",
        "grid": "#e1e0d9",
        "axis": "#c3c2b7",
        "series": ["#2a78d6", "#eb6834", "#1baf7a"],
        "neutral": "#898781",
    },
    "dark": {
        "surface": "#0d1117",
        "ink": "#ffffff",
        "ink2": "#c3c2b7",
        "muted": "#898781",
        "grid": "#2c2c2a",
        "axis": "#383835",
        "series": ["#3987e5", "#d95926", "#199e70"],
        "neutral": "#898781",
    },
}


# ------------------------------------------------------------------------------- figures


def _axes(fig: Any, t: dict, title: str, subtitle: str) -> Any:
    import matplotlib as mpl

    mpl.rcParams["font.family"] = "sans-serif"
    mpl.rcParams["font.sans-serif"] = [
        "Inter",
        "Helvetica Neue",
        "Helvetica",
        "Arial",
        "DejaVu Sans",
    ]
    ax = fig.add_axes((0.11, 0.15, 0.85, 0.66))
    fig.patch.set_facecolor(t["surface"])
    ax.set_facecolor(t["surface"])
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(t["axis"])
        ax.spines[side].set_linewidth(1)
    ax.tick_params(colors=t["muted"], labelsize=9, length=0, pad=6)
    ax.grid(True, color=t["grid"], linewidth=1)
    ax.set_axisbelow(True)
    fig.text(0.11, 0.93, title, color=t["ink"], fontsize=13, fontweight="bold")
    fig.text(0.11, 0.875, subtitle, color=t["ink2"], fontsize=9.5)
    return ax


def _save(fig: Any, path: Path) -> None:
    fig.savefig(path, dpi=200, facecolor=fig.get_facecolor())
    import matplotlib.pyplot as plt

    plt.close(fig)


def figure_fidelity(audit: dict, out: Path) -> None:
    import matplotlib.pyplot as plt

    f = audit["fidelity"]
    h = np.arange(1, f["horizon"] + 1) / HZ
    series = [("Dream (2 denoising steps)", f["steps_2"]["psnr"], 0)]
    for mode, t in THEMES.items():
        fig = plt.figure(figsize=(7.2, 4.0))
        ax = _axes(
            fig,
            t,
            "Dream fidelity on circuits the model never saw",
            "PSNR to the true future frames, rolled out from 4 real frames and the real controls",
        )
        ax.plot(h, f["copy_last"]["psnr"], color=t["neutral"], lw=2, solid_capstyle="round")
        ax.annotate(
            "Baseline: copy the last frame",
            (h[-1], f["copy_last"]["psnr"][-1]),
            xytext=(6, -8),
            textcoords="offset points",
            color=t["ink2"],
            fontsize=9,
            va="center",
        )
        for label, ys, slot in series:
            ax.plot(h, ys, color=t["series"][slot], lw=2, solid_capstyle="round")
            ax.annotate(
                label,
                (h[-1], ys[-1]),
                xytext=(6, 8),
                textcoords="offset points",
                color=t["ink2"],
                fontsize=9,
                va="center",
            )
        ax.set_xlabel("Seconds into the dream", color=t["muted"], fontsize=9)
        ax.set_ylabel("PSNR (dB)", color=t["muted"], fontsize=9)
        ax.set_xlim(0, h[-1])
        fig.axes[0].set_position((0.09, 0.15, 0.62, 0.66))
        _save(fig, out / f"fidelity_{mode}.png")


def figure_controllability(audit: dict, out: Path) -> None:
    import matplotlib.pyplot as plt

    fut = audit["controllability"]["futures"]
    for mode, t in THEMES.items():
        fig = plt.figure(figsize=(7.2, 4.6))
        ax = _axes(
            fig,
            t,
            "Steer the dream and it turns like the real car",
            "Same 4 starting frames, three steering commands held for 1 s. "
            "Yaw rate read from pixels.",
        )
        lim = 0.0
        for slot, name in enumerate(("left", "straight", "right")):
            xr, yd = np.array(fut[name]["yaw_rate_real"]), np.array(fut[name]["yaw_rate_dream"])
            lim = max(lim, np.abs(xr).max(), np.abs(yd).max())
            ax.scatter(
                xr,
                yd,
                s=36,
                color=t["series"][slot],
                edgecolors=t["surface"],
                linewidths=2,
                label=f"Steer {name}",
                zorder=3,
            )
        lim *= 1.1
        ax.plot([-lim, lim], [-lim, lim], color=t["axis"], lw=1, zorder=1)
        ax.text(
            lim * 0.42,
            lim * 0.30,
            "dream = reality",
            color=t["muted"],
            fontsize=8.5,
            ha="left",
            rotation=0,
        )
        ax.set_xlim(-lim, lim)
        ax.set_ylim(-lim, lim)
        ax.set_xlabel("Real simulator yaw rate (rad/s)", color=t["muted"], fontsize=9)
        ax.set_ylabel("Dreamed yaw rate (rad/s)", color=t["muted"], fontsize=9)
        leg = ax.legend(loc="upper left", frameon=False, fontsize=9)
        for txt in leg.get_texts():
            txt.set_color(t["ink2"])
        _save(fig, out / f"controllability_{mode}.png")


def figure_probes(probes: dict, out: Path) -> None:
    import matplotlib.pyplot as plt

    show = [
        "yaw_rate",
        "steer",
        "lateral_speed",
        "curvature_10",
        "curvature_30",
        "offset",
        "heading_error",
    ]
    names = [
        ("trained", "Trained world model"),
        ("raw_pixels", "Raw pixels"),
        ("random_init", "Same network, random weights"),
    ]
    r2 = probes["r2"]
    for mode, t in THEMES.items():
        fig = plt.figure(figsize=(7.2, 5.0))
        ax = _axes(
            fig,
            t,
            "What the network knows that the pixels don't say",
            "Held-out R² of linear probes on the 8x8 bottleneck; higher is better",
        )
        fig.axes[0].set_position((0.36, 0.10, 0.60, 0.72))
        y = np.arange(len(show))[::-1]
        bar_h = 0.24
        for j, (key, label) in enumerate(names):
            vals = [max(r2[s][key], 0.0) for s in show]
            ax.barh(
                y + (1 - j) * (bar_h + 0.03), vals, height=bar_h, color=t["series"][j], label=label
            )
            if key == "trained":
                for yy, v in zip(y, vals, strict=True):
                    ax.text(
                        v + 0.012,
                        yy + bar_h + 0.03,
                        f"{v:.2f}",
                        va="center",
                        fontsize=8.5,
                        color=t["ink2"],
                    )
        ax.set_yticks(y)
        ax.set_yticklabels([LABELS[s] for s in show], color=t["ink2"], fontsize=9)
        ax.set_xlim(0, 1.0)
        ax.grid(axis="y", visible=False)
        leg = ax.legend(loc="lower right", frameon=False, fontsize=8.5)
        for txt in leg.get_texts():
            txt.set_color(t["ink2"])
        _save(fig, out / f"probes_{mode}.png")


def figure_steering(steering: dict, out: Path) -> None:
    import matplotlib.pyplot as plt

    a = np.array(steering["alphas"])
    eff = steering["effects"]["speed"]
    for mode, t in THEMES.items():
        fig = plt.figure(figsize=(7.2, 4.0))
        ax = _axes(
            fig,
            t,
            "Edit one direction in the network, and the dream speeds up",
            "Controls held neutral; the push is added to the bottleneck every step",
        )
        for slot, (key, label) in enumerate(
            (("mass_mean", "Mass-mean direction"), ("ridge", "Ridge-probe direction"))
        ):
            ys = eff[key]["dream_speed"]
            ax.plot(
                a,
                ys,
                color=t["series"][slot],
                lw=2,
                marker="o",
                markersize=7,
                markeredgecolor=t["surface"],
                markeredgewidth=2,
            )
            ax.annotate(
                label,
                (a[-1], ys[-1]),
                xytext=(8, 0),
                textcoords="offset points",
                color=t["ink2"],
                fontsize=9,
                va="center",
            )
        ax.set_xlabel("Push along the speed direction (alpha)", color=t["muted"], fontsize=9)
        ax.set_ylabel("Dreamed speed (m/s)", color=t["muted"], fontsize=9)
        fig.axes[0].set_position((0.09, 0.15, 0.64, 0.66))
        _save(fig, out / f"steering_{mode}.png")


# ------------------------------------------------------------------------------- media


def _save_gif(frames: list[Image.Image], path: Path) -> None:
    """GIF with ONE palette for every frame (per-frame palettes shift colors: yellow cones
    turned orange) and no dithering (flat game colors compress far better without it)."""
    sample = frames[:: max(len(frames) // 24, 1)]
    w, h = sample[0].size
    sheet = Image.new("RGB", (w, h * len(sample)))
    for i, f in enumerate(sample):
        sheet.paste(f, (0, i * h))
    palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    q = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    q[0].save(
        path, save_all=True, append_images=q[1:], duration=round(1000 / HZ), loop=0, optimize=False
    )


def _label(img: Image.Image, text: str, xy: tuple[int, int]) -> None:
    d = ImageDraw.Draw(img)
    x, y = xy
    w = 8 * len(text) + 12
    d.rectangle([x, y, x + w, y + 20], fill=(6, 7, 11))
    d.text((x + 6, y + 4), text, fill=(231, 233, 238))


def gif_reality_vs_dream(
    model: Any,
    store: EpisodeStore,
    device: torch.device,
    out: Path,
    seconds: float = 4.0,
    seed: int = 5,
) -> None:
    """Side-by-side: the simulator (left) and the dream (right) under the same controls,
    open loop. Short on purpose: it shows fidelity, then how the dream drifts."""
    l = model.context_frames
    horizon = int(seconds * HZ)
    rng = np.random.default_rng(seed)
    spd, off = store.feature_index("speed"), store.feature_index("offset")
    while True:
        e = int(rng.integers(store.n_episodes))
        k = int(rng.integers(0, store.n_frames - l - horizon))
        f = np.asarray(store.features[e, k : k + l + horizon])
        if f[:, spd].min() > 6 and np.abs(f[:, off]).max() < DEFAULT.track.half_width:
            break
    t = k + np.arange(l + horizon)
    frames = to_tensor(store.frames[e, t][None], device)
    acts = torch.from_numpy(np.asarray(store.actions[e, t[:-1]])[None]).to(device)
    torch.manual_seed(seed)
    dream = to_uint8(model.rollout(frames[:, :l], acts[:, : l - 1], acts[:, l - 1 :], steps=2))[0]
    real = store.frames[e, t[l:]]
    scale, gap = 3, 8
    size = 64 * scale
    imgs = []
    for i in range(horizon):
        canvas = Image.new("RGB", (2 * size + gap, size), (6, 7, 11))
        canvas.paste(
            Image.fromarray(real[i]).resize((size, size), Image.Resampling.NEAREST), (0, 0)
        )
        canvas.paste(
            Image.fromarray(dream[i]).resize((size, size), Image.Resampling.NEAREST),
            (size + gap, 0),
        )
        _label(canvas, "REALITY", (8, 8))
        _label(canvas, "DREAM", (size + gap + 8, 8))
        imgs.append(canvas)
    _save_gif(imgs, out / "reality_vs_dream.gif")


@torch.no_grad()
def gif_two_worlds(
    model: Any,
    policy: Any,
    store: EpisodeStore,
    device: torch.device,
    out: Path,
    seconds: float = 10.0,
    seed: int = 11,
) -> None:
    """The hero animation. One pixel autopilot, two worlds: it drives the real simulator on
    the left and, closed loop, the world model's own dream on the right."""
    from dreamcircuit.sim.env import RaceEnv
    from dreamcircuit.sim.track import generate_track

    l = model.context_frames
    steps = int(seconds * HZ)
    cars = store.meta["cars_per_track"]
    rng = np.random.default_rng(seed)
    e = int(rng.integers(store.n_episodes))
    track = generate_track(store.meta["track_seeds"][e // cars], DEFAULT.track)
    env = RaceEnv(track, 1)
    env.reset(rng, speed=(11.0, 11.0), lateral_frac=0.0, heading_noise=0.0)
    hist = [env.render()[0]]
    acts = []
    for _ in range(l - 1):  # a few real frames to wake the dream up with
        a = policy(to_tensor(np.stack((hist * l)[-l:])[None], device).flatten(1, 2))
        a = a.cpu().numpy().astype(np.float64)
        env.step(a)
        hist.append(env.render()[0])
        acts.append(a[0])
    ctx = to_tensor(np.stack(hist)[None], device)
    past = torch.from_numpy(np.stack(acts)[None].astype(np.float32)).to(device)
    real_hist = list(hist)
    real, dream = [], []
    torch.manual_seed(seed)
    for _ in range(steps):
        a_real = policy(to_tensor(np.stack(real_hist[-l:])[None], device).flatten(1, 2))
        env.step(a_real.cpu().numpy().astype(np.float64))
        real_hist.append(env.render()[0])
        real.append(real_hist[-1])
        a_dream = policy(ctx.flatten(1, 2))
        nxt = model.sample(ctx, torch.cat([past, a_dream[:, None]], 1), steps=2)
        ctx = torch.cat([ctx[:, 1:], nxt[:, None]], 1)
        past = torch.cat([past[:, 1:], a_dream[:, None]], 1)
        dream.append(to_uint8(nxt)[0])
    scale, gap = 4, 8
    size = 64 * scale
    imgs = []
    for r, d in zip(real, dream, strict=True):
        canvas = Image.new("RGB", (2 * size + gap, size), (6, 7, 11))
        canvas.paste(Image.fromarray(r).resize((size, size), Image.Resampling.NEAREST), (0, 0))
        canvas.paste(
            Image.fromarray(d).resize((size, size), Image.Resampling.NEAREST), (size + gap, 0)
        )
        _label(canvas, "REALITY", (8, 8))
        _label(canvas, "DREAM", (size + gap + 8, 8))
        imgs.append(canvas)
    _save_gif(imgs, out / "two_worlds.gif")


def gif_multiverse(media: Any, out: Path, example: int = 0) -> None:
    """One context, five futures: the dream under five different control sequences."""
    names = list(COUNTERFACTUALS)
    scale, gap = 3, 6
    size = 64 * scale
    n = media[f"cf_{names[0]}_dream"].shape[1]
    imgs = []
    for i in range(n):
        canvas = Image.new("RGB", (len(names) * (size + gap) - gap, size + 26), (6, 7, 11))
        for j, name in enumerate(names):
            fr = media[f"cf_{name}_dream"][example, i]
            canvas.paste(
                Image.fromarray(fr).resize((size, size), Image.Resampling.NEAREST),
                (j * (size + gap), 26),
            )
            ImageDraw.Draw(canvas).text(
                (j * (size + gap) + 4, 6), name.upper(), fill=(167, 139, 250)
            )
        imgs.append(canvas)
    _save_gif(imgs, out / "multiverse.gif")


def png_imagination(
    model: Any, store: EpisodeStore, device: torch.device, out: Path, steps: int = 4, seed: int = 2
) -> None:
    """Noise -> x0 estimate after each denoising step -> final frame."""
    l = model.context_frames
    rng = np.random.default_rng(seed)
    e, k = int(rng.integers(store.n_episodes)), int(rng.integers(l, store.n_frames - 1))
    t = k + np.arange(-l + 1, 1)
    ctx = to_tensor(store.frames[e, t][None], device)
    acts = torch.from_numpy(np.asarray(store.actions[e, t])[None]).to(device)
    torch.manual_seed(seed)
    noise = torch.randn(1, 3, 64, 64, device=device)
    _, traj = model.sample_trajectory(ctx, acts, steps=steps, noise=noise)
    sig_t = model.sigmas(steps, device)
    states, xt = [], noise * sig_t[0]
    for i, x0 in enumerate(traj):  # replay the Euler updates to recover each noisy state
        xt = x0 if sig_t[i + 1] == 0 else xt + (xt - x0) / sig_t[i] * (sig_t[i + 1] - sig_t[i])
        states.append(xt)
    panels = [to_uint8((noise * 0.9).clamp(-1, 1))[0]] + [
        to_uint8(st.clamp(-1, 1))[0] for st in states
    ]
    scale, gap = 3, 10
    size = 64 * scale
    sig = model.sigmas(steps).tolist()
    canvas = Image.new("RGB", (len(panels) * (size + gap) - gap, size + 24), (6, 7, 11))
    for j, p in enumerate(panels):
        canvas.paste(
            Image.fromarray(p).resize((size, size), Image.Resampling.NEAREST),
            (j * (size + gap), 24),
        )
        cap = "pure noise" if j == 0 else f"after step {j}  (noise left {sig[j]:.2f})"
        ImageDraw.Draw(canvas).text((j * (size + gap) + 4, 6), cap, fill=(139, 147, 167))
    canvas.save(out / "imagination.png")


# ------------------------------------------------------------------------------- driver


def _jsonable(x: Any) -> Any:
    if isinstance(x, dict):
        return {k: _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    if isinstance(x, (np.floating, np.integer)):
        return x.item()
    return x


def run_report(
    checkpoint: str | Path,
    policy_result: str | Path = "runs/policy/result.json",
    policy_checkpoint: str | Path = "runs/policy/policy.pt",
    train_root: str = "data/train",
    test_root: str = "data/test",
    results: Path = Path("results"),
    assets: Path = Path("docs/assets"),
    web: Path = Path("web/public"),
    device_name: str = "auto",
    quick: bool = False,
) -> dict:
    device = pick_device(device_name)
    for d in (results, assets, web / "results", web / "models"):
        d.mkdir(parents=True, exist_ok=True)
    model, ck = load_world_model(checkpoint, device)
    scale = 0.25 if quick else 1.0

    audit = run_audit(
        model,
        test_root,
        device,
        results,
        n=int(96 * scale),
        horizon=60,
        n_counterfactual=int(32 * scale),
    )
    torch.manual_seed(0)
    random_model = build_model(ck["config"])
    for p in random_model.parameters():  # a fair random-feature control: no dead zero layers
        if p.abs().sum() == 0:
            torch.nn.init.normal_(p, std=0.02)
    pr = run_probes(
        model,
        random_model.to(device).eval(),
        train_root,
        test_root,
        device,
        results,
        n_train=int(12000 * scale),
        n_test=int(4000 * scale),
    )
    steering = steering_experiment(
        model, pr["probes"], pr["mass_mean"], test_root, device, results, n=int(32 * scale)
    )
    (web / "models" / "probes.json").write_text(
        json.dumps({"directions": browser_directions(pr["mass_mean"])})
    )

    media = np.load(results / "audit_media.npz")
    store = EpisodeStore(test_root)
    gif_reality_vs_dream(model, store, device, assets)
    if Path(policy_checkpoint).exists():
        from dreamcircuit.train.policy import load_policy

        gif_two_worlds(model, load_policy(policy_checkpoint).to(device), store, device, assets)
    gif_multiverse(media, assets)
    png_imagination(model, store, device, assets)
    figure_fidelity(audit, assets)
    figure_controllability(audit, assets)
    figure_probes(pr["results"], assets)
    figure_steering(steering, assets)

    train_meta = EpisodeStore(train_root).meta
    onnx_info = web / "models" / "denoiser.json"
    policy = json.loads(Path(policy_result).read_text()) if Path(policy_result).exists() else None
    summary = {
        "data": {
            "frames": train_meta["n_frames"],
            "circuits": train_meta["n_tracks"],
            "seconds": train_meta["seconds"],
            "grass_fraction": train_meta["grass_fraction"],
        },
        "model": {
            "params_m": count_params(model) / 1e6,
            "gmacs": estimate_macs(build_model(ck["config"])) / 1e9,
            "train_steps": ck["step"],
            "onnx_mb": json.loads(onnx_info.read_text())["bytes"] / 1e6
            if onnx_info.exists()
            else 0.0,
        },
        "audit": audit,
        "probes": pr["results"],
        "steering": {k: v for k, v in steering.items() if k != "directions"},
        "policy": policy,
    }
    summary = _jsonable(summary)
    (results / "summary.json").write_text(json.dumps(summary, indent=1))
    (web / "results" / "summary.json").write_text(json.dumps(summary))
    for name in ("audit.json", "probes.json", "steering.json"):
        shutil.copy(results / name, web / "results" / name)
    return summary
