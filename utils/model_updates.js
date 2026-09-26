/**
 * Automatic model updates — new models and current prices, from sources that agree.
 *
 * WHY THIS EXISTS. Adding a model used to be a form: id, name, two prices, a source
 * URL, typed by hand, because "no provider API exposes pricing" (2026-08-22). That is
 * still true of the models APIs. But three OTHER places publish prices in a shape a
 * program can read, and on 2026-09-25 all three agreed on every model PageOne runs:
 *
 *   - Anthropic's pricing page — first-party, served as a markdown table
 *   - OpenRouter's public models endpoint — JSON, no key, includes cache-read rates
 *   - LiteLLM's community price table — JSON on GitHub, ids match Anthropic's exactly
 *
 * THE ONE RULE: a price is written only when TWO INDEPENDENT SOURCES AGREE. Agreement
 * across the two third-party tables, or either of them and the first-party page,
 * gets written with both sources named on the row. A disagreement is never resolved
 * by picking one — it is reported as a conflict for the admin, with every value.
 * That rule is what makes auto-ADDING a model safe: the failure the registry was
 * built to end is a row at $0.00 that spends real money and reports nothing.
 *
 * WHAT IS AUTOMATIC: adding the newest model of each family (Opus, Sonnet, Haiku,
 * Fable; Gemini Pro, Flash, Flash-Lite) when it has an agreed price and no source
 * calls it retired · updating a registered row's price when the agreed price moved ·
 * merging rows and successor links from the bundled registry.
 *
 * WHAT IS NEVER AUTOMATIC: Verify (spends money) · moving stage defaults or Auto to a
 * successor (changes what writers get) · touching a row the admin added themselves
 * (openai-compatible) · touching a row edited today · touching any Verify result ·
 * enabling or disabling a row. The UI asks; the admin clicks.
 *
 * Sources can lag a launch by a day, so a brand-new model shows up as "known to a
 * provider, no agreed price yet" for a while rather than being added at $0.00.
 * Batch, fast-mode and thinking variants carry a `:suffix` on OpenRouter and are
 * dropped — PageOne must never post to a batch endpoint by accident.
 *
 * Env: MODEL_UPDATES=off skips the boot-time check (the route harness sets it, so no
 * test ever touches the network). MODEL_UPDATES_FIXTURE_DIR=<dir> reads the three
 * source payloads from files instead of fetching — that is how the route tests run
 * the real reconcile against a real harness server.
 */
const fs = require('fs');
const path = require('path');
const modelRegistry = require('./model_registry');

const SOURCES = {
    anthropicDocs: {
        name: 'anthropic-docs',
        url: 'https://platform.claude.com/docs/en/about-claude/pricing',
        firstParty: true,
        fixture: 'anthropic-pricing.md'
    },
    openrouter: {
        name: 'openrouter',
        url: 'https://openrouter.ai/api/v1/models',
        firstParty: false,
        fixture: 'openrouter.json'
    },
    litellm: {
        name: 'litellm',
        url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
        firstParty: false,
        fixture: 'litellm.json'
    }
};

const STATE_FILENAME = 'model-updates.json';
const FETCH_TIMEOUT_MS = 15_000;

// Only chat models PageOne can actually run. Mythos is limited-availability and is
// excluded on purpose: an auto-added row nobody can use would fail Verify honestly,
// but "we added a model you cannot have" is noise, not information.
const CLAUDE_ELIGIBLE = /^claude-(opus|sonnet|haiku|fable)-\d+(?:-\d+)?$/;
const GEMINI_ELIGIBLE = /^gemini-\d+(?:\.\d+)?-(pro|flash)(-lite)?(-preview)?$/;

