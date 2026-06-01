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
import io
import json
import logging
import os
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from PIL import Image

import httpx
from fastapi import FastAPI, File, Form, Query, Request, UploadFile, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
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
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}
OVERLAY_SUFFIX = "_overlay.png"

# Fake auth gate — single hardcoded credential pair. Override via env vars.
# Not real security: cookie just has to match a per-process secret. Anyone
# with the cookie value is "logged in" until the server restarts.
LOGIN_USERNAME = os.environ.get("LOGIN_USERNAME", "admin")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "admin")
AUTH_COOKIE_NAME = "dropbox_auth"
AUTH_COOKIE_VALUE = secrets.token_urlsafe(32)

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


def _classify_image(path: Path) -> str:
    """Classify an uploaded image by reading its bit depth + channel count.

    The whole point: don't trust filenames or folder layouts. A real depth
    map is 16-bit single-channel; an RGB photo is 8-bit 3-channel. That's
    what every depth sensor and every UOAIS-related dataset writes, so
    file content is a more reliable signal than path conventions chosen
    by whoever uploaded the data.

    Returns:
        "rgb"   — 8-bit, 3+ channels (color photo)
        "depth" — 16-bit (uint16) or 32-bit float, single channel
        "other" — anything ambiguous; not sent to inference as either input
    """
    if not _is_image(path):
        return "other"
    try:
        with Image.open(path) as im:
            mode = im.mode
    except Exception:
        return "other"
    # Color photos
    if mode in ("RGB", "RGBA", "BGR"):
        return "rgb"
    # Native PIL modes for 16-bit ints and 32-bit floats — what depth files use
    if mode in ("I", "I;16", "I;16B", "I;16L", "I;16N", "F"):
        return "depth"
    # 8-bit grayscale ("L") and palette ("P") are too ambiguous to classify.
    return "other"


def _is_depth_for_rgb(rgb_stem: str, depth_stem: str) -> bool:
    """Return True if ``depth_stem`` looks like the depth sibling of ``rgb_stem``.

    Bidirectional stem-prefix check.  Either side may be the "elaborated"
    one — the depth-side suffix happens with explicit naming
    (``IMG_001`` ↔ ``IMG_001_depth``), the rgb-side suffix happens when the
    upload save loop has to rename to avoid a same-name collision in one
    session (``000000`` ↔ ``000000_1``).  The shared prefix must be
    followed by a separator on the longer side so unrelated stems like
    ``IMG_010`` / ``IMG_01`` don't accidentally match.
    """
    if rgb_stem == depth_stem:
        return True
    if depth_stem.startswith(rgb_stem) and len(depth_stem) > len(rgb_stem):
        return depth_stem[len(rgb_stem)] in "_.-"
    if rgb_stem.startswith(depth_stem) and len(rgb_stem) > len(depth_stem):
        return rgb_stem[len(depth_stem)] in "_.-"
    return False


def _pair_rgb_depth(
    rgb_paths: list[Path], depth_paths: list[Path]
) -> list[tuple[Path, Optional[Path]]]:
    """Pair each RGB with its closest depth file, or None if no match.

    Matching priority — pick the most specific signal first:
      1. Exact stem match anywhere in the upload (rgb/X.png ↔ depth/X.png)
      2. Same directory + stem-prefix (X.png ↔ X_depth.png in flat folder)
      3. Stem-prefix anywhere else
    Each depth file can only pair with one RGB.
    """
    pairs: list[tuple[Path, Optional[Path]]] = []
    used: set[Path] = set()

    for rgb in rgb_paths:
        match: Optional[Path] = None
        # 1. exact stem
        for d in depth_paths:
            if d not in used and d.stem == rgb.stem:
                match = d
                break
        # 2. same dir, stem prefix
        if match is None:
            for d in depth_paths:
                if d in used:
                    continue
                if d.parent == rgb.parent and _is_depth_for_rgb(rgb.stem, d.stem):
                    match = d
                    break
        # 3. anywhere, stem prefix
        if match is None:
            for d in depth_paths:
                if d in used:
                    continue
                if _is_depth_for_rgb(rgb.stem, d.stem):
                    match = d
                    break
        if match is not None:
            used.add(match)
        pairs.append((rgb, match))
    return pairs


