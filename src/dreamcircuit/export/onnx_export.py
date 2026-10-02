"""Export the world model's denoiser (and the autopilot policy) to ONNX for the browser.

The exported denoiser computes the full preconditioned ``D(x; sigma | context, actions)``, so
the browser only has to run the 4-line Euler sampler around it. GroupNorm is exported as one
fused InstanceNormalization per layer (per-kernel dispatch overhead, not FLOPs, dominates small
models on WebGPU), so the graph only contains ops ONNX Runtime Web's WebGPU and WASM backends
both implement.

The first conv is zero-padded from 15 to 16 input channels: ONNX Runtime Web 1.30's WebGPU
Conv kernel returns wrong results when C_in is divisible by 3 but not by 4 (found with the
per-node cross-backend diff tool in ``web/tools/``).

Weights are stored as float16 and cast back to float32 inside the graph ("fp16 storage, fp32
compute"): half the download, and it runs on every backend, including GPUs without
``shader-f16``.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

from dreamcircuit.model.edm import WorldModel
from dreamcircuit.trackgen.model import TrackDenoiser


class DenoiserGraph(nn.Module):
    """Flat-tensor wrapper with a browser-friendly signature."""

    def __init__(self, wm: WorldModel):
        super().__init__()
        self.wm = wm

    def forward(
        self,
        x: torch.Tensor,
        sigma: torch.Tensor,
        context: torch.Tensor,
        actions: torch.Tensor,
        aug_sigma: torch.Tensor,
        mid_bias: torch.Tensor,
    ) -> torch.Tensor:
        b = x.shape[0]
        ctx = context.reshape(b, self.wm.context_frames, 3, x.shape[2], x.shape[3])
        return self.wm.denoise(x, sigma, ctx, actions, aug_sigma, mid_bias)


def denoiser_example_inputs(wm: WorldModel, size: int = 64) -> dict[str, torch.Tensor]:
    l = wm.context_frames
    g = torch.Generator().manual_seed(0)
    return {
        "x": torch.randn(1, 3, size, size, generator=g),
        "sigma": torch.tensor([1.3]),
        "context": torch.rand(1, 3 * l, size, size, generator=g) * 2 - 1,
        "actions": torch.rand(1, l, wm.unet_cfg.action_dim, generator=g) * 2 - 1,
        "aug_sigma": torch.tensor([0.0]),
        "mid_bias": torch.zeros(1, wm.unet_cfg.channels[-1]),
    }


def _export(
    module: nn.Module, inputs: dict[str, torch.Tensor], path: Path, output_name: str
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        module,
        tuple(inputs.values()),
        str(path),
        input_names=list(inputs),
        output_names=[output_name],
        opset_version=17,
        dynamo=False,
        do_constant_folding=True,
    )


def weights_to_fp16_storage(src: Path, dst: Path) -> None:
    """Rewrite float32 initializers as float16 + Cast(float32). Exact up to fp16 rounding."""
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load(str(src))
    graph = model.graph
    new_inits, casts = [], []
    for init in graph.initializer:
        arr = numpy_helper.to_array(init)
        if arr.dtype == np.float32 and arr.size >= 64:
            half = numpy_helper.from_array(arr.astype(np.float16), init.name + "_fp16")
            new_inits.append(half)
            casts.append(
                helper.make_node(
                    "Cast", [half.name], [init.name], to=TensorProto.FLOAT, name=init.name + "_cast"
                )
            )
        else:
            new_inits.append(init)
    del graph.initializer[:]
    graph.initializer.extend(new_inits)
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend(casts + nodes)
    onnx.checker.check_model(model)
    onnx.save(model, str(dst))


def check_parity(module: nn.Module, inputs: dict[str, torch.Tensor], path: Path) -> float:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    with torch.no_grad():
        ref = module(*inputs.values()).numpy()
    out = sess.run(None, {k: v.numpy() for k, v in inputs.items()})[0]
    return float(np.abs(out - ref).max())


def export_world_model(
    wm: WorldModel,
    out_dir: Path,
    name: str = "denoiser",
    norm_mode: str = "instance",
    pad_channels: bool = True,
) -> dict:
    wm = copy.deepcopy(wm).cpu().eval()  # export tweaks must never leak into a training model
    wm.unet.set_export_norm(norm_mode)
    if pad_channels:
        wm.unet.pad_input_channels(4)
    graph = DenoiserGraph(wm).eval()
    inputs = denoiser_example_inputs(wm)
    fp32 = out_dir / f"{name}.fp32.onnx"
    _export(graph, inputs, fp32, "x0")
    final = out_dir / f"{name}.onnx"
    weights_to_fp16_storage(fp32, final)
    err32 = check_parity(graph, inputs, fp32)
    err16 = check_parity(graph, inputs, final)
    fp32.unlink()
    e = wm.edm
    info = {
        "file": final.name,
        "bytes": final.stat().st_size,
        "max_abs_err_fp32": err32,
        "max_abs_err_fp16_storage": err16,
        "context_frames": wm.context_frames,
        "mid_channels": wm.unet_cfg.channels[-1],
        "edm": {
            "sigma_min": e.sigma_min,
            "sigma_max": e.sigma_max,
            "rho": e.rho,
            "sigma_data": e.sigma_data,
            "aug_max": e.aug_max,
        },
    }
    (out_dir / f"{name}.json").write_text(json.dumps(info, indent=2))
    return info


class PolicyGraph(nn.Module):
    def __init__(self, policy: nn.Module):
        super().__init__()
        self.policy = policy

    def forward(self, frames: torch.Tensor) -> torch.Tensor:
        return self.policy(frames)


def export_policy(policy: nn.Module, out_dir: Path, name: str = "policy") -> dict:
    """Export the pixel autopilot: frames (1, 12, 64, 64) in [-1, 1] -> action (1, 2)."""
    graph = PolicyGraph(copy.deepcopy(policy).cpu().eval()).eval()
    inputs = {
        "frames": torch.rand(1, 12, 64, 64, generator=torch.Generator().manual_seed(0)) * 2 - 1
    }
    tmp = out_dir / f"{name}.fp32.onnx"
    _export(graph, inputs, tmp, "action")
    final = out_dir / f"{name}.onnx"
    weights_to_fp16_storage(tmp, final)
    err = check_parity(graph, inputs, final)
    tmp.unlink()
    return {"file": final.name, "bytes": final.stat().st_size, "max_abs_err_fp16_storage": err}


class TrackGraph(nn.Module):
    def __init__(self, model: TrackDenoiser):
        super().__init__()
        self.model = model

    def forward(
        self, x: torch.Tensor, sigma: torch.Tensor, mask: torch.Tensor, known: torch.Tensor
    ) -> torch.Tensor:
        return self.model.denoise(x, sigma, mask, known)


def export_track_model(model: TrackDenoiser, out_dir: Path, name: str = "trackgen") -> dict:
    """Export the circuit designer: D(x; sigma | mask, known) on (1, 1, N) polar profiles.
    Tiny, so the browser runs it on the WASM backend."""
    m = copy.deepcopy(model).cpu().eval()
    m.set_export(True)
    n = m.cfg.n
    g = torch.Generator().manual_seed(0)
    inputs = {
        "x": torch.randn(1, 1, n, generator=g) * 3,
        "sigma": torch.tensor([2.0]),
        "mask": (torch.rand(1, 1, n, generator=g) > 0.5).float(),
        "known": torch.randn(1, 1, n, generator=g),
    }
    graph = TrackGraph(m).eval()
    tmp = out_dir / f"{name}.fp32.onnx"
    final = out_dir / f"{name}.onnx"
    _export(graph, inputs, tmp, "x0")
    weights_to_fp16_storage(tmp, final)
    tmp.unlink()
    err = check_parity(graph, inputs, final)
    c = m.cfg
    from dreamcircuit.trackgen.polar import R_MEAN, R_STD

    info = {
        "file": final.name,
        "bytes": final.stat().st_size,
        "max_abs_err": err,
        "n": n,
        "sigma_min": c.sigma_min,
        "sigma_max": c.sigma_max,
        "rho": c.rho,
        "sigma_data": c.sigma_data,
        "r_mean": R_MEAN,
        "r_std": R_STD,
    }
    (out_dir / f"{name}.json").write_text(json.dumps(info, indent=2))
    return info