function todayIso(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

// ─── Parsers: each returns Map<pageoneId, { inputPerMTok, outputPerMTok, provider, label?, retired?, limited? }>

/** OpenRouter: `anthropic/claude-opus-5.5` → `claude-opus-5-5`; `google/gemini-3.6-flash` → `gemini-3.6-flash`. */
function parseOpenRouter(payload) {
    const out = new Map();
    for (const row of payload?.data || []) {
        const id = String(row?.id || '');
        if (id.includes(':')) continue; // :batch / :fast / :thinking variants
        let pageoneId = null;
        let provider = null;
        if (id.startsWith('anthropic/claude-')) {
            pageoneId = id.slice('anthropic/'.length).replace(/\./g, '-');
            provider = 'anthropic';
        } else if (id.startsWith('google/gemini-')) {
            pageoneId = id.slice('google/'.length);
            provider = 'gemini';
        } else {
            continue;
        }
        const input = Number(row?.pricing?.prompt);
        const output = Number(row?.pricing?.completion);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        const label = String(row?.name || '').replace(/^(Anthropic|Google):\s*/i, '').trim() || null;
        out.set(pageoneId, { inputPerMTok: round4(input * 1e6), outputPerMTok: round4(output * 1e6), provider, label });
    }
    return out;
}

/** LiteLLM: `claude-opus-5-5` as-is; `gemini/gemini-3.6-flash` → `gemini-3.6-flash`. Chat mode only. */
function parseLiteLLM(payload, { now = Date.now() } = {}) {
    const out = new Map();
    const today = todayIso(now);
    for (const [key, row] of Object.entries(payload || {})) {
        if (!row || typeof row !== 'object') continue;
        if (row.mode && row.mode !== 'chat') continue;
        let pageoneId = null;
        let provider = null;
        if (/^claude-/.test(key) && !key.includes('/')) {
            pageoneId = key;
            provider = 'anthropic';
        } else if (key.startsWith('gemini/gemini-')) {
            pageoneId = key.slice('gemini/'.length);
            provider = 'gemini';
        } else {
            continue;
        }
        const input = Number(row.input_cost_per_token);
        const output = Number(row.output_cost_per_token);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        const retired = Boolean(row.deprecation_date && String(row.deprecation_date) <= today);
        out.set(pageoneId, { inputPerMTok: round4(input * 1e6), outputPerMTok: round4(output * 1e6), provider, retired });
    }
    return out;
}

/** Anthropic's docs page: `| Claude Opus 5.5 | $4 / MTok | … | $20 / MTok |` — first column name → id. */
function parseAnthropicDocs(markdown) {
    const out = new Map();
    const lines = String(markdown || '').split('\n');
    for (const line of lines) {
        if (!/^\|\s*Claude /.test(line)) continue;
        const cells = line.split('|').map(c => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length - 1);
        if (cells.length < 6) continue;
        const nameCell = cells[0];
        const name = nameCell.replace(/\s*\(.*$/, '').trim(); // drop "(retired…)" / "(limited availability…)"
        if (!/^Claude [A-Za-z]+ \d+(\.\d+)?$/.test(name)) continue;
        const id = 'claude-' + name.slice('Claude '.length).toLowerCase().replace(/\s+/g, '-').replace(/\./g, '-');
        const money = cell => {
            const m = String(cell).match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok/);
            return m ? Number(m[1]) : null;
        };
        const input = money(cells[1]);
        const output = money(cells[cells.length - 1]);
        if (input === null || output === null) continue;
        out.set(id, {
            inputPerMTok: input,
            outputPerMTok: output,
            provider: 'anthropic',
            label: name,
            retired: /retired/i.test(nameCell),
            limited: /limited availability/i.test(nameCell)
        });
    }
    return out;
}

// ─── Matching and agreement

/** A source id matches a registry id exactly, or a dated registry id (`claude-haiku-4-5-20251001`). */
function matchRegistryId(sourceId, registryIds) {
    if (registryIds.includes(sourceId)) return sourceId;
    const dated = registryIds.find(id => id.startsWith(`${sourceId}-`) && /^\d{8}$/.test(id.slice(sourceId.length + 1)));
    return dated || null;
}

function pricesAgree(a, b) {
    const tol = (x, y) => Math.abs(x - y) <= Math.max(0.005, 0.01 * Math.max(Math.abs(x), Math.abs(y)));
    return tol(a.inputPerMTok, b.inputPerMTok) && tol(a.outputPerMTok, b.outputPerMTok);
}

/**
 * For every id any source knows: the agreed price (≥2 sources within tolerance, the
 * first-party value preferred when it is among them), or a conflict listing every
 * value. Ids known to one source only are `single` — not enough to write anything.
 */
function agreePrices(parsed) {
    const names = Object.keys(parsed);
    const ids = new Set();
    for (const name of names) for (const id of parsed[name].keys()) ids.add(id);
    const agreed = new Map();
    const conflicts = new Map();
    const single = new Map();
    for (const id of ids) {
        const votes = names.filter(n => parsed[n].has(id)).map(n => ({ source: n, ...parsed[n].get(id) }));
        if (votes.length < 2) {
            single.set(id, votes[0]);
            continue;
        }
        let best = null;
        for (const v of votes) {
            const agreeing = votes.filter(w => pricesAgree(v, w));
            if (agreeing.length >= 2 && (!best || agreeing.length > best.agreeing.length || (agreeing.length === best.agreeing.length && SOURCES_BY_NAME[v.source]?.firstParty))) {
                best = { value: v, agreeing };
            }
        }
        const meta = {
            provider: votes.find(v => v.provider)?.provider || null,
            label: votes.find(v => v.source === 'openrouter' && v.label)?.label || votes.find(v => v.label)?.label || null,
            retired: votes.some(v => v.retired),
            limited: votes.some(v => v.limited)
        };
        if (best) {
            const firstParty = best.agreeing.find(v => SOURCES_BY_NAME[v.source]?.firstParty) || best.value;
            agreed.set(id, {
                ...meta,
                inputPerMTok: firstParty.inputPerMTok,
                outputPerMTok: firstParty.outputPerMTok,
                agreedBy: best.agreeing.map(v => v.source)
            });
        } else {
            conflicts.set(id, { ...meta, values: votes.map(v => ({ source: v.source, inputPerMTok: v.inputPerMTok, outputPerMTok: v.outputPerMTok })) });
        }
    }
    return { agreed, conflicts, single };
}

const SOURCES_BY_NAME = Object.fromEntries(Object.values(SOURCES).map(s => [s.name, s]));

// ─── Families and versions: "newest of each family" is what gets added

function familyOf(id) {
    let m = id.match(CLAUDE_ELIGIBLE);
    if (m) return `claude-${m[1]}`;
    m = id.match(GEMINI_ELIGIBLE);
    if (m) return `gemini-${m[1]}${m[2] || ''}`;
    return null;
}

/** Sortable version key: [major, minor, 0 for GA / -1 for preview]. */
function versionKey(id) {
    let m = id.match(/^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/);
    if (m) return [Number(m[1]), Number(m[2] || 0), 0];
    m = id.match(/^gemini-(\d+)(?:\.(\d+))?-(?:pro|flash)(?:-lite)?(-preview)?$/);
    if (m) return [Number(m[1]), Number(m[2] || 0), m[3] ? -1 : 0];
    return [0, 0, 0];
}

function compareVersions(a, b) {
    const ka = versionKey(a);
    const kb = versionKey(b);
    for (let i = 0; i < 3; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
}

function isEligibleForAutoAdd(id, info) {
    if (!(CLAUDE_ELIGIBLE.test(id) || GEMINI_ELIGIBLE.test(id))) return false;
    if (info?.retired || info?.limited) return false;
    return true;
}

function deriveLabel(id, info) {
    if (info?.label) return info.label;
    const m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/);
    if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
    const g = id.match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash)(-lite)?(-preview)?$/);
    if (g) return `Gemini ${g[1]} ${g[2][0].toUpperCase()}${g[2].slice(1)}${g[3] ? '-Lite' : ''}`;
    return id;
}

