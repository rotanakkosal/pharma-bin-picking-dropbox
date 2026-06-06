// Each entry: { file: File, path: string }  where path is the relative path (e.g. "000001/rgb/001.png")
let selectedFiles = [];

// --- Drop zone ---
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const browseBtn = document.getElementById('browseBtn');

browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
});
dropzone.addEventListener('click', (e) => {
    if (e.target === browseBtn) return;
    fileInput.click();
});

dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
        // Walk directory entries to preserve structure
        const entries = [];
        for (const item of items) {
            const entry = item.webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
        const files = [];
        for (const entry of entries) {
            await walkEntry(entry, '', files);
        }
        addFilesWithPaths(files);
    } else {
        // Fallback: regular file drop
        addFilesFromList(e.dataTransfer.files);
    }
});

// Recursively walk a FileSystemEntry (file or directory) and collect {file, path}
function walkEntry(entry, basePath, out) {
    return new Promise((resolve) => {
        if (entry.isFile) {
            entry.file((file) => {
                out.push({ file, path: basePath + file.name });
                resolve();
            }, () => resolve());
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const readAll = () => {
                reader.readEntries(async (entries) => {
                    if (entries.length === 0) {
                        resolve();
                        return;
                    }
                    for (const e of entries) {
                        await walkEntry(e, basePath + entry.name + '/', out);
                    }
                    readAll();  // keep reading (readEntries returns in batches)
                }, () => resolve());
            };
            readAll();
        } else {
            resolve();
        }
    });
}

fileInput.addEventListener('change', () => {
    addFilesFromList(fileInput.files);
    fileInput.value = '';
});

folderInput.addEventListener('change', () => {
    // webkitdirectory populates webkitRelativePath on each file
    const files = [];
    for (const f of folderInput.files) {
        files.push({ file: f, path: f.webkitRelativePath || f.name });
    }
    addFilesWithPaths(files);
    folderInput.value = '';
});

function addFilesFromList(fileListObj) {
    const files = [];
    for (const f of fileListObj) {
        files.push({ file: f, path: f.webkitRelativePath || f.name });
    }
    addFilesWithPaths(files);
}

function addFilesWithPaths(items) {
    for (const item of items) {
        const exists = selectedFiles.some(
            s => s.path === item.path && s.file.size === item.file.size
        );
        if (!exists) selectedFiles.push(item);
        // Auto-expand every ancestor folder so dropped directories show their
        // contents without an extra click.
        const parts = item.path.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
            expandedFolders.add(parts.slice(0, i).join('/'));
        }
    }
    autofillDatasetName();
    // User just dropped new files — they want to see the upload panel, not
    // whatever dataset detail might currently be open.
    rightPanelMode = 'auto';
    renderFiles();
}

// Return the unique top-level folder names across selectedFiles (empty if files at root)
function topLevelFolders() {
    const set = new Set();
    for (const item of selectedFiles) {
        const parts = item.path.split('/').filter(Boolean);
        if (parts.length > 1) set.add(parts[0]);
    }
    return [...set];
}

// If the user hasn't typed a dataset name and all files share one top folder,
// auto-fill the input with that folder name.
function autofillDatasetName() {
    const input = document.getElementById('dataset');
    if (!input) return;
    // Don't overwrite explicit user input
    if (input.value.trim() && !input.dataset.autofilled) return;

    const folders = topLevelFolders();
    if (folders.length === 1) {
        input.value = folders[0];
        input.dataset.autofilled = 'true';
    } else if (folders.length === 0 && input.dataset.autofilled) {
        // No folder context anymore — clear the auto-filled value
        input.value = '';
        delete input.dataset.autofilled;
    }
}

// Clear the autofill flag when the user types anything into the dataset field
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('dataset');
    if (input) input.addEventListener('input', () => { delete input.dataset.autofilled; });

    // Auto-open the "What to upload?" popout once, right after login.
    // The login redirect sets ?welcome=1; we open the popup and strip the
    // param so a plain refresh afterwards does not keep re-showing it.
    if (new URLSearchParams(window.location.search).has('welcome')) {
        openReqModal();
        history.replaceState(null, '', window.location.pathname);
    }
});

function removeFile(index) {
    selectedFiles.splice(index, 1);
    autofillDatasetName();
    renderFiles();
}

// Remove all files whose path starts with folderPath + '/'
function removeFolder(folderPath) {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    selectedFiles = selectedFiles.filter(item => !item.path.startsWith(prefix));
    expandedFolders.delete(folderPath);
    autofillDatasetName();
    renderFiles();
}

// Track in-flight XHRs so we can abort them if the user cancels
const activeUploadXHRs = new Set();

// Keep the left panel's X button in sync with upload state
function syncLeftClose() {
    const btn = document.getElementById('leftPanelClose');
    if (!btn) return;
    btn.disabled = isUploading;
    btn.style.opacity = isUploading ? '0.35' : '';
    btn.style.cursor = isUploading ? 'not-allowed' : '';
    btn.title = isUploading ? t('use_right_panel_cancel') : t('clear_all');
}

