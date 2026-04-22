"""
UOAIS Data Upload API
=====================
A flexible file storage API for the capture team to upload
datasets and camera captures to the GPU server.

Run:
    cd uoais_endpoint
    .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000

Docs:
    http://<server-ip>:8000/docs
"""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, Query, UploadFile, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
STORAGE_ROOT = Path(__file__).parent / "storage"
STORAGE_ROOT.mkdir(exist_ok=True)
TEMPLATES_DIR = Path(__file__).parent / "templates"

app = FastAPI(
    title="UOAIS Data Upload API",
    description=(
        "Upload datasets and L515 camera captures to the GPU server. "
        "Accepts any file types — organized by dataset, session, and timestamp."
    ),
    version="1.0.0",
)


# ---------------------------------------------------------------------------
# Web UI
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def web_ui():
    """Serve the drag-and-drop upload page."""
    return (TEMPLATES_DIR / "index.html").read_text()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _dataset_dir(dataset: str) -> Path:
    """Return (and create) the directory for a dataset."""
    safe_name = dataset.replace("..", "").strip("/")
    d = STORAGE_ROOT / safe_name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _session_dir(dataset: str, session: Optional[str]) -> Path:
    """Return (and create) the directory for a session inside a dataset."""
    base = _dataset_dir(dataset)
    if session:
        safe_session = session.replace("..", "").strip("/")
        d = base / safe_session
    else:
        # Auto-create a timestamped session
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        d = base / ts
    d.mkdir(parents=True, exist_ok=True)
    return d


def _dir_summary(d: Path) -> dict:
    """Summarize files in a directory tree."""
    files = sorted(f for f in d.rglob("*") if f.is_file())
    total_bytes = sum(f.stat().st_size for f in files)
    return {
        "file_count": len(files),
        "total_size_bytes": total_bytes,
        "files": [str(f.relative_to(d)) for f in files],
    }


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------
@app.post("/upload/{dataset}")
async def upload_files(
    dataset: str,
    files: list[UploadFile] = File(..., description="One or more files to upload"),
    session: Optional[str] = Form(None, description="Session name (auto-generated if omitted)"),
    metadata: Optional[str] = Form(None, description="Optional JSON metadata string"),
):
    """
    Upload any number of files to a dataset.

    - **dataset**: Name of the dataset (e.g. `bottle_v1`, `l515_captures`)
    - **session**: Optional session/group name. If omitted, a UTC timestamp is used.
    - **files**: Any files — images, depth maps, point clouds, configs, etc.
    - **metadata**: Optional JSON string with extra info (camera params, notes, etc.)
    """
    dest = _session_dir(dataset, session)
    saved = []

    for f in files:
        file_path = dest / f.filename
        # Avoid overwriting: append counter if file exists
        if file_path.exists():
            stem = file_path.stem
            suffix = file_path.suffix
            counter = 1
            while file_path.exists():
                file_path = dest / f"{stem}_{counter}{suffix}"
                counter += 1

        with open(file_path, "wb") as out:
            content = await f.read()
            out.write(content)

        saved.append({
            "filename": file_path.name,
            "size_bytes": file_path.stat().st_size,
        })

    # Save metadata if provided
    if metadata:
        try:
            meta_obj = json.loads(metadata)
        except json.JSONDecodeError:
            meta_obj = {"raw": metadata}
        meta_obj["_uploaded_at"] = datetime.now(timezone.utc).isoformat()
        meta_obj["_files"] = [s["filename"] for s in saved]
        meta_path = dest / "metadata.json"
        # Merge with existing metadata if present
        if meta_path.exists():
            existing = json.loads(meta_path.read_text())
            if isinstance(existing, list):
                existing.append(meta_obj)
                meta_obj = existing
            else:
                meta_obj = [existing, meta_obj]
        meta_path.write_text(json.dumps(meta_obj, indent=2))

    return {
        "status": "ok",
        "dataset": dataset,
        "session": dest.name,
        "path": str(dest.relative_to(STORAGE_ROOT)),
        "uploaded": saved,
    }


# ---------------------------------------------------------------------------
# Browse
# ---------------------------------------------------------------------------
@app.get("/datasets")
async def list_datasets():
    """List all datasets on the server."""
    datasets = []
    if STORAGE_ROOT.exists():
        for d in sorted(STORAGE_ROOT.iterdir()):
            if d.is_dir():
                summary = _dir_summary(d)
                sessions = sorted(s.name for s in d.iterdir() if s.is_dir())
                datasets.append({
                    "name": d.name,
                    "sessions": sessions,
                    "session_count": len(sessions),
                    **summary,
                })
    return {"datasets": datasets}


@app.get("/datasets/{dataset}")
async def get_dataset(dataset: str):
    """Get details of a specific dataset and its sessions."""
    d = STORAGE_ROOT / dataset
    if not d.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")

    sessions = []
    for s in sorted(d.iterdir()):
        if s.is_dir():
            summary = _dir_summary(s)
            sessions.append({"name": s.name, **summary})

    return {
        "dataset": dataset,
        "sessions": sessions,
        **_dir_summary(d),
    }


@app.get("/datasets/{dataset}/{session}")
async def get_session(dataset: str, session: str):
    """List all files in a specific session."""
    d = STORAGE_ROOT / dataset / session
    if not d.exists():
        raise HTTPException(404, f"Session '{dataset}/{session}' not found")
    return {
        "dataset": dataset,
        "session": session,
        **_dir_summary(d),
    }


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------
@app.get("/datasets/{dataset}/{session}/{filename:path}")
async def download_file(dataset: str, session: str, filename: str):
    """Download a specific file from a session."""
    f = STORAGE_ROOT / dataset / session / filename
    if not f.exists() or not f.is_file():
        raise HTTPException(404, f"File not found: {dataset}/{session}/{filename}")
    return FileResponse(f, filename=f.name)


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------
@app.delete("/datasets/{dataset}")
async def delete_dataset(
    dataset: str,
    confirm: bool = Query(False, description="Must be true to actually delete"),
):
    """Delete an entire dataset. Requires confirm=true."""
    d = STORAGE_ROOT / dataset
    if not d.exists():
        raise HTTPException(404, f"Dataset '{dataset}' not found")
    if not confirm:
        summary = _dir_summary(d)
        return {
            "warning": f"This will delete {summary['file_count']} files. "
                       f"Add ?confirm=true to proceed.",
            **summary,
        }
    shutil.rmtree(d)
    return {"status": "deleted", "dataset": dataset}


@app.delete("/datasets/{dataset}/{session}")
async def delete_session(
    dataset: str,
    session: str,
    confirm: bool = Query(False, description="Must be true to actually delete"),
):
    """Delete a session within a dataset. Requires confirm=true."""
    d = STORAGE_ROOT / dataset / session
    if not d.exists():
        raise HTTPException(404, f"Session '{dataset}/{session}' not found")
    if not confirm:
        summary = _dir_summary(d)
        return {
            "warning": f"This will delete {summary['file_count']} files. "
                       f"Add ?confirm=true to proceed.",
            **summary,
        }
    shutil.rmtree(d)
    return {"status": "deleted", "dataset": dataset, "session": session}


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    """Health check."""
    total = _dir_summary(STORAGE_ROOT)
    disk = shutil.disk_usage(STORAGE_ROOT)
    return {
        "status": "ok",
        "storage_path": str(STORAGE_ROOT.resolve()),
        "stored_files": total["file_count"],
        "stored_bytes": total["total_size_bytes"],
        "disk_free_gb": round(disk.free / (1024**3), 2),
    }