// ─── The plan

/**
 * Pure: registry rows + bundle rows + parsed sources + the stage defaults → what
 * should change. Nothing here writes. `applyPlan` does, and the tests assert on this.
 */
function reconcile({ registry, bundle, parsed, stageModels = {}, now = Date.now() }) {
    const today = todayIso(now);
    const models = registry?.models || [];
    const recommended = registry?.recommended || {};
    const registryIds = models.map(m => m.id);
    const bundleRows = bundle?.models || [];
    const bundleById = new Map(bundleRows.map(r => [r.id, r]));
    const { agreed, conflicts, single } = agreePrices(parsed);

    // 1. Rows the bundle has and the deployment lacks — curated, priced, trusted.
    const bundleAdds = bundleRows.filter(r => !registryIds.includes(r.id));

    // 2. Newest model of each family with an agreed price, not registered, not retired.
    const newestPerFamily = new Map();
    for (const [id, info] of agreed) {
        if (!isEligibleForAutoAdd(id, info)) continue;
        const fam = familyOf(id);
        const current = newestPerFamily.get(fam);
        if (!current || compareVersions(id, current) > 0) newestPerFamily.set(fam, id);
    }
    const added = [];
    const knownIds = [...registryIds, ...bundleAdds.map(r => r.id)];
    for (const id of newestPerFamily.values()) {
        if (matchRegistryId(id, knownIds)) continue;
        const bundleRow = bundleById.get(id);
        if (bundleRow?.deprecated) continue;
        const info = agreed.get(id);
        added.push({
            id,
            label: deriveLabel(id, info),
            provider: info.provider,
            baseUrl: null,
            enabled: true,
            deprecated: false,
            pricing: {
                inputPerMTok: info.inputPerMTok,
                outputPerMTok: info.outputPerMTok,
                source: `auto: ${info.agreedBy.join(' + ')} agree — ${info.agreedBy.map(n => SOURCES_BY_NAME[n].url).join(' ; ')}`,
                checkedAt: today,
                note: `Added automatically on ${today}. Unverified until Verify is run.`
            }
        });
    }

    // 3. Registered rows whose agreed price moved. A row checked or edited today wins.
    const priced = [];
    for (const [sourceId, info] of agreed) {
        const id = matchRegistryId(sourceId, registryIds);
        if (!id) continue;
        const row = models.find(m => m.id === id);
        if (!row || row.provider === 'openai-compatible') continue;
        const current = { inputPerMTok: Number(row.pricing?.inputPerMTok), outputPerMTok: Number(row.pricing?.outputPerMTok) };
        if (Number.isFinite(current.inputPerMTok) && Number.isFinite(current.outputPerMTok) && pricesAgree(current, info)) continue;
        if (row.pricing?.checkedAt === today) {
            priced.push({ id, from: current, to: { inputPerMTok: info.inputPerMTok, outputPerMTok: info.outputPerMTok }, agreedBy: info.agreedBy, skipped: 'edited today' });
            continue;
        }
        priced.push({ id, from: current, to: { inputPerMTok: info.inputPerMTok, outputPerMTok: info.outputPerMTok }, agreedBy: info.agreedBy });
    }

    // 4. Successor links and deprecations the bundle knows and the deployment does not.
    const successorPatches = [];
    for (const row of models) {
        const b = bundleById.get(row.id);
        if (!b) continue;
        const patch = {};
        if (b.successor && row.successor !== b.successor) patch.successor = b.successor;
        if (b.deprecated && !row.deprecated) patch.deprecated = true;
        if (Object.keys(patch).length) successorPatches.push({ id: row.id, patch });
    }

    // 5. Retirements to OFFER: a row with a successor that is (or will be) registered,
    //    and is in use somewhere — by a stage default or by Auto.
    const afterIds = new Set([...registryIds, ...bundleAdds.map(r => r.id), ...added.map(r => r.id)]);
    const successorOf = id => successorPatches.find(p => p.id === id)?.patch.successor || models.find(m => m.id === id)?.successor || null;
    const retirements = [];
    for (const row of models) {
        const successor = successorOf(row.id);
        if (!successor || !afterIds.has(successor)) continue;
        const stages = Object.entries(stageModels).filter(([, v]) => v === row.id).map(([k]) => k);
        const autoStages = Object.entries(recommended).filter(([, v]) => v === row.id).map(([k]) => k);
        if (!stages.length && !autoStages.length) continue;
        retirements.push({ id: row.id, label: row.label, successor, successorLabel: models.find(m => m.id === successor)?.label || added.find(a => a.id === successor)?.label || bundleById.get(successor)?.label || successor, deprecated: Boolean(row.deprecated || bundleById.get(row.id)?.deprecated), stages, autoStages });
    }

    // 6. Conflicts worth the admin's eye: registered rows, or would-be adds.
    const conflictList = [];
    for (const [sourceId, info] of conflicts) {
        const id = matchRegistryId(sourceId, registryIds);
        if (!id && !isEligibleForAutoAdd(sourceId, info)) continue;
        conflictList.push({ id: id || sourceId, registered: Boolean(id), values: info.values });
    }

    // 7. Known to one source only AND newer than anything its family already has —
    //    informational; the reason a launch-day model is not added yet. An old id one
    //    table still lists is not news.
    const newestKnownInFamily = (fam) => {
        const candidates = [...knownIds, ...added.map(r => r.id)].filter(id => familyOf(id) === fam || familyOf(id.replace(/-\d{8}$/, '')) === fam);
        return candidates.sort((a, b) => compareVersions(b.replace(/-\d{8}$/, ''), a.replace(/-\d{8}$/, '')))[0] || null;
    };
    const awaitingSecondSource = [...single.entries()]
        .filter(([id, info]) => isEligibleForAutoAdd(id, info) && !matchRegistryId(id, knownIds))
        .filter(([id]) => {
            const best = newestKnownInFamily(familyOf(id));
            return !best || compareVersions(id, best.replace(/-\d{8}$/, '')) > 0;
        })
        .map(([id, info]) => ({ id, source: info.source }));

    return { today, bundleAdds, added, priced, successorPatches, retirements, conflicts: conflictList, awaitingSecondSource };
}

