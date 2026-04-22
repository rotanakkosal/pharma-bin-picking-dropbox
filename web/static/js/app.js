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
    }
    autofillDatasetName();
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
    btn.title = isUploading ? 'Use the right panel to cancel' : 'Clear all';
}

function clearFiles() {
    if (isUploading) {
        if (!confirm('An upload is in progress. Cancel and remove all files?')) return;
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
        statusHtml = `<span class="tree-status error">${stats.errorCount} failed</span>`;
    } else if (showProgress) {
        statusHtml = `
            <div class="tree-mini-bar"><div class="tree-mini-bar-fill" style="width:${pct}%"></div></div>
            <span class="tree-status uploading">${stats.doneCount}/${stats.fileCount}</span>`;
    } else if (stats.doneCount === stats.fileCount && stats.fileCount > 0) {
        statusHtml = `<span class="tree-status done">${ICON_CHECK}Done</span>`;
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
                <span>${stats.fileCount} file${stats.fileCount > 1 ? 's' : ''}</span>
                <span>·</span>
                <span>${formatSize(stats.totalSize)}</span>
            </div>
            <button class="tree-row-action" onclick="event.stopPropagation(); removeFolder('${safePath}')" title="Remove folder">${ICON_TRASH}</button>
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
        statusHtml = `<span class="tree-status done">${ICON_CHECK}Done</span>`;
    } else if (item.status === 'error') {
        statusHtml = `<span class="tree-status error">Failed</span>`;
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
            </div>
            <div class="tree-row-stats">
                ${statusHtml}
                <span>${sizeLabel}</span>
            </div>
            <button class="tree-row-action" onclick="removeFile(${node.index})" title="Remove">${ICON_TRASH}</button>
        </div>`;
}

// Depth-first render of visible rows
function renderNode(node, depth, out) {
    const sorted = [...node.children.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
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
    });
}

// Force an immediate render (for click handlers that must update UI now)
function renderFilesImmediate() {
    _renderScheduled = false;
    renderRightPanel();
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
        summaryMeta = `${doneCount}/${selectedFiles.length} uploaded`;
        if (errorCount > 0) summaryMeta += ` · <span style="color:#dc2626;">${errorCount} failed</span>`;
    } else {
        summaryMeta = `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} · ${formatSize(totalBytes)}`;
    }
    const showBar = uploadingCount > 0 || doneCount > 0;

    const statusText = allDone ? 'All files uploaded'
        : isPaused && uploadingCount > 0 ? 'Pausing... (finishing current files)'
        : isPaused ? 'Paused'
        : uploadingCount > 0 ? 'Uploading...'
        : 'Ready to upload';

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

    const headerTitle = allDone ? 'Upload complete'
        : isPaused ? 'Upload paused'
        : isUploading ? 'Uploading files'
        : 'Files to upload';
    const headerSubtitle = `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} · ${formatSize(totalBytes)}`;
    const headerIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>`;
    const headerActions = `<button class="panel-header-close" onclick="clearFiles()" title="${isUploading ? 'Cancel upload' : 'Clear all'}">
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
                    ${isPaused ? 'Resume' : 'Pause'}
                </button>
            ` : `
                <button class="upload-btn" ${!hasPending ? 'disabled' : ''} onclick="upload()">
                    ${allDone ? 'Done' : 'Upload'}
                </button>
            `}
        </div>`;
}

// Right-panel coordinator:
// 1. if there are files queued → upload preview
// 2. else if a dataset is selected → dataset detail
// 3. else → empty state
// Also preserves the scroll position across re-renders.
function renderRightPanel() {
    const panel = document.getElementById('detailPanel');
    const oldBody = panel.querySelector('.detail-body');
    const savedScroll = oldBody ? oldBody.scrollTop : 0;

    if (selectedFiles.length > 0) {
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

async function upload() {
    if (isUploading) return;
    const dataset = document.getElementById('dataset').value.trim();
    let session = document.getElementById('session').value.trim();
    const metadata = document.getElementById('metadata').value.trim();

    const queue = selectedFiles.filter(f => !f.status || f.status === 'error');
    if (queue.length === 0) return;

    // If the user didn't specify a session, generate ONE timestamp here and share
    // it across every file so the whole batch lands in a single session folder.
    // (Without this, the server would generate a new timestamp per request → N folders.)
    if (!session) {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        session = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    }

    const uploadUrl = dataset
        ? `/upload/${encodeURIComponent(dataset)}`
        : `/upload`;

    isUploading = true;
    isPaused = false;
    syncLeftClose();
    renderFiles();

    // Concurrency pool — each worker awaits pause before picking up the next file
    let idx = 0;
    const worker = async () => {
        while (idx < queue.length) {
            // Block here while paused (re-check every 150ms)
            while (isPaused) {
                await new Promise(r => setTimeout(r, 150));
                // If user cancelled entirely, bail
                if (!isUploading) return;
            }
            if (!isUploading) return;
            const item = queue[idx++];
            await uploadOne(item, uploadUrl, session, metadata, dataset);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(PARALLEL_LIMIT, queue.length) }, worker)
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

function uploadOne(item, uploadUrl, session, metadata, dataset) {
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
        renderFiles();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                item.progress = Math.round((e.loaded / e.total) * 100);
                renderFiles();
            }
        });

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                item.status = 'done';
                item.progress = 100;
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
    if (secs < 45) return 'just now';
    if (secs < 90) return '1 minute ago';
    const mins = Math.round(secs / 60);
    if (mins < 45) return `${mins} minutes ago`;
    if (mins < 90) return '1 hour ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hours ago`;
    if (hrs < 48) return 'yesterday';
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} months ago`;
    return `${Math.round(months / 12)} years ago`;
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

async function loadDatasets() {
    const container = document.getElementById('datasetsList');
    try {
        const resp = await fetch('/datasets');
        const data = await resp.json();
        datasetsCache = data.datasets;

        // Drop cached details for datasets that no longer exist
        const names = new Set(datasetsCache.map(d => d.name));
        for (const k of [...datasetDetails.keys()]) {
            if (!names.has(k)) datasetDetails.delete(k);
        }
        // Deselect if selected dataset was deleted
        if (selectedDataset && !names.has(selectedDataset)) selectedDataset = null;

        renderDatasets();
        renderDetailPanel();

        // Refresh detail for currently selected dataset
        if (selectedDataset) fetchDatasetDetail(selectedDataset);
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Failed to load datasets.</div>';
    }
}

function renderDatasets() {
    const container = document.getElementById('datasetsList');
    if (datasetsCache.length === 0) {
        container.innerHTML = '<div class="empty-state">No datasets yet. Upload some files to get started.</div>';
        return;
    }

    const visible = sortedFilteredDatasets();
    if (visible.length === 0) {
        container.innerHTML = `<div class="empty-state">No datasets match "${datasetSearch}"</div>`;
        return;
    }

    container.innerHTML = visible.map(ds => {
        const safe = ds.name.replace(/'/g, "\\'");
        const isSelected = selectedDataset === ds.name;
        const isEmpty = ds.file_count === 0;
        const when = relativeTime(ds.modified_at);
        const sessionLabel = ds.session_count === 1 ? '1 session' : `${ds.session_count} sessions`;

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
                        <span>${ds.file_count} file${ds.file_count === 1 ? '' : 's'}</span>
                        <span class="dot">·</span>
                        <span>${sessionLabel}</span>
                        ${when ? `<span class="dot">·</span><span>${when}</span>` : ''}
                    </div>
                </div>
                <button class="dataset-delete-btn" onclick="event.stopPropagation(); deleteDataset('${safe}', ${ds.file_count})" title="Delete dataset">${ICON_TRASH}</button>
            </div>
        </div>`;
    }).join('');
}

