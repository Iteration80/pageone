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
                    elements.push({ type: 'parenthetical', text: dline });
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
        this.externalToolbarSlot = opts.externalToolbarSlot || null;
        this._dirty = false;
        this._lastCleanText = '';

        // ─── Undo/redo ───────────────────────────────────────────────────────
        // The browser's native contenteditable undo only covers typing INSIDE a
        // block. Every structural operation here — Tab retype, Enter split,
        // Backspace merge, type change, multi-line paste — rewrites the DOM
        // directly, which either bypasses that stack or corrupts it. In a tool
        // people write in for hours, undo you cannot trust is a correctness
        // problem, not a convenience one. So we keep our own: a snapshot of the
        // the element structure plus caret position, taken BEFORE each structural op and
        // on the first keystroke of a typing run (so a burst of typing collapses
        // into one undo step rather than one per character).
        this._history = [];
        this._historyIndex = -1;
        this._typingRun = false;
        this._maxHistory = 200;

        // ─── SmartType ───────────────────────────────────────────────────────
        // Populated by the host via setSmartTypeLists(). The editor deliberately
        // knows nothing about projects — it is handed plain string lists.
        this._smartLists = { characters: [], locations: [], times: [], transitions: [] };
        this._suggestions = [];
        this._suggestionIndex = 0;

        // Build DOM
        this.container.innerHTML = '';

        // Toolbar (only if editable)
        if (!this.readOnly) {
            this.toolbar = this._buildToolbar();
            if (this.externalToolbarSlot) {
                this.externalToolbarSlot.innerHTML = '';
                this.externalToolbarSlot.appendChild(this.toolbar);
            } else {
                this.container.appendChild(this.toolbar);
            }
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
            this.surface.addEventListener('click', () => { this._hideSuggestions(); this._updateToolbar(); });
            this.surface.addEventListener('blur', () => setTimeout(() => this._hideSuggestions(), 120));
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

    /** Called by the host after loadFountain to start a clean undo history. */
    resetHistory() {
        const elements = this._snapshotElements();
        this._history = [{ elements, key: this._snapshotKey(elements), caret: null }];
        this._historyIndex = 0;
        this._typingRun = false;
        this._savedText = this._lastCleanText;
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
        // Toolbar/dropdown path needs its own snapshot. The ⌘1-6 and Tab paths have
        // already pushed one; _pushHistory dedupes identical text, so that collapses
        // to a single undo step rather than two.
        this._pushHistory();
        const oldType = active.type;
        const text = active.el.textContent;

        // Auto-wrap/unwrap parenthetical text
        if (type === 'parenthetical' && oldType !== 'parenthetical') {
            const stripped = text.replace(/^\s*\(?\s*/, '').replace(/\s*\)?\s*$/, '');
            if (stripped) active.el.textContent = `(${stripped})`;
        } else if (type !== 'parenthetical' && oldType === 'parenthetical') {
            const stripped = text.replace(/^\s*\(\s*/, '').replace(/\s*\)\s*$/, '');
            if (stripped) active.el.textContent = stripped;
        }

        this._applyType(active.el, type);
        this._onInput();
        this._updateToolbar();
    }

    /**
     * Hand the editor the lists SmartType completes from. Plain strings only —
     * the editor stays ignorant of where they came from.
     * @param {{characters?:string[], locations?:string[], times?:string[], transitions?:string[]}} lists
     */
    setSmartTypeLists(lists = {}) {
        const clean = (arr) => [...new Set((arr || [])
            .map(s => String(s || '').trim())
            .filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
        this._smartLists = {
            characters: clean(lists.characters),
            locations: clean(lists.locations),
            times: clean(lists.times),
            transitions: clean(lists.transitions),
        };
    }

    /**
     * The elements the current selection touches, as whole elements.
     *
     * Deliberately element-granular rather than character-granular. A screenplay
     * element is the smallest thing that can be revised and spliced back with valid
     * formatting — half an action paragraph rewritten in isolation cannot be
     * reassembled without guessing where the sentence boundary went, and a partial
     * character cue is not a thing at all. Selecting mid-paragraph therefore expands
     * to the whole paragraph, and the caller highlights what it is about to act on so
     * the writer sees the real scope before committing.
     *
     * @returns {{startIndex:number, endIndex:number, text:string, elements:{type:string,text:string}[]}|null}
     */
    getSelectionRange() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || sel.isCollapsed) return null;

        const owner = (node) => {
            let n = node;
            while (n && n.parentElement !== this.surface) n = n.parentElement;
            return (n && n.parentElement === this.surface) ? n : null;
        };
        const startEl = owner(sel.anchorNode);
        const endEl = owner(sel.focusNode);
        if (!startEl || !endEl) return null;

        const children = Array.from(this.surface.children);
        let a = children.indexOf(startEl);
        let b = children.indexOf(endEl);
        if (a === -1 || b === -1) return null;
        if (a > b) [a, b] = [b, a];

        const elements = children.slice(a, b + 1).map(div => ({
            type: div.getAttribute('data-element') || 'action',
            text: div.textContent || ''
        }));
        // Nothing to revise if the writer only grabbed blank lines.
        if (!elements.some(e => e.text.trim())) return null;

        return { startIndex: a, endIndex: b, elements, text: this._elementsToFountain(elements) };
    }

    /** Serialize a slice of elements the same way toFountain() serializes the whole. */
    _elementsToFountain(elements) {
        const scratch = document.createElement('div');
        for (const el of elements) {
            const div = this._createElementDiv(el.type, el.text);
            scratch.appendChild(div);
        }
        // Reuse toFountain by temporarily pointing it at the scratch surface, so the
        // fragment and the document can never drift in how they serialize.
        const realSurface = this.surface;
        this.surface = scratch;
        let out;
        try { out = this.toFountain(); } finally { this.surface = realSurface; }
        return out;
    }

    /** Paint the elements an operation is about to affect. */
    highlightRange(startIndex, endIndex) {
        this.clearHighlight();
        const children = Array.from(this.surface.children);
        for (let i = startIndex; i <= endIndex && i < children.length; i++) {
            children[i].classList.add('fe-selection-scope');
        }
    }

    clearHighlight() {
        this.surface.querySelectorAll('.fe-selection-scope')
            .forEach(el => el.classList.remove('fe-selection-scope'));
    }

    /**
     * Replace elements [startIndex..endIndex] with the parsed contents of `fountainText`.
     * Undoable like any other structural edit.
     */
    replaceRange(startIndex, endIndex, fountainText) {
        const children = Array.from(this.surface.children);
        if (startIndex < 0 || startIndex >= children.length) return false;
        const end = Math.min(endIndex, children.length - 1);

        this._endTypingRun();
        this._pushHistory();

        const parsed = parseFountainToElements(fountainText || '');
        const fragment = document.createDocumentFragment();
        for (const el of parsed) {
            const div = this._createElementDiv(el.type === 'blank' ? 'action' : el.type, el.text);
            if (el.type === 'blank') div.innerHTML = '<br>';
            fragment.appendChild(div);
        }

        // Capture the node AFTER the range as the insertion point before removing
        // anything — anchoring on the first removed node would leave nowhere to insert.
        const insertBefore = children[end + 1] || null;
        for (let i = startIndex; i <= end; i++) children[i].remove();
        this.surface.insertBefore(fragment, insertBefore);

        this.clearHighlight();
        this._onInput();
        this._updateToolbar();
        return true;
    }

    undo() {
        // Snapshots are taken BEFORE each operation, so the live document is normally
        // one step ahead of the top of the stack. Capture it now — otherwise undo
        // steps back past the edit you actually wanted to reverse, and redo has
        // nothing to return to. (Measured: type "NO", accept a SmartType completion,
        // ⌘Z — without this the document jumped all the way back to the loaded text.)
        this._captureLiveState();
        if (this._historyIndex <= 0) return false;
        this._historyIndex--;
        this._restoreSnapshot(this._history[this._historyIndex]);
        return true;
    }

    /** Record the current document as a history entry if it has drifted past the top. */
    _captureLiveState() {
        const elements = this._snapshotElements();
        const key = this._snapshotKey(elements);
        const top = this._history[this._historyIndex];
        if (top && top.key === key) return;
        this._history = this._history.slice(0, this._historyIndex + 1);
        this._history.push({ elements, key, caret: this._caretPosition() });
        if (this._history.length > this._maxHistory) this._history.shift();
        this._historyIndex = this._history.length - 1;
    }

    redo() {
        if (this._historyIndex < 0 || this._historyIndex >= this._history.length - 1) return false;
        this._historyIndex++;
        this._restoreSnapshot(this._history[this._historyIndex]);
        return true;
    }

    isDirty() {
        return this._dirty;
    }

    markClean() {
        this._dirty = false;
        this._lastCleanText = this.toFountain();
        this._savedText = this._lastCleanText;
    }

    destroy() {
        if (this._suggestBox) { this._suggestBox.remove(); this._suggestBox = null; }
        this.container.innerHTML = '';
        if (this.externalToolbarSlot) {
            this.externalToolbarSlot.innerHTML = '';
        }
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

    // ─── Undo/redo internals ─────────────────────────────────────────────────

    /** Where the caret is, as (element index, character offset) — survives a reload. */
    _caretPosition() {
        const active = this.getActiveElement();
        if (!active) return null;
        const index = Array.from(this.surface.children).indexOf(active.el);
        const sel = window.getSelection();
        let offset = 0;
        if (sel.rangeCount) {
            const range = sel.getRangeAt(0).cloneRange();
            range.selectNodeContents(active.el);
            range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
            offset = range.toString().length;
        }
        return { index, offset };
    }

    _setCaret(pos) {
        if (!pos) return;
        const el = this.surface.children[Math.min(pos.index, this.surface.children.length - 1)];
        if (!el) return;
        const node = el.firstChild || el.appendChild(document.createTextNode(''));
        const range = document.createRange();
        const max = (node.textContent || '').length;
        try {
            range.setStart(node, Math.min(pos.offset, max));
        } catch { range.setStart(el, 0); }
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /**
     * A snapshot is the element STRUCTURE — [{type, text}] — not serialized Fountain.
     *
     * Fountain is lossy for element type: a lone uppercase line is a character cue
     * only if a blank line precedes it and a non-blank line follows, so round-tripping
     * an in-progress edit through toFountain()/parse can silently reclassify it.
     * Measured: typing a new character cue, accepting a SmartType completion and
     * pressing ⌘Z produced a document with no character element at all. Undo must
     * restore what the writer had, not what the serializer could express.
     */
    _snapshotElements() {
        return Array.from(this.surface.children).map(div => ({
            type: div.getAttribute('data-element') || 'action',
            text: div.textContent || ''
        }));
    }

    _snapshotKey(elements) {
        return elements.map(e => `${e.type}\u0000${e.text}`).join('\u0001');
    }

    _restoreElements(elements) {
        this.surface.innerHTML = '';
        for (const el of elements) {
            const div = this._createElementDiv(el.type, el.text);
            if (!el.text) div.innerHTML = '<br>';
            this.surface.appendChild(div);
        }
    }

    /**
     * Record the state BEFORE a change. Called by every structural operation and
     * by the first keystroke of a typing run. Anything after the current index is
     * discarded — the normal branch-on-new-edit behaviour.
     */
    _pushHistory() {
        const elements = this._snapshotElements();
        const snapshot = { elements, key: this._snapshotKey(elements), caret: this._caretPosition() };
        // Don't stack identical states (e.g. Tab pressed twice with no text change).
        const prev = this._history[this._historyIndex];
        if (prev && prev.key === snapshot.key) {
            prev.caret = snapshot.caret;
            return;
        }
        this._history = this._history.slice(0, this._historyIndex + 1);
        this._history.push(snapshot);
        if (this._history.length > this._maxHistory) this._history.shift();
        this._historyIndex = this._history.length - 1;
    }

    /** Snapshot once per typing run, so a burst collapses into a single undo step. */
    _beginTypingRun() {
        if (this._typingRun) return;
        this._typingRun = true;
        this._pushHistory();
    }

    _endTypingRun() {
        this._typingRun = false;
    }

    _restoreSnapshot(snapshot) {
        if (!snapshot) return;
        this._restoreElements(snapshot.elements);
        this._setCaret(snapshot.caret);
        this._dirty = this.toFountain() !== this._lastCleanTextForDirty();
        if (this.onDirty) this.onDirty();
        this._updateToolbar();
        this._hideSuggestions();
    }

    /** The text the host last considered saved — undo must not report "clean" wrongly. */
    _lastCleanTextForDirty() {
        return this._savedText !== undefined ? this._savedText : this._lastCleanText;
    }

    // ─── SmartType internals ─────────────────────────────────────────────────

    /**
     * Which list applies to the element being typed in, and what prefix to match.
     * Scene headings are two-part: the location, then the time after the final " - ".
     */
    _suggestionContextFor(active) {
        if (!active) return null;
        const raw = (active.el.textContent || '');
        const text = raw.trimStart();

        if (active.type === 'character') {
            return { pool: this._smartLists.characters, prefix: text, replaceFrom: 0 };
        }
        if (active.type === 'transition') {
            return { pool: this._smartLists.transitions, prefix: text, replaceFrom: 0 };
        }
        if (active.type === 'scene-heading') {
            // After the last " - " we're choosing a time of day; before it, a location.
            const sep = raw.lastIndexOf(' - ');
            if (sep !== -1) {
                return { pool: this._smartLists.times, prefix: raw.slice(sep + 3), replaceFrom: sep + 3 };
            }
            const intExt = raw.match(/^\s*(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.)\s*/i);
            if (intExt) {
                return { pool: this._smartLists.locations, prefix: raw.slice(intExt[0].length), replaceFrom: intExt[0].length };
            }
            return { pool: ['INT. ', 'EXT. ', 'INT./EXT. '], prefix: raw, replaceFrom: 0 };
        }
        return null;
    }

    _refreshSuggestions() {
        const active = this.getActiveElement();
        const ctx = this._suggestionContextFor(active);
        if (!ctx || !ctx.pool.length) return this._hideSuggestions();

        const prefix = ctx.prefix.trim().toUpperCase();
        // An empty prefix offers the whole list — that is the point on a fresh
        // character cue, where retyping the name is the most repetitive act in the app.
        const matches = ctx.pool
            .filter(v => v.toUpperCase().startsWith(prefix))
            .filter(v => v.toUpperCase() !== prefix)
            .slice(0, 8);

        if (!matches.length) return this._hideSuggestions();
        this._suggestions = matches;
        this._suggestionIndex = 0;
        this._suggestionCtx = { el: active.el, replaceFrom: ctx.replaceFrom };
        this._renderSuggestions(active.el);
    }

    _renderSuggestions(anchorEl) {
        if (!this._suggestBox) {
            this._suggestBox = document.createElement('div');
            this._suggestBox.className = 'fe-smarttype';
            document.body.appendChild(this._suggestBox);
        }
        const box = this._suggestBox;
        box.innerHTML = '';
        this._suggestions.forEach((s, i) => {
            const item = document.createElement('div');
            item.className = 'fe-smarttype-item' + (i === this._suggestionIndex ? ' fe-smarttype-active' : '');
            item.textContent = s;
            item.addEventListener('mousedown', (e) => { e.preventDefault(); this._acceptSuggestion(i); });
            box.appendChild(item);
        });
        const rect = anchorEl.getBoundingClientRect();
        box.style.top = `${rect.bottom + window.scrollY + 2}px`;
        box.style.left = `${rect.left + window.scrollX}px`;
        box.classList.remove('hidden');
    }

    _hideSuggestions() {
        this._suggestions = [];
        this._suggestionCtx = null;
        if (this._suggestBox) this._suggestBox.classList.add('hidden');
    }

    _suggestionsOpen() {
        return this._suggestions.length > 0 && this._suggestBox && !this._suggestBox.classList.contains('hidden');
    }

    _acceptSuggestion(index) {
        const value = this._suggestions[index != null ? index : this._suggestionIndex];
        const ctx = this._suggestionCtx;
        if (!value || !ctx) return this._hideSuggestions();

        this._pushHistory();
        const el = ctx.el;
        const head = (el.textContent || '').slice(0, ctx.replaceFrom);
        el.textContent = head + value;
        this._hideSuggestions();

        // Caret to end of the completed text.
        const node = el.firstChild || el.appendChild(document.createTextNode(''));
        const range = document.createRange();
        range.setStart(node, (node.textContent || '').length);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        this._onInput();
        this._updateToolbar();
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
        // First keystroke of a run gets the snapshot; the rest of the burst rides on it.
        this._beginTypingRun();

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

        this._refreshSuggestions();
    }

    _onKeydown(e) {
        // ⌘Z / ⌘⇧Z (⌃ on Windows) — checked before everything else so nothing
        // downstream can swallow it.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            this._endTypingRun();
            if (e.shiftKey) this.redo(); else this.undo();
            return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
            e.preventDefault();
            this._endTypingRun();
            this.redo();
            return;
        }

        // SmartType owns the arrows, Enter, Tab and Escape WHILE its list is open —
        // it must be consulted before the Tab/Enter handlers below, or accepting a
        // completion would instead retype the element or split the line.
        if (this._suggestionsOpen()) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = this._suggestions.length;
                this._suggestionIndex = (this._suggestionIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
                this._renderSuggestions(this._suggestionCtx.el);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                this._acceptSuggestion();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this._hideSuggestions();
                return;
            }
        }

        // Cmd/Ctrl + 1-6: set element type
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
            const num = parseInt(e.key);
            if (num >= 1 && num <= 6) {
                e.preventDefault();
                this._endTypingRun();
                this._pushHistory();
                this.setElementType(FE_SHORTCUT_KEYS[num]);
                return;
            }
        }

        // Any structural key ends the current typing run and gets its own undo step.
        if (e.key === 'Tab' || e.key === 'Enter' || e.key === 'Backspace') {
            this._endTypingRun();
        }

        // Tab: cycle element type
        if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            const active = this.getActiveElement();
            if (!active) return;
            this._pushHistory();
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
            this._pushHistory();
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
                this._pushHistory();
                this._applyType(active.el, 'action');
                this._onInput();
                this._updateToolbar();
                return;
            }

            if (text === '' && active.type === 'action' && active.el.previousElementSibling) {
                // Second backspace on empty action: delete the line, move cursor to end of previous
                e.preventDefault();
                this._pushHistory();
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
                this._pushHistory();
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
        this._endTypingRun();
        this._pushHistory();

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
