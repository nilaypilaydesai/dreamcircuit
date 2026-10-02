"""Pixel autopilot: a small CNN that drives from the last four ego frames.

It is trained by distillation from the privileged expert ("learning by cheating", Chen et al.
2019): every frame in the dataset is relabelled with what the expert, which sees the true track
geometry and vehicle state, would have done there. Because the student only ever sees pixels it
can drive inside the dream exactly as it drives in reality.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn


class PixelPolicy(nn.Module):
    def __init__(self, frames: int = 4, width: int = 32):
        super().__init__()
        w = width
        self.frames = frames
        self.net = nn.Sequential(
            nn.Conv2d(3 * frames, w, 5, stride=2, padding=2),
            nn.SiLU(),  # 32x32
            nn.Conv2d(w, 2 * w, 3, stride=2, padding=1),
            nn.SiLU(),  # 16x16
            nn.Conv2d(2 * w, 2 * w, 3, stride=2, padding=1),
            nn.SiLU(),  # 8x8
            nn.Conv2d(2 * w, 4 * w, 3, stride=2, padding=1),
            nn.SiLU(),  # 4x4
            nn.Flatten(),
            nn.Linear(4 * w * 16, 256),
            nn.SiLU(),
            nn.Linear(256, 2),
        )

    def forward(self, frames: torch.Tensor) -> torch.Tensor:
        """frames: (B, 3*frames, 64, 64) in [-1, 1] -> (B, 2) actions in [-1, 1]."""
        return torch.tanh(self.net(frames))


def policy_loss(pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    # Steering errors matter more than pedal errors for staying on the road.
    return 2.0 * F.smooth_l1_loss(pred[:, 0], target[:, 0], beta=0.1) + F.smooth_l1_loss(
        pred[:, 1], target[:, 1], beta=0.1
    )