async def _run_inference(
    rgb_path: Path, depth_path: Optional[Path] = None
) -> Optional[Path]:
    """POST RGB (and optional depth) to the inference service; save overlay.

    Returns the absolute overlay path on success, None on any failure.
    Inference is best-effort — failures must never break an upload. The
    inference server falls back to a dummy depth plane if depth is missing
    or undecodable, so we just forward whatever we have.
    """
    if _http_client is None:
        return None
    overlay_path = rgb_path.parent / (rgb_path.stem + OVERLAY_SUFFIX)
    files = {
        "file": (rgb_path.name, rgb_path.read_bytes(), "application/octet-stream"),
    }
    if depth_path is not None:
        files["depth"] = (
            depth_path.name, depth_path.read_bytes(), "application/octet-stream",
        )
    try:
        resp = await _http_client.post(f"{INFERENCE_URL}/infer", files=files)
        resp.raise_for_status()
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        log.warning(
            "inference failed for %s (depth=%s): %s",
            rgb_path.name, depth_path.name if depth_path else None, exc,
        )
        return None
    overlay_path.write_bytes(resp.content)
    log.info(
        "inference ok: %s (depth=%s, source=%s)",
        rgb_path.name,
        depth_path.name if depth_path else None,
        resp.headers.get("X-Depth-Source", "?"),
    )
    return overlay_path


# ---------------------------------------------------------------------------
# Fake auth gate
# ---------------------------------------------------------------------------
def _is_authed(request: Request) -> bool:
    return secrets.compare_digest(
        request.cookies.get(AUTH_COOKIE_NAME, ""), AUTH_COOKIE_VALUE
    )