function clearFiles() {
    if (isUploading) {
        if (!confirm(t('confirm_cancel_upload'))) return;
        // Abort all in-flight requests
        for (const xhr of activeUploadXHRs) {
            try { xhr.abort(); } catch (e) {}
        }
        activeUploadXHRs.clear();
        isUploading = false;
        isPaused = false;
    }
    selectedFiles = [];
    syncLeftClose();
    renderFilesImmediate();
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Pair source images with their *_overlay.png siblings (generated by the
// inference service) and their depth siblings (16-bit PNGs paired by the
// backend at upload time).  Each non-overlay file becomes one displayed
// card; depth files get a "kind: depth" tag + paired_rgb so the UI can
// render them with the gradient preview and a "used for masks of …" hint
// instead of the misleading "no mask" panel.
function pairOverlays(files, depthPairs) {
    depthPairs = depthPairs || {};
    const overlayByStem = new Map();
    const graspByStem = new Map();
    const sources = [];
    for (const f of files) {
        if (/_overlay\.png$/i.test(f)) {
            overlayByStem.set(f.replace(/_overlay\.png$/i, ''), f);
        } else if (/_grasp\.json$/i.test(f)) {
            graspByStem.set(f.replace(/_grasp\.json$/i, ''), f);
        } else {
            sources.push(f);
        }
    }
    const displayed = sources.map(path => {
        if (path in depthPairs) {
            return { path, kind: 'depth', pairedRgb: depthPairs[path] };
        }
        const stem = path.replace(/\.[^./]+$/, '');
        const overlay = overlayByStem.get(stem);
        if (overlay) overlayByStem.delete(stem);
        const graspJson = graspByStem.get(stem);
        if (graspJson) graspByStem.delete(stem);
        const entry = { path };
        if (overlay) entry.overlay = overlay;
        if (graspJson) entry.graspJson = graspJson;
        return entry;
    });
    // Any overlays that didn't match a source (shouldn't happen, but be safe)
    for (const orphan of overlayByStem.values()) {
        displayed.push({ path: orphan });
    }
    const hidden = files.length - displayed.length;
    return { displayed, hidden: Math.max(0, hidden) };
}

// Lightbox: flat ordered list of all viewable images across all sessions
// in the current dataset. Rebuilt every time the detail panel renders.
let lightboxItems = [];
let lightboxIndex = -1;

function renderEntry(entry, fileUrl, sessionName) {
    const isImage = /\.(png|jpe?g|tiff?)$/i.test(entry.path);
    const escName = entry.path.replace(/"/g, '&quot;');

    if (!isImage) {
        return `
            <a href="${fileUrl(entry.path)}" class="file-link" target="_blank" title="Download ${escName}">
                <span class="file-link-name">${entry.path}</span>
            </a>`;
    }

    // Tiny cached JPEG for the card thumbnail (~20KB) and a larger preview
    // for the lightbox (~400KB) — original PNG stays accessible via fileUrl
    // for downloads but never blocks the UI.  Depth files get the same
    // /thumb URL: the backend renders 16-bit depth as normalized 8-bit
    // grayscale (the familiar gradient view) automatically.
    const sourceThumb = thumbUrl(selectedDataset, sessionName, entry.path);
    const sourcePreview = thumbUrl(selectedDataset, sessionName, entry.path, LIGHTBOX_MAX_EDGE);
    const baseCaption = `${sessionName} / ${entry.path}`;

    // Depth file — show normalized gradient preview + linkage to its RGB,
    // not the misleading "no mask" panel.
    if (entry.kind === 'depth') {
        const sourceIdx = lightboxItems.length;
        lightboxItems.push({
            url: sourcePreview,
            thumbUrl: sourceThumb,
            caption: `${baseCaption} — ${t('caption_depth')}`,
        });
        const escPaired = (entry.pairedRgb || '').replace(/"/g, '&quot;');
        return `
            <div class="image-card">
                <div class="image-card-thumbs">
                    <button type="button" class="image-card-thumb"
                            onclick="openLightbox(${sourceIdx})"
                            title="${t('depth_normalized_title')}">
                        <img src="${sourceThumb}" alt="${escName} depth" loading="lazy">
                        <span class="image-card-label image-card-label--depth">${t('depth_label')}</span>
                    </button>
                    <div class="image-card-thumb image-card-thumb--depth-info" title="${escPaired ? t('used_as_depth_channel', escPaired) : t('depth_file_no_rgb_title')}">
                        <span class="image-card-depth-text">
                            ${escPaired
                                ? t('used_for_masks_of', escPaired)
                                : t('depth_file_no_rgb')}
                        </span>
                    </div>
                </div>
                <div class="image-card-name" title="${escName}">${entry.path}</div>
            </div>`;
    }

    // Standard RGB (with optional overlay) path
    const overlayThumb = entry.overlay ? thumbUrl(selectedDataset, sessionName, entry.overlay) : null;
    const overlayPreview = entry.overlay ? thumbUrl(selectedDataset, sessionName, entry.overlay, LIGHTBOX_MAX_EDGE) : null;

    const sourceIdx = lightboxItems.length;
    lightboxItems.push({
        url: sourcePreview,
        thumbUrl: sourceThumb,
        caption: `${baseCaption} — ${t('caption_original')}`,
    });

    let overlayIdx = -1;
    if (overlayPreview) {
        overlayIdx = lightboxItems.length;
        lightboxItems.push({
            url: overlayPreview,
            thumbUrl: overlayThumb,
            caption: `${baseCaption} — ${t('caption_masks')}`,
        });
    }

    return `
        <div class="image-card">
            <div class="image-card-thumbs">
                <button type="button" class="image-card-thumb"
                        onclick="openLightbox(${sourceIdx})"
                        title="${t('original_title')}">
                    <img src="${sourceThumb}" alt="${escName}" loading="lazy">
                    <span class="image-card-label">${t('original_label')}</span>
                </button>
                ${overlayThumb ? `
                    <button type="button" class="image-card-thumb image-card-thumb--mask"
                            onclick="openLightbox(${overlayIdx})"
                            title="${t('mask_overlay_title')}">
                        <img src="${overlayThumb}" alt="${escName} overlay" loading="lazy">
                        <span class="image-card-label image-card-label--mask">${t('masks_label')}</span>
                    </button>` : `
                    <div class="image-card-thumb image-card-thumb--empty" title="${t('no_mask_available')}">
                        <span class="image-card-empty-text">${t('no_mask')}</span>
                    </div>`}
            </div>
            <div class="image-card-footer">
                <div class="image-card-name" title="${escName}">${entry.path}</div>
                ${entry.graspJson ? `
                    <button type="button" class="grasp-json-link"
                            data-url="${fileUrl(entry.graspJson)}" data-name="${escName}"
                            onclick="openGraspModal(this.dataset.url, this.dataset.name)"
                            title="View grasp points (JSON)">${ICON_DOWNLOAD}<span>Grasp JSON</span></button>` : ''}
            </div>
        </div>`;
}

function thumbUrl(dataset, session, rel, maxEdge) {
    const base = `/thumb/${encodeURIComponent(dataset)}/${encodeURIComponent(session)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    return maxEdge ? `${base}?max=${maxEdge}` : base;
}

// Bigger size for lightbox previews — small enough to load fast (~400 KB
// JPEG vs. 25 MB PNG original) and still sharp on a typical monitor.
const LIGHTBOX_MAX_EDGE = 1920;

// Token incremented on every nav so a slow full-res download from a previous
// frame can't clobber the currently-displayed image.
let _lightboxToken = 0;

function openLightbox(index) {
    if (typeof index !== 'number' || !lightboxItems[index]) return;
    lightboxIndex = index;
    showLightboxFrame();
    const box = document.getElementById('lightbox');
    if (box) box.hidden = false;
    document.body.style.overflow = 'hidden';
}

function showLightboxFrame() {
    const item = lightboxItems[lightboxIndex];
    const img = document.getElementById('lightboxImg');
    const spin = document.getElementById('lightboxSpinner');
    const cap = document.getElementById('lightboxCaption');
    const ctr = document.getElementById('lightboxCounter');
    const prev = document.querySelector('.lightbox-nav--prev');
    const next = document.querySelector('.lightbox-nav--next');
    if (!item || !img) return;

    const token = ++_lightboxToken;
    img.alt = item.caption || '';

    if (cap) cap.textContent = item.caption || '';
    if (ctr) ctr.textContent = `${lightboxIndex + 1} / ${lightboxItems.length}`;
    const multi = lightboxItems.length > 1;
    if (prev) prev.style.visibility = multi ? 'visible' : 'hidden';
    if (next) next.style.visibility = multi ? 'visible' : 'hidden';

    // 1. Fast path — image already fully decoded in memory cache.
    const full = new Image();
    full.src = item.url;
    if (full.complete && full.naturalWidth > 0) {
        img.src = item.url;
        img.classList.remove('is-thumb');
        if (spin) spin.hidden = true;
        preloadNeighbors();
        return;
    }

    // 2. Slow path — show the (cached) thumb instantly so the user never sees
    //    a stale frame, but DELAY the spinner so quickly-arriving images
    //    (HTTP cache hits, fast network) don't flash a loader at all.
    img.classList.add('is-thumb');
    img.src = item.thumbUrl || item.url;
    if (spin) spin.hidden = true;
    const spinTimer = setTimeout(() => {
        if (token === _lightboxToken && spin) spin.hidden = false;
    }, 200);

    full.onload = () => {
        if (token !== _lightboxToken) return;
        clearTimeout(spinTimer);
        img.src = full.src;
        img.classList.remove('is-thumb');
        if (spin) spin.hidden = true;
        preloadNeighbors();
    };
    full.onerror = () => {
        if (token !== _lightboxToken) return;
        clearTimeout(spinTimer);
        if (spin) spin.hidden = true;
    };
}

// Warm the browser cache for the images on either side of the current frame
// so prev/next navigation hits the fast path instead of re-downloading.
function preloadNeighbors() {
    const n = lightboxItems.length;
    if (n <= 1) return;
    for (const offset of [1, -1, 2, -2]) {
        const idx = ((lightboxIndex + offset) % n + n) % n;
        const target = lightboxItems[idx];
        if (!target || !target.url) continue;
        const pre = new Image();
        pre.src = target.url;
    }
}

function navLightbox(delta, event) {
    if (event) event.stopPropagation();
    if (lightboxIndex < 0 || lightboxItems.length === 0) return;
    const n = lightboxItems.length;
    lightboxIndex = (lightboxIndex + delta + n) % n;
    showLightboxFrame();
}

function closeLightbox() {
    const box = document.getElementById('lightbox');
    const img = document.getElementById('lightboxImg');
    if (!box) return;
    box.hidden = true;
    if (img) img.src = '';
    lightboxIndex = -1;
    document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
    const box = document.getElementById('lightbox');
    if (!box || box.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') navLightbox(-1);
    else if (e.key === 'ArrowRight') navLightbox(1);
});

document.addEventListener('click', (e) => {
    const box = document.getElementById('lightbox');
    if (box && !box.hidden && e.target === box) closeLightbox();
});

// ---- "What to upload?" requirements popout ----
function openReqModal() {
    const box = document.getElementById('reqModal');
    if (!box) return;
    box.hidden = false;
    document.body.style.overflow = 'hidden';
}

function closeReqModal() {
    const box = document.getElementById('reqModal');
    if (!box) return;
    box.hidden = true;
    document.body.style.overflow = '';
}

// Close on Escape or click on the dark backdrop (outside the card).
document.addEventListener('keydown', (e) => {
    const box = document.getElementById('reqModal');
    if (box && !box.hidden && e.key === 'Escape') closeReqModal();
});

document.addEventListener('click', (e) => {
    const box = document.getElementById('reqModal');
    if (box && !box.hidden && e.target === box) closeReqModal();
});

// --- Grasp JSON viewer modal -------------------------------------------------
// Fetches the per-scene grasp JSON, pretty-prints it, and offers copy/download.
let _graspJsonText = '';

async function openGraspModal(url, name) {
    const box = document.getElementById('graspModal');
    if (!box) return;
    const tree = document.getElementById('graspJsonTree');
    const sub = document.getElementById('graspSub');
    const dl = document.getElementById('graspDownloadBtn');
    document.getElementById('graspTitle').textContent = name || 'Grasp points';
    document.getElementById('graspPath').textContent = 'root';
    dl.href = url;
    dl.setAttribute('download', ((name || 'scene').replace(/\.[^.]+$/, '')) + '_grasp.json');
    tree.textContent = 'Loading…';
    sub.innerHTML = '&nbsp;';
    _graspJsonText = '';
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        _graspJsonText = JSON.stringify(data, null, 2);
        renderGraspTree(data);
        const objs = data.objects || [];
        const pickable = objs.filter(o => o && o.pickable).length;
        const best = data.best_pick
            ? `best #${data.best_pick.id} (${Number(data.best_pick.score ?? 0).toFixed(2)})`
            : 'no pickable point';
        sub.textContent = `${objs.length} objects · ${pickable} pickable · ${best}`;
    } catch (err) {
        tree.textContent = 'Failed to load grasp JSON: ' + err.message;
    }
}

function closeGraspModal() {
    const box = document.getElementById('graspModal');
    if (!box) return;
    box.hidden = true;
    document.body.style.overflow = '';
}

async function copyGraspJson() {
    if (!_graspJsonText) return;
    const btn = document.getElementById('graspCopyBtn');
    try {
        await navigator.clipboard.writeText(_graspJsonText);
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = 'Copied';
            setTimeout(() => { btn.textContent = orig; }, 1200);
        }
    } catch (_e) { /* clipboard blocked — ignore */ }
}

document.addEventListener('keydown', (e) => {
    const box = document.getElementById('graspModal');
    if (box && !box.hidden && e.key === 'Escape') closeGraspModal();
});

// --- Collapsible JSON tree (no external library) -----------------------------
function _jtEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One DOM node for a key/value at `path`. Objects/arrays become collapsible.
function _jtNode(key, value, path) {
    const node = document.createElement('div');
    node.className = 'jt-node';
    const keyHtml = key === null
        ? ''
        : `<span class="jt-key">"${_jtEsc(key)}"</span><span class="jt-colon">: </span>`;

    const isObj = value !== null && typeof value === 'object';
    if (!isObj) {
        let v;
        if (typeof value === 'string') v = `<span class="jt-str">"${_jtEsc(value)}"</span>`;
        else if (typeof value === 'number') v = `<span class="jt-num">${value}</span>`;
        else if (typeof value === 'boolean') v = `<span class="jt-bool">${value}</span>`;
        else v = `<span class="jt-null">null</span>`;
        const row = document.createElement('div');
        row.className = 'jt-row';
        row.dataset.path = path;
        row.innerHTML = keyHtml + v;
        node.appendChild(row);
        return node;
    }

    const isArr = Array.isArray(value);
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    const open = isArr ? '[' : '{';
    const close = isArr ? ']' : '}';
    const count = isArr ? `${entries.length} items` : `${entries.length} keys`;

    const header = document.createElement('div');
    header.className = 'jt-row jt-header';
    header.dataset.path = path;
    header.innerHTML =
        `<span class="jt-toggle" aria-hidden="true"></span>${keyHtml}` +
        `<span class="jt-bracket">${open}</span>` +
        `<span class="jt-hint">&hellip; ${count} ${close}</span>`;
    node.appendChild(header);

    const children = document.createElement('div');
    children.className = 'jt-children';
    const inner = document.createElement('div');
    inner.className = 'jt-children-inner';
    for (const [k, v] of entries) {
        const childPath = isArr ? `${path}[${k}]` : `${path}.${k}`;
        inner.appendChild(_jtNode(isArr ? null : k, v, childPath));
    }
    children.appendChild(inner);
    node.appendChild(children);

    const closeRow = document.createElement('div');
    closeRow.className = 'jt-row jt-close';
    closeRow.innerHTML = `<span class="jt-bracket">${close}</span>`;
    node.appendChild(closeRow);
    return node;
}

let _graspTreeWired = false;
function renderGraspTree(data) {
    const c = document.getElementById('graspJsonTree');
    if (!c) return;
    c.innerHTML = '';
    c.appendChild(_jtNode(null, data, 'root'));
    // collapse the big arrays one level down by default so the top is readable
    c.querySelectorAll(':scope > .jt-node > .jt-children > .jt-children-inner > .jt-node').forEach(n => {
        if (n.querySelector(':scope > .jt-children > .jt-children-inner > .jt-node > .jt-children')) {
            n.classList.add('jt-collapsed');
        }
    });
    if (_graspTreeWired) return;
    _graspTreeWired = true;
    // Fold/unfold on header click.
    c.addEventListener('click', (e) => {
        const h = e.target.closest('.jt-header');
        if (h && c.contains(h)) h.parentElement.classList.toggle('jt-collapsed');
    });
    // Show the JSON path of whatever node the cursor is over.
    c.addEventListener('mousemove', (e) => {
        const n = e.target.closest('[data-path]');
        const bar = document.getElementById('graspPath');
        if (n && bar) bar.textContent = n.dataset.path;
    });
}

function graspTreeExpandAll() {
    document.querySelectorAll('#graspJsonTree .jt-node.jt-collapsed')
        .forEach(n => n.classList.remove('jt-collapsed'));
}
function graspTreeCollapseAll() {
    const c = document.getElementById('graspJsonTree');
    if (!c) return;
    c.querySelectorAll('.jt-node').forEach(n => {
        if (n.querySelector(':scope > .jt-children')) n.classList.add('jt-collapsed');
    });
    // keep the root open so the user sees the top-level keys
    const root = c.firstElementChild;
    if (root) root.classList.remove('jt-collapsed');
}

// Trigger a one-shot CSS spin animation on an element
function spinThis(el) {
    if (!el) return;
    el.classList.remove('spinning');
    // Force reflow so the animation restarts on rapid clicks
    void el.offsetWidth;
    el.classList.add('spinning');
    setTimeout(() => el.classList.remove('spinning'), 650);
}

// --- Badge label + color class based on file extension ---
function badgeFor(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
        pdf: { label: 'PDF', cls: 'badge-pdf' },
        doc: { label: 'DOC', cls: 'badge-doc' },
        docx: { label: 'DOC', cls: 'badge-doc' },
        txt: { label: 'TXT', cls: 'badge-doc' },
        md: { label: 'MD', cls: 'badge-doc' },
        json: { label: 'JSON', cls: 'badge-data' },
        yaml: { label: 'YAML', cls: 'badge-data' },
        yml: { label: 'YAML', cls: 'badge-data' },
        csv: { label: 'CSV', cls: 'badge-data' },
        xml: { label: 'XML', cls: 'badge-data' },
        png: { label: 'PNG', cls: 'badge-img' },
        jpg: { label: 'JPG', cls: 'badge-img' },
        jpeg: { label: 'JPG', cls: 'badge-img' },
        gif: { label: 'GIF', cls: 'badge-img' },
        webp: { label: 'WEBP', cls: 'badge-img' },
        bmp: { label: 'BMP', cls: 'badge-img' },
        tiff: { label: 'TIFF', cls: 'badge-img' },
        svg: { label: 'SVG', cls: 'badge-img' },
        npy: { label: 'NPY', cls: 'badge-data' },
        exr: { label: 'EXR', cls: 'badge-img' },
        ply: { label: 'PLY', cls: 'badge-data' },
        bag: { label: 'BAG', cls: 'badge-archive' },
        mp4: { label: 'MP4', cls: 'badge-video' },
        mov: { label: 'MOV', cls: 'badge-video' },
        avi: { label: 'AVI', cls: 'badge-video' },
        zip: { label: 'ZIP', cls: 'badge-archive' },
        tar: { label: 'TAR', cls: 'badge-archive' },
        gz: { label: 'GZ', cls: 'badge-archive' },
    };
    return map[ext] || { label: (ext || 'FILE').toUpperCase().slice(0, 4), cls: 'badge-default' };
}

// Icons used inline in markup
const ICON_CANCEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
</svg>`;
const ICON_TRASH = `<svg viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M26.25 8.41247C26.225 8.41247 26.1875 8.41247 26.15 8.41247C19.5375 7.74997 12.9375 7.49997 6.40002 8.16247L3.85002 8.41247C3.32502 8.46247 2.86252 8.08747 2.81252 7.56247C2.76252 7.03747 3.13752 6.58747 3.65002 6.53747L6.20002 6.28747C12.85 5.61247 19.5875 5.87497 26.3375 6.53747C26.85 6.58747 27.225 7.04997 27.175 7.56247C27.1375 8.04997 26.725 8.41247 26.25 8.41247Z" fill="currentColor"/>
    <path d="M10.625 7.15C10.575 7.15 10.525 7.15 10.4625 7.1375C9.96251 7.05 9.61251 6.5625 9.70001 6.0625L9.97501 4.425C10.175 3.225 10.45 1.5625 13.3625 1.5625H16.6375C19.5625 1.5625 19.8375 3.2875 20.025 4.4375L20.3 6.0625C20.3875 6.575 20.0375 7.0625 19.5375 7.1375C19.025 7.225 18.5375 6.875 18.4625 6.375L18.1875 4.75C18.0125 3.6625 17.975 3.45 16.65 3.45H13.375C12.05 3.45 12.025 3.625 11.8375 4.7375L11.55 6.3625C11.475 6.825 11.075 7.15 10.625 7.15Z" fill="currentColor"/>
    <path d="M19.0125 28.4375H10.9875C6.625 28.4375 6.45 26.025 6.3125 24.075L5.5 11.4875C5.4625 10.975 5.8625 10.525 6.375 10.4875C6.9 10.4625 7.3375 10.85 7.375 11.3625L8.1875 23.95C8.325 25.85 8.375 26.5625 10.9875 26.5625H19.0125C21.6375 26.5625 21.6875 25.85 21.8125 23.95L22.625 11.3625C22.6625 10.85 23.1125 10.4625 23.625 10.4875C24.1375 10.525 24.5375 10.9625 24.5 11.4875L23.6875 24.075C23.55 26.025 23.375 28.4375 19.0125 28.4375Z" fill="currentColor"/>
    <path d="M17.075 21.5625H12.9125C12.4 21.5625 11.975 21.1375 11.975 20.625C11.975 20.1125 12.4 19.6875 12.9125 19.6875H17.075C17.5875 19.6875 18.0125 20.1125 18.0125 20.625C18.0125 21.1375 17.5875 21.5625 17.075 21.5625Z" fill="currentColor"/>
    <path d="M18.125 16.5625H11.875C11.3625 16.5625 10.9375 16.1375 10.9375 15.625C10.9375 15.1125 11.3625 14.6875 11.875 14.6875H18.125C18.6375 14.6875 19.0625 15.1125 19.0625 15.625C19.0625 16.1375 18.6375 16.5625 18.125 16.5625Z" fill="currentColor"/>
</svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3v12"/>
    <path d="m7 11 5 5 5-5"/>
    <path d="M5 21h14"/>
</svg>`;
const ICON_CHECK = `<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10" fill="#16a34a" stroke="#16a34a"/>
    <polyline points="8 12 11 15 16 9" stroke="#ffffff"/>
</svg>`;

// --- Tree state ---
// Expanded folder paths; everything is collapsed by default for big uploads.
let expandedFolders = new Set();

// Build a hierarchical tree from the flat selectedFiles.
// Each folder node: { type:'folder', name, path, children:[], files:[fileRefs] }
// Each file node:   { type:'file', name, path, item, index }
function buildTree() {
    const root = { type: 'folder', name: '', path: '', children: new Map() };
    selectedFiles.forEach((item, i) => {
        const parts = item.path.split('/').filter(Boolean);
        let node = root;
        for (let p = 0; p < parts.length - 1; p++) {
            const part = parts[p];
            const subPath = parts.slice(0, p + 1).join('/');
            if (!node.children.has(part)) {
                node.children.set(part, {
                    type: 'folder',
                    name: part,
                    path: subPath,
                    children: new Map(),
                });
            }
            node = node.children.get(part);
        }
        // Leaf file
        const fileName = parts[parts.length - 1];
        node.children.set('__file_' + i, {
            type: 'file',
            name: fileName,
            path: item.path,
            item: item,
            index: i,
        });
    });
    return root;
}

// Compute aggregate stats for a folder subtree
function folderStats(node) {
    let fileCount = 0;
    let totalSize = 0;
    let doneCount = 0;
    let uploadingCount = 0;
    let errorCount = 0;
    let uploadedBytes = 0;
    const walk = (n) => {
        for (const child of n.children.values()) {
            if (child.type === 'file') {
                fileCount++;
                totalSize += child.item.file.size;
                if (child.item.status === 'done') {
                    doneCount++;
                    uploadedBytes += child.item.file.size;
                } else if (child.item.status === 'uploading') {
                    uploadingCount++;
                    uploadedBytes += child.item.file.size * ((child.item.progress || 0) / 100);
                } else if (child.item.status === 'error') {
                    errorCount++;
                }
            } else {
                walk(child);
            }
        }
    };
    walk(node);
    return { fileCount, totalSize, doneCount, uploadingCount, errorCount, uploadedBytes };
}

const ICON_CARET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"/>
</svg>`;
const ICON_FOLDER = `<svg viewBox="0 0 20 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M18 2H10L8.59 0.59C8.21 0.21 7.7 0 7.17 0H2C0.9 0 0.00999999 0.9 0.00999999 2L0 14C0 15.1 0.9 16 2 16H18C19.1 16 20 15.1 20 14V4C20 2.9 19.1 2 18 2ZM11 9V12C11 12.55 10.55 13 10 13C9.45 13 9 12.55 9 12V9H7.21C6.76 9 6.54 8.46 6.86 8.15L9.66 5.36C9.86 5.16 10.17 5.17 10.37 5.36L13.16 8.15C13.46 8.46 13.24 9 12.8 9H11Z"/></svg>`;

// Render a folder row HTML
function renderFolderRow(node, depth) {
    const stats = folderStats(node);
    const isExpanded = expandedFolders.has(node.path);
    const uploadingTotal = stats.uploadingCount + stats.doneCount + stats.errorCount;
    const showProgress = uploadingTotal > 0 && stats.doneCount < stats.fileCount;
    const pct = stats.fileCount > 0
        ? Math.round((stats.uploadedBytes / Math.max(stats.totalSize, 1)) * 100)
        : 0;

    let statusHtml = '';
    if (stats.errorCount > 0) {
        statusHtml = `<span class="tree-status error">${t('failed_count', stats.errorCount)}</span>`;
    } else if (showProgress) {
        statusHtml = `
            <div class="tree-mini-bar"><div class="tree-mini-bar-fill" style="width:${pct}%"></div></div>
            <span class="tree-status uploading">${stats.doneCount}/${stats.fileCount}</span>`;
    } else if (stats.doneCount === stats.fileCount && stats.fileCount > 0) {
        statusHtml = `<span class="tree-status done">${ICON_CHECK}${t('status_done')}</span>`;
    }

    const safePath = node.path.replace(/'/g, "\\'");
    return `
        <div class="tree-row folder" style="padding-left:${0.5 + depth * 1}rem"
             onclick="toggleFolder('${safePath}')">
            <span class="tree-caret ${isExpanded ? 'expanded' : ''}">${ICON_CARET}</span>
            <div class="tree-icon folder-icon">${ICON_FOLDER}</div>
            <div class="tree-row-body">
                <div class="tree-row-name">${node.name}</div>
            </div>
            <div class="tree-row-stats">
                ${statusHtml}
                <span>${t('files_count', stats.fileCount)}</span>
                <span>·</span>
                <span>${formatSize(stats.totalSize)}</span>
            </div>
            <button class="tree-row-action" onclick="event.stopPropagation(); removeFolder('${safePath}')" title="${t('remove_folder')}">${ICON_TRASH}</button>
        </div>`;
}

// Render a file row HTML
function renderFileRow(node, depth) {
    const item = node.item;
    const badge = badgeFor(item.path);
    const sizeLabel = formatSize(item.file.size);

    let statusHtml = '';
    if (item.status === 'uploading') {
        statusHtml = `
            <div class="tree-mini-bar"><div class="tree-mini-bar-fill" style="width:${item.progress || 0}%"></div></div>
            <span class="tree-status uploading"><span class="spinner"></span>${item.progress || 0}%</span>`;
    } else if (item.status === 'done') {
        statusHtml = `<span class="tree-status done">${ICON_CHECK}${t('status_done')}</span>`;
    } else if (item.status === 'error') {
        statusHtml = `<span class="tree-status error">${t('status_failed')}</span>`;
    }

    // Inline preview shown right after a successful upload — original + mask
    // thumbnails for RGB, or gradient + linkage for depth files.
    let previewHtml = '';
    if (item.status === 'done' && item.uploadResult) {
        const r = item.uploadResult;
        if (r.kind === 'depth') {
            // Depth file: show normalized gradient (the /thumb endpoint
            // renders 16-bit depth as 8-bit grayscale automatically) plus
            // an info card explaining its role.
            previewHtml = `
                <div class="upload-preview">
                    <button type="button" class="upload-preview-thumb"
                            onclick="openUploadPreview(${node.index}, 0)"
                            title="${t('depth_normalized_title')}">
                        <img src="${r.sourceThumb || r.sourceUrl}" alt="depth" loading="lazy">
                        <span class="upload-preview-label upload-preview-label--depth">${t('depth_label')}</span>
                    </button>
                    <div class="upload-preview-thumb upload-preview-thumb--depth-info" title="${t('depth_file_info_title')}">
                        <span class="upload-preview-depth-text">
                            ${t('depth_used_for_rgb')}
                        </span>
                    </div>
                </div>`;
        } else {
            previewHtml = `
                <div class="upload-preview">
                    <button type="button" class="upload-preview-thumb"
                            onclick="openUploadPreview(${node.index}, 0)"
                            title="${t('original_title')}">
                        <img src="${r.sourceThumb || r.sourceUrl}" alt="original" loading="lazy">
                        <span class="upload-preview-label">${t('original_label')}</span>
                    </button>
                    ${r.overlayUrl ? `
                        <button type="button" class="upload-preview-thumb upload-preview-thumb--mask"
                                onclick="openUploadPreview(${node.index}, 1)"
                                title="${t('mask_overlay_title')}">
                            <img src="${r.overlayThumb || r.overlayUrl}" alt="masks" loading="lazy">
                            <span class="upload-preview-label upload-preview-label--mask">${t('masks_label')}</span>
                        </button>` : `
                        <div class="upload-preview-thumb upload-preview-thumb--empty" title="${t('no_mask_available')}">
                            <span class="upload-preview-empty">${t('no_mask')}</span>
                        </div>`}
                </div>${r.graspJsonUrl ? `
                <button type="button" class="grasp-json-link"
                        data-url="${r.graspJsonUrl}" data-name="${(r.label || '').replace(/"/g, '&quot;')}"
                        onclick="openGraspModal(this.dataset.url, this.dataset.name)"
                        title="View grasp points (JSON)">${ICON_DOWNLOAD}<span>Grasp JSON</span></button>` : ''}`;
        }
    }

    return `
        <div class="tree-row file" style="padding-left:${0.5 + depth * 1}rem">
            <span class="tree-caret" style="visibility:hidden"></span>
            <div class="tree-badge">
                <div class="tree-badge-line bold" style="width:70%"></div>
                <div class="tree-badge-line" style="width:50%"></div>
                <div class="tree-badge-line" style="width:60%"></div>
                <div class="tree-badge-line" style="width:40%"></div>
                <span class="tree-badge-banner ${badge.cls}">${badge.label}</span>
            </div>
            <div class="tree-row-body">
                <div class="tree-row-name">${node.name}</div>
                ${previewHtml}
            </div>
            <div class="tree-row-stats">
                ${statusHtml}
                <span>${sizeLabel}</span>
            </div>
            <button class="tree-row-action" onclick="removeFile(${node.index})" title="${t('remove')}">${ICON_TRASH}</button>
        </div>`;
}

