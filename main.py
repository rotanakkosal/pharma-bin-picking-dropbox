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

import asyncio
import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, File, Form, Query, UploadFile, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
STORAGE_ROOT = BASE_DIR / "storage"
STORAGE_ROOT.mkdir(exist_ok=True)
WEB_DIR = BASE_DIR / "web"
TEMPLATES_DIR = WEB_DIR / "templates"
STATIC_DIR = WEB_DIR / "static"

INFERENCE_URL = os.environ.get("INFERENCE_URL", "http://127.0.0.1:8100").rstrip("/")
INFERENCE_TIMEOUT = float(os.environ.get("INFERENCE_TIMEOUT", "30"))
IMAGE_EXTS = {".png", ".jpg", ".jpeg"}
OVERLAY_SUFFIX = "_overlay.png"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dropbox")

app = FastAPI(
    title="UOAIS Data Upload API",
    description=(
        "Upload datasets and L515 camera captures to the GPU server. "
        "Accepts any file types — organized by dataset, session, and timestamp."
    ),
    version="1.0.0",
)

class NoCacheStatic(StaticFiles):
    """Serve static files with no-cache headers so JS/CSS edits show up
    immediately on reload, without users having to hard-refresh."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp


app.mount("/static", NoCacheStatic(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# Inference client (shared across requests)
# ---------------------------------------------------------------------------
_http_client: Optional[httpx.AsyncClient] = None


@app.on_event("startup")
async def _init_http_client():
    global _http_client
    _http_client = httpx.AsyncClient(timeout=INFERENCE_TIMEOUT)


@app.on_event("shutdown")
async def _close_http_client():
    if _http_client is not None:
        await _http_client.aclose()


def _is_image(path: Path) -> bool:
    if path.suffix.lower() not in IMAGE_EXTS:
        return False
    if path.name.endswith(OVERLAY_SUFFIX):
        return False
    return True


async def _run_inference(file_path: Path, raw_bytes: bytes) -> Optional[Path]:
    """POST image to the inference service; save overlay alongside the source.

    Returns the absolute overlay path on success, None on any failure.
    Inference is best-effort — failures must never break an upload.
    """
    if _http_client is None:
        return None
    overlay_path = file_path.parent / (file_path.stem + OVERLAY_SUFFIX)
    try:
        resp = await _http_client.post(
            f"{INFERENCE_URL}/infer",
            files={"file": (file_path.name, raw_bytes, "application/octet-stream")},
        )
        resp.raise_for_status()
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        log.warning("inference failed for %s: %s", file_path.name, exc)
        return None
    overlay_path.write_bytes(resp.content)
    return overlay_path


# ---------------------------------------------------------------------------
# Web UI
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def web_ui():
    """Serve the drag-and-drop upload page."""
    html = (TEMPLATES_DIR / "index.html").read_text()
    return HTMLResponse(
        content=html,
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _dataset_dir(dataset: str, append: bool = False) -> Path:
    """Return (and create) the directory for a dataset.

    With append=False (default), if the requested name already exists we pick
    `<name>_2`, `<name>_3`, …  This protects users from accidentally merging a
    new folder upload into an unrelated existing dataset of the same name.
    With append=True we reuse the existing directory if present.
    """
    safe_name = dataset.replace("..", "").strip("/")
    d = STORAGE_ROOT / safe_name
    if d.exists() and not append:
        counter = 2
        while True:
            candidate = STORAGE_ROOT / f"{safe_name}_{counter}"
            if not candidate.exists():
                d = candidate
                break
            counter += 1
    d.mkdir(parents=True, exist_ok=True)
    return d


def _session_dir(dataset: str, session: Optional[str], append: bool = False) -> Path:
    """Return (and create) the directory for a session inside a dataset."""
    base = _dataset_dir(dataset, append=append)
    if session:
        safe_session = session.replace("..", "").strip("/")
        d = base / safe_session
        # Even when appending the dataset, sessions still get the unique-name
        # treatment so two same-day uploads don't overwrite each other's files.
        if d.exists():
            counter = 2
            while True:
                candidate = base / f"{safe_session}_{counter}"
                if not candidate.exists():
                    d = candidate
                    break
                counter += 1
        d.mkdir(parents=True, exist_ok=True)
        return d
    # Auto-pick date-based session with _2, _3, … suffix for same-day reruns
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    d = base / today
    counter = 2
    while d.exists():
        d = base / f"{today}_{counter}"
        counter += 1
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
def _auto_dataset_name() -> str:
    """Generate a descriptive dataset name when the user doesn't provide one."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"capture_{ts}"


# Frontend uploads N files in parallel to /upload/{dataset}. Without
# coordination, each request sees the dataset already exists and picks its
# own suffix (rgb_2, rgb_3, ...), scattering one batch across many datasets.
# Clients send a `batch_id`; the first request resolves the actual name and
# the rest of the batch reuses it.
_batch_dataset_map: dict[str, tuple[str, Optional[str]]] = {}  # batch_id → (dataset, session)
_batch_locks: dict[str, asyncio.Lock] = {}
_batch_global_lock = asyncio.Lock()


