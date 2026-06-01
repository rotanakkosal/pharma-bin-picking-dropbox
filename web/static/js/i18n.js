// Lightweight client-side i18n for the dropbox UI.
//
// Two languages: Korean ('ko', default) and English ('en'). The chosen
// language is remembered in localStorage so it survives reloads.
//
// Translation values are either:
//   - a plain string (optionally with {placeholders} replaced via t(key, {...}))
//   - a function (value) => string, for plurals / count formatting
//
// Static HTML text is marked with attributes the page applies on load:
//   data-i18n            → element.innerHTML   (safe: only trusted strings)
//   data-i18n-placeholder→ placeholder attr
//   data-i18n-title      → title attr
//   data-i18n-aria-label → aria-label attr
//   <body data-doctitle="key"> → document.title
//
// JS-built strings call the global t('key', params).

const I18N = {
    en: {
        // --- document titles ---
        doc_title_index: 'Pharma Bin Picking Data Upload',
        doc_title_login: 'Sign in — Pharma Bin Picking',

        // --- left upload panel ---
        upload_files: 'Upload files',
        upload_files_sub: 'Select and upload the files of your choice',
        what_to_upload_btn: 'What to upload?',
        what_to_upload_title: 'What to upload to get grasp points',
        clear_all: 'Clear all',
        dataset_label: 'Dataset name (optional)',
        auto_generated: 'auto-generated if empty',
        session_label: 'Session (optional)',
        metadata_label: 'Metadata JSON (optional)',
        dropzone_text: 'Choose a file or drag & drop it here',
        dropzone_hint: 'Any file type or folder, structure preserved on the server',
        dropzone_summary_hint: 'Drop more or click to add',
        browse_file: 'Browse File',

        // --- datasets list ---
        datasets_on_server: 'Datasets on server',
        refresh: 'Refresh',
        search_datasets: 'Search datasets...',
        sort_modified_desc: 'Newest first',
        sort_modified_asc: 'Oldest first',
        sort_name_asc: 'Name A–Z',
        sort_name_desc: 'Name Z–A',
        sort_size_desc: 'Largest first',
        sort_size_asc: 'Smallest first',
        loading: 'Loading...',
        failed_to_load: 'Failed to load datasets.',
        no_datasets_yet: 'No datasets yet. Upload some files to get started.',
        no_datasets_match: (q) => `No datasets match "${q}"`,

        // --- "What to upload" modal ---
        req_sub: 'The server returns one suction pick point per bottle. It only works when you give it <strong>both</strong> images below, named as a pair.',
        req_section_per_scene: 'Per scene, upload 2 files',
        req_rgb_name: 'Color photo (RGB)',
        req_tag_required: 'Required',
        req_chip_8bit: '8 bit',
        req_chip_3ch: '3 channels',
        req_rgb_desc: 'A normal top down color picture of the bin. This is what the model sees to find each bottle.',
        req_depth_name: 'Depth map',
        req_tag_key: 'Unlocks pick point',
        req_chip_16bit: '16 bit',
        req_chip_1ch: '1 channel',
        req_chip_mm: 'millimeters',
        req_depth_desc: 'Distance to every pixel, saved straight from the L515 depth stream. Working range about 250 to 1500 mm.',
        req_callout: '<strong>No depth means no pick point.</strong> An RGB only upload still works, but you get bottle outlines only and the central grasp dot is skipped.',
        req_section_pair_name: 'Name the pair the same',
        req_pair_help: 'The server matches RGB to depth by <strong>filename</strong>, not by folder. Give a photo and its depth the same base name.',
        req_pair_tag_a: 'Option A: split folders',
        req_pair_tag_b: 'Option B: one folder, suffix',
        req_tree_a: `my_capture/
├─ RGB/
│   ├─ 000000.png
│   └─ 000001.png
└─ Depth/
    ├─ 000000.png   ← same name
    └─ 000001.png`,
        req_tree_b: `my_capture/
├─ IMG_001.png        (rgb)
├─ IMG_001_depth.png  (depth)
├─ IMG_002.png
└─ IMG_002_depth.png`,
        req_section_exact_types: 'Exact data types',
        th_file: 'File',
        th_format: 'Format',
        th_bitdepth: 'Bit depth',
        th_channels: 'Channels',
        th_pixel_means: 'Pixel value means',
        td_8bit: '8 bit',
        td_16bit: '16 bit',
        td_rgb_ch: '3 (R,G,B)',
        td_depth_ch: '1 (grayscale)',
        td_color: 'Color',
        td_distance_mm: 'Distance in mm',
        td_depth: 'Depth',
        req_note: 'The server reads the actual image content, not the filename. A depth map saved as 8 bit or 3 channel will be treated as a normal photo and ignored for picking. Camera intrinsics default to the L515. Add notes in the optional Metadata JSON box if needed.',
        req_section_comes_back: 'What comes back',
        req_result_text: 'An <strong>overlay PNG</strong> per scene: each bottle outlined, with one colored dot at its suction pick point.',
        legend_good: 'Good grip',
        legend_ok: 'OK grip',
        legend_weak: 'Weak grip',
        got_it: 'Got it',

        // --- upload overlay ---
        uploading_files: 'Uploading files',
        pause: 'Pause',
        resume: 'Resume',
        cancel_upload: 'Cancel upload',
        uploading_processing: 'Uploading & processing files',
        processing_masks: 'Processing masks…',
        finishing_up: 'Finishing up…',
        running_inference: (n) => `Running mask inference on ${n} file${n === 1 ? '' : 's'}…`,
        waiting_for_masks: (n) => `${n} file${n === 1 ? '' : 's'} waiting for masks`,
        files_ratio: (o) => `${o.done} / ${o.total} file${o.total === 1 ? '' : 's'}`,
        bytes_of: (o) => `${o.a} of ${o.b}`,
        auto_generated_dataset: 'auto-generated dataset',

        // --- common aria / titles ---
        close: 'Close',
        previous: 'Previous',
        next: 'Next',
        use_right_panel_cancel: 'Use the right panel to cancel',

        // --- login page ---
        login_signin: 'Sign in',
        login_subtitle: 'Pharma Bin Picking — Data Upload',
        login_username: 'Username',
        login_password: 'Password',
        login_footer: 'Authorized personnel only.',
        login_error: 'Invalid username or password.',

        // --- counts / relative time ---
        files_count: (n) => `${n} file${n === 1 ? '' : 's'}`,
        sessions_count: (n) => `${n} session${n === 1 ? '' : 's'}`,
        failed_count: (n) => `${n} failed`,
        just_now: 'just now',
        min_1: '1 minute ago',
        mins_ago: (n) => `${n} minutes ago`,
        hour_1: '1 hour ago',
        hours_ago: (n) => `${n} hours ago`,
        yesterday: 'yesterday',
        days_ago: (n) => `${n} days ago`,
        months_ago: (n) => `${n} months ago`,
        years_ago: (n) => `${n} years ago`,

        // --- upload preview / tree statuses ---
        status_done: 'Done',
        status_failed: 'Failed',
        all_files_uploaded: 'All files uploaded',
        pausing: 'Pausing... (finishing current files)',
        paused: 'Paused',
        uploading_dots: 'Uploading...',
        ready_to_upload: 'Ready to upload',
        upload_complete: 'Upload complete',
        upload_paused: 'Upload paused',
        files_to_upload: 'Files to upload',
        btn_done: 'Done',
        btn_upload: 'Upload',
        uploaded_ratio: (o) => `${o.done}/${o.total} uploaded`,
        files_selected: (n) => `${n} file${n === 1 ? '' : 's'} selected`,
        size_uploaded: (o) => `${o.size} · ${o.done}/${o.total} uploaded`,
        size_ready: (size) => `${size} ready to upload`,

        // --- image cards / depth ---
        original_label: 'original',
        masks_label: 'masks',
        depth_label: 'depth',
        no_mask: 'no mask',
        no_mask_available: 'No mask available',
        depth_normalized_title: 'Depth (normalized [250–1500] mm) — click to enlarge',
        original_title: 'Original — click to enlarge',
        mask_overlay_title: 'Mask overlay — click to enlarge',
        used_for_masks_of: (name) => `Used for masks of<br><strong>${name}</strong>`,
        depth_file_no_rgb: 'Depth file<br><span style="opacity:0.7;">(no paired RGB)</span>',
        used_as_depth_channel: (name) => `Used as the depth channel for ${name}`,
        depth_file_no_rgb_title: 'Depth file (no paired RGB)',
        depth_used_for_rgb: 'Depth file<br><span style="opacity:0.7;">used for RGB inference</span>',
        depth_file_info_title: 'Depth file — used as the depth channel for inference of its RGB sibling',
        caption_depth: 'depth (normalized)',
        caption_original: 'original',
        caption_masks: 'masks',

        // --- detail panel ---
        preview: 'Preview',
        preview_sub: 'Upload files or select a dataset',
        detail_empty_text: 'Drop files on the left<br>or select a dataset below',
        delete_dataset_title: 'Delete dataset',
        delete_session_title: 'Delete session',
        remove_folder: 'Remove folder',
        remove: 'Remove',
        more_files: (n) => `… and ${n} more files`,
        no_sessions: 'This dataset has no sessions.',
        try_again: 'Try again',
        error_prefix: (msg) => `Error: ${msg}`,
        mismatch_msg: (n) => `The dataset list reports ${n} sessions, but the server returned none.`,
        session_files_stats: (o) => `${o.n} files · ${o.size}`,

        // --- confirms / alerts ---
        confirm_cancel_upload: 'An upload is in progress. Cancel and remove all files?',
        confirm_delete_dataset: (o) => `Delete dataset "${o.name}"?\n\nThis will permanently remove ${o.n} file${o.n === 1 ? '' : 's'}.`,
        confirm_delete_session: (o) => `Delete session "${o.session}" from "${o.dataset}"?\n\nThis will permanently remove ${o.n} file${o.n === 1 ? '' : 's'}.`,
        failed_to_delete: (msg) => `Failed to delete: ${msg}`,
    },

    ko: {
        // --- document titles ---
        doc_title_index: 'Pharma Bin Picking 데이터 업로드',
        doc_title_login: '로그인 — Pharma Bin Picking',

        // --- left upload panel ---
        upload_files: '파일 업로드',
        upload_files_sub: '원하는 파일을 선택하여 업로드하세요',
        what_to_upload_btn: '무엇을 업로드하나요?',
        what_to_upload_title: '파지 지점을 얻으려면 무엇을 업로드해야 하나요',
        clear_all: '모두 지우기',
        dataset_label: '데이터셋 이름 (선택)',
        auto_generated: '비워두면 자동 생성됩니다',
        session_label: '세션 (선택)',
        metadata_label: '메타데이터 JSON (선택)',
        dropzone_text: '파일을 선택하거나 여기로 끌어다 놓으세요',
        dropzone_hint: '모든 파일 형식 또는 폴더, 서버에 구조가 그대로 유지됩니다',
        dropzone_summary_hint: '더 끌어다 놓거나 클릭하여 추가하세요',
        browse_file: '파일 찾아보기',

        // --- datasets list ---
        datasets_on_server: '서버의 데이터셋',
        refresh: '새로 고침',
        search_datasets: '데이터셋 검색...',
        sort_modified_desc: '최신순',
        sort_modified_asc: '오래된순',
        sort_name_asc: '이름 A–Z',
        sort_name_desc: '이름 Z–A',
        sort_size_desc: '용량 큰 순',
        sort_size_asc: '용량 작은 순',
        loading: '불러오는 중...',
        failed_to_load: '데이터셋을 불러오지 못했습니다.',
        no_datasets_yet: '아직 데이터셋이 없습니다. 파일을 업로드하여 시작하세요.',
        no_datasets_match: (q) => `"${q}"와 일치하는 데이터셋이 없습니다`,

        // --- "What to upload" modal ---
        req_sub: '서버는 병 하나당 하나의 흡착 파지 지점을 반환합니다. 아래 <strong>두 이미지</strong>를 한 쌍으로 이름 지어 함께 제공할 때만 작동합니다.',
        req_section_per_scene: '장면당 2개의 파일을 업로드하세요',
        req_rgb_name: '컬러 사진 (RGB)',
        req_tag_required: '필수',
        req_chip_8bit: '8비트',
        req_chip_3ch: '3채널',
        req_rgb_desc: '통을 위에서 내려다본 일반 컬러 사진입니다. 모델이 각 병을 찾기 위해 보는 이미지입니다.',
        req_depth_name: '깊이 맵',
        req_tag_key: '파지 지점 활성화',
        req_chip_16bit: '16비트',
        req_chip_1ch: '1채널',
        req_chip_mm: '밀리미터',
        req_depth_desc: '모든 픽셀까지의 거리이며, L515 깊이 스트림에서 그대로 저장됩니다. 작동 범위는 약 250~1500 mm입니다.',
        req_callout: '<strong>깊이가 없으면 파지 지점도 없습니다.</strong> RGB만 업로드해도 작동하지만, 병의 외곽선만 얻고 중심 파지 점은 생략됩니다.',
        req_section_pair_name: '쌍의 이름을 동일하게 지으세요',
        req_pair_help: '서버는 폴더가 아니라 <strong>파일 이름</strong>으로 RGB와 깊이를 매칭합니다. 사진과 그 깊이 파일에 동일한 기본 이름을 지정하세요.',
        req_pair_tag_a: '옵션 A: 폴더 분리',
        req_pair_tag_b: '옵션 B: 한 폴더, 접미사',
        req_tree_a: `my_capture/
├─ RGB/
│   ├─ 000000.png
│   └─ 000001.png
└─ Depth/
    ├─ 000000.png   ← 동일한 이름
    └─ 000001.png`,
        req_tree_b: `my_capture/
├─ IMG_001.png        (컬러)
├─ IMG_001_depth.png  (깊이)
├─ IMG_002.png
└─ IMG_002_depth.png`,
        req_section_exact_types: '정확한 데이터 형식',
        th_file: '파일',
        th_format: '형식',
        th_bitdepth: '비트 심도',
        th_channels: '채널',
        th_pixel_means: '픽셀 값 의미',
        td_8bit: '8비트',
        td_16bit: '16비트',
        td_rgb_ch: '3 (R,G,B)',
        td_depth_ch: '1 (그레이스케일)',
        td_color: '색상',
        td_distance_mm: '거리 (mm)',
        td_depth: '깊이',
        req_note: '서버는 파일 이름이 아니라 실제 이미지 내용을 읽습니다. 8비트 또는 3채널로 저장된 깊이 맵은 일반 사진으로 처리되어 파지 계산에서 무시됩니다. 카메라 내부 파라미터는 기본적으로 L515를 사용합니다. 필요하면 선택적 메타데이터 JSON 칸에 메모를 추가하세요.',
        req_section_comes_back: '반환되는 결과',
        req_result_text: '장면당 <strong>오버레이 PNG</strong> 한 장: 각 병의 외곽선과 흡착 파지 지점에 색상 점 하나가 표시됩니다.',
        legend_good: '좋은 파지',
        legend_ok: '보통 파지',
        legend_weak: '약한 파지',
        got_it: '확인',

        // --- upload overlay ---
        uploading_files: '파일 업로드 중',
        pause: '일시정지',
        resume: '재개',
        cancel_upload: '업로드 취소',
        uploading_processing: '업로드 및 처리 중',
        processing_masks: '마스크 처리 중…',
        finishing_up: '마무리 중…',
        running_inference: (n) => `${n}개 파일에 마스크 추론 실행 중…`,
        waiting_for_masks: (n) => `${n}개 파일이 마스크 대기 중`,
        files_ratio: (o) => `${o.done} / ${o.total} 파일`,
        bytes_of: (o) => `${o.a} / ${o.b}`,
        auto_generated_dataset: '자동 생성 데이터셋',

        // --- common aria / titles ---
        close: '닫기',
        previous: '이전',
        next: '다음',
        use_right_panel_cancel: '취소하려면 오른쪽 패널을 사용하세요',

        // --- login page ---
        login_signin: '로그인',
        login_subtitle: 'Pharma Bin Picking — 데이터 업로드',
        login_username: '사용자 이름',
        login_password: '비밀번호',
        login_footer: '승인된 인원만 접근할 수 있습니다.',
        login_error: '사용자 이름 또는 비밀번호가 올바르지 않습니다.',

        // --- counts / relative time ---
        files_count: (n) => `파일 ${n}개`,
        sessions_count: (n) => `세션 ${n}개`,
        failed_count: (n) => `${n}개 실패`,
        just_now: '방금 전',
        min_1: '1분 전',
        mins_ago: (n) => `${n}분 전`,
        hour_1: '1시간 전',
        hours_ago: (n) => `${n}시간 전`,
        yesterday: '어제',
        days_ago: (n) => `${n}일 전`,
        months_ago: (n) => `${n}개월 전`,
        years_ago: (n) => `${n}년 전`,

        // --- upload preview / tree statuses ---
        status_done: '완료',
        status_failed: '실패',
        all_files_uploaded: '모든 파일 업로드 완료',
        pausing: '일시정지 중... (현재 파일 마무리 중)',
        paused: '일시정지됨',
        uploading_dots: '업로드 중...',
        ready_to_upload: '업로드 준비됨',
        upload_complete: '업로드 완료',
        upload_paused: '업로드 일시정지됨',
        files_to_upload: '업로드할 파일',
        btn_done: '완료',
        btn_upload: '업로드',
        uploaded_ratio: (o) => `${o.done}/${o.total} 업로드됨`,
        files_selected: (n) => `파일 ${n}개 선택됨`,
        size_uploaded: (o) => `${o.size} · ${o.done}/${o.total} 업로드됨`,
        size_ready: (size) => `${size} 업로드 준비됨`,

        // --- image cards / depth ---
        original_label: '원본',
        masks_label: '마스크',
        depth_label: '깊이',
        no_mask: '마스크 없음',
        no_mask_available: '마스크 없음',
        depth_normalized_title: '깊이 (정규화 [250–1500] mm) — 클릭하여 확대',
        original_title: '원본 — 클릭하여 확대',
        mask_overlay_title: '마스크 오버레이 — 클릭하여 확대',
        used_for_masks_of: (name) => `마스크 사용 대상<br><strong>${name}</strong>`,
        depth_file_no_rgb: '깊이 파일<br><span style="opacity:0.7;">(RGB 쌍 없음)</span>',
        used_as_depth_channel: (name) => `${name}의 깊이 채널로 사용됨`,
        depth_file_no_rgb_title: '깊이 파일 (RGB 쌍 없음)',
        depth_used_for_rgb: '깊이 파일<br><span style="opacity:0.7;">RGB 추론에 사용됨</span>',
        depth_file_info_title: '깊이 파일 — RGB 형제 이미지의 추론을 위한 깊이 채널로 사용됨',
        caption_depth: '깊이 (정규화)',
        caption_original: '원본',
        caption_masks: '마스크',

        // --- detail panel ---
        preview: '미리보기',
        preview_sub: '파일을 업로드하거나 데이터셋을 선택하세요',
        detail_empty_text: '왼쪽에 파일을 놓거나<br>아래에서 데이터셋을 선택하세요',
        delete_dataset_title: '데이터셋 삭제',
        delete_session_title: '세션 삭제',
        remove_folder: '폴더 제거',
        remove: '제거',
        more_files: (n) => `… 그리고 ${n}개 파일 더`,
        no_sessions: '이 데이터셋에는 세션이 없습니다.',
        try_again: '다시 시도',
        error_prefix: (msg) => `오류: ${msg}`,
        mismatch_msg: (n) => `데이터셋 목록은 세션 ${n}개를 보고하지만, 서버는 아무것도 반환하지 않았습니다.`,
        session_files_stats: (o) => `파일 ${o.n}개 · ${o.size}`,

        // --- confirms / alerts ---
        confirm_cancel_upload: '업로드가 진행 중입니다. 취소하고 모든 파일을 제거하시겠습니까?',
        confirm_delete_dataset: (o) => `데이터셋 "${o.name}"을(를) 삭제하시겠습니까?\n\n파일 ${o.n}개가 영구적으로 제거됩니다.`,
        confirm_delete_session: (o) => `"${o.dataset}"에서 세션 "${o.session}"을(를) 삭제하시겠습니까?\n\n파일 ${o.n}개가 영구적으로 제거됩니다.`,
        failed_to_delete: (msg) => `삭제 실패: ${msg}`,
    },
};