// Build a lightbox list spanning every file that finished uploading in this
// session, then open it on the clicked thumbnail. `which` selects the original
// (0) vs. mask (1) of the clicked file.
function openUploadPreview(fileIndex, which) {
    const items = [];
    let target = 0;
    selectedFiles.forEach((f, i) => {
        if (!f.uploadResult) return;
        const r = f.uploadResult;
        const sourceIdx = items.length;
        items.push({
            url: r.sourcePreview || r.sourceUrl,
            thumbUrl: r.sourceThumb,
            caption: `${r.label} — ${t('caption_original')}`,
        });
        const overlayIdx = r.overlayUrl ? items.length : -1;
        if (r.overlayUrl) items.push({
            url: r.overlayPreview || r.overlayUrl,
            thumbUrl: r.overlayThumb,
            caption: `${r.label} — ${t('caption_masks')}`,
        });
        if (i === fileIndex) {
            target = (which === 1 && overlayIdx >= 0) ? overlayIdx : sourceIdx;
        }
    });
    if (items.length === 0) return;
    lightboxItems = items;
    openLightbox(target);
}

// Depth-first render of visible rows
function renderNode(node, depth, out) {
    const sorted = [...node.children.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        // Natural sort so 21.jpg < 177.jpg (instead of dumb string compare)
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    for (const child of sorted) {
        if (child.type === 'folder') {
            out.push(renderFolderRow(child, depth));
            if (expandedFolders.has(child.path)) {
                renderNode(child, depth + 1, out);
            }
        } else {
            out.push(renderFileRow(child, depth));
        }
    }
}

function toggleFolder(path) {
    if (expandedFolders.has(path)) expandedFolders.delete(path);
    else expandedFolders.add(path);
    renderFiles();
}

// Throttled re-render — upload progress fires many events per second.
// Rewriting innerHTML too fast destroys buttons mid-click, causes hover flicker,
// and swallows pointer events. Coalesce to one render per animation frame.
let _renderScheduled = false;
function renderFiles() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
        _renderScheduled = false;
        renderRightPanel();
        syncDropzoneSummary();
        syncUploadOverlay();
    });
}

