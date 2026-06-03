# CROWN — MRI Segmentation & TES Simulation Suite

A web platform for whole-head MRI segmentation and transcranial electrical stimulation (TES) modeling. Upload a NIfTI MRI volume, run automated tissue segmentation across 12 classes, and optionally simulate tDCS/tACS electric field distributions.

## Segmentation

CROWN segments whole-head MRI scans into 12 tissue classes:

| Label | Tissue |
|-------|--------|
| 0 | Background |
| 1 | White Matter (WM) |
| 2 | Gray Matter (GM) |
| 3 | Eyes |
| 4 | Cerebrospinal Fluid (CSF) |
| 5 | Air |
| 6 | Blood |
| 7 | Cancellous Bone |
| 8 | Cortical Bone |
| 9 | Skin |
| 10 | Fat |
| 11 | Muscle |

### Models

Six models spanning three architectures and two coordinate spaces:

| Architecture | Native Space | FreeSurfer Space |
|-------------|-------------|-----------------|
| **GRACE** | `grace-native` | `grace-fs` |
| **DOMINO** | `domino-native` | `domino-fs` |
| **DOMINO++** | `dominopp-native` | `dominopp-fs` |

- **Native space** — output matches the input MRI's original coordinate system
- **FreeSurfer space** — output conformed to 1mm isotropic 256×256×256 standard space

## TES Simulation

After segmentation, run electric field simulations directly in the browser:

| Solver | Method | Time |
|--------|--------|------|
| **ROAST** | FEM via compiled MATLAB runtime | ~10–15 min (fast) / ~20–30 min (standard) |
| **SimNIBS** | FEM with charm meshing on GRACE segmentation | ~1–3 hrs |

Configure electrode montages (position, size, current), select simulation quality, and visualize the resulting electric field alongside the segmentation.

## Features

- **Upload & Segment** — Upload a NIfTI (.nii / .nii.gz) and select one or more models
- **Interactive 3D/2D Viewer** — Niivue-based side-by-side comparison with 14 colormap options; all colormaps render all 12 tissue labels without transparency
- **Per-Panel Controls** — Independent background visibility toggle per viewer panel
- **Segmentation Legend** — Color-matched tissue legend synced to the active colormap
- **TES Wizard** — Step-by-step electrode configuration and simulation workflow
- **Real-time Progress** — Server-Sent Events stream job status to the browser
- **GPU Scheduling** — Multi-GPU Redis-backed job queue for concurrent users
- **Result Download** — Download segmentation outputs as NIfTI files

## Command-Line Interface (`crown-cli`)

A standalone CLI runs the same segmentation and ROAST TES pipeline locally — no web stack required.

```bash
pip install crown-cli
```

> Install PyTorch matching your CUDA version first (see https://pytorch.org/get-started/locally/). Requires Python ≥ 3.8.

Authenticate with HuggingFace, then download models and the ROAST build:

```bash
hf auth login --token hf_...     # needs read access to smilelab/ repos
crown models download --all      # UNETR checkpoints
crown roast download             # compiled ROAST build (needs MATLAB Runtime R2025b)
```

Core commands:

| Command | Purpose |
|---------|---------|
| `crown segment T1.nii.gz --model grace-native` | Segmentation only |
| `crown simulate roast <session_dir> --t1 T1.nii.gz --model grace-native --recipe "P3 -2 P4 2"` | ROAST TES on existing segmentation |
| `crown run T1.nii.gz --model grace-native --simulate roast --recipe "P3 -2 P4 2"` | Full pipeline (segment + simulate) |
| `crown status <job_id> --follow` | Monitor / live-tail a job |
| `crown cancel <job_id>` | Cancel a queued or running job |
| `crown models` / `crown roast info` | List models / show ROAST build status |

Jobs run detached; state persists in `~/.crown/jobs.db`. See [`crown-cli/README.md`](crown-cli/README.md) for full docs (the `--space` flag, electrode types, output file formats, config).

## Architecture

```
ui_v2/      Next.js frontend — deployed on Vercel
api_v2/     FastAPI backend  — deployed via Docker Compose
crown-cli/  Standalone CLI   — published to PyPI as crown-cli
```

### Backend services (docker-compose.yml)

| Service | Description |
|---------|-------------|
| `redis` | Job queue and GPU locking |
| `api` | FastAPI + GPU scheduler + ROAST + SimNIBS |

The frontend is deployed on Vercel and communicates with the backend via `NEXT_PUBLIC_API_URL`.

## Deployment

### Backend

```bash
# Copy and fill in environment variables
cp api_v2/.env.example api_v2/.env

# Start Redis + API
docker compose up -d --build
```

Required host mounts (set in `.env` or override defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `MODELS_HOST_PATH` | `/home/chintan/wws_v2/api_v2/models` | Pre-trained model weights |
| `FREESURFER_LICENSE_PATH` | `/home/chintan/licenses/freesurfer.txt` | FreeSurfer license |
| `ROAST_BUILD_DIR` | `/home/chintan/roast11/build` | ROAST-11 compiled binary |
| `MATLAB_RUNTIME` | `/home/chintan/MATLAB/MATLAB_Runtime/R2025b` | MCR for ROAST |
| `SIMNIBS_HOME` | `/home/chintan/SimNIBS-4.5` | SimNIBS installation |

### Frontend (local dev)

```bash
cd ui_v2
npm install
npm run dev   # http://localhost:3000
```

## Environment Variables

**Backend (`api_v2/.env`)**

```
REDIS_HOST=redis
REDIS_PORT=6379
GPU_COUNT=4
JWT_SECRET=...
HMAC_SECRET=...
ROAST_BUILD_DIR=/opt/roast/build
MATLAB_RUNTIME=/opt/mcr/R2025b
ROAST_MAX_WORKERS=2
SIMNIBS_HOME=/opt/simnibs
SIMNIBS_N_THREADS=8
```

**Frontend**

```
NEXT_PUBLIC_API_URL=http://<server>:8000
```

## Data Flow

1. User uploads a NIfTI file and selects models + coordinate space
2. Backend preprocesses the input (RAS orientation, 1mm resampling) and enqueues a job
3. GPU scheduler assigns the job to an available GPU and runs inference
4. Progress streams to the frontend via SSE
5. Results load into the interactive viewer; user can optionally launch a TES simulation