// Wire up search + custom sort dropdown (once)
const SORT_LABELS = {
    modified_desc: 'Newest first',
    modified_asc: 'Oldest first',
    name_asc: 'Name A–Z',
    name_desc: 'Name Z–A',
    size_desc: 'Largest first',
    size_asc: 'Smallest first',
};

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
        if (label) label.textContent = SORT_LABELS[datasetSort] || 'Sort by';
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
    // If files are queued, the upload preview owns the right panel.
    if (selectedFiles.length > 0) {
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
            title: 'Preview',
            subtitle: 'Upload files or select a dataset',
        }) + `
            <div class="detail-empty">
                ${ICON_FOLDER}
                <div>Drop files on the left<br>or select a dataset below</div>
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
        <button class="panel-header-close" onclick="deleteDataset('${safe}', ${totalFiles})" title="Delete dataset" style="margin-right:0.25rem;">
            ${ICON_TRASH}
        </button>
        <button class="panel-header-close" onclick="selectDataset(null)" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
        </button>`;

    const headerHtml = renderPanelHeader({
        iconSvg: dsIcon,
        title: selectedDataset,
        subtitle: `${totalFiles} file${totalFiles === 1 ? '' : 's'} · ${totalSize} · ${sessionCount} session${sessionCount === 1 ? '' : 's'}`,
        actionsHtml: dsActions,
    });

    let bodyHtml;
    if (!detail) {
        bodyHtml = `<div class="detail-body"><div class="empty-state">Loading...</div></div>`;
    } else if (detail.sessions.length === 0) {
        bodyHtml = `<div class="detail-body"><div class="empty-state">This dataset has no sessions.</div></div>`;
    } else {
        bodyHtml = `<div class="detail-body">${detail.sessions.map(s => {
            const safeS = s.name.replace(/'/g, "\\'");
            const shown = s.files.slice(0, 100);
            return `
            <div class="session-group">
                <div class="session-group-header">
                    <div class="session-group-folder">${ICON_FOLDER}</div>
                    <span class="session-group-name">${s.name}</span>
                    <span class="session-group-stats">${s.file_count} files · ${formatSize(s.total_size_bytes)}</span>
                    <button class="session-delete-btn" style="opacity:1;" onclick="deleteSession('${safe}', '${safeS}', ${s.file_count})" title="Delete session">${ICON_TRASH}</button>
                </div>
                <div class="session-files">
                    ${shown.map(f => `
                        <a href="/datasets/${encodeURIComponent(selectedDataset)}/${encodeURIComponent(s.name)}/${f.split('/').map(encodeURIComponent).join('/')}"
                           class="file-link" target="_blank" title="Download ${f}">
                            <span class="file-link-name">${f}</span>
                        </a>`).join('')}
                    ${s.files.length > shown.length ? `<div class="file-link" style="color:#A9ACB4;">… and ${s.files.length - shown.length} more files</div>` : ''}
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    panel.innerHTML = headerHtml + bodyHtml;
}

