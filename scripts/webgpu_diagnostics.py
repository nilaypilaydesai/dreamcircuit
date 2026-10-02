"""Build the models behind the browser diagnostics in web/tools/.

    python scripts/webgpu_diagnostics.py [--checkpoint runs/wm_base/latest.pt]
    cd web && npm run dev
    open http://localhost:5173/tools/conv-sweep.html          # isolates the WebGPU Conv bug
    open http://localhost:5173/tools/ep-diff.html?model=debug_nopad   # first diverging node
    open http://localhost:5173/tools/ep-diff.html?model=debug_padded  # workaround: no divergence

``ep-diff`` runs the denoiser with every intermediate tensor exposed as a graph output on both
the WebGPU and WASM backends and reports the first node where they disagree. That is how the
ONNX Runtime Web 1.30 bug was found: WebGPU Conv is wrong when the input-channel count is
divisible by 3 but not by 4. ``conv-sweep`` then characterizes it with single-conv models.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import onnx
import torch
from onnx import shape_inference

from dreamcircuit.export.onnx_export import export_world_model
from dreamcircuit.train.world_model import build_model, load_toml, load_world_model

OUT = Path("web/public/diagnostics")
PROBED_OPS = {
    "Conv",
    "Gemm",
    "MatMul",
    "Softmax",
    "Resize",
    "InstanceNormalization",
    "Concat",
    "Sigmoid",
    "Mul",
    "Add",
}


def expose_intermediates(src: Path, dst: Path) -> int:
    m = shape_inference.infer_shapes(onnx.load(str(src)))
    info = {v.name: v for v in list(m.graph.value_info) + list(m.graph.output)}
    seen = {o.name for o in m.graph.output}
    order = []
    for i, node in enumerate(m.graph.node):
        if node.op_type not in PROBED_OPS:
            continue
        for out in node.output:
            if out in info and out not in seen:
                m.graph.output.append(info[out])
                order.append({"name": out, "op": node.op_type, "node": node.name, "idx": i})
                seen.add(out)
    onnx.save(m, str(dst))
    dst.with_suffix(".json").write_text(json.dumps(order))
    return len(order)


def conv_sweep() -> None:
    d = OUT / "convtest"
    d.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    cases = []
    for cin, cout in [
        (1, 32),
        (2, 32),
        (3, 32),
        (4, 32),
        (5, 32),
        (6, 32),
        (7, 32),
        (8, 32),
        (9, 32),
        (12, 32),
        (13, 32),
        (15, 32),
        (16, 32),
        (17, 32),
        (30, 32),
        (32, 3),
        (32, 32),
        (15, 16),
        (15, 8),
    ]:
        conv = torch.nn.Conv2d(cin, cout, 3, padding=1).eval()
        name = f"conv_{cin}_{cout}"
        torch.onnx.export(
            conv,
            (torch.randn(1, cin, 64, 64),),
            str(d / f"{name}.onnx"),
            input_names=["x"],
            output_names=["y"],
            opset_version=17,
            dynamo=False,
        )
        cases.append({"name": name, "cin": cin})
    (d / "cases.json").write_text(json.dumps(cases))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=None, help="defaults to a random-weight model")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.checkpoint:
        wm, _ = load_world_model(args.checkpoint)
    else:
        torch.manual_seed(0)
        wm = build_model(load_toml("configs/wm_base.toml"))
        for p in wm.parameters():  # zero-initialized layers would hide most of the graph
            if p.abs().sum() == 0:
                torch.nn.init.normal_(p, std=0.02)
    for name, pad in (("debug_padded", True), ("debug_nopad", False)):
        export_world_model(wm, OUT, name=f"{name}_base", pad_channels=pad)
        n = expose_intermediates(OUT / f"{name}_base.onnx", OUT / f"{name}.onnx")
        (OUT / f"{name}_base.onnx").unlink()
        (OUT / f"{name}_base.json").unlink()
        print(f"{name}: {n} probed tensors")
    conv_sweep()
    print(f"diagnostic models written to {OUT}")


if __name__ == "__main__":
    main()
