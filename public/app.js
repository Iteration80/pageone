document.addEventListener('DOMContentLoaded', () => {
    let activeProjectId = null;
    let targetProjectId = null; // Used for rename and delete operations
    let activeStageNum = 1;
    let currentDraftSceneNumber = 1;
    let isBatchGenerating = false;
    const AUTH_STORAGE_KEY = 'pageone_access_key';
    const nativeFetch = window.fetch.bind(window);

    function getAuthSecret() {
        return sessionStorage.getItem(AUTH_STORAGE_KEY) || '';
    }

    function isApiRequest(resource) {
        const url = typeof resource === 'string' ? resource : resource?.url || '';
        return url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`);
    }

    function showAuthOverlay(message = '') {
        const overlay = document.getElementById('authOverlay');
        const error = document.getElementById('authError');
        const input = document.getElementById('authSecretInput');
        if (error) error.textContent = message;
        overlay?.classList.remove('hidden');
        setTimeout(() => input?.focus(), 0);
    }

    function hideAuthOverlay() {
        document.getElementById('authOverlay')?.classList.add('hidden');
        const error = document.getElementById('authError');
        if (error) error.textContent = '';
    }

    window.fetch = async (resource, options = {}) => {
        const shouldAuth = isApiRequest(resource);
        const requestOptions = { ...options };
        if (shouldAuth) {
            const headers = new Headers(requestOptions.headers || (resource instanceof Request ? resource.headers : undefined));
            const secret = getAuthSecret();
            if (secret && !headers.has('Authorization') && !headers.has('X-Api-Key')) {
                headers.set('Authorization', `Bearer ${secret}`);
            }
            requestOptions.headers = headers;
        }
        const response = await nativeFetch(resource, requestOptions);
        if (shouldAuth && response.status === 401) {
            showAuthOverlay('Invalid or missing access key.');
        }
        return response;
    };

    async function apiErrorMessage(response, fallback = 'Request failed') {
        let detail = '';
        try {
            const data = await response.clone().json();
            detail = data?.error || data?.message || '';
        } catch {
            try {
                detail = (await response.clone().text())
                    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            } catch {}
        }

        if (detail) return detail.slice(0, 500);

        let pathname = '';
        try {
            pathname = new URL(response.url, window.location.origin).pathname;
        } catch {}

        if (response.status === 404 && pathname.startsWith('/api/')) {
            return `API route not found: ${pathname}. Refresh the app so the browser and server are on the same version.`;
        }

        return `${fallback}: server returned ${response.status}`;
    }

    function setupAuthGate() {
        const form = document.getElementById('authForm');
        const input = document.getElementById('authSecretInput');
        const btn = document.getElementById('authSubmitBtn');
        const error = document.getElementById('authError');
        if (!form || !input || !btn) return;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const secret = input.value.trim();
            btn.disabled = true;
            if (error) error.textContent = '';
            try {
                const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
                const res = await nativeFetch('/api/projects', { headers });
                if (!res.ok) throw new Error('Access denied');
                if (secret) sessionStorage.setItem(AUTH_STORAGE_KEY, secret);
                hideAuthOverlay();
                if (window.location.hash.startsWith('#project-')) {
                    handleHashChange();
                } else {
                    loadProjects();
                }
            } catch {
                if (error) error.textContent = 'That access key was not accepted.';
                input.select();
            } finally {
                btn.disabled = false;
            }
        });
    }

    setupAuthGate();

    function autoResize(textarea) {
        if (!textarea) return;
        // Lock width to prevent CSS Grid reflow when height collapses
        const w = textarea.offsetWidth;
        textarea.style.width = w + 'px';
        textarea.style.overflow = 'auto';
        textarea.style.minHeight = '0px';
        textarea.style.height = '0px';
        const h = Math.max(textarea.scrollHeight, 24);
        textarea.style.height = h + 'px';
        textarea.style.overflow = 'hidden';
        textarea.style.minHeight = '';
        textarea.style.width = '100%';
    }

    function formatFountainToHTML(rawText, annotations = null) {
        const lines = rawText.split('\n');
        let html = '';
        let inDialogueBlock = false;

        // Escape HTML entities before injecting into the DOM
        function esc(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        lines.forEach((line, idx) => {
            const tLine = line.trim();
            const ann = annotations ? annotations[idx] : null;
            const diffBg = ann === 'removed' ? ' bg-red-900/40 rounded' : ann === 'added' ? ' bg-green-900/40 rounded' : '';

            if (tLine === '') {
                html += `<div class="h-3${diffBg}"></div>`;
                inDialogueBlock = false;
            } else if (/^(INT\.|EXT\.|I\/E\.|EST\.)/i.test(tLine) && tLine === tLine.toUpperCase()) {
                html += `<div class="font-bold uppercase mt-6 mb-2 text-left${diffBg}">${esc(tLine)}</div>`;
                inDialogueBlock = false;
            } else if (tLine === tLine.toUpperCase() && !inDialogueBlock && !/^(INT\.|EXT\.)/i.test(tLine)) {
                html += `<div class="ml-[30%] uppercase mt-4 mb-0 font-semibold tracking-wide${diffBg}">${esc(tLine)}</div>`;
                inDialogueBlock = true;
            } else if (inDialogueBlock && tLine.startsWith('(') && tLine.endsWith(')')) {
                html += `<div class="ml-[25%] mb-0 italic${diffBg}">${esc(tLine)}</div>`;
            } else if (inDialogueBlock) {
                html += `<div class="ml-[15%] w-[70%] mb-0${diffBg}">${esc(tLine)}</div>`;
            } else {
                html += `<div class="text-left mb-2 w-full${diffBg}">${esc(tLine)}</div>`;
            }
        });

        return html;
    }

    // Returns per-line diff annotations for left (removed) and right (added) panels
    function computeLineDiff(origText, proposedText) {
        const origLines = origText.split('\n');
        const newLines = proposedText.split('\n');
        const m = origLines.length, n = newLines.length;

        // LCS via DP (trim lines for comparison to avoid whitespace false-positives)
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (origLines[i - 1].trim() === newLines[j - 1].trim()) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack
        const leftAnnotations = new Array(m).fill(null);
        const rightAnnotations = new Array(n).fill(null);
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && origLines[i - 1].trim() === newLines[j - 1].trim()) {
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                rightAnnotations[j - 1] = 'added';
                j--;
            } else {
                leftAnnotations[i - 1] = 'removed';
                i--;
            }
        }

        return { leftAnnotations, rightAnnotations };
    }

    // --- DOM Elements ---
    const projectsHub = document.getElementById('projectsHub');
    const appContainer = document.getElementById('appContainer');
    const projectsGrid = document.getElementById('projectsGrid');
    const createNewProjectBtn = document.getElementById('createNewProjectBtn');
    const btnReturnHome = document.getElementById('btnReturnHome');

    // Navigation
    // Navigation and Workspaces
    const navItems = {};
    const workspaces = {};
    for (let i = 1; i <= 10; i++) {
        // Handle inconsistent ID patterns (nav-stage-X vs nav-stageX)
        navItems[i] = document.getElementById(`nav-stage-${i}`) || document.getElementById(`nav-stage${i}`);
        workspaces[i] = document.getElementById(`stage-${i}-view`) || document.getElementById(`stage${i}-view`);
    }
    const SOURCE_READINESS_STAGES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    const SOURCE_TYPE_OPTIONS = [
        ['source_material', 'Source Material'],
        ['source_reference', 'Source Reference'],
        ['style_reference', 'Style Reference'],
        ['script_reference', 'Script Reference'],
        ['development_notes', 'Development Notes']
    ];

    // Version History navigation
    const btnVersionHistory = document.getElementById('btnVersionHistory');
    const versionHistoryWorkspace = document.getElementById('version-history-view');
    const btnSourceLibrary = document.getElementById('btnSourceLibrary');
    const sourceLibraryModal = document.getElementById('sourceLibraryModal');
    const sourceLibraryMeta = document.getElementById('sourceLibraryMeta');
    const sourceBiblePanel = document.getElementById('sourceBiblePanel');
    const sourceLibraryStatus = document.getElementById('sourceLibraryStatus');
    const knowledgeSnapshotPanel = document.getElementById('knowledgeSnapshotPanel');
    const knowledgeDiagnosticsPanel = document.getElementById('knowledgeDiagnosticsPanel');
    const knowledgeReviewPanel = document.getElementById('knowledgeReviewPanel');
    const sourceLibraryList = document.getElementById('sourceLibraryList');
    const sourceReaderPanel = document.getElementById('sourceReaderPanel');
    const sourceReaderTitle = document.getElementById('sourceReaderTitle');
    const sourceReaderMeta = document.getElementById('sourceReaderMeta');
    const sourceReaderContent = document.getElementById('sourceReaderContent');
    const sourceUploadForm = document.getElementById('sourceUploadForm');
    const sourceKnowledgeUpload = document.getElementById('sourceKnowledgeUpload');
    const sourceUploadNote = document.getElementById('sourceUploadNote');
    const btnUploadSource = document.getElementById('btnUploadSource');
    const btnRebuildSourceBible = document.getElementById('btnRebuildSourceBible');
    const btnKnowledgeDiagnostics = document.getElementById('btnKnowledgeDiagnostics');
    const btnCompactMemory = document.getElementById('btnCompactMemory');
    const btnSourceLibraryClose = document.getElementById('btnSourceLibraryClose');
    const btnSourceReaderClose = document.getElementById('btnSourceReaderClose');

    // Legacy / Convenience references for existing stages
    const navStage1 = navItems[1];
    const navStage2 = navItems[2];
    const navStage3 = navItems[3];
    const navStage4 = navItems[4];
    const stage1Workspace = workspaces[1];
    const stage2Workspace = workspaces[2];
    const stage3Workspace = workspaces[3];
    const stage4Workspace = workspaces[4];

    // Stage 1 Elements
    const generateBtn = document.getElementById('generateBtn');
    const promptInput = document.getElementById('promptInput');
    const loadingState = document.getElementById('loadingState');
    const resultsContainer = document.getElementById('resultsContainer');
    const pdfUpload = document.getElementById('pdfUpload');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const stage1FeedbackPanel = document.getElementById('stage1FeedbackPanel');
    const stage1Notes = document.getElementById('stage1-notes');
    const stage2Notes = document.getElementById('stage2-notes');
    const stage3Notes = document.getElementById('stage3-notes');
    const stage4Notes = document.getElementById('stage4-notes');

    const stage1PdfUpload = document.getElementById('stage1PdfUpload');
    const stage1FileNameDisplay = document.getElementById('stage1FileNameDisplay');
    const stage2PdfUpload = document.getElementById('stage2PdfUpload');
    const stage2FileNameDisplay = document.getElementById('stage2FileNameDisplay');
    const stage3PdfUpload = document.getElementById('stage3PdfUpload');
    const stage3FileNameDisplay = document.getElementById('stage3FileNameDisplay');
    const stage4PdfUpload = document.getElementById('stage4PdfUpload');
    const stage4FileNameDisplay = document.getElementById('stage4FileNameDisplay');

    // Stage 5 Elements
    const stage5Notes = document.getElementById('stage5Notes');
    const stage5PdfUpload = document.getElementById('stage5PdfUpload');
    const stage5FileNameDisplay = document.getElementById('stage5FileNameDisplay');
    const btnGenerateStage5 = document.getElementById('btnGenerateStage5');
    const btnStage5Regenerate = document.getElementById('btnStage5Regenerate');
    const loadingStateStage5 = document.getElementById('loadingStateStage5');
    const loadingTextStage5 = document.getElementById('loadingTextStage5');
    const stage5Actions = document.getElementById('stage5Actions');
    const stage5TreatmentContainer = document.getElementById('stage5TreatmentContainer');
    const stage5Workshop = document.getElementById('stage5Workshop');
    const btnStage5Revise = document.getElementById('btnStage5Revise');
    const btnStage5Approve = document.getElementById('btnStage5Approve');
    const btnStage5Edit = document.getElementById('btnStage5Edit');

    const stage5TAs = {
        title_logline_characters: document.getElementById('stage5-title-logline'),
        act_1: document.getElementById('stage5-act1'),
        act_2a: document.getElementById('stage5-act2a'),
        act_2b: document.getElementById('stage5-act2b'),
        act_3: document.getElementById('stage5-act3')
    };

    // Stage 6 Elements
    const stage6Board = document.getElementById('stage6-blueprint-container');
    const stage6Workshop = document.getElementById('stage6Workshop');
    const stage6Notes = document.getElementById('stage6-notes');
    const btnStage6Submit = document.getElementById('btnStage6Submit');
    const btnStage6Approve = document.getElementById('btnStage6Approve');
    const btnStage6Revise = document.getElementById('btnStage6Revise');
    const btnStage6Regenerate = document.getElementById('btnStage6Regenerate');
    const stage6RegenerateMenu = document.getElementById('stage6RegenerateMenu');
    const stage6PdfUpload = document.getElementById('stage6PdfUpload');
    const stage6FileNameDisplay = document.getElementById('stage6FileNameDisplay');
    const btnStage7RegenerateHeader = document.getElementById('btnStage7RegenerateHeader');
    const btnStage9Regenerate = document.getElementById('btnStage9Regenerate');


    // Stage 8 Elements
    const stage8View = document.getElementById('stage-8-view');
    const draftEditorMount = document.getElementById('draft-editor-mount');
    let stage8Editor = null;
    let stage8SaveTimer = null;

    function stage8FlushEditor() {
        if (!stage8Editor || !stage8Editor.isDirty()) return;
        const scenes = getFlatScenes();
        const scene = scenes.find(s => s.scene_number === currentDraftSceneNumber);
        if (!scene) return;
        const newText = stage8Editor.toFountain();
        scene.draft_text = newText;
        stage8Editor.markClean();
        // Persist to server (fire and forget)
        if (activeProjectId && window.currentProjectData?.stage6_scenes) {
            fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { stage6_scenes: window.currentProjectData.stage6_scenes } })
            }).catch(err => console.error('Stage 8 auto-save failed:', err));
        }
    }

    function stage8LoadEditor(fountainText) {
        if (!draftEditorMount) return;
        if (!stage8Editor) {
            const toolbarSlot = document.getElementById('stage8-toolbar-slot');
            stage8Editor = new FountainEditor(draftEditorMount, {
                onDirty: () => {
                    clearTimeout(stage8SaveTimer);
                    stage8SaveTimer = setTimeout(stage8FlushEditor, 2000);
                },
                externalToolbarSlot: toolbarSlot
            });
        }
        stage8Editor.loadFountain(fountainText);
    }

    function stage8ShowPlaceholder(html) {
        if (!draftEditorMount) return;
        if (stage8Editor) { stage8Editor.destroy(); stage8Editor = null; }
        draftEditorMount.innerHTML = html;
    }
    const btnStage8Submit = document.getElementById('btnStage8Submit');
    const btnStage8Approve = document.getElementById('btnStage8Approve');
    const btnGenerateScene = document.getElementById('btnGenerateScene');
    const btnNextScene = document.getElementById('btnNextScene');
    const btnGenerateAll = document.getElementById('btnGenerateAll');
    const stage8Notes = document.getElementById('stage8-notes');


    // Textarea/Notes auto-resize listeners
    [stage1Notes, stage2Notes, stage3Notes, stage4Notes, stage5Notes, stage6Notes, promptInput].forEach(el => {

        if (el) {
            el.addEventListener('input', () => autoResize(el));
            el.addEventListener('focus', () => { el.style.background = 'rgba(31,41,55,0.8)'; el.style.outline = '1px solid #374151'; });
            el.addEventListener('blur', () => { 
                // Special case for stage5Notes which should match the premium card background if it has it
                // Actually, stage5Notes is a different element than the treatment fields.
                // Let's just reset to transparent as before unless it's explicitly styled.
                el.style.background = 'transparent'; 
                el.style.outline = 'none'; 
            });

            // Initial call for promptInput if it has content (e.g. after refresh)
            if (el.id === 'promptInput') requestAnimationFrame(() => autoResize(el));
        }
    });
    const btnStage1Revise = document.getElementById('btn-stage1-revise');
    const btnStage1Approve = document.getElementById('btn-stage1-approve');
    const btnStage1Edit = document.getElementById('btn-stage1-edit');

    const outlineContainer = document.getElementById('outlineContainer');
    const loadingStateOutline = document.getElementById('loadingStateOutline');

    // Stage 2 Workshop Elements
    const stage2Workshop = document.getElementById('stage2Workshop');
    // const stage2Notes = document.getElementById('stage2Notes') || document.getElementById('stage2-notes'); // This line is now redundant due to the new declaration above
    const btnStage2Revise = document.getElementById('btnStage2Revise') || document.getElementById('btn-stage2-revise');
    const btnStage2Approve = document.getElementById('btnStage2Approve') || document.getElementById('btn-stage2-approve');
    const btnStage2Edit = document.getElementById('btn-stage2-edit');
    const btnStage2Regenerate = document.getElementById('btnStage2Regenerate');

    const renameModal = document.getElementById('renameModal');
    const renameInput = document.getElementById('renameInput');

    // Stage 3 Workshop Elements
    const stage3Workshop = document.getElementById('stage3Workshop');
    const generateCharactersBtn = document.getElementById('generateCharactersBtn');
    const loadingStateCharacters = document.getElementById('loadingStateCharacters');
    const charactersContainer = document.getElementById('charactersContainer');
    // const stage3Notes = document.getElementById('stage3-notes'); // This line is now redundant due to the new declaration above
    const btnStage3Revise = document.getElementById('btn-stage3-revise');
    const btnStage3Approve = document.getElementById('btn-stage3-approve');
    const btnStage3Edit = document.getElementById('btn-stage3-edit');
    const btnStage3Regenerate = document.getElementById('btnStage3Regenerate');

    // Stage 4 Workshop Elements
    const stage4Workshop = document.getElementById('stage4Workshop');
    const loadingStateTreatment = document.getElementById('loadingStateTreatment');
    const loadingTextTreatment = document.getElementById('loadingTextTreatment');
    const treatmentContainer = document.getElementById('treatmentContainer');
    const btnStage4Revise = document.getElementById('btn-stage4-revise');
    const btnStage4Approve = document.getElementById('btn-stage4-approve');
    const btnStage4Edit = document.getElementById('btn-stage4-edit');
    const btnStage4Regenerate = document.getElementById('btnStage4Regenerate');
    const generateTreatmentBtn = document.getElementById('generateTreatmentBtn');
    const treatmentActions = document.getElementById('treatmentActions');

    const cancelRenameBtn = document.getElementById('cancelRenameBtn');
    const saveRenameBtn = document.getElementById('saveRenameBtn');

    const deleteModal = document.getElementById('deleteModal');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

    // --- Modal Logic ---
    function openRenameModal(id, currentTitle) {
        targetProjectId = id;
        renameInput.value = currentTitle;
        renameModal.classList.remove('hidden');
        renameInput.focus();
    }

    function closeRenameModal() {
        targetProjectId = null;
        renameInput.value = '';
        renameModal.classList.add('hidden');
    }

    function openDeleteModal(id) {
        targetProjectId = id;
        deleteModal.classList.remove('hidden');
    }

    function closeDeleteModal() {
        targetProjectId = null;
        deleteModal.classList.add('hidden');
    }

    // Modal Events
    cancelRenameBtn.addEventListener('click', closeRenameModal);

    saveRenameBtn.addEventListener('click', async () => {
        if (!targetProjectId) return;
        const newTitle = renameInput.value.trim();
        if (newTitle) {
            try {
                // Determine if we need to check if the title actually changed.
                // It's safe to just send it.
                await fetch(`/api/projects/${targetProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle })
                });
                closeRenameModal();
                initHub();
            } catch (err) {
                console.error("Error renaming project", err);
            }
        }
    });

    cancelDeleteBtn.addEventListener('click', closeDeleteModal);

    confirmDeleteBtn.addEventListener('click', async () => {
        if (!targetProjectId) return;
        try {
            await fetch(`/api/projects/${targetProjectId}`, { method: 'DELETE' });
            closeDeleteModal();
            initHub();
        } catch (err) {
            console.error("Error deleting project", err);
        }
    });

    // --- Project Hub Logic ---
    async function initHub() {
        try {
            const res = await fetch('/api/projects');
            const data = await res.json();
            renderProjects(data.projects || []);
        } catch (error) {
            console.error("Failed to load projects:", error);
        }
        loadHubStyles();
    }

    function renderProjects(projects) {
        projectsGrid.innerHTML = '';
        projects.forEach(project => {
            const card = document.createElement('div');
            card.className = 'project-card';
            card.innerHTML = `
                <h3 class="project-title" data-id="${project.id}">${escapeHtml(project.title)}</h3>
                <div class="project-actions">
                    <button class="edit-btn" data-id="${project.id}" title="Rename Project">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                    </button>
                    <button class="delete-btn" data-id="${project.id}" title="Delete Project">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                    </button>
                </div>
            `;

            // Handle Rename
            const editBtn = card.querySelector('.edit-btn');
            editBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation(); // Prevent card from opening
                openRenameModal(project.id, project.title);
            });

            // Handle Delete
            const deleteBtn = card.querySelector('.delete-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openDeleteModal(project.id);
            });

            // Handle Card clicking -> Load project Workspace
            card.addEventListener('click', () => {
                window.location.hash = `project-${project.id}`;
            });

            projectsGrid.appendChild(card);
        });
    }

    createNewProjectBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/projects', { method: 'POST' });
            const data = await res.json();
            window.location.hash = `project-${data.id}`;
        } catch (error) {
            console.error("Failed to create project:", error);
        }
    });

    // ── Hub Styles Section ───────────────────────────────────────────────────

    function styleTierLabel(tier) {
        if (tier === 'trained') return 'Trained';
        if (tier === 'preset') return 'Preset';
        return 'Conversational';
    }

    function styleTierClass(tier) {
        if (tier === 'trained') return 'trained';
        if (tier === 'preset') return 'preset';
        return 'conversational';
    }

    async function loadHubStyles() {
        const grid = document.getElementById('stylesGrid');
        if (!grid) return;

        try {
            const res = await fetch('/api/styles');
            const data = await res.json();
            grid.innerHTML = '';

            if (!data.styles?.length) {
                grid.innerHTML = '<p style="color:#4b5563;font-size:0.85rem;font-style:italic">No styles yet. Create one to define your writing voice.</p>';
                return;
            }

            for (const style of data.styles) {
                const card = document.createElement('div');
                card.className = 'hub-style-card';
                const tierClass = styleTierClass(style.tier);
                const tierLabel = styleTierLabel(style.tier);
                card.innerHTML = `
                    <div style="font-weight:600;color:var(--text-primary);font-size:1rem">${escapeHtml(style.name)} <span class="style-tier-badge ${tierClass}">${tierLabel}</span></div>
                    <div style="font-size:0.85rem;color:var(--text-secondary)">${escapeHtml(style.tonal_summary || '')}</div>
                `;
                card.addEventListener('click', () => openStyleDetail(style.slug));
                grid.appendChild(card);
            }
        } catch (err) {
            console.error('Load hub styles error:', err);
        }
    }

    let currentDetailStyleSlug = null;

    async function openStyleDetail(slug) {
        const modal = document.getElementById('styleDetailModal');
        if (!modal) return;

        try {
            const res = await fetch(`/api/styles/${slug}`);
            if (!res.ok) throw new Error('Failed to load style');
            const data = await res.json();
            currentDetailStyleSlug = slug;

            document.getElementById('styleDetailName').textContent = data.meta?.name || slug;
            document.getElementById('styleDetailTonal').textContent = data.meta?.tonal_summary || '';

            const badge = document.getElementById('styleDetailTierBadge');
            badge.textContent = styleTierLabel(data.tier);
            badge.className = `style-tier-badge ${styleTierClass(data.tier)}`;

            // Reference section (Tier 3 only)
            const refSection = document.getElementById('styleDetailRefSection');
            const refContent = document.getElementById('styleDetailRefContent');
            if (data.reference) {
                const { body: refBody } = parseStyleFileFrontend(data.reference);
                refContent.textContent = refBody;
                refSection.classList.remove('hidden');
                refContent.classList.add('hidden'); // collapsed by default
                document.getElementById('btnStyleDetailToggleRef').textContent = 'Show ▾';
            } else {
                refSection.classList.add('hidden');
            }

            // Directive
            const { body: dirBody } = parseStyleFileFrontend(data.directive);
            document.getElementById('styleDetailDirective').textContent = dirBody;

            modal.classList.remove('hidden');
        } catch (err) {
            console.error('Open style detail error:', err);
            alert('Failed to load style details.');
        }
    }

    // Simple frontend YAML front matter parser
    function parseStyleFileFrontend(content) {
        if (!content) return { meta: {}, body: content || '' };
        const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!match) return { meta: {}, body: content };
        return { meta: {}, body: match[2].trim() };
    }

    // Style detail modal listeners
    document.getElementById('btnStyleDetailClose')?.addEventListener('click', () => {
        document.getElementById('styleDetailModal')?.classList.add('hidden');
    });

    document.getElementById('btnStyleDetailDone')?.addEventListener('click', () => {
        document.getElementById('styleDetailModal')?.classList.add('hidden');
    });

    document.getElementById('btnStyleDetailToggleRef')?.addEventListener('click', () => {
        const content = document.getElementById('styleDetailRefContent');
        const btn = document.getElementById('btnStyleDetailToggleRef');
        if (!content || !btn) return;
        const hidden = content.classList.toggle('hidden');
        btn.textContent = hidden ? 'Show ▾' : 'Hide ▴';
    });

    document.getElementById('btnStyleDetailDelete')?.addEventListener('click', async () => {
        if (!currentDetailStyleSlug) return;
        if (!confirm(`Delete style "${currentDetailStyleSlug}"? This cannot be undone.`)) return;
        try {
            const res = await fetch(`/api/styles/${currentDetailStyleSlug}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            document.getElementById('styleDetailModal')?.classList.add('hidden');
            loadHubStyles();
        } catch (err) {
            console.error('Delete style error:', err);
            alert('Failed to delete style.');
        }
    });

    document.getElementById('btnStyleDetailEdit')?.addEventListener('click', async () => {
        if (!currentDetailStyleSlug) return;
        try {
            const res = await fetch(`/api/styles/${currentDetailStyleSlug}`);
            const data = await res.json();
            document.getElementById('editStyleContent').value = data.directive || '';
            document.getElementById('editStyleModal')?.classList.remove('hidden');
        } catch (err) {
            console.error('Load style for edit error:', err);
        }
    });

    document.getElementById('btnEditStyleCancel')?.addEventListener('click', () => {
        document.getElementById('editStyleModal')?.classList.add('hidden');
    });

    document.getElementById('btnEditStyleSave')?.addEventListener('click', async () => {
        if (!currentDetailStyleSlug) return;
        const content = document.getElementById('editStyleContent')?.value;
        if (!content) return;
        try {
            const res = await fetch(`/api/styles/${currentDetailStyleSlug}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
            if (!res.ok) throw new Error('Save failed');
            document.getElementById('editStyleModal')?.classList.add('hidden');
            document.getElementById('styleDetailModal')?.classList.add('hidden');
            loadHubStyles();
        } catch (err) {
            console.error('Save style error:', err);
            alert('Failed to save style.');
        }
    });

    // Create Style modal
    document.getElementById('btnNewStyle')?.addEventListener('click', () => {
        const modal = document.getElementById('createStyleModal');
        if (!modal) return;
        // Reset state
        document.getElementById('createStylePaths')?.classList.remove('hidden');
        document.getElementById('createStyleChatPath')?.classList.add('hidden');
        document.getElementById('createStyleUploadPath')?.classList.add('hidden');
        modal.classList.remove('hidden');
    });

    document.getElementById('btnCreateStyleClose')?.addEventListener('click', () => {
        document.getElementById('createStyleModal')?.classList.add('hidden');
    });

    // Conversational path
    let createStyleChatHistory = [];

    // Helper to render a chat message in the style thread
    function styleThreadAppend(thread, role, text) {
        const div = document.createElement('div');
        div.className = `chat-message ${role === 'user' ? 'chat-message-user' : 'chat-message-ai'}`;
        // Safe text rendering: split on newlines, insert <br> elements — no innerHTML with user/AI content
        const lines = String(text || '').split('\n');
        lines.forEach((line, i) => {
            if (i > 0) div.appendChild(document.createElement('br'));
            div.appendChild(document.createTextNode(line));
        });
        thread.appendChild(div);
        thread.scrollTop = thread.scrollHeight;
    }

    document.getElementById('btnCreateStyleConversational')?.addEventListener('click', async () => {
        document.getElementById('createStylePaths')?.classList.add('hidden');
        const chatPath = document.getElementById('createStyleChatPath');
        if (chatPath) { chatPath.classList.remove('hidden'); chatPath.style.display = 'flex'; }
        createStyleChatHistory = [];

        const thread = document.getElementById('createStyleChatThread');
        if (thread) thread.innerHTML = '<div class="chat-message chat-message-working">Thinking <div class="chat-working-dots"><span></span><span></span><span></span></div></div>';

        // Init chat — assistant introduces itself with project context
        try {
            const res = await fetch('/api/style-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [], isInit: true })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            createStyleChatHistory.push({ role: 'model', content: data.reply });
            if (thread) { thread.innerHTML = ''; styleThreadAppend(thread, 'ai', data.reply); }
        } catch (err) {
            if (thread) thread.innerHTML = '<p style="color:#ef4444;padding:8px">Failed to start chat. Check your API key in Settings.</p>';
        }
    });

    // Enter key sends message (Shift+Enter for newline)
    document.getElementById('createStyleChatInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('btnCreateStyleChatSend')?.click();
        }
    });

    document.getElementById('btnCreateStyleChatSend')?.addEventListener('click', async () => {
        const input = document.getElementById('createStyleChatInput');
        const thread = document.getElementById('createStyleChatThread');
        const text = input?.value?.trim();
        if (!text) return;

        createStyleChatHistory.push({ role: 'user', content: text });
        styleThreadAppend(thread, 'user', text);
        input.value = '';

        // Show thinking dots
        const thinking = document.createElement('div');
        thinking.className = 'chat-message chat-message-working';
        thinking.innerHTML = 'Thinking <div class="chat-working-dots"><span></span><span></span><span></span></div>';
        thread.appendChild(thinking);
        thread.scrollTop = thread.scrollHeight;

        try {
            const messages = createStyleChatHistory.map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
            }));
            const res = await fetch('/api/style-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages })
            });
            thinking.remove();
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            createStyleChatHistory.push({ role: 'model', content: data.reply });
            styleThreadAppend(thread, 'ai', data.reply);

            // Auto-trigger generation when the assistant signals readiness
            if (data.execute_immediately) {
                triggerStyleGeneration(thread);
            }
        } catch (err) {
            thinking.remove();
            styleThreadAppend(thread, 'ai', 'Error — try again.');
        }
    });

    async function triggerStyleGeneration(thread) {
        // Show generating indicator in chat
        const genIndicator = document.createElement('div');
        genIndicator.className = 'chat-message chat-message-working';
        genIndicator.innerHTML = 'Generating style <div class="chat-working-dots"><span></span><span></span><span></span></div>';
        if (thread) { thread.appendChild(genIndicator); thread.scrollTop = thread.scrollHeight; }

        // Disable input during generation
        const sendBtn = document.getElementById('btnCreateStyleChatSend');
        const input = document.getElementById('createStyleChatInput');
        if (sendBtn) sendBtn.disabled = true;
        if (input) input.disabled = true;

        try {
            const lastUserMsg = createStyleChatHistory.filter(m => m.role === 'user').pop()?.content || '';
            const res = await fetch('/api/generate-stage7-style', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: lastUserMsg,
                    conversationHistory: createStyleChatHistory.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
                })
            });
            if (!res.ok) throw new Error('Generation failed');
            const data = await res.json();
            document.getElementById('createStyleModal')?.classList.add('hidden');
            loadHubStyles();
            openStyleDetail(data.slug);
        } catch (err) {
            console.error('Create style error:', err);
            if (genIndicator) genIndicator.remove();
            styleThreadAppend(thread, 'ai', 'Failed to generate style — try again.');
        } finally {
            if (sendBtn) sendBtn.disabled = false;
            if (input) input.disabled = false;
        }
    }

    // Trained path
    document.getElementById('btnCreateStyleTrained')?.addEventListener('click', () => {
        document.getElementById('createStylePaths')?.classList.add('hidden');
        document.getElementById('createStyleUploadPath')?.classList.remove('hidden');
    });

    document.getElementById('btnCreateStyleUpload')?.addEventListener('click', async () => {
        const files = document.getElementById('createStyleFiles')?.files;
        if (!files?.length) {
            alert('Please select at least one screenplay file.');
            return;
        }

        const progress = document.getElementById('createStyleUploadProgress');
        const btn = document.getElementById('btnCreateStyleUpload');
        progress?.classList.remove('hidden');
        btn.disabled = true;

        try {
            const formData = new FormData();
            const styleName = document.getElementById('createStyleName')?.value?.trim() || '';
            if (styleName) formData.append('styleName', styleName);
            for (const file of files) {
                formData.append('screenplayFiles', file);
            }

            const res = await fetch('/api/generate-trained-style', {
                method: 'POST',
                body: formData
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Generation failed');
            }
            const data = await res.json();
            document.getElementById('createStyleModal')?.classList.add('hidden');
            loadHubStyles();
            openStyleDetail(data.slug);
        } catch (err) {
            console.error('Trained style error:', err);
            alert('Failed to create trained style: ' + err.message);
        } finally {
            progress?.classList.add('hidden');
            btn.disabled = false;
        }
    });

    // ── Import Script ────────────────────────────────────────────────────────
    const importModal = document.getElementById('importModal');
    const importFileInput = document.getElementById('importFileInput');
    const importDropZone = document.getElementById('importDropZone');
    const importDropLabel = document.getElementById('importDropLabel');
    const importTitleInput = document.getElementById('importTitle');
    const importProgress = document.getElementById('importProgress');
    const importError = document.getElementById('importError');
    const submitImportBtn = document.getElementById('submitImportBtn');
    let importSelectedFile = null;

    document.getElementById('importScriptBtn')?.addEventListener('click', () => {
        importModal?.classList.remove('hidden');
        importSelectedFile = null;
        if (importFileInput) importFileInput.value = '';
        if (importTitleInput) importTitleInput.value = '';
        if (importDropLabel) importDropLabel.innerHTML = '.fountain &nbsp; .fdx &nbsp; .pdf<br><span style="font-size:0.75rem;color:#4b5563">Click or drag to upload</span>';
        importProgress?.classList.add('hidden');
        importError?.classList.add('hidden');
        if (submitImportBtn) submitImportBtn.disabled = true;
    });

    document.getElementById('cancelImportBtn')?.addEventListener('click', () => {
        importModal?.classList.add('hidden');
    });
    importModal?.addEventListener('click', (e) => {
        if (e.target === importModal) importModal.classList.add('hidden');
    });

    importDropZone?.addEventListener('click', () => importFileInput?.click());
    importDropZone?.addEventListener('dragover', (e) => { e.preventDefault(); importDropZone.style.borderColor = 'rgba(59,130,246,0.5)'; });
    importDropZone?.addEventListener('dragleave', () => { importDropZone.style.borderColor = 'rgba(255,255,255,0.15)'; });
    importDropZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        importDropZone.style.borderColor = 'rgba(255,255,255,0.15)';
        if (e.dataTransfer.files.length > 0) handleImportFile(e.dataTransfer.files[0]);
    });
    importFileInput?.addEventListener('change', () => {
        if (importFileInput.files.length > 0) handleImportFile(importFileInput.files[0]);
    });

    function handleImportFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['fountain', 'fdx', 'pdf'].includes(ext)) {
            importError.textContent = `Unsupported file type: .${ext}. Use .fountain, .fdx, or .pdf`;
            importError.classList.remove('hidden');
            return;
        }
        importSelectedFile = file;
        importError?.classList.add('hidden');
        if (importDropLabel) importDropLabel.innerHTML = `<span style="color:#60a5fa">${escapeHtml(file.name)}</span><br><span style="font-size:0.75rem;color:#4b5563">${(file.size / 1024).toFixed(1)} KB</span>`;
        if (submitImportBtn) submitImportBtn.disabled = false;
    }

    submitImportBtn?.addEventListener('click', async () => {
        if (!importSelectedFile) return;
        importProgress?.classList.remove('hidden');
        importError?.classList.add('hidden');
        submitImportBtn.disabled = true;

        try {
            const formData = new FormData();
            formData.append('scriptFile', importSelectedFile);
            if (importTitleInput?.value.trim()) formData.append('title', importTitleInput.value.trim());

            const res = await fetch('/api/import-script', { method: 'POST', body: formData });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Import failed');
            }
            const data = await res.json();
            importModal?.classList.add('hidden');
            // Open the project and navigate to Stage 9 (Coverage)
            window.importedProjectTarget = 9;
            window.location.hash = `project-${data.projectId}`;
        } catch (error) {
            importError.textContent = error.message;
            importError?.classList.remove('hidden');
            submitImportBtn.disabled = false;
        } finally {
            importProgress?.classList.add('hidden');
        }
    });

    async function openProject(projectId) {
        activeProjectId = projectId;
        projectsHub.classList.add('hidden');
        appContainer.classList.remove('hidden');

        // Hydrate the workspace with saved data
        try {
            const res = await fetch(`/api/projects/${activeProjectId}`);
            if (!res.ok) throw new Error("Failed to fetch project details");
            const projectDetails = await res.json();
            window.currentProjectData = projectDetails.data;

            resultsContainer.innerHTML = ''; // Start clean
            document.querySelector('.prompt-section')?.classList.remove('hidden'); // Reset for fresh load
            for (const w of Object.values(stageChatWindows)) { if (w) w.clear(); }

            // Reset Stage 1 buttons to default state (prevents stale state from previous project)
            const btnExportPitch = document.getElementById('btnDownloadPitch');
            const hasStage1Data = !!(projectDetails.data && projectDetails.data.stage1_pitch);
            if (btnStage1Approve) {
                btnStage1Approve.textContent = 'Approve →';
                btnStage1Approve.classList.remove('approve-btn-green');
                btnStage1Approve.disabled = !hasStage1Data;
                btnStage1Approve.style.display = hasStage1Data ? '' : 'none';
            }
            if (btnExportPitch) {
                btnExportPitch.disabled = !hasStage1Data;
                btnExportPitch.style.opacity = hasStage1Data ? '' : '0.4';
                btnExportPitch.style.pointerEvents = hasStage1Data ? '' : 'none';
            }
            // Hide Stage 1 chat until a pitch is selected (show if project already has pitch data)
            const s1chat = document.getElementById('stage1-chat');
            const s1split = document.getElementById('stage1-hsplit');
            if (s1chat) s1chat.style.display = hasStage1Data ? '' : 'none';
            if (s1split) s1split.style.display = hasStage1Data ? '' : 'none';

            // Navigate to target stage (Stage 9 for imported projects, Stage 1 otherwise)
            const targetStage = window.importedProjectTarget || 1;
            window.importedProjectTarget = null;
            switchStage(targetStage);

            if (projectDetails.data && projectDetails.data.stage1_pitch) {
                const { pitch, notes, approved: wasApproved } = projectDetails.data.stage1_pitch;

                // Render a single pitch card with the saved data
                renderPitches([pitch]);

                // Auto-approve and go into workshop view
                const cardElement = resultsContainer.querySelector('.pitch-card');
                if (cardElement) {
                    handleApprove(cardElement, 0, { skipSave: true });

                    // Pre-fill notes
                    if (stage1Notes && notes) {
                        stage1Notes.value = notes;
                    }

                    // Show Approved state only if the pitch was actually approved
                    if (wasApproved) {
                        toggleStage1EditMode(true);
                    }

                    // Auto-resize notes if visible
                    if (stage1Notes) autoResize(stage1Notes);
                }

                updateStageNav(projectDetails.data);

                // Hydrate Stage 2 Outline if exists
                if (projectDetails.data.stage2_outline && projectDetails.data.stage2_outline.outline) {
                    renderOutline(projectDetails.data.stage2_outline.outline);

                    // Only show Approved if next stage (Characters) has data
                    const stage2WasApproved = !!(projectDetails.data.stage3_characters && projectDetails.data.stage3_characters.characters);
                    if (stage2WasApproved && btnStage2Approve) {
                        btnStage2Approve.textContent = 'Approved ✓';
                        btnStage2Approve.classList.add('approve-btn-green');
                        btnStage2Approve.disabled = true;
                    }
                    if (stage2WasApproved) toggleStage2EditMode(true);

                    // Pre-fill notes
                    if (stage2Notes && projectDetails.data.stage2_outline.notes) {
                        stage2Notes.value = projectDetails.data.stage2_outline.notes;
                    }
                    if (stage2Notes) autoResize(stage2Notes);
                } else {
                    document.getElementById('act1Container').innerHTML = '';
                    document.getElementById('act2Container').innerHTML = '';
                    document.getElementById('act3Container').innerHTML = '';
                    stage2Workshop?.classList.add('hidden');
                }

                // Hydrate Stage 3 Characters if exists
                if (projectDetails.data.stage3_characters && projectDetails.data.stage3_characters.characters) {
                    renderCharacters(projectDetails.data.stage3_characters.characters);
                    // Only show Approved if next stage (Beats) has data
                    const stage3WasApproved = !!((projectDetails.data.stage4_beats || projectDetails.data.stage4_treatment) && (projectDetails.data.stage4_beats || projectDetails.data.stage4_treatment).hybrid_beat_sheet);
                    if (stage3WasApproved && btnStage3Approve) {
                        btnStage3Approve.textContent = 'Approved ✓';
                        btnStage3Approve.classList.add('approve-btn-green');
                        btnStage3Approve.disabled = true;
                    }
                    if (stage3WasApproved && btnStage3Edit) btnStage3Edit.classList.remove('hidden');
                    if (stage3WasApproved && btnStage3Revise) btnStage3Revise.classList.add('hidden');

                    // Pre-fill notes
                    if (stage3Notes && projectDetails.data.stage3_characters.notes) {
                        stage3Notes.value = projectDetails.data.stage3_characters.notes;
                    }
                    if (stage3Notes) autoResize(stage3Notes);
                } else {
                    if (charactersContainer) charactersContainer.innerHTML = '';
                    if (stage3Workshop) stage3Workshop.classList.add('hidden');
                }

                // Hydrate Stage 4 Beats if exists
                if ((projectDetails.data.stage4_beats || projectDetails.data.stage4_treatment) && (projectDetails.data.stage4_beats || projectDetails.data.stage4_treatment).hybrid_beat_sheet) {
                    const stage4Data = projectDetails.data.stage4_beats || projectDetails.data.stage4_treatment;
                    renderTreatment(stage4Data);
                    // Only show Approved if next stage (Treatment) has data
                    const stage4WasApproved = !!projectDetails.data.stage5_treatment;
                    if (stage4WasApproved && btnStage4Approve) {
                        btnStage4Approve.textContent = 'Approved ✓';
                        btnStage4Approve.classList.add('approve-btn-green');
                        btnStage4Approve.disabled = true;
                    }
                    if (stage4WasApproved && btnStage4Edit) btnStage4Edit.classList.remove('hidden');
                    if (stage4WasApproved && btnStage4Revise) btnStage4Revise.classList.add('hidden');

                    if (stage4Notes && stage4Data.notes) {
                        stage4Notes.value = stage4Data.notes;
                    }
                    if (stage4Notes) autoResize(stage4Notes);
                } else {
                    if (treatmentContainer) treatmentContainer.innerHTML = '';
                    if (stage4Workshop) stage4Workshop.classList.add('hidden');
                    if (treatmentActions) treatmentActions.classList.remove('hidden');
                }

                // Hydrate Stage 5 Treatment if exists
                if (projectDetails.data.stage5_treatment) {
                    renderTreatmentStage5(projectDetails.data.stage5_treatment);
                    // Only show Approved if next stage (Scenes) has data
                    const stage5WasApproved = !!projectDetails.data.stage6_scenes;
                    if (stage5WasApproved && btnStage5Approve) {
                        btnStage5Approve.textContent = 'Approved ✓';
                        btnStage5Approve.classList.add('approve-btn-green');
                        btnStage5Approve.disabled = true;
                    }
                    if (stage5WasApproved && btnStage5Edit) btnStage5Edit.classList.remove('hidden');
                    if (stage5WasApproved && btnStage5Revise) btnStage5Revise.classList.add('hidden');

                    if (stage5Notes && projectDetails.data.stage5_treatment.notes) {
                        stage5Notes.value = projectDetails.data.stage5_treatment.notes;
                    }
                    if (stage5Notes) autoResize(stage5Notes);
                } else {
                    if (stage5TreatmentContainer) stage5TreatmentContainer.classList.add('hidden');
                    if (stage5Workshop) stage5Workshop.classList.add('hidden');
                    if (stage5Actions) stage5Actions.classList.remove('hidden');
                }

                // Hydrate Stage 6 Scenes if exists
                if (projectDetails.data.stage6_scenes) {
                    renderStage6(projectDetails.data.stage6_scenes);
                    if (btnStage6Approve) {
                        btnStage6Approve.textContent = 'Approve';
                        btnStage6Approve.classList.remove('approve-btn-green');
                    }

                    if (stage6Notes && projectDetails.data.stage6_scenes.notes) {
                        stage6Notes.value = projectDetails.data.stage6_scenes.notes;
                    }
                    if (stage6Notes) autoResize(stage6Notes);
                } else {
                    if (stage6Board) stage6Board.innerHTML = '';
                    if (stage6Workshop) stage6Workshop.classList.add('hidden');
                }

                // Restore persisted chat conversations
                // Data keys don't change — map old conversation keys to new UI stage numbers
                const savedConvos = projectDetails.data.conversations || {};
                const CONVO_TO_CHAT = { stage1: 1, stage2: 2, stage3: 3, stage4: 4, stage5: 5, stage6: 6, stage7: 7, stage8: 8, stage9: 10 };
                for (const [key, chatIdx] of Object.entries(CONVO_TO_CHAT)) {
                    if (savedConvos[key]?.length && stageChatWindows[chatIdx]) {
                        stageChatWindows[chatIdx].restoreHistory(savedConvos[key]);
                    }
                }
            } else {
                updateStageNav(projectDetails.data);
            }
            await refreshProjectKnowledgeSummary().catch(err => console.warn('Source readiness refresh skipped:', err.message));
        } catch (err) {
            console.error("Error loading project details:", err);
            window.location.hash = ''; // Revert to hub on error
        }
    }

    // Stage number → data key mapping (must be declared before handleHashChange runs)
    const STAGE_DATA_KEYS = {
        1: 'stage1_pitch', 2: 'stage2_outline', 3: 'stage3_characters',
        4: 'stage4_beats', 5: 'stage5_treatment', 6: 'stage6_scenes',
        7: 'stage7_style', 8: 'stage7_approved', 9: 'stage8_coverage', 10: 'stage9_rewrites'
    };

    function handleHashChange() {
        const hash = window.location.hash;
        if (hash.startsWith('#project-')) {
            const projectId = hash.replace('#project-', '');
            openProject(projectId);
        } else {
            activeProjectId = null;
            appContainer.classList.add('hidden');
            projectsHub.classList.remove('hidden');

            // Clear workspace state
            resultsContainer.innerHTML = '';
            promptInput.value = '';
            stage1FeedbackPanel?.classList.add('hidden');
            document.querySelector('.prompt-section')?.classList.remove('hidden');
            // Re-hide Stage 1 chat until a pitch is selected
            const s1chat = document.getElementById('stage1-chat');
            const s1split = document.getElementById('stage1-hsplit');
            if (s1chat) s1chat.style.display = 'none';
            if (s1split) s1split.style.display = 'none';
            if (stage1Notes) stage1Notes.value = '';
            if (stage2Notes) stage2Notes.value = '';
            if (stage3Notes) stage3Notes.value = '';

            // Reset to Stage 1
            switchStage(1);

            // Refresh project list
            initHub();
        }
    }

    window.addEventListener('hashchange', handleHashChange);

    btnReturnHome.addEventListener('click', () => {
        window.location.hash = '';
    });

    // Initialize the app state based on URL
    handleHashChange();

    // --- Main App Logic ---
    pdfUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        fileNameDisplay.textContent = file ? file.name : '';
    });

    stage1PdfUpload?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (stage1FileNameDisplay) stage1FileNameDisplay.textContent = file ? file.name : '';
    });

    stage2PdfUpload?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (stage2FileNameDisplay) stage2FileNameDisplay.textContent = file ? file.name : '';
    });

    stage3PdfUpload?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (stage3FileNameDisplay) stage3FileNameDisplay.textContent = file ? file.name : '';
    });

    generateBtn.addEventListener('click', async () => {
        const prompt = promptInput.value.trim();
        const pdfFile = pdfUpload.files[0];

        // If prompt is empty, the backend will generate random pitches

        // Show loading state, clean up results
        loadingState.classList.remove('hidden');
        resultsContainer.innerHTML = '';
        generateBtn.disabled = true;

        try {
            const formData = new FormData();
            if (prompt) formData.append('prompt', prompt);
            if (pdfFile) formData.append('pdfFile', pdfFile);
            if (activeProjectId) formData.append('projectId', activeProjectId);

            const response = await fetch('/api/execute', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}`);
            }

            const data = await response.json();
            await handleSourceGenerationResult(1, data, { postGenerationCheck: false });
            const pitches = data.result.pitch_options;

            if (pitches && Array.isArray(pitches)) {
                renderPitches(pitches);
            } else {
                alert("Unexpected response format from server.");
                console.error("Data received:", data);
            }
        } catch (error) {
            console.error(error);
            alert("An error occurred while generating pitches.");
        } finally {
            loadingState.classList.add('hidden');
            generateBtn.disabled = false;
        }
    });

    function renderPitches(pitches) {
        pitches.forEach((pitch, index) => {
            const card = document.createElement('div');
            card.className = 'pitch-card';
            card.id = `pitch-card-${index}`;

            card.innerHTML = `
                <div class="field-group mb-4">
                    <label class="text-gray-400 block mb-2 text-xs font-semibold tracking-wider uppercase">Title</label>
                    <input type="text" class="editable-field title-input w-full bg-transparent border-none text-gray-100 font-bold" data-field="title" value="${escapeHtml(pitch.title)}">
                </div>
                <div class="field-group mb-4">
                    <label class="text-gray-400 block mb-2 text-xs font-semibold tracking-wider uppercase">Genre</label>
                    <input type="text" class="editable-field w-full bg-transparent border-none text-gray-300" data-field="genre" value="${escapeHtml(pitch.genre)}">
                </div>
                <div class="field-group mb-4">
                    <label class="text-gray-400 block mb-2 text-xs font-semibold tracking-wider uppercase">Logline</label>
                    <textarea class="editable-field w-full bg-transparent border-none resize-none overflow-hidden text-gray-300" data-field="logline">${escapeHtml(pitch.logline)}</textarea>
                </div>
                <div class="field-group mb-4">
                    <label class="text-gray-400 block mb-2 text-xs font-semibold tracking-wider uppercase">Core Theme</label>
                    <textarea class="editable-field w-full bg-transparent border-none resize-none overflow-hidden text-gray-300" data-field="core_theme">${escapeHtml(pitch.core_theme)}</textarea>
                </div>
                <div class="field-group mb-6">
                    <label class="text-gray-400 block mb-2 text-xs font-semibold tracking-wider uppercase">Synopsis</label>
                    <textarea class="editable-field synopsis-input w-full bg-transparent border-none resize-none overflow-hidden text-gray-300" data-field="synopsis">${escapeHtml((pitch.synopsis || '').replace(/(?:\s+)(Act (?:II|III|2|3):)/ig, '\n\n$1').trim())}</textarea>
                </div>
                <button class="approve-btn">Select to Workshop</button>
            `;

            // Auto-resize and listeners
            card.querySelectorAll('textarea').forEach(ta => {
                ta.addEventListener('input', () => autoResize(ta));
                // Initial resize after it's in the DOM
                requestAnimationFrame(() => autoResize(ta));

                // Same hover/focus effects as Stage 3 for consistency
                ta.addEventListener('focus', () => { ta.style.background = 'rgba(31,41,55,0.8)'; ta.style.outline = '1px solid #374151'; });
                ta.addEventListener('blur', () => { ta.style.background = 'transparent'; ta.style.outline = 'none'; });
            });

            // Add approve event listener
            const approveBtn = card.querySelector('.approve-btn');
            approveBtn.addEventListener('click', () => handleApprove(card, index));

            resultsContainer.appendChild(card);
        });
    }

    function handleApprove(selectedCard, index, { skipSave = false } = {}) {
        // Grab the edited data from the card
        const fields = selectedCard.querySelectorAll('.editable-field');
        const approvedData = {};

        fields.forEach(field => {
            const key = field.getAttribute('data-field');
            approvedData[key] = field.value;
        });

        // Persist the selected pitch and auto-rename project to pitch title
        // skipSave = true when restoring from project load (don't overwrite approved state)
        if (activeProjectId && !skipSave) {
            const pitchData = { pitch: approvedData, approved: false };
            if (window.currentProjectData) window.currentProjectData.stage1_pitch = pitchData;
            const payload = { data: { stage1_pitch: pitchData } };
            if (approvedData.title) payload.title = approvedData.title;
            fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(err => console.error('Failed to save selected pitch:', err));
        }

        // Clear the other two cards from the screen
        const allCards = document.querySelectorAll('.pitch-card');
        allCards.forEach(card => {
            if (card !== selectedCard) {
                card.remove();
            }
        });

        // Expand the selected card
        selectedCard.classList.add('expanded');

        // Hide the prompt/generation section — not needed in workshop mode
        document.querySelector('.prompt-section')?.classList.add('hidden');

        // Hide the "Select to Workshop" button
        const btn = selectedCard.querySelector('.approve-btn');
        if (btn) btn.style.display = 'none';

        stage1FeedbackPanel?.classList.remove('hidden');

        // Show the assistant chat window
        const stage1Chat = document.getElementById('stage1-chat');
        const stage1Hsplit = document.getElementById('stage1-hsplit');
        if (stage1Chat) stage1Chat.style.display = '';
        if (stage1Hsplit) stage1Hsplit.style.display = '';

        // Show header buttons now that a pitch is selected
        if (btnStage1Approve) btnStage1Approve.style.display = '';
        const btnExportPitch = document.getElementById('btnDownloadPitch');
        if (btnExportPitch) {
            btnExportPitch.disabled = false;
            btnExportPitch.style.opacity = '';
            btnExportPitch.style.pointerEvents = '';
        }

        toggleStage1EditMode(false);
    }

    function toggleStage1EditMode(isApproved) {
        const expandedCard = document.querySelector('.pitch-card.expanded');
        const allFields = expandedCard
            ? [...expandedCard.querySelectorAll('.field-group .editable-field')]
            : [];
        if (stage1Notes) allFields.push(stage1Notes);

        if (isApproved) {
            // Fields stay editable — first keystroke auto-exits approved state
            allFields.forEach(f => {
                if (f._approveResetHandler) {
                    f.removeEventListener('input', f._approveResetHandler);
                }
                f._approveResetHandler = () => toggleStage1EditMode(false);
                f.addEventListener('input', f._approveResetHandler, { once: true });
            });
            if (btnStage1Revise) btnStage1Revise.classList.add('hidden');
            if (btnStage1Edit) btnStage1Edit.classList.remove('hidden');
            if (btnStage1Approve) {
                btnStage1Approve.style.display = '';
                btnStage1Approve.textContent = 'Approved ✓';
                btnStage1Approve.classList.add('approve-btn-green');
                btnStage1Approve.disabled = true;
            }
        } else {
            // Clean up any pending auto-reset listeners
            allFields.forEach(f => {
                if (f._approveResetHandler) {
                    f.removeEventListener('input', f._approveResetHandler);
                    delete f._approveResetHandler;
                }
            });
            if (btnStage1Revise) {
                btnStage1Revise.classList.remove('hidden');
                btnStage1Revise.disabled = false;
            }
            if (btnStage1Edit) btnStage1Edit.classList.add('hidden');
            if (btnStage1Approve) {
                btnStage1Approve.style.display = '';
                btnStage1Approve.classList.remove('hidden');
                btnStage1Approve.textContent = 'Approve';
                btnStage1Approve.classList.remove('approve-btn-green');
                btnStage1Approve.disabled = false;
            }
        }
    }

    // --- Stage 1 Feedback Panel Logic ---
    if (btnStage1Edit) {
        btnStage1Edit.addEventListener('click', () => {
            toggleStage1EditMode(false);
        });
    }
    if (btnStage1Revise) {
        btnStage1Revise.addEventListener('click', async () => {
        const userNote = stage1Notes.value.trim();

        // Grab current pitch data from expanded card
        const expandedCard = document.querySelector('.pitch-card.expanded');
        if (!expandedCard) return;

        const currentFields = expandedCard.querySelectorAll('.field-group .editable-field');
        const currentPitch = {};
        currentFields.forEach(field => {
            const key = field.getAttribute('data-field');
            currentPitch[key] = field.value;
        });

        // Set loading state
        const originalText = btnStage1Revise.textContent;

        if (!userNote) {
            // No AI feedback provided, treat as a manual save
            if (!activeProjectId) return;
            try {
                btnStage1Revise.textContent = 'Saving...';
                btnStage1Revise.disabled = true;

                const payload = {
                    data: {
                        stage1_pitch: {
                            pitch: currentPitch,
                            notes: ""
                        }
                    }
                };

                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                // Indicate success visually
                btnStage1Revise.textContent = 'Saved!';
                setTimeout(() => {
                    btnStage1Revise.textContent = originalText;
                    btnStage1Revise.disabled = false;
                }, 1500);

                if (btnStage1Approve) {
                    btnStage1Approve.textContent = 'Approve';
                    btnStage1Approve.classList.remove('approve-btn-green');
                }
            } catch (err) {
                console.error("Failed to manual save:", err);
                alert("An error occurred while saving your manual changes.");
                btnStage1Revise.textContent = originalText;
                btnStage1Revise.disabled = false;
            }
            return;
        }

        // Set loading state for AI revision
        btnStage1Revise.textContent = 'Revising...';
        btnStage1Revise.disabled = true;

        try {
            const formData = new FormData();
            formData.append('currentPitch', JSON.stringify(currentPitch));
            formData.append('userNote', userNote);
            if (activeProjectId) formData.append('projectId', activeProjectId);
            if (stage1PdfUpload && stage1PdfUpload.files[0]) {
                formData.append('pdfFile', stage1PdfUpload.files[0]);
            }

            const response = await fetch('/api/refine-pitch', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}`);
            }

            const data = await response.json();
            await handleSourceGenerationResult(1, data);
            const revisedPitch = data.result;

            if (revisedPitch) {
                if (window.currentProjectData) window.currentProjectData.stage1_pitch = { pitch: revisedPitch };

                // Update UI fields
                currentFields.forEach(field => {
                    const key = field.getAttribute('data-field');
                    if (revisedPitch[key]) {
                        if (key === 'synopsis') {
                            field.value = (revisedPitch[key] || '').replace(/(?:\s*)(Act 2:)/ig, '\n\n$1').replace(/(?:\s*)(Act 3:)/ig, '\n\n$1').trim();
                        } else {
                            field.value = revisedPitch[key];
                        }
                    }
                });

                // Clear notes and PDF
                stage1Notes.value = '';
                if (stage1PdfUpload) stage1PdfUpload.value = '';
                if (stage1FileNameDisplay) stage1FileNameDisplay.textContent = '';

                if (btnStage1Approve) {
                    btnStage1Approve.textContent = 'Approve';
                    btnStage1Approve.classList.remove('approve-btn-green');
                }
            } else {
                alert("Unexpected response format from server.");
            }
        } catch (error) {
            console.error(error);
            alert("An error occurred while revising the pitch.");
        } finally {
            btnStage1Revise.textContent = originalText;
            btnStage1Revise.disabled = false;
        }
        });
    }

    // Event listener for Final Approve Stage 1
    if (btnStage1Approve) {
        btnStage1Approve.addEventListener('click', async () => {
        const expandedCard = document.querySelector('.pitch-card.expanded');
        if (!expandedCard) return;
        if (!(await runApprovalSourceGuard(1, btnStage1Approve))) return;

        // Re-grab the edited data just in case they changed it during workshop
        const finalFields = expandedCard.querySelectorAll('.field-group .editable-field');
        const finalData = {};
        finalFields.forEach(field => {
            const key = field.getAttribute('data-field');
            finalData[key] = field.value;
        });
        const notes = stage1Notes?.value ?? '';

        // Set nested payload for Stage 1 data
        const stage1Snapshot = { pitch: finalData, notes: notes, approved: true };
        const versionHistory1 = captureVersionSnapshot(1, 'stage1_pitch', 'Pitch', stage1Snapshot);
        const payload = {
            data: {
                stage1_pitch: stage1Snapshot,
                versionHistory: versionHistory1
            }
        };

        // Save to the active project DB route
        try {
            if (!activeProjectId) throw new Error("No active project ID.");
            btnStage1Approve.textContent = 'Saving...';
            btnStage1Approve.disabled = true;
            btnStage1Approve.classList.remove('approve-btn-green');

            const res = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const updatedProject = await res.json();

            console.log('Final Approved Pitch Saved:', payload);
            await offerStageMemoryCuration(1);

            toggleStage1EditMode(true);

            // Update Navigation UI
            updateStageNav(updatedProject.data);

            // Auto-trigger Stage 2 Beats
            switchStage(2);
            autoGenerateBeats();
        } catch (error) {
            console.error("Failed to save approved pitch:", error);
            alert("An error occurred while saving to the database.");
            btnStage1Approve.textContent = 'Approve';
            btnStage1Approve.classList.remove('approve-btn-green');
            btnStage1Approve.disabled = false;
        }
        });
    }

    // --- Navigation Logic ---

    // Find the most recently revised upstream stage (for stale banner message)
    function findRevisedUpstream(stageNum) {
        const d = window.currentProjectData || {};
        for (let i = stageNum - 1; i >= 1; i--) {
            const key = STAGE_DATA_KEYS[i];
            if (key && d[key]?._meta?.manually_revised_at) {
                return STAGE_LABELS[i];
            }
        }
        return null;
    }

    function updateStageRegenerateButtons(data = window.currentProjectData || {}) {
        const hasStage6 = !!(data.stage6_scenes && (
            data.stage6_scenes.sequences?.length > 0
            || data.stage6_scenes.scenes?.length > 0
            || data.stage6_scenes.length > 0
        ));
        const controls = [
            [btnStage2Regenerate, !!data.stage2_outline],
            [btnStage3Regenerate, !!data.stage3_characters],
            [btnStage4Regenerate, !!(data.stage4_beats || data.stage4_treatment)],
            [btnStage5Regenerate, !!data.stage5_treatment],
            [btnStage6Regenerate, hasStage6],
            [btnStage7RegenerateHeader, !!(data.stage7_style || data.stage7_style_skipped)],
            [btnStage9Regenerate, !!data.stage8_coverage]
        ];
        controls.forEach(([button, visible]) => {
            button?.classList.toggle('hidden', !visible);
        });
    }

    function updateStageNav(data) {
        window.currentProjectData = data;
        function toggle(navEl, isDone, num) {
            if (!navEl) return;
            const b = navEl.querySelector('.badge');
            if (isDone) {
                navEl.classList.add('completed');
                b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            } else {
                navEl.classList.remove('completed');
                b.textContent = num;
            }
        }

        const stageStatus = {
            1: !!data.stage1_pitch,
            2: !!data.stage2_outline,
            3: !!data.stage3_characters,
            4: !!(data.stage4_beats || data.stage4_treatment),
            5: !!data.stage5_treatment,
            6: !!(data.stage6_scenes && (data.stage6_scenes.sequences?.length > 0 || data.stage6_scenes.scenes?.length > 0 || data.stage6_scenes.length > 0)),
            7: !!(data.stage7_style || data.stage7_style_skipped),
            8: !!data.stage7_approved,
            9: !!data.stage8_coverage,
            10: !!data.stage9_rewrites?.approved
        };

        for (let i = 1; i <= 10; i++) {
            const isDone = stageStatus[i] || false;
            toggle(navItems[i], isDone, i);

            // Unlock logic: next stage is unlocked if current is done
            if (i > 1) {
                const prevDone = stageStatus[i - 1] || false;
                if (prevDone) {
                    navItems[i]?.classList.remove('disabled');
                } else {
                    navItems[i]?.classList.add('disabled');
                }
            }

            // Stale stage indicator
            const stageKey = STAGE_DATA_KEYS[i];
            const isStale = stageKey && data[stageKey]?._meta?.stale === true;
            if (navItems[i]) {
                navItems[i].classList.toggle('stage-stale', !!isStale);
            }
        }
        renderStageSourceReadinessBadges(data);
        updateStageRegenerateButtons(data);
    }

    function sourceReadinessListFromData(data = window.currentProjectData) {
        const list = data?.knowledge?.stage_source_readiness;
        return Array.isArray(list) ? list : [];
    }

    function sourceReadinessForStage(stageId, data = window.currentProjectData) {
        return sourceReadinessListFromData(data).find(item => Number(item.stageId) === Number(stageId)) || null;
    }

    function sourceReadinessStatusClass(status) {
        return String(status || 'unknown').replace(/[^a-z_-]/g, '');
    }

    function setProjectKnowledge(knowledge) {
        if (!knowledge) return;
        if (window.currentProjectData) {
            window.currentProjectData.knowledge = knowledge;
            renderStageSourceReadinessBadges(window.currentProjectData);
        }
    }

    function renderStageSourceReadinessBadges(data = window.currentProjectData) {
        for (let stageId = 1; stageId <= 10; stageId++) {
            navItems[stageId]?.querySelector('.stage-source-readiness')?.remove();
            workspaces[stageId]?.querySelector(`.source-readiness-header-badge[data-source-stage="${stageId}"]`)?.remove();
        }
    }

    async function refreshProjectKnowledgeSummary() {
        if (!activeProjectId) return null;
        const res = await fetch(`/api/projects/${activeProjectId}/knowledge`);
        if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
        const data = await res.json();
        setProjectKnowledge(data.knowledge);
        return data.knowledge;
    }

    async function refreshCurrentProjectData() {
        if (!activeProjectId) return null;
        const res = await fetch(`/api/projects/${activeProjectId}`);
        if (!res.ok) throw new Error('Failed to refresh project data');
        const project = await res.json();
        window.currentProjectData = project.data;
        updateStageNav(project.data);
        return project.data;
    }

    async function switchToVersionHistory() {
        for (let i = 1; i <= 10; i++) {
            navItems[i]?.classList.remove('active');
            workspaces[i]?.classList.add('hidden');
        }
        versionHistoryWorkspace?.classList.remove('hidden');
        btnVersionHistory?.classList.add('active');
        try {
            await refreshCurrentProjectData();
        } catch (err) {
            console.warn('Could not refresh project data before rendering history:', err.message);
        }
        renderVersionHistory();
    }

    // Stage labels for user-facing messages
    const STAGE_LABELS = { 1: 'Pitch', 2: 'Outline', 3: 'Characters', 4: 'Beats', 5: 'Treatment', 6: 'Scenes', 7: 'Style', 8: 'Draft', 9: 'Coverage', 10: 'Rewrite' };

    function switchStage(stageNum) {
        activeStageNum = Number(stageNum) || activeStageNum;
        // Hide version history if open
        versionHistoryWorkspace?.classList.add('hidden');
        btnVersionHistory?.classList.remove('active');

        // Deactivate all nav items and hide all workspace views
        for (let i = 1; i <= 10; i++) {
            navItems[i]?.classList.remove('active');
            workspaces[i]?.classList.add('hidden');
        }

        // Remove any existing stale banners
        document.querySelectorAll('.stale-stage-banner').forEach(el => el.remove());

        // Activate the requested stage
        const activeNav = navItems[stageNum];
        const activeWorkspace = workspaces[stageNum];

        if (activeNav) activeNav.classList.add('active');
        if (activeWorkspace) activeWorkspace.classList.remove('hidden');

        // Show stale banner if this stage is outdated
        const stageKey = STAGE_DATA_KEYS[stageNum];
        const stageData = stageKey && window.currentProjectData?.[stageKey];
        if (stageData?._meta?.stale === true && activeWorkspace) {
            // Find which upstream stage was revised
            const upstreamLabel = findRevisedUpstream(stageNum);
            const banner = document.createElement('div');
            banner.className = 'stale-stage-banner';
            banner.innerHTML = `<span>⚠ This stage may be outdated${upstreamLabel ? ` — ${upstreamLabel} was updated after this was generated` : ''}.</span><button class="stale-dismiss-btn" title="Dismiss">✕</button>`;
            banner.querySelector('.stale-dismiss-btn').addEventListener('click', () => banner.remove());
            activeWorkspace.insertBefore(banner, activeWorkspace.firstChild);
        }

        // Auto-resize textareas when switching to a stage (they may have been
        // rendered while the workspace was hidden, giving scrollHeight of 0)
        if (stageNum === 2) {
            setTimeout(() => {
                document.querySelectorAll('.beat-description').forEach(ta => autoResize(ta));
            }, 50);
        } else if (stageNum === 3) {
            setTimeout(() => {
                document.querySelectorAll('.char-ta').forEach(ta => autoResize(ta));
            }, 50);
        } else if (stageNum === 4) {
            setTimeout(() => {
                document.querySelectorAll('.editable-treatment-field').forEach(ta => autoResize(ta));
            }, 50);
        } else if (stageNum === 5) {
            setTimeout(() => {
                document.querySelectorAll('.editable-treatment-field').forEach(ta => autoResize(ta));
            }, 50);
            initStage5();
        } else if (stageNum === 6) {
            setTimeout(() => {
                document.querySelectorAll('.scene-textarea').forEach(ta => autoResize(ta));
            }, 50);
            initStage6();
        } else if (stageNum === 7) {
            initStage7();
        } else if (stageNum === 8) {
            initStage8();
        } else if (stageNum === 9) {
            initStage9();
        } else if (stageNum === 10) {
            initStage10();
        }
    }


    // Bind navigation clicks for all 10 stages
    for (let i = 1; i <= 10; i++) {
        navItems[i]?.addEventListener('click', (e) => {
            e.preventDefault();
            if (!navItems[i].classList.contains('disabled')) {
                switchStage(i);
            }
        });
    }

    // Version history icon click
    btnVersionHistory?.addEventListener('click', () => {
        if (activeProjectId) switchToVersionHistory();
    });
    btnSourceLibrary?.addEventListener('click', () => openSourceLibrary());
    btnSourceLibraryClose?.addEventListener('click', () => sourceLibraryModal?.classList.add('hidden'));
    sourceLibraryModal?.addEventListener('click', (event) => {
        if (event.target === sourceLibraryModal) sourceLibraryModal.classList.add('hidden');
    });
    btnRebuildSourceBible?.addEventListener('click', () => rebuildSourceBible());
    btnKnowledgeDiagnostics?.addEventListener('click', () => loadKnowledgeDiagnostics());
    btnCompactMemory?.addEventListener('click', () => compactProjectMemory());
    btnSourceReaderClose?.addEventListener('click', () => sourceReaderPanel?.classList.add('hidden'));
    sourceUploadForm?.addEventListener('submit', uploadSourceToKnowledge);
    sourceLibraryList?.addEventListener('click', (event) => {
        const readBtn = event.target.closest('.source-library-read');
        if (readBtn) {
            readSourceAsset(readBtn.dataset.sourceId, readBtn.dataset.assetKind || 'extracted');
            return;
        }

        const originalBtn = event.target.closest('.source-library-open-original');
        if (originalBtn) {
            openOriginalSourceAsset(originalBtn.dataset.sourceId);
            return;
        }

        const deleteBtn = event.target.closest('.source-library-delete');
        if (deleteBtn) {
            if (!confirm('Delete this source from project knowledge?')) return;
            deleteSource(deleteBtn.dataset.sourceId);
            return;
        }

        const updateBtn = event.target.closest('.source-library-update');
        if (updateBtn) {
            updateSourceMetadata(updateBtn.dataset.sourceId);
        }
    });
    knowledgeReviewPanel?.addEventListener('click', (event) => {
        const sourceCheckBtn = event.target.closest('[data-action="run-source-check"]');
        if (sourceCheckBtn) {
            runSourceAudit(Number(sourceCheckBtn.dataset.stageId), sourceCheckBtn);
            return;
        }

        const btn = event.target.closest('[data-action="save-knowledge-review"]');
        if (!btn) return;
        saveKnowledgeReview(btn);
    });

    function stageSnapshotForRegenerate(stageNum) {
        const data = window.currentProjectData || {};
        if (stageNum === 2) {
            const outline = scrapeOutline();
            const hasOutline = ['act_1', 'act_2', 'act_3'].some(key => outline?.[key]?.length);
            return {
                stageKey: 'stage2_outline',
                stageName: 'Outline',
                snapshot: hasOutline ? { outline } : data.stage2_outline
            };
        }
        if (stageNum === 3) {
            const characters = scrapeCharacters();
            return {
                stageKey: 'stage3_characters',
                stageName: 'Characters',
                snapshot: characters?.length ? { characters } : data.stage3_characters
            };
        }
        if (stageNum === 4) {
            const beats = scrapeTreatment();
            return {
                stageKey: 'stage4_beats',
                stageName: 'Beats',
                snapshot: beats?.hybrid_beat_sheet?.length ? beats : (data.stage4_beats || data.stage4_treatment)
            };
        }
        if (stageNum === 5) {
            const treatment = scrapeTreatmentStage5();
            const hasTreatment = treatment && Object.entries(treatment).some(([key, value]) => key !== 'notes' && String(value || '').trim());
            return {
                stageKey: 'stage5_treatment',
                stageName: 'Treatment',
                snapshot: hasTreatment ? treatment : data.stage5_treatment
            };
        }
        if (stageNum === 9) {
            return {
                stageKey: 'stage8_coverage',
                stageName: 'Coverage',
                snapshot: data.stage8_coverage
            };
        }
        return null;
    }

    async function saveStageSnapshotBeforeGenericRegenerate(stageNum) {
        const info = stageSnapshotForRegenerate(stageNum);
        if (!info?.snapshot || !activeProjectId) return;
        const versionHistory = captureVersionSnapshot(stageNum, info.stageKey, info.stageName, info.snapshot);
        const response = await fetch(`/api/projects/${activeProjectId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: {
                    [info.stageKey]: info.snapshot,
                    versionHistory
                },
                stampRevisedStage: info.stageKey
            })
        });
        if (!response.ok) throw new Error(`Could not save current ${info.stageName} before regenerating.`);
        const updatedProject = await response.json();
        if (updatedProject?.data) {
            window.currentProjectData = updatedProject.data;
            updateStageNav(updatedProject.data);
        }
    }

    async function regenerateGeneratedStage(stageNum, button, runner) {
        if (!activeProjectId || !runner) return;
        const label = STAGE_LABELS[stageNum] || `Stage ${stageNum}`;
        if (!confirm(`Regenerate ${label}? The current version will be saved to Version History first.`)) return;

        const originalText = button?.textContent || 'Regenerate';
        try {
            if (button) {
                button.disabled = true;
                button.textContent = 'Regenerating...';
            }
            await saveStageSnapshotBeforeGenericRegenerate(stageNum);
            switchStage(stageNum);
            await runner();
        } catch (error) {
            console.error(`${label} regenerate failed:`, error);
            alert(error.message || `Could not regenerate ${label}.`);
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
            updateStageRegenerateButtons(window.currentProjectData || {});
        }
    }

    async function regenerateCoverage(button) {
        if (!activeProjectId) return;
        if (!confirm('Regenerate Coverage? The current report will be saved to Version History first.')) return;
        const originalText = button?.textContent || 'Regenerate';
        try {
            if (button) {
                button.disabled = true;
                button.textContent = 'Regenerating...';
            }
            await saveStageSnapshotBeforeGenericRegenerate(9);
            const response = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: {
                        stage8_coverage: null,
                        stage8_approved: false,
                        versionHistory: window.currentProjectData?.versionHistory || []
                    },
                    stampRevisedStage: 'stage8_coverage'
                })
            });
            if (!response.ok) throw new Error('Could not clear current coverage report.');
            const updatedProject = await response.json();
            window.currentProjectData = updatedProject.data;
            updateStageNav(updatedProject.data);
            switchStage(9);
        } catch (error) {
            console.error('Coverage regenerate failed:', error);
            alert(error.message || 'Could not regenerate Coverage.');
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
            updateStageRegenerateButtons(window.currentProjectData || {});
        }
    }

    btnStage2Regenerate?.addEventListener('click', () => regenerateGeneratedStage(2, btnStage2Regenerate, autoGenerateBeats));
    btnStage3Regenerate?.addEventListener('click', () => regenerateGeneratedStage(3, btnStage3Regenerate, autoGenerateCharacters));
    btnStage4Regenerate?.addEventListener('click', () => regenerateGeneratedStage(4, btnStage4Regenerate, autoGenerateTreatment));
    btnStage5Regenerate?.addEventListener('click', () => regenerateGeneratedStage(5, btnStage5Regenerate, autoGenerateTreatmentStage5));
    btnStage9Regenerate?.addEventListener('click', () => regenerateCoverage(btnStage9Regenerate));

    // --- Version History Logic ---

    function captureVersionSnapshot(stage, stageKey, stageName, snapshotData) {
        const history = (window.currentProjectData?.versionHistory) || [];
        const existingVersions = history.filter(v => v.stage === stage).length;
        const createdAt = new Date().toISOString();
        const entry = {
            id: `${activeProjectId}_stage${stage}_approved_${createdAt.replace(/[^0-9]/g, '')}_${existingVersions + 1}`,
            stage, stageKey, stageName,
            version: existingVersions + 1,
            snapshotType: 'approved',
            label: 'Approved',
            createdAt,
            approvedAt: createdAt,
            snapshot: JSON.parse(JSON.stringify(snapshotData))
        };
        history.push(entry);
        if (window.currentProjectData) window.currentProjectData.versionHistory = history;
        return history;
    }

    function renderVersionHistory() {
        const container = document.getElementById('version-history-list');
        if (!container) return;

        const history = window.currentProjectData?.versionHistory || [];
        if (history.length === 0) {
            container.innerHTML = '<p style="color:#6b7280;font-size:0.875rem;font-style:italic;padding-top:24px">No versions saved yet. Approve a stage to create the first version.</p>';
            return;
        }

        const stageNames = { 1:'Pitch', 2:'Outline', 3:'Characters', 4:'Beats', 5:'Treatment', 6:'Scenes', 7:'Style', 8:'Draft', 9:'Coverage', 10:'Rewrite' };
        const grouped = {};
        history.forEach(v => {
            if (!grouped[v.stage]) grouped[v.stage] = [];
            grouped[v.stage].push(v);
        });

        let html = '';
        Object.keys(grouped).sort((a, b) => Number(a) - Number(b)).forEach(stage => {
            const versions = grouped[stage];
            const stageName = stageNames[stage] || `Stage ${stage}`;
            html += `<div style="margin-bottom:32px">`;
            html += `<h3 style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;margin-bottom:12px;font-weight:600">Stage ${stage}: ${stageName}</h3>`;
            html += `<div style="display:flex;flex-direction:column;gap:8px">`;
            // Show newest first
            [...versions].reverse().forEach(v => {
                const date = new Date(v.approvedAt);
                const dateStr = date.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
                const timeStr = date.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
                const label = v.label || (v.snapshotType ? v.snapshotType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Approved');
                html += `<div style="background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
                    <div>
                        <div style="font-size:0.9rem;color:#e5e7eb;font-weight:500">Version ${v.version} · ${escapeHtml(label)}</div>
                        <div style="font-size:0.75rem;color:#6b7280;margin-top:2px">${dateStr} at ${timeStr}</div>
                    </div>
                    <div style="display:flex;gap:8px;flex-shrink:0">
                        <button class="secondary-btn version-view-btn" style="font-size:0.75rem;padding:6px 12px" data-version-id="${escapeHtml(String(v.id))}">View</button>
                        <button class="secondary-btn version-restore-btn" style="font-size:0.75rem;padding:6px 12px" data-version-id="${escapeHtml(String(v.id))}">Restore</button>
                    </div>
                </div>`;
            });
            html += `</div></div>`;
        });
        container.innerHTML = html;

        // Attach event listeners via delegation instead of inline onclick
        container.querySelectorAll('.version-view-btn').forEach(btn => {
            btn.addEventListener('click', () => window.previewVersionById(btn.dataset.versionId));
        });
        container.querySelectorAll('.version-restore-btn').forEach(btn => {
            btn.addEventListener('click', () => window.restoreVersionById(btn.dataset.versionId));
        });
    }

    window.restoreVersionById = async function(versionId) {
        const history = window.currentProjectData?.versionHistory || [];
        const version = history.find(v => v.id === versionId);
        if (!version) { alert('Version not found.'); return; }

        const confirmed = confirm(`Restore Stage ${version.stage} (${version.stageName}) — Version ${version.version}?\n\nThe stage will reload with this version. You can review and re-approve from there.`);
        if (!confirmed) return;

        try {
            const res = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ restoreVersionId: version.id, data: { [version.stageKey]: version.snapshot } })
            });
            if (!res.ok) throw new Error('Server error');
            const updatedProject = await res.json();
            window.currentProjectData = updatedProject.data;
            updateStageNav(updatedProject.data);
            rerenderStageAfterRestore(version.stage);
            switchStage(version.stage);
        } catch (err) {
            console.error('Restore failed:', err);
            alert('Failed to restore: ' + err.message);
        }
    };

    function rerenderStageAfterRestore(stageNum) {
        const data = window.currentProjectData;
        switch (stageNum) {
            case 1:
                if (data.stage1_pitch) {
                    renderPitches([data.stage1_pitch.pitch]);
                    const card = resultsContainer.querySelector('.pitch-card');
                    if (card) { handleApprove(card, 0, { skipSave: true }); toggleStage1EditMode(true); }
                    if (stage1Notes) stage1Notes.value = data.stage1_pitch.notes || '';
                    const btn1 = document.getElementById('btn-stage1-approve');
                    if (btn1) { btn1.textContent = 'Approve'; btn1.classList.remove('approve-btn-green'); btn1.disabled = false; }
                }
                break;
            case 2:
                if (data.stage2_outline?.outline) {
                    renderOutline(data.stage2_outline.outline);
                    if (btnStage2Approve) { btnStage2Approve.textContent = 'Approve'; btnStage2Approve.classList.remove('approve-btn-green'); btnStage2Approve.disabled = false; }
                    toggleStage2EditMode(false);
                }
                break;
            case 3:
                if (data.stage3_characters?.characters) {
                    renderCharacters(data.stage3_characters.characters);
                    if (btnStage3Approve) { btnStage3Approve.textContent = 'Approve'; btnStage3Approve.classList.remove('approve-btn-green'); btnStage3Approve.disabled = false; }
                    if (btnStage3Edit) btnStage3Edit.classList.add('hidden');
                    if (btnStage3Revise) btnStage3Revise.classList.remove('hidden');
                }
                break;
            case 4: {
                const s4 = data.stage4_beats || data.stage4_treatment;
                if (s4?.hybrid_beat_sheet) {
                    renderTreatment(s4);
                    if (btnStage4Approve) { btnStage4Approve.textContent = 'Approve'; btnStage4Approve.classList.remove('approve-btn-green'); btnStage4Approve.disabled = false; }
                    if (btnStage4Edit) btnStage4Edit.classList.add('hidden');
                    if (btnStage4Revise) btnStage4Revise.classList.remove('hidden');
                }
                break;
            }
            case 5:
                if (data.stage5_treatment) {
                    renderTreatmentStage5(data.stage5_treatment);
                    if (btnStage5Approve) { btnStage5Approve.textContent = 'Approve'; btnStage5Approve.classList.remove('approve-btn-green'); btnStage5Approve.disabled = false; }
                }
                break;
            case 6:
                if (data.stage6_scenes) {
                    renderStage6(data.stage6_scenes);
                    if (btnStage6Approve) { btnStage6Approve.textContent = 'Approve'; btnStage6Approve.classList.remove('approve-btn-green'); btnStage6Approve.disabled = false; }
                }
                break;
            // Stages 8-10: initStage8/9/10() called automatically by switchStage()
        }
    }

    // --- Stage 2 Logic ---
    async function recoverOutlineFromInterruptedStream(previousOutline, { chat = null } = {}) {
        if (!previousOutline) return null;
        let refreshed;
        try {
            refreshed = await refreshCurrentProjectData();
        } catch (err) {
            console.warn('Outline stream recovery refresh failed:', err.message);
            return null;
        }
        const recovered = refreshed?.stage2_outline;
        if (!recovered?.outline) return null;
        if (JSON.stringify(previousOutline || {}) === JSON.stringify(recovered.outline || {})) return null;
        const recoveredEvent = {
            type: 'complete',
            result: recovered,
            changed: true,
            recoveredFromInterruptedStream: true
        };
        await handleSourceGenerationResult(2, recoveredEvent, { chat });
        renderOutline(recovered.outline);
        if (window.currentProjectData) window.currentProjectData.stage2_outline = recovered;
        return recoveredEvent;
    }

    async function consumeOutlineGenerationResponse(response, { chat = null, fallback = 'Outline request failed', previousOutline = null } = {}) {
        if (!response.ok) throw new Error(await apiErrorMessage(response, fallback));

        const contentType = response.headers.get('content-type') || '';
        if (/\btext\/event-stream\b/i.test(contentType)) {
            let completeEvent = null;
            await readSSEStream(response, async (event) => {
                if (event.type === 'complete') {
                    completeEvent = event;
                } else if (event.type === 'error') {
                    throw new Error(event.message || fallback);
                }
            });
            if (!completeEvent) {
                const recoveredEvent = await recoverOutlineFromInterruptedStream(previousOutline, { chat });
                if (recoveredEvent) return recoveredEvent;
                throw new Error('Outline stream ended before the server sent a completion event. If Railway was deploying or restarting, wait for the deploy to finish and try again.');
            }
            await handleSourceGenerationResult(2, completeEvent, { chat });
            renderOutline(completeEvent.result.outline);
            if (window.currentProjectData) window.currentProjectData.stage2_outline = completeEvent.result;
            return completeEvent;
        }

        const data = await response.json();
        await handleSourceGenerationResult(2, data, { chat });
        renderOutline(data.result.outline);
        if (window.currentProjectData) window.currentProjectData.stage2_outline = data.result;
        return data;
    }

    async function autoGenerateBeats() {
        if (!activeProjectId) return;

        // Hide the workshop so no old buttons show
        if (stage2Workshop) stage2Workshop.classList.add('hidden');

        // Reset approve button — generation is starting, nothing is approved yet
        if (btnStage2Approve) {
            btnStage2Approve.textContent = 'Approve';
            btnStage2Approve.classList.remove('approve-btn-green');
            btnStage2Approve.classList.add('hidden');
        }

        loadingStateOutline.classList.remove('hidden');
        const previousOutline = window.currentProjectData?.stage2_outline?.outline || scrapeOutline();
        document.getElementById('act1Container').innerHTML = '';
        document.getElementById('act2Container').innerHTML = '';
        document.getElementById('act3Container').innerHTML = '';

        try {
            const res = await fetch('/api/generate-outline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                body: JSON.stringify({ projectId: activeProjectId, stream: true })
            });
            await consumeOutlineGenerationResponse(res, { fallback: 'Failed to generate outline', previousOutline });
        } catch (err) {
            console.error(err);
            alert(err.message);
        } finally {
            loadingStateOutline.classList.add('hidden');
        }
    }

    function renderOutline(outlineData) {
        const act1Container = document.getElementById('act1Container');
        const act2Container = document.getElementById('act2Container');
        const act3Container = document.getElementById('act3Container');

        act1Container.innerHTML = '';
        act2Container.innerHTML = '';
        act3Container.innerHTML = '';

        const renderSequences = (sequences, container) => {
            sequences.forEach(seq => {
                const seqBlock = document.createElement('div');
                seqBlock.className = 'sequence-block';

                const header = document.createElement('div');
                header.className = 'sequence-header';
                header.textContent = seq.sequence_number_and_title;
                seqBlock.appendChild(header);

                seq.beats.forEach(beat => {
                    const card = document.createElement('div');
                    card.className = 'beat-card';
                    card.innerHTML = `
                        <h4>${escapeHtml(beat.beat_label)}</h4>
                        <textarea class="beat-description w-full bg-transparent border-none resize-none overflow-hidden text-gray-300">${escapeHtml(beat.description)}</textarea>
                    `;

                    const ta = card.querySelector('textarea');
                    ta.addEventListener('input', () => {
                        autoResize(ta);
                        if (btnStage2Approve) {
                            btnStage2Approve.textContent = 'Approve';
                            btnStage2Approve.classList.remove('approve-btn-green');
                            btnStage2Approve.disabled = false;
                        }
                    });
                    requestAnimationFrame(() => autoResize(ta));

                    // Hover/focus effects
                    ta.addEventListener('focus', () => { ta.style.background = 'rgba(31,41,55,0.8)'; ta.style.outline = '1px solid #374151'; });
                    ta.addEventListener('blur', () => { ta.style.background = 'transparent'; ta.style.outline = 'none'; });

                    seqBlock.appendChild(card);
                });

                container.appendChild(seqBlock);
            });
        };

        if (outlineData.act_1) renderSequences(outlineData.act_1, act1Container);
        if (outlineData.act_2) renderSequences(outlineData.act_2, act2Container);
        if (outlineData.act_3) renderSequences(outlineData.act_3, act3Container);

        document.getElementById('outlineContainer').classList.remove('hidden');
        stage2Workshop?.classList.remove('hidden');

        // Also resize immediately if the container is already visible
        requestAnimationFrame(() => {
            document.querySelectorAll('.beat-description').forEach(ta => autoResize(ta));
        });

        toggleStage2EditMode(false);
    }

    function scrapeOutline() {
        const scrapeAct = (containerId) => {
            const container = document.getElementById(containerId);
            const sequenceBlocks = container.querySelectorAll('.sequence-block');
            const sequences = [];

            sequenceBlocks.forEach(block => {
                const title = block.querySelector('.sequence-header').textContent;
                const beatCards = block.querySelectorAll('.beat-card');
                const beats = [];

                beatCards.forEach(card => {
                    const label = card.querySelector('h4').textContent;
                    const desc = card.querySelector('textarea').value;
                    beats.push({ beat_label: label, description: desc });
                });

                sequences.push({
                    sequence_number_and_title: title,
                    beats: beats
                });
            });

            return sequences;
        };

        return {
            act_1: scrapeAct('act1Container'),
            act_2: scrapeAct('act2Container'),
            act_3: scrapeAct('act3Container')
        };
    }

    async function saveOutlineEdits(triggerBtn) {
        if (!activeProjectId) return;
        if (!(await runApprovalSourceGuard(2, triggerBtn))) return;

        const updatedOutline = scrapeOutline();
        const originalText = triggerBtn.textContent;

        const existingHistory = (window.currentProjectData?.versionHistory) || [];
        const isReApproval = existingHistory.filter(v => v.stage === 2).length > 0;

        triggerBtn.textContent = 'Saving...';
        triggerBtn.disabled = true;
        triggerBtn.classList.remove('approve-btn-green');

        const stage2Snapshot = { outline: updatedOutline };
        const versionHistory2 = captureVersionSnapshot(2, 'stage2_outline', 'Outline', stage2Snapshot);

        try {
            const putBody = {
                data: {
                    stage2_outline: stage2Snapshot,
                    versionHistory: versionHistory2
                }
            };
            if (isReApproval) putBody.stampRevisedStage = 'stage2_outline';

            const res = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(putBody)
            });
            const updatedProject = await res.json();
            await offerStageMemoryCuration(2);

            updateStageNav(updatedProject.data);

            triggerBtn.textContent = 'Approved ✓';
            triggerBtn.classList.add('approve-btn-green');
            triggerBtn.disabled = true;

            toggleStage2EditMode(true);

            if (isReApproval) {
                showGenericRegenModal('Outline', 'Stage 3 Characters',
                    () => { switchStage(3); autoGenerateCharacters(); },
                    () => { switchStage(3); }
                );
            } else {
                switchStage(3);
                autoGenerateCharacters();
            }
        } catch (err) {
            console.error("Failed to save outline:", err);
            alert("Error saving outline.");
            triggerBtn.textContent = originalText;
            triggerBtn.disabled = false;
        }
    }

    function toggleStage2EditMode(isApproved) {
        if (isApproved) {
            if (btnStage2Edit) btnStage2Edit.classList.remove('hidden');
            if (btnStage2Revise) btnStage2Revise.classList.add('hidden');
        } else {
            if (btnStage2Edit) btnStage2Edit.classList.add('hidden');

            // FIX: Only show Revise if you want it visible during the drafting phase.
            // If you want it to behave like Stage 1, it should stay hidden 
            // until the first 'Approve' or only show 'Submit' if notes are present.
            if (btnStage2Revise) {
                btnStage2Revise.classList.remove('hidden');
                btnStage2Revise.textContent = 'Submit';
            }

            if (btnStage2Approve) {
                btnStage2Approve.classList.remove('hidden');
                btnStage2Approve.textContent = 'Approve';
                btnStage2Approve.classList.remove('approve-btn-green');
                btnStage2Approve.disabled = false;
            }
        }
    }

    if (btnStage2Approve) {
        btnStage2Approve.addEventListener('click', () => saveOutlineEdits(btnStage2Approve));
    }

    if (btnStage2Edit) {
        btnStage2Edit.addEventListener('click', () => {
            toggleStage2EditMode(false);
        });
    }

    if (btnStage2Revise) {
        btnStage2Revise.addEventListener('click', async () => {
        if (!activeProjectId) return;
        const notes = stage2Notes.value.trim();

        const currentBeats = scrapeOutline();
        const originalText = btnStage2Revise.textContent;

        if (!notes && (!stage2PdfUpload || !stage2PdfUpload.files[0])) {
            // Treat as a manual save if there's no feedback or PDF
            try {
                btnStage2Revise.textContent = 'Saving...';
                btnStage2Revise.disabled = true;

                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data: {
                            stage2_outline: { outline: currentBeats }
                        }
                    })
                });

                btnStage2Revise.textContent = 'Saved!';
                setTimeout(() => {
                    btnStage2Revise.textContent = originalText;
                    btnStage2Revise.disabled = false;
                }, 1500);

            } catch (err) {
                console.error(err);
                alert("Failed to save manual changes.");
                btnStage2Revise.textContent = originalText;
                btnStage2Revise.disabled = false;
            }
            return;
        }

        loadingStateOutline.classList.remove('hidden');
        document.getElementById('act1Container').innerHTML = '';
        document.getElementById('act2Container').innerHTML = '';
        document.getElementById('act3Container').innerHTML = '';

        btnStage2Revise.disabled = true;
        btnStage2Revise.textContent = 'Revising...';

        try {
            const formData = new FormData();
            formData.append('projectId', activeProjectId);
            formData.append('currentBeats', JSON.stringify(currentBeats));
            formData.append('notes', notes);
            formData.append('stream', 'true');
            if (stage2PdfUpload && stage2PdfUpload.files[0]) {
                formData.append('pdfFile', stage2PdfUpload.files[0]);
            }

            const res = await fetch('/api/generate-outline', {
                method: 'POST',
                headers: { 'Accept': 'text/event-stream' },
                body: formData
            });
            await consumeOutlineGenerationResponse(res, { fallback: 'Failed to revise outline', previousOutline: currentBeats });

            // Clear notes and PDF
            stage2Notes.value = '';
            if (stage2PdfUpload) stage2PdfUpload.value = '';
            if (stage2FileNameDisplay) stage2FileNameDisplay.textContent = '';

            const projectRes = await fetch(`/api/projects/${activeProjectId}`);
            const projectDetails = await projectRes.json();
            updateStageNav(projectDetails.data);

            if (btnStage2Approve) {
                btnStage2Approve.textContent = 'Approve';
                btnStage2Approve.classList.remove('approve-btn-green');
            }
        } catch (err) {
            console.error(err);
            alert("Error revising outline: " + err.message);
        } finally {
            loadingStateOutline.classList.add('hidden');
            btnStage2Revise.disabled = false;
            btnStage2Revise.textContent = originalText;
        }
        });
    }

    // --- Stage 3 Logic: Characters ---

    // Cache for _deep_profile data (hidden from UI, preserved across scrape cycles)
    let _deepProfileCache = {};

    // Tag option lists
    const CHAR_TAG_OPTIONS = {
        voice_tag: ['Sparse & precise', 'Warm & meandering', 'Sharp & confrontational', 'Measured & diplomatic', 'Stream-of-consciousness', 'Performative & deflecting', 'Blunt & clipped', 'Lyrical & indirect'],
        pressure_tag: ['Withdraws', 'Controls', 'Lashes out', 'People-pleases', 'Dissociates', 'Doubles down', 'Goes numb', 'Deflects with humor'],
        humor_tag: ['Dry wit', 'Self-deprecating', 'Dark / gallows', 'Physical', 'Deflection', 'None'],
        core_drive: ['To be right', 'To be needed', 'To succeed', 'To be unique', 'To understand', 'To be safe', 'To be free', 'To be in control', 'To keep peace'],
    };

    function markStage3Dirty() {
        if (btnStage3Approve) {
            btnStage3Approve.textContent = 'Approve';
            btnStage3Approve.classList.remove('approve-btn-green');
            btnStage3Approve.disabled = false;
        }
    }

    // Close any open tag dropdowns
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.char-tag-pill-wrap')) {
            document.querySelectorAll('.char-tag-dropdown').forEach(dd => dd.classList.add('hidden'));
        }
    });

    function normalizeStage3CharacterForEditor(character = {}) {
        const core = character.psychological_core || {};
        const voice = character.voice_and_behavior || {};
        const ticks = character.ticks || {};
        const normalized = {
            ...character,
            psychological_core: {
                ghost_and_wound: core.ghost_and_wound || core.wound || core.ghost || '',
                the_lie: core.the_lie || core.false_belief || core.lie || '',
                fear: core.fear || '',
                desire: core.desire || '',
                psychological_need: core.psychological_need || core.need || '',
                moral_need: core.moral_need || '',
                paradox: core.paradox || voice.paradox || ''
            },
            voice_and_behavior: {
                voice_tag: voice.voice_tag || '',
                pressure_tag: voice.pressure_tag || '',
                humor_tag: voice.humor_tag || '',
                speech_patterns: voice.speech_patterns || '',
                deflection_tactic: voice.deflection_tactic || ''
            },
            arc: {
                core_drive: character.arc?.core_drive || '',
                direction: character.arc?.direction || 'Growth'
            },
            ticks: {
                enabled: ticks.enabled === true,
                description: ticks.description || '',
                frequency_gate: ticks.frequency_gate || ''
            }
        };
        if (character._deep_profile) normalized._deep_profile = character._deep_profile;
        if (character.subtlety_guidelines) normalized.subtlety_guidelines = character.subtlety_guidelines;
        return normalized;
    }

    function renderCharacters(characters) {
        if (!charactersContainer) return;
        charactersContainer.innerHTML = '';
        _deepProfileCache = {};

        // Sort: Protagonist first, Antagonist second, Supporting last
        const sorted = [...characters].map(normalizeStage3CharacterForEditor).sort((a, b) => {
            const rank = r => {
                const role = (r.role || '').toLowerCase();
                if (role.includes('protagonist')) return 0;
                if (role.includes('antagonist')) return 1;
                return 2;
            };
            return rank(a) - rank(b);
        });

        sorted.forEach((char, index) => {
            const role = char.role || '';
            const roleLower = role.toLowerCase();

            // Cache _deep_profile
            if (char._deep_profile) {
                _deepProfileCache[char.name || `char_${index}`] = char._deep_profile;
            }

            // Role-based border colour
            let borderColor, badgeBg, badgeColor;
            if (roleLower.includes('protagonist')) {
                borderColor = 'rgba(59,130,246,0.4)';
                badgeBg = 'rgba(59,130,246,0.15)';
                badgeColor = '#93c5fd';
            } else if (roleLower.includes('antagonist')) {
                borderColor = 'rgba(239,68,68,0.4)';
                badgeBg = 'rgba(239,68,68,0.15)';
                badgeColor = '#fca5a5';
            } else {
                borderColor = '#374151';
                badgeBg = 'rgba(107,114,128,0.15)';
                badgeColor = '#9ca3af';
            }

            // Invisible textarea style (transparent, no border, auto-height)
            const taStyle = `
                width: 100%;
                background: transparent;
                border: none;
                resize: none;
                overflow: hidden;
                color: #d1d5db;
                font-size: 0.88rem;
                line-height: 1.5;
                padding: 4px 6px;
                border-radius: 4px;
                outline: none;
                font-family: inherit;
                transition: background 0.15s;
                min-height: 24px;
            `;

            const card = document.createElement('div');
            card.className = 'character-card';
            card.style.backgroundColor = '#111827';
            card.style.borderRadius = '12px';
            card.style.border = `1px solid ${borderColor}`;
            card.style.padding = '24px';
            card.style.display = 'grid';
            card.style.gridTemplateColumns = '1fr 2fr';
            card.style.gap = '28px';
            card.style.alignItems = 'start';
            // Store name & role as data attributes for reliable scraping
            card.dataset.charName = char.name || '';
            card.dataset.charRole = role;

            // Build field helper: label + auto-expanding transparent textarea
            const field = (label, dataField, value) => `
                <div style="margin-bottom: 12px;">
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 2px;">${label}</div>
                    <textarea
                        rows="1"
                        class="char-input char-ta"
                        data-index="${index}"
                        data-field="${dataField}"
                        style="${taStyle}"
                    >${escapeHtml(value || '')}</textarea>
                </div>
            `;

            // Build tag pill helper
            const tagPill = (label, dataField, value, optionsKey) => {
                const options = CHAR_TAG_OPTIONS[optionsKey] || [];
                const current = escapeHtml(value || 'Select...');
                const optionsHtml = options.map(o =>
                    `<button class="char-tag-option" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`
                ).join('');
                return `
                    <div class="char-tag-pill-wrap" style="position: relative;">
                        <div style="font-size: 0.68rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 3px;">${label}</div>
                        <button class="char-tag-pill" data-field="${dataField}" data-value="${escapeHtml(value || '')}">${current}</button>
                        <div class="char-tag-dropdown hidden">
                            ${optionsHtml}
                            <div style="border-top: 1px solid #374151; margin-top: 2px; padding-top: 4px;">
                                <input class="char-tag-custom-input" placeholder="Custom..." />
                            </div>
                        </div>
                    </div>
                `;
            };

            // Ticks section — strip downstream warning from display (re-appended on scrape)
            const TICK_WARNING_RE = /\s*WARNING TO DOWNSTREAM AGENTS:.*$/s;
            const ticksEnabled = char.ticks?.enabled === true;
            const tickDesc = char.ticks?.description || '';
            const tickGateRaw = char.ticks?.frequency_gate || '';
            const tickGate = tickGateRaw.replace(TICK_WARNING_RE, '').trim();
            // Backward compat: fall back to subtlety_guidelines
            const legacySubtlety = (!char.ticks && char.subtlety_guidelines) ? char.subtlety_guidelines : '';

            // Arc direction toggle
            const arcDir = char.arc?.direction || 'Growth';
            const arcDrive = char.arc?.core_drive || '';
            const dirOptions = ['Growth', 'Decline', 'Circular'];

            card.innerHTML = `
                <!-- LEFT COLUMN: Identity -->
                <div style="border-right: 1px solid #1f2937; padding-right: 24px;">
                    <h3 style="margin: 0 0 4px; color: #f9fafb; font-size: 1.5rem; font-weight: 700;">${escapeHtml(char.name || 'Unnamed')}</h3>
                    <div style="display: inline-block; background: ${badgeBg}; color: ${badgeColor}; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 10px; border-radius: 20px; margin-bottom: 16px;">${escapeHtml(role)}</div>
                    <div>
                        <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;">Bio</div>
                        <textarea
                            rows="1"
                            class="char-input char-ta"
                            data-index="${index}"
                            data-field="brief_summary"
                            style="${taStyle} font-style: italic; color: #9ca3af;"
                        >${escapeHtml(char.brief_summary || '')}</textarea>
                    </div>
                </div>

                <!-- RIGHT COLUMN: Deep Dive -->
                <div>
                    <!-- PSYCHOLOGICAL CORE -->
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px;">Psychological Core</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px;">
                        ${field('Ghost & Wound', 'psychological_core.ghost_and_wound', char.psychological_core?.ghost_and_wound)}
                        ${field('The Lie', 'psychological_core.the_lie', char.psychological_core?.the_lie)}
                        ${field('Fear', 'psychological_core.fear', char.psychological_core?.fear)}
                        ${field('Desire', 'psychological_core.desire', char.psychological_core?.desire)}
                        ${field('Psychological Need', 'psychological_core.psychological_need', char.psychological_core?.psychological_need)}
                        ${field('Moral Need', 'psychological_core.moral_need', char.psychological_core?.moral_need)}
                    </div>
                    ${field('Paradox', 'psychological_core.paradox', char.psychological_core?.paradox || char.voice_and_behavior?.paradox)}

                    <!-- VOICE & BEHAVIOR -->
                    <div style="border-top: 1px solid #1f2937; margin: 12px 0;"></div>
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px;">Voice &amp; Behavior</div>
                    <div style="display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
                        ${tagPill('Voice', 'voice_and_behavior.voice_tag', char.voice_and_behavior?.voice_tag, 'voice_tag')}
                        ${tagPill('Pressure', 'voice_and_behavior.pressure_tag', char.voice_and_behavior?.pressure_tag, 'pressure_tag')}
                        ${tagPill('Humor', 'voice_and_behavior.humor_tag', char.voice_and_behavior?.humor_tag, 'humor_tag')}
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px;">
                        ${field('Speech Patterns', 'voice_and_behavior.speech_patterns', char.voice_and_behavior?.speech_patterns)}
                        ${field('Deflection Tactic', 'voice_and_behavior.deflection_tactic', char.voice_and_behavior?.deflection_tactic)}
                    </div>

                    <!-- ARC -->
                    <div style="border-top: 1px solid #1f2937; margin: 12px 0;"></div>
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px;">Arc</div>
                    <div style="display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap;">
                        ${tagPill('Core Drive', 'arc.core_drive', arcDrive, 'core_drive')}
                        <div>
                            <div style="font-size: 0.68rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 3px;">Direction</div>
                            <div class="char-arc-toggle" data-field="arc.direction">
                                ${dirOptions.map(d => `<button class="char-arc-btn${d === arcDir ? ' active' : ''}" data-value="${d}">${d}</button>`).join('')}
                            </div>
                        </div>
                    </div>

                    <!-- TICKS -->
                    <div style="border-top: 1px solid #1f2937; margin: 12px 0;"></div>
                    <div class="char-ticks-section" data-enabled="${ticksEnabled}">
                        <div class="char-ticks-header" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <span class="char-ticks-arrow">${ticksEnabled ? '▼' : '▶'}</span>
                            <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280;">Ticks</div>
                            ${!ticksEnabled ? '<button class="char-ticks-add-btn" style="font-size: 0.7rem; background: rgba(59,130,246,0.15); color: #93c5fd; border: 1px solid rgba(59,130,246,0.3); border-radius: 4px; padding: 1px 8px; cursor: pointer;">Add Tick</button>' : ''}
                        </div>
                        <div class="char-ticks-body" style="margin-top: 8px; ${ticksEnabled ? '' : 'display: none;'}">
                            ${ticksEnabled ? `
                                ${field('Description', 'ticks.description', tickDesc)}
                                ${field('Frequency Gate', 'ticks.frequency_gate', tickGate)}
                                <button class="char-ticks-remove-btn" style="font-size: 0.7rem; background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; padding: 1px 8px; cursor: pointer; margin-top: 4px;">Remove Tick</button>
                            ` : `
                                <div style="color: #6b7280; font-size: 0.82rem; font-style: italic;">No ticks for this character</div>
                            `}
                        </div>
                    </div>
                    ${legacySubtlety ? `
                        <div style="border-top: 1px solid #1f2937; margin: 12px 0;"></div>
                        <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;">Subtlety (legacy)</div>
                        <div style="color: #9ca3af; font-size: 0.82rem; font-style: italic; padding: 4px 6px;">${escapeHtml(legacySubtlety)}</div>
                    ` : ''}
                </div>
            `;

            // --- Event listeners ---

            // Hover/focus effect on transparent textareas
            card.querySelectorAll('.char-ta').forEach(ta => {
                ta.addEventListener('focus', () => { ta.style.background = 'rgba(31,41,55,0.8)'; ta.style.outline = '1px solid #374151'; });
                ta.addEventListener('blur', () => { ta.style.background = 'transparent'; ta.style.outline = 'none'; });
                ta.addEventListener('input', () => { autoResize(ta); markStage3Dirty(); });
            });

            // Tag pill click → toggle dropdown
            card.querySelectorAll('.char-tag-pill').forEach(pill => {
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Close all other dropdowns first
                    document.querySelectorAll('.char-tag-dropdown').forEach(dd => dd.classList.add('hidden'));
                    const dd = pill.nextElementSibling;
                    dd.classList.toggle('hidden');
                });
            });

            // Tag option click → update pill
            card.querySelectorAll('.char-tag-option').forEach(opt => {
                opt.addEventListener('click', () => {
                    const wrap = opt.closest('.char-tag-pill-wrap');
                    const pill = wrap.querySelector('.char-tag-pill');
                    pill.dataset.value = opt.dataset.value;
                    pill.textContent = opt.dataset.value;
                    wrap.querySelector('.char-tag-dropdown').classList.add('hidden');
                    markStage3Dirty();
                });
            });

            // Custom tag input → Enter to apply
            card.querySelectorAll('.char-tag-custom-input').forEach(input => {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && input.value.trim()) {
                        const wrap = input.closest('.char-tag-pill-wrap');
                        const pill = wrap.querySelector('.char-tag-pill');
                        pill.dataset.value = input.value.trim();
                        pill.textContent = input.value.trim();
                        wrap.querySelector('.char-tag-dropdown').classList.add('hidden');
                        input.value = '';
                        markStage3Dirty();
                    }
                });
                input.addEventListener('click', (e) => e.stopPropagation());
            });

            // Arc direction toggle
            card.querySelectorAll('.char-arc-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    card.querySelectorAll('.char-arc-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    markStage3Dirty();
                });
            });

            // Ticks header toggle
            const ticksHeader = card.querySelector('.char-ticks-header');
            const ticksSection = card.querySelector('.char-ticks-section');
            const ticksBody = card.querySelector('.char-ticks-body');
            const ticksArrow = card.querySelector('.char-ticks-arrow');
            if (ticksHeader) {
                ticksHeader.addEventListener('click', (e) => {
                    if (e.target.classList.contains('char-ticks-add-btn')) return; // handled separately
                    const isOpen = ticksBody.style.display !== 'none';
                    ticksBody.style.display = isOpen ? 'none' : '';
                    ticksArrow.textContent = isOpen ? '▶' : '▼';
                });
            }

            // Add Tick button
            const addTickBtn = card.querySelector('.char-ticks-add-btn');
            if (addTickBtn) {
                addTickBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    ticksSection.dataset.enabled = 'true';
                    ticksBody.innerHTML = `
                        ${field('Description', 'ticks.description', '')}
                        ${field('Frequency Gate', 'ticks.frequency_gate', '')}
                        <button class="char-ticks-remove-btn" style="font-size: 0.7rem; background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; padding: 1px 8px; cursor: pointer; margin-top: 4px;">Remove Tick</button>
                    `;
                    ticksBody.style.display = '';
                    ticksArrow.textContent = '▼';
                    addTickBtn.remove();
                    // Attach listeners to new textareas
                    ticksBody.querySelectorAll('.char-ta').forEach(ta => {
                        ta.addEventListener('focus', () => { ta.style.background = 'rgba(31,41,55,0.8)'; ta.style.outline = '1px solid #374151'; });
                        ta.addEventListener('blur', () => { ta.style.background = 'transparent'; ta.style.outline = 'none'; });
                        ta.addEventListener('input', () => { autoResize(ta); markStage3Dirty(); });
                    });
                    // Attach remove listener
                    ticksBody.querySelector('.char-ticks-remove-btn')?.addEventListener('click', () => {
                        ticksSection.dataset.enabled = 'false';
                        ticksBody.innerHTML = '<div style="color: #6b7280; font-size: 0.82rem; font-style: italic;">No ticks for this character</div>';
                        ticksBody.style.display = 'none';
                        ticksArrow.textContent = '▶';
                        // Re-add the Add Tick button
                        const newAddBtn = document.createElement('button');
                        newAddBtn.className = 'char-ticks-add-btn';
                        newAddBtn.style.cssText = 'font-size: 0.7rem; background: rgba(59,130,246,0.15); color: #93c5fd; border: 1px solid rgba(59,130,246,0.3); border-radius: 4px; padding: 1px 8px; cursor: pointer;';
                        newAddBtn.textContent = 'Add Tick';
                        ticksHeader.appendChild(newAddBtn);
                        markStage3Dirty();
                    });
                    markStage3Dirty();
                });
            }

            // Remove Tick button (for initially enabled ticks)
            const removeTickBtn = card.querySelector('.char-ticks-remove-btn');
            if (removeTickBtn) {
                removeTickBtn.addEventListener('click', () => {
                    ticksSection.dataset.enabled = 'false';
                    ticksBody.innerHTML = '<div style="color: #6b7280; font-size: 0.82rem; font-style: italic;">No ticks for this character</div>';
                    ticksBody.style.display = 'none';
                    ticksArrow.textContent = '▶';
                    const newAddBtn = document.createElement('button');
                    newAddBtn.className = 'char-ticks-add-btn';
                    newAddBtn.style.cssText = 'font-size: 0.7rem; background: rgba(59,130,246,0.15); color: #93c5fd; border: 1px solid rgba(59,130,246,0.3); border-radius: 4px; padding: 1px 8px; cursor: pointer;';
                    newAddBtn.textContent = 'Add Tick';
                    ticksHeader.appendChild(newAddBtn);
                    markStage3Dirty();
                });
            }

            charactersContainer.appendChild(card);
        });

        charactersContainer.classList.remove('hidden');
        if (stage3Workshop) stage3Workshop.classList.remove('hidden');

        // Auto-resize all textareas AFTER container is visible
        setTimeout(() => {
            document.querySelectorAll('.char-ta').forEach(ta => autoResize(ta));
        }, 100);
    }

    function scrapeCharacters() {
        const charCards = Array.from(document.querySelectorAll('.character-card'));
        const currentCharacters = [];

        charCards.forEach((card) => {
            const charName = card.dataset.charName || '';
            const charObj = {
                name: charName,
                role: card.dataset.charRole || '',
                brief_summary: '',
                psychological_core: { ghost_and_wound: '', the_lie: '', fear: '', desire: '', psychological_need: '', moral_need: '', paradox: '' },
                voice_and_behavior: { voice_tag: '', pressure_tag: '', humor_tag: '', speech_patterns: '', deflection_tactic: '' },
                arc: { core_drive: '', direction: 'Growth' },
                ticks: { enabled: false, description: '', frequency_gate: '' },
            };

            // Scrape textareas
            const inputs = card.querySelectorAll('.char-input');
            inputs.forEach(input => {
                const f = input.getAttribute('data-field');
                const val = input.value;
                if (f === 'brief_summary') {
                    charObj.brief_summary = val;
                } else if (f.startsWith('psychological_core.')) {
                    charObj.psychological_core[f.split('.')[1]] = val;
                } else if (f.startsWith('voice_and_behavior.')) {
                    charObj.voice_and_behavior[f.split('.')[1]] = val;
                } else if (f.startsWith('ticks.')) {
                    charObj.ticks[f.split('.')[1]] = val;
                }
            });

            // Scrape tag pills
            card.querySelectorAll('.char-tag-pill').forEach(pill => {
                const f = pill.getAttribute('data-field');
                const val = pill.dataset.value || '';
                if (f.startsWith('voice_and_behavior.')) {
                    charObj.voice_and_behavior[f.split('.')[1]] = val;
                } else if (f === 'arc.core_drive') {
                    charObj.arc.core_drive = val;
                }
            });

            // Scrape arc direction toggle
            const activeArcBtn = card.querySelector('.char-arc-btn.active');
            if (activeArcBtn) {
                charObj.arc.direction = activeArcBtn.dataset.value || 'Growth';
            }

            // Scrape ticks enabled state + re-append downstream warning to frequency_gate
            const ticksSection = card.querySelector('.char-ticks-section');
            if (ticksSection) {
                charObj.ticks.enabled = ticksSection.dataset.enabled === 'true';
                if (charObj.ticks.enabled && charObj.ticks.frequency_gate) {
                    const TICK_WARNING = 'WARNING TO DOWNSTREAM AGENTS: This tick must be used a maximum of ONCE per sequence, and only during the scene of absolute highest stress within that sequence.';
                    if (!charObj.ticks.frequency_gate.includes('WARNING TO DOWNSTREAM AGENTS')) {
                        charObj.ticks.frequency_gate = charObj.ticks.frequency_gate.trim() + ' ' + TICK_WARNING;
                    }
                }
            }

            // Re-attach _deep_profile from cache
            if (_deepProfileCache[charName]) {
                charObj._deep_profile = _deepProfileCache[charName];
            }

            currentCharacters.push(charObj);
        });

        return currentCharacters;
    }

    async function autoGenerateCharacters() {
        if (!activeProjectId) return;

        if (btnStage3Approve) {
            btnStage3Approve.textContent = 'Approve';
            btnStage3Approve.classList.remove('approve-btn-green');
            btnStage3Approve.classList.add('hidden');
        }

        loadingStateCharacters.classList.remove('hidden');
        charactersContainer.classList.add('hidden');

        // Ensure the feedback/revise bar is gone
        if (stage3Workshop) stage3Workshop.classList.add('hidden');

        if (generateCharactersBtn) generateCharactersBtn.disabled = true;

        try {
            const res = await fetch('/api/generate-characters', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId })
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Failed to generate characters");
            }
            const data = await res.json();
            await handleSourceGenerationResult(3, data);

            renderCharacters(data.result.characters);
            if (window.currentProjectData) window.currentProjectData.stage3_characters = data.result;

            const projectRes = await fetch(`/api/projects/${activeProjectId}`);
            const projectDetails = await projectRes.json();
            updateStageNav(projectDetails.data);

            // Always show Submit + Approve after a fresh generation
            if (btnStage3Edit) btnStage3Edit.classList.add('hidden');
            if (btnStage3Revise) {
                btnStage3Revise.classList.remove('hidden');
                btnStage3Revise.textContent = 'Submit';
                btnStage3Revise.disabled = false;
            }
            if (btnStage3Approve) {
                btnStage3Approve.classList.remove('hidden');
                btnStage3Approve.textContent = 'Approve';
                btnStage3Approve.classList.remove('approve-btn-green');
                btnStage3Approve.disabled = false;
            }
        } catch (err) {
            console.error(err);
            alert("Error generating characters: " + err.message);
        } finally {
            loadingStateCharacters.classList.add('hidden');
            if (generateCharactersBtn) generateCharactersBtn.disabled = false;
        }
    }

    if (btnStage3Edit) {
        btnStage3Edit.addEventListener('click', () => {
            btnStage3Edit.classList.add('hidden');
            if (btnStage3Revise) {
                btnStage3Revise.classList.remove('hidden');
                btnStage3Revise.textContent = 'Submit';
                btnStage3Revise.disabled = false;
            }
            if (btnStage3Approve) {
                btnStage3Approve.classList.remove('hidden');
                btnStage3Approve.textContent = 'Approve';
                btnStage3Approve.classList.remove('approve-btn-green');
                btnStage3Approve.disabled = false;
            }
        });
    }

    if (btnStage3Revise) {
        btnStage3Revise.addEventListener('click', async () => {
            if (!activeProjectId) return;
            const notes = stage3Notes ? stage3Notes.value.trim() : '';
            const currentCharacters = scrapeCharacters();
            const originalText = btnStage3Revise.textContent;

            if (!notes && (!stage3PdfUpload || !stage3PdfUpload.files[0])) {
                // Manual save
                try {
                    btnStage3Revise.textContent = 'Saving...';
                    btnStage3Revise.disabled = true;

                    await fetch(`/api/projects/${activeProjectId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            data: {
                                stage3_characters: { characters: currentCharacters }
                            }
                        })
                    });

                    btnStage3Revise.textContent = 'Saved!';
                    setTimeout(() => {
                        btnStage3Revise.textContent = originalText;
                        btnStage3Revise.disabled = false;
                    }, 1500);

                } catch (err) {
                    console.error(err);
                    alert("Failed to save manual changes.");
                    btnStage3Revise.textContent = originalText;
                    btnStage3Revise.disabled = false;
                }
                return;
            }

            loadingStateCharacters.classList.remove('hidden');
            charactersContainer.classList.add('hidden');
            btnStage3Revise.disabled = true;
            btnStage3Revise.textContent = 'Revising...';

            try {
                const formData = new FormData();
                formData.append('projectId', activeProjectId);
                formData.append('currentCharacters', JSON.stringify(currentCharacters));
                formData.append('notes', notes);
                if (stage3PdfUpload && stage3PdfUpload.files[0]) {
                    formData.append('pdfFile', stage3PdfUpload.files[0]);
                }

                const res = await fetch('/api/generate-characters', {
                    method: 'POST',
                    body: formData
                });

                if (!res.ok) {
                    const errData = await res.json();
                    throw new Error(errData.error || "Failed to revise characters");
                }
                const data = await res.json();
                await handleSourceGenerationResult(3, data);
                renderCharacters(data.result.characters);
                if (window.currentProjectData) window.currentProjectData.stage3_characters = data.result;

                // Clear notes and PDF
                if (stage3Notes) stage3Notes.value = ''; // clear notes
                if (stage3PdfUpload) stage3PdfUpload.value = '';
                if (stage3FileNameDisplay) stage3FileNameDisplay.textContent = '';

                const projectRes = await fetch(`/api/projects/${activeProjectId}`);
                const projectDetails = await projectRes.json();
                updateStageNav(projectDetails.data);

                if (btnStage3Approve) {
                    btnStage3Approve.textContent = 'Approve';
                    btnStage3Approve.classList.remove('approve-btn-green');
                }
            } catch (err) {
                console.error(err);
                alert("Error revising characters.");
            } finally {
                loadingStateCharacters.classList.add('hidden');
                btnStage3Revise.disabled = false;
                btnStage3Revise.textContent = originalText;
                charactersContainer.classList.remove('hidden');
            }
        });
    }

    // --- Stage 3 Re-Generation Options Modal ---
    const stage3RegenModal = document.getElementById('stage3-regen-modal');
    const btnRegenToStage10 = document.getElementById('btn-regen-to-stage10');
    const btnRegenSurgical = document.getElementById('btn-regen-surgical');
    const btnRegenFull = document.getElementById('btn-regen-full');
    const regenSurgicalDisabledMsg = document.getElementById('regen-surgical-disabled-msg');

    function diffCharacters(oldChars, newChars) {
        const changes = [];
        for (const nc of newChars) {
            const oc = oldChars.find(c => c.name === nc.name);
            if (!oc) { changes.push(`Added new character: ${nc.name} (${nc.role})`); continue; }
            if (oc.role !== nc.role) changes.push(`${nc.name}: role changed from "${oc.role}" to "${nc.role}"`);
            const pOld = oc.psychological_core || {};
            const pNew = nc.psychological_core || {};
            for (const k of ['ghost_and_wound', 'the_lie', 'fear', 'desire', 'psychological_need', 'moral_need', 'paradox']) {
                if ((pOld[k] || '') !== (pNew[k] || '')) changes.push(`${nc.name}: ${k.replace(/_/g, ' ')} updated`);
            }
            const vOld = oc.voice_and_behavior || {};
            const vNew = nc.voice_and_behavior || {};
            if (vOld.voice_tag !== vNew.voice_tag) changes.push(`${nc.name}: voice_tag changed from "${vOld.voice_tag || ''}" to "${vNew.voice_tag || ''}"`);
            if (vOld.pressure_tag !== vNew.pressure_tag) changes.push(`${nc.name}: pressure_tag changed from "${vOld.pressure_tag || ''}" to "${vNew.pressure_tag || ''}"`);
            if (vOld.humor_tag !== vNew.humor_tag) changes.push(`${nc.name}: humor_tag changed from "${vOld.humor_tag || ''}" to "${vNew.humor_tag || ''}"`);
            const aOld = oc.arc || {};
            const aNew = nc.arc || {};
            if (aOld.core_drive !== aNew.core_drive) changes.push(`${nc.name}: core_drive changed from "${aOld.core_drive || ''}" to "${aNew.core_drive || ''}"`);
            if (aOld.direction !== aNew.direction) changes.push(`${nc.name}: arc direction changed from "${aOld.direction || ''}" to "${aNew.direction || ''}"`);
            if ((oc.ticks?.enabled || false) !== (nc.ticks?.enabled || false)) changes.push(`${nc.name}: ticks ${nc.ticks?.enabled ? 'added' : 'removed'}`);
        }
        for (const oc of oldChars) {
            if (!newChars.find(c => c.name === oc.name)) changes.push(`Removed character: ${oc.name}`);
        }
        return changes;
    }

    function getCharacterDiffNotes() {
        const history = window.currentProjectData?.versionHistory || [];
        const stage3Versions = history.filter(v => v.stage === 3);
        const prevSnapshot = stage3Versions.length >= 2
            ? stage3Versions[stage3Versions.length - 2].snapshot
            : stage3Versions[stage3Versions.length - 1]?.snapshot;
        const currentChars = window.currentProjectData?.stage3_characters?.characters || [];
        const prevChars = prevSnapshot?.characters || [];
        return diffCharacters(prevChars, currentChars);
    }

    function showStage3RegenModal() {
        if (!stage3RegenModal) return;
        const d = window.currentProjectData || {};
        const hasStage4 = !!d.stage4_beats;
        const hasStage10 = !!d.stage9_rewrites;
        // Show/hide Stage 10 button based on whether Stage 10 data exists
        if (btnRegenToStage10) btnRegenToStage10.classList.toggle('hidden', !hasStage10);
        // Enable/disable surgical button
        if (btnRegenSurgical) btnRegenSurgical.disabled = !hasStage4;
        if (regenSurgicalDisabledMsg) regenSurgicalDisabledMsg.classList.toggle('hidden', hasStage4);
        stage3RegenModal.classList.remove('hidden');
    }

    function closeStage3RegenModal() {
        if (stage3RegenModal) stage3RegenModal.classList.add('hidden');
    }

    if (stage3RegenModal) {
        stage3RegenModal.addEventListener('click', (e) => {
            if (e.target === stage3RegenModal) closeStage3RegenModal();
        });
    }

    // "Send to Stage 10 Rewrite"
    if (btnRegenToStage10) {
        btnRegenToStage10.addEventListener('click', async () => {
            closeStage3RegenModal();
            // Store character change context for Stage 10 init
            const changes = getCharacterDiffNotes();
            if (changes.length > 0) {
                try {
                    await fetch(`/api/projects/${activeProjectId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ data: { characterChangeContext: changes.join('\n') } })
                    });
                } catch (e) { console.error('Failed to save character change context:', e); }
            }
            switchStage(10);
        });
    }

    // "Re-generate Stage 4 (surgical)"
    if (btnRegenSurgical) {
        btnRegenSurgical.addEventListener('click', async () => {
            closeStage3RegenModal();
            const changes = getCharacterDiffNotes();
            const notes = changes.length > 0
                ? 'Character profile changes (update affected beats while preserving overall structure):\n' + changes.join('\n')
                : 'Minor character updates — preserve existing beat structure as much as possible.';

            switchStage(4);

            const currentBeats = window.currentProjectData?.stage4_beats;
            if (!currentBeats) { autoGenerateTreatment(); return; }

            if (loadingStateTreatment) loadingStateTreatment.classList.remove('hidden');
            if (stage4Workshop) stage4Workshop.classList.add('hidden');
            if (treatmentContainer) { treatmentContainer.innerHTML = ''; treatmentContainer.classList.add('hidden'); }
            if (treatmentActions) treatmentActions.classList.add('hidden');
            if (loadingTextTreatment) loadingTextTreatment.textContent = 'Surgically updating beats...';

            try {
                const formData = new FormData();
                formData.append('projectId', activeProjectId);
                formData.append('currentBeats', JSON.stringify(currentBeats));
                formData.append('notes', notes);

                const response = await fetch('/api/generate-stage4-beats', { method: 'POST', body: formData });
                if (!response.ok) throw new Error(`Server responded with ${response.status}`);

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const event = JSON.parse(line.slice(6));
                        if (event.type === 'progress') {
                            if (loadingTextTreatment) loadingTextTreatment.textContent = event.label;
                        } else if (event.type === 'complete') {
                            renderTreatment(event.result);
                            if (window.currentProjectData) window.currentProjectData.stage4_beats = event.result;
                            const projRes = await fetch(`/api/projects/${activeProjectId}`);
                            const projData = await projRes.json();
                            updateStageNav(projData.data);
                            await handleSourceGenerationResult(4, event);
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        }
                    }
                }
            } catch (err) {
                console.error('Error during surgical beat update:', err);
                alert('Error during surgical beat update. You can retry from Stage 4.');
                if (treatmentActions) treatmentActions.classList.remove('hidden');
            } finally {
                if (loadingStateTreatment) loadingStateTreatment.classList.add('hidden');
            }
        });
    }

    // "Re-generate Stage 4 (full)"
    if (btnRegenFull) {
        btnRegenFull.addEventListener('click', () => {
            closeStage3RegenModal();
            switchStage(4);
            autoGenerateTreatment();
        });
    }

    // --- Generic Re-Approval Modal (Stages 2, 4, 5, 6) ---
    const genericRegenModal = document.getElementById('generic-regen-modal');
    const genericRegenTitle = document.getElementById('generic-regen-title');
    const genericRegenNextLabel = document.getElementById('generic-regen-next-label');
    const btnGenericRegenFull = document.getElementById('btn-generic-regen-full');
    const btnGenericSkip = document.getElementById('btn-generic-skip');

    let _genericRegenCallbacks = { onRegen: null, onSkip: null };

    function showGenericRegenModal(stageName, nextStageName, onRegen, onSkip) {
        if (!genericRegenModal) { onRegen(); return; } // fallback if modal missing
        if (genericRegenTitle) genericRegenTitle.textContent = `${stageName} Updated`;
        if (genericRegenNextLabel) genericRegenNextLabel.textContent = nextStageName;
        _genericRegenCallbacks = { onRegen, onSkip };
        genericRegenModal.classList.remove('hidden');
    }

    function closeGenericRegenModal() {
        if (genericRegenModal) genericRegenModal.classList.add('hidden');
    }

    if (genericRegenModal) {
        genericRegenModal.addEventListener('click', (e) => {
            if (e.target === genericRegenModal) {
                closeGenericRegenModal();
                if (_genericRegenCallbacks.onSkip) _genericRegenCallbacks.onSkip();
            }
        });
    }
    if (btnGenericRegenFull) {
        btnGenericRegenFull.addEventListener('click', () => {
            closeGenericRegenModal();
            if (_genericRegenCallbacks.onRegen) _genericRegenCallbacks.onRegen();
        });
    }
    if (btnGenericSkip) {
        btnGenericSkip.addEventListener('click', () => {
            closeGenericRegenModal();
            if (_genericRegenCallbacks.onSkip) _genericRegenCallbacks.onSkip();
        });
    }

    if (btnStage3Approve) {
        btnStage3Approve.addEventListener('click', async () => {
            if (!activeProjectId) return;
            if (!(await runApprovalSourceGuard(3, btnStage3Approve))) return;

            const currentCharacters = scrapeCharacters();
            const originalText = btnStage3Approve.textContent;

            // Detect re-approval: check if Stage 3 already has a version in history
            const existingHistory = (window.currentProjectData?.versionHistory) || [];
            const isReApproval = existingHistory.filter(v => v.stage === 3).length > 0;

            btnStage3Approve.textContent = 'Saving...';
            btnStage3Approve.disabled = true;
            btnStage3Approve.classList.remove('approve-btn-green');

            const stage3Snapshot = { characters: currentCharacters };
            const versionHistory3 = captureVersionSnapshot(3, 'stage3_characters', 'Characters', stage3Snapshot);

            try {
                const putBody = {
                    data: {
                        stage3_characters: stage3Snapshot,
                        versionHistory: versionHistory3
                    }
                };
                // On re-approval, stamp downstream stages as stale
                if (isReApproval) putBody.stampRevisedStage = 'stage3_characters';

                const res = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(putBody)
                });
                const updatedProject = await res.json();
                await offerStageMemoryCuration(3);
                updateStageNav(updatedProject.data);

                btnStage3Approve.textContent = 'Approved ✓';
                btnStage3Approve.classList.add('approve-btn-green');
                btnStage3Approve.disabled = true;

                // Toggle back to edit mode
                if (btnStage3Edit) btnStage3Edit.classList.remove('hidden');
                if (btnStage3Revise) btnStage3Revise.classList.add('hidden');

                if (isReApproval) {
                    // Show options modal instead of auto-advancing
                    showStage3RegenModal();
                } else {
                    // First approval: auto-transition to Stage 4
                    switchStage(4);
                    autoGenerateTreatment();
                }
            } catch (err) {
                console.error(err);
                alert("Error saving approved characters.");
                btnStage3Approve.textContent = originalText;
                btnStage3Approve.disabled = false;
            }
        });
    }

    // Utility for safely rendering HTML
    function escapeHtml(unsafe) {
        return (unsafe || '').toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatCountLabel(count, singular, plural) {
        return `${count} ${count === 1 ? singular : plural}`;
    }

    function setSourceLibraryStatus(message = '', isError = false) {
        if (!sourceLibraryStatus) return;
        sourceLibraryStatus.textContent = message;
        sourceLibraryStatus.classList.toggle('source-library-status-error', !!isError);
    }

    async function responseErrorMessage(res, fallback = 'Request failed') {
        const payload = await res.json().catch(() => null);
        return payload?.error || `${fallback} (${res.status})`;
    }

    function renderSourceBiblePanel(bible = {}) {
        if (!sourceBiblePanel) return;
        const facts = Array.isArray(bible.canon_facts) ? bible.canon_facts.slice(0, 8) : [];
        const mustKeep = Array.isArray(bible.must_keep_elements) ? bible.must_keep_elements.slice(0, 6) : [];
        const curatedNotes = Array.isArray(bible.curated_notes) ? bible.curated_notes.slice(-6) : [];
        const updated = bible.updatedAt ? new Date(bible.updatedAt).toLocaleString() : 'Not built yet';
        sourceBiblePanel.innerHTML = `
            <div class="source-bible-header">
                <div>
                    <div class="source-bible-kicker">Source Bible</div>
                    <div class="source-bible-updated">${escapeHtml(updated)}</div>
                </div>
                <span>${escapeHtml(formatCountLabel(bible.sourceCount || bible.sourceIds?.length || 0, 'source', 'sources'))}</span>
            </div>
            <p>${escapeHtml(bible.summary || 'No structured source bible yet.')}</p>
            ${facts.length ? `<div class="source-bible-list"><strong>Canon</strong><ul>${facts.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
            ${mustKeep.length ? `<div class="source-bible-list"><strong>Must Keep</strong><ul>${mustKeep.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
            ${curatedNotes.length ? `<div class="source-bible-list"><strong>Project Notes</strong><ul>${curatedNotes.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
        `;
    }

    function renderKnowledgeDiagnostics(diagnostics = {}) {
        if (!knowledgeDiagnosticsPanel) return;
        const issues = diagnostics.issues || [];
        const counts = diagnostics.counts || {};
        const countLine = [
            `${counts.sources || 0} sources`,
            `${counts.handoffs || 0} handoffs`,
            `${counts.sourcePlans || 0} plans`,
            `${counts.sourceAudits || 0} audits`,
            `${counts.continuityItems || 0} continuity`,
            `${counts.acceptedDivergences || 0} divergences`
        ].join(' · ');
        knowledgeDiagnosticsPanel.innerHTML = `
            <div class="knowledge-panel-header">
                <strong>Memory Health</strong>
                <span>${escapeHtml(countLine)}</span>
            </div>
            ${issues.length ? `
                <div class="knowledge-diagnostics-list">
                    ${issues.slice(0, 10).map(issue => `
                        <div class="knowledge-diagnostic-item knowledge-diagnostic-${escapeHtml(issue.severity || 'info')}">
                            <strong>${escapeHtml(issue.message || '')}</strong>
                            ${issue.recommendedAction ? `<p>${escapeHtml(issue.recommendedAction)}</p>` : ''}
                        </div>
                    `).join('')}
                </div>
            ` : '<p class="knowledge-empty">No memory health issues found.</p>'}
        `;
    }

    function renderKnowledgeSnapshot(snapshot = {}) {
        if (!knowledgeSnapshotPanel) return;
        const handoffs = Array.isArray(snapshot.stageHandoffs) ? snapshot.stageHandoffs.slice(-6) : [];
        const continuity = Array.isArray(snapshot.continuityWatchlist) ? snapshot.continuityWatchlist.slice(-6) : [];
        const readiness = Array.isArray(snapshot.sourceReadiness) ? snapshot.sourceReadiness : [];
        const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : 'Not built yet';
        knowledgeSnapshotPanel.innerHTML = `
            <div class="knowledge-panel-header">
                <strong>Memory Snapshot</strong>
                <span>${escapeHtml(generated)}</span>
            </div>
            <p class="knowledge-snapshot-summary">${escapeHtml(snapshot.summary || 'No compact assistant memory snapshot yet.')}</p>
            <div class="knowledge-snapshot-grid">
                <section>
                    <h4>Stage Handoffs</h4>
                    ${handoffs.length ? `<ul>${handoffs.map(item => `<li><strong>${escapeHtml(item.stageName || `Stage ${item.stageId || ''}`)}:</strong> ${escapeHtml(item.summary || '')}</li>`).join('')}</ul>` : '<p class="knowledge-empty">No handoffs saved yet.</p>'}
                </section>
                <section>
                    <h4>Continuity</h4>
                    ${continuity.length ? `<ul>${continuity.map(item => `<li>${escapeHtml(formatKnowledgeItemForUi(item))}</li>`).join('')}</ul>` : '<p class="knowledge-empty">No continuity items yet.</p>'}
                </section>
            </div>
            ${readiness.length ? `
                <div class="knowledge-snapshot-readiness">
                    ${readiness.map(item => `<span class="source-readiness-pill source-readiness-${escapeHtml(item.status || 'unknown')}">${escapeHtml(item.stageName || `Stage ${item.stageId || ''}`)}: ${escapeHtml(item.label || item.status || 'Unknown')}</span>`).join('')}
                </div>
            ` : ''}
        `;
    }

    function stageHasMemoryHandoffOutput(data = window.currentProjectData || {}, stageId) {
        const d = data?.data && !data.stage1_pitch ? data.data : (data || {});
        switch (Number(stageId)) {
            case 1: return !!d.stage1_pitch?.pitch;
            case 2: return !!d.stage2_outline?.outline?.length;
            case 3: return !!d.stage3_characters?.characters?.length;
            case 4: return !!(d.stage4_beats || d.stage4_treatment);
            case 5: return !!d.stage5_treatment;
            case 6: return !!(d.stage6_scenes && (
                d.stage6_scenes.length > 0
                || d.stage6_scenes.sequences?.length > 0
                || d.stage6_scenes.scenes?.length > 0
            ));
            case 7: return !!d.stage7_style;
            case 8: return !!d.stage7_approved;
            case 9: return !!d.stage8_coverage;
            case 10: return !!d.stage9_rewrites?.approved;
            default: return false;
        }
    }

    function latestVersionForStageUi(data = window.currentProjectData || {}, stageId) {
        const d = data?.data && !data.versionHistory ? data.data : (data || {});
        const history = Array.isArray(d.versionHistory) ? d.versionHistory : [];
        return history
            .filter(entry => Number(entry.stage) === Number(stageId))
            .sort((a, b) => new Date(b.approvedAt || 0) - new Date(a.approvedAt || 0))[0] || null;
    }

    function sourceCheckButtonForInspector(stageId, readiness = {}, { force = false, label = 'Run Check Source' } = {}) {
        const numericStageId = Number(stageId);
        const sourceCount = readiness.sourceCount ?? (window.currentProjectData?.knowledge?.source_registry || []).length;
        const hasOutput = readiness.hasOutput || stageHasMemoryHandoffOutput(window.currentProjectData, numericStageId);
        const status = readiness.status || '';
        const needsCheck = force
            || readiness.isAuditInvalidated
            || readiness.sourcePlan?.isStale
            || ['needs_audit', 'stale', 'fixed_since_audit'].includes(status);
        if (!SOURCE_READINESS_STAGES.has(numericStageId) || !sourceCount || !hasOutput || !needsCheck) return '';
        return `<button type="button" class="source-ledger-action" data-action="run-source-check" data-stage-id="${escapeHtml(String(numericStageId))}">${escapeHtml(label)}</button>`;
    }

    function sourceReadinessInspectorMessage(readiness = {}, audit = null, plan = null) {
        const invalidatedReason = readiness.auditInvalidatedReason || audit?.invalidatedReason || plan?.invalidatedReason || '';
        if (readiness.isAuditInvalidated || audit?.invalidatedAt) {
            return `Audit needs refresh because source material changed${invalidatedReason ? `: ${invalidatedReason}` : '.'}`;
        }
        if (plan?.invalidatedAt) {
            return `Source plan needs refresh because source material changed${invalidatedReason ? `: ${invalidatedReason}` : '.'}`;
        }
        if (!readiness.sourceCount) {
            return 'No saved source documents are available for this stage.';
        }
        if (!readiness.hasAudit) {
            return 'No audit yet for the active stage. Run Check Source when this output needs source trust.';
        }
        if (readiness.isStale || readiness.status === 'stale') {
            return 'Audit needs refresh because the current stage output changed after the last check.';
        }
        if (readiness.status === 'fixed_since_audit') {
            return 'Source fixes were applied after the last audit; a fresh check can confirm alignment.';
        }
        if (readiness.status === 'issues') {
            return 'Latest audit has unresolved source findings.';
        }
        if (readiness.status === 'resolved') {
            return 'Latest audit findings have been addressed or accepted.';
        }
        if (readiness.status === 'ready') {
            return 'Latest source audit is fresh with no open findings.';
        }
        return 'Source readiness has not been computed for this stage yet.';
    }

    function sourceReadinessLedgerNote(readiness = {}) {
        if (readiness.isAuditInvalidated) return readiness.auditInvalidatedReason || 'Audit invalidated after source material changed.';
        if (readiness.isStale) return 'Stage output changed after the saved audit.';
        if (readiness.status === 'needs_audit' && !readiness.hasAudit) return 'No audit yet for this stage output.';
        if (readiness.status === 'fixed_since_audit') return 'Fixes were applied after the last audit.';
        return '';
    }

    function sourcePlanLedgerStatus(plan = {}, readiness = {}) {
        const warningCount = Array.isArray(plan.localCheck?.warnings) ? plan.localCheck.warnings.length : 0;
        if (plan.invalidatedAt) {
            return {
                label: 'invalidated',
                className: 'source-plan-ledger-invalidated',
                note: plan.invalidatedReason || 'Plan references source material that changed or was removed.'
            };
        }
        if (readiness.sourcePlan?.status === 'stale' || readiness.sourcePlan?.isStale || plan.isStale) {
            return {
                label: 'stale',
                className: 'source-plan-ledger-warning',
                note: 'Stage output changed after this source packet was recorded.'
            };
        }
        if (warningCount) {
            return {
                label: `${warningCount} warning${warningCount === 1 ? '' : 's'}`,
                className: 'source-plan-ledger-warning',
                note: (plan.localCheck?.warnings || []).map(w => w.message || w).filter(Boolean).slice(0, 2).join(' ')
            };
        }
        return {
            label: plan.lastUsedAt ? 'used' : 'cached',
            className: '',
            note: ''
        };
    }

    function renderHandoffRowsForInspector(knowledge = {}) {
        const handoffs = knowledge.stage_handoffs || {};
        const stageIds = new Set();
        Object.keys(handoffs).forEach(key => {
            const stageId = Number(String(key).replace('stage', ''));
            if (stageId) stageIds.add(stageId);
        });
        for (let stageId = 1; stageId <= 10; stageId++) {
            if (stageHasMemoryHandoffOutput(window.currentProjectData, stageId)) stageIds.add(stageId);
        }
        return Array.from(stageIds).sort((a, b) => a - b).map(stageId => {
            const key = `stage${stageId}`;
            const value = handoffs[key] || '';
            const summary = typeof value === 'string' ? value : (value?.summary || '');
            const updatedAt = typeof value === 'object' ? value?.at : '';
            const latest = latestVersionForStageUi(window.currentProjectData, stageId);
            const hasOutput = stageHasMemoryHandoffOutput(window.currentProjectData, stageId);
            const missing = hasOutput && !String(summary || '').trim();
            const stale = !!String(summary || '').trim()
                && !!latest?.approvedAt
                && (!updatedAt || new Date(updatedAt) < new Date(latest.approvedAt));
            const statusClass = missing ? 'missing' : (stale ? 'stale' : (summary ? 'current' : 'idle'));
            const statusLabel = missing ? 'Missing handoff' : (stale ? 'Stale handoff' : (summary ? 'Current handoff' : 'No output yet'));
            const note = missing
                ? 'Approved output exists for this stage, but no compact handoff has been saved for later assistants.'
                : stale
                    ? `Latest approval ${formatDateTimeForUi(latest.approvedAt)} is newer than this handoff${updatedAt ? ` (${formatDateTimeForUi(updatedAt)})` : ''}.`
                    : updatedAt
                        ? `Last updated ${formatDateTimeForUi(updatedAt)}.`
                        : 'Leave blank to keep this stage out of compact memory.';
            return `
                <div class="knowledge-handoff-row knowledge-handoff-${escapeHtml(statusClass)}">
                    <div class="knowledge-handoff-row-header">
                        <label>${escapeHtml(STAGE_LABELS[stageId] || `Stage ${stageId}`)}</label>
                        <span class="knowledge-handoff-status knowledge-handoff-status-${escapeHtml(statusClass)}">${escapeHtml(statusLabel)}</span>
                    </div>
                    <textarea class="modal-input knowledge-handoff-input" data-handoff-key="${escapeHtml(key)}" rows="3" placeholder="Add the compact handoff this stage should give later assistants.">${escapeHtml(summary)}</textarea>
                    <p class="knowledge-handoff-note">${escapeHtml(note)}</p>
                </div>
            `;
        }).join('');
    }

    function renderKnowledgeReview(knowledge = {}) {
        if (!knowledgeReviewPanel) return;
        const readiness = Array.isArray(knowledge.stage_source_readiness)
            ? knowledge.stage_source_readiness
            : [];
        const readinessByStage = new Map(readiness.map(item => [Number(item.stageId), item]));
        const sourcePlans = Object.entries(knowledge.stage_source_plans || {})
            .map(([key, plan]) => ({
                ...(plan || {}),
                stageId: Number(plan?.stageId || String(key).replace('stage', '')) || null,
                _cacheKey: key
            }))
            .filter(plan => plan && plan.stageId)
            .sort((a, b) => Number(a.stageId || 0) - Number(b.stageId || 0));
        const handoffRows = renderHandoffRowsForInspector(knowledge);
        const continuityText = (knowledge.continuity_watchlist || []).map(formatKnowledgeItemForUi).join('\n');
        const notesText = (knowledge.source_bible?.curated_notes || []).join('\n');
        const decisions = (knowledge.decision_log || []).slice(-6).reverse();
        const divergences = (knowledge.accepted_divergences || []).slice(-6).reverse();
        const audits = Object.entries(knowledge.stage_source_audits || {})
            .map(([key, audit]) => ({
                ...(audit || {}),
                stageId: Number(audit?.stageId || String(key).replace('stage', '')) || null,
                _cacheKey: key
            }))
            .filter(audit => audit && audit.stageId)
            .sort((a, b) => Number(a.stageId || 0) - Number(b.stageId || 0));
        const currentReadiness = sourceReadinessForStage(activeStageNum, { knowledge }) || {};
        const currentPlan = sourcePlanForStage(knowledge, activeStageNum);
        const currentAudit = sourceAuditForStage(knowledge, activeStageNum);
        const currentRefs = Array.isArray(currentPlan?.sourceReferences) ? currentPlan.sourceReferences.slice(0, 4) : [];
        const currentWarnings = Array.isArray(currentPlan?.localCheck?.warnings) ? currentPlan.localCheck.warnings.slice(0, 3) : [];
        const currentStageLabel = STAGE_LABELS[activeStageNum] || `Stage ${activeStageNum}`;
        const currentStageMessage = sourceReadinessInspectorMessage(currentReadiness, currentAudit, currentPlan);
        const currentAction = sourceCheckButtonForInspector(activeStageNum, currentReadiness, {
            force: !!(currentAudit?.invalidatedAt || currentPlan?.invalidatedAt)
        });

        knowledgeReviewPanel.innerHTML = `
            <div class="knowledge-panel-header">
                <strong>Project Memory Review</strong>
                <button type="button" class="secondary-btn" data-action="save-knowledge-review">Save Memory Edits</button>
            </div>
            <section class="knowledge-inspector-summary">
                <div>
                    <h4>Current Stage</h4>
                    <span class="source-readiness-pill source-readiness-${escapeHtml(currentReadiness.status || 'unknown')}">${escapeHtml(currentStageLabel)}: ${escapeHtml(currentReadiness.label || 'No source status')}</span>
                    <p>${escapeHtml(currentStageMessage)}</p>
                    ${currentAction}
                </div>
                <div>
                    <h4>Used Source Packet</h4>
                    ${currentPlan ? `
                        <p>${escapeHtml(currentPlan.lastUsedAt ? `Last used ${formatDateTimeForUi(currentPlan.lastUsedAt)}` : 'Plan recorded, not yet used.')}</p>
                        ${currentRefs.length ? `<ul>${currentRefs.map(ref => `<li>${escapeHtml(ref.name || ref.sourceId || 'Source')} ${ref.label ? `<span>${escapeHtml(ref.label)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="knowledge-empty">No specific source excerpts were selected.</p>'}
                        ${currentWarnings.length ? `<p class="source-plan-ledger-warning">${escapeHtml(currentWarnings.map(w => w.message || w).join(' '))}</p>` : ''}
                        ${currentPlan.invalidatedAt ? `<p class="source-plan-ledger-invalidated">${escapeHtml(currentPlan.invalidatedReason || 'This source packet was invalidated after source material changed.')}</p>` : ''}
                    ` : '<p class="knowledge-empty">No generation source packet has been recorded for this stage yet.</p>'}
                </div>
                <div>
                    <h4>Latest Audit Detail</h4>
                    ${currentAudit ? `
                        <p>${escapeHtml(formatCountLabel(currentAudit.issueCounts?.total || 0, 'open issue', 'open issues'))}</p>
                        ${currentAudit.invalidatedAt ? `<p class="source-plan-ledger-invalidated">${escapeHtml(currentAudit.invalidatedReason || 'This source audit was invalidated after source material changed.')}</p>` : ''}
                        ${renderMiniList([...(currentAudit.possible_source_mismatches || []), ...(currentAudit.missing_source_elements || []), ...(currentAudit.recommended_fixes || [])], 'No audit issues recorded.')}
                        ${currentAudit.invalidatedAt ? sourceCheckButtonForInspector(activeStageNum, currentReadiness, { force: true }) : ''}
                    ` : '<p class="knowledge-empty">No source audit detail saved for this stage.</p>'}
                </div>
            </section>
            <div class="knowledge-review-grid">
                <section>
                    <h4>Stage Handoffs</h4>
                    ${handoffRows || '<p class="knowledge-empty">No stage output or handoffs saved yet.</p>'}
                </section>
                <section>
                    <h4>Continuity Watchlist</h4>
                    <textarea class="modal-input" id="knowledgeContinuityEditor" rows="7" placeholder="One item per line">${escapeHtml(continuityText)}</textarea>
                    <h4>Project Source Notes</h4>
                    <textarea class="modal-input" id="knowledgeNotesEditor" rows="7" placeholder="One note per line">${escapeHtml(notesText)}</textarea>
                </section>
            </div>
            <div class="knowledge-readonly-grid">
                <section>
                    <h4>Recent Decisions</h4>
                    ${decisions.length ? `<ul>${decisions.map(item => `<li>${escapeHtml(formatKnowledgeItemForUi(item))}</li>`).join('')}</ul>` : '<p class="knowledge-empty">No decisions logged yet.</p>'}
                </section>
                <section>
                    <h4>Accepted Divergences</h4>
                    ${divergences.length ? `<ul>${divergences.map(item => `<li>${escapeHtml(formatKnowledgeItemForUi(item))}</li>`).join('')}</ul>` : '<p class="knowledge-empty">No accepted divergences yet.</p>'}
                </section>
            </div>
            <section class="source-readiness-ledger">
                <h4>Source Readiness</h4>
                ${readiness.length ? readiness.map(item => {
                    const checked = item.checkedAt ? new Date(item.checkedAt).toLocaleString() : 'Not checked';
                    const issues = item.issueCounts?.total || 0;
                    const planStatus = item.sourcePlan?.status ? item.sourcePlan.status.replace(/_/g, ' ') : 'no recorded plan';
                    const note = sourceReadinessLedgerNote(item);
                    const action = sourceCheckButtonForInspector(item.stageId, item);
                    return `
                        <div class="source-readiness-row">
                            <div>
                                <strong>${escapeHtml(item.stageName || `Stage ${item.stageId || ''}`)}</strong>
                                <span>${escapeHtml(checked)}</span>
                                ${note ? `<span class="source-ledger-note">${escapeHtml(note)}</span>` : ''}
                            </div>
                            <span class="source-readiness-pill source-readiness-${escapeHtml(item.status || 'unknown')}">${escapeHtml(item.label || item.status || 'Unknown')}</span>
                            <div>${escapeHtml(formatCountLabel(issues, 'issue', 'issues'))}</div>
                            <div>${escapeHtml(planStatus)}</div>
                            <div>${action || '<span class="source-ledger-muted">No action</span>'}</div>
                        </div>
                    `;
                }).join('') : '<p class="knowledge-empty">No source readiness data yet.</p>'}
            </section>
            <section class="source-audit-ledger">
                <h4>Source Audit Results</h4>
                ${audits.length ? audits.map(audit => {
                    const stageReadiness = readinessByStage.get(Number(audit.stageId)) || {};
                    const checked = audit.checkedAt ? new Date(audit.checkedAt).toLocaleString() : 'Not checked';
                    const issues = audit.issueCounts?.total || 0;
                    const references = Array.isArray(audit.sourceReferences) ? audit.sourceReferences.length : 0;
                    const invalidated = audit.invalidatedAt || stageReadiness.isAuditInvalidated;
                    const invalidatedLabel = audit.invalidatedAt ? `Invalidated ${formatDateTimeForUi(audit.invalidatedAt)}` : 'Invalidated';
                    return `
                        <details class="source-audit-ledger-item${invalidated ? ' source-audit-ledger-invalidated' : ''}">
                            <summary>
                                <strong>${escapeHtml(audit.stageName || `Stage ${audit.stageId || ''}`)}</strong>
                                <span>${escapeHtml(formatCountLabel(issues, 'issue', 'issues'))} · ${escapeHtml(formatCountLabel(references, 'reference', 'references'))} · ${escapeHtml(invalidated ? invalidatedLabel : checked)}</span>
                            </summary>
                            <div class="source-audit-ledger-body">
                                ${invalidated ? `<p class="source-ledger-note source-ledger-note-invalidated">${escapeHtml(audit.invalidatedReason || stageReadiness.auditInvalidatedReason || 'Audit needs refresh because source material changed.')}</p>` : ''}
                                ${invalidated ? sourceCheckButtonForInspector(audit.stageId, stageReadiness, { force: true }) : ''}
                                <label>Possible Mismatches</label>
                                ${renderMiniList(audit.possible_source_mismatches || [], 'No possible mismatches.')}
                                <label>Missing Source Elements</label>
                                ${renderMiniList(audit.missing_source_elements || [], 'No missing source elements.')}
                                <label>Recommended Fixes</label>
                                ${renderMiniList(audit.recommended_fixes || [], 'No recommended fixes.')}
                            </div>
                        </details>
                    `;
                }).join('') : '<p class="knowledge-empty">No source audits have been saved yet.</p>'}
            </section>
            <section class="source-plan-ledger">
                <h4>Source Plan Ledger</h4>
                ${sourcePlans.length ? sourcePlans.map(plan => {
                    const stageReadiness = readinessByStage.get(Number(plan.stageId)) || {};
                    const lastUsed = plan.lastUsedAt ? new Date(plan.lastUsedAt).toLocaleString() : 'Not used yet';
                    const sourceCount = Array.isArray(plan.sourceIds) ? plan.sourceIds.length : 0;
                    const status = sourcePlanLedgerStatus(plan, stageReadiness);
                    const refs = Array.isArray(plan.sourceReferences) ? plan.sourceReferences.slice(0, 3) : [];
                    const action = sourceCheckButtonForInspector(plan.stageId, stageReadiness, {
                        force: !!(plan.invalidatedAt || status.label === 'stale')
                    });
                    return `
                        <div class="source-plan-ledger-row${plan.invalidatedAt ? ' source-plan-ledger-row-invalidated' : ''}">
                            <div>
                                <strong>${escapeHtml(plan.stageName || `Stage ${plan.stageId || ''}`)}</strong>
                                <span>${escapeHtml(plan.profile || '')}</span>
                            </div>
                            <div>${escapeHtml(lastUsed)}</div>
                            <div>${escapeHtml(formatCountLabel(sourceCount, 'source', 'sources'))}</div>
                            <div class="${escapeHtml(status.className)}">
                                ${escapeHtml(status.label)}
                                ${refs.length ? `<span>${escapeHtml(refs.map(ref => ref.name || ref.sourceId || 'Source').join(', '))}</span>` : ''}
                                ${status.note ? `<span class="source-ledger-note">${escapeHtml(status.note)}</span>` : ''}
                            </div>
                            <div>${action || '<span class="source-ledger-muted">No action</span>'}</div>
                        </div>
                    `;
                }).join('') : '<p class="knowledge-empty">No source plans have been recorded by generation yet.</p>'}
            </section>
        `;
    }

    function formatKnowledgeItemForUi(item) {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        return item.summary || item.decision || item.note || item.text || JSON.stringify(item);
    }

    function formatDateTimeForUi(value) {
        return value ? new Date(value).toLocaleString() : '';
    }

    function formatSourceTypeLabel(type) {
        const option = SOURCE_TYPE_OPTIONS.find(([value]) => value === type);
        return option ? option[1] : 'Source Material';
    }

    function renderSourceTypeOptions(selectedType) {
        return SOURCE_TYPE_OPTIONS
            .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selectedType ? ' selected' : ''}>${escapeHtml(label)}</option>`)
            .join('');
    }

    function sourcePlanForStage(knowledge = {}, stageId = activeStageNum) {
        return knowledge.stage_source_plans?.[`stage${stageId}`] || null;
    }

    function sourceAuditForStage(knowledge = {}, stageId = activeStageNum) {
        return knowledge.stage_source_audits?.[`stage${stageId}`] || null;
    }

    function sourceAssetUrl(sourceId, assetKind, query = '') {
        const base = `/api/projects/${encodeURIComponent(activeProjectId)}/knowledge/sources/${encodeURIComponent(sourceId)}/assets/${encodeURIComponent(assetKind)}`;
        return query ? `${base}?${query}` : base;
    }

    async function readSourceAsset(sourceId, assetKind = 'extracted') {
        if (!activeProjectId || !sourceId || !sourceReaderPanel || !sourceReaderContent) return;
        sourceReaderPanel.classList.remove('hidden');
        if (sourceReaderTitle) sourceReaderTitle.textContent = 'Loading source...';
        if (sourceReaderMeta) sourceReaderMeta.textContent = '';
        sourceReaderContent.textContent = '';
        setSourceLibraryStatus('Loading source text...');

        try {
            const res = await fetch(sourceAssetUrl(sourceId, assetKind, 'format=json'));
            if (!res.ok) throw new Error(await responseErrorMessage(res, 'Source read failed'));
            const data = await res.json();
            const content = data.content || '';
            if (sourceReaderTitle) sourceReaderTitle.textContent = data.filename || 'Source text';
            if (sourceReaderMeta) {
                const label = data.assetKind === 'text' ? 'stored text' : 'extracted markdown';
                sourceReaderMeta.textContent = `${formatCountLabel(data.charCount || content.length, 'char', 'chars')} - ${label}`;
            }
            sourceReaderContent.textContent = content || 'No readable text was found for this source.';
            setSourceLibraryStatus('');
            sourceReaderPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
            if (sourceReaderTitle) sourceReaderTitle.textContent = 'Source unavailable';
            sourceReaderContent.textContent = err.message;
            setSourceLibraryStatus('Source read failed: ' + err.message, true);
        }
    }

    async function openOriginalSourceAsset(sourceId) {
        if (!activeProjectId || !sourceId) return;
        const openedWindow = window.open('about:blank', '_blank');
        if (openedWindow) {
            openedWindow.opener = null;
            openedWindow.document.title = 'Opening source...';
            openedWindow.document.body.textContent = 'Opening original source...';
        }
        setSourceLibraryStatus('Opening original source...');
        try {
            const res = await fetch(sourceAssetUrl(sourceId, 'original'));
            if (!res.ok) throw new Error(await responseErrorMessage(res, 'Original source unavailable'));
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            if (openedWindow) {
                openedWindow.location.href = objectUrl;
            } else {
                const link = document.createElement('a');
                link.href = objectUrl;
                link.target = '_blank';
                link.rel = 'noopener';
                link.click();
            }
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
            setSourceLibraryStatus('');
        } catch (err) {
            if (openedWindow) openedWindow.close();
            setSourceLibraryStatus('Original source open failed: ' + err.message, true);
        }
    }

    function renderMiniList(items = [], emptyText = 'None recorded.') {
        const list = items.map(formatKnowledgeItemForUi).filter(Boolean).slice(0, 5);
        return list.length
            ? `<ul>${list.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
            : `<p class="knowledge-empty">${escapeHtml(emptyText)}</p>`;
    }

    function renderSourceLibrary(knowledge = {}) {
        const sources = knowledge.source_registry || [];
        if (sourceLibraryMeta) {
            const readiness = sourceReadinessForStage(activeStageNum, { knowledge });
            const stageLabel = STAGE_LABELS[activeStageNum] || `Stage ${activeStageNum}`;
            sourceLibraryMeta.textContent = `${formatCountLabel(sources.length, 'source', 'sources')} saved · ${stageLabel}: ${readiness?.label || 'no source status'}`;
        }
        renderSourceBiblePanel(knowledge.source_bible || {});
        renderKnowledgeSnapshot(knowledge.memory_snapshot || {});
        renderKnowledgeReview(knowledge);
        if (!sourceLibraryList) return;
        if (!sources.length) {
            sourceReaderPanel?.classList.add('hidden');
            sourceLibraryList.innerHTML = '<div class="source-library-empty">No saved source documents yet.</div>';
            return;
        }
        sourceLibraryList.innerHTML = sources.map(source => {
            const tags = (source.tags || []).slice(0, 5).map(tag => `<span>${escapeHtml(tag)}</span>`).join('');
            const uploaded = source.uploadedAt ? new Date(source.uploadedAt).toLocaleString() : '';
            const updated = source.updatedAt ? ` - updated ${escapeHtml(new Date(source.updatedAt).toLocaleString())}` : '';
            const storage = source.storage === 'chunks'
                ? `${formatCountLabel(source.chunkCount || 0, 'chunk', 'chunks')}${source.truncated ? ', truncated' : ''}`
                : source.storage || 'summary';
            const assetSummary = source.extractedMarkdown?.path
                ? ' - extracted .md saved'
                : '';
            const referenced = source.stagesReferenced?.length
                ? ` - used in stages ${source.stagesReferenced.join(', ')}`
                : '';
            const readKind = source.extractedMarkdown?.path ? 'extracted' : 'text';
            const readLabel = source.extractedMarkdown?.path ? 'Read Extracted Markdown' : 'Read Stored Text';
            const originalButton = source.originalFile?.path
                ? `<button class="secondary-btn source-library-open-original" data-source-id="${escapeHtml(source.id)}" type="button">Open Original</button>`
                : '';
            return `
                <article class="source-library-item">
                    <div class="source-library-item-header">
                        <div class="source-library-item-main">
                            <div class="source-library-item-title">${escapeHtml(source.name || 'Untitled source')}</div>
                            <div class="source-library-item-meta">${escapeHtml(formatSourceTypeLabel(source.type || 'source_material'))} - ${escapeHtml(formatCountLabel(source.charCount || 0, 'char', 'chars'))} - ${escapeHtml(storage)}${escapeHtml(assetSummary)}${uploaded ? ` - ${escapeHtml(uploaded)}` : ''}${updated}${escapeHtml(referenced)}</div>
                        </div>
                        <button class="source-library-delete" data-source-id="${escapeHtml(source.id)}" type="button">Delete</button>
                    </div>
                    ${source.summary ? `<p class="source-library-preview"><strong>Preview</strong>${escapeHtml(source.summary)}</p>` : ''}
                    <div class="source-library-file-actions">
                        <button class="primary-btn source-library-read" data-source-id="${escapeHtml(source.id)}" data-asset-kind="${escapeHtml(readKind)}" type="button">${escapeHtml(readLabel)}</button>
                        ${originalButton}
                    </div>
                    <div class="source-library-item-main">
                        ${source.sourceNote ? `<p class="source-library-note">${escapeHtml(source.sourceNote)}</p>` : ''}
                        ${tags ? `<div class="source-library-tags">${tags}</div>` : ''}
                        <div class="source-library-controls">
                            <select class="source-library-type" data-source-id="${escapeHtml(source.id)}" aria-label="Source type">
                                ${renderSourceTypeOptions(source.type || 'source_material')}
                            </select>
                            <input class="source-library-tag-input" data-source-id="${escapeHtml(source.id)}" value="${escapeHtml((source.tags || []).join(', '))}" aria-label="Source tags" placeholder="tags">
                            <button class="secondary-btn source-library-update" data-source-id="${escapeHtml(source.id)}" type="button">Update</button>
                        </div>
                    </div>
                </article>
            `;
        }).join('');
    }

    async function loadSourceLibrary() {
        if (!activeProjectId) return;
        setSourceLibraryStatus('Loading...');
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge`);
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            renderSourceLibrary(data.knowledge);
            await loadKnowledgeDiagnostics();
            setSourceLibraryStatus('');
        } catch (err) {
            setSourceLibraryStatus('Knowledge load failed: ' + err.message, true);
        }
    }

    async function openSourceLibrary() {
        if (!activeProjectId) return;
        sourceLibraryModal?.classList.remove('hidden');
        await loadSourceLibrary();
    }

    async function rebuildSourceBible() {
        if (!activeProjectId || !btnRebuildSourceBible) return;
        btnRebuildSourceBible.disabled = true;
        const originalText = btnRebuildSourceBible.textContent;
        btnRebuildSourceBible.textContent = 'Rebuilding...';
        setSourceLibraryStatus('Reading saved sources...');
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/rebuild-source-bible`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            renderSourceLibrary(data.knowledge);
            await loadKnowledgeDiagnostics();
            setSourceLibraryStatus('Source bible rebuilt.');
        } catch (err) {
            setSourceLibraryStatus('Rebuild failed: ' + err.message, true);
        } finally {
            btnRebuildSourceBible.disabled = false;
            btnRebuildSourceBible.textContent = originalText;
        }
    }

    async function compactProjectMemory() {
        if (!activeProjectId || !btnCompactMemory) return;
        const originalText = btnCompactMemory.textContent;
        btnCompactMemory.disabled = true;
        btnCompactMemory.textContent = 'Compacting...';
        setSourceLibraryStatus('Compacting project memory...');
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/compact`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            renderSourceLibrary(data.knowledge);
            renderKnowledgeDiagnostics(data.diagnostics || {});
            setSourceLibraryStatus('Project memory compacted.');
        } catch (err) {
            setSourceLibraryStatus('Memory compaction failed: ' + err.message, true);
        } finally {
            btnCompactMemory.disabled = false;
            btnCompactMemory.textContent = originalText;
        }
    }

    async function uploadSourceToKnowledge(event) {
        event?.preventDefault();
        if (!activeProjectId || !sourceKnowledgeUpload || !btnUploadSource) return;
        const file = sourceKnowledgeUpload.files?.[0];
        if (!file) {
            setSourceLibraryStatus('Choose a source file first.', true);
            return;
        }

        const originalText = btnUploadSource.textContent;
        btnUploadSource.disabled = true;
        btnUploadSource.textContent = 'Adding...';
        setSourceLibraryStatus('Extracting source text...');
        try {
            const form = new FormData();
            form.append('sourceFile', file);
            form.append('sourceNote', sourceUploadNote?.value || '');
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/sources`, {
                method: 'POST',
                body: form
            });
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            sourceUploadForm?.reset();
            renderSourceLibrary(data.knowledge);
            await loadKnowledgeDiagnostics();
            const saved = data.savedSource;
            setSourceLibraryStatus(saved?.duplicate ? 'Source already existed; reference refreshed.' : 'Source added to project knowledge.');
        } catch (err) {
            setSourceLibraryStatus('Source upload failed: ' + err.message, true);
        } finally {
            btnUploadSource.disabled = false;
            btnUploadSource.textContent = originalText;
        }
    }

    async function deleteSource(sourceId) {
        if (!activeProjectId || !sourceId) return;
        setSourceLibraryStatus('Deleting source...');
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/sources/${encodeURIComponent(sourceId)}`, {
                method: 'DELETE'
            });
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            renderSourceLibrary(data.knowledge);
            await loadKnowledgeDiagnostics();
            setSourceLibraryStatus('Source deleted.');
        } catch (err) {
            setSourceLibraryStatus('Delete failed: ' + err.message, true);
        }
    }

    async function updateSourceMetadata(sourceId) {
        if (!activeProjectId || !sourceId) return;
        const safeSourceId = String(sourceId).replace(/[^a-zA-Z0-9_]/g, '');
        const type = document.querySelector(`.source-library-type[data-source-id="${safeSourceId}"]`)?.value || 'source_material';
        const tags = (document.querySelector(`.source-library-tag-input[data-source-id="${safeSourceId}"]`)?.value || '')
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);

        setSourceLibraryStatus('Updating source metadata...');
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/sources/${encodeURIComponent(sourceId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, tags })
            });
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            renderSourceLibrary(data.knowledge);
            renderKnowledgeDiagnostics(data.diagnostics || {});
            setSourceLibraryStatus('Source metadata updated.');
        } catch (err) {
            setSourceLibraryStatus('Source update failed: ' + err.message, true);
        }
    }

    async function loadKnowledgeDiagnostics() {
        if (!activeProjectId || !knowledgeDiagnosticsPanel) return;
        knowledgeDiagnosticsPanel.innerHTML = '<p class="knowledge-empty">Inspecting project memory...</p>';
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/diagnostics`);
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            renderKnowledgeDiagnostics(data.diagnostics || {});
        } catch (err) {
            knowledgeDiagnosticsPanel.innerHTML = `<p class="source-library-status-error">Diagnostics failed: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function saveKnowledgeReview(button) {
        if (!activeProjectId) return;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Saving...';
        const linesFrom = (selector) => (document.querySelector(selector)?.value || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
        const stage_handoffs = {};
        document.querySelectorAll('.knowledge-handoff-input').forEach(input => {
            stage_handoffs[input.dataset.handoffKey] = input.value.trim();
        });
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/review`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stage_handoffs,
                    continuity_watchlist: linesFrom('#knowledgeContinuityEditor'),
                    curated_notes: linesFrom('#knowledgeNotesEditor')
                })
            });
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            renderSourceLibrary(data.knowledge);
            renderKnowledgeDiagnostics(data.diagnostics || {});
            setSourceLibraryStatus('Project memory updated.');
        } catch (err) {
            setSourceLibraryStatus('Memory update failed: ' + err.message, true);
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    // =============================================
    // === Stage 4: Beats Logic ===
    // =============================================

    // PDF Upload listener for Stage 4
    if (stage4PdfUpload) {
        stage4PdfUpload.addEventListener('change', () => {
            if (stage4PdfUpload.files[0]) {
                if (stage4FileNameDisplay) stage4FileNameDisplay.textContent = stage4PdfUpload.files[0].name;
            } else {
                if (stage4FileNameDisplay) stage4FileNameDisplay.textContent = '';
            }
        });
    }

    // Renders the beat sheet data into the UI
    function renderTreatment(treatmentData) {
        if (!treatmentContainer) return;
        treatmentContainer.innerHTML = '';

        // STC Genre Category label
        if (treatmentData.stc_genre_category) {
            const genreLabel = document.createElement('div');
            genreLabel.style.cssText = 'background: linear-gradient(135deg, #2563eb, #3b82f6); color: white; font-weight: 700; font-size: 0.85rem; padding: 6px 16px; border-radius: 20px; display: inline-block; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;';
            genreLabel.textContent = `STC Genre: ${treatmentData.stc_genre_category}`;
            treatmentContainer.appendChild(genreLabel);
        }

        if (!treatmentData.hybrid_beat_sheet) return;

        treatmentData.hybrid_beat_sheet.forEach(sequence => {
            // Sequence header
            const seqHeader = document.createElement('h3');
            seqHeader.style.cssText = 'color: #e5e7eb; font-size: 1.1rem; font-weight: 700; margin-top: 16px; border-bottom: 1px solid #374151; padding-bottom: 8px;';
            // Strip any accidental "Sequence N:" prefix from the title
            const cleanTitle = (sequence.sequence_title || '').replace(/^Sequence\s*\d+\s*:\s*/i, '');
            seqHeader.textContent = `Sequence ${sequence.sequence_number}: ${cleanTitle}`;
            treatmentContainer.appendChild(seqHeader);

            if (!sequence.beats) return;

            sequence.beats.forEach(beat => {
                const card = document.createElement('div');
                card.className = 'treatment-beat-card';
                card.style.cssText = 'background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 20px; margin-top: 12px;';

                // Beat name header
                const beatName = document.createElement('h4');
                beatName.style.cssText = 'color: #93c5fd; font-weight: 700; font-size: 1rem; margin-bottom: 12px;';
                beatName.textContent = beat.beat_name || '';
                card.appendChild(beatName);

                const renderField = (parent, f) => {
                    const label = document.createElement('label');
                    label.className = 'text-gray-400 block mb-1 text-xs font-semibold tracking-wider uppercase';
                    label.style.cssText = 'color: #9ca3af; display: block; margin-bottom: 4px; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding-top: 12px;';
                    label.textContent = f.label;
                    parent.appendChild(label);

                    const ta = document.createElement('textarea');
                    ta.className = 'w-full bg-transparent border-none resize-none overflow-hidden text-gray-300 editable-treatment-field';
                    ta.setAttribute('data-field', f.key);
                    ta.value = f.value || '';
                    ta.style.cssText = 'width: 100%; background: transparent; border: none; resize: none; overflow: hidden; color: #d1d5db; font-family: inherit; font-size: 0.9rem; line-height: 1.6; padding: 4px 0; min-height: 24px;';
                    ta.addEventListener('input', () => {
                        autoResize(ta);
                        if (btnStage4Approve) {
                            btnStage4Approve.textContent = 'Approve';
                            btnStage4Approve.classList.remove('approve-btn-green');
                        }
                    });
                    ta.addEventListener('focus', () => { ta.style.background = 'rgba(31,41,55,0.8)'; ta.style.outline = '1px solid #374151'; });
                    ta.addEventListener('blur', () => { ta.style.background = 'transparent'; ta.style.outline = 'none'; });
                    parent.appendChild(ta);
                };

                renderField(card, { label: 'DETAILED ACTION', key: 'detailed_action', value: beat.detailed_action });

                // Toggle button for annotation fields
                const notesToggle = document.createElement('button');
                notesToggle.textContent = 'Show Notes ▾';
                notesToggle.style.cssText = 'font-size:0.75rem; color:#60a5fa; background:none; border:none; cursor:pointer; padding:4px 0; margin-top:8px; display:block;';
                card.appendChild(notesToggle);

                // Collapsible annotation fields
                const notesWrap = document.createElement('div');
                notesWrap.className = 'hidden';
                [
                    { label: 'GENRE VARIATION NOTES', key: 'genre_variation_notes', value: beat.genre_variation_notes },
                    { label: 'EMOTIONAL ARC', key: 'emotional_arc', value: beat.emotional_arc },
                    { label: 'PACING NOTES', key: 'pacing_notes', value: beat.pacing_notes }
                ].forEach(f => renderField(notesWrap, f));
                card.appendChild(notesWrap);

                notesToggle.addEventListener('click', () => {
                    const hidden = notesWrap.classList.toggle('hidden');
                    notesToggle.textContent = hidden ? 'Show Notes ▾' : 'Hide Notes ▴';
                    if (!hidden) notesWrap.querySelectorAll('textarea').forEach(ta => autoResize(ta));
                });

                treatmentContainer.appendChild(card);
            });
        });

        treatmentContainer.classList.remove('hidden');
        if (treatmentActions) treatmentActions.classList.add('hidden');
        if (stage4Workshop) stage4Workshop.classList.remove('hidden');

        // Show Submit/Approve, hide Revise
        if (btnStage4Revise) btnStage4Revise.classList.remove('hidden');
        if (btnStage4Approve) {
            btnStage4Approve.classList.remove('hidden');
            btnStage4Approve.textContent = 'Approve';
            btnStage4Approve.classList.remove('approve-btn-green');
            btnStage4Approve.disabled = false;
        }
        if (btnStage4Edit) btnStage4Edit.classList.add('hidden');

        // Auto-resize all beat sheet textareas AFTER container is visible
        // Use setTimeout to ensure the browser has painted and computed layout
        setTimeout(() => {
            treatmentContainer.querySelectorAll('.editable-treatment-field').forEach(ta => autoResize(ta));
        }, 50);
    }

    // Scrape beat sheet data from the DOM
    function scrapeTreatment() {
        if (!treatmentContainer) return null;

        const genreLabel = treatmentContainer.querySelector('div');
        const stcGenre = genreLabel ? genreLabel.textContent.replace('STC Genre: ', '') : '';

        const sequenceHeaders = treatmentContainer.querySelectorAll('h3');
        const beatCards = treatmentContainer.querySelectorAll('.treatment-beat-card');

        // Group cards by their preceding sequence header
        const sequences = [];
        let currentSeqIdx = -1;

        treatmentContainer.childNodes.forEach(child => {
            if (child.tagName === 'H3') {
                currentSeqIdx++;
                const text = child.textContent;
                const numMatch = text.match(/Sequence (\d+):\s*(.*)/);
                sequences.push({
                    sequence_number: numMatch ? parseInt(numMatch[1]) : currentSeqIdx + 1,
                    sequence_title: numMatch ? numMatch[2] : text,
                    beats: []
                });
            } else if (child.classList && child.classList.contains('treatment-beat-card') && currentSeqIdx >= 0) {
                const beatName = child.querySelector('h4')?.textContent || '';
                const fieldAreas = child.querySelectorAll('.editable-treatment-field');
                const beat = { beat_name: beatName };
                fieldAreas.forEach(ta => {
                    beat[ta.getAttribute('data-field')] = ta.value;
                });
                sequences[currentSeqIdx].beats.push(beat);
            }
        });

        return {
            stc_genre_category: stcGenre,
            hybrid_beat_sheet: sequences
        };
    }

    // Auto-generate beat sheet from Stages 1-3
    async function autoGenerateTreatment() {
        if (!activeProjectId) return;

        if (btnStage4Approve) {
            btnStage4Approve.textContent = 'Approve';
            btnStage4Approve.classList.remove('approve-btn-green');
            btnStage4Approve.classList.add('hidden');
        }

        if (loadingStateTreatment) loadingStateTreatment.classList.remove('hidden');

        // Kill the workshop bar during generation
        if (stage4Workshop) stage4Workshop.classList.add('hidden');

        if (treatmentContainer) {
            treatmentContainer.innerHTML = '';
            treatmentContainer.classList.add('hidden');
        }
        if (treatmentActions) treatmentActions.classList.add('hidden');

        if (loadingTextTreatment) loadingTextTreatment.textContent = 'Generating 15-Beat Sheet...';

        try {
            const formData = new FormData();
            formData.append('projectId', activeProjectId);

            const response = await fetch('/api/generate-stage4-beats', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}`);
            }

            // Read SSE stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const event = JSON.parse(line.slice(6));

                    if (event.type === 'progress') {
                        if (loadingTextTreatment) loadingTextTreatment.textContent = event.label;
                    } else if (event.type === 'complete') {
                        renderTreatment(event.result);
                        if (window.currentProjectData) window.currentProjectData.stage4_beats = event.result;
                        const projRes = await fetch(`/api/projects/${activeProjectId}`);
                        const projData = await projRes.json();
                        if (window.currentProjectData) window.currentProjectData.conversations = projData.data?.conversations || {};
                        updateStageNav(projData.data);
                        resetStageChatForNewArtifact(4, 'Beat sheet regenerated. Previous Stage 4 chat was cleared because it may refer to an older beat sheet.');
                        await handleSourceGenerationResult(4, event);
                    } else if (event.type === 'error') {
                        throw new Error(event.message);
                    }
                }
            }
        } catch (err) {
            console.error('Error generating beats:', err);
            alert('An error occurred while generating the beat sheet. You can retry with the Generate Beats button.');
            if (treatmentActions) treatmentActions.classList.remove('hidden');
        } finally {
            if (loadingStateTreatment) loadingStateTreatment.classList.add('hidden');
        }
    }

    // Generate Beats button click handler
    if (generateTreatmentBtn) {
        generateTreatmentBtn.addEventListener('click', () => {
            autoGenerateTreatment();
        });
    }

    // Toggle Stage 4 Edit Mode
    function toggleStage4EditMode(locked) {
        const fields = treatmentContainer ? treatmentContainer.querySelectorAll('.editable-treatment-field') : [];
        fields.forEach(f => {
            f.readOnly = locked;
            f.style.opacity = locked ? '0.85' : '1';
        });

        if (locked) {
            if (btnStage4Edit) btnStage4Edit.classList.remove('hidden');
            if (btnStage4Revise) btnStage4Revise.classList.add('hidden');
        } else {
            if (btnStage4Edit) btnStage4Edit.classList.add('hidden');
            if (btnStage4Revise) btnStage4Revise.classList.remove('hidden');
            if (btnStage4Approve) {
                btnStage4Approve.classList.remove('hidden');
                btnStage4Approve.textContent = 'Approve';
                btnStage4Approve.classList.remove('approve-btn-green');
                btnStage4Approve.disabled = false;
            }
        }
    }

    // Stage 4 Edit button
    if (btnStage4Edit) {
        btnStage4Edit.addEventListener('click', () => {
            toggleStage4EditMode(false);
        });
    }

    // Stage 4 Revise (Submit) button
    if (btnStage4Revise) {
        btnStage4Revise.addEventListener('click', async () => {
            const userNote = stage4Notes ? stage4Notes.value.trim() : '';
            const selectedPdf = stage4PdfUpload && stage4PdfUpload.files[0];

            if (!userNote && !selectedPdf) {
                // Manual save
                if (!activeProjectId) return;
                const currentS4Beats = scrapeTreatment();
                const originalText = btnStage4Revise.textContent;

                try {
                    btnStage4Revise.textContent = 'Saving...';
                    btnStage4Revise.disabled = true;

                    await fetch(`/api/projects/${activeProjectId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            data: { stage4_beats: currentS4Beats }
                        })
                    });

                    btnStage4Revise.textContent = 'Saved!';
                    setTimeout(() => {
                        btnStage4Revise.textContent = originalText;
                        btnStage4Revise.disabled = false;
                    }, 1500);

                    if (btnStage4Approve) {
                        btnStage4Approve.textContent = 'Approve';
                        btnStage4Approve.classList.remove('approve-btn-green');
                    }
                } catch (err) {
                    console.error('Failed to manual save beats:', err);
                    alert('An error occurred while saving.');
                    btnStage4Revise.textContent = originalText;
                    btnStage4Revise.disabled = false;
                }
                return;
            }

            // AI Revision
            const originalText = btnStage4Revise.textContent;
            btnStage4Revise.textContent = 'Revising...';
            btnStage4Revise.disabled = true;

            try {
                const currentS4Beats = scrapeTreatment();
                const formData = new FormData();
                formData.append('projectId', activeProjectId);
                formData.append('currentBeats', JSON.stringify(currentS4Beats));
                formData.append('notes', userNote);
                if (selectedPdf) {
                    formData.append('pdfFile', selectedPdf);
                }

                const response = await fetch('/api/generate-stage4-beats', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    throw new Error(`Server responded with ${response.status}`);
                }

                // Read SSE stream
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const event = JSON.parse(line.slice(6));

                        if (event.type === 'progress') {
                            btnStage4Revise.textContent = event.label;
                        } else if (event.type === 'complete') {
                            renderTreatment(event.result);
                            if (window.currentProjectData) window.currentProjectData.stage4_beats = event.result;
                            if (stage4Notes) stage4Notes.value = '';
                            if (stage4PdfUpload) stage4PdfUpload.value = '';
                            if (stage4FileNameDisplay) stage4FileNameDisplay.textContent = '';
                            if (btnStage4Approve) {
                                btnStage4Approve.textContent = 'Approve';
                                btnStage4Approve.classList.remove('approve-btn-green');
                            }
                            await handleSourceGenerationResult(4, event);
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        }
                    }
                }
            } catch (err) {
                console.error('Error revising beats:', err);
                alert('An error occurred while revising the beat sheet.');
            } finally {
                btnStage4Revise.textContent = originalText;
                btnStage4Revise.disabled = false;
            }
        });
    }

    // Stage 4 Approve button
    if (btnStage4Approve) {
        btnStage4Approve.addEventListener('click', async () => {
            if (!activeProjectId) return;
            if (!(await runApprovalSourceGuard(4, btnStage4Approve))) return;

            const currentS4Beats = scrapeTreatment();
            const originalText = btnStage4Approve.textContent;

            const existingHistory = (window.currentProjectData?.versionHistory) || [];
            const isReApproval = existingHistory.filter(v => v.stage === 4).length > 0;

            btnStage4Approve.textContent = 'Saving...';
            btnStage4Approve.disabled = true;
            btnStage4Approve.classList.remove('approve-btn-green');

            const versionHistory4 = captureVersionSnapshot(4, 'stage4_beats', 'Beats', currentS4Beats);

            try {
                const putBody = {
                    data: { stage4_beats: currentS4Beats, versionHistory: versionHistory4 }
                };
                if (isReApproval) putBody.stampRevisedStage = 'stage4_beats';

                const res = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(putBody)
                });
                const updatedProject = await res.json();
                await offerStageMemoryCuration(4);
                updateStageNav(updatedProject.data);

                btnStage4Approve.textContent = 'Approved ✓';
                btnStage4Approve.classList.add('approve-btn-green');
                btnStage4Approve.disabled = true;

                if (btnStage4Edit) btnStage4Edit.classList.remove('hidden');
                if (btnStage4Revise) btnStage4Revise.classList.add('hidden');

                if (isReApproval) {
                    showGenericRegenModal('Beats', 'Stage 5 Treatment',
                        () => { switchStage(5); autoGenerateTreatmentStage5(); },
                        () => { switchStage(5); }
                    );
                } else {
                    switchStage(5);
                    autoGenerateTreatmentStage5();
                }
            } catch (err) {
                console.error(err);
                alert('Error saving approved treatment.');
                btnStage4Approve.textContent = originalText;
                btnStage4Approve.disabled = false;
            }
        });
    }

    // --- Stage 5: Treatment Functions ---

    function stripTreatmentRevisionArtifacts(value) {
        return String(value || '')
            .replace(/<<<\s*TREATMENT_SECTION\s*/gi, '')
            .replace(/^\s*TREATMENT_SECTION\s*$/gim, '')
            .replace(/^\s*<\/?pageone_current_treatment_section>\s*$/gim, '')
            .trim();
    }

    function isInvalidTreatmentMetadata(value) {
        const cleaned = stripTreatmentRevisionArtifacts(value);
        if (!cleaned) return true;
        const compact = cleaned.replace(/[\s_-]+/g, '').toLowerCase();
        return compact === 'treatmentsection' || compact === 'pageonecurrenttreatmentsection';
    }

    function buildTreatmentMetadataFallback() {
        const pitch = window.currentProjectData?.stage1_pitch?.pitch || {};
        const characters = window.currentProjectData?.stage3_characters?.characters || [];
        const lines = [];
        if (pitch.title) lines.push(`TITLE: ${pitch.title}`);
        if (pitch.genre) lines.push(`GENRE: ${pitch.genre}`);
        if (pitch.logline) lines.push(`LOGLINE: ${pitch.logline}`);
        if (pitch.core_theme) lines.push(`CORE THEME: ${pitch.core_theme}`);
        if (Array.isArray(characters) && characters.length) {
            lines.push('CHARACTERS:');
            characters.forEach(character => {
                const name = character.name || 'Unnamed Character';
                const summary = character.brief_summary || character.role || '';
                lines.push(summary ? `${name}: ${summary}` : name);
            });
        }
        return lines.join('\n');
    }

    function cleanTreatmentStage5Value(key, value) {
        const cleaned = stripTreatmentRevisionArtifacts(value);
        if (key === 'title_logline_characters' && isInvalidTreatmentMetadata(cleaned)) {
            return buildTreatmentMetadataFallback() || cleaned;
        }
        return cleaned;
    }

    function renderTreatmentStage5(data) {
        if (!data) return;
        if (stage5TreatmentContainer) stage5TreatmentContainer.classList.remove('hidden');
        if (stage5Workshop) stage5Workshop.classList.remove('hidden');
        if (stage5Actions) stage5Actions.classList.add('hidden');

        Object.keys(stage5TAs).forEach(key => {
            if (stage5TAs[key]) {
                const ta = stage5TAs[key];
                ta.value = cleanTreatmentStage5Value(key, data[key] || '').replace(/\[SEQUENCE \d+ (?:START|END)\]\n?/gi, '');
                
                // Fixed-height scrollable cards for treatment text
                ta.className = "editable-field w-full p-6 rounded-xl bg-[#1f2937] text-gray-300 text-sm leading-relaxed border-none focus:ring-0 focus:outline-none resize-y overflow-y-auto treatment-stage5-ta";
                const isTitleField = (key === 'title_logline_characters');
                ta.style.minHeight = isTitleField ? '120px' : '400px';
                ta.style.maxHeight = isTitleField ? '300px' : '800px';
                ta.style.overflowY = 'auto';

                // Add input listeners for user edits
                if (!ta.dataset.listenerAdded) {
                    ta.addEventListener('input', () => {
                        if (btnStage5Approve) {
                            btnStage5Approve.textContent = 'Approve';
                            btnStage5Approve.classList.remove('approve-btn-green');
                        }
                    });
                    ta.addEventListener('focus', () => {
                        ta.style.background = '#374151'; // Slightly lighter on focus (gray-700)
                    });
                    ta.addEventListener('blur', () => {
                        ta.style.background = '#1f2937'; // Reset to explicitly set dark card background (gray-800)
                    });
                    ta.dataset.listenerAdded = 'true';
                }
            }
        });
    }

    function scrapeTreatmentStage5() {
        const data = {};
        Object.keys(stage5TAs).forEach(key => {
            if (stage5TAs[key]) {
                data[key] = stage5TAs[key].value.trim();
            }
        });
        if (stage5Notes) data.notes = stage5Notes.value.trim();
        return data;
    }

    async function autoGenerateTreatmentStage5() {
        if (!activeProjectId) return;

        if (btnStage5Approve) {
            btnStage5Approve.textContent = 'Approve';
            btnStage5Approve.classList.remove('approve-btn-green');
            btnStage5Approve.classList.add('hidden');
        }

        // Clear Stage 5 content
        if (loadingStateStage5) loadingStateStage5.classList.remove('hidden');
        if (stage5Actions) stage5Actions.classList.add('hidden');
        if (stage5TreatmentContainer) stage5TreatmentContainer.classList.add('hidden');
        if (stage5Workshop) stage5Workshop.classList.add('hidden');
        Object.values(stage5TAs).forEach(ta => { if (ta) ta.value = ''; });

        // Clear Stage 6 — it is now stale since Stage 5 is being regenerated
        if (stage6Board) stage6Board.innerHTML = '';
        if (stage6Workshop) stage6Workshop.classList.add('hidden');

        if (loadingTextStage5) loadingTextStage5.textContent = 'Writing Act I...';

        try {
            const formData = new FormData();
            formData.append('projectId', activeProjectId);

            const response = await fetch('/api/generate-stage5-treatment', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}`);
            }

            // Read SSE stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const event = JSON.parse(line.slice(6));

                    if (event.type === 'progress') {
                        if (loadingTextStage5) loadingTextStage5.textContent = `Step ${event.step} of ${event.total}: ${event.label}`;
                    } else if (event.type === 'complete') {
                        renderTreatmentStage5(event.result);
                        if (window.currentProjectData) window.currentProjectData.stage5_treatment = event.result;
                        // Reset buttons to fresh "Submit + Approve" state, overriding any
                        // stale locked state left over from project hydration.
                        if (btnStage5Edit) btnStage5Edit.classList.add('hidden');
                        if (btnStage5Revise) btnStage5Revise.classList.remove('hidden');
                        if (btnStage5Approve) {
                            btnStage5Approve.classList.remove('hidden');
                            btnStage5Approve.textContent = 'Approve';
                            btnStage5Approve.classList.remove('approve-btn-green');
                            btnStage5Approve.disabled = false;
                        }
                        // Fetch updated project for nav status
                        const projRes = await fetch(`/api/projects/${activeProjectId}`);
                        const projData = await projRes.json();
                        updateStageNav(projData.data);
                        await handleSourceGenerationResult(5, event);
                    } else if (event.type === 'error') {
                        throw new Error(event.message);
                    }
                }
            }
        } catch (err) {
            console.error('Error generating stage 5 treatment:', err);
            alert('An error occurred during Treatment generation.');
            if (stage5Actions) stage5Actions.classList.remove('hidden');
        } finally {
            if (loadingStateStage5) loadingStateStage5.classList.add('hidden');
        }
    }

    // Stage 5 Event Listeners
    if (btnGenerateStage5) {
        btnGenerateStage5.addEventListener('click', autoGenerateTreatmentStage5);
    }

    if (stage5PdfUpload) {
        stage5PdfUpload.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                if (stage5FileNameDisplay) stage5FileNameDisplay.textContent = e.target.files[0].name;
            }
        });
    }

    if (stage6PdfUpload) {
        stage6PdfUpload.addEventListener('change', (e) => {
            if (stage6FileNameDisplay) stage6FileNameDisplay.textContent = e.target.files[0] ? e.target.files[0].name : '';
        });
    }

    if (btnStage5Edit) {
        btnStage5Edit.addEventListener('click', () => {
            if (btnStage5Revise) btnStage5Revise.classList.remove('hidden');
            if (btnStage5Approve) {
                btnStage5Approve.classList.remove('hidden');
                btnStage5Approve.textContent = 'Approve';
                btnStage5Approve.classList.remove('approve-btn-green');
                btnStage5Approve.disabled = false;
            }
            btnStage5Edit.classList.add('hidden');
        });
    }

    if (btnStage5Revise) {
        btnStage5Revise.addEventListener('click', async () => {
            const userNote = stage5Notes ? stage5Notes.value.trim() : '';
            const selectedPdf = stage5PdfUpload && stage5PdfUpload.files[0];

            if (!userNote && !selectedPdf) {
                // Manual Save
                if (!activeProjectId) return;
                const currentData = scrapeTreatmentStage5();
                const originalText = btnStage5Revise.textContent;

                try {
                    btnStage5Revise.textContent = 'Saving...';
                    btnStage5Revise.disabled = true;

                    await fetch(`/api/projects/${activeProjectId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            data: { stage5_treatment: currentData }
                        })
                    });

                    btnStage5Revise.textContent = 'Saved!';
                    setTimeout(() => {
                        btnStage5Revise.textContent = originalText;
                        btnStage5Revise.disabled = false;
                    }, 1500);

                    if (btnStage5Approve) {
                        btnStage5Approve.textContent = 'Approve';
                        btnStage5Approve.classList.remove('approve-btn-green');
                    }
                } catch (err) {
                    console.error('Failed to manual save stage 5:', err);
                    btnStage5Revise.textContent = originalText;
                    btnStage5Revise.disabled = false;
                }
                return;
            }

            // AI Revision
            const originalText = btnStage5Revise.textContent;
            btnStage5Revise.textContent = 'Revising...';
            btnStage5Revise.disabled = true;

            try {
                const currentData = scrapeTreatmentStage5();
                const formData = new FormData();
                formData.append('projectId', activeProjectId);
                formData.append('currentTreatment', JSON.stringify(currentData));
                formData.append('notes', userNote);
                if (selectedPdf) formData.append('pdfFile', selectedPdf);

                const response = await fetch('/api/generate-stage5-treatment', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) throw new Error(`Server responded with ${response.status}`);

                // Read SSE stream
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const event = JSON.parse(line.slice(6));

                        if (event.type === 'progress') {
                            btnStage5Revise.textContent = event.label;
                        } else if (event.type === 'complete') {
                            renderTreatmentStage5(event.result);
                            if (window.currentProjectData) window.currentProjectData.stage5_treatment = event.result;
                            if (stage5Notes) stage5Notes.value = '';
                            if (stage5PdfUpload) stage5PdfUpload.value = '';
                            if (stage5FileNameDisplay) stage5FileNameDisplay.textContent = '';
                            await handleSourceGenerationResult(5, event);
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        }
                    }
                }
            } catch (err) {
                console.error('Error revising stage 5:', err);
                alert('An error occurred while revising the treatment.');
            } finally {
                btnStage5Revise.textContent = originalText;
                btnStage5Revise.disabled = false;
            }
        });
    }

    if (btnStage5Approve) {
        btnStage5Approve.addEventListener('click', async () => {
            if (!activeProjectId) return;
            if (!(await runApprovalSourceGuard(5, btnStage5Approve))) return;
            const currentData = scrapeTreatmentStage5();
            const originalText = btnStage5Approve.textContent;

            const stage6HasData = !!(window.currentProjectData?.stage6_scenes?.length);
            const isReApproval = stage6HasData;

            btnStage5Approve.textContent = 'Saving...';
            btnStage5Approve.disabled = true;
            btnStage5Approve.classList.remove('approve-btn-green');

            const versionHistory5 = captureVersionSnapshot(5, 'stage5_treatment', 'Treatment', currentData);

            try {
                const putBody = {
                    data: { stage5_treatment: currentData, versionHistory: versionHistory5 }
                };
                if (isReApproval) putBody.stampRevisedStage = 'stage5_treatment';

                const res = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(putBody)
                });
                const updatedProject = await res.json();
                await offerStageMemoryCuration(5);
                updateStageNav(updatedProject.data);

                btnStage5Approve.textContent = 'Approved ✓';
                btnStage5Approve.classList.add('approve-btn-green');

                if (btnStage5Edit) btnStage5Edit.classList.remove('hidden');
                if (btnStage5Revise) btnStage5Revise.classList.add('hidden');

                if (isReApproval) {
                    showGenericRegenModal('Treatment', 'Stage 6 Scenes',
                        () => { switchStage(6); generateStage6(); },
                        () => { switchStage(6); }
                    );
                } else {
                    switchStage(6);
                    generateStage6();
                }
            } catch (err) {
                console.error(err);
                btnStage5Approve.textContent = originalText;
                btnStage5Approve.disabled = false;
            }
        });
    }

    // --- Stage 6 Logic: Scene Blueprint ---

    function renderStage6(data) {
        const container = document.getElementById('stage6-blueprint-container');
        if (!container) return;
        container.innerHTML = ''; // Wipe clean before drawing

        // Determine data structure — no dummy data; empty state is handled by leaving the container empty
        let sequences = [];
        if (!data) {
            return; // No data — leave container empty
        } else if (Array.isArray(data)) {
            sequences = data; // Flat array of sequences
        } else if (data.sequences && Array.isArray(data.sequences)) {
            sequences = data.sequences; // Nested sequences
        } else if (data.scenes && Array.isArray(data.scenes)) {
            // Flat array of scenes: wrap them so they render in a single block
            sequences = [{ sequence_title: "Draft Blueprint", scenes: data.scenes }];
        } else {
            return; // Unknown shape — leave container empty
        }

        // Clean up accumulated ghosts: If real scenes exist in the data, strip out any empty placeholder sequences
        const hasRealScenes = sequences.some(seq => seq.scenes && seq.scenes.length > 0);
        if (hasRealScenes) {
            sequences = sequences.filter(seq => seq.scenes && seq.scenes.length > 0);
        }

        if (sequences.length === 0) {
            return; // Nothing to render
        }

        let globalSceneCounter = 1;

        // Helper to update all scene numbers in the DOM
        const updateSceneNumbers = () => {
            document.querySelectorAll('.scene-card:not(.ghost-card) .scene-number').forEach((span, i) => {
                span.textContent = `Scene ${i + 1}`;
            });
        };

        sequences.forEach((seq, index) => {
            // Inject Act Headers
            let actHeader = null;
            if (index === 0) actHeader = "ACT I";
            else if (index === 2) actHeader = "ACT II (PART 1)";
            else if (index === 4) actHeader = "ACT II (PART 2)";
            else if (index === 6) actHeader = "ACT III";

            if (actHeader) {
                const header = document.createElement('h3');
                header.className = 'text-sm font-bold text-white tracking-widest uppercase mt-8';
                header.textContent = actHeader;
                container.appendChild(header);
            }

            const seqBlock = document.createElement('div');
            seqBlock.className = 'sequence-block';

            const seqTitleElement = document.createElement('div');
            seqTitleElement.className = 'sequence-title';
            seqTitleElement.textContent = seq.sequence_title || seq.title || seq.name || "SEQUENCE " + (index + 1);
            seqBlock.appendChild(seqTitleElement);

            const cardsContainer = document.createElement('div');
            cardsContainer.className = 'scene-cards-container';

            const scenes = seq.scenes || [];
            scenes.forEach((scene) => {
                const card = document.createElement('div');
                card.className = 'scene-card';
                card.dataset.sceneNumber = String(Number(scene.scene_number) || globalSceneCounter);
                card.innerHTML = `
                    <div class="scene-card-header">
                        <div class="flex items-center">
                            <span class="card-grip">⋮⋮</span>
                            <span class="scene-number">Scene ${globalSceneCounter}</span>
                        </div>
                    </div>
                    <input type="text" class="scene-heading-input" value="${escapeHtml(scene.scene_heading)}" placeholder="SCENE HEADING">
                    <div class="scene-field-group">
                        <label class="scene-field-label">Narrative Action</label>
                        <textarea class="scene-textarea" placeholder="Describe the action...">${escapeHtml(scene.narrative_action)}</textarea>
                    </div>
                    <div class="scene-field-group">
                        <label class="scene-field-label">Dramaturgical Function</label>
                        <textarea class="scene-textarea" placeholder="What is the purpose of this scene?">${escapeHtml(scene.dramaturgical_function)}</textarea>
                    </div>
                    <div class="scene-card-footer">
                        <input type="text" class="page-count-input" value="${escapeHtml(scene.estimated_page_count)}" placeholder="0.5 pgs">
                    </div>
                `;

                // Add resize listeners to textareas
                card.querySelectorAll('textarea').forEach(ta => {
                    ta.addEventListener('input', () => {
                        autoResize(ta);
                        if (btnStage6Approve) {
                            btnStage6Approve.textContent = 'Approve';
                            btnStage6Approve.classList.remove('approve-btn-green');
                            btnStage6Approve.disabled = false;
                        }
                    });
                    // Initial resize
                    setTimeout(() => autoResize(ta), 0);
                });
                card.querySelectorAll('input[type="text"]').forEach(input => {
                    input.addEventListener('input', () => {
                        if (btnStage6Approve) {
                            btnStage6Approve.textContent = 'Approve';
                            btnStage6Approve.classList.remove('approve-btn-green');
                            btnStage6Approve.disabled = false;
                        }
                    });
                });

                cardsContainer.appendChild(card);
                globalSceneCounter++;
            });

            // Add Ghost Card at the end of the cards array
            const ghostCard = document.createElement('div');
            ghostCard.className = 'scene-card ghost-card';
            ghostCard.innerHTML = `
                <div class="ghost-card-content">
                    <div class="ghost-card-plus">+</div>
                    <div class="ghost-card-text">Add Scene</div>
                </div>
                <div class="prompt-ai-scene-box hidden">
                    <input type="text" class="prompt-ai-scene-input" placeholder="Describe the new scene...">
                    <div class="flex justify-end">
                        <button class="primary-btn text-xs py-1 px-3">Generate</button>
                    </div>
                </div>
            `;

            ghostCard.addEventListener('click', (e) => {
                if (!ghostCard.classList.contains('active')) {
                    ghostCard.classList.add('active');
                    const promptBox = ghostCard.querySelector('.prompt-ai-scene-box');
                    promptBox.classList.remove('hidden');
                    const input = ghostCard.querySelector('.prompt-ai-scene-input');
                    input.focus();
                }
            });

            // Prevent event bubbling for input/button clicks inside active ghost card
            ghostCard.querySelector('.prompt-ai-scene-box').addEventListener('click', (e) => {
                e.stopPropagation();
            });

            cardsContainer.appendChild(ghostCard);
            seqBlock.appendChild(cardsContainer);
            container.appendChild(seqBlock);
        });


        // Re-initialize SortableJS on every sequence container
        if (typeof Sortable !== 'undefined') {
            document.querySelectorAll('.scene-cards-container').forEach(containerEL => {
                new Sortable(containerEL, {
                    group: 'shared',
                    animation: 150,
                    handle: '.card-grip',
                    onEnd: updateSceneNumbers
                });
            });
        } else {
            console.warn('SortableJS library not found. Drag and drop disabled.');
        }

        if (stage6Workshop) {
            stage6Workshop.classList.remove('hidden');
            // Ensure correct button states in renderStage6
            if (btnStage6Approve) {
                btnStage6Approve.textContent = 'Approve';
                btnStage6Approve.classList.remove('approve-btn-green');
                btnStage6Approve.classList.remove('hidden');
                btnStage6Approve.disabled = false;
            }
            if (btnStage6Submit) {
                btnStage6Submit.textContent = 'Submit';
                btnStage6Submit.classList.remove('hidden');
            }
        }
    }

    const loadingStateStage6 = document.getElementById('loadingStateStage6');
    const loadingTextStage6 = document.getElementById('loadingTextStage6');

    function hasStage6Scenes(snapshot) {
        return Array.isArray(snapshot) && snapshot.some(seq => Array.isArray(seq.scenes) && seq.scenes.length > 0);
    }

    function stage6SceneMap(snapshot) {
        const map = new Map();
        if (!Array.isArray(snapshot)) return map;
        snapshot.forEach(seq => {
            (seq.scenes || []).forEach(scene => {
                const key = Number(scene.scene_number) || map.size + 1;
                map.set(key, JSON.stringify({
                    scene_heading: scene.scene_heading || '',
                    narrative_action: scene.narrative_action || '',
                    dramaturgical_function: scene.dramaturgical_function || '',
                    estimated_page_count: scene.estimated_page_count ?? ''
                }));
            });
        });
        return map;
    }

    function changedStage6SceneNumbers(beforeSnapshot, afterSnapshot) {
        const before = stage6SceneMap(beforeSnapshot);
        const after = stage6SceneMap(afterSnapshot);
        const changed = [];
        after.forEach((serialized, sceneNumber) => {
            if (before.get(sceneNumber) !== serialized) changed.push(sceneNumber);
        });
        return changed;
    }

    function highlightStage6ChangedScenes(sceneNumbers = []) {
        const numbers = sceneNumbers.map(Number).filter(Number.isFinite);
        if (!numbers.length) return;
        const cards = numbers
            .map(num => document.querySelector(`.scene-card[data-scene-number="${num}"]`))
            .filter(Boolean);
        if (!cards.length) return;
        cards.forEach(card => {
            card.classList.add('scene-card-revision-highlight');
            setTimeout(() => card.classList.remove('scene-card-revision-highlight'), 2600);
        });
        cards[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function getStage6SnapshotForHistory() {
        const hasRenderedCards = !!stage6Board?.querySelector('.scene-card:not(.ghost-card)');
        if (hasRenderedCards) return scrapeStage6();
        const savedScenes = window.currentProjectData?.stage6_scenes;
        return Array.isArray(savedScenes) ? JSON.parse(JSON.stringify(savedScenes)) : [];
    }

    async function saveStage6SnapshotBeforeRegenerate() {
        const currentBlueprint = getStage6SnapshotForHistory();
        if (!hasStage6Scenes(currentBlueprint)) return;

        const versionHistory6 = captureVersionSnapshot(6, 'stage6_scenes', 'Scenes', currentBlueprint);
        const response = await fetch(`/api/projects/${activeProjectId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: {
                    stage6_scenes: currentBlueprint,
                    stage7_approved: false,
                    stage8_coverage: null,
                    stage8_approved: false,
                    versionHistory: versionHistory6
                },
                stampRevisedStage: 'stage6_scenes'
            })
        });

        if (!response.ok) throw new Error('Failed to save current blueprint before regenerating');
        const updatedProject = await response.json();
        if (window.currentProjectData) window.currentProjectData = updatedProject.data;
        updateStageNav(updatedProject.data);
    }

    function closeStage6RegenerateMenu() {
        stage6RegenerateMenu?.classList.add('hidden');
    }

    async function handleStage6Regenerate(action) {
        closeStage6RegenerateMenu();
        if (action === 'history') {
            switchToVersionHistory();
            return;
        }
        if (action === 'notes') {
            const chatInput = document.getElementById('stage6-chat-input');
            if (chatInput) {
                if (!chatInput.value.trim()) chatInput.value = 'Regenerate the blueprint with these notes: ';
                chatInput.focus();
                chatInput.selectionStart = chatInput.selectionEnd = chatInput.value.length;
            }
            return;
        }
        if (!activeProjectId) return;

        const confirmText = 'Create a fresh Scene Blueprint from the approved Pitch, Characters, Beats, and Treatment? The current blueprint will be saved in Version History first.';
        if (!confirm(confirmText)) return;

        const originalText = btnStage6Regenerate?.textContent;
        try {
            if (btnStage6Regenerate) {
                btnStage6Regenerate.disabled = true;
                btnStage6Regenerate.textContent = 'Regenerating...';
            }
            await saveStage6SnapshotBeforeRegenerate();
            await generateStage6({ isRegenerate: true, throwOnError: true });
        } catch (error) {
            console.error('Stage 6 regenerate failed:', error);
            alert(error.message || 'Could not regenerate the Scene Blueprint.');
        } finally {
            if (btnStage6Regenerate) {
                btnStage6Regenerate.disabled = false;
                btnStage6Regenerate.innerHTML = 'Regenerate <span class="stage-regenerate-chevron">⌄</span>';
                if (originalText && originalText.includes('Regenerate')) {
                    btnStage6Regenerate.innerHTML = 'Regenerate <span class="stage-regenerate-chevron">⌄</span>';
                }
            }
        }
    }

    async function generateStage6(options = {}) {
        if (!activeProjectId) return;
        const { notes = '', isRegenerate = false, throwOnError = false } = options || {};

        if (btnStage6Approve) {
            btnStage6Approve.textContent = 'Approve';
            btnStage6Approve.classList.remove('approve-btn-green');
            btnStage6Approve.classList.add('hidden');
        }
        if (btnStage6Regenerate) btnStage6Regenerate.disabled = true;

        // Clear old content and show loading state
        if (stage6Board) stage6Board.innerHTML = '';
        if (stage6Workshop) stage6Workshop.classList.add('hidden');
        if (loadingStateStage6) loadingStateStage6.classList.remove('hidden');
        if (loadingTextStage6) loadingTextStage6.textContent = isRegenerate ? 'Regenerating Scene Blueprint...' : 'Generating Scene Blueprint...';

        try {
            const requestBody = { projectId: activeProjectId };
            if (notes) requestBody.notes = notes;
            const response = await fetch('/api/generate-stage6-scenes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to generate scene blueprint');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let stage6GenerationComplete = false;

            const processStage6Event = async (event) => {
                if (event.type === 'progress') {
                    if (loadingTextStage6) loadingTextStage6.textContent = `Generating Sequence ${event.current} of ${event.total}...`;
                } else if (event.type === 'status') {
                    if (loadingTextStage6) loadingTextStage6.textContent = event.message || 'Preparing Scene Blueprint...';
                } else if (event.type === 'complete') {
                    stage6GenerationComplete = true;
                    renderStage6(event.result);
                    if (window.currentProjectData) window.currentProjectData.stage6_scenes = event.result;
                    await handleSourceGenerationResult(6, event);
                } else if (event.type === 'error') {
                    throw new Error(event.message);
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const event = JSON.parse(line.slice(6));
                    await processStage6Event(event);
                }
            }

            if (buffer.trim().startsWith('data: ')) {
                await processStage6Event(JSON.parse(buffer.trim().slice(6)));
            }

            if (!stage6GenerationComplete) {
                const projectRes = await fetch(`/api/projects/${activeProjectId}`);
                if (!projectRes.ok) throw new Error('Scene Blueprint was generated, but the project could not be refreshed.');
                const project = await projectRes.json();
                window.currentProjectData = project.data;
                updateStageNav(project.data);
                if (project.data?.stage6_scenes) {
                    renderStage6(project.data.stage6_scenes);
                    await handleSourceGenerationResult(6, {}, { refreshKnowledge: false });
                }
            }
        } catch (error) {
            console.error('Stage 6 generation failed:', error);
            if (throwOnError) throw error;
            alert(error.message || 'An error occurred during scene generation.');
        } finally {
            if (loadingStateStage6) loadingStateStage6.classList.add('hidden');
            if (btnStage6Regenerate) btnStage6Regenerate.disabled = false;
        }
    }

    if (btnStage6Regenerate && stage6RegenerateMenu) {
        btnStage6Regenerate.addEventListener('click', (event) => {
            event.stopPropagation();
            stage6RegenerateMenu.classList.toggle('hidden');
        });
        stage6RegenerateMenu.addEventListener('click', (event) => {
            event.stopPropagation();
            const action = event.target.closest('[data-stage6-regenerate]')?.dataset.stage6Regenerate;
            if (action) handleStage6Regenerate(action);
        });
        document.addEventListener('click', closeStage6RegenerateMenu);
    }

    if (btnStage6Submit) {
        btnStage6Submit.addEventListener('click', async () => {
            if (!activeProjectId) return;
            const feedback = stage6Notes ? stage6Notes.value.trim() : "";
            if (!feedback) {
                alert("Please enter revision notes in the feedback box.");
                return;
            }

            const originalText = btnStage6Submit.textContent;
            btnStage6Submit.disabled = true;
            btnStage6Submit.textContent = 'Revising...';

            try {
                const data = await reviseStage6Blueprint(feedback, {
                    onStatus: (message) => {
                        btnStage6Submit.textContent = message || 'Revising...';
                    }
                });
                if (data && data.changed === false) {
                    throw new Error('The revision engine returned no blueprint changes.');
                }

                // Clear feedback box
                if (stage6Notes) {
                    stage6Notes.value = "";
                    stage6Notes.style.height = 'auto'; // Reset auto-resize
                }

                // Success feedback
                btnStage6Submit.textContent = 'Revised ✓';
                setTimeout(() => {
                    btnStage6Submit.textContent = originalText;
                    btnStage6Submit.disabled = false;
                }, 2000);

            } catch (error) {
                console.error('Stage 6 revision failed:', error);
                alert('An error occurred during scene revision.');
                btnStage6Submit.textContent = originalText;
                btnStage6Submit.disabled = false;
            }
        });
    }

    function scrapeStage6() {
        const sequences = [];
        const stage6Container = document.getElementById('stage6-blueprint-container');
        
        // Scope the query exclusively to the Stage 6 container to avoid grabbing hidden Stage 2 blocks
        const seqBlocks = stage6Container ? stage6Container.querySelectorAll('.sequence-block') : [];
        
        seqBlocks.forEach(block => {
            const title = block.querySelector('.sequence-title')?.textContent || "";
            const scenes = [];
            const sceneCards = block.querySelectorAll('.scene-card:not(.ghost-card)');
            
            sceneCards.forEach(card => {
                const sceneNumberText = card.querySelector('.scene-number')?.textContent || "";
                const sceneNumber = parseInt(sceneNumberText.replace('Scene ', '')) || 0;
                
                const heading = card.querySelector('.scene-heading-input')?.value || "";
                const textareas = card.querySelectorAll('.scene-textarea');
                const action = textareas[0]?.value || "";
                const functionText = textareas[1]?.value || "";
                const pageCount = card.querySelector('.page-count-input')?.value || "";
                
                scenes.push({
                    scene_number: sceneNumber,
                    scene_heading: heading,
                    narrative_action: action,
                    dramaturgical_function: functionText,
                    estimated_page_count: pageCount
                });
            });
            
            sequences.push({
                sequence_title: title,
                scenes: scenes
            });
        });
        
        return sequences;
    }

    if (btnStage6Approve) {
        btnStage6Approve.addEventListener('click', async () => {
            if (!activeProjectId) return;
            if (!(await runApprovalSourceGuard(6, btnStage6Approve))) return;
            const currentBlueprint = scrapeStage6();
            const originalText = btnStage6Approve.textContent;

            const existingHistory = (window.currentProjectData?.versionHistory) || [];
            const isReApproval = existingHistory.filter(v => v.stage === 6).length > 0;

            btnStage6Approve.disabled = true;
            btnStage6Approve.textContent = 'Saving...';

            const versionHistory6 = captureVersionSnapshot(6, 'stage6_scenes', 'Scenes', currentBlueprint);

            try {
                const putBody = {
                    data: { stage6_scenes: currentBlueprint, versionHistory: versionHistory6 }
                };
                if (isReApproval) putBody.stampRevisedStage = 'stage6_scenes';

                const response = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(putBody)
                });

                if (!response.ok) throw new Error('Failed to save project');

                btnStage6Approve.textContent = 'Approved ✓';
                btnStage6Approve.classList.add('approve-btn-green');
                await offerStageMemoryCuration(6);

                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                updateStageNav(projData.data);

                if (btnStage6Submit) btnStage6Submit.classList.add('hidden');
                if (btnStage6Revise) btnStage6Revise.classList.remove('hidden');

                const stage6NavItem = navItems[6];
                if (stage6NavItem) {
                    stage6NavItem.classList.add('completed');
                }

                if (isReApproval) {
                    // Stage 7 (Style) sits between 6 and 8 — offer regen of Stage 8 only if it exists
                    const hasStage8 = !!(window.currentProjectData?.stage8_draft);
                    if (hasStage8) {
                        showGenericRegenModal('Scenes', 'Stage 8 Draft',
                            () => { switchStage(8); initStage8(); },
                            () => { switchStage(7); }
                        );
                    } else {
                        switchStage(7);
                    }
                } else {
                    switchStage(7);
                }

            } catch (error) {
                console.error('Stage 6 approval failed:', error);
                alert('An error occurred while saving the approved blueprint.');
                btnStage6Approve.textContent = originalText;
                btnStage6Approve.disabled = false;
            }
        });
    }

    // --- Stage 8 Logic: Draft ---

    // Renders only the scene TOC sidebar, leaving the editor and buttons untouched.
    // Called by both initStage8() and the batch generation loop.
    function renderStage8Sidebar() {
        const toc = document.getElementById('stage8-toc');
        if (!toc) return;

        toc.innerHTML = '';
        const scenes = getFlatScenes();
        scenes.forEach(scene => {
            const isActive = scene.scene_number === currentDraftSceneNumber;
            const activeClass = isActive ? 'border-blue-500 bg-gray-800' : 'border-gray-700 bg-gray-900 opacity-75 hover:opacity-100';

            const card = document.createElement('div');
            card.className = `scene-accordion-card rounded-md mb-2 border ${activeClass} overflow-hidden transition-all`;

            const lockBadge = scene.locked
                ? `<span class="text-[9px] text-green-400 font-bold ml-1">LOCKED</span>`
                : '';
            const draftBadge = (!scene.locked && scene.draft_text)
                ? `<span class="text-[9px] text-blue-400/60 font-bold ml-1">✓</span>`
                : '';

            card.innerHTML = `
                <div class="accordion-header p-3 cursor-pointer flex justify-between items-center" onclick="selectDraftScene(${scene.scene_number})">
                    <div class="flex-1 pr-4">
                        <div class="text-[10px] text-blue-400 font-bold mb-1">SCENE ${scene.scene_number}${lockBadge}${draftBadge}</div>
                        <div class="text-xs text-gray-200 font-semibold leading-snug">${escapeHtml(scene.scene_heading)}</div>
                    </div>
                    <div class="p-2 hover:bg-white/10 rounded-full transition-colors" onclick="toggleSceneDetails(this, event)">
                        <svg class="w-4 h-4 text-gray-400 transform transition-transform duration-200 chevron-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </div>
                </div>
                <div class="accordion-body hidden p-3 bg-gray-950 border-t border-gray-700">
                    <div class="text-[9px] text-gray-500 mb-1 uppercase tracking-wider font-bold">Narrative Action</div>
                    <p class="text-xs text-gray-400 mb-3">${escapeHtml(scene.narrative_action)}</p>
                    <div class="text-[9px] text-gray-500 mb-1 uppercase tracking-wider font-bold">Dramaturgical Function</div>
                    <p class="text-xs text-blue-400/80">${escapeHtml(scene.dramaturgical_function)}</p>
                </div>
            `;
            toc.appendChild(card);
        });
    }

    function showContinuityFeedback(data) {
        const banner = document.getElementById('stage8-continuity-banner');
        const errorsEl = document.getElementById('stage8-continuity-errors');
        const warningsBanner = document.getElementById('stage8-continuity-warnings');
        const warningsText = document.getElementById('stage8-continuity-warnings-text');
        if (!banner || !errorsEl || !warningsBanner || !warningsText) return;

        if (data.continuityErrors?.length > 0) {
            errorsEl.innerHTML = data.continuityErrors.map(e =>
                `<div><strong>Continuity issue:</strong> ${escapeHtml(e.explanation)}</div>`
            ).join('');
            banner.classList.remove('hidden');

            const btnRedraft = document.getElementById('btnRedraftScene');
            if (btnRedraft) {
                btnRedraft.onclick = async () => {
                    const autoNote = data.continuityErrors.map(e => e.explanation).join(' ');
                    hideContinuityFeedback();
                    const originalText = btnGenerateScene?.textContent;
                    if (btnGenerateScene) { btnGenerateScene.textContent = 'Re-drafting...'; btnGenerateScene.disabled = true; }
                    try {
                        const response = await fetch('/api/revise-draft', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: activeProjectId, sceneNumber: currentDraftSceneNumber, feedback: `Fix continuity: ${autoNote}` })
                        });
                        if (!response.ok) throw new Error('Revision failed');
                        const revised = await response.json();
                        stage8LoadEditor(revised.result);
                        showContinuityFeedback(revised);
                        await handleSourceGenerationResult(8, revised);
                        const projRes = await fetch(`/api/projects/${activeProjectId}`);
                        window.currentProjectData = (await projRes.json()).data;
                    } catch (err) {
                        console.error('Continuity re-draft failed:', err);
                        alert(`Re-draft error: ${err.message}`);
                    } finally {
                        if (btnGenerateScene) { btnGenerateScene.textContent = originalText; btnGenerateScene.disabled = false; }
                    }
                };
            }
        } else {
            banner.classList.add('hidden');
        }

        if (data.continuityWarnings?.length > 0) {
            warningsText.textContent = data.continuityWarnings.map(w => `ℹ ${w.explanation}`).join(' · ');
            warningsBanner.classList.remove('hidden');
        } else {
            warningsBanner.classList.add('hidden');
        }
    }

    function hideContinuityFeedback() {
        document.getElementById('stage8-continuity-banner')?.classList.add('hidden');
        document.getElementById('stage8-continuity-warnings')?.classList.add('hidden');
    }

    function initStage8() {
        if (!btnGenerateScene || !btnNextScene || !draftEditorMount) return;

        renderStage8Sidebar();

        const scenes = getFlatScenes();
        const currentSceneData = scenes.find(s => s.scene_number === currentDraftSceneNumber);

        if (currentSceneData?.locked) {
            btnGenerateScene.textContent = `Scene ${currentDraftSceneNumber} Locked`;
            btnGenerateScene.disabled = true;
        } else {
            btnGenerateScene.textContent = `Generate Scene ${currentDraftSceneNumber}`;
            btnGenerateScene.disabled = false;
        }

        if (currentSceneData && (currentSceneData.humanized_draft_text || currentSceneData.draft_text)) {
            stage8LoadEditor(currentSceneData.humanized_draft_text || currentSceneData.draft_text);
            btnNextScene.classList.remove('hidden');
        } else {
            stage8ShowPlaceholder(`<div class="text-gray-500 italic text-center mt-24 p-12">Ready to generate Scene ${currentDraftSceneNumber}...</div>`);
            btnNextScene.classList.add('hidden');
        }
    }

    if (btnGenerateScene) {
        btnGenerateScene.addEventListener('click', async () => {
            if (!activeProjectId) return;

            const originalText = btnGenerateScene.textContent;
            btnGenerateScene.textContent = 'Generating...';
            btnGenerateScene.disabled = true;
            hideContinuityFeedback();

            try {
                const response = await fetch('/api/generate-draft', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId: activeProjectId,
                        sceneNumber: currentDraftSceneNumber
                    })
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({ error: `Server error: ${response.status}` }));
                    throw new Error(error.error || 'Failed to generate draft');
                }

                const data = await response.json().catch(() => ({ result: '' }));
                const draftText = data.result;

                stage8LoadEditor(draftText);
                showContinuityFeedback(data);
                await handleSourceGenerationResult(8, data);

                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                window.currentProjectData = projData.data;

                // Show "Next" button after generation
                if (btnNextScene) btnNextScene.classList.remove('hidden');

            } catch (error) {
                console.error('Stage 8 draft generation failed:', error);
                alert(`Error: ${error.message}`);
            } finally {
                btnGenerateScene.textContent = originalText;
                btnGenerateScene.disabled = false;
            }
        });
    }

    if (btnNextScene) {
        btnNextScene.addEventListener('click', async () => {
            // Flush any manual edits before locking
            stage8FlushEditor();
            // Mark the current scene as locked and persist before advancing
            const scenes = getFlatScenes();
            const currentSceneData = scenes.find(s => s.scene_number === currentDraftSceneNumber);
            if (currentSceneData && activeProjectId) {
                currentSceneData.locked = true;
                const stage6Scenes = window.currentProjectData?.stage6_scenes;
                if (stage6Scenes) {
                    try {
                        await fetch(`/api/projects/${activeProjectId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ data: { stage6_scenes: stage6Scenes } })
                        });
                        const projRes = await fetch(`/api/projects/${activeProjectId}`);
                        const projData = await projRes.json();
                        window.currentProjectData = projData.data;
                    } catch (err) {
                        console.error('Failed to persist lock state:', err);
                    }
                }
            }
            currentDraftSceneNumber++;
            initStage8();
        });
    }

    if (btnStage8Submit) {
        btnStage8Submit.addEventListener('click', async () => {
            if (!activeProjectId) return;
            const feedback = stage8Notes?.value.trim();
            if (!feedback) {
                alert("Please enter revision notes in the feedback box before submitting.");
                return;
            }

            const originalText = btnStage8Submit.textContent;
            btnStage8Submit.disabled = true;
            btnStage8Submit.textContent = 'Revising...';
            hideContinuityFeedback();

            try {
                const response = await fetch('/api/revise-draft', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId: activeProjectId,
                        sceneNumber: currentDraftSceneNumber,
                        feedback: feedback
                    })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || 'Failed to revise scene');
                }

                const data = await response.json();

                stage8LoadEditor(data.result);
                showContinuityFeedback(data);
                await handleSourceGenerationResult(8, data);

                // Sync local project data
                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                window.currentProjectData = projData.data;

                // Clear feedback notes
                if (stage8Notes) {
                    stage8Notes.value = '';
                    stage8Notes.style.height = 'auto';
                }

                // Show "Next" button since we now have a draft
                if (btnNextScene) btnNextScene.classList.remove('hidden');

                btnStage8Submit.textContent = 'Revised ✓';
                setTimeout(() => {
                    btnStage8Submit.textContent = originalText;
                    btnStage8Submit.disabled = false;
                }, 2000);

            } catch (error) {
                console.error('Stage 8 revision failed:', error);
                alert(`Error: ${error.message}`);
                btnStage8Submit.textContent = originalText;
                btnStage8Submit.disabled = false;
            }
        });
    }

    if (btnStage8Approve) {
        btnStage8Approve.addEventListener('click', async () => {
            if (!activeProjectId) return;
            stage8FlushEditor(); // Save any pending manual edits
            if (!(await runApprovalSourceGuard(8, btnStage8Approve))) return;

            const originalText = btnStage8Approve.textContent;
            btnStage8Approve.disabled = true;
            btnStage8Approve.textContent = 'Saving...';

            const versionHistory7 = captureVersionSnapshot(8, 'stage7_approved', 'Draft', true);

            try {
                const response = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { stage7_approved: true, stage8_coverage: null, versionHistory: versionHistory7 } })
                });

                if (!response.ok) throw new Error('Failed to save project');

                const updatedProject = await response.json();
                await offerStageMemoryCuration(8);
                updateStageNav(updatedProject.data);

                btnStage8Approve.textContent = 'Approved ✓';
                btnStage8Approve.classList.add('approve-btn-green');

                // Clear stale coverage so Stage 9 re-generates
                if (window.currentProjectData) delete window.currentProjectData.stage8_coverage;

                // Advance to Stage 9
                switchStage(9);

            } catch (error) {
                console.error('Stage 8 approval failed:', error);
                alert('An error occurred while saving.');
                btnStage8Approve.textContent = originalText;
                btnStage8Approve.disabled = false;
            }
        });
    }

    document.querySelectorAll('.feedback-panel').forEach(panel => {
        const header = panel.querySelector('.feedback-panel-header');
        if (header) {
            header.addEventListener('click', () => panel.classList.toggle('collapsed'));
        }
    });

    if (btnGenerateAll) {
        btnGenerateAll.addEventListener('click', async () => {
            // Toggle: cancel an in-progress batch run
            if (isBatchGenerating) {
                isBatchGenerating = false;
                return;
            }

            if (!activeProjectId) return;

            const pendingScenes = getFlatScenes().filter(s => !s.draft_text && !s.locked);
            if (pendingScenes.length === 0) {
                alert('All scenes already have drafts.');
                return;
            }

            isBatchGenerating = true;
            btnGenerateAll.textContent = '✕ Cancel';
            btnGenerateScene.disabled = true;
            btnNextScene.classList.add('hidden');

            let completed = 0;
            const total = pendingScenes.length;

            for (const scene of pendingScenes) {
                if (!isBatchGenerating) break;

                currentDraftSceneNumber = scene.scene_number;
                btnGenerateAll.textContent = `✕ Cancel  (${completed}/${total})`;

                stage8ShowPlaceholder(`<div class="text-gray-500 italic text-center mt-24 p-12">Generating Scene ${scene.scene_number} of ${getFlatScenes().length}...</div>`);
                renderStage8Sidebar();

                try {
                    const response = await fetch('/api/generate-draft', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: activeProjectId, sceneNumber: scene.scene_number })
                    });

                    if (!response.ok) {
                        const err = await response.json().catch(() => ({ error: `Server error: ${response.status}` }));
                        throw new Error(err.error || `Failed to generate Scene ${scene.scene_number}`);
                    }

                    const data = await response.json();

                    stage8LoadEditor(data.result);
                    showContinuityFeedback(data);
                    await handleSourceGenerationResult(8, data, { refreshKnowledge: false });

                    // Sync local project data so getFlatScenes() reflects the new draft_text
                    const projRes = await fetch(`/api/projects/${activeProjectId}`);
                    const projData = await projRes.json();
                    window.currentProjectData = projData.data;

                    renderStage8Sidebar();
                    completed++;

                } catch (error) {
                    console.error(`Batch generation failed on Scene ${scene.scene_number}:`, error);
                    isBatchGenerating = false;
                    btnGenerateAll.textContent = 'Generate All Scenes';
                    btnGenerateScene.disabled = false;
                    alert(`Error on Scene ${scene.scene_number}: ${error.message}`);
                    return;
                }
            }

            // Finished or cancelled — restore UI
            isBatchGenerating = false;
            btnGenerateAll.textContent = 'Generate All Scenes';
            await refreshProjectKnowledgeSummary().catch(err => console.warn('Source readiness refresh skipped:', err.message));
            await runPostGenerationSourceVerification(8).catch(err => console.warn('Post-generation source check skipped:', err.message));
            initStage8(); // Full re-render to restore button states
        });
    }

    function makeFilename(title, stage, ext = 'txt') {
        const slug = (title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
        const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
        return `${slug}_${stage}_${ts}.${ext}`;
    }

    // ── Export helper: triggers a server-generated file download ──────────────
    async function triggerApiDownload(url, btn) {
        const orig = btn ? btn.textContent : null;
        try {
            if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
            const res = await fetch(url);
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Export failed' }));
                alert(err.error || 'Export failed');
                return;
            }
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="([^"]+)"/);
            const filename = match ? match[1] : 'export';
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (e) {
            alert('Export failed: ' + e.message);
        } finally {
            if (btn && orig) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    const btnDownloadOutline = document.getElementById('btnDownloadOutline');
    if (btnDownloadOutline) {
        btnDownloadOutline.addEventListener('click', () => {
            if (!window.currentProjectData?.stage2_outline?.outline) { alert('No outline has been generated yet.'); return; }
            triggerApiDownload(`/api/export/docx/${activeProjectId}?stage=outline`, btnDownloadOutline);
        });
    }

    const btnDownloadPitch = document.getElementById('btnDownloadPitch');
    if (btnDownloadPitch) {
        btnDownloadPitch.addEventListener('click', () => {
            if (!window.currentProjectData?.stage1_pitch?.pitch) { alert('No pitch has been generated yet.'); return; }
            triggerApiDownload(`/api/export/docx/${activeProjectId}?stage=pitch`, btnDownloadPitch);
        });
    }

    const btnDownloadCharacters = document.getElementById('btnDownloadCharacters');
    if (btnDownloadCharacters) {
        btnDownloadCharacters.addEventListener('click', () => {
            if (!window.currentProjectData?.stage3_characters?.characters?.length) { alert('No characters have been generated yet.'); return; }
            triggerApiDownload(`/api/export/docx/${activeProjectId}?stage=characters`, btnDownloadCharacters);
        });
    }

    const btnDownloadBeats = document.getElementById('btnDownloadBeats');
    if (btnDownloadBeats) {
        btnDownloadBeats.addEventListener('click', () => {
            const d = window.currentProjectData?.stage4_beats || window.currentProjectData?.stage4_treatment;
            if (!d?.hybrid_beat_sheet) { alert('No beats have been generated yet.'); return; }
            triggerApiDownload(`/api/export/docx/${activeProjectId}?stage=beats`, btnDownloadBeats);
        });
    }

    const btnDownloadScenes = document.getElementById('btnDownloadScenes');
    if (btnDownloadScenes) {
        btnDownloadScenes.addEventListener('click', () => {
            const d = window.currentProjectData?.stage6_scenes;
            if (!d || !(Array.isArray(d) ? d : (d.sequences || [])).length) { alert('No scene blueprint has been generated yet.'); return; }
            triggerApiDownload(`/api/export/docx/${activeProjectId}?stage=scenes`, btnDownloadScenes);
        });
    }

    const btnDownloadTreatment = document.getElementById('btnDownloadTreatment');
    if (btnDownloadTreatment) {
        btnDownloadTreatment.addEventListener('click', () => {
            const t = window.currentProjectData?.stage5_treatment;
            if (!t || !Object.values(t).some(v => v && typeof v === 'string' && v.trim())) { alert('No treatment has been generated yet.'); return; }
            triggerApiDownload(`/api/export/docx/${activeProjectId}?stage=treatment`, btnDownloadTreatment);
        });
    }

    const btnDownloadDraft = document.getElementById('btnDownloadDraft');
    if (btnDownloadDraft) {
        btnDownloadDraft.addEventListener('click', () => {
            const scenes = getFlatScenes();
            const drafted = scenes.filter(s => s.draft_text);
            if (drafted.length === 0) {
                alert('No scenes have been drafted yet.');
                return;
            }
            const fountainText = drafted.map(s => s.draft_text.trim()).join('\n\n');
            const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'screenplay';
            const blob = new Blob([fountainText], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = makeFilename(title, 'draft', 'fountain');
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const btnExportDraftPdf = document.getElementById('btnExportDraftPdf');
    if (btnExportDraftPdf) {
        btnExportDraftPdf.addEventListener('click', () => {
            const scenes = getFlatScenes().filter(s => s.draft_text || s.humanized_draft_text);
            if (!scenes.length) { alert('No scenes have been drafted yet.'); return; }
            triggerApiDownload(`/api/export/pdf/${activeProjectId}?stage=draft`, btnExportDraftPdf);
        });
    }

    // Expose selectDraftScene on window from inside the closure so it has access
    // to currentDraftSceneNumber and initStage8 (both defined in this scope).
    window.selectDraftScene = function(sceneNumber) {
        stage8FlushEditor();
        hideContinuityFeedback();
        currentDraftSceneNumber = sceneNumber;
        initStage8();
    };

    // --- Stage 9: Coverage ---

    async function initStage9() {
        const loadingDiv  = document.getElementById('stage9-loading');
        const reportDiv   = document.getElementById('stage9-report');
        const coverageData = window.currentProjectData?.stage8_coverage;

        if (coverageData) {
            loadingDiv?.classList.add('hidden');
            reportDiv?.classList.remove('hidden');
            renderCoverageReport(coverageData);
        } else {
            loadingDiv?.classList.remove('hidden');
            reportDiv?.classList.add('hidden');
            try {
                const coverageSource = window.coverageSourceStage10 ? 'stage9' : 'stage6';
                window.coverageSourceStage10 = false;
                const response = await fetch('/api/generate-coverage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: activeProjectId, source: coverageSource })
                });
                if (!response.ok) {
                    const err = await response.json();
                    throw new Error(err.error || 'Failed to generate coverage');
                }
                const data = await response.json();

                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                window.currentProjectData = projData.data;

                const versionHistory8 = captureVersionSnapshot(9, 'stage8_coverage', 'Coverage', data.result);
                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { versionHistory: versionHistory8 } })
                });

                updateStageNav(projData.data);

                loadingDiv?.classList.add('hidden');
                reportDiv?.classList.remove('hidden');
                renderCoverageReport(data.result);
            } catch (error) {
                console.error('Coverage generation failed:', error);
                loadingDiv?.classList.add('hidden');
                reportDiv?.classList.remove('hidden');
                const container = document.getElementById('stage9-content');
                if (container) {
                    container.innerHTML = `
                        <div class="text-center mt-24">
                            <p class="text-red-400 text-sm mb-4">Failed to generate coverage: ${error.message}</p>
                            <button onclick="window.retryStage9Coverage()" class="primary-btn">Try Again</button>
                        </div>`;
                }
            }
        }

        // Wire up Begin Rewrite button
        const btnApprove = document.getElementById('btnStage9Approve');
        if (btnApprove) {
            btnApprove.onclick = async () => {
                try {
                    await saveCoveragePriorities();
                } catch (err) {
                    alert('Failed to save your edits. Please try again.');
                    return;
                }
                try {
                    const response = await fetch(`/api/projects/${activeProjectId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ data: { stage8_approved: true } })
                    });
                    if (!response.ok) throw new Error('Failed to save');
                    const updated = await response.json();
                    updateStageNav(updated.data);
                    btnApprove.textContent = 'Rewrite Started ✓';
                    btnApprove.classList.add('approve-btn-green');
                    btnApprove.disabled = true;
                    // Always restart Stage 10 from P1 when entering from Begin Rewrite
                    window.stage10ResetOnInit = true;
                    switchStage(10);
                } catch (err) {
                    console.error('Stage 9 approval failed:', err);
                    alert('An error occurred. Please try again.');
                }
            };
        }

        // Restore approved state if already approved
        if (btnApprove && window.currentProjectData?.stage8_approved) {
            btnApprove.textContent = 'Rewrite Started ✓';
            btnApprove.classList.add('approve-btn-green');
            btnApprove.disabled = true;
        }

        // Wire up Download Coverage button
        const btnDownload = document.getElementById('btnDownloadCoverage');
        if (btnDownload) {
            btnDownload.onclick = () => {
                if (!window.currentProjectData?.stage8_coverage) { alert('No coverage report available.'); return; }
                triggerApiDownload(`/api/export/docx/${activeProjectId}?stage=coverage`, btnDownload);
            };
        }
    }

    function renderCoverageReport(data) {
        const container = document.getElementById('stage9-content');
        if (!container || !data) return;

        // Support both new (macro_todo/micro_todo) and legacy (priority_todo) schemas
        const hasNewSchema = data.macro_todo !== undefined || data.micro_todo !== undefined;
        window.currentMacroTodo = JSON.parse(JSON.stringify(hasNewSchema ? (data.macro_todo || []) : (data.priority_todo || [])));
        window.currentMicroTodo = JSON.parse(JSON.stringify(hasNewSchema ? (data.micro_todo || []) : []));

        const ratingClass = (r) => {
            switch ((r || '').toLowerCase()) {
                case 'excellent': return 'text-green-400 bg-green-400/10 border-green-400/30';
                case 'good':      return 'text-blue-400 bg-blue-400/10 border-blue-400/30';
                case 'fair':      return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30';
                case 'poor':      return 'text-red-400 bg-red-400/10 border-red-400/30';
                default:          return 'text-gray-400 bg-gray-400/10 border-gray-400/30';
            }
        };

        const gradeClass = (g) => {
            switch ((g || '').toUpperCase()) {
                case 'RECOMMEND': return 'text-green-400 bg-green-400/10 border-green-400/30';
                case 'CONSIDER':  return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30';
                case 'PASS':      return 'text-red-400 bg-red-400/10 border-red-400/30';
                default:          return 'text-gray-400 bg-gray-400/10 border-gray-400/30';
            }
        };

        const authClass = (a) => {
            const s = (a || '').toLowerCase();
            if (s.includes('authentic') || s.includes('human')) return 'text-green-400 bg-green-400/10 border-green-400/30';
            if (s.includes('mixed')) return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30';
            return 'text-red-400 bg-red-400/10 border-red-400/30';
        };

        const gridKeys = ['concept', 'structure', 'characterization', 'pacing', 'dialogue'];
        const gridHTML = gridKeys.map(k => `
            <div class="flex flex-col items-center gap-2 text-center">
                <span class="text-xs text-gray-500 uppercase tracking-wider">${k}</span>
                <span class="text-xs font-bold px-2 py-1 rounded border ${ratingClass(data.evaluation_grid?.[k])}">${data.evaluation_grid?.[k] || '—'}</span>
            </div>`).join('');

        const redFlagsHTML = (data.authenticity?.red_flags || []).length > 0
            ? `<ul class="mt-3 space-y-2">${data.authenticity.red_flags.map(f =>
                `<li class="text-gray-300 text-sm italic border-l-2 border-yellow-500/40 pl-3 py-1">"${f}"</li>`).join('')}</ul>`
            : '<p class="text-gray-500 text-sm italic mt-2">No major red flags detected.</p>';

        container.innerHTML = `
            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <div class="flex items-start justify-between gap-4 mb-3">
                    <h2 class="text-xl font-bold text-white">${data.title || 'Untitled'}</h2>
                    <span class="text-xs font-mono text-gray-400 uppercase tracking-wider shrink-0 mt-1">${data.genre || ''}</span>
                </div>
                <p class="text-gray-300 text-sm leading-relaxed italic">${data.logline || ''}</p>
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase mb-4">Evaluation Grid</h3>
                <div class="grid grid-cols-5 gap-3">${gridHTML}</div>
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase mb-4">Narrative Synopsis</h3>
                <div class="space-y-4">
                    <div><span class="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1">Setup</span><p class="text-gray-300 text-sm leading-relaxed">${data.synopsis?.setup || ''}</p></div>
                    <div><span class="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1">Escalation</span><p class="text-gray-300 text-sm leading-relaxed">${data.synopsis?.escalation || ''}</p></div>
                    <div><span class="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1">Resolution</span><p class="text-gray-300 text-sm leading-relaxed">${data.synopsis?.resolution || ''}</p></div>
                </div>
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase mb-3">Authenticity Check</h3>
                <span class="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded border ${authClass(data.authenticity?.assessment)}">${data.authenticity?.assessment || '—'}</span>
                ${redFlagsHTML}
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase mb-4">Development Notes</h3>
                <div class="space-y-4">
                    <div>
                        <span class="text-xs font-semibold text-green-400 uppercase tracking-wider block mb-3">Strengths</span>
                        <ul class="space-y-3">
                            ${(data.strengths || []).map(s => `
                            <li class="flex items-start gap-2 text-sm leading-relaxed">
                                <span class="text-green-500 mt-0.5 shrink-0">•</span>
                                <span><span class="font-semibold text-white">${s.headline}.</span> <span class="text-gray-300">${s.detail}</span></span>
                            </li>`).join('')}
                        </ul>
                    </div>
                    <div class="border-t border-white/10 pt-4">
                        <span class="text-xs font-semibold text-red-400 uppercase tracking-wider block mb-3">Weaknesses</span>
                        <ul class="space-y-3">
                            ${(data.weaknesses || []).map(w => `
                            <li class="flex items-start gap-2 text-sm leading-relaxed">
                                <span class="text-red-500 mt-0.5 shrink-0">•</span>
                                <span><span class="font-semibold text-white">${w.headline}.</span> <span class="text-gray-300">${w.detail}</span></span>
                            </li>`).join('')}
                        </ul>
                    </div>
                </div>
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase">Macro To-Do</h3>
                    <span class="text-xs text-gray-500">Structural · Plot · Character · Pacing</span>
                </div>
                <div id="stage9-macro-todo-list" class="space-y-2"></div>
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase">Micro To-Do</h3>
                    <span class="text-xs text-gray-500">Scene · Dialogue · Polish</span>
                </div>
                <div id="stage9-micro-todo-list" class="space-y-2"></div>
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase mb-4">Final Recommendation</h3>
                <div class="flex items-start gap-4">
                    <span class="text-lg font-black px-4 py-2 rounded border shrink-0 ${gradeClass(data.recommendation?.grade)}">${data.recommendation?.grade || '—'}</span>
                    <p class="text-gray-300 text-sm leading-relaxed">${data.recommendation?.justification || ''}</p>
                </div>
            </div>`;

        renderTodoList(window.currentMacroTodo, 'macro');
        renderTodoList(window.currentMicroTodo, 'micro');
    }

    function renderTodoList(items, list) {
        const containerId = list === 'micro' ? 'stage9-micro-todo-list' : 'stage9-macro-todo-list';
        const container = document.getElementById(containerId);
        if (!container) return;
        if (!items || items.length === 0) {
            container.innerHTML = '<p class="text-gray-600 text-sm italic">No items.</p>';
            return;
        }
        // Build elements via DOM API so data attributes stay safe and no inline handlers are needed
        container.innerHTML = '';
        items.forEach((item, idx) => {
            const row = document.createElement('div');
            row.className = 'flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10';

            const badge = document.createElement('span');
            badge.className = 'text-xs font-mono font-bold px-2 py-0.5 mt-0.5 rounded border shrink-0 text-blue-400 bg-blue-400/10 border-blue-400/30';
            badge.textContent = `P${item.priority}`;

            const textWrap = document.createElement('div');
            textWrap.className = 'flex-1 min-w-0';

            const ta = document.createElement('textarea');
            ta.className = 'todo-task-input w-full bg-transparent text-sm text-gray-200 resize-none border-none focus:outline-none focus:ring-1 focus:ring-blue-500/40 rounded p-1 leading-relaxed';
            ta.rows = 2;
            ta.dataset.list = list;
            ta.dataset.idx = String(idx);
            ta.value = item.task;  // safe — value property, not innerHTML
            textWrap.appendChild(ta);

            const btnWrap = document.createElement('div');
            btnWrap.className = 'flex flex-col gap-1 shrink-0 pt-1';

            const btnUp = document.createElement('button');
            btnUp.className = 'text-gray-500 hover:text-gray-300 transition-colors leading-none text-xs';
            btnUp.title = 'Move up';
            btnUp.textContent = '▲';
            btnUp.addEventListener('click', () => window.moveTodoItem(idx, -1, list));

            const btnDown = document.createElement('button');
            btnDown.className = 'text-gray-500 hover:text-gray-300 transition-colors leading-none text-xs';
            btnDown.title = 'Move down';
            btnDown.textContent = '▼';
            btnDown.addEventListener('click', () => window.moveTodoItem(idx, 1, list));

            btnWrap.appendChild(btnUp);
            btnWrap.appendChild(btnDown);
            row.appendChild(badge);
            row.appendChild(textWrap);
            row.appendChild(btnWrap);
            container.appendChild(row);
        });
        setTimeout(() => {
            container.querySelectorAll('.todo-task-input').forEach(ta => autoResize(ta));
        }, 50);
    }

    async function saveCoveragePriorities() {
        if (!activeProjectId) return;
        // Flush any in-progress textarea edits into their respective working copies
        document.querySelectorAll('.todo-task-input').forEach(ta => {
            const i = parseInt(ta.dataset.idx);
            const list = ta.dataset.list;
            const arr = list === 'micro' ? window.currentMicroTodo : window.currentMacroTodo;
            if (!isNaN(i) && arr && arr[i]) arr[i].task = ta.value;
        });
        const coverage = window.currentProjectData?.stage8_coverage;
        if (!coverage) {
            console.warn('saveCoveragePriorities: stage8_coverage not found on currentProjectData — skipping save');
            return;
        }
        coverage.macro_todo = window.currentMacroTodo || [];
        coverage.micro_todo = window.currentMicroTodo || [];
        try {
            const saveRes = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { stage8_coverage: coverage } })
            });
            if (!saveRes.ok) throw new Error(`Server returned ${saveRes.status}`);
            const projRes = await fetch(`/api/projects/${activeProjectId}`);
            const projData = await projRes.json();
            window.currentProjectData = projData.data;
        } catch (err) {
            console.error('saveCoveragePriorities failed:', err.message);
            throw err; // Re-throw so the caller can abort
        }
    }

    window.moveTodoItem = function(idx, direction, list) {
        const arr = list === 'micro' ? window.currentMicroTodo : window.currentMacroTodo;
        if (!arr) return;
        // Flush current textarea values for this list first
        document.querySelectorAll(`.todo-task-input[data-list="${list}"]`).forEach(ta => {
            const i = parseInt(ta.dataset.idx);
            if (!isNaN(i) && arr[i]) arr[i].task = ta.value;
        });
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= arr.length) return;
        [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
        arr.forEach((item, i) => { item.priority = i + 1; });
        renderTodoList(arr, list);
    };

    window.retryStage9Coverage = function() {
        initStage9();
    };

    // ─── REUSABLE CHAT WINDOW ────────────────────────────────────────────────

    class ChatWindow {
        constructor({ threadId, inputId, sendBtnId, attachInputId, onSend }) {
            this.thread  = document.getElementById(threadId);
            this.input   = document.getElementById(inputId);
            this.sendBtn = document.getElementById(sendBtnId);
            this.history = [];
            this.pendingFile = null;
            this._chip = null;
            this._attachInput = null;
            if (attachInputId) this._wireAttach(document.getElementById(attachInputId));
            this._wireSend(onSend);
        }

        _wireAttach(attachInput) {
            if (!attachInput) return;
            this._attachInput = attachInput;
            attachInput.addEventListener('change', e => {
                const file = e.target.files[0];
                if (!file) return;
                this.pendingFile = file;
                this._showChip(file.name);
            });
        }

        _showChip(name) {
            this._removeChip();
            const chip = document.createElement('div');
            chip.className = 'chat-attach-chip';
            const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            chip.innerHTML = `<span title="${esc(name)}">${esc(name)}</span><span class="chat-attach-chip-remove" title="Remove">✕</span>`;
            chip.querySelector('.chat-attach-chip-remove').addEventListener('click', () => this._clearAttach());
            this.input.parentElement.insertBefore(chip, this.input);
            this._chip = chip;
        }

        _removeChip() {
            if (this._chip) { this._chip.remove(); this._chip = null; }
        }

        _clearAttach() {
            this.pendingFile = null;
            if (this._attachInput) this._attachInput.value = '';
            this._removeChip();
        }

        async _readFileAsBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => {
                    const bytes = new Uint8Array(e.target.result);
                    let binary = '';
                    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
                    resolve(btoa(binary));
                };
                reader.onerror = reject;
                reader.readAsArrayBuffer(file);
            });
        }

        _wireSend(onSend) {
            const send = async () => {
                const text = this.input.value.trim();
                if (!text || this.sendBtn.disabled) return;

                let attachment = null;
                if (this.pendingFile) {
                    try {
                        const data = await this._readFileAsBase64(this.pendingFile);
                        attachment = { name: this.pendingFile.name, mimeType: this.pendingFile.type || 'application/octet-stream', data };
                    } catch (e) {
                        console.error('File read error:', e);
                    }
                    this._clearAttach();
                }

                this.input.value = '';
                this.input.style.height = 'auto';
                this.append('user', text);
                this.setDisabled(true);
                try {
                    await withChatTimeout(onSend(text, this.history, attachment));
                } catch (err) {
                    console.error('Chat send failed:', err);
                    this.append('ai', err.message || 'Assistant request failed. Try again in a moment.');
                } finally {
                    this.setDisabled(false);
                    this.input.focus();
                }
            };
            this.sendBtn.addEventListener('click', send);
            this.input.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            });
            this.input.addEventListener('input', () => {
                this.input.style.height = 'auto';
                this.input.style.height = Math.min(this.input.scrollHeight, 120) + 'px';
            });
        }

        append(role, content, opts = {}) {
            if (role !== 'system') {
                this.history.push({ role: role === 'ai' ? 'assistant' : 'user', content: typeof content === 'string' ? content : '' });
            }
            const el = document.createElement('div');
            el.className = `chat-message chat-message-${role}`;
            if (opts.html) {
                el.innerHTML = opts.html;
            } else {
                // Render paragraphs: split on blank lines, convert single newlines to <br>
                const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                const paras = esc(content).split(/\n\n+/);
                el.innerHTML = paras.map(p => `<p>${p.replace(/\n/g,'<br>')}</p>`).join('');
            }
            if (opts.withPlanBtn) {
                const btn = document.createElement('button');
                btn.className = 'chat-generate-plan-btn';
                btn.textContent = 'Generate Plan →';
                btn.addEventListener('click', () => { btn.disabled = true; opts.withPlanBtn(); });
                el.appendChild(btn);
            }
            if (opts.actions?.length) {
                const row = document.createElement('div');
                row.className = 'chat-action-row';
                opts.actions.forEach(({ label, onClick }) => {
                    const btn = document.createElement('button');
                    btn.className = 'chat-action-btn';
                    btn.textContent = label;
                    btn.addEventListener('click', () => { btn.disabled = true; onClick(); });
                    row.appendChild(btn);
                });
                el.appendChild(row);
            }
            this.thread.appendChild(el);
            this.thread.scrollTop = this.thread.scrollHeight;
            return el;
        }

        restoreHistory(messages) {
            if (!messages?.length) return;
            this.history = [...messages];
            const sep = document.createElement('div');
            sep.className = 'chat-message chat-message-system';
            sep.textContent = '— previous session —';
            this.thread.appendChild(sep);
            const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            messages.forEach(m => {
                const el = document.createElement('div');
                el.className = `chat-message chat-message-${m.role === 'user' ? 'user' : 'ai'}`;
                const paras = esc(m.content).split(/\n\n+/);
                el.innerHTML = paras.map(p => `<p>${p.replace(/\n/g,'<br>')}</p>`).join('');
                this.thread.appendChild(el);
            });
            const sep2 = document.createElement('div');
            sep2.className = 'chat-message chat-message-system';
            sep2.textContent = '— continuing —';
            this.thread.appendChild(sep2);
            this.thread.scrollTop = this.thread.scrollHeight;
        }

        clear() { this.thread.innerHTML = ''; this.history = []; }
        setDisabled(d) { this.sendBtn.disabled = d; this.input.disabled = d; }

        setThinking(active) {
            const existing = this.thread.querySelector('.chat-thinking');
            if (active && !existing) {
                const el = document.createElement('div');
                el.className = 'chat-bubble ai-bubble chat-thinking';
                el.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
                this.thread.appendChild(el);
                this.thread.scrollTop = this.thread.scrollHeight;
            } else if (!active && existing) {
                existing.remove();
            }
        }
    }

    const stageChatWindows = {};

    function noteSavedSource(chat, savedSource) {
        if (!chat || !savedSource) return;
        const status = savedSource.duplicate
            ? 'Already in project knowledge for reuse across stages'
            : 'Saved to project knowledge for reuse across stages';
        chat.append('system', `${status}: ${savedSource.name}`);
        refreshProjectKnowledgeSummary().catch(err => console.warn('Source library refresh skipped:', err.message));
    }

    function renderSourceMemoryUsageCard(memory = {}) {
        const sources = (memory.sources || []).slice(0, 3);
        const handoffs = (memory.handoffs || []).slice(-3);
        const divergences = (memory.acceptedDivergences || []).slice(0, 2);
        const continuity = (memory.continuity || []).slice(0, 2);
        const rows = [];
        if (sources.length) {
            rows.push(`<li><strong>Sources</strong><span>${sources.map(source => escapeHtml(source.name || 'Untitled source')).join(', ')}</span></li>`);
        }
        if (handoffs.length) {
            rows.push(`<li><strong>Handoffs</strong><span>${handoffs.map(handoff => escapeHtml(handoff.stageName || 'Stage handoff')).join(', ')}</span></li>`);
        }
        if (divergences.length) {
            rows.push(`<li><strong>Divergences</strong><span>${divergences.map(escapeHtml).join('; ')}</span></li>`);
        }
        if (continuity.length) {
            rows.push(`<li><strong>Continuity</strong><span>${continuity.map(escapeHtml).join('; ')}</span></li>`);
        }
        if (!rows.length && memory.summary) {
            rows.push(`<li><strong>Snapshot</strong><span>${escapeHtml(memory.summary)}</span></li>`);
        }
        if (!rows.length) return '';
        return `
            <div class="source-memory-card">
                <div class="source-memory-card-header">
                    <strong>Using project memory</strong>
                    <span>${escapeHtml(memory.stageName || '')}</span>
                </div>
                <ul>${rows.join('')}</ul>
            </div>
        `;
    }

    function noteSourceMemoryUsed(chat, memory) {
        if (!chat || !memory) return;
        const key = memory.key || JSON.stringify(memory);
        chat._sourceMemoryNoticeKeys = chat._sourceMemoryNoticeKeys || new Set();
        if (chat._sourceMemoryNoticeKeys.has(key)) return;
        chat._sourceMemoryNoticeKeys.add(key);
    }

    function isMemoryRecallPrompt(text = '') {
        return /\b(what do (you|we) (already )?(remember|know)|what have we (already )?(established|decided)|what is in project memory|what's in project memory|what do you have in memory|what do you remember)\b/i.test(String(text || ''));
    }

    function sourceAuditHasActionableItems(audit = {}) {
        const mismatches = (audit.possible_source_mismatches || []).filter(Boolean).length;
        const missing = (audit.missing_source_elements || []).filter(Boolean).length;
        const fixes = (audit.recommended_fixes || []).filter(Boolean).length;
        if (mismatches || missing) return true;
        return fixes > 0 && ((audit.sourceCount || 0) > 0 || (audit.acceptedDivergenceCount || 0) > 0);
    }

    function summarizeAuditForUi(audit = {}) {
        const counts = [];
        const mismatches = (audit.possible_source_mismatches || []).filter(Boolean).length;
        const missing = (audit.missing_source_elements || []).filter(Boolean).length;
        const fixes = (audit.recommended_fixes || []).filter(Boolean).length;
        if (mismatches) counts.push(`${mismatches} mismatch${mismatches === 1 ? '' : 'es'}`);
        if (missing) counts.push(`${missing} missing element${missing === 1 ? '' : 's'}`);
        if (fixes) counts.push(`${fixes} recommended fix${fixes === 1 ? '' : 'es'}`);
        return counts.length
            ? `Stage ${audit.stageId}: ${counts.join(', ')}.`
            : `Stage ${audit.stageId}: source audit reviewed with no issues flagged.`;
    }

    function renderSourceReadinessBadge(readiness = {}) {
        const status = String(readiness.status || 'unknown').replace(/[^a-z_-]/g, '');
        return `<span class="source-readiness-pill source-readiness-${escapeHtml(status)}">${escapeHtml(readiness.label || readiness.status || 'Readiness unknown')}</span>`;
    }

    function renderSourceReadinessSummary(readiness = {}) {
        if (!readiness || !readiness.status) return '';
        const checked = readiness.checkedAt ? new Date(readiness.checkedAt).toLocaleString() : 'Not checked';
        const issues = readiness.issueCounts?.total || 0;
        const planStatus = readiness.sourcePlan?.status ? readiness.sourcePlan.status.replace(/_/g, ' ') : 'no recorded plan';
        return `
            <div class="source-readiness-summary">
                ${renderSourceReadinessBadge(readiness)}
                <span>${escapeHtml(checked)}</span>
                <span>${escapeHtml(formatCountLabel(issues, 'issue', 'issues'))}</span>
                <span>${escapeHtml(planStatus)}</span>
            </div>
        `;
    }

    function normalizeSourceWarnings(warnings) {
        return Array.isArray(warnings)
            ? warnings.map(w => String(w || '').trim()).filter(Boolean)
            : [];
    }

    function renderSourceWarningCard(warnings = [], stageId = null) {
        const safeWarnings = normalizeSourceWarnings(warnings);
        if (!safeWarnings.length) return '';
        const stageLabel = STAGE_LABELS?.[Number(stageId)] || (stageId ? `Stage ${stageId}` : 'Stage');
        return `
            <div class="source-warning-card">
                <div class="source-warning-card-header">
                    <strong>Source check note</strong>
                    <span>${escapeHtml(stageLabel)}</span>
                </div>
                <ul>
                    ${safeWarnings.slice(0, 5).map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}
                </ul>
                <p>Use Check Source to compare this stage with your saved project sources.</p>
            </div>
        `;
    }

    function renderPostGenerationSourceCheckCard(readiness = {}, gate = {}, warnings = []) {
        const safeWarnings = normalizeSourceWarnings(warnings);
        const shouldRunAudit = !!gate.shouldRunAudit;
        const primaryLabel = shouldRunAudit ? 'Run Check Source' : 'Show Findings';
        return `
            <div class="source-post-check-card">
                <div class="source-audit-card-header">
                    <strong>Source Check Recommended</strong>
                    <span>${escapeHtml(readiness.stageName || `Stage ${readiness.stageId || ''}`)}</span>
                    ${renderSourceReadinessBadge(readiness)}
                </div>
                ${renderSourceReadinessSummary(readiness)}
                <p>${escapeHtml(gate.message || 'This stage should be checked against saved project source material.')}</p>
                ${safeWarnings.length ? `
                    <ul>
                        ${safeWarnings.slice(0, 3).map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}
                    </ul>
                ` : ''}
                <div class="source-audit-actions">
                    <button type="button" class="source-audit-action-btn source-post-check-primary">${escapeHtml(primaryLabel)}</button>
                    ${shouldRunAudit ? '' : '<button type="button" class="source-audit-action-btn source-post-check-run">Run Fresh Check</button>'}
                    <button type="button" class="source-audit-action-btn source-post-check-dismiss">Dismiss</button>
                </div>
            </div>
        `;
    }

    function showSourceWarningBanner(stageId, warnings = []) {
        const safeWarnings = normalizeSourceWarnings(warnings);
        const workspace = workspaces?.[Number(stageId)];
        if (!workspace || !safeWarnings.length) return;

        workspace.querySelector(`.source-generation-warning[data-source-warning-stage="${stageId}"]`)?.remove();
        const banner = document.createElement('div');
        banner.className = 'source-generation-warning';
        banner.dataset.sourceWarningStage = String(stageId);
        banner.innerHTML = `
            <div>
                <strong>Source check note</strong>
                <span>${escapeHtml(safeWarnings[0])}</span>
            </div>
            <button type="button" class="source-warning-dismiss" title="Dismiss source check note">x</button>
        `;
        banner.querySelector('.source-warning-dismiss')?.addEventListener('click', () => banner.remove());

        const scrollable = Number(stageId) === 10
            ? workspace.querySelector('#stage10-workspace')
            : workspace.querySelector('.workspace-scrollable');
        if (scrollable) {
            scrollable.insertBefore(banner, scrollable.firstChild);
            return;
        }

        const header = workspace.querySelector('.workspace-header');
        if (header?.nextSibling) {
            workspace.insertBefore(banner, header.nextSibling);
        } else {
            workspace.insertBefore(banner, workspace.firstChild);
        }
    }

    const postGenerationSourceChecks = new Set();

    function shouldOfferPostGenerationSourceCheck(readiness = {}, gate = {}, warnings = []) {
        const stageId = Number(readiness.stageId);
        if (!SOURCE_READINESS_STAGES.has(stageId)) return false;
        if (!readiness.sourceCount || !readiness.hasOutput) return false;
        if (gate.shouldRunAudit) return true;
        if (readiness.status === 'issues') return true;
        return normalizeSourceWarnings(warnings).length > 0 && readiness.status !== 'ready' && readiness.status !== 'resolved';
    }

    function postGenerationSourceCheckKey(readiness = {}) {
        return [
            readiness.stageId || 'stage',
            readiness.stageOutputHash || 'nohash',
            readiness.auditStageOutputHash || 'noaudit',
            readiness.status || 'unknown'
        ].join(':');
    }

    function showPostGenerationSourceBanner(stageId, readiness = {}, gate = {}, readinessData = {}) {
        const workspace = workspaces?.[Number(stageId)];
        if (!workspace) return null;
        workspace.querySelector(`.source-post-generation-check[data-source-post-stage="${stageId}"]`)?.remove();
        const banner = document.createElement('div');
        banner.className = 'source-generation-warning source-post-generation-check';
        banner.dataset.sourcePostStage = String(stageId);
        const shouldRunAudit = !!gate.shouldRunAudit;
        banner.innerHTML = `
            <div>
                <strong>Source check recommended</strong>
                <span>${escapeHtml(gate.message || `${readiness.stageName || `Stage ${stageId}`} should be checked against saved source material.`)}</span>
            </div>
            <div class="source-post-check-banner-actions">
                <button type="button" class="source-post-check-banner-run">${shouldRunAudit ? 'Run Check' : 'Show Findings'}</button>
                <button type="button" class="source-warning-dismiss" title="Dismiss source check prompt">x</button>
            </div>
        `;
        banner.querySelector('.source-warning-dismiss')?.addEventListener('click', () => banner.remove());
        banner.querySelector('.source-post-check-banner-run')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            if (shouldRunAudit) {
                await runSourceAudit(stageId, button);
            } else {
                showExistingSourceAudit(stageId, readinessData, button);
            }
            banner.remove();
        });

        const scrollable = Number(stageId) === 10
            ? workspace.querySelector('#stage10-workspace')
            : workspace.querySelector('.workspace-scrollable');
        if (scrollable) {
            scrollable.insertBefore(banner, scrollable.firstChild);
        } else {
            const header = workspace.querySelector('.workspace-header');
            workspace.insertBefore(banner, header?.nextSibling || workspace.firstChild);
        }
        return banner;
    }

    function showExistingSourceAudit(stageId, readinessData = {}, button = null) {
        const chat = stageChatWindows[stageId];
        const audit = readinessData.sourceAudit;
        if (!chat || !audit) {
            if (chat) chat.append('system', 'No saved source audit findings are available for this output yet.');
            return;
        }
        const cardEl = chat.append('system', '', { html: renderSourceAuditCard(audit) });
        wireSourceAuditActions(stageId, audit, cardEl);
        if (button) button.textContent = 'Shown';
    }

    function wirePostGenerationSourceCheckActions(stageId, readinessData = {}, cardEl) {
        if (!cardEl) return;
        const readiness = readinessData.sourceReadiness || {};
        const gate = readinessData.gate || {};
        const shouldRunAudit = !!gate.shouldRunAudit;
        const primaryBtn = cardEl.querySelector('.source-post-check-primary');
        const runBtn = cardEl.querySelector('.source-post-check-run');
        const dismissBtn = cardEl.querySelector('.source-post-check-dismiss');

        primaryBtn?.addEventListener('click', async () => {
            if (shouldRunAudit) {
                await runSourceAudit(stageId, primaryBtn);
            } else {
                showExistingSourceAudit(stageId, readinessData, primaryBtn);
            }
        });
        runBtn?.addEventListener('click', () => runSourceAudit(stageId, runBtn));
        dismissBtn?.addEventListener('click', () => cardEl.remove());
    }

    function showPostGenerationSourceCheck(stageId, readinessData = {}, warnings = [], opts = {}) {
        const readiness = readinessData.sourceReadiness || {};
        const gate = readinessData.gate || {};
        const chat = opts.chat || null;
        if (chat) {
            const cardEl = chat.append('system', '', {
                html: renderPostGenerationSourceCheckCard(readiness, gate, warnings)
            });
            wirePostGenerationSourceCheckActions(stageId, readinessData, cardEl);
            return;
        }
        showPostGenerationSourceBanner(stageId, readiness, gate, readinessData);
    }

    async function runPostGenerationSourceVerification(stageId, opts = {}) {
        if (!activeProjectId || opts.postGenerationCheck === false) return;
        const numericStageId = Number(stageId);
        if (!SOURCE_READINESS_STAGES.has(numericStageId)) return;
        const readinessData = await requestStageSourceReadiness(numericStageId);
        const readiness = readinessData.sourceReadiness || {};
        const gate = readinessData.gate || {};
        if (!shouldOfferPostGenerationSourceCheck(readiness, gate, opts.warnings || [])) return;
        const key = postGenerationSourceCheckKey(readiness);
        if (postGenerationSourceChecks.has(key)) return;
        postGenerationSourceChecks.add(key);
        showPostGenerationSourceCheck(numericStageId, readinessData, opts.warnings || [], opts);
    }

    function queuePostGenerationSourceVerification(stageId, payload = {}, opts = {}) {
        if (opts.postGenerationCheck === false || !activeProjectId) return;
        const warnings = normalizeSourceWarnings(payload?.sourceWarnings);
        window.setTimeout(() => {
            runPostGenerationSourceVerification(stageId, { ...opts, warnings })
                .catch(err => console.warn('Post-generation source check skipped:', err.message));
        }, 0);
    }

    async function handleSourceGenerationResult(stageId, payload = {}, opts = {}) {
        const warnings = normalizeSourceWarnings(payload?.sourceWarnings);
        if (opts.chat) noteSourceMemoryUsed(opts.chat, payload?.sourceMemory);
        if (warnings.length) {
            showSourceWarningBanner(stageId, warnings);
            if (opts.chat) {
                opts.chat.append('system', '', { html: renderSourceWarningCard(warnings, stageId) });
            }
        }
        if (opts.refreshKnowledge === false || !activeProjectId) return;
        await refreshProjectKnowledgeSummary().catch(err => console.warn('Source readiness refresh skipped:', err.message));
    }

    async function requestStageSourceReadiness(stageId) {
        const res = await fetch('/api/source-readiness-stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectId: activeProjectId,
                stageId,
                stageDataOverride: getStageApprovalSnapshot(stageId),
                sceneNumber: sourceRevisionSceneNumber(stageId)
            })
        });
        if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
        const data = await res.json();
        if (data.knowledge) setProjectKnowledge(data.knowledge);
        return data;
    }

    async function requestStageSourceAudit(stageId) {
        const res = await fetch('/api/source-audit-stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectId: activeProjectId,
                stageId,
                stageDataOverride: getStageApprovalSnapshot(stageId),
                sceneNumber: sourceRevisionSceneNumber(stageId)
            })
        });
        if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
        const audit = await res.json();
        if (audit.knowledge) setProjectKnowledge(audit.knowledge);
        return audit;
    }

    function buildSourceAuditRevisionNotes(audit = {}) {
        const lines = [
            `SOURCE ALIGNMENT FIX REQUEST`,
            `Stage: ${audit.stageName || `Stage ${audit.stageId || ''}`}`,
            '',
            'Revise the current stage so it aligns with saved project source material. Preserve existing good work, but prefer concrete source canon over unsupported invention unless an accepted divergence is explicitly noted.'
        ];
        const addSection = (title, items) => {
            const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
            if (!safeItems.length) return;
            lines.push('', `${title}:`);
            safeItems.forEach(item => lines.push(`- ${item}`));
        };
        addSection('POSSIBLE SOURCE MISMATCHES TO RESOLVE', audit.possible_source_mismatches);
        addSection('MISSING SOURCE ELEMENTS TO CONSIDER ADDING', audit.missing_source_elements);
        addSection('RECOMMENDED FIXES', audit.recommended_fixes);
        return lines.join('\n');
    }

    function appendWorkingIndicator(chat, label = 'Applying changes') {
        const el = document.createElement('div');
        el.className = 'chat-message chat-message-working';
        el.innerHTML = `${escapeHtml(label)} <div class="chat-working-dots"><span></span><span></span><span></span></div>`;
        chat.thread.appendChild(el);
        chat.thread.scrollTop = chat.thread.scrollHeight;
        return el;
    }

    async function logKnowledgeDecision(type, stageId, summary, audit) {
        if (!activeProjectId) return;
        const res = await fetch(`/api/projects/${activeProjectId}/knowledge/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, stageId, summary, audit })
        });
        if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
        const data = await res.json();
        setProjectKnowledge(data.knowledge);
    }

    async function saveAcceptedSourceDivergence(stageId, audit) {
        const summary = `Accepted source divergence for ${audit.stageName || `Stage ${stageId}`}: ${summarizeAuditForUi(audit)}`;
        const res = await fetch(`/api/projects/${activeProjectId}/knowledge/accepted-divergence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stageId, summary, audit })
        });
        if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
        const data = await res.json();
        setProjectKnowledge(data.knowledge);
        return data;
    }

    async function acceptSourceDivergence(stageId, audit, button) {
        if (!activeProjectId) return;
        const chat = stageChatWindows[stageId];
        const originalText = button?.textContent || 'Accept Divergence';
        if (button) {
            button.disabled = true;
            button.textContent = 'Saving...';
        }
        try {
            await saveAcceptedSourceDivergence(stageId, audit);
            chat?.append('system', 'Accepted divergence saved to project knowledge.');
            if (button) button.textContent = 'Saved';
        } catch (err) {
            chat?.append('system', 'Could not save accepted divergence: ' + err.message);
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
        }
    }

    function getStageApprovalSnapshot(stageId) {
        try {
            switch (Number(stageId)) {
                case 1: {
                    const expandedCard = document.querySelector('.pitch-card.expanded');
                    const finalData = {};
                    expandedCard?.querySelectorAll('.field-group .editable-field').forEach(field => {
                        finalData[field.getAttribute('data-field')] = field.value;
                    });
                    return { pitch: finalData, notes: stage1Notes?.value ?? '' };
                }
                case 2:
                    return { outline: scrapeOutline() };
                case 3:
                    return { characters: scrapeCharacters() };
                case 4:
                    return scrapeTreatment();
                case 5:
                    return scrapeTreatmentStage5();
                case 6:
                    return scrapeStage6();
                case 7:
                    return stage7CurrentStyle
                        ? { slug: stage7CurrentStyle.slug, content: stage7CurrentStyle.content || stage7CurrentStyle.directive || '' }
                        : { slug: window.currentProjectData?.stage7_style || null, content: '' };
                case 8:
                    stage8FlushEditor();
                    return getFlatScenes().map(scene => ({
                        scene_number: scene.scene_number,
                        slugline: scene.slugline || scene.scene_heading || '',
                        draft_text: scene.humanized_draft_text || scene.draft_text || ''
                    }));
                case 10:
                    return {
                        working: stage10State?.working || {},
                        pending: stage10Pending || {},
                        priority_idx: stage10State?.priority_idx ?? null
                    };
                default:
                    return null;
            }
        } catch (err) {
            console.warn('Could not build approval snapshot:', err.message);
            return null;
        }
    }

    function showSourceReadinessGateModal(stageId, readiness = {}, gate = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay approval-source-modal';
            overlay.innerHTML = `
                <div class="modal-content approval-source-content">
                    <h3>Source Check Recommended</h3>
                    <p>${escapeHtml(gate.message || `${readiness.stageName || `Stage ${stageId}`} should be checked against saved source material before approval.`)}</p>
                    ${renderSourceReadinessSummary(readiness)}
                    <div class="modal-actions approval-source-actions">
                        <button type="button" class="secondary-btn" data-action="cancel">Cancel</button>
                        <button type="button" class="primary-btn" data-action="run">Run Check Source</button>
                    </div>
                </div>
            `;
            const cleanup = (value) => {
                overlay.remove();
                resolve(value);
            };
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) cleanup(false);
            });
            overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => cleanup(false));
            overlay.querySelector('[data-action="run"]')?.addEventListener('click', () => cleanup(true));
            document.body.appendChild(overlay);
        });
    }

    function showApprovalSourceGuardModal(stageId, audit) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay approval-source-modal';
            const issues = [
                ...(audit.possible_source_mismatches || []).map(item => `Mismatch: ${item}`),
                ...(audit.missing_source_elements || []).map(item => `Missing: ${item}`),
                ...(audit.recommended_fixes || []).map(item => `Fix: ${item}`)
            ].filter(Boolean).slice(0, 8);
            overlay.innerHTML = `
                <div class="modal-content approval-source-content">
                    <h3>Source Check Found Issues</h3>
                    <p>${escapeHtml(audit.stageName || `Stage ${stageId}`)} may not fully align with saved project source material.</p>
                    ${renderSourceReadinessSummary(audit.sourceReadiness)}
                    <ul>${issues.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    <div class="modal-actions approval-source-actions">
                        <button type="button" class="secondary-btn" data-action="apply">Apply Fixes</button>
                        <button type="button" class="secondary-btn" data-action="diverge">Accept Divergence</button>
                        <button type="button" class="secondary-btn" data-action="cancel">Cancel</button>
                        <button type="button" class="primary-btn" data-action="approve">Approve Anyway</button>
                    </div>
                </div>
            `;
            const cleanup = (value) => {
                overlay.remove();
                resolve(value);
            };
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) cleanup(false);
            });
            overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => cleanup(false));
            overlay.querySelector('[data-action="approve"]')?.addEventListener('click', async (event) => {
                event.currentTarget.disabled = true;
                try {
                    await logKnowledgeDecision(
                        'source_audit_approved_anyway',
                        stageId,
                        `Approved ${audit.stageName || `Stage ${stageId}`} despite source audit warnings: ${summarizeAuditForUi(audit)}`,
                        audit
                    );
                } catch (err) {
                    console.warn('Approve-anyway decision log failed:', err.message);
                }
                cleanup(true);
            });
            overlay.querySelector('[data-action="diverge"]')?.addEventListener('click', async (event) => {
                event.currentTarget.disabled = true;
                try {
                    await saveAcceptedSourceDivergence(stageId, audit);
                    cleanup(true);
                } catch (err) {
                    alert('Could not save accepted divergence: ' + err.message);
                    event.currentTarget.disabled = false;
                }
            });
            overlay.querySelector('[data-action="apply"]')?.addEventListener('click', async (event) => {
                event.currentTarget.disabled = true;
                const chat = stageChatWindows[stageId];
                if (chat?.applySourceAudit) {
                    await chat.applySourceAudit(audit, event.currentTarget);
                    cleanup(false);
                } else {
                    alert('This stage does not have an automatic source-fix path yet.');
                    event.currentTarget.disabled = false;
                }
            });
            document.body.appendChild(overlay);
        });
    }

    async function runApprovalSourceGuard(stageId, button) {
        return true;
    }

    function showMemoryCurationModal(stageId, proposal, { fallback = false } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay memory-curation-modal';
            const listToText = (items = []) => items.filter(Boolean).join('\n');
            overlay.innerHTML = `
                <div class="modal-content memory-curation-content">
                    <h3>Update Project Memory</h3>
                    <p>${fallback ? 'The AI curator was unavailable, so PageOne prepared a conservative handoff.' : 'Review the proposed memory updates before downstream stages use them.'}</p>
                    <label>Stage Handoff</label>
                    <textarea class="modal-input" data-field="handoff" rows="4">${escapeHtml(proposal.handoff_summary || '')}</textarea>
                    <label>Continuity Watchlist</label>
                    <textarea class="modal-input" data-field="watchlist" rows="4" placeholder="One item per line">${escapeHtml(listToText(proposal.continuity_watchlist_additions))}</textarea>
                    <label>Source Bible Notes</label>
                    <textarea class="modal-input" data-field="bible" rows="4" placeholder="One note per line">${escapeHtml(listToText(proposal.source_bible_notes))}</textarea>
                    <label>Decision Log</label>
                    <textarea class="modal-input" data-field="decision" rows="2">${escapeHtml(proposal.decision_summary || '')}</textarea>
                    <div class="modal-actions">
                        <button type="button" class="secondary-btn" data-action="reject">Reject</button>
                        <button type="button" class="primary-btn" data-action="accept">Save Memory</button>
                    </div>
                </div>
            `;
            const readLines = (field) => (overlay.querySelector(`[data-field="${field}"]`)?.value || '')
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);
            const cleanup = (value) => {
                overlay.remove();
                resolve(value);
            };
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) cleanup(false);
            });
            overlay.querySelector('[data-action="reject"]')?.addEventListener('click', () => cleanup(false));
            overlay.querySelector('[data-action="accept"]')?.addEventListener('click', async (event) => {
                event.currentTarget.disabled = true;
                const editedProposal = {
                    stageId,
                    stageName: proposal.stageName,
                    handoff_summary: overlay.querySelector('[data-field="handoff"]')?.value.trim() || proposal.handoff_summary || '',
                    continuity_watchlist_additions: readLines('watchlist'),
                    source_bible_notes: readLines('bible'),
                    decision_summary: overlay.querySelector('[data-field="decision"]')?.value.trim() || proposal.decision_summary || ''
                };
                try {
                    const res = await fetch(`/api/projects/${activeProjectId}/knowledge/apply-stage-curation`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ stageId, proposal: editedProposal })
                    });
                    if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
                    const data = await res.json();
                    setProjectKnowledge(data.knowledge);
                    cleanup(true);
                } catch (err) {
                    alert('Could not save project memory: ' + err.message);
                    event.currentTarget.disabled = false;
                }
            });
            document.body.appendChild(overlay);
        });
    }

    async function refreshStageMemoryHandoff(stageId) {
        if (!activeProjectId) return false;
        try {
            const res = await fetch(`/api/projects/${activeProjectId}/knowledge/refresh-stage-handoff`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stageId, stageDataOverride: getStageApprovalSnapshot(stageId) })
            });
            if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
            const data = await res.json();
            setProjectKnowledge(data.knowledge);
            return true;
        } catch (err) {
            console.warn('Automatic stage handoff skipped:', err.message);
            return false;
        }
    }

    async function offerStageMemoryCuration(stageId) {
        if (!activeProjectId) return false;
        return await refreshStageMemoryHandoff(stageId);
    }

    function renderSourceAuditCard(audit) {
        const renderList = (title, items, emptyText) => {
            const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
            const body = safeItems.length
                ? `<ul>${safeItems.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
                : `<p class="source-audit-empty">${escapeHtml(emptyText)}</p>`;
            return `<section><h4>${escapeHtml(title)}</h4>${body}</section>`;
        };
        const sourceRefs = (audit.source_references || []).slice(0, 5);
        return `
            <div class="source-audit-card">
                <div class="source-audit-card-header">
                    <strong>Source Alignment</strong>
                    <span>${escapeHtml(audit.stageName || `Stage ${audit.stageId || ''}`)} - ${audit.sourceCount || 0} source${audit.sourceCount === 1 ? '' : 's'}</span>
                    ${audit.sourceReadiness ? renderSourceReadinessBadge(audit.sourceReadiness) : ''}
                </div>
                ${renderSourceReadinessSummary(audit.sourceReadiness)}
                ${sourceRefs.length ? `
                    <section>
                        <h4>Sources Consulted</h4>
                        <div class="source-audit-references">
                            ${sourceRefs.map(ref => `
                                <div class="source-audit-reference">
                                    <strong>${escapeHtml(ref.name || 'Source')}</strong>
                                    <span>${escapeHtml(ref.sourceId || ref.label || '')}</span>
                                    ${ref.excerpt ? `<p>${escapeHtml(ref.excerpt)}</p>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </section>
                ` : ''}
                ${renderList('Aligned', audit.aligned_items, 'No clear source alignments found yet.')}
                ${renderList('Possible Mismatches', audit.possible_source_mismatches, 'No source mismatches flagged.')}
                ${renderList('Missing Source Elements', audit.missing_source_elements, 'No missing source elements flagged.')}
                ${renderList('Recommended Fixes', audit.recommended_fixes, 'No fixes recommended.')}
                ${sourceAuditHasActionableItems(audit) ? `
                    <div class="source-audit-actions">
                        <button type="button" class="source-audit-action-btn source-audit-apply">Apply Recommended Fixes</button>
                        <button type="button" class="source-audit-action-btn source-audit-divergence">Accept Divergence</button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    function renderSourcePlanCard(plan) {
        const renderList = (title, items, emptyText) => {
            const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
            return `
                <section>
                    <h4>${escapeHtml(title)}</h4>
                    ${safeItems.length
                        ? `<ul>${safeItems.map(item => `<li>${escapeHtml(formatKnowledgeItemForUi(item))}</li>`).join('')}</ul>`
                        : `<p class="source-audit-empty">${escapeHtml(emptyText)}</p>`}
                </section>
            `;
        };
        const refs = (plan.sourceReferences || []).slice(0, 6);
        const cached = plan.cachedPlan || null;
        const freshness = plan.freshness || cached?.status || 'not_used';
        const statusCopy = {
            used: 'Used in last generation',
            stale: 'Plan stale',
            cached: 'Cached',
            not_used: 'Not used yet'
        };
        const statusClass = String(freshness).replace(/[^a-z_-]/g, '');
        const lastUsed = cached?.lastUsedAt ? new Date(cached.lastUsedAt).toLocaleString() : '';
        const cachedRefs = (cached?.sourceReferences || []).slice(0, 4);
        const localWarnings = (cached?.localCheck?.warnings || []).map(warning => warning.message || warning);
        const memorySnapshot = plan.memorySnapshot || cached?.memorySnapshot || null;
        const snapshotUsed = !!(plan.usesMemorySnapshot || cached?.memorySnapshotUsed || memorySnapshot?.hasSnapshot);
        const snapshotLines = [];
        if (memorySnapshot?.summary) snapshotLines.push(memorySnapshot.summary);
        if (memorySnapshot?.stageHandoffs?.length) {
            snapshotLines.push(...memorySnapshot.stageHandoffs.slice(-3).map(item => `${item.stageName || `Stage ${item.stageId || ''}`}: ${item.summary || formatKnowledgeItemForUi(item)}`));
        }
        if (memorySnapshot?.continuityWatchlist?.length) {
            snapshotLines.push(...memorySnapshot.continuityWatchlist.slice(-3));
        }
        return `
            <div class="source-audit-card source-plan-card">
                <div class="source-audit-card-header">
                    <strong>Source Use Plan</strong>
                    <span>${escapeHtml(plan.stageName || `Stage ${plan.stageId || ''}`)} - ${escapeHtml(plan.profile || 'Project source plan')}</span>
                    <span class="source-plan-status source-plan-status-${escapeHtml(statusClass)}">${escapeHtml(statusCopy[freshness] || statusCopy.not_used)}</span>
                    ${snapshotUsed ? '<span class="source-plan-status source-plan-status-used">Snapshot used</span>' : ''}
                </div>
                ${lastUsed ? `<p class="source-plan-meta">Last generation use: ${escapeHtml(lastUsed)}${cached?.reason ? ` (${escapeHtml(cached.reason.replace(/_/g, ' '))})` : ''}</p>` : '<p class="source-plan-meta">This plan has not been recorded by a generation or revision yet.</p>'}
                ${freshness === 'stale' ? '<p class="source-plan-meta source-plan-warning">The current stage text differs from the last recorded source-plan use.</p>' : ''}
                ${plan.hasKnowledge ? '' : '<p class="source-audit-empty">No saved project knowledge yet. Upload source material or add project notes first.</p>'}
                ${snapshotLines.length ? renderList('Compact Memory Snapshot', snapshotLines.slice(0, 6), 'No compact memory snapshot available.') : ''}
                ${renderList('Stage Rules', plan.directives, 'No stage-specific rules available.')}
                ${plan.handoff ? renderList('Current Handoff', [plan.handoff], '') : ''}
                ${renderList('Continuity To Preserve', plan.continuityWatchlist, 'No continuity items selected.')}
                ${renderList('Accepted Divergences', plan.acceptedDivergences, 'No accepted divergences for this stage.')}
                ${cachedRefs.length ? renderList('Last Used Sources', cachedRefs.map(ref => `${ref.name || ref.sourceId || 'Source'}${ref.label ? ` - ${ref.label}` : ''}`), 'No cached source references yet.') : ''}
                ${localWarnings.length ? renderList('Local Warnings', localWarnings, 'No local warnings.') : ''}
                ${refs.length ? `
                    <section>
                        <h4>Source References</h4>
                        <div class="source-audit-references">
                            ${refs.map(ref => `
                                <div class="source-audit-reference">
                                    <strong>${escapeHtml(ref.name || 'Source')}</strong>
                                    <span>${escapeHtml(ref.sourceId || ref.label || '')}</span>
                                    ${ref.excerpt ? `<p>${escapeHtml(ref.excerpt)}</p>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </section>
                ` : ''}
            </div>
        `;
    }

    function renderSourceFixCard(revision = {}) {
        return `
            <div class="source-audit-card source-fix-card">
                <div class="source-audit-card-header">
                    <strong>Source Fix Applied</strong>
                    <span>${escapeHtml(revision.stageName || `Stage ${revision.stageId || ''}`)}</span>
                    ${revision.sourceReadiness ? renderSourceReadinessBadge(revision.sourceReadiness) : ''}
                </div>
                ${renderSourceReadinessSummary(revision.sourceReadiness)}
                <section>
                    <h4>Targeted Findings</h4>
                    <p class="source-fix-summary">${escapeHtml(revision.sourceFixSummary || 'Source audit fixes were applied.')}</p>
                </section>
                ${revision.stageId === 8 && revision.result?.scene_number ? `
                    <section>
                        <h4>Scene</h4>
                        <p class="source-fix-summary">Scene ${escapeHtml(revision.result.scene_number)} was revised and rechecked for continuity.</p>
                    </section>
                ` : ''}
            </div>
        `;
    }

    function wireSourceAuditActions(stageId, audit, cardEl) {
        if (!cardEl) return;
        const chat = stageChatWindows[stageId];
        const applyBtn = cardEl.querySelector('.source-audit-apply');
        const divergenceBtn = cardEl.querySelector('.source-audit-divergence');
        if (applyBtn) {
            if (chat?.applySourceAudit) {
                applyBtn.addEventListener('click', () => chat.applySourceAudit(audit, applyBtn));
            } else {
                applyBtn.disabled = true;
                applyBtn.title = 'This stage does not have an automatic source-fix path yet.';
            }
        }
        if (divergenceBtn) {
            divergenceBtn.addEventListener('click', () => acceptSourceDivergence(stageId, audit, divergenceBtn));
        }
    }

    async function refreshCurrentProjectData() {
        if (!activeProjectId) return null;
        const res = await fetch(`/api/projects/${activeProjectId}?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Project refresh failed (${res.status})`);
        const project = await res.json();
        window.currentProjectData = project.data;
        updateStageNav(project.data);
        await refreshProjectKnowledgeSummary().catch(err => console.warn('Source readiness refresh skipped:', err.message));
        return project.data;
    }

    function sourceRevisionSceneNumber(stageId) {
        return Number(stageId) === 8 ? currentDraftSceneNumber : null;
    }

    function applySourceRevisionResult(stageId, data = {}) {
        const result = data.result;
        if (!window.currentProjectData) window.currentProjectData = {};
        if (Number(stageId) === 2 && result?.outline) {
            window.currentProjectData.stage2_outline = result;
            renderOutline(result.outline);
            if (btnStage2Approve) { btnStage2Approve.textContent = 'Approve'; btnStage2Approve.classList.remove('approve-btn-green'); }
        } else if (Number(stageId) === 3 && result?.characters) {
            window.currentProjectData.stage3_characters = result;
            renderCharacters(result.characters);
            if (btnStage3Approve) { btnStage3Approve.textContent = 'Approve'; btnStage3Approve.classList.remove('approve-btn-green'); }
        } else if (Number(stageId) === 4 && result) {
            window.currentProjectData.stage4_beats = result;
            renderTreatment(result);
            if (btnStage4Approve) { btnStage4Approve.textContent = 'Approve'; btnStage4Approve.classList.remove('approve-btn-green'); }
        } else if (Number(stageId) === 5 && result) {
            window.currentProjectData.stage5_treatment = result;
            renderTreatmentStage5(result);
            if (btnStage5Approve) { btnStage5Approve.textContent = 'Approve'; btnStage5Approve.classList.remove('approve-btn-green'); }
        } else if (Number(stageId) === 6 && result) {
            window.currentProjectData.stage6_scenes = result;
            renderStage6(result);
            if (btnStage6Approve) { btnStage6Approve.textContent = 'Approve'; btnStage6Approve.classList.remove('approve-btn-green'); }
        } else if (Number(stageId) === 8 && result) {
            stage8LoadEditor(result.humanized_draft_text || result.draft_text || '');
            showContinuityFeedback(result);
            if (btnNextScene) btnNextScene.classList.remove('hidden');
        }
    }

    async function applySourceAuditRevision(stageId, audit, button) {
        const supported = [2, 3, 4, 5, 6, 8].includes(Number(stageId));
        if (!supported) return null;

        const res = await fetch('/api/source-revise-stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectId: activeProjectId,
                stageId,
                audit,
                stageDataOverride: getStageApprovalSnapshot(stageId),
                sceneNumber: sourceRevisionSceneNumber(stageId)
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
            throw new Error(err.error || `Server error ${res.status}`);
        }
        const data = await res.json();
        applySourceRevisionResult(stageId, data);
        if (data.knowledge) setProjectKnowledge(data.knowledge);
        await handleSourceGenerationResult(stageId, data, { chat: stageChatWindows[stageId] });
        await refreshCurrentProjectData().catch(err => console.warn(err.message));
        return data;
    }

    async function runSourceAudit(stageId, button) {
        if (!activeProjectId) return;
        const chat = stageChatWindows[stageId];
        const originalText = button?.textContent || 'Check Source';
        if (button) {
            button.disabled = true;
            button.textContent = 'Checking...';
        }
        const pending = chat?.append('system', 'Checking against project source material...');
        try {
            const audit = await requestStageSourceAudit(stageId);
            pending?.remove();
            if (chat) {
                const cardEl = chat.append('system', '', { html: renderSourceAuditCard(audit) });
                wireSourceAuditActions(stageId, audit, cardEl);
            }
            if (audit.knowledge) {
                renderSourceLibrary(audit.knowledge);
                await loadKnowledgeDiagnostics().catch(err => console.warn('Knowledge diagnostics refresh skipped:', err.message));
            }
            setSourceLibraryStatus(`${STAGE_LABELS[stageId] || `Stage ${stageId}`} source check updated.`);
        } catch (err) {
            pending?.remove();
            if (chat) chat.append('system', 'Source check failed: ' + err.message);
            setSourceLibraryStatus('Source check failed: ' + err.message, true);
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
        }
    }

    async function runSourcePlan(stageId, button) {
        if (!activeProjectId) return;
        const chat = stageChatWindows[stageId];
        if (!chat) return;
        const originalText = button?.textContent || 'Source Plan';
        if (button) {
            button.disabled = true;
            button.textContent = 'Planning...';
        }
        const pending = chat.append('system', 'Building source use plan...');
        try {
            const res = await fetch('/api/source-plan-stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: activeProjectId,
                    stageId,
                    stageDataOverride: getStageApprovalSnapshot(stageId),
                    sceneNumber: sourceRevisionSceneNumber(stageId)
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
                throw new Error(err.error || `Server error ${res.status}`);
            }
            const plan = await res.json();
            pending.remove();
            chat.append('system', '', { html: renderSourcePlanCard(plan) });
        } catch (err) {
            pending.remove();
            chat.append('system', 'Source plan failed: ' + err.message);
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
        }
    }

    function addSourceAuditButton(stageId) {
        if (![1, 2, 3, 4, 5, 6, 7, 8, 10].includes(stageId)) return;
        const chatEl = document.getElementById(`stage${stageId}-chat`);
        const header = chatEl?.querySelector('.chat-header');
        if (!header || header.querySelector('.source-audit-btn')) return;
        const collapseBtn = header.querySelector('.chat-collapse-btn');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'source-audit-btn';
        btn.textContent = 'Check Source';
        btn.title = 'Check this stage against saved project source material';
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            runSourceAudit(stageId, btn);
        });
        header.insertBefore(btn, collapseBtn || null);
    }

    function addSourcePlanButton(stageId) {
        if (![1, 2, 3, 4, 5, 6, 7, 8, 10].includes(stageId)) return;
        const chatEl = document.getElementById(`stage${stageId}-chat`);
        const header = chatEl?.querySelector('.chat-header');
        if (!header || header.querySelector('.source-plan-btn')) return;
        const collapseBtn = header.querySelector('.chat-collapse-btn');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'source-plan-btn';
        btn.textContent = 'Source Plan';
        btn.title = 'Preview which saved sources will guide this stage';
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            runSourcePlan(stageId, btn);
        });
        header.insertBefore(btn, collapseBtn || null);
    }

    // ─── STAGES 1–7 CHAT ─────────────────────────────────────────────────────

    async function readSSEStream(response, onEvent) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const processEventBlock = async (block) => {
            const dataLines = [];
            let eventName = '';
            for (const rawLine of String(block || '').split(/\r?\n/)) {
                const line = rawLine.trimEnd();
                if (!line || line.startsWith(':')) continue;
                if (line.startsWith('event:')) {
                    eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).trimStart());
                }
            }
            if (!dataLines.length) return;
            const event = JSON.parse(dataLines.join('\n'));
            if (eventName && !event.type) event.type = eventName;
            await onEvent(event);
        };
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                buffer += decoder.decode();
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            for (const block of blocks) {
                await processEventBlock(block);
            }
        }
        if (buffer.trim()) await processEventBlock(buffer.trim());
    }

    function withChatTimeout(promise, ms = 10 * 60 * 1000) {
        let timeoutId;
        const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error('Assistant request timed out. Try again in a moment.'));
            }, ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
    }

    function resetStageChatForNewArtifact(stageId, message) {
        const chat = stageChatWindows[stageId];
        if (!chat) return;
        chat.clear();
        chat.setDisabled(false);
        if (message) chat.append('system', message);
    }

    const revisionProposalPattern = /\b(want me to|should we|do you want|revise|revising|revision|update|align|work that|apply|applying|change|improve|sequence\s*5|kaiju march|source spiritually|faithful|flow)\b/i;
    const assistantErrorPattern = /^(error:|something went wrong|assistant request timed out|application failed|failed to respond)/i;

    function isAssistantErrorMessage(content = '') {
        return assistantErrorPattern.test(String(content || '').trim());
    }

    function isRevisionStatusQuestion(content = '') {
        const clean = String(content || '').trim();
        if (!/[?]/.test(clean)) return false;
        return /\b(did you|did it|really|actually|show up|showing|not show|isn't showing|is not showing|doesn't show|does not show|verify|check|confirm|was it applied|has it been applied|have you)\b/i.test(clean);
    }

    function findRecentRevisionProposal(history = []) {
        return history
            .slice(0, -1)
            .reverse()
            .find(m => m.role === 'assistant'
                && typeof m.content === 'string'
                && m.content.trim()
                && !isAssistantErrorMessage(m.content)
                && revisionProposalPattern.test(m.content));
    }

    function isRevisionConfirmation(text = '', history = []) {
        const clean = String(text || '').trim();
        if (!clean || clean.length > 240) return false;
        if (isRevisionStatusQuestion(clean)) return false;
        const asksForAnalysis = /[?]/.test(clean) &&
            /\b(how|what|why|which|are there|do we|does|compare|analysis|analy[sz]e|audit|missing|need|thoughts)\b/i.test(clean);
        if (asksForAnalysis) return false;
        const lower = clean.toLowerCase();
        const affirmative = /\b(yes|yep|yeah|sure|ok|okay|go ahead|do it|apply|revise|revising|make the change|sounds good|i'm ok|i am ok|fine)\b/.test(lower);
        if (!affirmative) return false;
        return Boolean(findRecentRevisionProposal(history));
    }

    function revisionReceiptChanged(result = {}) {
        const receipt = result?.revisionReceipt || result?.receipt || null;
        if (revisionReceiptFailed(result)) return false;
        return receipt?.changed === true || receipt?.verified === true || Number(receipt?.appliedOperationCount || 0) > 0;
    }

    function revisionReceiptFailed(result = {}) {
        const receipt = result?.revisionReceipt || result?.receipt || null;
        return Array.isArray(receipt?.failures) && receipt.failures.length > 0;
    }

    function initStageChat({ stageId, threadId, inputId, sendBtnId, executeRevision, attachInputId: explicitAttachId }) {
        // Guard: skip silently if any required element is missing
        if (!document.getElementById(sendBtnId) || !document.getElementById(inputId) || !document.getElementById(threadId)) {
            console.warn(`initStageChat: missing element(s) for stage ${stageId}`);
            return null;
        }
        let pendingRevision = false;
        let pendingNotes = '';
        const chat = new ChatWindow({
            threadId, inputId, sendBtnId,
            attachInputId: explicitAttachId === false ? null : (explicitAttachId || `stage${stageId}-chat-attach`),
            onSend: async (_text, history, attachment) => {
                const showWorking = () => {
                    const el = document.createElement('div');
                    el.className = 'chat-message chat-message-working';
                    el.innerHTML = 'Applying changes <div class="chat-working-dots"><span></span><span></span><span></span></div>';
                    chat.thread.appendChild(el);
                    chat.thread.scrollTop = chat.thread.scrollHeight;
                    return el;
                };

                // Build revision notes that include user requests, the assistant's
                // latest concrete proposal, and the final execution acknowledgement.
                const buildRevisionNotes = (assistantSummary, conversationHistory) => {
                    const userMessages = conversationHistory.filter(m => m.role === 'user');
                    const latestUserMessage = userMessages[userMessages.length - 1]?.content || '';
                    const allUserMessages = userMessages
                        .map(m => m.content)
                        .join('\n');
                    const recentAssistantMessages = conversationHistory
                        .filter(m => m.role === 'assistant'
                            && typeof m.content === 'string'
                            && m.content.trim()
                            && !isAssistantErrorMessage(m.content))
                        .slice(-4)
                        .map(m => m.content.trim())
                        .join('\n\n---\n\n');
                    const recentConversation = conversationHistory
                        .slice(-10)
                        .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content || ''}`)
                        .join('\n\n---\n\n');
                    const latestIsConfirmation = /\b(yes|yep|yeah|sure|ok|okay|do it|go ahead|apply|refine|revise|sounds good|make it|let's do it)\b/i.test(latestUserMessage)
                        && latestUserMessage.length < 120;
                    const confirmationHandoff = latestIsConfirmation
                        ? '\n\nCONFIRMATION HANDOFF:\nThe latest user message is a short confirmation. Apply the most recent concrete revision proposal from RECENT ASSISTANT CONTEXT and RECENT CONVERSATION CONTEXT; do not treat the confirmation text alone as the full brief.'
                        : '';
                    return `LATEST USER REQUEST:\n${latestUserMessage}\n\nUSER REQUESTS:\n${allUserMessages}${confirmationHandoff}\n\nRECENT ASSISTANT CONTEXT:\n${recentAssistantMessages || 'No prior assistant proposal captured.'}\n\nRECENT CONVERSATION CONTEXT:\n${recentConversation}\n\nASSISTANT DIRECTION:\n${assistantSummary}`;
                };

                const postRevisionFollowUp = async (revisionResult = {}) => {
                    const changedScenes = Array.isArray(revisionResult.changedSceneNumbers)
                        ? revisionResult.changedSceneNumbers
                            .filter(n => Number.isFinite(Number(n)))
                            .map(n => Number(n))
                            .sort((a, b) => a - b)
                        : [];
                    const sceneNote = changedScenes.length
                        ? ` Changed scenes: ${changedScenes.join(', ')}.`
                        : '';
                    const receiptSummary = revisionResult?.revisionReceipt?.summary
                        ? ` Verified: ${revisionResult.revisionReceipt.summary}`
                        : '';
                    const outputName = Number(stageId) === 6
                        ? 'scene blueprint'
                        : (STAGE_LABELS[stageId] || 'stage output').toLowerCase();
                    chat.append('ai', `Applied to the saved ${outputName}.${sceneNote}${receiptSummary} Review the updated output before treating any broader feedback list as complete.`);
                };

                const assertRevisionApplied = (revisionResult, message = 'The revision engine did not report saved changes, so I did not mark this as applied.') => {
                    if (!revisionResult || revisionResult.changed === false) {
                        throw new Error(message);
                    }
                };

                if (pendingRevision && !attachment && isRevisionConfirmation(_text, history)) {
                    const notesForRevision = pendingNotes;
                    pendingRevision = false;
                    pendingNotes = '';
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        const revisionResult = await executeRevision(buildRevisionNotes(notesForRevision, history));
                        assertRevisionApplied(revisionResult, 'The revision engine returned no saved changes, so I did not mark this as applied.');
                        indicator.remove();
                        await postRevisionFollowUp(revisionResult);
                    } catch (err) {
                        indicator.remove();
                        chat.append('ai', 'Something went wrong: ' + err.message);
                    } finally {
                        chat.setDisabled(false);
                    }
                    return;
                }
                if (pendingRevision) {
                    pendingRevision = false;
                    pendingNotes = '';
                }

                if (Number(stageId) === 2 && isStage2DirectRevisionRequest(_text)) {
                    chat.append('ai', 'Applying those outline changes now.');
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        const revisionResult = await executeRevision(`DIRECT USER REVISION REQUEST:\n${_text}`);
                        assertRevisionApplied(revisionResult, 'The outline revision returned no saved changes, so I did not mark this as applied.');
                        indicator.remove();
                        await postRevisionFollowUp(revisionResult);
                    } catch (err) {
                        indicator.remove();
                        chat.append('ai', 'I tried to apply that, but the outline revision failed: ' + err.message);
                    } finally {
                        chat.setDisabled(false);
                    }
                    return;
                }

                if (executeRevision && !attachment && isRevisionConfirmation(_text, history)) {
                    chat.append('ai', 'On it — applying that revision now.');
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        const revisionResult = await executeRevision(buildRevisionNotes('Apply the most recent concrete assistant revision proposal while preserving the user constraints in the latest confirmation.', history));
                        assertRevisionApplied(revisionResult, 'The revision engine returned no saved changes, so I did not mark this as applied.');
                        indicator.remove();
                        await postRevisionFollowUp(revisionResult);
                    } catch (err) {
                        indicator.remove();
                        chat.append('ai', 'Something went wrong: ' + err.message);
                    } finally {
                        chat.setDisabled(false);
                    }
                    return;
                }

                if (Number(stageId) === 3 && isStage3DirectRevisionRequest(_text)) {
                    chat.append('ai', 'Applying those character changes now.');
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        const revisionResult = await executeRevision(`DIRECT USER REVISION REQUEST:\n${_text}`);
                        assertRevisionApplied(revisionResult, 'The character revision returned no saved changes, so I did not mark this as applied.');
                        indicator.remove();
                        await postRevisionFollowUp(revisionResult);
                    } catch (err) {
                        indicator.remove();
                        chat.append('ai', 'I tried to apply that, but the character revision failed: ' + err.message);
                    } finally {
                        chat.setDisabled(false);
                    }
                    return;
                }

                if (Number(stageId) === 6 && isStage6DirectRevisionRequest(_text)) {
                    chat.append('ai', 'Applying those changes to the scene blueprint now.');
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        const revisionResult = await executeRevision(`DIRECT USER REVISION REQUEST:\n${_text}`);
                        assertRevisionApplied(revisionResult, 'The revision engine returned no blueprint changes, so I did not mark this as applied.');
                        indicator.remove();
                        await postRevisionFollowUp(revisionResult);
                    } catch (err) {
                        indicator.remove();
                        chat.append('ai', 'I tried to apply that, but the saved blueprint came back unchanged: ' + err.message);
                    } finally {
                        chat.setDisabled(false);
                    }
                    return;
                }

                let data;
                chat.setThinking(true);
                try {
                    const res = await fetch('/api/brainstorm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: activeProjectId, stageId, messages: history, ...(attachment && { attachment }) })
                    });
                    if (!res.ok) {
                        const errorMessage = await apiErrorMessage(res, 'Assistant request failed');
                        chat.setThinking(false);
                        chat.append('ai', 'Error: ' + errorMessage);
                        return;
                    }
                    data = await res.json();
                } catch (err) {
                    chat.setThinking(false);
                    chat.append('ai', 'Error: ' + err.message);
                    return;
                }
                chat.setThinking(false);
                noteSavedSource(chat, data.savedSource);
                noteSourceMemoryUsed(chat, data.sourceMemory);
                if (normalizeSourceWarnings(data.sourceWarnings).length) {
                    await handleSourceGenerationResult(stageId, data, { chat, postGenerationCheck: false });
                }
                const stage6AnalysisOnlyFeedback = Number(stageId) === 6 && isStage6AnalysisOnlyFeedback(_text);
                if (stage6AnalysisOnlyFeedback && data.suggest_plan) {
                    data = { ...data, suggest_plan: false, execute_immediately: false };
                }
                chat.append('ai', data.message);
                if (data.suggest_plan && data.execute_immediately) {
                    // Clear directive — execute revision immediately, no confirmation needed
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        const revisionResult = await executeRevision(buildRevisionNotes(data.message, history));
                        assertRevisionApplied(revisionResult, 'The revision engine returned no saved changes, so I did not mark this as applied.');
                        indicator.remove();
                        await postRevisionFollowUp(revisionResult);
                    } catch (err) {
                        indicator.remove();
                        chat.append('ai', 'Something went wrong: ' + err.message);
                    } finally {
                        chat.setDisabled(false);
                    }
                } else if (data.suggest_plan) {
                    // Brainstorm reached plan readiness — wait for user confirmation
                    pendingRevision = true;
                    pendingNotes = data.message;
                }
            }
        });
        chat.applySourceAudit = async (audit, button) => {
            if (!executeRevision) {
                chat.append('system', 'This stage does not have an automatic source-fix path yet.');
                return;
            }
            const originalText = button?.textContent || 'Apply Recommended Fixes';
            if (button) {
                button.disabled = true;
                button.textContent = 'Applying...';
            }
            chat.setDisabled(true);
            const indicator = appendWorkingIndicator(chat, 'Applying source fixes');
            try {
                const sourceRevision = await applySourceAuditRevision(stageId, audit, button);
                if (!sourceRevision) {
                    await executeRevision(buildSourceAuditRevisionNotes(audit));
                    await logKnowledgeDecision(
                        'source_audit_fixes_applied',
                        stageId,
                        `Applied source audit fixes for ${audit.stageName || `Stage ${stageId}`}: ${summarizeAuditForUi(audit)}`,
                        audit
                    );
                }
                indicator.remove();
                if (sourceRevision) {
                    chat.append('system', '', { html: renderSourceFixCard(sourceRevision) });
                } else {
                    chat.append('system', 'Applied source fixes and logged the decision.');
                }
                if (button) button.textContent = 'Applied';
            } catch (err) {
                indicator.remove();
                chat.append('ai', 'Something went wrong applying source fixes: ' + err.message);
                if (button) {
                    button.disabled = false;
                    button.textContent = originalText;
                }
            } finally {
                chat.setDisabled(false);
            }
        };
        return chat;
    }

    // Stage 1
    stageChatWindows[1] = initStageChat({
        stageId: 1,
        threadId: 'stage1-chat-thread',
        inputId: 'stage1-chat-input',
        sendBtnId: 'stage1-chat-send',
        executeRevision: async (notes) => {
            const expandedCard = document.querySelector('.pitch-card.expanded');
            if (!expandedCard) throw new Error('No pitch selected yet.');
            const currentFields = expandedCard.querySelectorAll('.field-group .editable-field');
            const currentPitch = {};
            currentFields.forEach(f => { currentPitch[f.getAttribute('data-field')] = f.value; });
            const formData = new FormData();
            formData.append('currentPitch', JSON.stringify(currentPitch));
            formData.append('userNote', notes);
            if (activeProjectId) formData.append('projectId', activeProjectId);
            const res = await fetch('/api/refine-pitch', { method: 'POST', body: formData });
            if (!res.ok) throw new Error(await apiErrorMessage(res, 'Pitch revision failed'));
            const data = await res.json();
            await handleSourceGenerationResult(1, data, { chat: stageChatWindows[1] });
            let updatedPitch = null;
            if (data.result) {
                currentFields.forEach(f => {
                    const key = f.getAttribute('data-field');
                    if (data.result[key]) {
                        f.value = key === 'synopsis'
                            ? (data.result[key] || '').replace(/(?:\s*)(Act 2:)/ig, '\n\n$1').replace(/(?:\s*)(Act 3:)/ig, '\n\n$1').trim()
                            : data.result[key];
                    }
                });
                toggleStage1EditMode(false);
                // Auto-save revised pitch so changes survive a refresh
                updatedPitch = {};
                currentFields.forEach(f => { updatedPitch[f.getAttribute('data-field')] = f.value; });
                if (window.currentProjectData) window.currentProjectData.stage1_pitch = { pitch: updatedPitch };
                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { stage1_pitch: { pitch: updatedPitch, notes: stage1Notes?.value ?? '' } } })
                });
            }
            return {
                ...data,
                changed: data.changed !== false && JSON.stringify(currentPitch) !== JSON.stringify(updatedPitch || data.result || {})
            };
        }
    });

    // Stage 2
    stageChatWindows[2] = initStageChat({
        stageId: 2,
        threadId: 'stage2-chat-thread',
        inputId: 'stage2-chat-input',
        sendBtnId: 'stage2-chat-send',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            const currentBeats = scrapeOutline();
            const formData = new FormData();
            formData.append('projectId', activeProjectId);
            formData.append('currentBeats', JSON.stringify(currentBeats));
            formData.append('notes', notes);
            formData.append('stream', 'true');
            const res = await fetch('/api/generate-outline', {
                method: 'POST',
                headers: { 'Accept': 'text/event-stream' },
                body: formData
            });
            const data = await consumeOutlineGenerationResponse(res, { chat: stageChatWindows[2], fallback: 'Outline revision failed', previousOutline: currentBeats });
            if (btnStage2Approve) { btnStage2Approve.textContent = 'Approve'; btnStage2Approve.classList.remove('approve-btn-green'); }
            return {
                ...data,
                changed: !revisionReceiptFailed(data) && (
                    revisionReceiptChanged(data)
                    || (data.changed !== false && JSON.stringify(currentBeats) !== JSON.stringify(data.result?.outline || {}))
                )
            };
        }
    });

    // Stage 3
    stageChatWindows[3] = initStageChat({
        stageId: 3,
        threadId: 'stage3-chat-thread',
        inputId: 'stage3-chat-input',
        sendBtnId: 'stage3-chat-send',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            const currentCharacters = scrapeCharacters();
            const formData = new FormData();
            formData.append('projectId', activeProjectId);
            formData.append('currentCharacters', JSON.stringify(currentCharacters));
            formData.append('notes', notes);
            const res = await fetch('/api/generate-characters', { method: 'POST', body: formData });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
                throw new Error(err.error || `Server error ${res.status}`);
            }
            const data = await res.json();
            await handleSourceGenerationResult(3, data, { chat: stageChatWindows[3] });
            renderCharacters(data.result.characters);
            if (window.currentProjectData) window.currentProjectData.stage3_characters = data.result;
            if (btnStage3Approve) { btnStage3Approve.textContent = 'Approve'; btnStage3Approve.classList.remove('approve-btn-green'); }
            return {
                ...data,
                changed: !revisionReceiptFailed(data) && (
                    revisionReceiptChanged(data)
                    || (data.changed !== false && JSON.stringify(currentCharacters) !== JSON.stringify(data.result?.characters || []))
                )
            };
        }
    });

    // Stage 4
    stageChatWindows[4] = initStageChat({
        stageId: 4,
        threadId: 'stage4-chat-thread',
        inputId: 'stage4-chat-input',
        sendBtnId: 'stage4-chat-send',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            const currentBeats = scrapeTreatment();
            const formData = new FormData();
            formData.append('projectId', activeProjectId);
            formData.append('currentBeats', JSON.stringify(currentBeats));
            formData.append('notes', notes);
            const response = await fetch('/api/generate-stage4-beats', { method: 'POST', body: formData });
            if (!response.ok) throw new Error(`Server error ${response.status}`);
            let completeEvent = null;
            await readSSEStream(response, async (event) => {
                if (event.type === 'complete') {
                    completeEvent = event;
                    renderTreatment(event.result);
                    await handleSourceGenerationResult(4, event, { chat: stageChatWindows[4] });
                    if (btnStage4Approve) { btnStage4Approve.textContent = 'Approve'; btnStage4Approve.classList.remove('approve-btn-green'); }
                } else if (event.type === 'error') throw new Error(event.message);
            });
            if (!completeEvent) throw new Error('Beat revision finished without a completion event.');
            return {
                ...completeEvent,
                changed: !revisionReceiptFailed(completeEvent) && (
                    revisionReceiptChanged(completeEvent)
                    || (completeEvent.changed !== false && JSON.stringify(currentBeats) !== JSON.stringify(completeEvent.result || {}))
                )
            };
        }
    });

    // Stage 5
    stageChatWindows[5] = initStageChat({
        stageId: 5,
        threadId: 'stage5-chat-thread',
        inputId: 'stage5-chat-input',
        sendBtnId: 'stage5-chat-send',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            const currentData = scrapeTreatmentStage5();
            const comparableCurrentData = { ...currentData };
            delete comparableCurrentData.notes;
            const formData = new FormData();
            formData.append('projectId', activeProjectId);
            formData.append('currentTreatment', JSON.stringify(currentData));
            formData.append('notes', notes);
            const response = await fetch('/api/generate-stage5-treatment', { method: 'POST', body: formData });
            if (!response.ok) throw new Error(`Server error ${response.status}`);
            let completeEvent = null;
            await readSSEStream(response, async (event) => {
                if (event.type === 'complete') {
                    completeEvent = event;
                    renderTreatmentStage5(event.result);
                    await handleSourceGenerationResult(5, event, { chat: stageChatWindows[5] });
                    if (btnStage5Approve) { btnStage5Approve.textContent = 'Approve'; btnStage5Approve.classList.remove('approve-btn-green'); }
                } else if (event.type === 'error') throw new Error(event.message);
            });
            if (!completeEvent) throw new Error('Treatment revision finished without a completion event.');
            return {
                ...completeEvent,
                changed: !revisionReceiptFailed(completeEvent) && (
                    revisionReceiptChanged(completeEvent)
                    || (completeEvent.changed !== false && JSON.stringify(comparableCurrentData) !== JSON.stringify(completeEvent.result || {}))
                )
            };
        }
    });

    // Stage 5 — Proactive editorial opening message
    async function initStage5() {
        const data = window.currentProjectData || {};
        if (!data.stage5_treatment) return; // No treatment yet
        const chat = stageChatWindows[5];
        if (!chat || (chat.history && chat.history.length > 0)) return; // Already has conversation
        const savedConvos = data.conversations || {};
        if (savedConvos.stage5?.length) return;

        chat.setThinking(true);
        try {
            const res = await fetch('/api/brainstorm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, stageId: 5, messages: [], isInit: true })
            });
            if (res.ok) {
                const initData = await res.json();
                chat.append('ai', initData.message);
            }
        } catch (err) {
            console.error('Stage 5 init message failed:', err);
        } finally {
            chat.setThinking(false);
        }
    }

    function isStage2DirectRevisionRequest(text) {
        const value = String(text || '').trim();
        if (value.length < 40) return false;

        const asksForDiscussion = /[?]/.test(value) &&
            /\b(thoughts|what do you think|should we|should i|do you think|wonder|maybe|could we|which|why|how|analysis|audit|compare)\b/i.test(value);
        if (asksForDiscussion) return false;

        const referencesOutlineTarget = /\b(seq(?:uence)?\s*[a-h1-8]\b|act\s+[123]|outline|beat|beats|coda|closing image|final image|aftermath|resolution|finale)\b/i.test(value);
        const containsDirective = /\b(please\s+)?(restore|add|include|keep|revise|update|fix|replace|remove|delete|move|relocate|compress|expand|change|apply|work in)\b/i.test(value);
        const structuredMemo = /\n\s*(?:\[[^\]]+\]|[-*]\s+|\d+[.)]\s+|[A-Z][^\n]{2,80}\n)/.test(value);

        return referencesOutlineTarget && containsDirective && (structuredMemo || value.length > 120);
    }

    // Stage 6
    function isStage3DirectRevisionRequest(text) {
        const value = String(text || '').trim();
        if (value.length < 18) return false;

        const asksForDiscussion = /[?]/.test(value) &&
            /\b(thoughts|what do you think|should we|should i|do you think|wonder|maybe|could we|which|why|how)\b/i.test(value);
        if (asksForDiscussion) return false;

        const referencesCharacters = /\b(character|characters|cast|profile|profiles|protagonist|antagonist)\b/i.test(value);
        const containsDirective = /\b(regenerate|re-generate|redo|rebuild|recast|start over|from scratch|fresh pass|fresh set|revise|refine|apply|fix|add|remove|delete|replace|make|change|update|deepen|sharpen)\b/i.test(value);
        const structuredMemo = /\n\s*(?:\d+\.|[-*]\s+|==)/.test(value);

        return referencesCharacters && containsDirective && (structuredMemo || value.length > 80 || /\b(regenerate|re-generate|redo|rebuild|recast|from scratch)\b/i.test(value));
    }

    function hasStage6ExplicitApplyIntent(text) {
        const value = String(text || '').trim();
        const opening = value.slice(0, 420);
        return /\b(?:please|pls|go ahead|apply|revise|update|implement|integrate|work in|make)\b[\s\S]{0,100}\b(?:these|this|following|feedback|notes|changes|fixes|blueprint|scene|sequence)\b/i.test(opening)
            || /\b(?:apply|revise|update|implement|integrate|fix)\s+(?:the\s+)?(?:scene\s+)?blueprint\b/i.test(value);
    }

    function isStage6ExternalFeedbackDump(text) {
        const value = String(text || '').trim();
        const opening = value.slice(0, 420);
        return /\b(?:claude|gemini|coverage|reader|editor|script notes|feedback)\b/i.test(opening)
            || /\b(?:tier\s+\d|hard canon breaks|what'?s working|craft flags|internal continuity)\b/i.test(value);
    }

    function isStage6AnalysisOnlyFeedback(text) {
        const value = String(text || '').trim();
        return (isStage6ExternalFeedbackDump(value) || value.length > 1400) && !hasStage6ExplicitApplyIntent(value);
    }

    function isStage6DirectRevisionRequest(text) {
        const value = String(text || '').trim();
        if (value.length < 24) return false;

        const asksForDiscussion = /[?]/.test(value) &&
            /\b(thoughts|what do you think|should we|should i|do you think|wonder|maybe|could we|which|why|how)\b/i.test(value);
        if (asksForDiscussion) return false;

        if (isStage6AnalysisOnlyFeedback(value)) return false;

        const referencesBlueprintTarget = /\bscene[s]?\s+\d+\b|\bsequence[s]?\s+\d+\b|\b\d+\s*\+\s*\d+\b|\bblueprint\b/i.test(value);
        const containsDirective = /\b(final[- ]polish|revision pass|relocation pass|refine|revise|apply|fix|restore|add|tag|strip|replace|rephrase|merge|compress|relocate|move|remove|delete|lock|confirm|keep|do not touch)\b/i.test(value);
        const structuredMemo = /\n\s*(?:\d+\.|[-*]\s+|==)/.test(value);

        return referencesBlueprintTarget && containsDirective && (structuredMemo || value.length > 160);
    }

    function latestUserRequestFromRevisionNotes(notes) {
        const match = String(notes || '').match(/LATEST USER REQUEST:\n([\s\S]*?)\n\nUSER REQUESTS:/);
        return (match ? match[1] : notes || '').trim();
    }

    function shouldRegenerateStage6FromChat(notes) {
        const latest = latestUserRequestFromRevisionNotes(notes);
        if (/\b(do not|don't|dont|not|never)\s+(?:fully\s+)?regenerate\b/i.test(latest)) return false;
        return /\b(regenerate|fresh blueprint|start over|new blueprint|new scene blueprint)\b/i.test(latest);
    }

    async function reviseStage6Blueprint(feedback, { onStatus } = {}) {
        const beforeSnapshot = JSON.parse(JSON.stringify(window.currentProjectData?.stage6_scenes || []));
        const beforeSerialized = JSON.stringify(beforeSnapshot || null);
        const response = await fetch('/api/revise-stage6', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({
                projectId: activeProjectId,
                feedback,
                stream: true
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: `Server error ${response.status}` }));
            throw new Error(error.error || `Server error ${response.status}`);
        }

        let completeEvent = null;
        let streamError = null;
        try {
            await readSSEStream(response, async (event) => {
                if (event.type === 'status' && onStatus) {
                    onStatus(event.message);
                } else if (event.type === 'complete') {
                    completeEvent = event;
                } else if (event.type === 'error') {
                    throw new Error(event.message || 'Failed to revise Stage 6');
                }
            });
        } catch (err) {
            streamError = err;
        }

        if (!completeEvent) {
            throw new Error(streamError?.message || 'Revision finished without a completion event.');
        }

        if (streamError) throw streamError;
        if (revisionReceiptFailed(completeEvent) || (completeEvent.changed === false && !revisionReceiptChanged(completeEvent))) {
            throw new Error('The revision engine returned no blueprint changes.');
        }

        let refreshed;
        try {
            refreshed = await refreshCurrentProjectData();
        } catch (err) {
            throw new Error(`Revision completed, but the updated blueprint could not be refreshed: ${err.message}`);
        }

        const revisedScenes = refreshed?.stage6_scenes || completeEvent.result;
        if (!hasStage6Scenes(revisedScenes)) {
            throw new Error('Revision completed, but the refreshed project did not include a readable Stage 6 blueprint.');
        }

        const changed = JSON.stringify(revisedScenes) !== beforeSerialized;
        if (!changed) {
            throw new Error('Revision completed, but the refreshed blueprint matched the previous viewer state.');
        }

        const changedScenes = changedStage6SceneNumbers(beforeSnapshot, revisedScenes);
        completeEvent = {
            ...completeEvent,
            type: 'complete',
            result: revisedScenes,
            changed: true,
            changedSceneNumbers: changedScenes,
            refreshedFromProject: true
        };

        await handleSourceGenerationResult(6, completeEvent, { chat: stageChatWindows[6] });
        renderStage6(revisedScenes);
        if (window.currentProjectData) window.currentProjectData.stage6_scenes = revisedScenes;
        highlightStage6ChangedScenes(changedScenes);
        return completeEvent;
    }

    stageChatWindows[6] = initStageChat({
        stageId: 6,
        threadId: 'stage6-chat-thread',
        inputId: 'stage6-chat-input',
        sendBtnId: 'stage6-chat-send',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            if (shouldRegenerateStage6FromChat(notes)) {
                await saveStage6SnapshotBeforeRegenerate();
                await generateStage6({ notes, isRegenerate: true, throwOnError: true });
                return { changed: true };
            }
            return reviseStage6Blueprint(notes);
        }
    });

    // Stage 6 — Proactive editorial opening message
    async function initStage6() {
        const data = window.currentProjectData || {};
        if (!data.stage6_scenes?.length) return; // No scenes yet
        const chat = stageChatWindows[6];
        if (!chat || (chat.history && chat.history.length > 0)) return;
        const savedConvos = data.conversations || {};
        if (savedConvos.stage6?.length) return;

        chat.setThinking(true);
        try {
            const res = await fetch('/api/brainstorm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, stageId: 6, messages: [], isInit: true })
            });
            if (res.ok) {
                const initData = await res.json();
                chat.append('ai', initData.message);
            }
        } catch (err) {
            console.error('Stage 6 init message failed:', err);
        } finally {
            chat.setThinking(false);
        }
    }

    // ─── STAGE 7: STYLE ───────────────────────────────────────────────────────

    // Stage 7 chat
    stageChatWindows[7] = initStageChat({
        stageId: 7,
        threadId: 'stage7-chat-thread',
        inputId: 'stage7-chat-input',
        sendBtnId: 'stage7-chat-send',
        attachInputId: false,
        executeRevision: async (notes) => {
            // "Execute" from chat means "generate style from this conversation"
            return stage7GenerateFromChat(notes);
        }
    });

    let stage7CurrentStyle = null; // { slug, content, meta }

    function stage7SetChoicePanelVisible(visible) {
        const panel = document.getElementById('stage7-choice-panel');
        if (panel) panel.style.display = visible ? 'grid' : 'none';
    }

    function stage7ShowTrainedPanel(show = true) {
        const panel = document.getElementById('stage7-trained-panel');
        if (!panel) return;
        panel.classList.toggle('hidden', !show);
        if (show) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function initStage7() {
        const data = window.currentProjectData || {};
        const styleCard = document.getElementById('stage7-style-card');
        const importNotice = document.getElementById('stage7-import-notice');
        const btnApprove = document.getElementById('btnStage7Approve');

        // Show import notice if applicable
        if (data.imported && data.stage7_style_skipped && !data.stage7_style) {
            importNotice?.classList.remove('hidden');
        } else {
            importNotice?.classList.add('hidden');
        }

        // Load inline saved-style cards
        stage7LoadInlineStyles();

        // If style already exists, load and show it
        if (data.stage7_style) {
            stage7SetChoicePanelVisible(false);
            stage7ShowTrainedPanel(false);
            stage7LoadExistingStyle(data.stage7_style);
        } else {
            stage7SetChoicePanelVisible(true);
            stage7ShowTrainedPanel(false);
            styleCard?.classList.add('hidden');
            document.getElementById('stage7-no-style')?.classList.remove('hidden');
            if (btnApprove) btnApprove.disabled = true;

            // If scenes exist and chat is empty, fire proactive 3-writer suggestion
            const hasScenes = data.stage6_scenes &&
                (data.stage6_scenes.sequences?.length > 0 ||
                 data.stage6_scenes.scenes?.length > 0 ||
                 (Array.isArray(data.stage6_scenes) && data.stage6_scenes.length > 0));
            if (hasScenes && !data.stage7_style_skipped) {
                const chat = stageChatWindows[7];
                const savedConvos = data.conversations || {};
                if (chat && (!chat.history || chat.history.length === 0) && !savedConvos.stage7?.length) {
                    initStage7Brainstorm();
                }
            }
        }
    }

    // Stage 7 — Proactive 3-writer suggestion (same pattern as Stage 5/6 init)
    async function initStage7Brainstorm() {
        const chat = stageChatWindows[7];
        if (!chat) return;

        chat.setThinking(true);
        try {
            const res = await fetch('/api/brainstorm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, stageId: 7, messages: [], isInit: true })
            });
            if (res.ok) {
                const initData = await res.json();
                chat.append('ai', initData.message);
            }
        } catch (err) {
            console.error('Stage 7 init message failed:', err);
        } finally {
            chat.setThinking(false);
        }
    }

    async function stage7LoadExistingStyle(slug) {
        try {
            const res = await fetch('/api/select-style', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, styleSlug: slug })
            });
            if (!res.ok) return;
            const data = await res.json();
            stage7DisplayStyle(data);
        } catch (err) {
            console.error('Failed to load existing style:', err);
        }
    }

    function stage7DisplayStyle(styleData) {
        stage7CurrentStyle = styleData;
        const card = document.getElementById('stage7-style-card');
        const nameEl = document.getElementById('stage7-style-name');
        const tonalEl = document.getElementById('stage7-style-tonal');
        const refsEl = document.getElementById('stage7-style-refs');
        const bodyEl = document.getElementById('stage7-style-body');
        const btnApprove = document.getElementById('btnStage7Approve');

        if (!card) return;

        nameEl.textContent = styleData.meta?.name || styleData.slug || 'Custom Style';
        tonalEl.textContent = styleData.meta?.tonal_summary || '';
        const refs = styleData.meta?.references;
        const tierText = styleTierLabel(styleData.tier || styleData.meta?.tier);
        const refsText = refs?.length ? ` · References: ${Array.isArray(refs) ? refs.join(', ') : refs}` : '';
        refsEl.textContent = `${tierText} Style${refsText}`;

        // Show the body content without YAML front matter
        let body = styleData.content || styleData.directive || '';
        const fmEnd = body.indexOf('---', body.indexOf('---') + 3);
        if (fmEnd > 0) body = body.slice(fmEnd + 3).trim();
        bodyEl.textContent = body;

        // Reset collapsible body
        const bodyWrap = document.getElementById('stage7-style-body-wrap');
        const toggleBtn = document.getElementById('stage7-style-toggle');
        if (bodyWrap) bodyWrap.classList.add('hidden');
        if (toggleBtn) toggleBtn.textContent = 'Show Full Details ▾';

        card.classList.remove('hidden');
        stage7SetChoicePanelVisible(false);
        stage7ShowTrainedPanel(false);
        document.getElementById('stage7-no-style')?.classList.add('hidden');
        document.getElementById('stage7-loading')?.classList.add('hidden');
        if (btnApprove) {
            btnApprove.disabled = false;
            // If already approved, show green state
            if (window.currentProjectData?.stage7_style) {
                btnApprove.textContent = 'Approved ✓';
                btnApprove.classList.add('approve-btn-green');
            }
        }
    }

    async function stage7GenerateFromChat(description) {
        const loadingEl = document.getElementById('stage7-loading');
        const loadingText = document.getElementById('stage7-loading-text');
        if (loadingEl) { loadingEl.classList.remove('hidden'); }
        if (loadingText) loadingText.textContent = 'Generating style...';

        try {
            const chat = stageChatWindows[7];
            const history = chat ? chat.history || [] : [];
            const res = await fetch('/api/generate-stage7-style', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: activeProjectId,
                    mode: 'chat',
                    description: description || '',
                    conversationHistory: history
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Generation failed');
            }
            const data = await res.json();
            stage7DisplayStyle(data);
            await handleSourceGenerationResult(7, data, { chat: stageChatWindows[7] });
            if (window.currentProjectData) window.currentProjectData.stage7_style = data.slug;
            updateStageNav(window.currentProjectData);
            return { ...data, changed: true };
        } catch (err) {
            console.error('Style generation error:', err);
            if (loadingEl) loadingEl.classList.add('hidden');
            alert('Style generation failed: ' + err.message);
            throw err;
        }
    }

    async function stage7GenerateTrainedFromUpload() {
        const files = document.getElementById('stage7-trained-files')?.files;
        if (!files?.length) {
            alert('Please select at least one screenplay file.');
            return;
        }

        const progress = document.getElementById('stage7-trained-progress');
        const btn = document.getElementById('btnStage7GenerateTrained');
        if (progress) progress.classList.remove('hidden');
        if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }

        try {
            const formData = new FormData();
            formData.append('projectId', activeProjectId);
            const styleName = document.getElementById('stage7-trained-name')?.value?.trim() || '';
            if (styleName) formData.append('styleName', styleName);
            const chat = stageChatWindows[7];
            if (chat?.history?.length) formData.append('conversationHistory', JSON.stringify(chat.history));
            for (const file of files) formData.append('screenplayFiles', file);

            const res = await fetch('/api/generate-trained-style', {
                method: 'POST',
                body: formData
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Generation failed' }));
                throw new Error(err.error || 'Generation failed');
            }
            const data = await res.json();
            stage7DisplayStyle({ ...data, content: data.directive });
            await handleSourceGenerationResult(7, data, { chat: stageChatWindows[7] });
            if (window.currentProjectData) window.currentProjectData.stage7_style = data.slug;
            updateStageNav(window.currentProjectData);
            stage7LoadInlineStyles();
        } catch (err) {
            console.error('Stage 7 trained style error:', err);
            alert('Failed to create trained style: ' + err.message);
        } finally {
            if (progress) progress.classList.add('hidden');
            if (btn) { btn.disabled = false; btn.textContent = 'Analyze & Create'; }
        }
    }

    // Load saved styles as inline cards in Stage 7
    function stage7MarkActiveCard(activeSlug) {
        document.querySelectorAll('.stage7-inline-style-card').forEach(c => {
            const isActive = c.dataset.styleSlug === activeSlug;
            c.style.borderColor = isActive ? '#3b82f6' : '#334155';
            c.style.background = isActive ? '#1e3a5f' : '#1e293b';
            const btn = c.querySelector('button');
            if (btn) {
                btn.textContent = isActive ? 'In Use ✓' : 'Use This';
                btn.style.background = isActive ? '#166534' : '';
                btn.style.borderColor = isActive ? '#166534' : '';
            }
        });
    }

    async function stage7LoadInlineStyles() {
        const container = document.getElementById('stage7-saved-styles');
        const grid = document.getElementById('stage7-saved-styles-grid');
        if (!container || !grid) return;

        try {
            const res = await fetch('/api/styles');
            const data = await res.json();
            if (!data.styles?.length) {
                container.classList.add('hidden');
                return;
            }

            grid.innerHTML = '';
            for (const style of data.styles) {
                const card = document.createElement('div');
                card.className = 'stage7-inline-style-card';
                card.dataset.styleSlug = style.slug;
                card.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:10px;padding:12px 16px;min-width:180px;max-width:240px;cursor:pointer;transition:border-color 0.2s,background 0.2s;display:flex;flex-direction:column;gap:4px';
                const tierClass = styleTierClass(style.tier);
                const tierLabel = styleTierLabel(style.tier);
                card.innerHTML = `
                    <div style="font-size:0.9rem;color:#e5e7eb;font-weight:500">${escapeHtml(style.name)}<span class="style-tier-badge ${tierClass}">${tierLabel}</span></div>
                    <div style="font-size:0.75rem;color:#6b7280">${escapeHtml(style.tonal_summary || '')}</div>
                    <button class="primary-btn" style="font-size:0.7rem;padding:3px 10px;margin-top:4px;align-self:flex-start">Use This</button>
                `;
                card.querySelector('button').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const loadingEl = document.getElementById('stage7-loading');
                    if (loadingEl) loadingEl.classList.remove('hidden');
                    try {
                        const selectRes = await fetch('/api/select-style', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: activeProjectId, styleSlug: style.slug })
                        });
                        if (!selectRes.ok) throw new Error('Select failed');
                        const selectData = await selectRes.json();
                        stage7DisplayStyle(selectData);
                        if (window.currentProjectData) window.currentProjectData.stage7_style = selectData.slug;
                        stage7MarkActiveCard(selectData.slug);
                        updateStageNav(window.currentProjectData);
                    } catch (err) {
                        console.error('Select style error:', err);
                        if (loadingEl) loadingEl.classList.add('hidden');
                        alert('Failed to select style: ' + err.message);
                    }
                });
                grid.appendChild(card);
            }
            stage7MarkActiveCard(window.currentProjectData?.stage7_style);
            container.classList.remove('hidden');
        } catch (err) {
            console.error('Load inline styles error:', err);
            container.classList.add('hidden');
        }
    }

    async function stage7PreviewScene() {
        if (!stage7CurrentStyle?.slug) return;
        const previewPanel = document.getElementById('stage7-preview-panel');
        const previewText = document.getElementById('stage7-preview-text');
        const loadingEl = document.getElementById('stage7-loading');

        if (loadingEl) { loadingEl.classList.remove('hidden'); }
        document.getElementById('stage7-loading-text').textContent = 'Drafting preview scene...';

        try {
            const res = await fetch('/api/preview-style-scene', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, styleSlug: stage7CurrentStyle.slug, sceneIndex: 0 })
            });
            if (!res.ok) throw new Error('Preview failed');
            const data = await res.json();
            previewText.textContent = data.previewText;
            previewPanel.classList.remove('hidden');
            await handleSourceGenerationResult(7, data, { chat: stageChatWindows[7], postGenerationCheck: false });
        } catch (err) {
            console.error('Preview error:', err);
            alert('Preview failed: ' + err.message);
        } finally {
            if (loadingEl) loadingEl.classList.add('hidden');
        }
    }

    async function stage7ApproveStyle() {
        if (!stage7CurrentStyle?.slug || !activeProjectId) return;
        const btnApprove = document.getElementById('btnStage7Approve');
        if (!(await runApprovalSourceGuard(7, btnApprove))) return;

        try {
            const res = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { stage7_style: stage7CurrentStyle.slug } })
            });
            if (!res.ok) throw new Error('Approve failed');
            const updated = await res.json();
            window.currentProjectData = updated.data;
            await offerStageMemoryCuration(7);
            updateStageNav(updated.data);

            if (btnApprove) {
                btnApprove.textContent = 'Approved ✓';
                btnApprove.classList.add('approve-btn-green');
                btnApprove.disabled = true;
            }
        } catch (err) {
            console.error('Approve error:', err);
            alert('Failed to approve style: ' + err.message);
        }
    }

    async function resetStage7StyleForRegenerate() {
        stage7SetChoicePanelVisible(true);
        stage7ShowTrainedPanel(false);
        document.getElementById('stage7-style-card')?.classList.add('hidden');
        document.getElementById('stage7-no-style')?.classList.remove('hidden');
        const btnApprove = document.getElementById('btnStage7Approve');
        if (btnApprove) {
            btnApprove.disabled = true;
            btnApprove.textContent = 'Approve →';
            btnApprove.classList.remove('approve-btn-green');
        }
        stage7CurrentStyle = null;
        if (window.currentProjectData) {
            window.currentProjectData.stage7_style = null;
            window.currentProjectData.stage7_style_skipped = false;
            updateStageNav(window.currentProjectData);
        }
        if (activeProjectId) {
            await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { stage7_style: null, stage7_style_skipped: false } })
            }).catch(err => console.warn('Stage 7 style reset skipped:', err.message));
        }
    }

    // Stage 7 event listeners
    document.getElementById('btnStage7Approve')?.addEventListener('click', () => stage7ApproveStyle());
    document.getElementById('btnStage7Preview')?.addEventListener('click', () => stage7PreviewScene());
    document.getElementById('btnStage7Describe')?.addEventListener('click', () => {
        const input = document.getElementById('stage7-chat-input');
        input?.focus();
        document.getElementById('stage7-chat')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    document.getElementById('btnStage7Analyze')?.addEventListener('click', () => stage7ShowTrainedPanel(true));
    document.getElementById('btnStage7CloseTrained')?.addEventListener('click', () => stage7ShowTrainedPanel(false));
    document.getElementById('btnStage7GenerateTrained')?.addEventListener('click', () => stage7GenerateTrainedFromUpload());
    document.getElementById('btnStage7Saved')?.addEventListener('click', () => {
        document.getElementById('stage7-saved-styles')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    document.getElementById('btnStage7NoStyleChoice')?.addEventListener('click', () => {
        document.getElementById('btnStage7Skip')?.click();
    });
    document.getElementById('btnStage7Regenerate')?.addEventListener('click', resetStage7StyleForRegenerate);
    btnStage7RegenerateHeader?.addEventListener('click', resetStage7StyleForRegenerate);
    document.getElementById('btnStage7ClosePreview')?.addEventListener('click', () => {
        document.getElementById('stage7-preview-panel')?.classList.add('hidden');
    });
    // Style card body expand/collapse
    document.getElementById('stage7-style-toggle')?.addEventListener('click', () => {
        const wrap = document.getElementById('stage7-style-body-wrap');
        const btn = document.getElementById('stage7-style-toggle');
        if (!wrap || !btn) return;
        const hidden = wrap.classList.toggle('hidden');
        btn.textContent = hidden ? 'Show Full Details ▾' : 'Hide Details ▴';
    });
    // Continue without style
    document.getElementById('btnStage7Skip')?.addEventListener('click', async () => {
        if (!activeProjectId) return;
        try {
            const res = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { stage7_style: null, stage7_style_skipped: true } })
            });
            if (!res.ok) throw new Error('Skip failed');
            const updated = await res.json();
            window.currentProjectData = updated.data;
            updateStageNav(updated.data);
            switchStage(8);
        } catch (err) {
            console.error('Skip style error:', err);
        }
    });


    // Stage 8 (Draft)
    stageChatWindows[8] = initStageChat({
        stageId: 8,
        threadId: 'stage8-chat-thread',
        inputId: 'stage8-chat-input',
        sendBtnId: 'stage8-chat-send',
        attachInputId: 'stage8-chat-attach',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            const res = await fetch('/api/revise-draft', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, sceneNumber: currentDraftSceneNumber, feedback: notes })
            });
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const data = await res.json();
            await handleSourceGenerationResult(8, data, { chat: stageChatWindows[8] });
            stage8LoadEditor(data.result);
            const projRes = await fetch(`/api/projects/${activeProjectId}`);
            const projData = await projRes.json();
            window.currentProjectData = projData.data;
            if (btnNextScene) btnNextScene.classList.remove('hidden');
            return data;
        }
    });

    // ─── STAGE CHAT COLLAPSE ──────────────────────────────────────────────────
    function initChatCollapse(stageNum, chatEl, handleEl) {
        const key = `stageChatCollapsed${stageNum}`;
        const header = chatEl.querySelector('.chat-header');
        if (!header) return;

        function setCollapsed(collapsed, save = true) {
            if (collapsed) {
                chatEl.classList.add('collapsed');
                if (handleEl) handleEl.style.display = 'none';
            } else {
                chatEl.classList.remove('collapsed');
                if (handleEl) handleEl.style.display = '';
            }
            if (save) localStorage.setItem(key, collapsed ? '1' : '0');
        }

        if (localStorage.getItem(key) === '1') setCollapsed(true, false);

        header.addEventListener('click', () => setCollapsed(!chatEl.classList.contains('collapsed')));
    }

    // ─── STAGE CHAT RESIZERS (Stages 1–6, 8) ──────────────────────────────────
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const hsplit = document.getElementById(`stage${s}-hsplit`);
        const chatEl = document.getElementById(`stage${s}-chat`);
        if (!hsplit || !chatEl) continue;
        const storageKey = `stageChatH${s}`;
        const saved = parseInt(localStorage.getItem(storageKey) || '280');
        chatEl.style.height = `${saved}px`;
        initChatCollapse(s, chatEl, hsplit);
        hsplit.addEventListener('mousedown', e => {
            e.preventDefault();
            hsplit.classList.add('dragging');
            const startY = e.clientY;
            const startH = chatEl.offsetHeight;
            const onMove = ev => {
                const newH = Math.min(600, Math.max(120, startH + (startY - ev.clientY)));
                chatEl.style.height = `${newH}px`;
                localStorage.setItem(storageKey, newH);
            };
            const onUp = () => {
                hsplit.classList.remove('dragging');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // ─── VERSION HISTORY CHAT ────────────────────────────────────────────────

    // ─── Version Preview Modal ────────────────────────────────────────────────
    const versionPreviewModal = document.getElementById('version-preview-modal');
    const versionPreviewTitle = document.getElementById('version-preview-title');
    const versionPreviewBody  = document.getElementById('version-preview-body');
    const versionPreviewClose = document.getElementById('version-preview-close');
    const versionPreviewCompare = document.getElementById('version-preview-compare');
    const versionPreviewDownload = document.getElementById('version-preview-download');
    const versionPreviewRestore  = document.getElementById('version-preview-restore');
    let currentPreviewVersion = null;

    function snapshotToText(version) {
        const snap = version.snapshot;
        if (!snap) return '(empty snapshot)';
        const stage = version.stage;

        // Helper: render array of {headline, detail} items
        const bulletList = (arr) => (arr || []).map(item => {
            if (typeof item === 'string') return `• ${item}`;
            return `• ${item.headline || item.label || ''}: ${item.detail || item.task || item.description || ''}`;
        }).join('\n');

        // Stage 1 — Pitch
        if (stage === 1) {
            const p = snap.pitch || snap;
            let out = '';
            if (p.title) out += `TITLE: ${p.title}\n\n`;
            if (p.genre) out += `GENRE: ${p.genre}\n`;
            if (p.tone) out += `TONE: ${p.tone}\n`;
            if (p.setting) out += `SETTING: ${p.setting}\n`;
            if (p.logline) out += `\nLOGLINE:\n${p.logline}\n`;
            if (p.synopsis) out += `\nSYNOPSIS:\n${p.synopsis}\n`;
            if (snap.notes) out += `\nNOTES:\n${snap.notes}\n`;
            return out.trim() || JSON.stringify(snap, null, 2);
        }

        const renderOutlineSnapshot = (outline) => {
            const data = outline?.outline || outline;
            if (!data || typeof data !== 'object') return String(outline || '');
            const acts = ['act_1', 'act_2', 'act_3'];
            return acts.map(actKey => {
                const sequences = Array.isArray(data[actKey]) ? data[actKey] : [];
                if (!sequences.length) return '';
                return `${actKey.toUpperCase()}\n\n` + sequences.map(seq => {
                    const title = seq.sequence_number_and_title || seq.title || 'Sequence';
                    const beats = Array.isArray(seq.beats) ? seq.beats : [];
                    return `${title}\n${beats.map(beat => `- ${beat.beat_label || beat.beat || 'Beat'}: ${beat.description || ''}`).join('\n')}`;
                }).join('\n\n');
            }).filter(Boolean).join('\n\n---\n\n') || JSON.stringify(snap, null, 2);
        };

        // Stage 2 — Outline
        if (stage === 2) return renderOutlineSnapshot(snap);

        // Stage 3 — Characters (array of objects)
        if (stage === 3 && (Array.isArray(snap) || Array.isArray(snap.characters))) {
            const characters = Array.isArray(snap) ? snap : snap.characters;
            return characters.map(c => {
                let out = `${c.name || 'Unnamed'}`;
                if (c.role) out += ` (${c.role})`;
                out += '\n';
                if (c.description) out += `  ${c.description}\n`;
                if (c.arc) out += `  Arc: ${c.arc}\n`;
                if (c.backstory) out += `  Backstory: ${c.backstory}\n`;
                return out;
            }).join('\n');
        }

        // Stage 4 — Beats (array of objects with beat_number)
        if (stage === 4 && Array.isArray(snap)) {
            return snap.map(b => `Beat ${b.beat_number}: ${b.beat_name || ''}\n  ${b.description || ''}`).join('\n\n');
        }

        // Stage 5 — Treatment (array of sequences / scenes)
        if (stage === 5) {
            const seqs = Array.isArray(snap) ? snap : Object.values(snap);
            return seqs.map(seq => {
                let out = `=== ${seq.sequence_title || 'Sequence'} ===\n`;
                if (seq.scenes) {
                    out += seq.scenes.map(s =>
                        `  Scene ${s.scene_number}: ${s.scene_heading || s.slugline || ''}\n    ${s.narrative_action || s.description || ''}`
                    ).join('\n\n');
                }
                return out;
            }).join('\n\n');
        }

        // Stage 6 Scenes and Stage 8 Draft snapshots (array-like of sequences)
        if (stage === 6 || (stage === 8 && (Array.isArray(snap) || Array.isArray(snap?.sequences)))) {
            const seqs = Array.isArray(snap) ? snap : Object.values(snap);
            const allScenes = seqs.flatMap(seq => seq.scenes || []).sort((a, b) => a.scene_number - b.scene_number);
            return allScenes.map(s => {
                const heading = s.scene_heading || s.slugline || '';
                const body = s.humanized_draft_text || s.draft_text || s.narrative_action || '';
                return `SCENE ${s.scene_number}: ${heading}\n${body.trim()}`;
            }).filter(Boolean).join('\n\n---\n\n');
        }

        // Stage 8 (Draft) — approval flag
        if (stage === 8 || stage === 7) {
            return stage === 7
                ? '(Style approval marker.)'
                : '(Stage 8 approval marker — the full draft text is stored in the scene snapshots.)';
        }

        // Stage 9 (Coverage)
        if ((stage === 9 || stage === 8) && snap.evaluation_grid) {
            let out = '';
            if (snap.title) out += `TITLE: ${snap.title}\n`;
            if (snap.genre) out += `GENRE: ${snap.genre}\n`;
            if (snap.logline) out += `\nLOGLINE:\n${snap.logline}\n`;

            out += '\n━━━ EVALUATION GRID ━━━\n';
            for (const [key, val] of Object.entries(snap.evaluation_grid)) {
                out += `  ${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}\n`;
            }

            if (snap.recommendation) {
                out += `\n━━━ RECOMMENDATION ━━━\n`;
                out += `  Grade: ${snap.recommendation.grade || ''}\n`;
                if (snap.recommendation.justification) out += `  ${snap.recommendation.justification}\n`;
            }

            if (snap.synopsis) {
                out += `\n━━━ SYNOPSIS ━━━\n`;
                if (typeof snap.synopsis === 'string') {
                    out += snap.synopsis + '\n';
                } else {
                    for (const [phase, text] of Object.entries(snap.synopsis)) {
                        out += `  ${phase.toUpperCase()}: ${text}\n\n`;
                    }
                }
            }

            if (snap.strengths?.length) {
                out += `━━━ STRENGTHS ━━━\n${bulletList(snap.strengths)}\n\n`;
            }
            if (snap.weaknesses?.length) {
                out += `━━━ WEAKNESSES ━━━\n${bulletList(snap.weaknesses)}\n\n`;
            }

            if (snap.authenticity) {
                out += `━━━ AUTHENTICITY ━━━\n`;
                if (snap.authenticity.assessment) out += `  ${snap.authenticity.assessment}\n`;
                if (snap.authenticity.red_flags?.length) {
                    out += `  Red flags:\n${snap.authenticity.red_flags.map(f => `    • ${typeof f === 'string' ? f : f.detail || JSON.stringify(f)}`).join('\n')}\n`;
                }
                out += '\n';
            }

            if (snap.analytical_comments) {
                out += `━━━ ANALYTICAL COMMENTS ━━━\n`;
                if (Array.isArray(snap.analytical_comments)) {
                    out += snap.analytical_comments.map(c => typeof c === 'string' ? `• ${c}` : `• ${c.voice || ''}: ${c.text || c.detail || JSON.stringify(c)}`).join('\n');
                } else if (typeof snap.analytical_comments === 'string') {
                    out += snap.analytical_comments;
                }
                out += '\n\n';
            }

            if (snap.macro_todo?.length) {
                out += `━━━ MACRO TO-DO ━━━\n`;
                out += snap.macro_todo.map((t, i) => `${i + 1}. [P${t.priority || i + 1}] ${t.task || t}`).join('\n');
                out += '\n\n';
            }
            if (snap.micro_todo?.length) {
                out += `━━━ MICRO TO-DO ━━━\n`;
                out += snap.micro_todo.map((t, i) => `${i + 1}. [P${t.priority || i + 1}] ${t.task || t}`).join('\n');
                out += '\n';
            }

            return out.trim();
        }

        // Fallback — structured JSON
        if (typeof snap === 'string') return snap;
        if (typeof snap === 'object') return JSON.stringify(snap, null, 2);
        return String(snap);
    }

    window.previewVersionById = function(versionId) {
        const history = window.currentProjectData?.versionHistory || [];
        const version = history.find(v => v.id === versionId);
        if (!version) { alert('Version not found.'); return; }

        currentPreviewVersion = version;
        const date = new Date(version.approvedAt);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const label = version.label || (version.snapshotType ? version.snapshotType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Approved');

        versionPreviewTitle.textContent = `Stage ${version.stage}: ${version.stageName} — Version ${version.version} · ${label} (${dateStr} at ${timeStr})`;
        versionPreviewBody.textContent = snapshotToText(version);
        versionPreviewModal?.classList.remove('hidden');
    };

    if (versionPreviewClose) {
        versionPreviewClose.onclick = () => versionPreviewModal?.classList.add('hidden');
    }
    if (versionPreviewModal) {
        versionPreviewModal.onclick = (e) => { if (e.target === versionPreviewModal) versionPreviewModal.classList.add('hidden'); };
    }
    if (versionPreviewCompare) {
        versionPreviewCompare.onclick = () => {
            if (!currentPreviewVersion) return;
            const currentSnapshot = window.currentProjectData?.[currentPreviewVersion.stageKey];
            const currentVersion = {
                ...currentPreviewVersion,
                snapshot: currentSnapshot
            };
            versionPreviewBody.textContent = `SELECTED VERSION\n${snapshotToText(currentPreviewVersion)}\n\n====================\n\nCURRENT SAVED ARTIFACT\n${snapshotToText(currentVersion)}`;
        };
    }
    if (versionPreviewRestore) {
        versionPreviewRestore.onclick = () => {
            if (currentPreviewVersion) {
                versionPreviewModal?.classList.add('hidden');
                window.restoreVersionById(currentPreviewVersion.id);
            }
        };
    }
    if (versionPreviewDownload) {
        versionPreviewDownload.onclick = () => {
            if (!currentPreviewVersion) return;
            const text = snapshotToText(currentPreviewVersion);
            const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'project';
            const safeName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const filename = `${safeName}_stage${currentPreviewVersion.stage}_v${currentPreviewVersion.version}.txt`;
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        };
    }

    // ─── STAGE 10 LOOPBACK MODAL ─────────────────────────────────────────────

    const stage10LoopbackModal = document.getElementById('stage10-loopback-modal');
    const btnLoopbackCoverage = document.getElementById('btn-loopback-coverage');
    const btnLoopbackExport   = document.getElementById('btn-loopback-export');

    function setStage10ApproveConfirmed() {
        const btn = document.getElementById('btnStage10Approve');
        if (btn) {
            btn.textContent = 'Approved ✓';
            btn.classList.add('approve-btn-green');
            btn.disabled = true;
        }
    }

    if (btnLoopbackExport) {
        btnLoopbackExport.addEventListener('click', () => {
            stage10LoopbackModal?.classList.add('hidden');
            setStage10ApproveConfirmed();
            // Trigger fountain download from the Rewrite stage
            document.getElementById('btnDownloadRewriteFountain')?.click();
        });
    }

    if (btnLoopbackCoverage) {
        btnLoopbackCoverage.addEventListener('click', async () => {
            stage10LoopbackModal?.classList.add('hidden');
            setStage10ApproveConfirmed();

            // Snapshot existing coverage before overwriting (if it exists)
            if (window.currentProjectData?.stage8_coverage) {
                const vhCov = captureVersionSnapshot(9, 'stage8_coverage', 'Coverage', window.currentProjectData.stage8_coverage);
                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { versionHistory: vhCov } })
                });
            }

            // Clear coverage so initStage9() regenerates it from Stage 10 working copy
            await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { stage8_coverage: null, stage8_approved: false } })
            });
            if (window.currentProjectData) {
                window.currentProjectData.stage8_coverage = null;
                window.currentProjectData.stage8_approved = false;
            }

            // Re-run coverage on the Stage 10 rewritten draft
            window.coverageSourceStage10 = true;
            switchStage(9);
        });
    }

    // ─── STAGE 10: REWRITE ───────────────────────────────────────────────────

    // State
    let stage10State   = null;   // { working, priority_idx, macro_todo, micro_todo }
    let stage10Pending = {};     // { scene_number: proposed_text } — not yet approved
    let stage10CurrentScene = null;  // currently selected scene_number
    let stage10ApprovedScenes = {}; // { scene_number: true } changed in a prior approved pass
    let stage10Chat = null;      // ChatWindow instance
    let stage10ExecutingPlan = false; // guard against double-click on Execute Plan

    function stage10RenderPlanCard(plan) {
        const esc = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const scenes = (plan.affected_scenes || []).map(s => `
            <div class="chat-plan-scene">
                <span class="chat-plan-scene-num">Scene ${s.scene_number}</span>
                <span class="chat-plan-scene-slug">${esc(s.slugline)}</span>
                <p class="chat-plan-scene-change">${esc(s.planned_change)}</p>
            </div>`).join('');
        return `<div class="chat-plan-card">
            <p class="chat-plan-rationale">${esc(plan.rationale)}</p>
            <div class="chat-plan-scenes">${scenes}</div>
            <button id="btnExecutePlanInChat" class="primary-btn" style="margin-top:10px;font-size:0.8rem;">Execute Plan</button>
        </div>`;
    }

    let stage10GeneratingPlan = false;

    async function stage10GeneratePlan() {
        if (!stage10Chat || stage10GeneratingPlan || window.stage10CurrentPlan) return;
        stage10GeneratingPlan = true;
        const priorities = stage10GetPriorityList();
        const task = priorities[stage10State.priority_idx]?.task;
        if (!task) { stage10Chat.append('system', 'No active priority task.'); stage10GeneratingPlan = false; return; }
        stage10Chat.append('system', 'Generating rewrite plan...');
        stage10Chat.setThinking(true);
        const conversationContext = stage10Chat.history.map(m => `${m.role}: ${m.content}`).join('\n');
        try {
            const res = await fetch('/api/plan-rewrite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, priorityTask: task, conversationContext })
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const plan = await res.json();
            await handleSourceGenerationResult(10, plan, { chat: stage10Chat, postGenerationCheck: false });
            window.stage10CurrentPlan = plan;
            stage10Chat.append('ai', '', { html: stage10RenderPlanCard(plan) });
            document.getElementById('btnExecutePlanInChat')?.addEventListener('click', () => stage10ExecutePlan(plan));
        } catch (err) {
            stage10Chat.append('system', 'Planning failed: ' + err.message);
        } finally {
            stage10Chat.setThinking(false);
            stage10GeneratingPlan = false;
        }
    }

    async function stage10ExecutePlan(plan) {
        if (!plan || stage10ExecutingPlan) return;
        stage10ExecutingPlan = true;

        const priorities = stage10GetPriorityList();
        const task = priorities[stage10State.priority_idx]?.task || '';
        const scenes = plan.affected_scenes || [];

        const loadingOverlay = document.getElementById('stage10-rewrite-loading');
        const rightView = document.getElementById('stage10-right-panel-view');
        loadingOverlay?.classList.remove('hidden');
        loadingOverlay?.classList.add('flex');
        if (rightView) rightView.classList.add('hidden');
        if (stage10Chat) stage10Chat.setDisabled(true);
        if (stage10Chat) stage10Chat.setThinking(true);

        try {
            for (let i = 0; i < scenes.length; i++) {
                const s = scenes[i];
                if (stage10Chat) stage10Chat.append('system', `Rewriting scene ${s.scene_number} (${i + 1}/${scenes.length})...`);

                const res = await fetch('/api/rewrite-single-scene', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId: activeProjectId,
                        sceneNumber: s.scene_number,
                        priorityTask: task,
                        plannedChange: s.planned_change
                    })
                });
                if (!res.ok) {
                    const err = await res.json();
                    if (stage10Chat) stage10Chat.append('system', `Scene ${s.scene_number} failed: ${err.error}`);
                    continue;
                }
                const data = await res.json();
                await handleSourceGenerationResult(10, data, { chat: stage10Chat, refreshKnowledge: false });
                if (data.modified) {
                    stage10Pending[data.scene_number] = data.proposed_text;
                    renderStage10SceneList();
                }
            }

            resetStage10ApproveBtn();
            window.stage10CurrentPlan = null;
            await refreshProjectKnowledgeSummary().catch(err => console.warn('Source readiness refresh skipped:', err.message));
            await runPostGenerationSourceVerification(10, { chat: stage10Chat }).catch(err => console.warn('Post-generation source check skipped:', err.message));

            const modCount = Object.keys(stage10Pending).length;
            const firstModified = Object.keys(stage10Pending).map(Number)[0];
            if (firstModified) stage10SelectScene(firstModified);
            renderStage10SceneList();

            if (stage10Chat) stage10Chat.append('ai', `Rewrites applied to ${modCount} scene(s). Review the diffs above — use the scene list on the right to jump between changed scenes.\n\nWhen you're happy with the changes, approve to move on to the next priority.`, {
                actions: [{ label: 'Approve & Continue', onClick: stage10ApproveAndContinue }]
            });
        } catch (err) {
            console.error('Execute plan failed:', err);
            if (stage10Chat) stage10Chat.append('system', 'Rewrite failed: ' + err.message);
        } finally {
            loadingOverlay?.classList.add('hidden');
            loadingOverlay?.classList.remove('flex');
            if (rightView) rightView.classList.remove('hidden');
            if (stage10Chat) stage10Chat.setThinking(false);
            if (stage10Chat) stage10Chat.setDisabled(false);
            stage10ExecutingPlan = false;
        }
    }

    async function stage10ApproveAndContinue() {
        stage10FlushEditPanel();
        const newIdx = stage10State.priority_idx + 1;
        try {
            await fetch('/api/approve-rewrite-priority', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, pendingScenes: stage10Pending, newPriorityIdx: newIdx })
            });
            Object.assign(stage10State.working, stage10Pending);
            Object.keys(stage10Pending).forEach(n => { stage10ApprovedScenes[parseInt(n)] = true; });
            stage10Pending = {};
            stage10State.priority_idx = newIdx;
            window.stage10CurrentPlan = null;
            if (window.currentProjectData?.stage9_rewrites) {
                window.currentProjectData.stage9_rewrites.priority_idx = newIdx;
            }
            stage10DeselectScene();

            const priorities = stage10GetPriorityList();
            if (newIdx >= priorities.length) {
                // All done — show done banner, post system message
                document.getElementById('stage10-done-banner')?.classList.remove('hidden');
                stage10Chat?.clear();
                stage10Chat?.append('system', 'All priorities addressed. Use the Finalize Rewrite button above to complete.');
            } else {
                // Clear chat and re-open with next priority
                stage10Chat?.clear();
                stage10Chat?.setDisabled(true);
                stage10Chat?.setThinking(true);
                try {
                    const initRes = await fetch('/api/brainstorm-rewrite', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: activeProjectId, messages: [], isInit: true })
                    });
                    const initData = await initRes.json();
                    stage10Chat?.append('ai', initData.message);
                } finally {
                    stage10Chat?.setThinking(false);
                    stage10Chat?.setDisabled(false);
                }
            }
        } catch (err) {
            console.error('Approve failed:', err);
            alert('Failed to save: ' + err.message);
        }
    }

    function initStage10Resizers() {
        const vsplit = document.getElementById('stage10-vsplit');
        const leftCont = document.getElementById('stage10-left-container');
        const rightCont = document.getElementById('stage10-right-container');
        if (vsplit && leftCont && rightCont) {
            const savedV = parseFloat(localStorage.getItem('stage10SplitV') || '0.5');
            leftCont.style.flexBasis = `${savedV * 100}%`;
            rightCont.style.flexBasis = `${(1 - savedV) * 100}%`;
            vsplit.addEventListener('mousedown', e => {
                e.preventDefault();
                vsplit.classList.add('dragging');
                const container = vsplit.parentElement;
                const onMove = ev => {
                    const rect = container.getBoundingClientRect();
                    const ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
                    leftCont.style.flexBasis = `${ratio * 100}%`;
                    rightCont.style.flexBasis = `${(1 - ratio) * 100}%`;
                    localStorage.setItem('stage10SplitV', ratio);
                };
                const onUp = () => { vsplit.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }
        const hsplit = document.getElementById('stage10-hsplit');
        const chatEl = document.getElementById('stage10-chat');
        if (hsplit && chatEl) {
            const savedH = parseInt(localStorage.getItem('stage10SplitH') || '280');
            chatEl.style.height = `${savedH}px`;
            initChatCollapse(10, chatEl, hsplit);
            hsplit.addEventListener('mousedown', e => {
                e.preventDefault();
                hsplit.classList.add('dragging');
                const startY = e.clientY;
                const startH = chatEl.offsetHeight;
                const onMove = ev => {
                    const newH = Math.min(600, Math.max(120, startH + (startY - ev.clientY)));
                    chatEl.style.height = `${newH}px`;
                    localStorage.setItem('stage10SplitH', newH);
                };
                const onUp = () => { hsplit.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }
    }

    async function initStage10() {
        if (!activeProjectId) return;
        const loading  = document.getElementById('stage10-loading');
        const workspace = document.getElementById('stage10-workspace');
        loading?.classList.remove('hidden');
        workspace?.classList.add('hidden');

        try {
            const reset = !!window.stage10ResetOnInit;
            window.stage10ResetOnInit = false;
            const res = await fetch('/api/init-stage9', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, reset })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to init Stage 10');
            const data = await res.json();

            stage10State = {
                working:      data.stage9_rewrites.working,
                priority_idx: data.stage9_rewrites.priority_idx,
                macro_todo:   data.macro_todo || [],
                micro_todo:   data.micro_todo  || [],
            };
            // Restore any pending rewrites that were saved to disk (survives page refresh)
            stage10Pending = data.stage9_rewrites.pending || {};
            stage10ApprovedScenes = {};

            loading?.classList.add('hidden');
            workspace?.classList.remove('hidden');

            renderStage10SceneList();
            renderStage10TaskBanner();
            stage10WireButtons();

            // If pending rewrites were restored from disk, select the first one
            const pendingKeys = Object.keys(stage10Pending).map(Number);
            if (pendingKeys.length > 0) {
                stage10SelectScene(pendingKeys[0]);
                renderStage10SceneList();
            }

            // Initialize chat window
            stage10Chat = new ChatWindow({
                threadId:  'stage10-chat-thread',
                inputId:   'stage10-chat-input',
                sendBtnId: 'btnChatSend',
                attachInputId: 'stage10-chat-attach',
                onSend: async (text, history, attachment) => {
                    if (stage10CurrentScene !== null && !isMemoryRecallPrompt(text)) {
                        // Scene selected: feedback for that scene
                        const priorities = stage10GetPriorityList();
                        const task = priorities[stage10State.priority_idx]?.task || '';
                        let currentText;
                        if (stage10ViewMode === 'formatted' && stage10Editor) {
                            currentText = stage10Editor.toFountain();
                        } else {
                            currentText = stage10Pending[stage10CurrentScene] ?? stage10State.working[stage10CurrentScene] ?? '';
                        }
                        stage10Chat.setThinking(true);
                        const res = await fetch('/api/rewrite-scene-feedback', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: activeProjectId, sceneNumber: stage10CurrentScene, priorityTask: task, userFeedback: text, currentText, ...(attachment && { attachment }) })
                        });
                        stage10Chat.setThinking(false);
                        if (!res.ok) throw new Error((await res.json()).error);
                        const data = await res.json();
                        noteSavedSource(stage10Chat, data.savedSource);
                        noteSourceMemoryUsed(stage10Chat, data.sourceMemory);
                        await handleSourceGenerationResult(10, data, { chat: stage10Chat });
                        stage10Pending[stage10CurrentScene] = data.proposed_text;
                        resetStage10ApproveBtn();
                        stage10SelectScene(stage10CurrentScene);
                        renderStage10SceneList();
                        stage10Chat.append('ai', `Scene ${stage10CurrentScene} updated. Review the diff on the right.`);
                    } else {
                        // No scene selected: planning brainstorm
                        const msgs = history.filter(m => m.role !== 'system');
                        stage10Chat.setThinking(true);
                        const res = await fetch('/api/brainstorm-rewrite', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: activeProjectId, messages: msgs, isInit: false, ...(attachment && { attachment }) })
                        });
                        stage10Chat.setThinking(false);
                        if (!res.ok) throw new Error((await res.json()).error);
                        const data = await res.json();
                        noteSavedSource(stage10Chat, data.savedSource);
                        noteSourceMemoryUsed(stage10Chat, data.sourceMemory);
                        if (normalizeSourceWarnings(data.sourceWarnings).length) {
                            await handleSourceGenerationResult(10, data, { chat: stage10Chat, postGenerationCheck: false });
                        }
                        stage10Chat.append('ai', data.message);
                        if (data.suggest_plan && !window.stage10CurrentPlan && !stage10ExecutingPlan) stage10GeneratePlan();
                    }
                }
            });
            stageChatWindows[10] = stage10Chat;
            const savedStage10Convo = window.currentProjectData?.conversations?.stage9 || [];
            if (savedStage10Convo.length && (!stage10Chat.history || stage10Chat.history.length === 0)) {
                stage10Chat.restoreHistory(savedStage10Convo);
            }
            stage10Chat.applySourceAudit = async (audit, button) => {
                const originalText = button?.textContent || 'Apply Recommended Fixes';
                if (button) {
                    button.disabled = true;
                    button.textContent = 'Applying...';
                }
                const notes = buildSourceAuditRevisionNotes(audit);
                try {
                    if (stage10CurrentScene === null) {
                        stage10Chat.history.push({ role: 'user', content: notes });
                        stage10Chat.append('system', 'Source audit findings added to the rewrite planning context.');
                        await logKnowledgeDecision(
                            'source_audit_fix_plan_requested',
                            10,
                            `Queued source audit fixes for Stage 10 planning: ${summarizeAuditForUi(audit)}`,
                            audit
                        );
                        await stage10GeneratePlan();
                        if (button) button.textContent = 'Queued';
                        return;
                    }

                    const priorities = stage10GetPriorityList();
                    const task = priorities[stage10State.priority_idx]?.task || 'Apply source alignment fixes.';
                    const currentText = stage10ViewMode === 'formatted' && stage10Editor
                        ? stage10Editor.toFountain()
                        : (stage10Pending[stage10CurrentScene] ?? stage10State.working[stage10CurrentScene] ?? '');

                    stage10Chat.setDisabled(true);
                    stage10Chat.setThinking(true);
                    const res = await fetch('/api/rewrite-scene-feedback', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            projectId: activeProjectId,
                            sceneNumber: stage10CurrentScene,
                            priorityTask: task,
                            userFeedback: notes,
                            currentText
                        })
                    });
                    stage10Chat.setThinking(false);
                    if (!res.ok) throw new Error((await res.json()).error || `Server error ${res.status}`);
                    const data = await res.json();
                    await handleSourceGenerationResult(10, data, { chat: stage10Chat });
                    stage10Pending[stage10CurrentScene] = data.proposed_text;
                    resetStage10ApproveBtn();
                    stage10SelectScene(stage10CurrentScene);
                    renderStage10SceneList();
                    await logKnowledgeDecision(
                        'source_audit_fixes_applied',
                        10,
                        `Applied source audit fixes to Stage 10 scene ${stage10CurrentScene}: ${summarizeAuditForUi(audit)}`,
                        audit
                    );
                    stage10Chat.append('ai', `Scene ${stage10CurrentScene} updated from the source audit. Review the diff on the right.`);
                    if (button) button.textContent = 'Applied';
                } catch (err) {
                    stage10Chat.setThinking(false);
                    stage10Chat.append('system', 'Source audit apply failed: ' + err.message);
                    if (button) {
                        button.disabled = false;
                        button.textContent = originalText;
                    }
                } finally {
                    stage10Chat.setDisabled(false);
                }
            };
            // Fetch AI opening message (presents Stage 9 priorities)
            if (!savedStage10Convo.length) {
                try {
                    stage10Chat.setThinking(true);
                    stage10Chat.setDisabled(true);
                    const initRes = await fetch('/api/brainstorm-rewrite', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: activeProjectId, messages: [], isInit: true })
                    });
                    if (initRes.ok) {
                        const initData = await initRes.json();
                        stage10Chat.append('ai', initData.message);
                    }
                } catch (e) {
                    console.warn('Chat init failed:', e.message);
                } finally {
                    stage10Chat.setThinking(false);
                    stage10Chat.setDisabled(false);
                }
            }
        } catch (err) {
            console.error('initStage10 error:', err);
            if (loading) loading.querySelector('p').textContent = 'Failed to load: ' + err.message;
        }
    }

    function stage10GetPriorityList() {
        const macro = (stage10State.macro_todo || []).map((t, i) => ({ ...t, list: 'MACRO', localIdx: i }));
        const micro = (stage10State.micro_todo  || []).map((t, i) => ({ ...t, list: 'MICRO', localIdx: i }));
        return [...macro, ...micro];
    }

    function renderStage10TaskBanner() {
        const priorities = stage10GetPriorityList();
        const idx = stage10State.priority_idx;
        const doneBanner = document.getElementById('stage10-done-banner');
        if (idx >= priorities.length) {
            doneBanner?.classList.remove('hidden');
        } else {
            doneBanner?.classList.add('hidden');
        }
    }

    function renderStage10SceneList() {
        const container = document.getElementById('stage10-scene-list');
        if (!container || !stage10State) return;
        const entries = Object.keys(stage10State.working).map(n => parseInt(n)).sort((a, b) => a - b);
        container.innerHTML = entries.map(n => {
            const hasPending  = !!stage10Pending[n];
            const hasApproved = !!stage10ApprovedScenes[n];
            const dot = hasPending
                ? '<span class="text-blue-400 ml-1 text-xs">●</span>'
                : hasApproved
                    ? '<span class="text-green-500 ml-1 text-xs">✓</span>'
                    : '';
            const isActive = n === stage10CurrentScene ? 'bg-white/10' : 'hover:bg-white/5';
            // Get slugline from stage6 data
            const allScenes = getFlatScenes();
            const sceneData = allScenes.find(s => s.scene_number === n);
            const label = sceneData?.scene_heading || sceneData?.slugline || `Scene ${n}`;
            return `<button onclick="window.stage10SelectSceneBtn(${n})"
                class="w-full text-left px-3 py-2 rounded text-xs text-gray-300 transition-colors ${isActive} flex items-center justify-between gap-2">
                <span class="truncate">${n}. ${escapeHtml(label)}</span>${dot}
            </button>`;
        }).join('');
    }

    let stage10Editor = null;
    let stage10ViewMode = 'preview'; // 'preview' | 'formatted'

    function stage10DeselectScene() {
        stage10CurrentScene = null;
        const leftPanel = document.getElementById('stage10-left-panel');
        const editorMount = document.getElementById('stage10-editor-mount');
        const rightView = document.getElementById('stage10-right-panel-view');
        if (leftPanel) leftPanel.innerHTML = '<p class="text-gray-600 italic text-xs">Select a scene from the sidebar...</p>';
        if (editorMount) editorMount.classList.add('hidden');
        if (rightView) { rightView.classList.remove('hidden'); rightView.innerHTML = '<p class="text-gray-600 italic text-xs">Start a conversation below to begin...</p>'; }
        if (stage10Editor) { stage10Editor.destroy(); stage10Editor = null; }
        stage10ViewMode = 'preview';
        stage10UpdateToggleButtons();
        renderStage10SceneList();
    }

    window.stage10SelectSceneBtn = function(n) {
        if (n === stage10CurrentScene) {
            stage10DeselectScene();
        } else {
            stage10SelectScene(n);
        }
    };

    function stage10SelectScene(n) {
        // Flush any current editor/textarea edit into pending
        stage10FlushEditPanel();
        stage10CurrentScene = n;

        const origText     = stage10State.working[n] || '';
        const proposedText = stage10Pending[n] !== undefined ? stage10Pending[n] : origText;
        const leftPanel    = document.getElementById('stage10-left-panel');
        const editorMount  = document.getElementById('stage10-editor-mount');
        const rightView    = document.getElementById('stage10-right-panel-view');

        // Left panel: show original with diff highlights if there are pending changes
        if (stage10Pending[n] !== undefined) {
            const { leftAnnotations } = computeLineDiff(origText, proposedText);
            if (leftPanel)  leftPanel.innerHTML  = formatFountainToHTML(origText, leftAnnotations);
        } else {
            if (leftPanel)  leftPanel.innerHTML  = formatFountainToHTML(origText);
        }

        // Right panel: default to preview (diff) view
        if (stage10Pending[n] !== undefined) {
            const { rightAnnotations } = computeLineDiff(origText, proposedText);
            if (rightView) rightView.innerHTML = formatFountainToHTML(proposedText, rightAnnotations);
        } else {
            if (rightView) rightView.innerHTML = formatFountainToHTML(proposedText);
        }

        // Ensure editor is loaded (for Edit mode, lazily created)
        if (!stage10Editor && editorMount) {
            const s10ToolbarSlot = document.getElementById('stage10-toolbar-slot');
            stage10Editor = new FountainEditor(editorMount, {
                externalToolbarSlot: s10ToolbarSlot,
                onDirty: () => {
                    if (stage10CurrentScene !== null) {
                        stage10Pending[stage10CurrentScene] = stage10Editor.toFountain();
                        resetStage10ApproveBtn();
                        renderStage10SceneList();
                        // Update left panel diff
                        const orig = stage10State.working[stage10CurrentScene] || '';
                        const proposed = stage10Editor.toFountain();
                        const { leftAnnotations } = computeLineDiff(orig, proposed);
                        const lp = document.getElementById('stage10-left-panel');
                        if (lp) lp.innerHTML = formatFountainToHTML(orig, leftAnnotations);
                    }
                }
            });
        }
        if (stage10Editor) stage10Editor.loadFountain(proposedText);

        // Default to preview view
        stage10ViewMode = 'preview';
        if (editorMount) editorMount.classList.add('hidden');
        if (rightView) rightView.classList.remove('hidden');
        stage10UpdateToggleButtons();

        renderStage10SceneList();
    }

    function stage10FlushEditPanel() {
        if (stage10CurrentScene === null) return;
        // Only flush editor text to pending if this scene already has pending changes
        // (prevents overwriting original text with editor-normalized version)
        if (stage10ViewMode === 'formatted' && stage10Editor && stage10Pending[stage10CurrentScene] !== undefined) {
            stage10Pending[stage10CurrentScene] = stage10Editor.toFountain();
        }
    }

    function stage10UpdateToggleButtons() {
        const btnF = document.getElementById('btnToggleFormatted');
        const btnP = document.getElementById('btnTogglePreview');
        const active = 'text-blue-400 bg-blue-900/30';
        const inactive = 'text-gray-500 hover:text-gray-300';
        if (btnP) { btnP.className = `text-xs px-2 py-1 rounded transition-colors ${stage10ViewMode === 'preview' ? active : inactive}`; }
        if (btnF) { btnF.className = `text-xs px-2 py-1 rounded transition-colors ${stage10ViewMode === 'formatted' ? active : inactive}`; }
    }

    function stage10WireButtons() {
        // ── Toggle: Preview | Edit ────────────────────────────────────────────
        function stage10SwitchView(mode) {
            stage10FlushEditPanel(); // flush current mode first
            stage10ViewMode = mode;

            const editorMount = document.getElementById('stage10-editor-mount');
            const rightView   = document.getElementById('stage10-right-panel-view');
            if (!editorMount || !rightView) return;

            const origText     = stage10CurrentScene !== null ? (stage10State.working[stage10CurrentScene] || '') : '';
            const proposedText = stage10CurrentScene !== null
                ? (stage10Pending[stage10CurrentScene] !== undefined ? stage10Pending[stage10CurrentScene] : origText)
                : '';

            editorMount.classList.add('hidden');
            rightView.classList.add('hidden');

            if (mode === 'formatted') {
                editorMount.classList.remove('hidden');
                if (stage10Editor) stage10Editor.loadFountain(proposedText);
            } else {
                // Preview mode (default)
                rightView.classList.remove('hidden');
                if (stage10Pending[stage10CurrentScene] !== undefined) {
                    const { rightAnnotations } = computeLineDiff(origText, proposedText);
                    rightView.innerHTML = formatFountainToHTML(proposedText, rightAnnotations);
                } else {
                    rightView.innerHTML = formatFountainToHTML(proposedText);
                }
            }

            // Update left panel diff
            if (stage10CurrentScene !== null && stage10Pending[stage10CurrentScene] !== undefined) {
                const { leftAnnotations } = computeLineDiff(origText, proposedText);
                const leftPanel = document.getElementById('stage10-left-panel');
                if (leftPanel) leftPanel.innerHTML = formatFountainToHTML(origText, leftAnnotations);
            }

            stage10UpdateToggleButtons();
            renderStage10SceneList();
        }

        const btnF = document.getElementById('btnToggleFormatted');
        const btnP = document.getElementById('btnTogglePreview');
        if (btnF) btnF.onclick = () => stage10SwitchView('formatted');
        if (btnP) btnP.onclick = () => stage10SwitchView('preview');

        // ── Finalize Rewrite ──────────────────────────────────────────────────
        async function finalizeStage10() {
            stage10FlushEditPanel();
            const approvalBtn = document.getElementById('btnStage10Approve') || btnFinalize;
            if (!(await runApprovalSourceGuard(10, approvalBtn))) return;
            if (Object.keys(stage10Pending).length > 0) {
                await fetch('/api/approve-rewrite-priority', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: activeProjectId, pendingScenes: stage10Pending, newPriorityIdx: stage10State.priority_idx })
                });
                Object.assign(stage10State.working, stage10Pending);
                stage10Pending = {};
            }
            await fetch('/api/finalize-stage10', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId })
            });

            const projRes = await fetch(`/api/projects/${activeProjectId}`);
            const projData = await projRes.json();
            window.currentProjectData = projData.data;

            // Snapshot Stage 10
            const versionHistory9 = captureVersionSnapshot(10, 'stage9_rewrites', 'Rewrite', projData.data.stage9_rewrites);
            await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { versionHistory: versionHistory9 } })
            });
            await offerStageMemoryCuration(10);

            updateStageNav(projData.data);

            // Show loopback modal instead of jumping straight to Stage 10
            const loopbackModal = document.getElementById('stage10-loopback-modal');
            if (loopbackModal) loopbackModal.classList.remove('hidden');
        }

        const btnFinalize = document.getElementById('btnFinalizeRewrite');
        if (btnFinalize) btnFinalize.onclick = finalizeStage10;

        const btnApprove9 = document.getElementById('btnStage10Approve');
        if (btnApprove9) btnApprove9.addEventListener('click', finalizeStage10);

        // ── Download Rewrite (.fountain + PDF) ─────────────────────────────────
        const btnFountain = document.getElementById('btnDownloadRewriteFountain');
        if (btnFountain) {
            btnFountain.onclick = () => {
                if (!stage10State?.working) { alert('No rewrite data available.'); return; }
                const entries = Object.keys(stage10State.working).map(Number).sort((a, b) => a - b);
                const fountainText = entries.map(n => (stage10State.working[n] || '').trim()).filter(t => t && t !== '[SCENE DELETED]').join('\n\n');
                const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'screenplay';
                const blob = new Blob([fountainText], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = makeFilename(title, 'rewrite', 'fountain');
                a.click();
                URL.revokeObjectURL(url);
            };
        }

        const btnPdf = document.getElementById('btnDownloadRewritePdf');
        if (btnPdf) {
            btnPdf.onclick = () => {
                if (!stage10State) { alert('No rewrite data available.'); return; }
                triggerApiDownload(`/api/export/pdf/${activeProjectId}?stage=rewrite`, btnPdf);
            };
        }

        // ── Resize handles ────────────────────────────────────────────────────
        initStage10Resizers();
    }

    function resetStage10ApproveBtn() {
        const btn = document.getElementById('btnStage10Approve');
        if (btn && (btn.textContent.includes('Approved') || btn.disabled)) {
            btn.textContent = 'Approve';
            btn.classList.remove('approve-btn-green');
            btn.disabled = false;
        }
    }

});

// --- Stage 8 Helpers ---
    function getFlatScenes() {
        const data = window.currentProjectData?.stage6_scenes;
        if (!data) return [];

        let scenes = [];
        if (Array.isArray(data)) {
            data.forEach(seq => { if (seq.scenes) scenes.push(...seq.scenes); });
        } else if (data.sequences && Array.isArray(data.sequences)) {
            data.sequences.forEach(seq => { if (seq.scenes) scenes.push(...seq.scenes); });
        } else if (data.scenes && Array.isArray(data.scenes)) {
            scenes = data.scenes;
        }
        return scenes;
    }

    window.toggleSceneDetails = function(element, event) {
        if (event) event.stopPropagation();
        const card = element.closest('.scene-accordion-card');
        const body = card.querySelector('.accordion-body');
        const chevron = card.querySelector('.chevron-icon');
        body.classList.toggle('hidden');
        chevron.classList.toggle('rotate-180', !body.classList.contains('hidden'));
    };

    // ─── Settings Modal ────────────────────────────────────────────────────────

    const MODEL_OPTIONS = [
        { value: 'gemini-3.1-pro-preview',    label: 'Gemini 3.1 Pro' },
        { value: 'gemini-3-flash-preview',    label: 'Gemini 3 Flash' },
        { value: 'claude-opus-4-7',           label: 'Claude Opus 4.7' },
        { value: 'claude-opus-4-6',           label: 'Claude Opus 4.6' },
        { value: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
        { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ];

    const STAGE_LABELS = [
        [1, 'Pitch'], [2, 'Outline'], [3, 'Characters'], [4, 'Beats'],
        [5, 'Treatment'], [6, 'Scenes'], [7, 'Style'], [8, 'Draft'],
        [9, 'Coverage'], [10, 'Rewrite']
    ];

    const settingsModal = document.getElementById('settingsModal');

    function buildModelSelect(stageNum, currentModel) {
        const select = document.createElement('select');
        select.id = `settings-model-stage${stageNum}`;
        select.className = 'modal-input';
        select.style.cssText = 'flex:1;padding:4px 8px';
        MODEL_OPTIONS.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === currentModel) option.selected = true;
            select.appendChild(option);
        });
        return select;
    }

    async function openSettingsModal() {
        let settings = { stageModels: {} };
        try {
            const res = await fetch('/api/settings');
            settings = await res.json();
        } catch (e) {
            console.warn('Could not load settings:', e);
        }

        const apiKeySection = document.getElementById('settings-api-key-section');
        const managedKeySection = document.getElementById('settings-api-key-managed');
        if (settings.apiKeysManagedByServer) {
            apiKeySection?.classList.add('hidden');
            managedKeySection?.classList.remove('hidden');
        } else {
            apiKeySection?.classList.remove('hidden');
            managedKeySection?.classList.add('hidden');
        }

        // Never pre-fill API key fields (they show masked values server-side)
        document.getElementById('settings-gemini-key').value = '';
        document.getElementById('settings-anthropic-key').value = '';

        // Build per-stage model dropdowns
        const container = document.getElementById('settings-stage-models');
        container.innerHTML = '';
        STAGE_LABELS.forEach(([num, label]) => {
            const currentModel = settings.stageModels?.[`stage${num}`] || 'gemini-3.1-pro-preview';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:12px';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'width:130px;font-size:0.8rem;color:#9ca3af;flex-shrink:0';
            lbl.textContent = `Stage ${num}: ${label}`;
            row.appendChild(lbl);
            row.appendChild(buildModelSelect(num, currentModel));
            container.appendChild(row);
        });

        settingsModal.classList.remove('hidden');
    }

    function closeSettingsModal() {
        settingsModal.classList.add('hidden');
    }

    document.getElementById('btnOpenSettings')?.addEventListener('click', openSettingsModal);
    document.getElementById('btnOpenSettingsHub')?.addEventListener('click', openSettingsModal);
    document.getElementById('cancelSettingsBtn')?.addEventListener('click', closeSettingsModal);

    document.getElementById('saveSettingsBtn')?.addEventListener('click', async () => {
        const geminiApiKey = document.getElementById('settings-gemini-key').value.trim();
        const anthropicApiKey = document.getElementById('settings-anthropic-key').value.trim();

        const stageModels = {};
        STAGE_LABELS.forEach(([num]) => {
            const sel = document.getElementById(`settings-model-stage${num}`);
            if (sel) stageModels[`stage${num}`] = sel.value;
        });

        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiApiKey, anthropicApiKey, stageModels })
            });
            if (!res.ok) throw new Error('Save failed');
            closeSettingsModal();
        } catch (err) {
            console.error('Failed to save settings:', err);
            alert('Failed to save settings. Check the console for details.');
        }
    });

    // Close modal when clicking the overlay backdrop
    settingsModal?.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettingsModal();
    });

    // ─── Project Spend Modal ────────────────────────────────────────────────

    const MODEL_PRICING = {
        'gemini-3.1-pro-preview':      { input: 1.25 / 1e6, output: 10.0 / 1e6, label: 'Gemini 3.1 Pro' },
        'gemini-2.5-pro-preview-05-06':{ input: 1.25 / 1e6, output: 10.0 / 1e6, label: 'Gemini 2.5 Pro' },
        'gemini-3-flash-preview':      { input: 0.10 / 1e6, output: 0.40 / 1e6, label: 'Gemini 3 Flash' },
        'gemini-2.0-flash':            { input: 0.10 / 1e6, output: 0.40 / 1e6, label: 'Gemini 2.0 Flash' },
        'gemini-2.0-flash-001':        { input: 0.10 / 1e6, output: 0.40 / 1e6, label: 'Gemini 2.0 Flash' },
        'claude-opus-4-7':             { input: 15.0 / 1e6, output: 75.0 / 1e6, label: 'Claude Opus 4.7' },
        'claude-opus-4-6':             { input: 15.0 / 1e6, output: 75.0 / 1e6, label: 'Claude Opus 4.6' },
        'claude-sonnet-4-6':           { input: 3.0 / 1e6,  output: 15.0 / 1e6, label: 'Claude Sonnet 4.6' },
        'claude-haiku-4-5-20251001':   { input: 0.80 / 1e6, output: 4.0 / 1e6,  label: 'Claude Haiku 4.5' },
    };

    const spendModal = document.getElementById('spendModal');

    function openSpendModal() {
        const content = document.getElementById('spend-modal-content');
        if (!content) return;

        const usage = window.currentProjectData?.apiUsage || [];

        if (!usage.length) {
            content.innerHTML = '<p style="color:#6b7280;font-size:0.85rem;text-align:center;padding:24px 0">No usage data yet. Generate some content to start tracking costs.</p>';
            spendModal?.classList.remove('hidden');
            return;
        }

        // Aggregate by model
        const byModel = {};
        for (const u of usage) {
            const key = u.model || 'unknown';
            if (!byModel[key]) byModel[key] = { inputTokens: 0, outputTokens: 0, calls: 0 };
            byModel[key].inputTokens += u.inputTokens || 0;
            byModel[key].outputTokens += u.outputTokens || 0;
            byModel[key].calls += 1;
        }

        // Calculate costs
        let totalCost = 0;
        const rows = Object.entries(byModel).map(([model, data]) => {
            const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
            const cost = (data.inputTokens * pricing.input) + (data.outputTokens * pricing.output);
            totalCost += cost;
            const label = MODEL_PRICING[model]?.label || model;
            return { label, model, ...data, cost };
        }).sort((a, b) => b.cost - a.cost);

        let html = `<div style="text-align:center;margin-bottom:20px">
            <div style="font-size:2rem;font-weight:700;color:#e5e7eb">$${totalCost.toFixed(2)}</div>
            <div style="font-size:0.75rem;color:#6b7280;margin-top:4px">${usage.length} API calls</div>
        </div>`;

        html += `<table style="width:100%;font-size:0.8rem;border-collapse:collapse">
            <thead>
                <tr style="color:#9ca3af;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08)">
                    <th style="padding:8px 4px">Model</th>
                    <th style="padding:8px 4px;text-align:right">Input</th>
                    <th style="padding:8px 4px;text-align:right">Output</th>
                    <th style="padding:8px 4px;text-align:right">Cost</th>
                </tr>
            </thead>
            <tbody>`;

        for (const r of rows) {
            const fmtTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toString();
            html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
                <td style="padding:8px 4px;color:#d1d5db">${r.label}</td>
                <td style="padding:8px 4px;text-align:right;color:#9ca3af">${fmtTokens(r.inputTokens)}</td>
                <td style="padding:8px 4px;text-align:right;color:#9ca3af">${fmtTokens(r.outputTokens)}</td>
                <td style="padding:8px 4px;text-align:right;color:#e5e7eb;font-weight:600">$${r.cost.toFixed(2)}</td>
            </tr>`;
        }

        html += '</tbody></table>';
        html += '<p style="font-size:0.65rem;color:#4b5563;margin-top:12px;text-align:center">Costs are estimates based on published API pricing.</p>';

        content.innerHTML = html;
        spendModal?.classList.remove('hidden');
    }

    function closeSpendModal() {
        spendModal?.classList.add('hidden');
    }

    document.getElementById('btnProjectSpend')?.addEventListener('click', openSpendModal);
    document.getElementById('closeSpendBtn')?.addEventListener('click', closeSpendModal);
    spendModal?.addEventListener('click', (e) => {
        if (e.target === spendModal) closeSpendModal();
    });
