"""Command-line entry point: ``dreamcircuit <command>`` (or ``python -m dreamcircuit``)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def _cmd_generate(a: argparse.Namespace) -> None:
    from dreamcircuit.data.generate import GenSpec, generate_dataset

    meta = generate_dataset(
        GenSpec(Path(a.out), a.split, a.tracks, a.cars, a.steps, a.seed), workers=a.workers
    )
    print(
        json.dumps(
            {k: meta[k] for k in ("split", "n_episodes", "n_frames", "grass_fraction", "seconds")},
            indent=2,
        )
    )


def _cmd_train_wm(a: argparse.Namespace) -> None:
    from dreamcircuit.train.world_model import train

    print(f"run saved to {train(a.config, a.run_dir, a.max_steps)}")


def _cmd_export_web(a: argparse.Namespace) -> None:
    from dreamcircuit.export.web_assets import export_web_assets

    print(json.dumps(export_web_assets(Path(a.web_dir), a.tracks), indent=2))


def _cmd_train_policy(a: argparse.Namespace) -> None:
    from dreamcircuit.train.policy import train_policy

    train_policy(a.data, a.test, a.out, a.bc_steps, a.dagger_steps, device=a.device)


def _cmd_export(a: argparse.Namespace) -> None:
    from dreamcircuit.export.onnx_export import export_policy, export_world_model
    from dreamcircuit.export.web_assets import export_web_assets
    from dreamcircuit.train.policy import load_policy
    from dreamcircuit.train.world_model import load_world_model

    models = Path(a.web_dir) / "public" / "models"
    wm, ck = load_world_model(a.checkpoint)
    info = export_world_model(wm, models)
    info["train_step"] = ck["step"]
    (models / "denoiser.json").write_text(json.dumps(info, indent=2))
    out = {"denoiser": info}
    if Path(a.policy).exists():
        out["policy"] = export_policy(load_policy(a.policy), models)
    if Path(a.tracks).exists():
        from dreamcircuit.export.onnx_export import export_track_model
        from dreamcircuit.trackgen.train import load_track_model

        out["trackgen"] = export_track_model(load_track_model(a.tracks), models)
    out["assets"] = export_web_assets(Path(a.web_dir))
    print(json.dumps(out, indent=2))


def _cmd_report(a: argparse.Namespace) -> None:
    from dreamcircuit.eval.report import run_report

    s = run_report(a.checkpoint, a.policy_result, device_name=a.device, quick=a.quick)
    print(
        json.dumps(
            {
                "physics": s["audit"]["physics"]["hud_consistency_mae"],
                "controllability": s["audit"]["controllability"]["summary"],
            },
            indent=2,
        )
    )


def _cmd_trackgen_data(a: argparse.Namespace) -> None:
    from dreamcircuit.trackgen.data import build

    print(json.dumps(build(Path(a.out), a.n, a.workers), indent=2))


def _cmd_train_tracks(a: argparse.Namespace) -> None:
    from dreamcircuit.trackgen.train import train_tracks

    r = train_tracks(a.data, a.out, a.steps, device_name=a.device, init=a.init)
    print(json.dumps(r["evals"][-1]))


def _cmd_eval_tracks(a: argparse.Namespace) -> None:
    from dreamcircuit.trackgen.train import evaluate_designer

    r = evaluate_designer(a.checkpoint, a.out, n_whole=a.n, n_live=a.n_live, device_name=a.device)
    print(json.dumps({k: v for k, v in r.items() if k not in ("dreamed", "real")}, indent=2))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="dreamcircuit", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    g = sub.add_parser("generate", help="simulate drivers and write a frame dataset")
    g.add_argument("--split", choices=["train", "test"], default="train")
    g.add_argument("--tracks", type=int, default=360)
    g.add_argument("--cars", type=int, default=8, help="cars (episodes) per track")
    g.add_argument("--steps", type=int, default=160, help="frames per episode (15 Hz)")
    g.add_argument("--seed", type=int, default=0)
    g.add_argument("--workers", type=int, default=10)
    g.add_argument("--out", default="data/train")
    g.set_defaults(func=_cmd_generate)

    t = sub.add_parser("train-wm", help="train the diffusion world model")
    t.add_argument("--config", default="configs/wm_base.toml")
    t.add_argument("--run-dir", default=None)
    t.add_argument("--max-steps", type=int, default=None, help="stop early (for smoke tests)")
    t.set_defaults(func=_cmd_train_wm)

    w = sub.add_parser("export-web", help="write sim config, sprite, tracks and parity fixtures")
    w.add_argument("--web-dir", default="web")
    w.add_argument("--tracks", type=int, default=6)
    w.set_defaults(func=_cmd_export_web)

    pp = sub.add_parser("train-policy", help="distill the privileged expert into a pixel policy")
    pp.add_argument("--data", default="data/train")
    pp.add_argument("--test", default="data/test")
    pp.add_argument("--out", default="runs/policy")
    pp.add_argument("--bc-steps", type=int, default=5000)
    pp.add_argument("--dagger-steps", type=int, default=2500)
    pp.add_argument("--device", default="cpu")
    pp.set_defaults(func=_cmd_train_policy)

    ex = sub.add_parser("export", help="ONNX models + web assets for the browser app")
    ex.add_argument("--checkpoint", default="runs/wm_base/latest.pt")
    ex.add_argument("--policy", default="runs/policy/policy.pt")
    ex.add_argument("--tracks", default="runs/trackgen/trackgen.pt", help="circuit designer")
    ex.add_argument("--web-dir", default="web")
    ex.set_defaults(func=_cmd_export)

    rp = sub.add_parser("report", help="physics audit, probes, steering, figures, web summary")
    rp.add_argument("--checkpoint", default="runs/wm_base/latest.pt")
    rp.add_argument("--policy-result", default="runs/policy/result.json")
    rp.add_argument("--device", default="auto")
    rp.add_argument("--quick", action="store_true", help="a quarter of the samples")
    rp.set_defaults(func=_cmd_report)

    td = sub.add_parser("trackgen-data", help="circuits as polar profiles for the track model")
    td.add_argument("--n", type=int, default=60000)
    td.add_argument("--workers", type=int, default=10)
    td.add_argument("--out", default="data/tracks")
    td.set_defaults(func=_cmd_trackgen_data)

    tt = sub.add_parser("train-tracks", help="train the circuit-designer diffusion model")
    tt.add_argument("--data", default="data/tracks")
    tt.add_argument("--out", default="runs/trackgen")
    tt.add_argument("--steps", type=int, default=8000)
    tt.add_argument("--device", default="auto")
    tt.add_argument("--init", default=None, help="continue from a checkpoint's weights")
    tt.set_defaults(func=_cmd_train_tracks)

    et = sub.add_parser("eval-tracks", help="validity of dreamed circuits, and a gallery sample")
    et.add_argument("--checkpoint", default="runs/trackgen/trackgen.pt")
    et.add_argument("--out", default="results/trackgen.json")
    et.add_argument("--n", type=int, default=1000, help="whole circuits, sampled in one batch")
    et.add_argument("--n-live", type=int, default=200, help="circuits built arc by arc, like lap 1")
    et.add_argument("--device", default="cpu", help="cpu is fastest for this tiny 1-D model")
    et.set_defaults(func=_cmd_eval_tracks)
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