const I18N_STORAGE_KEY = 'pbp_lang';
const I18N_DEFAULT = 'ko';

function getLang() {
    try {
        const saved = localStorage.getItem(I18N_STORAGE_KEY);
        if (saved && I18N[saved]) return saved;
    } catch (e) { /* localStorage unavailable */ }
    return I18N_DEFAULT;
}

function setLang(lang) {
    if (!I18N[lang]) return;
    try { localStorage.setItem(I18N_STORAGE_KEY, lang); } catch (e) {}
    applyTranslations();
    syncLangSwitch();
    // Let app.js re-render its dynamically-built strings.
    document.dispatchEvent(new Event('i18n:changed'));
}

// Translate a key. `params` is passed straight to function-valued entries,
// or used for {placeholder} substitution on string-valued entries.
function t(key, params) {
    const lang = getLang();
    const table = I18N[lang] || I18N.en;
    let v = table[key];
    if (v === undefined) v = I18N.en[key];
    if (v === undefined) return key;
    if (typeof v === 'function') return v(params);
    if (params && typeof params === 'object') {
        return v.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ''));
    }
    return v;
}

// Apply all data-i18n* attributes in the current document.
function applyTranslations() {
    document.documentElement.lang = getLang();

    document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.innerHTML = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });

    const docTitleKey = document.body && document.body.getAttribute('data-doctitle');
    if (docTitleKey) document.title = t(docTitleKey);
}

// Reflect the active language on the floating toggle.
function syncLangSwitch() {
    const lang = getLang();
    document.querySelectorAll('.lang-switch [data-lang]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });
}

function setupLangSwitch() {
    document.querySelectorAll('.lang-switch [data-lang]').forEach((btn) => {
        btn.addEventListener('click', () => setLang(btn.getAttribute('data-lang')));
    });
    applyTranslations();
    syncLangSwitch();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupLangSwitch);
} else {
    setupLangSwitch();
}