// ─── Fetching

async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'text/markdown, application/json, text/plain;q=0.9, */*;q=0.1', 'User-Agent': 'PageOne model-updates' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

/** The three payloads, parsed. A failed source is reported, not thrown — two are enough. */
async function loadSources({ fetchImpl, fixtureDir = process.env.MODEL_UPDATES_FIXTURE_DIR || null, now = Date.now() } = {}) {
    const status = {};
    const parsed = {};
    const read = async (src) => {
        if (fixtureDir) return fs.readFileSync(path.join(fixtureDir, src.fixture), 'utf8');
        return fetchText(src.url, { fetchImpl });
    };
    const jobs = Object.values(SOURCES).map(async (src) => {
        try {
            const text = await read(src);
            if (src.name === 'anthropic-docs') parsed[src.name] = parseAnthropicDocs(text);
            else if (src.name === 'openrouter') parsed[src.name] = parseOpenRouter(JSON.parse(text));
            else if (src.name === 'litellm') parsed[src.name] = parseLiteLLM(JSON.parse(text), { now });
            status[src.name] = { ok: true, models: parsed[src.name].size };
        } catch (err) {
            status[src.name] = { ok: false, error: err.message };
        }
    });
    await Promise.all(jobs);
    return { parsed, status };
}

// ─── State: what the admin has not yet seen

