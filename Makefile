# DreamCircuit: one command per stage. `make help` lists them.
PY ?= .venv/bin/python
WM_RUN ?= runs/wm_base
CKPT ?= $(WM_RUN)/latest.pt

.PHONY: help setup data train policy report export web-dev web-build test lint all clean-runs

help:  ## list targets
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}'

setup:  ## create the Python venv (uv) and install the web app
	uv venv --python 3.12 .venv
	uv pip install --python $(PY) -e ".[export,viz,dev]"
	cd web && npm ci

data:  ## simulate 464k training frames (360 circuits) + 39k test frames (40 unseen circuits)
	$(PY) -m dreamcircuit generate --split train --tracks 360 --cars 8 --steps 160 --out data/train
	$(PY) -m dreamcircuit generate --split test --tracks 40 --cars 4 --steps 240 --out data/test

train:  ## train the diffusion world model (~3.5 h on an M4 Pro; resumable)
	$(PY) -m dreamcircuit train-wm --config configs/wm_base.toml

policy:  ## distill the privileged expert into the pixel autopilot (BC + DAgger)
	$(PY) -m dreamcircuit train-policy --device auto

report:  ## physics audit, probes, steering; writes results/ figures and web summary
	$(PY) -m dreamcircuit report --checkpoint $(CKPT)

export:  ## ONNX models + simulator assets + parity fixtures for the browser
	$(PY) -m dreamcircuit export --checkpoint $(CKPT)

web-dev:  ## run the browser app locally (http://localhost:5173)
	cd web && npm run dev

web-build:  ## production build of the browser app into web/dist
	cd web && npm run build

test:  ## Python + TypeScript test suites
	$(PY) -m pytest
	cd web && npm test

lint:  ## ruff, mypy, tsc
	$(PY) -m ruff check src tests
	$(PY) -m ruff format --check src tests
	$(PY) -m mypy src
	cd web && npm run typecheck

all: data train policy report export  ## the whole pipeline, end to end

clean-runs:  ## delete training runs (keeps data/)
	rm -rf runs
