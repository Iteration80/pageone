/**
 * fountain-editor.js — WYSIWYG screenplay editor with Fountain format
 *
 * Shared by Stage 7 (Draft) and Stage 9 (Rewrite).
 * Each paragraph is a <div> with data-element="type" and a CSS class.
 * Storage format is Fountain plain text (loadFountain / toFountain).
 */

/* global window, document */

// ─── Fountain Parser (ported from agents/export.js) ──────────────────────────

const FE_ELEMENT_TYPES = [
    'scene-heading', 'action', 'character', 'parenthetical', 'dialogue', 'transition'
];

const FE_TYPE_LABELS = {
    'scene-heading':   'Scene Heading',
    'action':          'Action',
    'character':       'Character',
    'parenthetical':   'Parenthetical',
    'dialogue':        'Dialogue',
    'transition':      'Transition',
};

const FE_SHORTCUT_KEYS = { 1: 'scene-heading', 2: 'action', 3: 'character', 4: 'parenthetical', 5: 'dialogue', 6: 'transition' };

// Context-aware next element when pressing Tab
const FE_TAB_NEXT = {
    'scene-heading':   'action',
    'action':          'character',
    'character':       'dialogue',
    'parenthetical':   'dialogue',
    'dialogue':        'action',
    'transition':      'action',
};

// Auto-advance: when pressing Enter, what does the NEW line become?
const FE_ENTER_NEXT = {
    'scene-heading':   'action',
    'action':          'action',
    'character':       'dialogue',
    'parenthetical':   'dialogue',
    'dialogue':        'action',
    'transition':      'scene-heading',
};

function parseFountainToElements(text) {
    if (!text || !text.trim()) return [{ type: 'action', text: '' }];

    const lines = text.split('\n');
    const elements = [];
    let i = 0;

    while (i < lines.length) {
        const raw = lines[i];
        const trimmed = raw.trim();

        // Blank line
        if (!trimmed) {
            elements.push({ type: 'blank', text: '' });
            i++;
            continue;
        }

        // Forced scene heading: .INT...
        if (trimmed.startsWith('.') && !trimmed.startsWith('..')) {
            elements.push({ type: 'scene-heading', text: trimmed.slice(1).trim() });
            i++;
            continue;
        }

        // Scene heading: INT./EXT.
        if (/^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.)/i.test(trimmed)) {
            elements.push({ type: 'scene-heading', text: trimmed });
            i++;
            continue;
        }

        // Transition: ends with TO: or specific keywords
        if (/^(FADE\s+IN:|FADE\s+OUT\.|FADE\s+TO:|SMASH\s+CUT\s+TO:|CUT\s+TO:)$/i.test(trimmed) ||
            (trimmed === trimmed.toUpperCase() && trimmed.endsWith(' TO:')) ||
            trimmed === 'FADE OUT.') {
            elements.push({ type: 'transition', text: trimmed });
            i++;
            continue;
        }

        // Forced transition: > at start (not centered)
        if (trimmed.startsWith('>') && !trimmed.endsWith('<')) {
            elements.push({ type: 'transition', text: trimmed.slice(1).trim() });
            i++;
            continue;
        }

        // Character cue: all caps (possibly with extensions like (V.O.), (O.S.))
        // Must be preceded by blank line (or start of document), next line non-empty
        const prevIsBlank = i === 0 || !lines[i - 1].trim();
        const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
        const cueBase = trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
        const cueIsAllCaps = cueBase === cueBase.toUpperCase() && /[A-Z]/.test(cueBase);

        if (cueIsAllCaps && prevIsBlank && nextLine) {
            elements.push({ type: 'character', text: trimmed });
            i++;
            // Collect dialogue / parentheticals
            while (i < lines.length) {
                const dline = lines[i].trim();
                if (!dline) break;
                if (dline.startsWith('(') && dline.endsWith(')')) {
                    elements.push({ type: 'parenthetical', text: dline.slice(1, -1).trim() });
                } else {
                    elements.push({ type: 'dialogue', text: dline });
                }
                i++;
            }
            continue;
        }

        // Action (default)
        elements.push({ type: 'action', text: trimmed });
        i++;
    }

    if (elements.length === 0) elements.push({ type: 'action', text: '' });
    return elements;
}