function statePath() {
    return path.join(path.dirname(modelRegistry._storePath()), STATE_FILENAME);
}

function emptyState() {
    return { lastCheckedAt: null, sources: {}, unacknowledged: { added: [], priced: [] }, conflicts: [], awaitingSecondSource: [], lastApplied: null };
}

function readState() {
    try {
        const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
        return { ...emptyState(), ...raw, unacknowledged: { ...emptyState().unacknowledged, ...(raw.unacknowledged || {}) } };
    } catch {
        return emptyState();
    }
}

function writeState(state) {
    const target = statePath();
    const tmp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return state;
}

// ─── Apply

async function applyPlan(plan, { by = 'auto-update' } = {}) {
    const applied = { added: [], priced: [], successorPatches: [], errors: [] };
    for (const row of [...plan.bundleAdds, ...plan.added]) {
        try {
            await modelRegistry.addModel(row, { by });
            applied.added.push(row.id);
        } catch (err) {
            applied.errors.push({ id: row.id, error: err.message });
        }
    }
    for (const change of plan.priced) {
        if (change.skipped) continue;
        try {
            await modelRegistry.updateModel(change.id, {
                pricing: {
                    inputPerMTok: change.to.inputPerMTok,
                    outputPerMTok: change.to.outputPerMTok,
                    source: `auto: ${change.agreedBy.join(' + ')} agree — ${change.agreedBy.map(n => SOURCES_BY_NAME[n].url).join(' ; ')}`,
                    checkedAt: plan.today
                }
            });
            applied.priced.push(change.id);
        } catch (err) {
            applied.errors.push({ id: change.id, error: err.message });
        }
    }
    for (const { id, patch } of plan.successorPatches) {
        try {
            await modelRegistry.updateModel(id, patch);
            applied.successorPatches.push(id);
        } catch (err) {
            applied.errors.push({ id, error: err.message });
        }
    }
    return applied;
}

