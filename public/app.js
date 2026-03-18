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


    // Stage 7 Elements
    const stage7View = document.getElementById('stage7-view');
    const draftEditor = document.getElementById('draft-editor');
    const btnStage7Submit = document.getElementById('btnStage7Submit');
    const btnStage7Approve = document.getElementById('btnStage7Approve');
    const btnGenerateScene = document.getElementById('btnGenerateScene');
    const btnNextScene = document.getElementById('btnNextScene');
    const btnGenerateAll = document.getElementById('btnGenerateAll');
    const stage7Notes = document.getElementById('stage7-notes');


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

            // Always default back to Stage 1 when opening a project
            switchStage(1);

            if (projectDetails.data && projectDetails.data.stage1_pitch) {
                const { pitch, notes } = projectDetails.data.stage1_pitch;

                // Render a single pitch card with the saved data
                renderPitches([pitch]);

                // Auto-approve and go into workshop view
                const cardElement = resultsContainer.querySelector('.pitch-card');
                if (cardElement) {
                    handleApprove(cardElement, 0);

                    // Pre-fill notes
                    if (stage1Notes && notes) {
                        stage1Notes.value = notes;
                    }

                    // Lock textareas and show Approved / Revise state
                    toggleStage1EditMode(true);

                    // Auto-resize notes if visible
                    if (stage1Notes) autoResize(stage1Notes);
                }

                updateStageNav(projectDetails.data);

                // Hydrate Stage 2 Outline if exists
                if (projectDetails.data.stage2_outline && projectDetails.data.stage2_outline.outline) {
                    renderOutline(projectDetails.data.stage2_outline.outline);

                    // Outline is approved — override the unapproved state set by renderOutline
                    if (btnStage2Approve) {
                        btnStage2Approve.textContent = 'Approved ✓';
                        btnStage2Approve.classList.add('approve-btn-green');
                    }
                    toggleStage2EditMode(true);

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
                    if (btnStage3Approve) {
                        btnStage3Approve.textContent = 'Approved ✓';
                        btnStage3Approve.classList.add('approve-btn-green');
                    }
                    if (btnStage3Edit) btnStage3Edit.classList.remove('hidden');
                    if (btnStage3Revise) btnStage3Revise.classList.add('hidden');

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
                    if (btnStage4Approve) {
                        btnStage4Approve.textContent = 'Approved ✓';
                        btnStage4Approve.classList.add('approve-btn-green');
                    }
                    if (btnStage4Edit) btnStage4Edit.classList.remove('hidden');
                    if (btnStage4Revise) btnStage4Revise.classList.add('hidden');

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
                    if (btnStage5Approve) {
                        btnStage5Approve.textContent = 'Approved ✓';
                        btnStage5Approve.classList.add('approve-btn-green');
                    }
                    if (btnStage5Edit) btnStage5Edit.classList.remove('hidden');
                    if (btnStage5Revise) btnStage5Revise.classList.add('hidden');

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
            } else {
                updateStageNav(projectDetails.data);
            }
        } catch (err) {
            console.error("Error loading project details:", err);
            window.location.hash = ''; // Revert to hub on error
        }
    }

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

    function handleApprove(selectedCard, index) {
        // Grab the edited data from the card
        const fields = selectedCard.querySelectorAll('.editable-field');
        const approvedData = {};

        fields.forEach(field => {
            const key = field.getAttribute('data-field');
            approvedData[key] = field.value;
        });

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
        toggleStage1EditMode(false);
        const pitchDownloadRow = document.getElementById('pitchDownloadRow');
        if (pitchDownloadRow) pitchDownloadRow.classList.remove('hidden');
    }

    function toggleStage1EditMode(isApproved) {
        const expandedCard = document.querySelector('.pitch-card.expanded');
        if (expandedCard) {
            const fields = expandedCard.querySelectorAll('.field-group .editable-field');
            fields.forEach(f => f.disabled = isApproved);
        }
        if (stage1Notes) stage1Notes.disabled = isApproved;

        if (isApproved) {
            if (btnStage1Revise) btnStage1Revise.classList.add('hidden');
            if (btnStage1Edit) btnStage1Edit.classList.remove('hidden');
        } else {
            if (btnStage1Revise) {
                btnStage1Revise.classList.remove('hidden');
                btnStage1Revise.disabled = false;
            }
            if (btnStage1Edit) btnStage1Edit.classList.add('hidden');
            if (btnStage1Approve) {
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
        const payload = {
            data: {
                stage1_pitch: {
                    pitch: finalData,
                    notes: notes
                }
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
            7: !!data.stage7_approved,
            8: !!data.stage8_coverage,
            9: !!data.stage9_rewrites?.approved
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
        }
    }

    function switchStage(stageNum) {
        // Deactivate all nav items and hide all workspace views
        for (let i = 1; i <= 10; i++) {
            navItems[i]?.classList.remove('active');
            workspaces[i]?.classList.add('hidden');
        }

        // Activate the requested stage
        const activeNav = navItems[stageNum];
        const activeWorkspace = workspaces[stageNum];

        if (activeNav) activeNav.classList.add('active');
        if (activeWorkspace) activeWorkspace.classList.remove('hidden');

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

    // --- Stage 2 Logic ---
    async function autoGenerateBeats() {
        if (!activeProjectId) return;

        // Hide the workshop so no old buttons show
        if (stage2Workshop) stage2Workshop.classList.add('hidden');

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
        const outlineDownloadRow = document.getElementById('outlineDownloadRow');
        if (outlineDownloadRow) outlineDownloadRow.classList.remove('hidden');

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
                    ta.addEventListener('input', () => autoResize(ta));
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

        triggerBtn.textContent = 'Saving...';
        triggerBtn.disabled = true;
        triggerBtn.classList.remove('approve-btn-green');

        try {
            const res = await fetch(`/api/projects/${activeProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: {
                        stage2_outline: { outline: updatedOutline }
                    }
                })
            });
            const updatedProject = await res.json();

            // Update Navigation UI
            updateStageNav(updatedProject.data);

            // Indicate success visually
            triggerBtn.textContent = 'Approved ✓';
            triggerBtn.classList.add('approve-btn-green');

            toggleStage2EditMode(true);

            // Auto-trigger Stage 3 Characters
            switchStage(3);
            autoGenerateCharacters();
        } catch (err) {
            console.error("Failed to save outline:", err);
            alert("Error saving outline.");
            triggerBtn.textContent = originalText;
        } finally {
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

    function renderCharacters(characters) {
        if (!charactersContainer) return;
        charactersContainer.innerHTML = '';
        const charactersDownloadRow = document.getElementById('charactersDownloadRow');
        if (charactersDownloadRow) charactersDownloadRow.classList.remove('hidden');

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
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px;">Psychological Core</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px;">
                        ${field('Ghost & Wound', 'psychological_core.ghost_and_wound', char.psychological_core?.ghost_and_wound)}
                        ${field('The Lie', 'psychological_core.the_lie', char.psychological_core?.the_lie)}
                        ${field('Fear', 'psychological_core.fear', char.psychological_core?.fear)}
                        ${field('Desire', 'psychological_core.desire', char.psychological_core?.desire)}
                        ${field('Psychological Need', 'psychological_core.psychological_need', char.psychological_core?.psychological_need)}
                        ${field('Moral Need', 'psychological_core.moral_need', char.psychological_core?.moral_need)}
                    </div>

                    <div style="border-top: 1px solid #1f2937; margin: 12px 0;"></div>
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px;">Voice &amp; Behavior</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px;">
                        ${field('Speech Patterns', 'voice_and_behavior.speech_patterns', char.voice_and_behavior?.speech_patterns)}
                        ${field('Deflection Tactic', 'voice_and_behavior.deflection_tactic', char.voice_and_behavior?.deflection_tactic)}
                        ${field('Paradox', 'voice_and_behavior.paradox', char.voice_and_behavior?.paradox)}
                    </div>

                    <div style="border-top: 1px solid #1f2937; margin: 12px 0;"></div>
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;">Subtlety (90/10 Rule)</div>
                    <textarea
                        rows="1"
                        class="char-input char-ta"
                        data-index="${index}"
                        data-field="subtlety_guidelines"
                        style="${taStyle}"
                    >${escapeHtml(char.subtlety_guidelines || '')}</textarea>
                </div>
            `;

            // Hover/focus effect on transparent textareas
            card.querySelectorAll('.char-ta').forEach(ta => {
                ta.addEventListener('focus', () => { ta.style.background = 'rgba(31,41,55,0.8)'; ta.style.outline = '1px solid #374151'; });
                ta.addEventListener('blur', () => { ta.style.background = 'transparent'; ta.style.outline = 'none'; });
                ta.addEventListener('input', () => autoResize(ta));
            });

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
            const charObj = {
                name: card.dataset.charName || '',
                role: card.dataset.charRole || '',
                brief_summary: '',
                psychological_core: { ghost_and_wound: '', the_lie: '', fear: '', desire: '', psychological_need: '', moral_need: '' },
                voice_and_behavior: { speech_patterns: '', deflection_tactic: '', paradox: '' },
                subtlety_guidelines: ''
            };

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
                } else if (f === 'subtlety_guidelines') {
                    charObj.subtlety_guidelines = val;
                }
            });

            currentCharacters.push(charObj);
        });

        return currentCharacters;
    }

    async function autoGenerateCharacters() {
        if (!activeProjectId) return;

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

    if (btnStage3Approve) {
        btnStage3Approve.addEventListener('click', async () => {
            if (!activeProjectId) return;

            const currentCharacters = scrapeCharacters();
            const originalText = btnStage3Approve.textContent;

            btnStage3Approve.textContent = 'Saving...';
            btnStage3Approve.disabled = true;
            btnStage3Approve.classList.remove('approve-btn-green');

            try {
                const res = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data: {
                            stage3_characters: { characters: currentCharacters }
                        }
                    })
                });
                const updatedProject = await res.json();
                updateStageNav(updatedProject.data);

                btnStage3Approve.textContent = 'Approved ✓';
                btnStage3Approve.classList.add('approve-btn-green');

                // Toggle back to edit mode
                if (btnStage3Edit) btnStage3Edit.classList.remove('hidden');
                if (btnStage3Revise) btnStage3Revise.classList.add('hidden');

                // Auto-transition to Stage 4: Treatment
                switchStage(4);
                autoGenerateTreatment();
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
        const beatsDownloadRow = document.getElementById('beatsDownloadRow');
        if (beatsDownloadRow) beatsDownloadRow.classList.remove('hidden');

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
                    ta.addEventListener('input', () => autoResize(ta));
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

            btnStage4Approve.textContent = 'Saving...';
            btnStage4Approve.disabled = true;
            btnStage4Approve.classList.remove('approve-btn-green');

            try {
                const res = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data: { stage4_beats: currentS4Beats }
                    })
                });
                const updatedProject = await res.json();
                updateStageNav(updatedProject.data);

                btnStage4Approve.textContent = 'Approved ✓';
                btnStage4Approve.classList.add('approve-btn-green');

                // Toggle back to edit mode
                if (btnStage4Edit) btnStage4Edit.classList.remove('hidden');
                if (btnStage4Revise) btnStage4Revise.classList.add('hidden');

                // Auto-transition to Stage 5: Treatment
                switchStage(5);
                autoGenerateTreatmentStage5();
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

            btnStage5Approve.textContent = 'Saving...';
            btnStage5Approve.disabled = true;
            btnStage5Approve.classList.remove('approve-btn-green');

            try {
                const res = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data: { stage5_treatment: currentData }
                    })
                });
                const updatedProject = await res.json();
                updateStageNav(updatedProject.data);

                btnStage5Approve.textContent = 'Approved ✓';
                btnStage5Approve.classList.add('approve-btn-green');

                if (btnStage5Edit) btnStage5Edit.classList.remove('hidden');
                btnStage5Revise.classList.add('hidden');

                // Auto-transition to Stage 6: Scene Blueprint
                switchStage(6);
                generateStage6();
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
                    ta.addEventListener('input', () => autoResize(ta));
                    // Initial resize
                    setTimeout(() => autoResize(ta), 0);
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

            btnStage6Approve.disabled = true;
            btnStage6Approve.textContent = 'Saving...';

            try {
                const response = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data: { stage6_scenes: currentBlueprint }
                    })
                });

                if (!response.ok) throw new Error('Failed to save project');

                btnStage6Approve.textContent = 'Approved ✓';
                btnStage6Approve.classList.add('approve-btn-green');
                
                // Fetch updated project for nav status
                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                updateStageNav(projData.data);

                // Apply completion UI to Stage 6
                if (btnStage6Submit) btnStage6Submit.classList.add('hidden');
                if (btnStage6Revise) btnStage6Revise.classList.remove('hidden');

                // Apply completed styling to sidebar (already handled by updateStageNav, but being explicit about the active transition)
                const stage6NavItem = navItems[6];
                if (stage6NavItem) {
                    stage6NavItem.classList.add('completed');
                }

                // Programmatically switch to Stage 7
                switchStage(7);
                initStage7();

            } catch (error) {
                console.error('Stage 6 approval failed:', error);
                alert('An error occurred while saving the approved blueprint.');
                btnStage6Approve.textContent = originalText;
                btnStage6Approve.disabled = false;
            }
        });
    }

    // --- Stage 7 Logic: Draft ---

    // Renders only the scene TOC sidebar, leaving the editor and buttons untouched.
    // Called by both initStage7() and the batch generation loop.
    function renderStage7Sidebar() {
        const toc = document.getElementById('stage7-toc');
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

    function initStage7() {
        if (!btnGenerateScene || !btnNextScene || !draftEditor) return;

        renderStage7Sidebar();

        draftEditor.classList.add('font-mono');

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
            draftEditor.innerHTML = formatFountainToHTML(currentSceneData.draft_text);
            btnNextScene.classList.remove('hidden');
        } else {
            draftEditor.innerHTML = `<div class="text-gray-500 italic text-center mt-24">Ready to generate Scene ${currentDraftSceneNumber}...</div>`;
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

                if (draftEditor) {
                    draftEditor.innerHTML = formatFountainToHTML(draftText);
                }

                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                window.currentProjectData = projData.data;

                // Show "Next" button after generation
                if (btnNextScene) btnNextScene.classList.remove('hidden');

            } catch (error) {
                console.error('Stage 7 draft generation failed:', error);
                alert(`Error: ${error.message}`);
            } finally {
                btnGenerateScene.textContent = originalText;
                btnGenerateScene.disabled = false;
            }
        });
    }

    if (btnNextScene) {
        btnNextScene.addEventListener('click', async () => {
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
            initStage7();
        });
    }

    if (btnStage7Submit) {
        btnStage7Submit.addEventListener('click', async () => {
            if (!activeProjectId) return;
            const feedback = stage7Notes?.value.trim();
            if (!feedback) {
                alert("Please enter revision notes in the feedback box before submitting.");
                return;
            }

            const originalText = btnStage7Submit.textContent;
            btnStage7Submit.disabled = true;
            btnStage7Submit.textContent = 'Revising...';

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

                if (draftEditor) {
                    draftEditor.innerHTML = formatFountainToHTML(data.result);
                }

                // Sync local project data
                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                window.currentProjectData = projData.data;

                // Clear feedback notes
                if (stage7Notes) {
                    stage7Notes.value = '';
                    stage7Notes.style.height = 'auto';
                }

                // Show "Next" button since we now have a draft
                if (btnNextScene) btnNextScene.classList.remove('hidden');

                btnStage7Submit.textContent = 'Revised ✓';
                setTimeout(() => {
                    btnStage7Submit.textContent = originalText;
                    btnStage7Submit.disabled = false;
                }, 2000);

            } catch (error) {
                console.error('Stage 7 revision failed:', error);
                alert(`Error: ${error.message}`);
                btnStage7Submit.textContent = originalText;
                btnStage7Submit.disabled = false;
            }
        });
    }

    if (btnStage7Approve) {
        btnStage7Approve.addEventListener('click', async () => {
            if (!activeProjectId) return;

            const originalText = btnStage7Approve.textContent;
            btnStage7Approve.disabled = true;
            btnStage7Approve.textContent = 'Saving...';

            try {
                const response = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { stage7_approved: true, stage8_coverage: null } })
                });

                if (!response.ok) throw new Error('Failed to save project');

                const updatedProject = await response.json();
                updateStageNav(updatedProject.data);

                btnStage7Approve.textContent = 'Approved ✓';
                btnStage7Approve.classList.add('approve-btn-green');

                // Clear stale coverage so Stage 8 re-generates
                if (window.currentProjectData) delete window.currentProjectData.stage8_coverage;

                // Advance to Stage 8
                switchStage(8);

            } catch (error) {
                console.error('Stage 7 approval failed:', error);
                alert('An error occurred while saving.');
                btnStage7Approve.textContent = originalText;
                btnStage7Approve.disabled = false;
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

                if (draftEditor) {
                    draftEditor.innerHTML = `<div class="text-gray-500 italic text-center mt-24">Generating Scene ${scene.scene_number} of ${getFlatScenes().length}...</div>`;
                }
                renderStage7Sidebar();

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

                    if (draftEditor) {
                        draftEditor.innerHTML = formatFountainToHTML(data.result);
                    }

                    // Sync local project data so getFlatScenes() reflects the new draft_text
                    const projRes = await fetch(`/api/projects/${activeProjectId}`);
                    const projData = await projRes.json();
                    window.currentProjectData = projData.data;

                    renderStage7Sidebar();
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
            initStage7(); // Full re-render to restore button states
        });
    }

    function makeFilename(title, stage, ext = 'txt') {
        const slug = (title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
        const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
        return `${slug}_${stage}_${ts}.${ext}`;
    }

    const btnDownloadOutline = document.getElementById('btnDownloadOutline');
    if (btnDownloadOutline) {
        btnDownloadOutline.addEventListener('click', () => {
            const outline = window.currentProjectData?.stage2_outline?.outline;
            if (!outline) { alert('No outline has been generated yet.'); return; }
            const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'untitled';
            let text = `OUTLINE: ${title.toUpperCase()}\n\n`;
            const acts = [
                { label: 'ACT I', key: 'act_1' },
                { label: 'ACT II', key: 'act_2' },
                { label: 'ACT III', key: 'act_3' }
            ];
            acts.forEach(({ label, key }) => {
                const sequences = outline[key];
                if (!sequences || !sequences.length) return;
                text += `${'='.repeat(60)}\n${label}\n${'='.repeat(60)}\n\n`;
                sequences.forEach(seq => {
                    text += `${seq.sequence_number_and_title}\n${'-'.repeat(40)}\n`;
                    (seq.beats || []).forEach(beat => {
                        text += `[${beat.beat_label}] ${beat.description}\n`;
                    });
                    text += '\n';
                });
            });
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = makeFilename(title, 'outline');
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const btnDownloadPitch = document.getElementById('btnDownloadPitch');
    if (btnDownloadPitch) {
        btnDownloadPitch.addEventListener('click', () => {
            const pitch = window.currentProjectData?.stage1_pitch?.pitch;
            if (!pitch) { alert('No pitch has been generated yet.'); return; }
            const title = pitch.title || 'untitled';
            let text = `PITCH: ${title.toUpperCase()}\n`;
            text += `${'='.repeat(60)}\n\n`;
            if (pitch.genre) text += `GENRE: ${pitch.genre}\n\n`;
            if (pitch.logline) text += `LOGLINE:\n${pitch.logline}\n\n`;
            if (pitch.core_theme) text += `CORE THEME:\n${pitch.core_theme}\n\n`;
            if (pitch.synopsis) text += `SYNOPSIS:\n${pitch.synopsis}\n`;
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = makeFilename(title, 'pitch');
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const btnDownloadCharacters = document.getElementById('btnDownloadCharacters');
    if (btnDownloadCharacters) {
        btnDownloadCharacters.addEventListener('click', () => {
            const characters = window.currentProjectData?.stage3_characters?.characters;
            if (!characters || !characters.length) { alert('No characters have been generated yet.'); return; }
            const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'untitled';
            let text = `CHARACTERS: ${title.toUpperCase()}\n`;
            characters.forEach(char => {
                text += `\n${'='.repeat(60)}\n${char.name?.toUpperCase() || 'CHARACTER'} — ${char.role || ''}\n${'='.repeat(60)}\n\n`;
                if (char.brief_summary) text += `${char.brief_summary}\n\n`;
                const pc = char.psychological_core;
                if (pc) {
                    text += `PSYCHOLOGICAL CORE\n${'-'.repeat(30)}\n`;
                    if (pc.ghost_and_wound) text += `Ghost & Wound: ${pc.ghost_and_wound}\n`;
                    if (pc.the_lie) text += `The Lie: ${pc.the_lie}\n`;
                    if (pc.fear) text += `Fear: ${pc.fear}\n`;
                    if (pc.desire) text += `Desire: ${pc.desire}\n`;
                    if (pc.psychological_need) text += `Psychological Need: ${pc.psychological_need}\n`;
                    if (pc.moral_need) text += `Moral Need: ${pc.moral_need}\n`;
                    text += '\n';
                }
                const vb = char.voice_and_behavior;
                if (vb) {
                    text += `VOICE & BEHAVIOR\n${'-'.repeat(30)}\n`;
                    if (vb.speech_patterns) text += `Speech Patterns: ${vb.speech_patterns}\n`;
                    if (vb.deflection_tactic) text += `Deflection Tactic: ${vb.deflection_tactic}\n`;
                    if (vb.paradox) text += `Paradox: ${vb.paradox}\n`;
                    text += '\n';
                }
                if (char.subtlety_guidelines) text += `SUBTLETY GUIDELINES\n${'-'.repeat(30)}\n${char.subtlety_guidelines}\n`;
            });
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = makeFilename(title, 'characters');
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const btnDownloadBeats = document.getElementById('btnDownloadBeats');
    if (btnDownloadBeats) {
        btnDownloadBeats.addEventListener('click', () => {
            const data = window.currentProjectData?.stage4_beats || window.currentProjectData?.stage4_treatment;
            if (!data || !data.hybrid_beat_sheet) {
                alert('No beats have been generated yet.');
                return;
            }
            const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'untitled';
            let text = `BEAT SHEET: ${title.toUpperCase()}\n`;
            if (data.stc_genre_category) text += `STC Genre: ${data.stc_genre_category}\n`;
            text += '\n';
            data.hybrid_beat_sheet.forEach(seq => {
                const cleanTitle = (seq.sequence_title || '').replace(/^Sequence\s*\d+\s*:\s*/i, '');
                text += `${'='.repeat(60)}\nSEQUENCE ${seq.sequence_number}: ${cleanTitle.toUpperCase()}\n${'='.repeat(60)}\n\n`;
                (seq.beats || []).forEach(beat => {
                    text += `--- ${beat.beat_name} ---\n\n`;
                    if (beat.genre_variation_notes) text += `GENRE VARIATION NOTES:\n${beat.genre_variation_notes}\n\n`;
                    if (beat.emotional_arc) text += `EMOTIONAL ARC:\n${beat.emotional_arc}\n\n`;
                    if (beat.pacing_notes) text += `PACING NOTES:\n${beat.pacing_notes}\n\n`;
                    if (beat.detailed_action) text += `DETAILED ACTION:\n${beat.detailed_action}\n\n`;
                });
            });
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = makeFilename(title, 'beats');
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const btnDownloadScenes = document.getElementById('btnDownloadScenes');
    if (btnDownloadScenes) {
        btnDownloadScenes.addEventListener('click', () => {
            const data = window.currentProjectData?.stage6_scenes;
            if (!data) {
                alert('No scene blueprint has been generated yet.');
                return;
            }
            const sequences = Array.isArray(data) ? data : (data.sequences || []);
            if (sequences.length === 0) {
                alert('No scene blueprint has been generated yet.');
                return;
            }
            const lines = [];
            sequences.forEach(seq => {
                lines.push(`SEQUENCE ${seq.sequence_number}: ${seq.sequence_title}`);
                lines.push('='.repeat(60));
                lines.push(`Estimated Pages: ${seq.total_estimated_pages}`);
                lines.push('');
                (seq.scenes || []).forEach(scene => {
                    lines.push(`Scene ${scene.scene_number}: ${scene.scene_heading}`);
                    lines.push(`Narrative: ${scene.narrative_action}`);
                    lines.push(`Function: ${scene.dramaturgical_function}`);
                    lines.push(`Est. Pages: ${scene.estimated_page_count}`);
                    lines.push('');
                });
                lines.push('');
            });
            const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'scenes';
            const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = makeFilename(title, 'scene_blueprint');
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const btnDownloadTreatment = document.getElementById('btnDownloadTreatment');
    if (btnDownloadTreatment) {
        btnDownloadTreatment.addEventListener('click', () => {
            const treatment = window.currentProjectData?.stage5_treatment;
            if (!treatment || !Object.values(treatment).some(v => v && typeof v === 'string' && v.trim())) {
                alert('No treatment has been generated yet.');
                return;
            }
            const sections = [
                { label: 'TITLE, LOGLINE & CHARACTERS', key: 'title_logline_characters' },
                { label: 'ACT I', key: 'act_1' },
                { label: 'ACT II (PART 1)', key: 'act_2a' },
                { label: 'ACT II (PART 2)', key: 'act_2b' },
                { label: 'ACT III', key: 'act_3' }
            ];
            const text = sections
                .filter(s => treatment[s.key] && treatment[s.key].trim())
                .map(s => `${s.label}\n${'='.repeat(s.label.length)}\n\n${treatment[s.key].trim()}`)
                .join('\n\n\n');
            const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'treatment';
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = makeFilename(title, 'treatment');
            a.click();
            URL.revokeObjectURL(url);
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

    // Expose selectDraftScene on window from inside the closure so it has access
    // to currentDraftSceneNumber and initStage7 (both defined in this scope).
    window.selectDraftScene = function(sceneNumber) {
        currentDraftSceneNumber = sceneNumber;
        initStage7();
    };

    // --- Stage 8: Coverage ---

    async function initStage8() {
        const loadingDiv  = document.getElementById('stage8-loading');
        const reportDiv   = document.getElementById('stage8-report');
        const coverageData = window.currentProjectData?.stage8_coverage;

        if (coverageData) {
            loadingDiv?.classList.add('hidden');
            reportDiv?.classList.remove('hidden');
            renderCoverageReport(coverageData);
        } else {
            loadingDiv?.classList.remove('hidden');
            reportDiv?.classList.add('hidden');
            try {
                const response = await fetch('/api/generate-coverage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: activeProjectId })
                });
                if (!response.ok) {
                    const err = await response.json();
                    throw new Error(err.error || 'Failed to generate coverage');
                }
                const data = await response.json();

                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                window.currentProjectData = projData.data;
                updateStageNav(projData.data);

                loadingDiv?.classList.add('hidden');
                reportDiv?.classList.remove('hidden');
                renderCoverageReport(data.result);
            } catch (error) {
                console.error('Coverage generation failed:', error);
                loadingDiv?.classList.add('hidden');
                reportDiv?.classList.remove('hidden');
                const container = document.getElementById('stage8-content');
                if (container) {
                    container.innerHTML = `
                        <div class="text-center mt-24">
                            <p class="text-red-400 text-sm mb-4">Failed to generate coverage: ${error.message}</p>
                            <button onclick="window.retryStage8Coverage()" class="primary-btn">Try Again</button>
                        </div>`;
                }
            }
        }

        // Wire up Begin Rewrite button
        const btnApprove = document.getElementById('btnStage8Approve');
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
                    // Always restart Stage 9 from P1 when entering from Begin Rewrite
                    window.stage9ResetOnInit = true;
                    switchStage(9);
                } catch (err) {
                    console.error('Stage 8 approval failed:', err);
                    alert('An error occurred. Please try again.');
                }
            };
        }

        // Wire up Download Coverage button
        const btnDownload = document.getElementById('btnDownloadCoverage');
        if (btnDownload) {
            btnDownload.onclick = () => {
                const coverage = window.currentProjectData?.stage8_coverage;
                if (!coverage) { alert('No coverage report available.'); return; }
                const title = coverage.title || 'Untitled';
                const sep = (char, len = 60) => char.repeat(len);
                let text = `COVERAGE REPORT: ${title.toUpperCase()}\n${sep('=')}\n\n`;
                text += `GENRE: ${coverage.genre || '—'}\n\n`;
                text += `LOGLINE:\n${coverage.logline || '—'}\n\n`;
                text += `${sep('-')}\n\nEVALUATION GRID\n${sep('-')}\n`;
                const grid = coverage.evaluation_grid || {};
                ['concept', 'structure', 'characterization', 'pacing', 'dialogue'].forEach(k => {
                    text += `  ${(k.charAt(0).toUpperCase() + k.slice(1)).padEnd(20)} ${grid[k] || '—'}\n`;
                });
                text += `\n${sep('-')}\n\nNARRATIVE SYNOPSIS\n${sep('-')}\n\n`;
                if (coverage.synopsis?.setup)      text += `SETUP:\n${coverage.synopsis.setup}\n\n`;
                if (coverage.synopsis?.escalation) text += `ESCALATION:\n${coverage.synopsis.escalation}\n\n`;
                if (coverage.synopsis?.resolution) text += `RESOLUTION:\n${coverage.synopsis.resolution}\n\n`;
                text += `${sep('-')}\n\nAUTHENTICITY CHECK\n${sep('-')}\n`;
                text += `Assessment: ${coverage.authenticity?.assessment || '—'}\n`;
                const flags = coverage.authenticity?.red_flags || [];
                if (flags.length > 0) {
                    text += `\nAI Signals Detected:\n`;
                    flags.forEach((f, i) => { text += `  ${i + 1}. ${f}\n`; });
                } else {
                    text += `No major red flags detected.\n`;
                }
                text += `\n${sep('-')}\n\nDEVELOPMENT NOTES\n${sep('-')}\n\nSTRENGTHS:\n`;
                (coverage.strengths || []).forEach(s => { text += `  • ${s.headline}. ${s.detail}\n`; });
                text += `\nWEAKNESSES:\n`;
                (coverage.weaknesses || []).forEach(w => { text += `  • ${w.headline}. ${w.detail}\n`; });
                text += `\n${sep('-')}\n\nMACRO TO-DO\n${sep('-')}\n`;
                (window.currentMacroTodo || coverage.macro_todo || []).forEach(item => {
                    text += `  ${item.priority}. ${item.task}\n`;
                });
                text += `\n${sep('-')}\n\nMICRO TO-DO\n${sep('-')}\n`;
                (window.currentMicroTodo || coverage.micro_todo || []).forEach(item => {
                    text += `  ${item.priority}. ${item.task}\n`;
                });
                text += `\n${sep('-')}\n\nFINAL RECOMMENDATION\n${sep('-')}\n`;
                text += `${coverage.recommendation?.grade || '—'}\n\n${coverage.recommendation?.justification || ''}\n`;
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = makeFilename(title, 'coverage');
                a.click();
                URL.revokeObjectURL(url);
            };
        }
    }

    function renderCoverageReport(data) {
        const container = document.getElementById('stage8-content');
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
                <div id="stage8-macro-todo-list" class="space-y-2"></div>
            </div>

            <div class="p-6 rounded-lg bg-white/5 border border-white/10">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-xs font-bold text-gray-400 tracking-wider uppercase">Micro To-Do</h3>
                    <span class="text-xs text-gray-500">Scene · Dialogue · Polish</span>
                </div>
                <div id="stage8-micro-todo-list" class="space-y-2"></div>
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
        const containerId = list === 'micro' ? 'stage8-micro-todo-list' : 'stage8-macro-todo-list';
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

    window.retryStage8Coverage = function() {
        initStage8();
    };

    // ─── REUSABLE CHAT WINDOW ────────────────────────────────────────────────

    class ChatWindow {
        constructor({ threadId, inputId, sendBtnId, onSend }) {
            this.thread  = document.getElementById(threadId);
            this.input   = document.getElementById(inputId);
            this.sendBtn = document.getElementById(sendBtnId);
            this.history = [];
            this._wireSend(onSend);
        }

        _wireSend(onSend) {
            const send = async () => {
                const text = this.input.value.trim();
                if (!text || this.sendBtn.disabled) return;
                this.input.value = '';
                this.input.style.height = 'auto';
                this.append('user', text);
                this.setDisabled(true);
                try { await onSend(text, this.history); }
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

        clear() { this.thread.innerHTML = ''; this.history = []; }
        setDisabled(d) { this.sendBtn.disabled = d; this.input.disabled = d; }
    }

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

    function initStageChat({ stageId, threadId, inputId, sendBtnId, executeRevision }) {
        // Guard: skip silently if any required element is missing
        if (!document.getElementById(sendBtnId) || !document.getElementById(inputId) || !document.getElementById(threadId)) {
            console.warn(`initStageChat: missing element(s) for stage ${stageId}`);
            return null;
        }
        let pendingRevision = false;
        let pendingNotes = '';
        const chat = new ChatWindow({
            threadId, inputId, sendBtnId,
            onSend: async (_text, history) => {
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
                try {
                    const res = await fetch('/api/brainstorm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: activeProjectId, stageId, messages: history })
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
                        chat.append('ai', 'Error: ' + (err.error || `Server error ${res.status}`));
                        return;
                    }
                    data = await res.json();
                } catch (err) {
                    chat.append('ai', 'Error: ' + err.message);
                    return;
                }
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
    initStageChat({
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
                if (btnStage1Approve) { btnStage1Approve.textContent = 'Approve'; btnStage1Approve.classList.remove('approve-btn-green'); }
                // Auto-save revised pitch so changes survive a refresh
                const updatedPitch = {};
                currentFields.forEach(f => { updatedPitch[f.getAttribute('data-field')] = f.value; });
                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { stage1_pitch: { pitch: updatedPitch, notes: stage1Notes?.value ?? '' } } })
                });
            }
        }
    });

    // Stage 2
    initStageChat({
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
    initStageChat({
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
    initStageChat({
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
    initStageChat({
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
    initStageChat({
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

    // Stage 7
    initStageChat({
        stageId: 7,
        threadId: 'stage7-chat-thread',
        inputId: 'stage7-chat-input',
        sendBtnId: 'stage7-chat-send',
        executeRevision: async (notes) => {
            if (!activeProjectId) throw new Error('No active project');
            const res = await fetch('/api/revise-draft', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, sceneNumber: currentDraftSceneNumber, feedback: notes })
            });
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const data = await res.json();
            if (draftEditor) draftEditor.innerHTML = formatFountainToHTML(data.result);
            const projRes = await fetch(`/api/projects/${activeProjectId}`);
            const projData = await projRes.json();
            window.currentProjectData = projData.data;
            if (btnNextScene) btnNextScene.classList.remove('hidden');
        }
    });

    // ─── STAGE CHAT RESIZERS (Stages 1–7) ───────────────────────────────────
    for (let s = 1; s <= 7; s++) {
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

    // ─── STAGE 9: REWRITE ────────────────────────────────────────────────────

    // State
    let stage9State   = null;   // { working, priority_idx, macro_todo, micro_todo }
    let stage9Pending = {};     // { scene_number: proposed_text } — not yet approved
    let stage9CurrentScene = null;  // currently selected scene_number
    let stage9ApprovedScenes = {}; // { scene_number: true } changed in a prior approved pass
    let stage9Chat = null;      // ChatWindow instance

    function stage9RenderPlanCard(plan) {
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
            <button id="btnExecutePlanInChat" class="primary-btn" style="margin-top:10px;font-size:0.8rem;">Execute Plan →</button>
        </div>`;
    }

    async function stage9GeneratePlan() {
        if (!stage9Chat) return;
        const priorities = stage9GetPriorityList();
        const task = priorities[stage9State.priority_idx]?.task;
        if (!task) { stage9Chat.append('system', 'No active priority task.'); return; }
        stage9Chat.append('system', 'Generating rewrite plan...');
        const conversationContext = stage9Chat.history.map(m => `${m.role}: ${m.content}`).join('\n');
        try {
            const res = await fetch('/api/plan-rewrite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, priorityTask: task, conversationContext })
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const plan = await res.json();
            window.stage9CurrentPlan = plan;
            stage9Chat.append('ai', '', { html: stage9RenderPlanCard(plan) });
            document.getElementById('btnExecutePlanInChat')?.addEventListener('click', () => stage9ExecutePlan(plan));
        } catch (err) {
            stage9Chat.append('system', 'Planning failed: ' + err.message);
        }
    }

    async function stage9ExecutePlan(plan) {
        if (!plan) return;
        const priorities = stage9GetPriorityList();
        const task = priorities[stage9State.priority_idx]?.task || '';
        const affectedSceneNumbers = (plan.affected_scenes || []).map(s => s.scene_number);
        const loadingOverlay = document.getElementById('stage9-rewrite-loading');
        const rightView = document.getElementById('stage9-right-panel-view');
        loadingOverlay?.classList.remove('hidden');
        loadingOverlay?.classList.add('flex');
        if (rightView) rightView.classList.add('hidden');
        if (stage9Chat) stage9Chat.setDisabled(true);
        try {
            const res = await fetch('/api/rewrite-for-priority', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, priorityTask: task, affectedSceneNumbers })
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const data = await res.json();
            data.scenes.forEach(s => { if (s.modified) stage9Pending[s.scene_number] = s.proposed_text; });
            window.stage9CurrentPlan = null;
            const firstModified = data.scenes.find(s => s.modified);
            if (firstModified) stage9SelectScene(firstModified.scene_number);
            else if (stage9CurrentScene !== null) stage9SelectScene(stage9CurrentScene);
            renderStage9SceneList();
            const modCount = data.scenes.filter(s => s.modified).length;
            if (stage9Chat) stage9Chat.append('ai', `Rewrites applied to ${modCount} scene(s). Review the diffs above — use the scene list on the right to jump between changed scenes.\n\nWhen you're happy with the changes, approve to move on to the next priority.`, {
                actions: [{ label: 'Approve & Continue →', onClick: stage9ApproveAndContinue }]
            });
        } catch (err) {
            console.error('Execute plan failed:', err);
            if (stage9Chat) stage9Chat.append('system', 'Rewrite failed: ' + err.message);
        } finally {
            loadingOverlay?.classList.add('hidden');
            loadingOverlay?.classList.remove('flex');
            if (rightView) rightView.classList.remove('hidden');
            if (stage9Chat) stage9Chat.setDisabled(false);
        }
    }

    async function stage9ApproveAndContinue() {
        stage9FlushEditPanel();
        const newIdx = stage9State.priority_idx + 1;
        try {
            await fetch('/api/approve-rewrite-priority', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, pendingScenes: stage9Pending, newPriorityIdx: newIdx })
            });
            Object.assign(stage9State.working, stage9Pending);
            Object.keys(stage9Pending).forEach(n => { stage9ApprovedScenes[parseInt(n)] = true; });
            stage9Pending = {};
            stage9State.priority_idx = newIdx;
            window.stage9CurrentPlan = null;
            if (window.currentProjectData?.stage9_rewrites) {
                window.currentProjectData.stage9_rewrites.priority_idx = newIdx;
            }
            if (stage9CurrentScene !== null) stage9SelectScene(stage9CurrentScene);
            renderStage9SceneList();

            const priorities = stage9GetPriorityList();
            if (newIdx >= priorities.length) {
                // All done — show done banner, post system message
                document.getElementById('stage9-done-banner')?.classList.remove('hidden');
                stage9Chat?.clear();
                stage9Chat?.append('system', 'All priorities addressed. Use the Finalize Rewrite button above to complete.');
            } else {
                // Clear chat and re-open with next priority
                stage9Chat?.clear();
                stage9Chat?.setDisabled(true);
                try {
                    const initRes = await fetch('/api/brainstorm-rewrite', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: activeProjectId, messages: [], isInit: true })
                    });
                    const initData = await initRes.json();
                    stage9Chat?.append('ai', initData.message);
                } finally {
                    stage9Chat?.setDisabled(false);
                }
            }
        } catch (err) {
            console.error('Approve failed:', err);
            alert('Failed to save: ' + err.message);
        }
    }

    function initStage9Resizers() {
        const vsplit = document.getElementById('stage9-vsplit');
        const leftCont = document.getElementById('stage9-left-container');
        const rightCont = document.getElementById('stage9-right-container');
        if (vsplit && leftCont && rightCont) {
            const savedV = parseFloat(localStorage.getItem('stage9SplitV') || '0.5');
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
                    localStorage.setItem('stage9SplitV', ratio);
                };
                const onUp = () => { vsplit.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }
        const hsplit = document.getElementById('stage9-hsplit');
        const chatEl = document.getElementById('stage9-chat');
        if (hsplit && chatEl) {
            const savedH = parseInt(localStorage.getItem('stage9SplitH') || '280');
            chatEl.style.height = `${savedH}px`;
            hsplit.addEventListener('mousedown', e => {
                e.preventDefault();
                hsplit.classList.add('dragging');
                const startY = e.clientY;
                const startH = chatEl.offsetHeight;
                const onMove = ev => {
                    const newH = Math.min(600, Math.max(120, startH + (startY - ev.clientY)));
                    chatEl.style.height = `${newH}px`;
                    localStorage.setItem('stage9SplitH', newH);
                };
                const onUp = () => { hsplit.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }
    }

    async function initStage9() {
        if (!activeProjectId) return;
        const loading  = document.getElementById('stage9-loading');
        const workspace = document.getElementById('stage9-workspace');
        loading?.classList.remove('hidden');
        workspace?.classList.add('hidden');

        try {
            const reset = !!window.stage9ResetOnInit;
            window.stage9ResetOnInit = false;
            const res = await fetch('/api/init-stage9', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: activeProjectId, reset })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to init Stage 9');
            const data = await res.json();

            stage9State = {
                working:      data.stage9_rewrites.working,
                priority_idx: data.stage9_rewrites.priority_idx,
                macro_todo:   data.macro_todo || [],
                micro_todo:   data.micro_todo  || [],
            };
            stage9Pending = {};
            stage9ApprovedScenes = {};

            loading?.classList.add('hidden');
            workspace?.classList.remove('hidden');

            renderStage9SceneList();
            renderStage9TaskBanner();
            stage9WireButtons();

            // Auto-select first scene
            const firstScene = Object.keys(stage9State.working)[0];
            if (firstScene) stage9SelectScene(parseInt(firstScene));

            // Initialize chat window
            stage9Chat = new ChatWindow({
                threadId:  'stage9-chat-thread',
                inputId:   'stage9-chat-input',
                sendBtnId: 'btnChatSend',
                onSend: async (text, history) => {
                    if (stage9CurrentScene !== null) {
                        // Scene selected: feedback for that scene
                        const priorities = stage9GetPriorityList();
                        const task = priorities[stage9State.priority_idx]?.task || '';
                        const editTA = document.getElementById('stage9-right-panel-edit');
                        const currentText = (editTA && !editTA.classList.contains('hidden'))
                            ? editTA.value
                            : (stage9Pending[stage9CurrentScene] ?? stage9State.working[stage9CurrentScene] ?? '');
                        stage9Chat.append('system', `Rewriting scene ${stage9CurrentScene}...`);
                        const res = await fetch('/api/rewrite-scene-feedback', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: activeProjectId, sceneNumber: stage9CurrentScene, priorityTask: task, userFeedback: text, currentText })
                        });
                        if (!res.ok) throw new Error((await res.json()).error);
                        const data = await res.json();
                        stage9Pending[stage9CurrentScene] = data.proposed_text;
                        stage9SelectScene(stage9CurrentScene);
                        renderStage9SceneList();
                        stage9Chat.append('ai', `Scene ${stage9CurrentScene} updated. Review the diff on the right.`);
                    } else {
                        // No scene selected: planning brainstorm
                        const msgs = history.filter(m => m.role !== 'system');
                        const res = await fetch('/api/brainstorm-rewrite', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectId: activeProjectId, messages: msgs, isInit: false })
                        });
                        if (!res.ok) throw new Error((await res.json()).error);
                        const data = await res.json();
                        const opts = data.suggest_plan ? { withPlanBtn: () => stage9GeneratePlan() } : {};
                        stage9Chat.append('ai', data.message, opts);
                    }
                }
            });

            // Fetch AI opening message (presents Stage 8 priorities)
            try {
                stage9Chat.setDisabled(true);
                const initRes = await fetch('/api/brainstorm-rewrite', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: activeProjectId, messages: [], isInit: true })
                });
                if (initRes.ok) {
                    const initData = await initRes.json();
                    stage9Chat.append('ai', initData.message);
                }
            } catch (e) {
                console.warn('Chat init failed:', e.message);
            } finally {
                stage9Chat.setDisabled(false);
            }
        } catch (err) {
            console.error('initStage9 error:', err);
            if (loading) loading.querySelector('p').textContent = 'Failed to load: ' + err.message;
        }
    }

    function stage9GetPriorityList() {
        const macro = (stage9State.macro_todo || []).map((t, i) => ({ ...t, list: 'MACRO', localIdx: i }));
        const micro = (stage9State.micro_todo  || []).map((t, i) => ({ ...t, list: 'MICRO', localIdx: i }));
        return [...macro, ...micro];
    }

    function renderStage9TaskBanner() {
        const priorities = stage9GetPriorityList();
        const idx = stage9State.priority_idx;
        const doneBanner = document.getElementById('stage9-done-banner');
        if (idx >= priorities.length) {
            doneBanner?.classList.remove('hidden');
        } else {
            doneBanner?.classList.add('hidden');
        }
    }

    function renderStage9SceneList() {
        const container = document.getElementById('stage9-scene-list');
        if (!container || !stage9State) return;
        const entries = Object.keys(stage9State.working).map(n => parseInt(n)).sort((a, b) => a - b);
        container.innerHTML = entries.map(n => {
            const hasPending  = !!stage9Pending[n];
            const hasApproved = !!stage9ApprovedScenes[n];
            const dot = hasPending
                ? '<span class="text-blue-400 ml-1 text-xs">●</span>'
                : hasApproved
                    ? '<span class="text-green-500 ml-1 text-xs">✓</span>'
                    : '';
            const isActive = n === stage9CurrentScene ? 'bg-white/10' : 'hover:bg-white/5';
            // Get slugline from stage6 data
            const allScenes = getFlatScenes();
            const sceneData = allScenes.find(s => s.scene_number === n);
            const label = sceneData?.scene_heading || sceneData?.slugline || `Scene ${n}`;
            return `<button onclick="window.stage9SelectSceneBtn(${n})"
                class="w-full text-left px-3 py-2 rounded text-xs text-gray-300 transition-colors ${isActive} flex items-center justify-between gap-2">
                <span class="truncate">${n}. ${label}</span>${dot}
            </button>`;
        }).join('');
    }

    window.stage9SelectSceneBtn = function(n) { stage9SelectScene(n); };

    function stage9SelectScene(n) {
        // Flush any current right-panel textarea edit into pending
        if (stage9CurrentScene !== null) {
            const editTA = document.getElementById('stage9-right-panel-edit');
            if (editTA && !editTA.classList.contains('hidden')) {
                stage9Pending[stage9CurrentScene] = editTA.value;
            }
        }
        stage9CurrentScene = n;

        const origText     = stage9State.working[n] || '';
        const proposedText = stage9Pending[n] !== undefined ? stage9Pending[n] : origText;
        const leftPanel    = document.getElementById('stage9-left-panel');
        const rightView    = document.getElementById('stage9-right-panel-view');
        const rightEdit    = document.getElementById('stage9-right-panel-edit');

        if (stage9Pending[n] !== undefined) {
            const { leftAnnotations, rightAnnotations } = computeLineDiff(origText, proposedText);
            if (leftPanel)  leftPanel.innerHTML  = formatFountainToHTML(origText, leftAnnotations);
            if (rightView)  rightView.innerHTML  = formatFountainToHTML(proposedText, rightAnnotations);
        } else {
            if (leftPanel)  leftPanel.innerHTML  = formatFountainToHTML(origText);
            if (rightView)  rightView.innerHTML  = formatFountainToHTML(origText);
        }
        if (rightEdit) rightEdit.value = proposedText;

        // Always return to rendered view when switching scenes
        if (rightView) rightView.classList.remove('hidden');
        if (rightEdit) rightEdit.classList.add('hidden');
        const btnToggle = document.getElementById('btnToggleEdit');
        if (btnToggle) btnToggle.textContent = 'Edit Source';

        renderStage9SceneList();
    }

    function stage9FlushEditPanel() {
        if (stage9CurrentScene === null) return;
        const editTA = document.getElementById('stage9-right-panel-edit');
        if (editTA && !editTA.classList.contains('hidden')) {
            stage9Pending[stage9CurrentScene] = editTA.value;
        }
    }

    function stage9WireButtons() {
        // ── Toggle Edit Source ────────────────────────────────────────────────
        const btnToggle = document.getElementById('btnToggleEdit');
        if (btnToggle) {
            btnToggle.onclick = () => {
                const rightView = document.getElementById('stage9-right-panel-view');
                const rightEdit = document.getElementById('stage9-right-panel-edit');
                if (!rightView || !rightEdit) return;

                const editVisible = !rightEdit.classList.contains('hidden');
                if (editVisible) {
                    // Save textarea content → re-render with diff
                    if (stage9CurrentScene !== null) {
                        stage9Pending[stage9CurrentScene] = rightEdit.value;
                        const origText     = stage9State.working[stage9CurrentScene] || '';
                        const proposedText = rightEdit.value;
                        const { rightAnnotations } = computeLineDiff(origText, proposedText);
                        rightView.innerHTML = formatFountainToHTML(proposedText, rightAnnotations);
                        // Also refresh left with removed annotations
                        const { leftAnnotations } = computeLineDiff(origText, proposedText);
                        const leftPanel = document.getElementById('stage9-left-panel');
                        if (leftPanel) leftPanel.innerHTML = formatFountainToHTML(origText, leftAnnotations);
                        renderStage9SceneList();
                    }
                    rightEdit.classList.add('hidden');
                    rightView.classList.remove('hidden');
                    btnToggle.textContent = 'Edit Source';
                } else {
                    rightView.classList.add('hidden');
                    rightEdit.classList.remove('hidden');
                    btnToggle.textContent = 'Preview';
                }
            };
        }

        // ── Finalize Rewrite ──────────────────────────────────────────────────
        const btnFinalize = document.getElementById('btnFinalizeRewrite');
        if (btnFinalize) {
            btnFinalize.onclick = async () => {
                stage9FlushEditPanel();
                if (Object.keys(stage9Pending).length > 0) {
                    await fetch('/api/approve-rewrite-priority', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: activeProjectId, pendingScenes: stage9Pending, newPriorityIdx: stage9State.priority_idx })
                    });
                    Object.assign(stage9State.working, stage9Pending);
                    stage9Pending = {};
                }
                await fetch('/api/finalize-stage9', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: activeProjectId })
                });
                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                window.currentProjectData = projData.data;
                updateStageNav(projData.data);
                switchStage(10);
            };
        }

        // ── Download Rewrite ──────────────────────────────────────────────────
        const btnDownload = document.getElementById('btnDownloadRewrite');
        if (btnDownload) {
            btnDownload.onclick = () => {
                if (!stage9State) { alert('No rewrite data available.'); return; }
                stage9FlushEditPanel();
                const working = { ...stage9State.working, ...stage9Pending };
                const scenes = Object.keys(working).map(n => parseInt(n)).sort((a, b) => a - b);
                const text = scenes.map(n => working[n] || '').filter(Boolean).join('\n\n');
                const title = window.currentProjectData?.stage1_pitch?.pitch?.title || 'Untitled';
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = makeFilename(title, 'rewrite');
                a.click();
                URL.revokeObjectURL(url);
            };
        }

        // ── Resize handles ────────────────────────────────────────────────────
        initStage9Resizers();
    }

});

// --- Stage 7 Helpers ---
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


