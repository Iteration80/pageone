document.addEventListener('DOMContentLoaded', () => {
    let activeProjectId = null;

    // --- DOM Elements ---
    const projectsHub = document.getElementById('projectsHub');
    const appContainer = document.getElementById('appContainer');
    const projectsGrid = document.getElementById('projectsGrid');
    const createNewProjectBtn = document.getElementById('createNewProjectBtn');

    const generateBtn = document.getElementById('generateBtn');
    const promptInput = document.getElementById('promptInput');
    const loadingState = document.getElementById('loadingState');
    const resultsContainer = document.getElementById('resultsContainer');
    const pdfUpload = document.getElementById('pdfUpload');
    const fileNameDisplay = document.getElementById('fileNameDisplay');

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
                <input type="text" class="project-title" value="${escapeHtml(project.title)}" data-id="${project.id}">
                <div class="project-meta">ID: ${project.id}</div>
                <div class="project-actions">
                    <button class="delete-btn" data-id="${project.id}" title="Delete Project">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                    </button>
                </div>
            `;

            // Handle title rename via blur
            const titleInput = card.querySelector('.project-title');
            titleInput.addEventListener('blur', async (e) => {
                const newTitle = e.target.value.trim();
                const id = e.target.getAttribute('data-id');
                if (newTitle && newTitle !== project.title) {
                    await fetch(`/api/projects/${id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: newTitle })
                    });
                }
            });

            // Prevent card click when typing in title
            titleInput.addEventListener('click', (e) => e.stopPropagation());

            // Handle Delete
            const deleteBtn = card.querySelector('.delete-btn');
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm("Are you sure you want to delete this project?")) {
                    const id = e.currentTarget.getAttribute('data-id');
                    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
                    initHub(); // refresh
                }
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

                await fetch(`/api/projects/${activeProjectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                console.log('Final Approved Pitch Saved:', payload);

                finalApproveBtn.textContent = 'Pitch Approved & Saved ✔';
                workshopSection.querySelector('.revise-btn').disabled = true;
            } catch (error) {
                console.error("Failed to save approved pitch:", error);
                alert("An error occurred while saving to the database.");
                finalApproveBtn.textContent = 'Approve';
                finalApproveBtn.disabled = false;
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
