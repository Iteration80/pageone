document.addEventListener('DOMContentLoaded', () => {
    let activeProjectId = null;
    let targetProjectId = null; // Used for rename and delete operations

    // --- DOM Elements ---
    const projectsHub = document.getElementById('projectsHub');
    const appContainer = document.getElementById('appContainer');
    const projectsGrid = document.getElementById('projectsGrid');
    const createNewProjectBtn = document.getElementById('createNewProjectBtn');

    // Navigation
    const navStage1 = document.getElementById('navStage1');
    const navStage2 = document.getElementById('navStage2');
    const stage1Workspace = document.getElementById('stage1Workspace');
    const stage2Workspace = document.getElementById('stage2Workspace');

    // Stage 1 Elements
    const generateBtn = document.getElementById('generateBtn');
    const promptInput = document.getElementById('promptInput');
    const loadingState = document.getElementById('loadingState');
    const resultsContainer = document.getElementById('resultsContainer');
    const pdfUpload = document.getElementById('pdfUpload');
    const fileNameDisplay = document.getElementById('fileNameDisplay');

    const generateOutlineBtn = document.getElementById('generateOutlineBtn');
    const saveOutlineBtn = document.getElementById('saveOutlineBtn');
    const outlineContainer = document.getElementById('outlineContainer');
    const loadingStateOutline = document.getElementById('loadingStateOutline');

    // Stage 2 Workshop Elements
    const stage2Workshop = document.getElementById('stage2Workshop');
    const stage2Notes = document.getElementById('stage2Notes') || document.getElementById('stage2-notes');
    const btnStage2Revise = document.getElementById('btnStage2Revise') || document.getElementById('btn-stage2-revise');
    const btnStage2Approve = document.getElementById('btnStage2Approve') || document.getElementById('btn-stage2-approve');

    const renameModal = document.getElementById('renameModal');
    const renameInput = document.getElementById('renameInput');
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
            card.addEventListener('click', async () => {
                activeProjectId = project.id;
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
                            const notesInput = cardElement.querySelector('.notes-input');
                            if (notesInput && notes) {
                                notesInput.value = notes;
                            }

                            // Re-bind final approve button text if it was already saved
                            const finalApproveBtn = cardElement.querySelector('.final-approve-btn');
                            if (finalApproveBtn) {
                                finalApproveBtn.textContent = 'Pitch Approved & Saved ✔';
                            }
                        }

                        updateStageNav(projectDetails.data);

                        // Hydrate Stage 2 Outline if exists
                        if (projectDetails.data.stage2_outline && projectDetails.data.stage2_outline.outline) {
                            renderOutline(projectDetails.data.stage2_outline.outline);
                        } else {
                            document.getElementById('act1Container').innerHTML = '';
                            document.getElementById('act2Container').innerHTML = '';
                            document.getElementById('act3Container').innerHTML = '';
                            saveOutlineBtn.classList.add('hidden');
                            stage2Workshop.classList.add('hidden');
                        }
                    } else {
                        updateStageNav(projectDetails.data);
                    }
                } catch (err) {
                    console.error("Error loading project details:", err);
                }
            });

            projectsGrid.appendChild(card);
        });
    }

    createNewProjectBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/projects', { method: 'POST' });
            initHub();
        } catch (error) {
            console.error("Failed to create project:", error);
        }
    });

    // Initialize the hub on load
    initHub();

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

        if (!prompt && !pdfFile) {
            alert("Please enter a story idea or attach a PDF first.");
            return;
        }

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
                <div class="field-group">
                    <label>Title</label>
                    <input type="text" class="editable-field title-input" data-field="title" value="${escapeHtml(pitch.title)}">
                </div>
                <div class="field-group">
                    <label>Genre</label>
                    <input type="text" class="editable-field" data-field="genre" value="${escapeHtml(pitch.genre)}">
                </div>
                <div class="field-group">
                    <label>Core Theme</label>
                    <input type="text" class="editable-field" data-field="core_theme" value="${escapeHtml(pitch.core_theme)}">
                </div>
                <div class="field-group">
                    <label>Logline</label>
                    <textarea class="editable-field" data-field="logline">${escapeHtml(pitch.logline)}</textarea>
                </div>
                <div class="field-group">
                    <label>Synopsis</label>
                    <textarea class="editable-field synopsis-input" data-field="synopsis">${escapeHtml(pitch.synopsis)}</textarea>
                </div>
                <button class="approve-btn">Select to Workshop</button>
            `;

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
        btn.style.display = 'none';

        // Add the workshop UI at the bottom of the card
        const workshopSection = document.createElement('div');
        workshopSection.className = 'workshop-section';
        workshopSection.innerHTML = `
            <div class="field-group">
                <label>Notes</label>
                <textarea class="editable-field notes-input" placeholder="e.g., Make it scarier, change the setting..."></textarea>
            </div>
            <div class="workshop-actions">
                <button class="revise-btn">Revise Pitch</button>
                <button class="final-approve-btn">Approve</button>
            </div>
        `;
        selectedCard.appendChild(workshopSection);

        // Event listener for Revise Pitch
        const reviseBtn = workshopSection.querySelector('.revise-btn');
        const notesInput = workshopSection.querySelector('.notes-input');

        reviseBtn.addEventListener('click', async () => {
            const userNote = notesInput.value.trim();
            if (!userNote) {
                alert("Please enter a note for the revision.");
                return;
            }

            // Gather current pitch data
            const currentFields = selectedCard.querySelectorAll('.pitch-card > .field-group .editable-field');
            const currentPitch = {};
            currentFields.forEach(field => {
                const key = field.getAttribute('data-field');
                currentPitch[key] = field.value;
            });

            // Set loading state
            const originalText = reviseBtn.textContent;
            reviseBtn.textContent = 'Revising...';
            reviseBtn.disabled = true;

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
                            field.value = revisedPitch[key];
                        }
                    });

                    // Clear notes
                    notesInput.value = '';
                } else {
                    alert("Unexpected response format from server.");
                }
            } catch (error) {
                console.error(error);
                alert("An error occurred while revising the pitch.");
            } finally {
                reviseBtn.textContent = originalText;
                reviseBtn.disabled = false;
            }
        });

        // Event listener for Final Approve
        const finalApproveBtn = workshopSection.querySelector('.final-approve-btn');
        finalApproveBtn.addEventListener('click', async () => {
            // Re-grab the edited data just in case they changed it during workshop
            const finalFields = selectedCard.querySelectorAll('.pitch-card > .field-group .editable-field');
            const finalData = {};
            finalFields.forEach(field => {
                const key = field.getAttribute('data-field');
                finalData[key] = field.value;
            });
            const notes = workshopSection.querySelector('.notes-input').value;

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
                finalApproveBtn.textContent = 'Saving...';
                finalApproveBtn.disabled = true;

                const res = await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const updatedProject = await res.json();

                console.log('Final Approved Pitch Saved:', payload);

                finalApproveBtn.textContent = 'Pitch Approved & Saved ✔';
                workshopSection.querySelector('.revise-btn').disabled = true;

                // Update Navigation UI
                updateStageNav(updatedProject.data);
            } catch (error) {
                console.error("Failed to save approved pitch:", error);
                alert("An error occurred while saving to the database.");
                finalApproveBtn.textContent = 'Approve';
                finalApproveBtn.disabled = false;
            }
        });
    }

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

        const stage1Done = data && data.stage1_pitch && data.stage1_pitch.pitch;
        const stage2Done = data && data.stage2_outline && data.stage2_outline.outline;

        toggle(navStage1, stage1Done, '1');
        toggle(navStage2, stage2Done, '2');

        if (stage1Done) {
            navStage2.classList.remove('disabled');
        } else {
            navStage2.classList.add('disabled');
        }
    }

    function switchStage(stageNum) {
        if (stageNum === 1) {
            navStage1.classList.add('active');
            navStage2.classList.remove('active');
            stage1Workspace.classList.remove('hidden');
            stage2Workspace.classList.add('hidden');
        } else if (stageNum === 2) {
            navStage2.classList.add('active');
            navStage1.classList.remove('active');
            stage2Workspace.classList.remove('hidden');
            stage1Workspace.classList.add('hidden');
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

    // --- Stage 2 Logic ---
    generateOutlineBtn.addEventListener('click', async () => {
        if (!activeProjectId) return;

        loadingStateOutline.classList.remove('hidden');
        outlineContainer.innerHTML = '';
        generateOutlineBtn.disabled = true;

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
            generateOutlineBtn.disabled = false;
        }
    });

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
                        <textarea class="beat-description">${escapeHtml(beat.description)}</textarea>
                    `;
                    seqBlock.appendChild(card);
                });

                container.appendChild(seqBlock);
            });
        };

        if (outlineData.act_1) renderSequences(outlineData.act_1, act1Container);
        if (outlineData.act_2) renderSequences(outlineData.act_2, act2Container);
        if (outlineData.act_3) renderSequences(outlineData.act_3, act3Container);

        saveOutlineBtn.classList.remove('hidden');
        document.getElementById('outlineContainer').classList.remove('hidden');
        stage2Workshop.classList.remove('hidden');
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

            triggerBtn.textContent = 'Beats Saved ✔';
            if (triggerBtn.id === 'btn-stage2-approve') {
                triggerBtn.style.backgroundColor = '#10b981'; // solid emerald-500
            }
            setTimeout(() => {
                triggerBtn.textContent = originalText;
            }, 3000);
        } catch (err) {
            console.error("Failed to save outline:", err);
            alert("Error saving outline.");
            triggerBtn.textContent = originalText;
        } finally {
            triggerBtn.disabled = false;
        }
    }

    saveOutlineBtn.addEventListener('click', () => saveOutlineEdits(saveOutlineBtn));
    btnStage2Approve.addEventListener('click', () => saveOutlineEdits(btnStage2Approve));

    btnStage2Revise.addEventListener('click', async () => {
        if (!activeProjectId) return;
        const notes = stage2Notes.value.trim();
        if (!notes) {
            alert("Please enter notes for revision.");
            return;
        }

        const currentBeats = scrapeOutline();
        loadingStateOutline.classList.remove('hidden');
        btnStage2Revise.disabled = true;
        const originalText = btnStage2Revise.textContent;
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
        } catch (err) {
            console.error(err);
            alert(err.message);
        } finally {
            loadingStateOutline.classList.add('hidden');
            btnStage2Revise.disabled = false;
            btnStage2Revise.textContent = originalText;
        }
    });

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
