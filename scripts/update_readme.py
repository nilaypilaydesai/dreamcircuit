"""Regenerate the numbers in README.md from results/summary.json and results/trackgen.json.

Every figure quoted between ``<!-- results:start -->`` and ``<!-- results:end -->`` (and in the
other marked blocks) is computed from the evaluation output, so the README cannot drift from
what the code actually measured. Run after ``make report``:

    python scripts/update_readme.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def block(text: str, name: str, body: str) -> str:
    pat = re.compile(rf"(<!-- {name}:start -->\n).*?(\n<!-- {name}:end -->)", re.S)
    if not pat.search(text):
        raise SystemExit(f"README is missing the {name} block")
    return pat.sub(lambda m: m.group(1) + body + m.group(2), text)


def main() -> None:
    s = json.loads((ROOT / "results" / "summary.json").read_text())
    a = s["audit"]
    f, ph, ctrl = a["fidelity"], a["physics"], a["controllability"]["summary"]
    pr, st, pol = s["probes"]["r2"], s["steering"], s.get("policy")
    hz = 15
    at = {sec: int(sec * hz) - 1 for sec in (0.0667, 1, 2, 4)}

    rows = [
        "| What was measured (held-out circuits) | Dream | Reference |",
        "|---|---|---|",
        f"| Next-frame PSNR | **{f['steps_2']['psnr'][0]:.1f} dB** | "
        f"{f['copy_last']['psnr'][0]:.1f} dB copying the last frame |",
        f"| PSNR after 1 s / 4 s of dreaming | **{f['steps_2']['psnr'][at[1]]:.1f} / "
        f"{f['steps_2']['psnr'][at[4]]:.1f} dB** | {f['copy_last']['psnr'][at[1]]:.1f} / "
        f"{f['copy_last']['psnr'][at[4]]:.1f} dB |",
        f"| Speed error vs. the real car, first second | **{ph['speed_mae_1s']:.2f} m/s** | "
        f"speeds of 6-29 m/s |",
        f"| Dreamed speedometer vs. dreamed motion | **{ph['hud_consistency_mae']['dream']:.2f} "
        f"m/s** | {ph['hud_consistency_mae']['reality']:.2f} m/s instrument floor on real frames |",
        f"| Moments exceeding tyre grip (friction circle) | **"
        f"{100 * ph['friction_violation_rate']['dream']:.1f}%** | "
        f"{100 * ph['friction_violation_rate']['reality']:.1f}% on real frames |",
        f"| Counterfactual steering turns the right way | **"
        f"{100 * ctrl['steer_sign_agreement']:.0f}%** | yaw-rate correlation "
        f"{ctrl['yaw_rate_correlation']:.2f}, response ratio {ctrl['yaw_response_ratio']:.2f} |",
        f"| Throttle vs. brake changes speed the right way | **"
        f"{100 * ctrl['pedal_sign_agreement']:.0f}%** | response ratio "
        f"{ctrl['dv_response_ratio']:.2f} |",
    ]
    probes = [
        "| Linear probe on the bottleneck (held-out R²) | Trained | Raw pixels | Random weights |",
        "|---|---|---|---|",
    ]
    labels = s["probes"]["labels"]
    for k in (
        "yaw_rate",
        "steer",
        "lateral_speed",
        "curvature_10",
        "curvature_30",
        "heading_error",
    ):
        r = pr[k]
        probes.append(
            f"| {labels[k]} | **{r['trained']:.2f}** | {max(r['raw_pixels'], 0):.2f} |"
            f" {max(r['random_init'], 0):.2f} |"
        )
    sp = st["effects"]["speed"]
    steer = (
        f"Pushing the bottleneck along the mass-mean *speed* direction moves the dreamed "
        f"speed from **{sp['mass_mean']['dream_speed'][0]:.1f} m/s** (alpha = "
        f"{st['alphas'][0]:g}) to **{sp['mass_mean']['dream_speed'][-1]:.1f} m/s** (alpha = "
        f"{st['alphas'][-1]:g}) with the controls held neutral. The ridge-probe direction, "
        f"pushed equally hard, moves it from {sp['ridge']['dream_speed'][0]:.1f} to "
        f"{sp['ridge']['dream_speed'][-1]:.1f} m/s."
    )
    text = (ROOT / "README.md").read_text()
    text = block(text, "results", "\n".join(rows))
    text = block(text, "probes", "\n".join(probes))
    text = block(text, "steering", steer)
    if pol:
        p = (
            f"From pixels alone the autopilot laps held-out circuits at "
            f"**{pol['student']['laps_per_min']:.2f} laps/min** "
            f"({100 * pol['student']['laps_per_min'] / pol['teacher']['laps_per_min']:.0f}% of "
            f"its privileged teacher's {pol['teacher']['laps_per_min']:.2f}), off the asphalt "
            f"{100 * pol['student']['grass_fraction']:.1f}% of the time. One round of DAgger cut "
            f"that from {100 * pol['student_bc_only']['grass_fraction']:.1f}%."
        )
        text = block(text, "policy", p)
    m = s["model"]
    stats = (
        f"{m['params_m']:.1f}M parameters · {m['gmacs']:.2f} GMACs per denoising step · "
        f"{m['train_steps']:,} training steps · {m['onnx_mb']:.1f} MB in the browser · "
        f"{s['data']['frames']:,} training frames from {s['data']['circuits']} circuits"
    )
    text = block(text, "stats", stats)
    text = designer_blocks(text)
    (ROOT / "README.md").write_text(text)
    print("README numbers updated")


def designer_blocks(text: str) -> str:
    """The circuit designer's numbers, from ``dreamcircuit eval-tracks``."""
    path = ROOT / "results" / "trackgen.json"
    if not path.exists():
        return text
    tg = json.loads(path.read_text())
    onnx = json.loads((ROOT / "web" / "public" / "models" / "trackgen.json").read_text())
    reasons = ", ".join(f"{v} {k}" for k, v in sorted(tg["whole_fail_reasons"].items()))
    rows = [
        "| What was measured | Result |",
        "|---|---|",
        f"| Whole circuits dreamed from nothing that pass every drivability check | "
        f"**{100 * tg['whole_valid']:.1f}%** of {tg['n_whole']:,} "
        f"({100 * tg['whole_valid_unsmoothed']:.1f}% before arc smoothing; failures: {reasons}) |",
        f"| Circuits built live, arc by arc, the way lap 1 builds them | "
        f"**{100 * tg['live_valid']:.1f}%** of {tg['n_live']:,} |",
        f"| Arcs resampled per live circuit (the game's retry rule) | "
        f"{tg['live_retries_per_circuit']:.2f} on average |",
        f"| Mean lap length of a dreamed circuit | {tg['mean_length_m']:.0f} m "
        f"(the game drives it at 1.5x scale) |",
    ]
    text = block(text, "trackgen", "\n".join(rows))
    stats = (
        f"{tg['params'] / 1e6:.1f}M-parameter circuit designer · "
        f"{100 * tg['live_valid']:.0f}% of live-built circuits drivable · "
        f"{onnx['bytes'] / 1e6:.1f} MB, runs on the CPU in a browser tab · "
        f"{tg['sampler_steps']} Heun steps per arc"
    )
    return block(text, "designer-stats", stats)


if __name__ == "__main__":
    main()