// Force an immediate render (for click handlers that must update UI now)
function renderFilesImmediate() {
    _renderScheduled = false;
    renderRightPanel();
    syncDropzoneSummary();
    syncUploadOverlay();
}

// Full-screen overlay shown while an upload is in progress. Mirrors the
// per-file progress already drawn in the right panel, but at center-stage
// so a multi-thousand-file batch can't be missed or mistaken for hung.
function syncUploadOverlay() {
    const ov = document.getElementById('uploadOverlay');
    if (!ov) return;
    if (!isUploading) {
        ov.hidden = true;
        return;
    }
    const n = selectedFiles.length;
    const doneCount = selectedFiles.filter(f => f.status === 'done').length;
    const errCount  = selectedFiles.filter(f => f.status === 'error').length;
    const totalBytes = selectedFiles.reduce((s, f) => s + (f.file.size || 0), 0);
    // Bytes from fully-completed files only — keeps the meta line honest about
    // what's persisted on the server. (In-flight files don't count until done.)
    const uploadedBytes = selectedFiles.reduce(
        (s, f) => f.status === 'done' ? s + (f.file.size || 0) : s, 0,
    );
    // The progress bar tracks file count so it stays in lockstep with the
    // "X / N files" counter — bytes percentage gets its own line below.
    const pct = Math.round((doneCount / Math.max(n, 1)) * 100);

    // Distinguish "still pushing bytes" from "waiting on the server's inference
    // response". `bytesUploaded` flips true via xhr.upload.onloadend the moment
    // all bytes leave the browser; `status` flips to 'done' only when the
    // server replies (after running UOAIS + CG-Net). The gap between those two
    // moments grows with batch size.
    const stillUploading = selectedFiles.some(
        f => f.status === 'uploading' && !f.bytesUploaded,
    );
    const awaitingInference = selectedFiles.filter(
        f => f.status === 'uploading' && f.bytesUploaded,
    ).length;

    const titleEl = document.getElementById('uploadOverlayTitle');
    if (titleEl) {
        titleEl.textContent = stillUploading
            ? t('uploading_processing')
            : awaitingInference > 0
                ? t('processing_masks')
                : t('finishing_up');
    }
    const subEl = document.getElementById('uploadOverlaySubstatus');
    if (subEl) {
        if (awaitingInference > 0 && !stillUploading) {
            subEl.textContent = t('running_inference', awaitingInference);
        } else if (awaitingInference > 0) {
            subEl.textContent = t('waiting_for_masks', awaitingInference);
        } else {
            subEl.textContent = '';
        }
    }

    document.getElementById('uploadOverlayCount').textContent =
        t('files_ratio', { done: doneCount, total: n });
    document.getElementById('uploadOverlayPct').textContent = `${pct}%`;
    document.getElementById('uploadOverlayMeta').textContent =
        t('bytes_of', { a: formatSize(uploadedBytes), b: formatSize(totalBytes) }) +
        (errCount > 0 ? ` · ${t('failed_count', errCount)}` : '');
    document.getElementById('uploadOverlayFill').style.width = `${pct}%`;

    const targetEl = document.getElementById('uploadOverlayTarget');
    const dataset = (document.getElementById('dataset') || {}).value || '';
    const session = (document.getElementById('session') || {}).value || '';
    if (targetEl) {
        targetEl.textContent = dataset
            ? (session ? `${dataset} / ${session}` : dataset)
            : t('auto_generated_dataset');
    }

    const pauseBtn = document.getElementById('uploadOverlayPauseBtn');
    if (pauseBtn) pauseBtn.textContent = isPaused ? t('resume') : t('pause');

    ov.hidden = false;
}