// ─── FountainEditor Class ────────────────────────────────────────────────────

class FountainEditor {
    /**
     * @param {HTMLElement} containerEl - Mount point (will be populated)
     * @param {object} opts
     * @param {boolean} opts.readOnly
     * @param {function} opts.onDirty - Called when content changes
     */
    constructor(containerEl, opts = {}) {
        this.container = containerEl;
        this.readOnly = opts.readOnly || false;
        this.onDirty = opts.onDirty || null;
        this._dirty = false;
        this._lastCleanText = '';

        // Build DOM
        this.container.innerHTML = '';

        // Toolbar (only if editable)
        if (!this.readOnly) {
            this.toolbar = this._buildToolbar();
            this.container.appendChild(this.toolbar);
        }

        // Editing surface
        this.surface = document.createElement('div');
        this.surface.className = 'fe-surface';
        this.surface.contentEditable = this.readOnly ? 'false' : 'true';
        this.surface.spellcheck = true;
        this.container.appendChild(this.surface);

        // Event listeners
        if (!this.readOnly) {
            this.surface.addEventListener('input', () => this._onInput());
            this.surface.addEventListener('keydown', (e) => this._onKeydown(e));
            this.surface.addEventListener('paste', (e) => this._onPaste(e));
            this.surface.addEventListener('click', () => this._updateToolbar());
            this.surface.addEventListener('keyup', () => this._updateToolbar());

            // Close dropdown on outside click
            document.addEventListener('click', (e) => {
                if (this.dropdown && !this.toolbar.contains(e.target)) {
                    this.dropdown.classList.add('hidden');
                }
            });
        }
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    loadFountain(rawText) {
        const elements = parseFountainToElements(rawText || '');
        this.surface.innerHTML = '';

        for (const el of elements) {
            if (el.type === 'blank') {
                const div = this._createElementDiv('action', '');
                div.innerHTML = '<br>';
                this.surface.appendChild(div);
            } else {
                this.surface.appendChild(this._createElementDiv(el.type, el.text));
            }
        }

        this._dirty = false;
        this._lastCleanText = this.toFountain();
        this._updateToolbar();
    }

    toFountain() {
        const divs = Array.from(this.surface.children);
        const lines = [];
        let prevType = null;

        for (const div of divs) {
            const type = div.getAttribute('data-element') || 'action';
            const text = (div.textContent || '').trim();

            // Insert blank line before scene headings, characters, transitions (unless at start)
            if (lines.length > 0 && (type === 'scene-heading' || type === 'character' || type === 'transition')) {
                // Only add blank if previous line wasn't already blank
                if (lines[lines.length - 1] !== '') {
                    lines.push('');
                }
            }

            // Insert blank line after dialogue block ends (dialogue/parenthetical -> non-dialogue)
            if (lines.length > 0 && (prevType === 'dialogue' || prevType === 'parenthetical') &&
                type !== 'dialogue' && type !== 'parenthetical' && type !== 'character') {
                if (lines[lines.length - 1] !== '') {
                    lines.push('');
                }
            }

            if (!text && type === 'action') {
                // Empty action line = blank line separator
                lines.push('');
            } else {
                switch (type) {
                    case 'scene-heading':
                        lines.push(text.toUpperCase());
                        break;
                    case 'character':
                        lines.push(text.toUpperCase());
                        break;
                    case 'parenthetical': {
                        const inner = text.replace(/^\(/, '').replace(/\)$/, '').trim();
                        lines.push(`(${inner})`);
                        break;
                    }
                    case 'transition':
                        lines.push(text.toUpperCase());
                        break;
                    default:
                        lines.push(text);
                }
            }

            prevType = type;
        }

        // Trim trailing empty lines
        while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        return lines.join('\n');
    }

    getActiveElement() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return null;
        let node = sel.anchorNode;
        // Walk up to find the direct child of surface
        while (node && node.parentElement !== this.surface) {
            node = node.parentElement;
        }
        if (!node || node.parentElement !== this.surface) return null;
        return { el: node, type: node.getAttribute('data-element') || 'action' };
    }

    setElementType(type) {
        const active = this.getActiveElement();
        if (!active) return;
        this._applyType(active.el, type);
        this._onInput();
        this._updateToolbar();
    }

