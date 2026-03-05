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
                <button class="approve-btn">Select & Approve This Pitch</button>
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

        console.log('Approved Pitch', approvedData);

        // Clear the other two cards from the screen
        const allCards = document.querySelectorAll('.pitch-card');
        allCards.forEach(card => {
            if (card !== selectedCard) {
                card.remove();
            }
        });

        // Optionally, make the selected card look "approved"
        selectedCard.style.border = '2px solid var(--accent-color)';
        const btn = selectedCard.querySelector('.approve-btn');
        btn.textContent = 'Pitch Approved ✔';
        btn.disabled = true;
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