@app.get("/login", response_class=HTMLResponse)
async def login_page(error: int = 0):
    """Serve the login form. ?error=1 highlights bad credentials."""
    html = (TEMPLATES_DIR / "login.html").read_text()
    # The text is localized client-side by i18n.js via the data-i18n hook;
    # the English string here is just the no-JS fallback.
    html = html.replace("<!--ERROR-->", '<div class="login-error" data-i18n="login_error">Invalid username or password.</div>' if error else "")
    return HTMLResponse(
        content=html,
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.post("/login")
async def login_submit(username: str = Form(...), password: str = Form(...)):
    ok = (
        secrets.compare_digest(username, LOGIN_USERNAME)
        and secrets.compare_digest(password, LOGIN_PASSWORD)
    )
    if not ok:
        return RedirectResponse("/login?error=1", status_code=303)
    # welcome=1 makes the "What to upload?" popout auto-open once on the
    # page that loads right after login (the frontend strips the param).
    resp = RedirectResponse("/?welcome=1", status_code=303)
    resp.set_cookie(
        AUTH_COOKIE_NAME,
        AUTH_COOKIE_VALUE,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    return resp


@app.get("/logout")
async def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(AUTH_COOKIE_NAME)
    return resp


# ---------------------------------------------------------------------------
# Web UI
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def web_ui(request: Request):
    """Serve the drag-and-drop upload page (login required)."""
    if not _is_authed(request):
        return RedirectResponse("/login", status_code=303)
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
    """Return (and create) the directory for a session inside a dataset.

    With ``append=True`` we reuse an existing session of the same name —
    that path is taken by every batch-follower request so all parallel
    uploads in one drag-and-drop end up sharing one session (and so the
    RGB/depth pair-detector can see them together).  ``append=False``
    auto-suffixes (`<name>_2`, `_3`, …) to keep two unrelated uploads
    on the same day from clobbering each other's files.
    """
    base = _dataset_dir(dataset, append=append)
    if session:
        safe_session = session.replace("..", "").strip("/")
        d = base / safe_session
        if d.exists() and not append:
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
    if not append:
        counter = 2
        while d.exists():
            d = base / f"{today}_{counter}"
            counter += 1
    d.mkdir(parents=True, exist_ok=True)
    return d


def _dir_summary(d: Path) -> dict:
    """Summarize files in a directory tree (excluding cached thumbnails).

    ``depth_pairs`` lets the frontend render depth files distinctly: keys are
    relative paths of files classified as depth, values are the relative path
    of the RGB they were paired with at upload time (for the "used for masks
    of …" hint).  Computed on every read so it stays correct after deletes.
    """
    files = sorted(
        f for f in d.rglob("*")
        if f.is_file() and THUMB_DIR_NAME not in f.parts
    )
    total_bytes = sum(f.stat().st_size for f in files)

    # Classify and pair so depth files can be linked back to their RGB sibling.
    rgb_paths = [f for f in files if _classify_image(f) == "rgb"]
    depth_paths = [f for f in files if _classify_image(f) == "depth"]
    depth_pairs: dict[str, str] = {}
    if depth_paths:
        for rgb, depth in _pair_rgb_depth(rgb_paths, depth_paths):
            if depth is not None:
                depth_pairs[str(depth.relative_to(d))] = str(rgb.relative_to(d))

    return {
        "file_count": len(files),
        "total_size_bytes": total_bytes,
        "files": [str(f.relative_to(d)) for f in files],
        "depth_pairs": depth_pairs,
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
    """Shared upload logic for both /upload and /upload/{dataset}.

    Three phases: save every file to disk, classify the saved images by
    bit depth + channels (RGB vs depth), pair each RGB with its closest
    depth file, then run inference per pair. Save-then-infer keeps pairing
    correct even if depth and RGB arrive out of order in the multipart batch.
    """
    dest = await _resolve_session_for_batch(dataset, session, append, batch_id)
    # The dataset/session names actually written may differ from what the
    # caller asked for (we auto-suffix to avoid collisions).
    actual_dataset = dest.parent.name
    actual_session = dest.name

    # Phase 1: write every uploaded file to disk, preserving folder structure.
    saved_paths: list[Path] = []
    for idx, f in enumerate(files):
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
        saved_paths.append(file_path)

    # Phase 2: pair RGB and depth across the WHOLE session, not just this
    # request's files. The browser splits folder uploads into one POST per
    # subfolder, so RGB/ and Depth/ land in separate parallel requests; the
    # depth arrives without an RGB to pair with (and vice versa) unless we
    # scan siblings already on disk. Excludes thumbnails (.thumbs/) and the
    # overlay outputs (_overlay.png) — _classify_image filters the latter.
    session_files = [
        f for f in dest.rglob("*")
        if f.is_file() and THUMB_DIR_NAME not in f.parts
    ]
    session_classifications = {p: _classify_image(p) for p in session_files}
    session_rgb = [p for p, k in session_classifications.items() if k == "rgb"]
    session_depth = [p for p, k in session_classifications.items() if k == "depth"]
    all_pairs = _pair_rgb_depth(session_rgb, session_depth)
    rgb_to_depth = {rgb: depth for rgb, depth in all_pairs}

    # Phase 3: run inference only for pairs touched by this request — either
    # the RGB or its paired depth was just saved. Re-running on an unchanged
    # pair wastes a GPU call; running when depth arrives late upgrades the
    # earlier dummy-depth overlay to a real-depth one (which also unlocks
    # the picker — the inference server skips grasp dots without real depth).
    saved_set = set(saved_paths)
    pairs_to_infer = [
        (rgb, depth) for rgb, depth in all_pairs
        if rgb in saved_set or (depth is not None and depth in saved_set)
    ]
    overlays: dict[Path, Path] = {}
    for rgb, depth in pairs_to_infer:
        overlay_path = await _run_inference(rgb, depth)
        if overlay_path is not None:
            overlays[rgb] = overlay_path

    # Per-saved-file classification for the response (uses session pass since
    # it already classified every saved file).
    classifications = {p: session_classifications.get(p, "other") for p in saved_paths}

    # Build the response entries from saved_paths in the original upload order.
    # ``kind`` is exposed so the upload preview UI can render depth files
    # with the gradient/DEPTH styling instead of the misleading "no mask"
    # panel — even when the depth file's POST arrived in parallel with its
    # RGB sibling and didn't see it directly.
    saved = []
    for fp in saved_paths:
        entry = {
            "filename": str(fp.relative_to(dest)),
            "size_bytes": fp.stat().st_size,
            "kind": classifications.get(fp, "other"),
        }
        if fp in overlays:
            entry["overlay"] = str(overlays[fp].relative_to(dest))
        depth_match = rgb_to_depth.get(fp)
        if depth_match is not None:
            entry["depth"] = str(depth_match.relative_to(dest))
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
# Thumbnails (cached, on-demand) — keeps the dataset browser fast even when
# the underlying images are 25 MB phone photos.
# ---------------------------------------------------------------------------
THUMB_DIR_NAME = ".thumbs"
THUMB_DEFAULT_MAX_EDGE = 480
THUMB_QUALITY = 78


def _thumb_path(source: Path, max_edge: int) -> Path:
    return source.parent / THUMB_DIR_NAME / f"{source.name}.{max_edge}.jpg"


_DEPTH_MODES = {"I", "I;16", "I;16B", "I;16L", "I;16N", "F"}


def _normalize_depth_for_preview(im: "Image.Image") -> "Image.Image":
    """Render a 16-bit depth image as 8-bit grayscale.

    Browsers can't display 16-bit PNGs meaningfully — they show them as
    nearly-white because most depth values land near the top of uint16.
    This produces the familiar normalized depth view (gradient where
    closer = darker, far = lighter) by clipping to the bin-picking
    workspace [250, 1500] mm and scaling to [0, 255].

    Auto-detects 0.1mm (BOP-format) encoding via the same max-value
    heuristic the inference server uses; values > 5000 are scaled by
    0.1 first so T-LESS / ITODD depths render correctly.

    Implemented with ``struct`` per-pixel because PIL's Image.point only
    accepts linear scale+offset on "I" mode, not arbitrary callables.
    """
    import struct

    # Normalize to "I" (32-bit signed) so we have one input format below.
    src = im.convert("I") if im.mode != "I" else im
    W, H = src.size
    values = struct.unpack(f"<{W * H}i", src.tobytes())

    # Auto-detect 0.1mm encoding. Use max because medians require sorting
    # the whole flat sequence; max is O(N) and good enough for the
    # heuristic.
    max_v = max(values) if values else 0
    scale = 0.1 if max_v > 5000 else 1.0

    out = bytearray(W * H)
    for i, v in enumerate(values):
        mm = v * scale
        if mm < 250:
            continue                         # leave at 0 (bytearray default)
        if mm > 1500:
            out[i] = 255
            continue
        out[i] = int((mm - 250) * 255 / 1250)
    return Image.frombytes("L", (W, H), bytes(out))


def _generate_thumb(source: Path, max_edge: int) -> Path:
    out = _thumb_path(source, max_edge)
    out.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as im:
        if im.mode in _DEPTH_MODES:
            im = _normalize_depth_for_preview(im)
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.save(out, "JPEG", quality=THUMB_QUALITY, optimize=True)
    return out


@app.get("/thumb/{dataset}/{session}/{filename:path}")
async def thumbnail(dataset: str, session: str, filename: str, max: int = THUMB_DEFAULT_MAX_EDGE):
    """Return a cached JPEG thumbnail/preview for any image file.

    Two practical sizes from the UI:
      max=480  → small card thumbnails (default)
      max=1920 → fast lightbox preview (replaces the 25 MB original)

    Generated lazily on first request and cached under <session>/.thumbs/.
    Cache-Control lets the browser keep the JPEG locally so revisits don't
    even round-trip the server.
    """
    src = STORAGE_ROOT / dataset / session / filename
    if not src.exists() or not src.is_file():
        raise HTTPException(404, f"File not found: {dataset}/{session}/{filename}")
    if src.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
        # Not an image — fall back to the raw file.
        return FileResponse(src, filename=src.name)
    max_edge = max if 32 <= max <= 4096 else THUMB_DEFAULT_MAX_EDGE
    thumb = _thumb_path(src, max_edge)
    if not thumb.exists() or thumb.stat().st_mtime < src.stat().st_mtime:
        try:
            thumb = _generate_thumb(src, max_edge)
        except Exception as e:
            log.warning("thumbnail failed for %s: %s", src, e)
            return FileResponse(src, filename=src.name)
    return FileResponse(
        thumb,
        media_type="image/jpeg",
        # Cache for an hour but allow revalidation against Last-Modified
        # (FileResponse adds it automatically).  Dropping `immutable` means
        # that when our thumb-generation logic changes and we regenerate
        # the on-disk JPEG, browsers will pick up the new bytes within
        # max-age, and `Ctrl+Shift+R` will refetch immediately.
        headers={"Cache-Control": "public, max-age=3600"},
    )


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
