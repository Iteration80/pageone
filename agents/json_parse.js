function stripJsonFences(text) {
    return String(text || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function extractJsonFromText(text, schema) {
    const source = stripJsonFences(text);
    const expectedOpen = schema?.type === 'array' ? '[' : schema?.type === 'object' ? '{' : null;
    const start = expectedOpen ? source.indexOf(expectedOpen) : source.search(/[\{\[]/);
    if (start < 0) return source;

    const open = expectedOpen || source[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === open) {
            depth += 1;
        } else if (ch === close) {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }

    return source.slice(start);
}

function removeTrailingCommasOutsideStrings(text) {
    let output = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            output += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            output += ch;
            continue;
        }

        if (ch === ',') {
            let nextIndex = i + 1;
            while (/\s/.test(text[nextIndex] || '')) nextIndex += 1;
            if (text[nextIndex] === '}' || text[nextIndex] === ']') continue;
        }
        output += ch;
    }

    return output;
}

function insertMissingCommasBetweenValues(text) {
    let output = '';
    let inString = false;
    let escaped = false;
    let valueEnded = false;

    const insertCommaBeforePendingWhitespace = () => {
        const trimmedLength = output.replace(/\s+$/u, '').length;
        output = `${output.slice(0, trimmedLength)},${output.slice(trimmedLength)}`;
    };

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (inString) {
            output += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
                valueEnded = true;
            }
            continue;
        }

        if (/\s/.test(ch)) {
            output += ch;
            continue;
        }

        if (valueEnded && (ch === '{' || ch === '[' || ch === '"')) {
            insertCommaBeforePendingWhitespace();
            valueEnded = false;
        }

        output += ch;

        if (ch === '"') {
            inString = true;
            escaped = false;
            valueEnded = false;
        } else if (ch === '}' || ch === ']') {
            valueEnded = true;
        } else if (ch === ',' || ch === ':' || ch === '{' || ch === '[') {
            valueEnded = false;
        } else {
            valueEnded = false;
        }
    }

    return output;
}

/**
 * Salvage a response that was cut off mid-value by the output token cap.
 *
 * The failure this exists for: gemini-3.1-pro re-emits the same array element until
 * it runs out of tokens — on a one-character Stage 3 revision it returned the same
 * character 93 times, 131KB, dying as "Unterminated string in JSON" at a consistent
 * offset. That consistency is what got it recorded as a deterministic size problem in
 * July; it is really an unterminated array. Bounding the array in the schema is the
 * obvious fix and the API rejects `maxItems` in that position, so instead: the
 * elements BEFORE the cut are complete and correct, and throwing them away turns a
 * recoverable response into a failed revision.
 *
 * So rewind to the last structural boundary that was reached outside a string, then
 * close whatever is still open. Deliberately conservative — it only ever truncates
 * and closes, never invents a value, so the worst case is fewer elements than the
 * model intended, which the surgical merge already handles.
 */
function closeTruncatedJson(text) {
    const stack = [];
    let inString = false;
    let escaped = false;
    let lastBoundary = -1;
    let boundaryStack = null;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); continue; }
        if (ch === '}' || ch === ']') {
            stack.pop();
            // A completed element: everything up to here is parseable once closed.
            lastBoundary = i;
            boundaryStack = [...stack];
        }
    }

    if (!stack.length) return text;              // nothing open — not truncated
    if (lastBoundary < 0 || !boundaryStack?.length) return text; // nothing to salvage
    return text.slice(0, lastBoundary + 1) + boundaryStack.reverse().join('');
}

function parseJsonWithRepair(text, { schema, label = 'AI response' } = {}) {
    const candidate = extractJsonFromText(text, schema);
    const attempts = [
        candidate,
        removeTrailingCommasOutsideStrings(candidate),
        removeTrailingCommasOutsideStrings(insertMissingCommasBetweenValues(candidate)),
        // Last resort, so a well-formed response is never reshaped by it.
        removeTrailingCommasOutsideStrings(closeTruncatedJson(candidate))
    ];
    let firstError = null;

    for (const attempt of [...new Set(attempts)]) {
        try {
            return JSON.parse(attempt);
        } catch (error) {
            if (!firstError) firstError = error;
        }
    }

    const error = new Error(`${label} was not valid JSON after repair: ${firstError?.message || 'unknown parse error'}`);
    error.cause = firstError;
    throw error;
}

module.exports = {
    extractJsonFromText,
    parseJsonWithRepair,
    closeTruncatedJson,
    removeTrailingCommasOutsideStrings,
    insertMissingCommasBetweenValues
};
