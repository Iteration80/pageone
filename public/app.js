document.addEventListener('DOMContentLoaded', () => {
    let activeProjectId = null;
    let targetProjectId = null; // Used for rename and delete operations

    function autoResize(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    }

    // --- DOM Elements ---
    const projectsHub = document.getElementById('projectsHub');
    const appContainer = document.getElementById('appContainer');
    const projectsGrid = document.getElementById('projectsGrid');
    const createNewProjectBtn = document.getElementById('createNewProjectBtn');
    const btnReturnHome = document.getElementById('btnReturnHome');

    // Navigation
    const navStage1 = document.getElementById('navStage1');
    const navStage2 = document.getElementById('navStage2');
    const stage1Workspace = document.getElementById('stage1Workspace');
    const stage2Workspace = document.getElementById('stage2Workspace');
    const navStage3 = document.getElementById('navStage3');
    const stage3Workspace = document.getElementById('stage3Workspace');

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

    // Textarea/Notes auto-resize listeners
    [stage1Notes, stage2Notes, stage3Notes, promptInput].forEach(el => {
        if (el) {
            el.addEventListener('input', () => autoResize(el));
            el.addEventListener('focus', () => { el.style.background = 'rgba(31,41,55,0.8)'; el.style.outline = '1px solid #374151'; });
            el.addEventListener('blur', () => { el.style.background = 'transparent'; el.style.outline = 'none'; });

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
        if (e.target.files.length > 0) {
            fileNameDisplay.textContent = e.target.files[0].name;
            fileNameDisplay.style.display = 'inline-block';
        } else {
            fileNameDisplay.textContent = '';
            fileNameDisplay.style.display = 'none';
        }
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
            const response = await fetch('/api/refine-pitch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPitch, userNote })
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

                // Clear notes
                stage1Notes.value = '';
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
            const b = navEl.querySelector('.badge');
            if (isDone) {
                navEl.classList.add('completed');
                b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            } else {
                navEl.classList.remove('completed');
                b.textContent = num;
            }
        }

        const stage1Done = !!data.stage1_pitch;
        const stage2Done = !!data.stage2_outline;
        const stage3Done = !!data.stage3_characters;

        toggle(navStage1, stage1Done, '1');
        toggle(navStage2, stage2Done, '2');
        toggle(navStage3, stage3Done, '3');

        if (stage1Done) {
            navStage2.classList.remove('disabled');
        } else {
            navStage2.classList.add('disabled');
        }

        if (stage2Done) {
            navStage3.classList.remove('disabled');
        } else {
            navStage3.classList.add('disabled');
        }
    }

    function switchStage(stageNum) {
        if (stageNum === 1) {
            navStage1.classList.add('active');
            navStage2.classList.remove('active');
            if (navStage3) navStage3.classList.remove('active');
            stage1Workspace.classList.remove('hidden');
            stage2Workspace.classList.add('hidden');
            if (stage3Workspace) stage3Workspace.classList.add('hidden');
        } else if (stageNum === 2) {
            navStage2.classList.add('active');
            navStage1.classList.remove('active');
            if (navStage3) navStage3.classList.remove('active');
            stage2Workspace.classList.remove('hidden');
            stage1Workspace.classList.add('hidden');
            if (stage3Workspace) stage3Workspace.classList.add('hidden');
        } else if (stageNum === 3) {
            if (navStage3) navStage3.classList.add('active');
            navStage1.classList.remove('active');
            navStage2.classList.remove('active');
            if (stage3Workspace) stage3Workspace.classList.remove('hidden');
            stage1Workspace.classList.add('hidden');
            stage2Workspace.classList.add('hidden');
        }
    }

    navStage1.addEventListener('click', (e) => {
        e.preventDefault();
        switchStage(1);
    });

    navStage2.addEventListener('click', (e) => {
        e.preventDefault();
        if (!navStage2.classList.contains('disabled')) {
            switchStage(2);
        }
    });

    if (navStage3) {
        navStage3.addEventListener('click', (e) => {
            e.preventDefault();
            if (!navStage3.classList.contains('disabled')) {
                switchStage(3);
            }
        });
    }

    // --- Stage 2 Logic ---
    async function autoGenerateBeats() {
        if (!activeProjectId) return;

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
            if (btnStage2Revise) {
                btnStage2Revise.classList.remove('hidden');
                btnStage2Revise.textContent = 'Submit';
                btnStage2Revise.disabled = false;
            }
            if (btnStage2Approve) {
                btnStage2Approve.classList.remove('hidden');
                btnStage2Approve.textContent = 'Approve';
                btnStage2Approve.classList.remove('approve-btn-green');
                btnStage2Approve.disabled = false;
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

        if (!notes) {
            // Treat as a manual save if there's no feedback
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
        btnStage2Revise.disabled = true;
        btnStage2Revise.textContent = 'Revising...';

        try {
            const res = await fetch('/api/generate-outline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: activeProjectId,
                    currentBeats,
                    notes
                })
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Failed to revise outline");
            }

            const data = await res.json();
            renderOutline(data.result.outline);
            stage2Notes.value = '';

            if (btnStage2Approve) {
                btnStage2Approve.textContent = 'Approve';
                btnStage2Approve.classList.remove('approve-btn-green');
            }
        } catch (err) {
            console.error(err);
            alert(err.message);
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

        // Auto-resize all textareas after DOM is populated
        requestAnimationFrame(() => {
            document.querySelectorAll('.char-ta').forEach(ta => autoResize(ta));
        });

        charactersContainer.classList.remove('hidden');
        if (stage3Workshop) stage3Workshop.classList.remove('hidden');
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

            if (!notes) {
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
                const res = await fetch('/api/generate-characters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId: activeProjectId,
                        currentCharacters,
                        notes
                    })
                });

                if (!res.ok) throw new Error("Failed to revise characters");
                const data = await res.json();
                renderCharacters(data.result.characters);

                if (stage3Notes) stage3Notes.value = ''; // clear notes
                if (btnStage3Approve) {
                    btnStage3Approve.textContent = 'Approve';
                    btnStage3Approve.classList.remove('approve-btn-green');
                }
            } catch (err) {
                console.error(err);
                alert("Error revising characters");
            } finally {
                loadingStateCharacters.classList.add('hidden');
                charactersContainer.classList.remove('hidden');
                btnStage3Revise.textContent = originalText;
                btnStage3Revise.disabled = false;
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
});