// Show the selection count/size inside the dropzone while files are queued
// or uploading. Once the whole batch is done, revert to the clean default
// state so the user can stage the next upload — the right-panel preview
// keeps the finished thumbnails.
function syncDropzoneSummary() {
    const dz = document.getElementById('dropzone');
    const empty = dz ? dz.querySelector('.dropzone-empty') : null;
    const summary = document.getElementById('dropzoneSummary');
    const countEl = document.getElementById('dropzoneSummaryCount');
    const metaEl = document.getElementById('dropzoneSummaryMeta');
    if (!dz || !empty || !summary || !countEl || !metaEl) return;

    const n = selectedFiles.length;
    const pendingCount = selectedFiles.filter(f => f.status !== 'done').length;
    if (n === 0 || pendingCount === 0) {
        dz.classList.remove('has-files');
        empty.hidden = false;
        summary.hidden = true;
        return;
    }
    const totalBytes = selectedFiles.reduce((s, f) => s + (f.file.size || 0), 0);
    const doneCount = n - pendingCount;
    countEl.textContent = t('files_selected', n);
    metaEl.textContent = (isUploading || doneCount > 0)
        ? t('size_uploaded', { size: formatSize(totalBytes), done: doneCount, total: n })
        : t('size_ready', formatSize(totalBytes));
    dz.classList.add('has-files');
    empty.hidden = true;
    summary.hidden = false;
}

// Shared panel header used by the right workspace (matches left panel's style)
function renderPanelHeader({ iconSvg, title, subtitle, actionsHtml }) {
    return `
        <div class="panel-header">
            <div class="panel-header-icon">${iconSvg}</div>
            <div class="panel-header-text">
                <div class="panel-header-title">${title}</div>
                <div class="panel-header-subtitle">${subtitle}</div>
            </div>
            ${actionsHtml || ''}
        </div>`;
}

// Generate the HTML for the "upload preview" state
function renderUploadPreviewHTML() {
    const totalBytes = selectedFiles.reduce((s, f) => s + f.file.size, 0);
    const doneCount = selectedFiles.filter(f => f.status === 'done').length;
    const errorCount = selectedFiles.filter(f => f.status === 'error').length;
    const uploadingCount = selectedFiles.filter(f => f.status === 'uploading').length;
    const uploadedBytes = selectedFiles.reduce((s, f) => {
        if (f.status === 'done') return s + f.file.size;
        if (f.status === 'uploading') return s + f.file.size * ((f.progress || 0) / 100);
        return s;
    }, 0);
    const pct = Math.round((uploadedBytes / Math.max(totalBytes, 1)) * 100);
    const allDone = doneCount === selectedFiles.length && selectedFiles.length > 0;

    let summaryMeta;
    if (uploadingCount > 0 || doneCount > 0) {
        summaryMeta = t('uploaded_ratio', { done: doneCount, total: selectedFiles.length });
        if (errorCount > 0) summaryMeta += ` · <span style="color:#dc2626;">${t('failed_count', errorCount)}</span>`;
    } else {
        summaryMeta = `${t('files_count', selectedFiles.length)} · ${formatSize(totalBytes)}`;
    }
    const showBar = uploadingCount > 0 || doneCount > 0;

    const statusText = allDone ? t('all_files_uploaded')
        : isPaused && uploadingCount > 0 ? t('pausing')
        : isPaused ? t('paused')
        : uploadingCount > 0 ? t('uploading_dots')
        : t('ready_to_upload');

    const summaryHtml = `
        <div class="upload-summary">
            <div class="upload-summary-line">
                <span class="upload-summary-text">${statusText}</span>
                <span class="upload-summary-meta">${formatSize(totalBytes)}</span>
            </div>
            <div class="upload-summary-meta" style="margin-top:0.2rem;">${summaryMeta}</div>
            ${showBar ? `
                <div class="upload-summary-bar">
                    <div class="upload-summary-bar-fill ${allDone ? 'complete' : ''}" style="width:${pct}%"></div>
                </div>` : ''}
        </div>`;

    const tree = buildTree();
    const rows = [];
    renderNode(tree, 0, rows);

    const hasPending = selectedFiles.some(f => !f.status || f.status === 'error');

    const headerTitle = allDone ? t('upload_complete')
        : isPaused ? t('upload_paused')
        : isUploading ? t('uploading_files')
        : t('files_to_upload');
    const headerSubtitle = `${t('files_count', selectedFiles.length)} · ${formatSize(totalBytes)}`;
    const headerIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>`;
    const headerActions = `<button class="panel-header-close" onclick="clearFiles()" title="${isUploading ? t('cancel_upload') : t('clear_all')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
    </button>`;

    return renderPanelHeader({
        iconSvg: headerIcon,
        title: headerTitle,
        subtitle: headerSubtitle,
        actionsHtml: headerActions,
    }) + `
        <div class="detail-body" style="padding:0;">
            ${summaryHtml}
            <div class="file-items">${rows.join('')}</div>
        </div>
        <div class="sticky-upload">
            ${isUploading ? `
                <button class="upload-btn ${isPaused ? '' : 'ghost'}" onclick="togglePause()">
                    ${isPaused ? t('resume') : t('pause')}
                </button>
            ` : `
                <button class="upload-btn" ${!hasPending ? 'disabled' : ''} onclick="upload()">
                    ${allDone ? t('btn_done') : t('btn_upload')}
                </button>
            `}
        </div>`;
}

// Right-panel coordinator:
// 1. if there are files queued → upload preview
// 2. else if a dataset is selected → dataset detail
// 3. else → empty state
// Also preserves the scroll position across re-renders.
// Right-panel view mode. The upload preview wins by default while there are
// pending/just-uploaded files, but selecting a dataset card overrides this so
// the user can browse server data without dismissing the upload first.
let rightPanelMode = 'auto';   // 'auto' | 'dataset'

function renderRightPanel() {
    const panel = document.getElementById('detailPanel');
    const oldBody = panel.querySelector('.detail-body');
    const savedScroll = oldBody ? oldBody.scrollTop : 0;

    const showDataset = rightPanelMode === 'dataset' && selectedDataset;
    if (!showDataset && selectedFiles.length > 0) {
        panel.innerHTML = renderUploadPreviewHTML();
    } else {
        renderDetailPanel();
    }

    const newBody = panel.querySelector('.detail-body');
    if (newBody) newBody.scrollTop = savedScroll;
}

// --- Upload: per-file XHR with real progress, bounded parallelism ---
let isUploading = false;
let isPaused = false;
const PARALLEL_LIMIT = 3;

// Pick today's date as the session name, with _2, _3, … suffix if that dataset
// already has a session for today. Uses local time so the name matches the
// user's calendar day. Safe when the dataset doesn't exist yet (404 → no sessions).
async function pickSessionName(dataset) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    if (!dataset) return base;

    let existing = new Set();
    try {
        const resp = await fetch(`/datasets/${encodeURIComponent(dataset)}`);
        if (resp.ok) {
            const data = await resp.json();
            for (const s of data.sessions || []) existing.add(s.name);
        }
    } catch (e) { /* new dataset or transient error — fall through with empty set */ }

    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base}_${i}`;
        if (!existing.has(candidate)) return candidate;
    }
    return base;
}

