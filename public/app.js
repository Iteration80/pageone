document.addEventListener('DOMContentLoaded', () => {
    let activeProjectId = null;
    let targetProjectId = null; // Used for rename and delete operations

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
        navItems[i] = document.getElementById(`nav-stage-${i}`);
        workspaces[i] = document.getElementById(`stage-${i}-view`);
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
    const stage6Board = document.getElementById('stage6-board');
    const stage6Workshop = document.getElementById('stage6Workshop');
    const stage6Notes = document.getElementById('stage6-notes');
    const btnStage6Revise = document.getElementById('btn-stage6-revise');
    const btnStage6Approve = document.getElementById('btn-stage6-approve');
    const btnStage6Edit = document.getElementById('btn-stage6-edit');
    const btnGenerateStage6Blueprint = document.getElementById('btnGenerateStage6Blueprint');


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

            resultsContainer.innerHTML = ''; // Start clean

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
                    stage2Workshop.classList.add('hidden');
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
                    if (btnStage3Approve) btnStage3Approve.classList.add('hidden');

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
                    if (btnStage4Approve) btnStage4Approve.classList.add('hidden');

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
                    if (btnStage5Approve) btnStage5Approve.classList.add('hidden');

                    if (stage5Notes && projectDetails.data.stage5_treatment.notes) {
                        stage5Notes.value = projectDetails.data.stage5_treatment.notes;
                    }
                    if (stage5Notes) autoResize(stage5Notes);
                } else {
                    if (stage5TreatmentContainer) stage5TreatmentContainer.classList.add('hidden');
                    if (stage5Workshop) stage5Workshop.classList.add('hidden');
                    if (stage5Actions) stage5Actions.classList.remove('hidden');
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
            stage1FeedbackPanel.classList.add('hidden');
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

    stage1PdfUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        stage1FileNameDisplay.textContent = file ? file.name : '';
    });

    stage2PdfUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        stage2FileNameDisplay.textContent = file ? file.name : '';
    });

    stage3PdfUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        stage3FileNameDisplay.textContent = file ? file.name : '';
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

        // Hide the "Select to Workshop" button
        const btn = selectedCard.querySelector('.approve-btn');
        if (btn) btn.style.display = 'none';

        // Show the Stage 1 Feedback Panel
        stage1FeedbackPanel.classList.remove('hidden');
        toggleStage1EditMode(false);
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
            if (btnStage1Approve) btnStage1Approve.classList.add('hidden');
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

    // Event listener for Final Approve Stage 1
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
        const notes = stage1Notes.value;

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

    // --- Navigation Logic ---
    function updateStageNav(data) {
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
            5: !!data.stage5_treatment
            // Stages 6-10 currently placeholder
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
        stage2Workshop.classList.remove('hidden');

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
            if (btnStage2Approve) btnStage2Approve.classList.add('hidden');
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

    btnStage2Approve.addEventListener('click', () => saveOutlineEdits(btnStage2Approve));

    if (btnStage2Edit) {
        btnStage2Edit.addEventListener('click', () => {
            toggleStage2EditMode(false);
        });
    }

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

    // --- Stage 3 Logic: Characters ---

    function renderCharacters(characters) {
        if (!charactersContainer) return;
        charactersContainer.innerHTML = '';

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
                        ${field('Wound', 'psychological_core.wound', char.psychological_core?.wound)}
                        ${field('False Belief', 'psychological_core.false_belief', char.psychological_core?.false_belief)}
                        ${field('Fear', 'psychological_core.fear', char.psychological_core?.fear)}
                        ${field('Desire', 'psychological_core.desire', char.psychological_core?.desire)}
                        ${field('Need', 'psychological_core.need', char.psychological_core?.need)}
                    </div>

                    <div style="border-top: 1px solid #1f2937; margin: 12px 0;"></div>
                    <div style="font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px;">Voice &amp; Behavior</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px;">
                        ${field('Speech Patterns', 'voice_and_behavior.speech_patterns', char.voice_and_behavior?.speech_patterns)}
                        ${field('Deflection Tactic', 'voice_and_behavior.deflection_tactic', char.voice_and_behavior?.deflection_tactic)}
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
                psychological_core: { wound: '', false_belief: '', fear: '', desire: '', need: '' },
                voice_and_behavior: { speech_patterns: '', deflection_tactic: '' },
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
                if (btnStage3Approve) btnStage3Approve.classList.add('hidden');

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
                    { label: 'GENRE VARIATION NOTES', key: 'genre_variation_notes', value: beat.genre_variation_notes },
                    { label: 'EMOTIONAL ARC', key: 'emotional_arc', value: beat.emotional_arc },
                    { label: 'PACING NOTES', key: 'pacing_notes', value: beat.pacing_notes },
                    { label: 'DETAILED ACTION', key: 'detailed_action', value: beat.detailed_action }
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

            const data = await response.json();
            if (data.result) {
                renderTreatment(data.result);

                // Fetch updated project to refresh nav
                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                updateStageNav(projData.data);
            } else {
                alert('Unexpected response format from server.');
            }
        } catch (err) {
            console.error('Error generating treatment:', err);
            alert('An error occurred while generating the treatment. You can retry with the Generate Treatment button.');
            // Show the button again so the user can retry
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
            if (btnStage4Approve) btnStage4Approve.classList.add('hidden');
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

                const data = await response.json();
                if (data.result) {
                    renderTreatment(data.result);

                    // Clear notes and PDF
                    if (stage4Notes) stage4Notes.value = '';
                    if (stage4PdfUpload) stage4PdfUpload.value = '';
                    if (stage4FileNameDisplay) stage4FileNameDisplay.textContent = '';

                    if (btnStage4Approve) {
                        btnStage4Approve.textContent = 'Approve';
                        btnStage4Approve.classList.remove('approve-btn-green');
                    }
                } else {
                    alert('Unexpected response format from server.');
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
                if (btnStage4Approve) btnStage4Approve.classList.add('hidden');
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
                
                // Force Apply the Card Aesthetic Classes just in case
                ta.className = "editable-field w-full bg-[#1e293b] rounded-xl border border-gray-800/60 p-6 text-gray-300 leading-relaxed max-h-96 overflow-y-auto resize-y treatment-stage5-ta text-sm";
                
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
                        ta.style.background = 'rgba(30, 41, 59, 0.9)'; // Slightly lighter on focus
                        ta.style.outline = '1px solid #374151';
                    });
                    ta.addEventListener('blur', () => {
                        ta.style.background = '#1e293b'; // Reset to explicitly set dark card background
                        ta.style.outline = 'none';
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

        if (loadingStateStage5) loadingStateStage5.classList.remove('hidden');
        if (stage5Actions) stage5Actions.classList.add('hidden');
        if (stage5TreatmentContainer) stage5TreatmentContainer.classList.add('hidden');
        if (stage5Workshop) stage5Workshop.classList.add('hidden');

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

            const data = await response.json();
            if (data.result) {
                renderTreatmentStage5(data.result);
                // Fetch updated project for nav status
                const projRes = await fetch(`/api/projects/${activeProjectId}`);
                const projData = await projRes.json();
                updateStageNav(projData.data);
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

    if (btnStage5Edit) {
        btnStage5Edit.addEventListener('click', () => {
            if (btnStage5Revise) btnStage5Revise.classList.remove('hidden');
            if (btnStage5Approve) btnStage5Approve.classList.remove('hidden');
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
                formData.append('currentTreatment', JSON.stringify(currentData)); // Reuse key for backend consistency if needed, but route handles it
                formData.append('notes', userNote);
                if (selectedPdf) formData.append('pdfFile', selectedPdf);

                const response = await fetch('/api/generate-stage5-treatment', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) throw new Error(`Server responded with ${response.status}`);

                const data = await response.json();
                if (data.result) {
                    renderTreatmentStage5(data.result);
                    if (stage5Notes) stage5Notes.value = '';
                    if (stage5PdfUpload) stage5PdfUpload.value = '';
                    if (stage5FileNameDisplay) stage5FileNameDisplay.textContent = '';
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
                btnStage5Approve.classList.add('hidden');
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
        if (!stage6Board) return;
        stage6Board.innerHTML = '';

        // Dummy Data implementation
        const dummyData = data || {
            sequences: [
                {
                    title: "Sequence 1: The Setup",
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
                },
                {
                    title: "Sequence 2: The Complication",
                    scenes: [
                        {
                            scene_number: 3,
                            scene_heading: "INT. DARK ALLEY - NIGHT",
                            narrative_action: "Shadowy figures pursue the protagonist. A tense chase ensues.",
                            dramaturgical_function: "Increase the stakes and introduce the antagonists.",
                            estimated_page_count: "1 pgs"
                        },
                        {
                            scene_number: 4,
                            scene_heading: "EXT. ROOFTOP - NIGHT",
                            narrative_action: "The protagonist barely escapes, looking over the city with the package in hand.",
                            dramaturgical_function: "Establish the protagonist's isolation and the importance of the package.",
                            estimated_page_count: "1.5 pgs"
                        }
                    ]
                }
            ]
        };

        dummyData.sequences.forEach((seq) => {
            const seqBlock = document.createElement('div');
            seqBlock.className = 'sequence-block';

            const seqTitle = document.createElement('div');
            seqTitle.className = 'sequence-title';
            seqTitle.textContent = seq.title;
            seqBlock.appendChild(seqTitle);

            const cardsContainer = document.createElement('div');
            cardsContainer.className = 'scene-cards-container';

            seq.scenes.forEach((scene) => {
                const card = document.createElement('div');
                card.className = 'scene-card';
                card.innerHTML = `
                    <div class="scene-card-header">
                        <div class="flex items-center">
                            <span class="card-grip">⋮⋮</span>
                            <span class="scene-number">Scene ${scene.scene_number}</span>
                        </div>
                        <button class="delete-patch-btn" title="Delete & Patch">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
                        </button>
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
                        <button class="ai-rewrite-btn" title="AI Rewrite Scene">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path><path d="M5 3v4"></path><path d="M3 5h4"></path><path d="M21 17v4"></path><path d="M19 19h4"></path></svg>
                        </button>
                    </div>
                `;

                // Add resize listeners to textareas
                card.querySelectorAll('textarea').forEach(ta => {
                    ta.addEventListener('input', () => autoResize(ta));
                    // Initial resize
                    setTimeout(() => autoResize(ta), 0);
                });

                cardsContainer.appendChild(card);
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
            stage6Board.appendChild(seqBlock);
        });


        // Show workshop if data is rendered
        if (stage6Workshop) stage6Workshop.classList.remove('hidden');
    }

    if (btnGenerateStage6Blueprint) {
        btnGenerateStage6Blueprint.addEventListener('click', () => {
            renderStage6(); // Re-render with dummy data for now
        });
    }

});