/**
 * The whole job: load sources → reconcile against the live registry and the bundle →
 * apply the automatic part → remember what the admin has not acknowledged yet.
 */
async function checkForUpdates({ apply = true, fetchImpl, fixtureDir, stageModels = {}, now = Date.now(), by = 'auto-update' } = {}) {
    await modelRegistry.ensureSeeded?.();
    const { parsed, status } = await loadSources({ fetchImpl, fixtureDir, now });
    const usable = Object.values(status).filter(s => s.ok).length;
    const registry = { models: modelRegistry.listModels(), recommended: modelRegistry.getRecommended() };
    let bundle = { models: [] };
    try { bundle = JSON.parse(fs.readFileSync(modelRegistry._bundledPath, 'utf8')); } catch {}
    const plan = usable >= 2
        ? reconcile({ registry, bundle, parsed, stageModels, now })
        : { ...reconcile({ registry, bundle, parsed: {}, stageModels, now }), added: [], priced: [], conflicts: [], awaitingSecondSource: [], tooFewSources: true };
    const applied = apply ? await applyPlan(plan, { by }) : null;

    const state = readState();
    state.lastCheckedAt = new Date(now).toISOString();
    state.sources = status;
    state.tooFewSources = Boolean(plan.tooFewSources);
    if (applied) {
        const seen = new Set(state.unacknowledged.added.map(a => a.id));
        for (const id of applied.added) {
            if (seen.has(id)) continue;
            const row = [...plan.bundleAdds, ...plan.added].find(r => r.id === id);
            state.unacknowledged.added.push({ id, label: row?.label || id, at: state.lastCheckedAt, from: plan.bundleAdds.some(r => r.id === id) ? 'bundle' : 'sources' });
        }
        const seenPriced = new Set(state.unacknowledged.priced.map(p => p.id));
        for (const change of plan.priced) {
            if (change.skipped || seenPriced.has(change.id)) continue;
            state.unacknowledged.priced.push({ id: change.id, from: change.from, to: change.to, at: state.lastCheckedAt });
        }
        state.lastApplied = { at: state.lastCheckedAt, ...applied };
    }
    state.conflicts = plan.conflicts;
    state.awaitingSecondSource = plan.awaitingSecondSource;
    writeState(state);
    return { plan, applied, state };
}

function acknowledge() {
    const state = readState();
    state.unacknowledged = { added: [], priced: [] };
    return writeState(state);
}

/** Retirements to offer right now, from the live registry and the given stage defaults. */
function currentRetirements({ stageModels = {} } = {}) {
    const registry = { models: modelRegistry.listModels(), recommended: modelRegistry.getRecommended() };
    return reconcile({ registry, bundle: { models: [] }, parsed: {}, stageModels }).retirements;
}

module.exports = {
    SOURCES,
    parseOpenRouter,
    parseLiteLLM,
    parseAnthropicDocs,
    matchRegistryId,
    agreePrices,
    reconcile,
    loadSources,
    applyPlan,
    checkForUpdates,
    acknowledge,
    readState,
    currentRetirements,
    familyOf,
    compareVersions,
    isEligibleForAutoAdd,
    _statePath: statePath
};