    isDirty() {
        return this._dirty;
    }

    markClean() {
        this._dirty = false;
        this._lastCleanText = this.toFountain();
    }

    destroy() {
        this.container.innerHTML = '';
    }

    // ─── Toolbar ─────────────────────────────────────────────────────────────

    _buildToolbar() {
        const bar = document.createElement('div');
        bar.className = 'fe-toolbar';

        // Current type button
        this.typeBtn = document.createElement('button');
        this.typeBtn.className = 'fe-current-type';
        this.typeBtn.textContent = 'Action';
        this.typeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.dropdown.classList.toggle('hidden');
        });
        bar.appendChild(this.typeBtn);

        // Dropdown
        this.dropdown = document.createElement('div');
        this.dropdown.className = 'fe-type-dropdown hidden';

        const isMac = navigator.platform.indexOf('Mac') > -1;
        const modKey = isMac ? '⌘' : 'Ctrl+';

        FE_ELEMENT_TYPES.forEach((type, idx) => {
            const btn = document.createElement('button');
            btn.className = 'fe-type-option';
            btn.setAttribute('data-type', type);
            btn.innerHTML = `<span>${FE_TYPE_LABELS[type]}</span><kbd>${modKey}${idx + 1}</kbd>`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setElementType(type);
                this.dropdown.classList.add('hidden');
                this.surface.focus();
            });
            this.dropdown.appendChild(btn);
        });

        bar.appendChild(this.dropdown);

        // Shortcut hint
        const hint = document.createElement('span');
        hint.className = 'fe-toolbar-hint';
        hint.textContent = 'Tab to cycle type';
        bar.appendChild(hint);

        return bar;
    }

    _updateToolbar() {
        if (!this.typeBtn) return;
        const active = this.getActiveElement();
        const type = active ? active.type : 'action';
        this.typeBtn.textContent = FE_TYPE_LABELS[type] || 'Action';
        this.typeBtn.setAttribute('data-active-type', type);

        // Highlight active option in dropdown
        if (this.dropdown) {
            this.dropdown.querySelectorAll('.fe-type-option').forEach(btn => {
                btn.classList.toggle('fe-type-active', btn.getAttribute('data-type') === type);
            });
        }
    }

    // ─── DOM Helpers ─────────────────────────────────────────────────────────

    _createElementDiv(type, text) {
        const div = document.createElement('div');
        this._applyType(div, type);
        if (text) {
            div.textContent = text;
        }
        return div;
    }

    _applyType(div, type) {
        // Remove all fe- classes
        FE_ELEMENT_TYPES.forEach(t => div.classList.remove('fe-' + t));
        div.setAttribute('data-element', type);
        div.classList.add('fe-' + type);
    }

    // ─── Event Handlers ──────────────────────────────────────────────────────

    _onInput() {
        const currentText = this.toFountain();
        if (currentText !== this._lastCleanText) {
            this._dirty = true;
            if (this.onDirty) this.onDirty();
        }

        // Ensure new divs created by contenteditable get a type
        for (const child of this.surface.children) {
            if (!child.getAttribute('data-element')) {
                // Infer type from previous sibling
                const prev = child.previousElementSibling;
                const prevType = prev ? (prev.getAttribute('data-element') || 'action') : 'action';
                const newType = FE_ENTER_NEXT[prevType] || 'action';
                this._applyType(child, newType);
            }
        }
    }

    _onKeydown(e) {
        // Cmd/Ctrl + 1-6: set element type
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
            const num = parseInt(e.key);
            if (num >= 1 && num <= 6) {
                e.preventDefault();
                this.setElementType(FE_SHORTCUT_KEYS[num]);
                return;
            }
        }

        // Tab: cycle element type
        if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            const active = this.getActiveElement();
            if (!active) return;
            const currentType = active.type;

            if (e.shiftKey) {
                // Reverse cycle: find what maps TO currentType
                const reverseMap = {};
                for (const [from, to] of Object.entries(FE_TAB_NEXT)) {
                    reverseMap[to] = from;
                }
                const prevType = reverseMap[currentType] || 'action';
                this.setElementType(prevType);
            } else {
                const nextType = FE_TAB_NEXT[currentType] || 'action';
                this.setElementType(nextType);
            }
            return;
        }

        // Enter: create new line with auto-advanced type
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const active = this.getActiveElement();
            const currentType = active ? active.type : 'action';
            const nextType = FE_ENTER_NEXT[currentType] || 'action';

            // Split at cursor position
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);

            if (active && active.el) {
                // Get text after cursor
                const afterRange = document.createRange();
                afterRange.setStart(range.endContainer, range.endOffset);
                afterRange.setEndAfter(active.el.lastChild || active.el);
                const afterText = afterRange.toString();

                // Remove text after cursor from current line
                afterRange.deleteContents();

                // Create new line
                const newDiv = this._createElementDiv(nextType, afterText);
                active.el.after(newDiv);

                // Place cursor at start of new line
                const newRange = document.createRange();
                if (newDiv.childNodes.length > 0) {
                    newRange.setStart(newDiv.childNodes[0], 0);
                } else {
                    newDiv.appendChild(document.createTextNode(''));
                    newRange.setStart(newDiv.childNodes[0], 0);
                }
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
            }

            this._onInput();
            this._updateToolbar();
            return;
        }

        // Backspace at start of empty line: reset to action, then delete
        if (e.key === 'Backspace') {
            const active = this.getActiveElement();
            if (!active) return;
            const text = (active.el.textContent || '').trim();
            const sel = window.getSelection();
            const range = sel.rangeCount ? sel.getRangeAt(0) : null;
            const atStart = range && range.startOffset === 0 && range.collapsed;

            if (text === '' && active.type !== 'action') {
                // First backspace on empty non-action: reset to action
                e.preventDefault();
                this._applyType(active.el, 'action');
                this._onInput();
                this._updateToolbar();
                return;
            }

            if (text === '' && active.type === 'action' && active.el.previousElementSibling) {
                // Second backspace on empty action: delete the line, move cursor to end of previous
                e.preventDefault();
                const prev = active.el.previousElementSibling;
                active.el.remove();
                // Place cursor at end of previous element
                const newRange = document.createRange();
                if (prev.childNodes.length > 0) {
                    const lastChild = prev.childNodes[prev.childNodes.length - 1];
                    newRange.setStart(lastChild, lastChild.textContent.length);
                } else {
                    prev.appendChild(document.createTextNode(''));
                    newRange.setStart(prev.childNodes[0], 0);
                }
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
                this._onInput();
                this._updateToolbar();
                return;
            }

            // Backspace at start of non-empty line: merge with previous
            if (atStart && active.el.previousElementSibling) {
                e.preventDefault();
                const prev = active.el.previousElementSibling;
                const prevText = prev.textContent || '';
                const curText = active.el.textContent || '';
                prev.textContent = prevText + curText;
                active.el.remove();
                // Place cursor at the join point
                const newRange = document.createRange();
                if (prev.childNodes.length > 0) {
                    newRange.setStart(prev.childNodes[0], prevText.length);
                }
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
                this._onInput();
                this._updateToolbar();
                return;
            }
        }
    }

    _onPaste(e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (!text) return;

        // If pasting multi-line content, parse it as Fountain and insert elements
        const lines = text.split('\n');
        if (lines.length > 1) {
            const elements = parseFountainToElements(text);
            const active = this.getActiveElement();
            let insertAfter = active ? active.el : this.surface.lastElementChild;

            for (const el of elements) {
                if (el.type === 'blank') {
                    const div = this._createElementDiv('action', '');
                    div.innerHTML = '<br>';
                    if (insertAfter) {
                        insertAfter.after(div);
                    } else {
                        this.surface.appendChild(div);
                    }
                    insertAfter = div;
                } else {
                    const div = this._createElementDiv(el.type, el.text);
                    if (insertAfter) {
                        insertAfter.after(div);
                    } else {
                        this.surface.appendChild(div);
                    }
                    insertAfter = div;
                }
            }
            this._onInput();
        } else {
            // Single-line paste: insert at cursor
            document.execCommand('insertText', false, text);
        }
    }
}

// Export for use in app.js
window.FountainEditor = FountainEditor;
window.parseFountainToElements = parseFountainToElements;