async function fetchDatasetDetail(name) {
    try {
        const resp = await fetch(`/datasets/${encodeURIComponent(name)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        datasetDetails.set(name, data);
        if (selectedDataset === name) renderDetailPanel();
    } catch (e) {
        datasetDetails.set(name, { sessions: [], error: e.message });
        if (selectedDataset === name) renderDetailPanel();
    }
}

function selectDataset(name) {
    selectedDataset = name;
    renderDatasets();
    renderDetailPanel();
    if (name && !datasetDetails.has(name)) fetchDatasetDetail(name);
}

async function deleteDataset(name, fileCount) {
    if (!confirm(`Delete dataset "${name}"?\n\nThis will permanently remove ${fileCount} file${fileCount === 1 ? '' : 's'}.`)) return;
    try {
        const resp = await fetch(`/datasets/${encodeURIComponent(name)}?confirm=true`, { method: 'DELETE' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        datasetDetails.delete(name);
        if (selectedDataset === name) selectedDataset = null;
        loadDatasets();
    } catch (e) {
        alert(`Failed to delete: ${e.message}`);
    }
}

async function deleteSession(dataset, session, fileCount) {
    if (!confirm(`Delete session "${session}" from "${dataset}"?\n\nThis will permanently remove ${fileCount} file${fileCount === 1 ? '' : 's'}.`)) return;
    try {
        const resp = await fetch(`/datasets/${encodeURIComponent(dataset)}/${encodeURIComponent(session)}?confirm=true`, { method: 'DELETE' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        datasetDetails.delete(dataset);
        loadDatasets();
    } catch (e) {
        alert(`Failed to delete: ${e.message}`);
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

// Load on start
renderRightPanel();   // paint the empty state immediately
syncPanelHeights();
loadDatasets();