async def _resolve_session_for_batch(
    dataset: str,
    session: Optional[str],
    append: bool,
    batch_id: Optional[str],
) -> Path:
    """Like _session_dir but cooperates with sibling requests in the same batch.

    The first request to land for a given batch_id picks the unique
    dataset/session names (auto-suffixing on collision), records them, and
    returns. Later requests in the same batch reuse those exact names.
    """
    if not batch_id:
        return _session_dir(dataset, session, append=append)

    async with _batch_global_lock:
        lock = _batch_locks.setdefault(batch_id, asyncio.Lock())
    async with lock:
        if batch_id in _batch_dataset_map:
            actual_dataset, actual_session = _batch_dataset_map[batch_id]
            # The first request has already created these dirs — reuse them.
            return _session_dir(actual_dataset, actual_session, append=True)
        dest = _session_dir(dataset, session, append=append)
        _batch_dataset_map[batch_id] = (dest.parent.name, dest.name)
        return dest


async def _do_upload(
    dataset: str,
    files: list[UploadFile],
    session: Optional[str],
    metadata: Optional[str],
    paths: Optional[list[str]],
    append: bool = False,
    batch_id: Optional[str] = None,
):
    """Shared upload logic for both /upload and /upload/{dataset}."""
    dest = await _resolve_session_for_batch(dataset, session, append, batch_id)
    # The dataset/session names actually written may differ from what the
    # caller asked for (we auto-suffix to avoid collisions).
    actual_dataset = dest.parent.name
    actual_session = dest.name
    saved = []

    for idx, f in enumerate(files):
        # Determine relative path (preserves folder structure if provided)
        if paths and idx < len(paths) and paths[idx]:
            rel = paths[idx].replace("\\", "/").lstrip("/")
            rel_parts = [p for p in rel.split("/") if p and p != ".."]
            rel_path = Path(*rel_parts) if rel_parts else Path(f.filename)
        else:
            rel_path = Path(f.filename)

        file_path = dest / rel_path
        file_path.parent.mkdir(parents=True, exist_ok=True)

        # Avoid overwriting: append counter if file exists
        if file_path.exists():
            stem = file_path.stem
            suffix = file_path.suffix
            counter = 1
            while file_path.exists():
                file_path = file_path.parent / f"{stem}_{counter}{suffix}"
                counter += 1

        with open(file_path, "wb") as out:
            content = await f.read()
            out.write(content)

        entry = {
            "filename": str(file_path.relative_to(dest)),
            "size_bytes": file_path.stat().st_size,
        }

        if _is_image(file_path):
            overlay_path = await _run_inference(file_path, content)
            if overlay_path is not None:
                entry["overlay"] = str(overlay_path.relative_to(dest))

        saved.append(entry)

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
        "dataset": actual_dataset,
        "session": actual_session,
        "path": str(dest.relative_to(STORAGE_ROOT)),
        "uploaded": saved,
    }


@app.post("/upload")
async def upload_without_dataset(
    files: list[UploadFile] = File(..., description="One or more files to upload"),
    session: Optional[str] = Form(None, description="Session name (auto-generated if omitted)"),
    metadata: Optional[str] = Form(None, description="Optional JSON metadata string"),
    paths: Optional[list[str]] = Form(None, description="Optional relative paths (one per file) to preserve folder structure"),
    batch_id: Optional[str] = Form(None, description="Group concurrent requests into one upload batch (so they share one dataset/session)"),
):
    """
    Upload without specifying a dataset name — the server auto-generates one
    like `capture_20260422_120000`.
    """
    return await _do_upload(_auto_dataset_name(), files, session, metadata, paths, batch_id=batch_id)


@app.post("/upload/{dataset}")
async def upload_files(
    dataset: str,
    files: list[UploadFile] = File(..., description="One or more files to upload"),
    session: Optional[str] = Form(None, description="Session name (auto-generated if omitted)"),
    metadata: Optional[str] = Form(None, description="Optional JSON metadata string"),
    paths: Optional[list[str]] = Form(None, description="Optional relative paths (one per file) to preserve folder structure"),
    append: bool = Form(False, description="If true, merge into the existing dataset of this name. Default false: auto-suffix to a fresh name on collision."),
    batch_id: Optional[str] = Form(None, description="Group concurrent requests into one upload batch (so they share one dataset/session)"),
):
    """
    Upload any number of files (or whole folders) to a named dataset.

    - **dataset**: Name of the dataset (e.g. `bottle_v1`, `l515_captures`)
    - **session**: Optional session/group name. If omitted, a UTC timestamp is used.
    - **files**: Any files — images, depth maps, point clouds, configs, etc.
    - **paths**: Optional list of relative paths (one per file) to preserve folder hierarchy.
    - **metadata**: Optional JSON string with extra info (camera params, notes, etc.)
    - **append**: When the dataset name already exists, default behavior is to
      auto-suffix (`rgb_2`, `rgb_3`, …) so old data is never silently merged.
      Pass `append=true` to opt into merge-into-existing.
    """
    return await _do_upload(dataset, files, session, metadata, paths, append=append, batch_id=batch_id)


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
                # Latest mtime across the tree — approximates "last uploaded"
                stats = [d.stat()] + [
                    f.stat() for f in d.rglob("*") if f.is_file()
                ]
                latest_mtime = max(s.st_mtime for s in stats) if stats else d.stat().st_mtime
                datasets.append({
                    "name": d.name,
                    "sessions": sessions,
                    "session_count": len(sessions),
                    "modified_at": latest_mtime,
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
