function normalizeStageName(stageName) {
    return String(stageName || 'this stage').trim() || 'this stage';
}

function buildMemorySourceContract(stageName = 'this stage') {
    const label = normalizeStageName(stageName);
    return `## MEMORY AND SOURCE CONTRACT
For ${label}, interpret project memory in this order:
1. Current user notes/request: latest instruction, but do not silently contradict source canon.
2. Accepted divergences: approved departures from source canon; apply only within their stated scope.
3. Approved stage handoffs: binding downstream story state from prior approved stages.
4. Source bible and source references: canonical source facts, motifs, relationships, chronology, settings, and constraints.
5. Current stage output: editable work product; preserve it unless the user/source contract requires a change.

Rules:
- Treat compact memory snapshots as the current project state.
- Treat Source Bible, Source References, and relevant source document excerpts as source canon.
- If current user notes conflict with source canon and no accepted divergence covers the conflict, adapt conservatively and do not invent a new canon fact.
- Use approved handoffs to maintain continuity across stages; do not undo approved decisions unless the user explicitly asks.
- Prefer source-grounded specifics over generic invention. If the packet lacks support for a detail, keep the output neutral instead of adding unsupported canon.
- Preserve required output format and unrelated approved material.`;
}

function buildMemorySourceSystemInstruction(baseInstruction = '', stageName = 'this stage') {
    return [String(baseInstruction || '').trim(), buildMemorySourceContract(stageName)]
        .filter(Boolean)
        .join('\n\n');
}

function buildMemorySourcePromptBlock(knowledgeContext = '', stageName = 'this stage') {
    const context = String(knowledgeContext || '').trim();
    if (!context) return '';

    return `## PROJECT MEMORY AND SOURCE PACKET
Use this packet under the MEMORY AND SOURCE CONTRACT for ${normalizeStageName(stageName)}.

${context}
`;
}

module.exports = {
    buildMemorySourceContract,
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
};
