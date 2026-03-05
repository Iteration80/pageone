document.addEventListener('DOMContentLoaded', () => {
    const generateBtn = document.getElementById('generateBtn');
    const promptInput = document.getElementById('promptInput');
    const loadingState = document.getElementById('loadingState');
    const resultsContainer = document.getElementById('resultsContainer');
    const pdfUpload = document.getElementById('pdfUpload');
    const fileNameDisplay = document.getElementById('fileNameDisplay');

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
        finalApproveBtn.addEventListener('click', () => {
            // Re-grab the edited data just in case they changed it during workshop
            const finalFields = selectedCard.querySelectorAll('.pitch-card > .field-group .editable-field');
            const finalData = {};
            finalFields.forEach(field => {
                const key = field.getAttribute('data-field');
                finalData[key] = field.value;
            });
            const notes = workshopSection.querySelector('.notes-input').value;
            console.log('Final Approved Pitch:', finalData, 'Workshop Notes:', notes);

            finalApproveBtn.textContent = 'Pitch Approved ✔';
            finalApproveBtn.disabled = true;
            workshopSection.querySelector('.revise-btn').disabled = true;
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