// Pair RGB + depth files in the browser before upload, so each pair lands at
// the server in ONE POST and the server-side _pair_rgb_depth can match them.
// Without this, the per-file POST pool sends RGB and depth in separate requests,
// the server sees each one alone, and falls back to dummy depth → 0 picker dots.
// Rule mirrors the server's _is_depth_for_rgb: same parent dir + bidirectional
// stem-prefix with a [_.-] separator on the longer side. Groups are capped at
// 2 items so an unrelated third file with the same prefix doesn't get sucked in.
function _stemOf(path) {
    const name = path.split('/').pop() || path;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}
function _parentOf(path) {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
}
function _stemsPair(a, b) {
    if (a === b) return true;
    if (b.startsWith(a) && b.length > a.length) return '_.-'.includes(b[a.length]);
    if (a.startsWith(b) && a.length > b.length) return '_.-'.includes(a[b.length]);
    return false;
}
function pairUploadGroups(items) {
    const groups = [];
    for (const item of items) {
        const stem = _stemOf(item.path);
        const parent = _parentOf(item.path);
        let placed = false;
        for (const g of groups) {
            if (g.length >= 2) continue;
            if (g[0]._parent !== parent) continue;
            if (_stemsPair(g[0]._stem, stem)) {
                g.push(item);
                if (stem.length < g[0]._stem.length) g[0]._stem = stem;
                placed = true;
                break;
            }
        }
        if (!placed) {
            const g = [item];
            g[0]._parent = parent;
            g[0]._stem = stem;
            groups.push(g);
        }
    }
    return groups;
}

async function upload() {
    if (isUploading) return;
    const dataset = document.getElementById('dataset').value.trim();
    let session = document.getElementById('session').value.trim();
    const metadata = document.getElementById('metadata').value.trim();

    const queue = selectedFiles.filter(f => !f.status || f.status === 'error');
    if (queue.length === 0) return;

    // If the user didn't specify a session, pick ONE date-based name here and share
    // it across every file so the whole batch lands in a single session folder.
    // (Without this, the server would generate a new timestamp per request → N folders.)
    if (!session) {
        session = await pickSessionName(dataset);
    }

    const uploadUrl = dataset
        ? `/upload/${encodeURIComponent(dataset)}`
        : `/upload`;

    isUploading = true;
    isPaused = false;
    syncLeftClose();
    renderFiles();

    // One batch_id shared by every parallel request in this run — tells the
    // server that all these files belong together so they land in the same
    // (auto-suffixed) dataset/session, not one per file.
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // Group the queue into RGB+depth pairs (where pairing applies) so each
    // POST carries both files together — the server can then pair them and
    // pass the depth to /infer, which the picker needs to produce dots.
    const groups = pairUploadGroups(queue);

    // Concurrency pool — each worker awaits pause before picking up the next group
    let idx = 0;
    const worker = async () => {
        while (idx < groups.length) {
            // Block here while paused (re-check every 150ms)
            while (isPaused) {
                await new Promise(r => setTimeout(r, 150));
                // If user cancelled entirely, bail
                if (!isUploading) return;
            }
            if (!isUploading) return;
            const group = groups[idx++];
            await uploadGroup(group, uploadUrl, session, metadata, dataset, batchId);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(PARALLEL_LIMIT, groups.length) }, worker)
    );

    isUploading = false;
    isPaused = false;
    syncLeftClose();
    renderFiles();
    loadDatasets();
}

function togglePause() {
    if (!isUploading) return;
    isPaused = !isPaused;
    renderFilesImmediate();
}

// POST a group of 1-2 paired files (RGB + optional depth) in a single
// multipart request. Server's _pair_rgb_depth then sees both files in the
// same _do_upload call and forwards (RGB, depth) to /infer together.
// Per-item status fields (status/progress/uploadResult) are tracked for every
// item in the group; XHR progress applies to the whole upload.
function uploadGroup(group, uploadUrl, session, metadata, dataset, batchId) {
    return new Promise((resolve) => {
        const fd = new FormData();
        if (session) fd.append('session', session);
        if (metadata) fd.append('metadata', metadata);
        if (batchId) fd.append('batch_id', batchId);

        const savePaths = [];
        for (const item of group) {
            let savePath = item.path;
            if (dataset && savePath.startsWith(dataset + '/')) {
                savePath = savePath.slice(dataset.length + 1);
            }
            savePaths.push(savePath);
            fd.append('files', item.file, item.file.name);
            fd.append('paths', savePath);
        }

        const xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl);
        activeUploadXHRs.add(xhr);

        const finish = () => {
            activeUploadXHRs.delete(xhr);
            resolve();
        };

        for (const item of group) {
            item.status = 'uploading';
            item.progress = 0;
            item.bytesUploaded = false;
        }
        renderFiles();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                for (const item of group) item.progress = pct;
                renderFiles();
            }
        });

        xhr.upload.addEventListener('loadend', () => {
            for (const item of group) {
                item.bytesUploaded = true;
                item.progress = 100;
            }
            renderFiles();
        });

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                let resp = null;
                try { resp = JSON.parse(xhr.responseText); } catch (e) {}
                // Server returns one "uploaded" entry per file in the POST,
                // keyed by relative filename. Match each item back to its entry
                // so the row can render its overlay/thumb just like the
                // single-file path did.
                const byName = new Map();
                if (resp && Array.isArray(resp.uploaded)) {
                    for (const u of resp.uploaded) byName.set(u.filename, u);
                }
                for (let gi = 0; gi < group.length; gi++) {
                    const item = group[gi];
                    item.status = 'done';
                    item.progress = 100;
                    const u = byName.get(savePaths[gi]) || (resp && (resp.uploaded || [])[gi]);
                    if (u && resp && resp.dataset && resp.session) {
                        const buildUrl = (rel) =>
                            `/datasets/${encodeURIComponent(resp.dataset)}/${encodeURIComponent(resp.session)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
                        item.uploadResult = {
                            sourceUrl: buildUrl(u.filename),
                            overlayUrl: u.overlay ? buildUrl(u.overlay) : null,
                            sourceThumb: thumbUrl(resp.dataset, resp.session, u.filename),
                            overlayThumb: u.overlay ? thumbUrl(resp.dataset, resp.session, u.overlay) : null,
                            sourcePreview: thumbUrl(resp.dataset, resp.session, u.filename, LIGHTBOX_MAX_EDGE),
                            overlayPreview: u.overlay ? thumbUrl(resp.dataset, resp.session, u.overlay, LIGHTBOX_MAX_EDGE) : null,
                            graspJsonUrl: u.grasp_json ? buildUrl(u.grasp_json) : null,
                            kind: u.kind || 'rgb',
                            pairedRgb: null,
                            label: u.filename,
                        };
                    }
                }
            } else {
                for (const item of group) {
                    item.status = 'error';
                    item.error = `HTTP ${xhr.status}`;
                }
            }
            renderFiles();
            finish();
        };

        xhr.onerror = () => {
            for (const item of group) {
                item.status = 'error';
                item.error = 'Network error';
            }
            renderFiles();
            finish();
        };

        xhr.onabort = () => { finish(); };

        try {
            xhr.send(fd);
        } catch (e) {
            for (const item of group) {
                item.status = 'error';
                item.error = e.message;
            }
            renderFiles();
            finish();
        }
    });
}

function uploadOne(item, uploadUrl, session, metadata, dataset, batchId) {
    return new Promise((resolve) => {
        // If the dataset name matches the top-level folder in the path, strip
        // that folder so files don't end up in <dataset>/<session>/<dataset>/...
        let savePath = item.path;
        if (dataset && savePath.startsWith(dataset + '/')) {
            savePath = savePath.slice(dataset.length + 1);
        }

        const fd = new FormData();
        if (session) fd.append('session', session);
        if (metadata) fd.append('metadata', metadata);
        if (batchId) fd.append('batch_id', batchId);
        fd.append('files', item.file, item.file.name);
        fd.append('paths', savePath);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl);
        activeUploadXHRs.add(xhr);

        const finish = () => {
            activeUploadXHRs.delete(xhr);
            resolve();
        };

        item.status = 'uploading';
        item.progress = 0;
        item.bytesUploaded = false;
        renderFiles();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                item.progress = Math.round((e.loaded / e.total) * 100);
                renderFiles();
            }
        });

        // Fires once all request bytes have left the browser. After this point
        // the file is sitting on the server while it runs inference — the UI
        // uses this to switch from "uploading" to "processing masks" cleanly.
        xhr.upload.addEventListener('loadend', () => {
            item.bytesUploaded = true;
            item.progress = 100;
            renderFiles();
        });

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                item.status = 'done';
                item.progress = 100;
                // Capture per-file result so the row can preview the mask overlay
                // immediately, without waiting for the dataset list to refresh.
                try {
                    const resp = JSON.parse(xhr.responseText);
                    const u = (resp.uploaded || [])[0];
                    if (u && resp.dataset && resp.session) {
                        const buildUrl = (rel) =>
                            `/datasets/${encodeURIComponent(resp.dataset)}/${encodeURIComponent(resp.session)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
                        item.uploadResult = {
                            sourceUrl: buildUrl(u.filename),
                            overlayUrl: u.overlay ? buildUrl(u.overlay) : null,
                            sourceThumb: thumbUrl(resp.dataset, resp.session, u.filename),
                            overlayThumb: u.overlay ? thumbUrl(resp.dataset, resp.session, u.overlay) : null,
                            sourcePreview: thumbUrl(resp.dataset, resp.session, u.filename, LIGHTBOX_MAX_EDGE),
                            overlayPreview: u.overlay ? thumbUrl(resp.dataset, resp.session, u.overlay, LIGHTBOX_MAX_EDGE) : null,
                            graspJsonUrl: u.grasp_json ? buildUrl(u.grasp_json) : null,
                            kind: u.kind || 'rgb',
                            pairedRgb: u.depth ? null : null,  // depth files don't carry their RGB pair in the per-POST response
                            label: u.filename,
                        };
                    }
                } catch (e) { /* response wasn't JSON — ignore */ }
            } else {
                item.status = 'error';
                item.error = `HTTP ${xhr.status}`;
            }
            renderFiles();
            finish();
        };

        xhr.onerror = () => {
            item.status = 'error';
            item.error = 'Network error';
            renderFiles();
            finish();
        };

        xhr.onabort = () => {
            // User cancelled — just resolve silently
            finish();
        };

        try {
            xhr.send(fd);
        } catch (e) {
            item.status = 'error';
            item.error = e.message;
            renderFiles();
            finish();
        }
    });
}

