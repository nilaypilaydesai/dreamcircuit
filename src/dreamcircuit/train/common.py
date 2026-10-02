"""Shared training utilities: TOML configs, devices, EMA, checkpoints, CSV logging."""

from __future__ import annotations

import copy
import csv
import math
import tomllib
from dataclasses import fields
from pathlib import Path
from typing import Any

import torch
from torch import nn


def load_toml(path: str | Path) -> dict[str, Any]:
    with open(path, "rb") as f:
        return tomllib.load(f)


def dataclass_from(cls: type, values: dict[str, Any]) -> Any:
    """Build a (frozen) dataclass from a dict, converting lists to tuples and ignoring extras."""
    names = {f.name for f in fields(cls)}
    kw = {k: tuple(v) if isinstance(v, list) else v for k, v in values.items() if k in names}
    return cls(**kw)


def pick_device(name: str = "auto") -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class EMA:
    """Exponential moving average of weights, with the usual warmup on the decay."""

    def __init__(self, model: nn.Module, decay: float):
        self.decay = decay
        self.model = copy.deepcopy(model).eval()
        for p in self.model.parameters():
            p.requires_grad_(False)

    @torch.no_grad()
    def update(self, model: nn.Module, step: int) -> None:
        d = min(self.decay, (1 + step) / (10 + step))
        for pe, pm in zip(self.model.parameters(), model.parameters(), strict=True):
            pe.lerp_(pm.detach(), 1 - d)
        for be, bm in zip(self.model.buffers(), model.buffers(), strict=True):
            be.copy_(bm)


def cosine_lr(step: int, base: float, warmup: int, total: int, floor: float = 0.25) -> float:
    if step < warmup:
        return base * (step + 1) / warmup
    t = min((step - warmup) / max(total - warmup, 1), 1.0)
    return base * (floor + (1 - floor) * 0.5 * (1 + math.cos(math.pi * t)))


class CSVLogger:
    def __init__(self, path: Path, columns: list[str]):
        self.path, self.columns = path, columns
        new = not path.exists()
        self.f = open(path, "a", newline="")  # noqa: SIM115 - lives as long as the run
        self.w = csv.DictWriter(self.f, fieldnames=columns)
        if new:
            self.w.writeheader()

    def log(self, **row: Any) -> None:
        self.w.writerow({k: row.get(k, "") for k in self.columns})
        self.f.flush()


def save_checkpoint(path: Path, **state: Any) -> None:
    tmp = path.with_suffix(".tmp")
    torch.save(state, tmp)
    tmp.replace(path)  # atomic: a crash mid-save never corrupts the latest checkpoint
