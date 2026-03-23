document.addEventListener('DOMContentLoaded', () => {
    let activeProjectId = null;
    let targetProjectId = null; // Used for rename and delete operations
    let currentDraftSceneNumber = 1;
    let isBatchGenerating = false;

    function autoResize(textarea) {
        if (!textarea) return;
        // Lock width to prevent CSS Grid reflow when height collapses
        const w = textarea.offsetWidth;
        textarea.style.width = w + 'px';
        textarea.style.overflow = 'auto';
        textarea.style.height = '0px';
        const h = Math.max(textarea.scrollHeight, 24);
        textarea.style.height = h + 'px';
        textarea.style.overflow = 'hidden';
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

    // Version History navigation
    const btnVersionHistory = document.getElementById('btnVersionHistory');
    const versionHistoryWorkspace = document.getElementById('version-history-view');

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
    const stage6PdfUpload = document.getElementById('stage6PdfUpload');
    const stage6FileNameDisplay = document.getElementById('stage6FileNameDisplay');


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

    // Stage 4 Workshop Elements
    const stage4Workshop = document.getElementById('stage4Workshop');
    const loadingStateTreatment = document.getElementById('loadingStateTreatment');
    const loadingTextTreatment = document.getElementById('loadingTextTreatment');
    const treatmentContainer = document.getElementById('treatmentContainer');
    const btnStage4Revise = document.getElementById('btn-stage4-revise');
    const btnStage4Approve = document.getElementById('btn-stage4-approve');
    const btnStage4Edit = document.getElementById('btn-stage4-edit');
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
    }

    function renderProjects(projects) {
        projectsGrid.innerHTML = '';
        projects.forEach(project => {
            const card = document.createElement('div');
            card.className = 'project-card';
            card.innerHTML = `
                <h3 class="project-title" data-id="${project.id}">${escapeHtml(project.title)}</h3>
                <div class="project-meta">ID: ${project.id}</div>
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
        if (importDropLabel) importDropLabel.innerHTML = `<span style="color:#60a5fa">${file.name}</span><br><span style="font-size:0.75rem;color:#4b5563">${(file.size / 1024).toFixed(1)} KB</span>`;
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
                const CONVO_TO_CHAT = { stage1: 1, stage2: 2, stage3: 3, stage4: 4, stage5: 5, stage6: 6, stage7: 7, stage8: 8 };
                for (const [key, chatIdx] of Object.entries(CONVO_TO_CHAT)) {
                    if (savedConvos[key]?.length && stageChatWindows[chatIdx]) {
                        stageChatWindows[chatIdx].restoreHistory(savedConvos[key]);
                    }
                }
            } else {
                updateStageNav(projectDetails.data);
            }
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

            const response = await fetch('/api/execute', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}`);
            }

            const data = await response.json();
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
    }

    function switchToVersionHistory() {
        for (let i = 1; i <= 10; i++) {
            navItems[i]?.classList.remove('active');
            workspaces[i]?.classList.add('hidden');
        }
        versionHistoryWorkspace?.classList.remove('hidden');
        btnVersionHistory?.classList.add('active');
        renderVersionHistory();
    }

    // Stage labels for user-facing messages
    const STAGE_LABELS = { 1: 'Pitch', 2: 'Outline', 3: 'Characters', 4: 'Beats', 5: 'Treatment', 6: 'Scenes', 7: 'Style', 8: 'Draft', 9: 'Coverage', 10: 'Rewrite' };

    function switchStage(stageNum) {
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

        // Special handling for Stages 3 & 4 autoResize (as previously fixed)
        if (stageNum === 3) {
            setTimeout(() => {
                document.querySelectorAll('.char-ta').forEach(ta => autoResize(ta));
            }, 50);
        } else if (stageNum === 4) {
            setTimeout(() => {
                document.querySelectorAll('.editable-treatment-field').forEach(ta => autoResize(ta));
            }, 50);
        } else if (stageNum === 6) {
            // Visualize dummy data for Stage 6 if board is empty
            if (stage6Board && !stage6Board.innerHTML.trim()) {
                renderStage6();
            }
            setTimeout(() => {
                document.querySelectorAll('.scene-textarea').forEach(ta => autoResize(ta));
            }, 50);
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

    // --- Version History Logic ---

    function captureVersionSnapshot(stage, stageKey, stageName, snapshotData) {
        const history = (window.currentProjectData?.versionHistory) || [];
        const existingVersions = history.filter(v => v.stage === stage).length;
        const entry = {
            id: `${activeProjectId}_stage${stage}_v${existingVersions + 1}`,
            stage, stageKey, stageName,
            version: existingVersions + 1,
            approvedAt: new Date().toISOString(),
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
                html += `<div style="background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
                    <div>
                        <div style="font-size:0.9rem;color:#e5e7eb;font-weight:500">Version ${v.version}</div>
                        <div style="font-size:0.75rem;color:#6b7280;margin-top:2px">${dateStr} at ${timeStr}</div>
                    </div>
                    <div style="display:flex;gap:8px;flex-shrink:0">
                        <button class="secondary-btn" style="font-size:0.75rem;padding:6px 12px" onclick="window.previewVersionById('${v.id}')">View</button>
                        <button class="secondary-btn" style="font-size:0.75rem;padding:6px 12px" onclick="window.restoreVersionById('${v.id}')">Restore</button>
                    </div>
                </div>`;
            });
            html += `</div></div>`;
        });
        container.innerHTML = html;
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
                body: JSON.stringify({ data: { [version.stageKey]: version.snapshot } })
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
        document.getElementById('act1Container').innerHTML = '';
        document.getElementById('act2Container').innerHTML = '';
        document.getElementById('act3Container').innerHTML = '';

        try {
            const res = await fetch('/api/generate-outline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId })
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Failed to generate outline");
            }

            const data = await res.json();
            renderOutline(data.result.outline);
            if (window.currentProjectData) window.currentProjectData.stage2_outline = data.result;
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
            if (stage2PdfUpload && stage2PdfUpload.files[0]) {
                formData.append('pdfFile', stage2PdfUpload.files[0]);
            }

            const res = await fetch('/api/generate-outline', {
                method: 'POST',
                body: formData
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Failed to revise outline");
            }

            const data = await res.json();
            renderOutline(data.result.outline);
            if (window.currentProjectData) window.currentProjectData.stage2_outline = data.result;

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
            alert("Error revising beats.");
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

    function renderCharacters(characters) {
        if (!charactersContainer) return;
        charactersContainer.innerHTML = '';
        _deepProfileCache = {};

        // Sort: Protagonist first, Antagonist second, Supporting last
        const sorted = [...characters].sort((a, b) => {
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
                updateStageNav(updatedProject.data);

                btnStage3Approve.textContent = 'Approved ✓';
                btnStage3Approve.classList.add('approve-btn-green');

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
            } finally {
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

    // =============================================
    // === Stage 4: Treatment Logic ===
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

    // Renders the treatment data into the UI
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

                // Helper to create labeled textarea fields
                const fields = [
                    { label: 'DETAILED ACTION', key: 'detailed_action', value: beat.detailed_action },
                    { label: 'GENRE VARIATION NOTES', key: 'genre_variation_notes', value: beat.genre_variation_notes },
                    { label: 'EMOTIONAL ARC', key: 'emotional_arc', value: beat.emotional_arc },
                    { label: 'PACING NOTES', key: 'pacing_notes', value: beat.pacing_notes }
                ];

                fields.forEach(f => {
                    const label = document.createElement('label');
                    label.className = 'text-gray-400 block mb-1 text-xs font-semibold tracking-wider uppercase';
                    label.style.cssText = 'color: #9ca3af; display: block; margin-bottom: 4px; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding-top: 12px;';
                    label.textContent = f.label;
                    card.appendChild(label);

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
                    card.appendChild(ta);
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

        // Auto-resize all treatment textareas AFTER container is visible
        // Use setTimeout to ensure the browser has painted and computed layout
        setTimeout(() => {
            treatmentContainer.querySelectorAll('.editable-treatment-field').forEach(ta => autoResize(ta));
        }, 50);
    }

    // Scrape treatment from the DOM
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

    // Auto-generate treatment from Stages 1-3
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
                        const projRes = await fetch(`/api/projects/${activeProjectId}`);
                        const projData = await projRes.json();
                        updateStageNav(projData.data);
                    } else if (event.type === 'error') {
                        throw new Error(event.message);
                    }
                }
            }
        } catch (err) {
            console.error('Error generating treatment:', err);
            alert('An error occurred while generating the treatment. You can retry with the Generate Treatment button.');
            if (treatmentActions) treatmentActions.classList.remove('hidden');
        } finally {
            if (loadingStateTreatment) loadingStateTreatment.classList.add('hidden');
        }
    }

    // Generate Treatment button click handler
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
                    console.error('Failed to manual save treatment:', err);
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
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        }
                    }
                }
            } catch (err) {
                console.error('Error revising treatment:', err);
                alert('An error occurred while revising the treatment.');
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
                updateStageNav(updatedProject.data);

                btnStage4Approve.textContent = 'Approved ✓';
                btnStage4Approve.classList.add('approve-btn-green');

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
            } finally {
                btnStage4Approve.disabled = false;
            }
        });
    }

    // --- Stage 5: Treatment Functions ---

    function renderTreatmentStage5(data) {
        if (!data) return;
        if (stage5TreatmentContainer) stage5TreatmentContainer.classList.remove('hidden');
        if (stage5Workshop) stage5Workshop.classList.remove('hidden');
        if (stage5Actions) stage5Actions.classList.add('hidden');

        Object.keys(stage5TAs).forEach(key => {
            if (stage5TAs[key]) {
                const ta = stage5TAs[key];
                ta.value = data[key] || '';
                
                // Force Apply the Card Aesthetic Classes to match Stage 4 exactly
                ta.className = "editable-field w-full p-6 rounded-xl bg-[#1f2937] text-gray-300 text-sm leading-relaxed border-none focus:ring-0 focus:outline-none resize-y overflow-y-auto max-h-96 treatment-stage5-ta";
                
                // For Stage 5 treatment fields, we skip autoResize because we want fixed max-height + scrollbar
                // However, if the text is short, we still want it to fit normally.
                // Let's call autoResize but then immediately ensure overflow-y-auto is set
                autoResize(ta);
                ta.style.overflowY = 'auto'; // Re-enable scrollbars specifically for Treatment

                // Add input listeners for user edits
                if (!ta.dataset.listenerAdded) {
                    ta.addEventListener('input', () => {
                        autoResize(ta);
                        ta.style.overflowY = 'auto'; // Keep scrollbars enabled
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
            const currentData = scrapeTreatmentStage5();
            const originalText = btnStage5Approve.textContent;

            const existingHistory = (window.currentProjectData?.versionHistory) || [];
            const isReApproval = existingHistory.filter(v => v.stage === 5).length > 0;

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
                updateStageNav(updatedProject.data);

                btnStage5Approve.textContent = 'Approved ✓';
                btnStage5Approve.classList.add('approve-btn-green');

                if (btnStage5Edit) btnStage5Edit.classList.remove('hidden');
                btnStage5Revise.classList.add('hidden');

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
            } finally {
                btnStage5Approve.disabled = false;
            }
        });
    }

    // --- Stage 6 Logic: Scene Blueprint ---

    function renderStage6(data) {
        const container = document.getElementById('stage6-blueprint-container');
        if (!container) return;
        container.innerHTML = ''; // Wipe clean before drawing

        // Dummy Data implementation
        const dummyData = {
            sequences: [
                {
                    sequence_title: "Sequence 1: The Setup",
                    scenes: [
                        {
                            scene_number: 1,
                            scene_heading: "EXT. CITY STREET - DAY",
                            narrative_action: "The protagonist walks through the crowded street, looking for something.",
                            dramaturgical_function: "Establish the setting and the protagonist's initial goal.",
                            estimated_page_count: "1.5 pgs"
                        },
                        {
                            scene_number: 2,
                            scene_heading: "INT. COFFEE SHOP - DAY",
                            narrative_action: "He meets his contact, who looks nervous. They exchange a cryptic package.",
                            dramaturgical_function: "Introduce the inciting incident and a secondary character.",
                            estimated_page_count: "2 pgs"
                        }
                    ]
                }
            ]
        };

        // Determine data structure
        let sequences = [];
        if (!data) {
            sequences = dummyData.sequences; 
        } else if (Array.isArray(data)) {
            sequences = data; // Flat array of sequences
        } else if (data.sequences && Array.isArray(data.sequences)) {
            sequences = data.sequences; // Nested sequences
        } else if (data.scenes && Array.isArray(data.scenes)) {
            // Flat array of scenes: wrap them so they render in a single block
            sequences = [{ sequence_title: "Draft Blueprint", scenes: data.scenes }];
        } else {
            sequences = dummyData.sequences;
        }

        // Clean up accumulated ghosts: If real scenes exist in the data, strip out any empty placeholder sequences
        const hasRealScenes = sequences.some(seq => seq.scenes && seq.scenes.length > 0);
        if (hasRealScenes) {
            sequences = sequences.filter(seq => seq.scenes && seq.scenes.length > 0);
        }

        if (sequences === dummyData.sequences || sequences.length === 0) {
            // If we are forcing dummy data, clear the container but allow it to draw the empty blocks so the user can hit 'Generate'
            container.innerHTML = '';
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

    async function generateStage6() {
        if (!activeProjectId) return;

        if (btnStage6Approve) {
            btnStage6Approve.textContent = 'Approve';
            btnStage6Approve.classList.remove('approve-btn-green');
            btnStage6Approve.classList.add('hidden');
        }

        // Clear old content and show loading state
        if (stage6Board) stage6Board.innerHTML = '';
        if (stage6Workshop) stage6Workshop.classList.add('hidden');
        if (loadingStateStage6) loadingStateStage6.classList.remove('hidden');
        if (loadingTextStage6) loadingTextStage6.textContent = 'Generating Scene Blueprint...';

        try {
            const response = await fetch('/api/generate-stage6-scenes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to generate scene blueprint');
            }

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
                        if (loadingTextStage6) loadingTextStage6.textContent = `Generating Sequence ${event.current} of ${event.total}...`;
                    } else if (event.type === 'complete') {
                        renderStage6(event.result);
                        if (window.currentProjectData) window.currentProjectData.stage6_scenes = event.result;
                    } else if (event.type === 'error') {
                        throw new Error(event.message);
                    }
                }
            }
        } catch (error) {
            console.error('Stage 6 generation failed:', error);
            alert('An error occurred during scene generation.');
        } finally {
            if (loadingStateStage6) loadingStateStage6.classList.add('hidden');
        }
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
                const response = await fetch('/api/revise-stage6', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        projectId: activeProjectId,
                        feedback: feedback
                    })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || 'Failed to revise Stage 6');
                }

                const data = await response.json();
                if (window.currentProjectData) window.currentProjectData.stage6_scenes = data.result;

                // Clear feedback box
                if (stage6Notes) {
                    stage6Notes.value = "";
                    stage6Notes.style.height = 'auto'; // Reset auto-resize
                }

                // Render updated blueprint
                renderStage6(data.result);
                
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
                    showGenericRegenModal('Scenes', 'Stage 8 Draft',
                        () => { switchStage(8); initStage8(); },
                        () => { switchStage(8); }
                    );
                } else {
                    switchStage(8);
                    initStage8();
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

        if (currentSceneData && currentSceneData.draft_text) {
            stage8LoadEditor(currentSceneData.draft_text);
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
        // Flush any unsaved edits from the current scene before switching
        stage8FlushEditor();
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
        container.innerHTML = items.map((item, idx) => `
            <div class="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                <span class="text-xs font-mono font-bold px-2 py-0.5 mt-0.5 rounded border shrink-0 text-blue-400 bg-blue-400/10 border-blue-400/30">P${item.priority}</span>
                <div class="flex-1 min-w-0">
                    <textarea class="todo-task-input w-full bg-transparent text-sm text-gray-200 resize-none border-none focus:outline-none focus:ring-1 focus:ring-blue-500/40 rounded p-1 leading-relaxed" rows="2" data-list="${list}" data-idx="${idx}">${item.task}</textarea>
                </div>
                <div class="flex flex-col gap-1 shrink-0 pt-1">
                    <button onclick="window.moveTodoItem(${idx}, -1, '${list}')" class="text-gray-500 hover:text-gray-300 transition-colors leading-none text-xs" title="Move up">▲</button>
                    <button onclick="window.moveTodoItem(${idx},  1, '${list}')" class="text-gray-500 hover:text-gray-300 transition-colors leading-none text-xs" title="Move down">▼</button>
                </div>
            </div>`).join('');
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
                try { await onSend(text, this.history, attachment); }
                finally { this.setDisabled(false); this.input.focus(); }
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

    // ─── STAGES 1–7 CHAT ─────────────────────────────────────────────────────

    async function readSSEStream(response, onEvent) {
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
                await onEvent(event);
            }
        }
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
            attachInputId: explicitAttachId || `stage${stageId}-chat-attach`,
            onSend: async (_text, history, attachment) => {
                const showWorking = () => {
                    const el = document.createElement('div');
                    el.className = 'chat-message chat-message-working';
                    el.innerHTML = 'Applying changes <div class="chat-working-dots"><span></span><span></span><span></span></div>';
                    chat.thread.appendChild(el);
                    chat.thread.scrollTop = chat.thread.scrollHeight;
                    return el;
                };

                if (pendingRevision) {
                    pendingRevision = false;
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        await executeRevision(pendingNotes);
                        indicator.remove();
                        chat.append('ai', 'Done. Review the changes above, then approve when ready.');
                    } catch (err) {
                        indicator.remove();
                        chat.append('ai', 'Something went wrong: ' + err.message);
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
                        const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
                        chat.setThinking(false);
                        chat.append('ai', 'Error: ' + (err.error || `Server error ${res.status}`));
                        return;
                    }
                    data = await res.json();
                } catch (err) {
                    chat.setThinking(false);
                    chat.append('ai', 'Error: ' + err.message);
                    return;
                }
                chat.setThinking(false);
                chat.append('ai', data.message);
                if (data.suggest_plan && data.execute_immediately) {
                    // Clear directive — execute revision immediately, no confirmation needed
                    chat.setDisabled(true);
                    const indicator = showWorking();
                    try {
                        await executeRevision(data.message);
                        indicator.remove();
                        chat.append('ai', 'Done. Review the changes above, then approve when ready.');
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
            const res = await fetch('/api/refine-pitch', { method: 'POST', body: formData });
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const data = await res.json();
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
                const updatedPitch = {};
                currentFields.forEach(f => { updatedPitch[f.getAttribute('data-field')] = f.value; });
                if (window.currentProjectData) window.currentProjectData.stage1_pitch = { pitch: updatedPitch };
                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { stage1_pitch: { pitch: updatedPitch, notes: stage1Notes?.value ?? '' } } })
                });
            }
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
            const res = await fetch('/api/generate-outline', { method: 'POST', body: formData });
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const data = await res.json();
            renderOutline(data.result.outline);
            if (btnStage2Approve) { btnStage2Approve.textContent = 'Approve'; btnStage2Approve.classList.remove('approve-btn-green'); }
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
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const data = await res.json();
            renderCharacters(data.result.characters);
            if (btnStage3Approve) { btnStage3Approve.textContent = 'Approve'; btnStage3Approve.classList.remove('approve-btn-green'); }
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
            await readSSEStream(response, async (event) => {
                if (event.type === 'complete') {
                    renderTreatment(event.result);
                    if (btnStage4Approve) { btnStage4Approve.textContent = 'Approve'; btnStage4Approve.classList.remove('approve-btn-green'); }
                } else if (event.type === 'error') throw new Error(event.message);
            });
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
            const formData = new FormData();
            formData.append('projectId', activeProjectId);
            formData.append('currentTreatment', JSON.stringify(currentData));
            formData.append('notes', notes);
            const response = await fetch('/api/generate-stage5-treatment', { method: 'POST', body: formData });
            if (!response.ok) throw new Error(`Server error ${response.status}`);
            await readSSEStream(response, async (event) => {
                if (event.type === 'complete') {
                    renderTreatmentStage5(event.result);
                    if (btnStage5Approve) { btnStage5Approve.textContent = 'Approve'; btnStage5Approve.classList.remove('approve-btn-green'); }
                } else if (event.type === 'error') throw new Error(event.message);
            });
        }
    });

    // Stage 6
    stageChatWindows[6] = initStageChat({
        stageId: 6,
        threadId: 'stage6-chat-thread',
        inputId: 'stage6-chat-input',
        sendBtnId: 'stage6-chat-send',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            const res = await fetch('/api/revise-stage6', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, feedback: notes })
            });
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const data = await res.json();
            renderStage6(data.result);
            if (window.currentProjectData) window.currentProjectData.stage6_scenes = data.result;
        }
    });

    // ─── STAGE 7: STYLE ───────────────────────────────────────────────────────

    // Stage 7 chat
    stageChatWindows[7] = initStageChat({
        stageId: 7,
        threadId: 'stage7-chat-thread',
        inputId: 'stage7-chat-input',
        sendBtnId: 'stage7-chat-send',
        attachInputId: 'stage7-chat-attach',
        executeRevision: async (notes) => {
            // "Execute" from chat means "generate style from this conversation"
            await stage7GenerateFromChat(notes);
        }
    });

    let stage7CurrentStyle = null; // { slug, content, meta }

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

        // If style already exists, load and show it
        if (data.stage7_style) {
            stage7LoadExistingStyle(data.stage7_style);
        } else {
            styleCard?.classList.add('hidden');
            document.getElementById('stage7-no-style')?.classList.remove('hidden');
            if (btnApprove) btnApprove.disabled = true;

            // If scenes exist and chat is empty, offer style analysis
            const hasScenes = data.stage6_scenes &&
                (data.stage6_scenes.sequences?.length > 0 ||
                 data.stage6_scenes.scenes?.length > 0);
            if (hasScenes && !data.stage7_style_skipped) {
                const chat = stageChatWindows[7];
                if (chat && (!chat.history || chat.history.length === 0)) {
                    setTimeout(() => {
                        chat.append('ai',
                            'I can see your scenes are ready. Want me to analyze your story and suggest a style direction? Or use Quick Start / My Styles above to define your own.');
                    }, 300);
                }
            }
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
        refsEl.textContent = refs?.length ? `References: ${Array.isArray(refs) ? refs.join(', ') : refs}` : '';

        // Show the body content without YAML front matter
        let body = styleData.content || '';
        const fmEnd = body.indexOf('---', body.indexOf('---') + 3);
        if (fmEnd > 0) body = body.slice(fmEnd + 3).trim();
        bodyEl.textContent = body;

        // Reset collapsible body
        const bodyWrap = document.getElementById('stage7-style-body-wrap');
        const toggleBtn = document.getElementById('stage7-style-toggle');
        if (bodyWrap) bodyWrap.classList.add('hidden');
        if (toggleBtn) toggleBtn.textContent = 'Show Full Details ▾';

        card.classList.remove('hidden');
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
            if (window.currentProjectData) window.currentProjectData.stage7_style = data.slug;
            updateStageNav(window.currentProjectData);
        } catch (err) {
            console.error('Style generation error:', err);
            if (loadingEl) loadingEl.classList.add('hidden');
            alert('Style generation failed: ' + err.message);
        }
    }

    async function stage7GenerateFromForm() {
        const name = document.getElementById('stage7-qs-name')?.value?.trim() || '';
        const references = document.getElementById('stage7-qs-references')?.value?.trim() || '';
        const files = document.getElementById('stage7-qs-files')?.files;

        // Gather selected pills
        const characteristics = [];
        document.querySelectorAll('#stage7-qs-pills .style-pill.active').forEach(el => {
            characteristics.push(el.dataset.val);
        });

        // Gather slider values
        const sliders = {
            warmth: document.getElementById('stage7-qs-slider-warmth')?.value || 50,
            intensity: document.getElementById('stage7-qs-slider-intensity')?.value || 50,
            realism: document.getElementById('stage7-qs-slider-realism')?.value || 50
        };

        // Close modal
        document.getElementById('stage7-quickstart-modal')?.classList.add('hidden');

        const loadingEl = document.getElementById('stage7-loading');
        if (loadingEl) loadingEl.classList.remove('hidden');

        try {
            const formDataObj = new FormData();
            formDataObj.append('projectId', activeProjectId);
            formDataObj.append('mode', 'form');
            formDataObj.append('formData', JSON.stringify({ name, references: references ? references.split(',').map(r => r.trim()) : [], characteristics, sliders }));
            if (files) {
                for (const f of files) formDataObj.append('sampleFiles', f);
            }

            const res = await fetch('/api/generate-stage7-style', {
                method: 'POST',
                body: formDataObj
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Generation failed');
            }
            const data = await res.json();
            stage7DisplayStyle(data);
            if (window.currentProjectData) window.currentProjectData.stage7_style = data.slug;
            updateStageNav(window.currentProjectData);
        } catch (err) {
            console.error('Form style generation error:', err);
            if (loadingEl) loadingEl.classList.add('hidden');
            alert('Style generation failed: ' + err.message);
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

        try {
            const res = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { stage7_style: stage7CurrentStyle.slug } })
            });
            if (!res.ok) throw new Error('Approve failed');
            const updated = await res.json();
            window.currentProjectData = updated.data;
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

    async function stage7LoadMyStyles() {
        const list = document.getElementById('stage7-mystyles-list');
        if (!list) return;
        list.innerHTML = '<p style="color:#6b7280;font-size:0.85rem">Loading...</p>';

        try {
            const res = await fetch('/api/styles');
            const data = await res.json();
            if (!data.styles?.length) {
                list.innerHTML = '<p style="color:#6b7280;font-size:0.85rem;font-style:italic">No saved styles yet. Create one using the chat or Quick Start form.</p>';
                return;
            }
            list.innerHTML = '';
            for (const style of data.styles) {
                const item = document.createElement('div');
                item.className = 'style-list-item';
                item.innerHTML = `
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;color:#e5e7eb;font-size:0.9rem">${style.name}</div>
                        <div style="font-size:0.8rem;color:#6b7280">${style.tonal_summary || ''}${style.references?.length ? ' — ' + (Array.isArray(style.references) ? style.references.join(', ') : style.references) : ''}</div>
                    </div>
                    <button class="primary-btn" style="font-size:0.75rem;padding:4px 12px;white-space:nowrap">Use This</button>
                `;
                item.querySelector('button').addEventListener('click', async () => {
                    document.getElementById('stage7-mystyles-modal')?.classList.add('hidden');
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
                        updateStageNav(window.currentProjectData);
                    } catch (err) {
                        console.error('Select style error:', err);
                        if (loadingEl) loadingEl.classList.add('hidden');
                        alert('Failed to select style: ' + err.message);
                    }
                });
                list.appendChild(item);
            }
        } catch (err) {
            console.error('Load styles error:', err);
            list.innerHTML = '<p style="color:#ef4444;font-size:0.85rem">Failed to load styles.</p>';
        }
    }

    // Stage 7 event listeners
    document.getElementById('btnStage7QuickStart')?.addEventListener('click', () => {
        document.getElementById('stage7-quickstart-modal')?.classList.remove('hidden');
    });
    document.getElementById('btnStage7QsCancel')?.addEventListener('click', () => {
        document.getElementById('stage7-quickstart-modal')?.classList.add('hidden');
    });
    document.getElementById('btnStage7QsGenerate')?.addEventListener('click', () => stage7GenerateFromForm());
    document.getElementById('btnStage7MyStyles')?.addEventListener('click', () => {
        document.getElementById('stage7-mystyles-modal')?.classList.remove('hidden');
        stage7LoadMyStyles();
    });
    document.getElementById('btnStage7MyStylesClose')?.addEventListener('click', () => {
        document.getElementById('stage7-mystyles-modal')?.classList.add('hidden');
    });
    document.getElementById('btnStage7Approve')?.addEventListener('click', () => stage7ApproveStyle());
    document.getElementById('btnStage7Preview')?.addEventListener('click', () => stage7PreviewScene());
    document.getElementById('btnStage7Regenerate')?.addEventListener('click', () => {
        document.getElementById('stage7-style-card')?.classList.add('hidden');
        document.getElementById('stage7-no-style')?.classList.remove('hidden');
        document.getElementById('btnStage7Approve').disabled = true;
        document.getElementById('btnStage7Approve').textContent = 'Approve →';
        document.getElementById('btnStage7Approve').classList.remove('approve-btn-green');
        stage7CurrentStyle = null;
    });
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

    // Quick Start pill toggle
    document.querySelectorAll('#stage7-qs-pills .style-pill').forEach(pill => {
        pill.addEventListener('click', () => pill.classList.toggle('active'));
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
            stage8LoadEditor(data.result);
            const projRes = await fetch(`/api/projects/${activeProjectId}`);
            const projData = await projRes.json();
            window.currentProjectData = projData.data;
            if (btnNextScene) btnNextScene.classList.remove('hidden');
        }
    });

    // ─── STAGE CHAT RESIZERS (Stages 1–6, 8) ──────────────────────────────────
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const hsplit = document.getElementById(`stage${s}-hsplit`);
        const chatEl = document.getElementById(`stage${s}-chat`);
        if (!hsplit || !chatEl) continue;
        const storageKey = `stageChatH${s}`;
        const saved = parseInt(localStorage.getItem(storageKey) || '280');
        chatEl.style.height = `${saved}px`;
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

        // Stage 2 — Outline (string)
        if (stage === 2 && typeof snap === 'string') return snap;

        // Stage 3 — Characters (array of objects)
        if (stage === 3 && Array.isArray(snap)) {
            return snap.map(c => {
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

        // Stage 6 — Scenes (array-like of sequences)
        if (stage === 6) {
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
            return '(Stage 8 approval marker — the full draft text is stored in the Stage 6 scenes snapshot.)';
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

        versionPreviewTitle.textContent = `Stage ${version.stage}: ${version.stageName} — Version ${version.version} (${dateStr} at ${timeStr})`;
        versionPreviewBody.textContent = snapshotToText(version);
        versionPreviewModal?.classList.remove('hidden');
    };

    if (versionPreviewClose) {
        versionPreviewClose.onclick = () => versionPreviewModal?.classList.add('hidden');
    }
    if (versionPreviewModal) {
        versionPreviewModal.onclick = (e) => { if (e.target === versionPreviewModal) versionPreviewModal.classList.add('hidden'); };
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
                if (data.modified) {
                    stage10Pending[data.scene_number] = data.proposed_text;
                    renderStage10SceneList();
                }
            }

            resetStage10ApproveBtn();
            window.stage10CurrentPlan = null;

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
                    if (stage10CurrentScene !== null) {
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
                        stage10Chat.append('ai', data.message);
                        if (data.suggest_plan && !window.stage10CurrentPlan && !stage10ExecutingPlan) stage10GeneratePlan();
                    }
                }
            });

            // Fetch AI opening message (presents Stage 9 priorities)
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
                <span class="truncate">${n}. ${label}</span>${dot}
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
        { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
        { value: 'gemini-3-flash-preview',    label: 'Gemini 3 Flash' },
        { value: 'claude-opus-4-6',          label: 'Claude Opus 4.6' },
        { value: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6' },
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
        'claude-opus-4-6':             { input: 15.0 / 1e6, output: 75.0 / 1e6, label: 'Claude Opus 4.6' },
        'claude-sonnet-4-6':           { input: 3.0 / 1e6,  output: 15.0 / 1e6, label: 'Claude Sonnet 4.6' },
        'claude-haiku-4-5-20251001':   { input: 0.80 / 1e6, output: 4.0 / 1e6,  label: 'Claude Haiku 4.5' },
    };

    const spendModal = document.getElementById('spendModal');

    function openSpendModal() {
        const content = document.getElementById('spend-modal-content');
        if (!content) return;

        const usage = window.currentProjectData?.data?.apiUsage || [];

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