// --- Browse datasets ---
let datasetsCache = [];              // last list from the server
let selectedDataset = null;          // currently selected dataset name (shown in detail panel)
let datasetDetails = new Map();      // name → { sessions: [...] } cache
let datasetSearch = '';              // current search query
let datasetSort = 'modified_desc';   // current sort key

// Format a unix-epoch seconds timestamp as "N minutes/hours/days ago"
function relativeTime(ts) {
    if (!ts) return '';
    const secs = Math.floor(Date.now() / 1000 - ts);
    if (secs < 45) return t('just_now');
    if (secs < 90) return t('min_1');
    const mins = Math.round(secs / 60);
    if (mins < 45) return t('mins_ago', mins);
    if (mins < 90) return t('hour_1');
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return t('hours_ago', hrs);
    if (hrs < 48) return t('yesterday');
    const days = Math.round(hrs / 24);
    if (days < 30) return t('days_ago', days);
    const months = Math.round(days / 30);
    if (months < 12) return t('months_ago', months);
    return t('years_ago', Math.round(months / 12));
}

function sortedFilteredDatasets() {
    const q = datasetSearch.trim().toLowerCase();
    let list = datasetsCache.filter(d =>
        !q || d.name.toLowerCase().includes(q) ||
        (d.sessions || []).some(s => s.toLowerCase().includes(q))
    );
    const cmp = {
        modified_desc: (a, b) => (b.modified_at || 0) - (a.modified_at || 0),
        modified_asc:  (a, b) => (a.modified_at || 0) - (b.modified_at || 0),
        name_asc:      (a, b) => a.name.localeCompare(b.name),
        name_desc:     (a, b) => b.name.localeCompare(a.name),
        size_desc:     (a, b) => b.total_size_bytes - a.total_size_bytes,
        size_asc:      (a, b) => a.total_size_bytes - b.total_size_bytes,
    }[datasetSort];
    return cmp ? [...list].sort(cmp) : list;
}

let datasetsLoading = false;

// Reflect loading state on the refresh icon so a re-fetch triggered by code
// (e.g. right after upload) is visible even when nothing else has changed.
function syncRefreshButton() {
    const btn = document.querySelector('.datasets-header .refresh-btn');
    if (!btn) return;
    btn.classList.toggle('loading', datasetsLoading);
}

async function loadDatasets() {
    const container = document.getElementById('datasetsList');
    datasetsLoading = true;
    renderDatasets();
    try {
        const resp = await fetch('/datasets');
        const data = await resp.json();
        datasetsCache = data.datasets;

        // Drop cached details for datasets that no longer exist OR whose
        // top-level summary (file count / sessions / mtime) has changed since
        // we last fetched their detail — keeps the detail panel honest.
        const byName = new Map(datasetsCache.map(d => [d.name, d]));
        for (const k of [...datasetDetails.keys()]) {
            const live = byName.get(k);
            const cached = datasetDetails.get(k);
            const stale = !live
                || live.file_count !== cached.file_count
                || (live.session_count ?? live.sessions?.length) !== cached.sessions?.length
                || live.modified_at !== cached._mtime;
            if (stale) datasetDetails.delete(k);
        }
        // Deselect if selected dataset was deleted
        if (selectedDataset && !byName.has(selectedDataset)) selectedDataset = null;

        datasetsLoading = false;
        renderDatasets();
        renderDetailPanel();

        // Refresh detail for currently selected dataset
        if (selectedDataset) fetchDatasetDetail(selectedDataset);
    } catch (e) {
        datasetsLoading = false;
        container.innerHTML = `<div class="empty-state">${t('failed_to_load')}</div>`;
    }
}

function renderDatasets() {
    const container = document.getElementById('datasetsList');
    syncRefreshButton();

    // First-load: no cache yet AND a fetch is in flight → skeleton cards.
    if (datasetsLoading && datasetsCache.length === 0) {
        const skel = `
            <div class="dataset-card dataset-card--skeleton">
                <div class="dataset-card-row">
                    <div class="skeleton-shape skeleton-icon"></div>
                    <div class="dataset-card-info">
                        <div class="skeleton-shape skeleton-line skeleton-line--title"></div>
                        <div class="skeleton-shape skeleton-line skeleton-line--meta"></div>
                    </div>
                </div>
            </div>`;
        container.innerHTML = skel.repeat(3);
        return;
    }

    if (datasetsCache.length === 0) {
        container.innerHTML = `<div class="empty-state">${t('no_datasets_yet')}</div>`;
        return;
    }

    const visible = sortedFilteredDatasets();
    if (visible.length === 0) {
        container.innerHTML = `<div class="empty-state">${t('no_datasets_match', datasetSearch)}</div>`;
        return;
    }

    container.innerHTML = visible.map(ds => {
        const safe = ds.name.replace(/'/g, "\\'");
        const isSelected = selectedDataset === ds.name;
        const isEmpty = ds.file_count === 0;
        const when = relativeTime(ds.modified_at);
        const sessionLabel = t('sessions_count', ds.session_count);

        return `
        <div class="dataset-card ${isSelected ? 'selected' : ''} ${isEmpty ? 'empty' : ''}" onclick="selectDataset('${safe}')">
            <div class="dataset-card-row">
                <div class="dataset-card-icon">${ICON_FOLDER}</div>
                <div class="dataset-card-info">
                    <div class="dataset-card-top">
                        <div class="dataset-card-name" title="${ds.name}">${ds.name}</div>
                        <span class="dataset-card-stats-pill">${formatSize(ds.total_size_bytes)}</span>
                    </div>
                    <div class="dataset-card-meta">
                        <span>${t('files_count', ds.file_count)}</span>
                        <span class="dot">·</span>
                        <span>${sessionLabel}</span>
                        ${when ? `<span class="dot">·</span><span>${when}</span>` : ''}
                    </div>
                </div>
                <button class="dataset-delete-btn" onclick="event.stopPropagation(); deleteDataset('${safe}', ${ds.file_count})" title="${t('delete_dataset_title')}">${ICON_TRASH}</button>
            </div>
        </div>`;
    }).join('');
}

// Wire up search + custom sort dropdown (once). Labels are looked up by
// `sort_<key>` so the i18n table is the single source of truth.

function setupDatasetControls() {
    const search = document.getElementById('datasetSearch');
    if (search) {
        search.addEventListener('input', (e) => {
            datasetSearch = e.target.value;
            renderDatasets();
        });
    }

    const wrap = document.getElementById('sortWrap');
    const button = document.getElementById('sortButton');
    const label = document.getElementById('sortLabel');
    const menu = document.getElementById('sortMenu');
    if (!wrap) return;

    function refreshSortUI() {
        menu.querySelectorAll('.sort-option').forEach((o) => {
            o.classList.toggle('selected', o.dataset.sort === datasetSort);
        });
        if (label) label.textContent = t('sort_' + datasetSort);
    }

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        wrap.classList.toggle('open');
    });

    menu.addEventListener('click', (e) => {
        const opt = e.target.closest('.sort-option');
        if (!opt) return;
        datasetSort = opt.dataset.sort;
        wrap.classList.remove('open');
        refreshSortUI();
        renderDatasets();
    });

    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) wrap.classList.remove('open');
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') wrap.classList.remove('open');
    });

    refreshSortUI();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDatasetControls);
} else {
    setupDatasetControls();
}

function renderDetailPanel() {
    // Pending files normally own the right panel — but yield it when the
    // user has explicitly selected a dataset to browse.
    if (selectedFiles.length > 0 && rightPanelMode !== 'dataset') {
        renderRightPanel();
        return;
    }
    const panel = document.getElementById('detailPanel');

    // Empty state: no dataset selected, no files
    if (!selectedDataset) {
        const emptyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 4H2v16h20V6H12l-2-2z"/>
        </svg>`;
        panel.innerHTML = renderPanelHeader({
            iconSvg: emptyIcon,
            title: t('preview'),
            subtitle: t('preview_sub'),
        }) + `
            <div class="detail-empty">
                ${ICON_FOLDER}
                <div>${t('detail_empty_text')}</div>
            </div>`;
        return;
    }

    const ds = datasetsCache.find(d => d.name === selectedDataset);
    const detail = datasetDetails.get(selectedDataset);
    const safe = selectedDataset.replace(/'/g, "\\'");
    const totalFiles = ds ? ds.file_count : 0;
    const totalSize = ds ? formatSize(ds.total_size_bytes) : '';
    const sessionCount = ds ? ds.sessions.length : 0;

    const dsIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H2v16h20V6H12l-2-2z"/></svg>`;
    const dsActions = `
        <button class="panel-header-close" onclick="deleteDataset('${safe}', ${totalFiles})" title="${t('delete_dataset_title')}" style="margin-right:0.25rem;">
            ${ICON_TRASH}
        </button>
        <button class="panel-header-close" onclick="selectDataset(null)" title="${t('close')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
        </button>`;

    const headerHtml = renderPanelHeader({
        iconSvg: dsIcon,
        title: selectedDataset,
        subtitle: `${t('files_count', totalFiles)} · ${totalSize} · ${t('sessions_count', sessionCount)}`,
        actionsHtml: dsActions,
    });

    let bodyHtml;
    const sessions = detail?.sessions;
    const cachedSessionCount = Array.isArray(sessions) ? sessions.length : 0;
    const liveSessionCount = ds?.session_count ?? 0;
    // List and detail disagree — flag it loudly so we can debug, but DON'T
    // auto-refetch (that just causes infinite loops if the server is the
    // one returning empty data).
    const mismatch = detail && cachedSessionCount === 0 && liveSessionCount > 0;
    const errMsg = detail?.error;
    if (!detail) {
        bodyHtml = `<div class="detail-body"><div class="empty-state">${t('loading')}</div></div>`;
    } else if (cachedSessionCount === 0) {
        const errLine = errMsg ? `<br><br><span style="color:#c52c4a;">${t('error_prefix', errMsg)}</span>` : '';
        bodyHtml = mismatch
            ? `<div class="detail-body"><div class="empty-state">
                   ${t('mismatch_msg', liveSessionCount)}${errLine}
                   <br><br>
                   <button class="browse-btn" onclick="datasetDetails.delete('${selectedDataset.replace(/'/g, "\\'")}'); fetchDatasetDetail('${selectedDataset.replace(/'/g, "\\'")}')">${t('try_again')}</button>
               </div></div>`
            : `<div class="detail-body"><div class="empty-state">${t('no_sessions')}${errLine}</div></div>`;
    } else {
        // Reset the flat lightbox list before re-rendering — renderEntry()
        // appends to it as it walks each session.
        lightboxItems = [];
        bodyHtml = `<div class="detail-body">${detail.sessions.map(s => {
            const safeS = s.name.replace(/'/g, "\\'");
            const { displayed } = pairOverlays(s.files, s.depth_pairs);
            // Sort so paired RGB+depth files appear next to each other:
            //   RGB/000000.png  (rgb)
            //   Depth/000000.png (its pair)
            //   RGB/000001.png  (rgb)
            //   Depth/000001.png (its pair)
            // Achieved by sorting depth files by their PAIRED RGB's path
            // instead of their own path.  Within the same primary key
            // (the rgb path), RGB sorts before depth via the secondary
            // rank.  Unpaired files keep their natural path order.
            displayed.sort((a, b) => {
                const keyA = (a.kind === 'depth' && a.pairedRgb) ? a.pairedRgb : a.path;
                const keyB = (b.kind === 'depth' && b.pairedRgb) ? b.pairedRgb : b.path;
                const cmp = keyA.localeCompare(keyB, undefined, { numeric: true, sensitivity: 'base' });
                if (cmp !== 0) return cmp;
                // Same primary key → RGB (0) before depth (1).
                const rank = (e) => e.kind === 'depth' ? 1 : 0;
                return rank(a) - rank(b);
            });
            const shown = displayed.slice(0, 100);
            const fileUrl = (rel) => `/datasets/${encodeURIComponent(selectedDataset)}/${encodeURIComponent(s.name)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
            return `
            <div class="session-group">
                <div class="session-group-header">
                    <div class="session-group-folder">${ICON_FOLDER}</div>
                    <span class="session-group-name">${s.name}</span>
                    <span class="session-group-stats">${t('session_files_stats', { n: s.file_count, size: formatSize(s.total_size_bytes) })}</span>
                    <button class="session-delete-btn" style="opacity:1;" onclick="deleteSession('${safe}', '${safeS}', ${s.file_count})" title="${t('delete_session_title')}">${ICON_TRASH}</button>
                </div>
                <div class="session-files">
                    ${shown.map(entry => renderEntry(entry, fileUrl, s.name)).join('')}
                    ${displayed.length > shown.length ? `<div class="file-link" style="color:#A9ACB4;">${t('more_files', displayed.length - shown.length)}</div>` : ''}
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    panel.innerHTML = headerHtml + bodyHtml;
}

async function fetchDatasetDetail(name) {
    // Fetch first, then render — keeping render outside the try block so a
    // render bug never overwrites valid data with the catch-path empty stub.
    let stored;
    try {
        const resp = await fetch(`/datasets/${encodeURIComponent(name)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data?.sessions)) {
            throw new Error(`Server response missing 'sessions' array`);
        }
        const live = datasetsCache.find(d => d.name === name);
        if (live) data._mtime = live.modified_at;
        stored = data;
    } catch (e) {
        console.error('[fetchDatasetDetail] failed', name, e);
        stored = { sessions: [], error: String(e.message || e) };
    }
    datasetDetails.set(name, stored);
    if (selectedDataset === name) renderDetailPanel();
}

function selectDataset(name) {
    selectedDataset = name;
    rightPanelMode = name ? 'dataset' : 'auto';
    renderDatasets();
    renderRightPanel();
    // Always refetch on click — the cache is only useful as an instant render
    // hint; the source of truth lives on the server. This avoids stale "no
    // sessions" states after deletes, renames, or background changes.
    if (name) fetchDatasetDetail(name);
}

async function deleteDataset(name, fileCount) {
    if (!confirm(t('confirm_delete_dataset', { name, n: fileCount }))) return;
    try {
        const resp = await fetch(`/datasets/${encodeURIComponent(name)}?confirm=true`, { method: 'DELETE' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        datasetDetails.delete(name);
        if (selectedDataset === name) selectedDataset = null;
        loadDatasets();
    } catch (e) {
        alert(t('failed_to_delete', e.message));
    }
}

async function deleteSession(dataset, session, fileCount) {
    if (!confirm(t('confirm_delete_session', { dataset, session, n: fileCount }))) return;
    try {
        const resp = await fetch(`/datasets/${encodeURIComponent(dataset)}/${encodeURIComponent(session)}?confirm=true`, { method: 'DELETE' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        datasetDetails.delete(dataset);
        loadDatasets();
    } catch (e) {
        alert(t('failed_to_delete', e.message));
    }
}

// Keep the right panel height in sync with the left panel
function syncPanelHeights() {
    const left = document.querySelector('.container');
    const right = document.getElementById('detailPanel');
    if (!left || !right) return;
    right.style.height = left.offsetHeight + 'px';
}

// Re-sync on initial load, resize, and any time the left panel might resize
window.addEventListener('load', syncPanelHeights);
window.addEventListener('resize', syncPanelHeights);
// Observe left panel size changes (e.g. metadata textarea resize)
const leftPanel = document.querySelector('.container');
if (leftPanel && 'ResizeObserver' in window) {
    new ResizeObserver(() => syncPanelHeights()).observe(leftPanel);
}

// Re-render every JS-built string when the user switches language. i18n.js
// has already swapped the static data-i18n nodes by the time this fires;
// here we repaint the dynamic panels (upload preview, dataset list, detail).
document.addEventListener('i18n:changed', () => {
    renderFilesImmediate();   // upload preview / dropzone summary / overlay / detail
    renderDatasets();         // dataset cards on the bottom list
    // The sort label is overwritten by JS, so applyTranslations() can't keep
    // it in sync with the *current* sort — reset it to the active option here.
    const label = document.getElementById('sortLabel');
    if (label) label.textContent = t('sort_' + datasetSort);
});

// Load on start
renderRightPanel();   // paint the empty state immediately
syncPanelHeights();
loadDatasets();
