/**
 * scripts/lib/prod_sync.js — pull-backup and explicit per-project push over the API.
 *
 * The design decision behind this file (2026-08-09, Carsten accepted): there is NO
 * continuous two-way sync between a laptop and prod. Two writers on the same JSON
 * files is the silent-200 family this project keeps paying for. What exists
 * instead is exactly two verbs, both explicit, both PAT-authenticated:
 *
 *   pullAll  — `npm run backup:prod`: fetch every project the token can see and
 *              mirror it under <dir>/latest/, plus a dated snapshot under
 *              <dir>/snapshots/<iso>/. Records a manifest with each project's
 *              content hash AT PULL TIME. Read-only against prod.
 *   pushOne  — `npm run push:prod -- <projectId>`: upload ONE project from
 *              <dir>/latest/ (or --file). REFUSES if prod's copy has changed since
 *              the manifest's hash — i.e. since your last pull — unless --force.
 *              Never creates a project; never touches anything but that one id.
 *
 * Why the hash and not a timestamp: projects carry no reliable "updated" stamp
 * (dozens of writers, none of which is a clock), and a hash of the whole record is
 * exactly the question being asked — "is prod still what I last saw?".
 *
 * Whose projects: an ordinary token pulls its owner's projects (`/api/projects`).
 * An ADMIN token pulls everyone's through `/api/maintenance/projects` — the one
 * read-only elevation in the codebase (see routes/projects.js). `--mine` forces
 * the narrow scope. Push always goes through `PUT /api/projects/:id`, so it can
 * only ever write a project the token's owner owns; an admin restoring someone
 * else's project is deliberately not a thing this tool does.
 *
 * Everything the CLI wrappers do is in here as functions that take a base URL, so
 * the route harness can drive the real behaviour against a real server
 * (test/prod_sync.test.js) — no live prod call in any test.
 *
 * `fetch` is Node's global (>= 18); `fetchImpl` is injectable for tests only.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

class RemoteError extends Error {
    constructor(status, message, body) {
        super(message);
        this.name = 'RemoteError';
        this.status = status;
        this.body = body;
    }
}

/** A refusal is not a failure: the tool declined to do something on purpose. */
class Refusal extends Error {
    constructor(code, message, detail = {}) {
        super(message);
        this.name = 'Refusal';
        this.code = code;
        Object.assign(this, detail);
    }
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** The hash the manifest records and the push compares: the whole record, as JSON. */
function projectHash(project) {
    return sha256(JSON.stringify(project));
}

function normaliseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

async function api(base, token, pathname, { method = 'GET', body } = {}, fetchImpl = fetch) {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${base}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!res.ok) {
        const message = json?.error || (text ? text.slice(0, 200) : `HTTP ${res.status}`);
        throw new RemoteError(res.status, `${method} ${pathname} → ${res.status}: ${message}`, json);
    }
    return json;
}

/**
 * Who is this token, and is it an admin? `/api/me` is session-only by design, so
 * the token's owner is read from `/api/usage` (its rollup carries `owner`) and
 * admin standing from whether `/api/admin/overview` admits it.
 */
async function probe(base, token, fetchImpl) {
    const usage = await api(base, token, '/api/usage', {}, fetchImpl); // 401 here = bad token
    let admin = false;
    try {
        await api(base, token, '/api/admin/overview', {}, fetchImpl);
        admin = true;
    } catch (err) {
        if (!(err instanceof RemoteError) || err.status !== 403) throw err;
    }
    return { owner: usage.owner || null, admin };
}

function latestDir(dir) { return path.join(dir, 'latest'); }
function projectsDir(dir) { return path.join(latestDir(dir), 'projects'); }
function manifestPath(dir) { return path.join(dir, 'manifest.json'); }

async function readManifest(dir) {
    try {
        const parsed = JSON.parse(await fs.readFile(manifestPath(dir), 'utf-8'));
        if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') return parsed;
    } catch {}
    return null;
}

async function writeJsonAtomic(target, value) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, target);
}

function isoStamp(d = new Date()) {
    return d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

/**
 * Pull every project the token can see into <dir>.
 *
 * Returns { scope, by, pulled, added, changed, unchanged, removed, snapshotDir }.
 * `removed` = ids present in the previous manifest but not on prod now; their files
 * are dropped from latest/ (it is a mirror) but survive in every earlier snapshot.
 */
async function pullAll({ url, token, dir, mine = false, snapshot = true, log = () => {}, fetchImpl = fetch, now = () => new Date() } = {}) {
    const base = normaliseUrl(url);
    if (!base) throw new Error('A base URL is required (PAGEONE_URL or --url).');
    if (!token) throw new Error('A personal access token is required (PAGEONE_TOKEN or --token). Mint one in Settings → Access Tokens.');
    if (!dir) throw new Error('A backup directory is required.');

    const who = await probe(base, token, fetchImpl);
    const scope = who.admin && !mine ? 'everyone' : 'mine';
    log(`Signed in as ${who.owner || '(no email)'}${who.admin ? ' (admin)' : ''} — pulling ${scope === 'everyone' ? "everyone's" : 'your'} projects from ${base}`);

    const listing = scope === 'everyone'
        ? (await api(base, token, '/api/maintenance/projects', {}, fetchImpl)).projects
        : (await api(base, token, '/api/projects', {}, fetchImpl)).projects;

    const previous = await readManifest(dir);
    const pulledAt = now().toISOString();
    const manifest = { version: 1, url: base, pulledAt, by: who.owner, scope, projects: {} };
    const summary = { scope, by: who.owner, pulled: 0, added: [], changed: [], unchanged: [], removed: [], snapshotDir: null };

    await fs.mkdir(projectsDir(dir), { recursive: true });
    for (const item of listing) {
        const id = String(item.id);
        const project = scope === 'everyone'
            ? await api(base, token, `/api/maintenance/projects/${encodeURIComponent(id)}`, {}, fetchImpl)
            : await api(base, token, `/api/projects/${encodeURIComponent(id)}`, {}, fetchImpl);
        const hash = projectHash(project);
        await writeJsonAtomic(path.join(projectsDir(dir), `${id}.json`), project);
        manifest.projects[id] = {
            title: project.title || item.title || '(untitled)',
            owner: String(project.owner || '').trim().toLowerCase() || null,
            sha256: hash,
            pulledAt
        };
        summary.pulled += 1;
        const before = previous?.projects?.[id];
        if (!before) summary.added.push(id);
        else if (before.sha256 !== hash) summary.changed.push(id);
        else summary.unchanged.push(id);
    }

    // Mirror semantics for latest/: anything we did not just pull is gone from prod
    // (or out of this token's scope) — drop it here; snapshots keep history.
    for (const file of await fs.readdir(projectsDir(dir))) {
        if (!file.endsWith('.json')) continue;
        const id = file.replace(/\.json$/, '');
        if (manifest.projects[id]) continue;
        await fs.unlink(path.join(projectsDir(dir), file));
        if (previous?.projects?.[id]) summary.removed.push(id);
    }

    await writeJsonAtomic(manifestPath(dir), manifest);

    if (snapshot) {
        const snapDir = path.join(dir, 'snapshots', isoStamp(now()));
        await fs.mkdir(path.join(snapDir, 'projects'), { recursive: true });
        for (const id of Object.keys(manifest.projects)) {
            await fs.copyFile(path.join(projectsDir(dir), `${id}.json`), path.join(snapDir, 'projects', `${id}.json`));
        }
        await writeJsonAtomic(path.join(snapDir, 'manifest.json'), manifest);
        summary.snapshotDir = snapDir;
    }

    log(`Pulled ${summary.pulled} project(s): ${summary.added.length} new, ${summary.changed.length} changed, ${summary.unchanged.length} unchanged, ${summary.removed.length} gone from prod.`);
    if (summary.snapshotDir) log(`Snapshot: ${summary.snapshotDir}`);
    return summary;
}

/**
 * Push one project. Refuses (throws Refusal) when:
 *   NEVER_PULLED       — no manifest entry for this id and not --force
 *   CHANGED_ON_REMOTE  — prod's hash ≠ the manifest's hash and not --force
 *   NOT_ON_REMOTE      — prod 404s (not yours, or deleted): push never creates
 *   LOCAL_MISSING      — no local file to push
 * Returns { pushed: true, projectId, before, after } or { pushed: false, code: 'UNCHANGED' }.
 *
 * ⚠️ `PUT /api/projects/:id` merges `data` shallowly (top-level keys), so a key that
 * was DELETED locally survives on prod. That is the server's contract for every
 * client save and this tool does not fight it; a push restores and overwrites, it
 * does not prune. `id` and `owner` are pinned server-side and ignored if sent.
 */
async function pushOne({ url, token, dir, projectId, file = null, force = false, log = () => {}, fetchImpl = fetch, now = () => new Date() } = {}) {
    const base = normaliseUrl(url);
    if (!base) throw new Error('A base URL is required (PAGEONE_URL or --url).');
    if (!token) throw new Error('A personal access token is required (PAGEONE_TOKEN or --token).');
    const id = String(projectId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error(`"${projectId}" is not a project id (a numeric timestamp).`);

    const localPath = file ? path.resolve(file) : path.join(projectsDir(dir), `${id}.json`);
    let local;
    try {
        local = JSON.parse(await fs.readFile(localPath, 'utf-8'));
    } catch (err) {
        throw new Refusal('LOCAL_MISSING', `No local copy at ${localPath} (${err.code || err.message}). Run backup:prod first, or pass --file.`);
    }
    if (String(local.id || id) !== id) {
        throw new Refusal('ID_MISMATCH', `${localPath} is project ${local.id}, not ${id}. Refusing to push one project's contents into another's id.`);
    }

    const manifest = await readManifest(dir);
    const entry = manifest?.projects?.[id] || null;
    if (!entry && !force) {
        throw new Refusal('NEVER_PULLED', `Project ${id} is not in the manifest — you have never pulled it, so there is nothing to compare prod against. Run backup:prod first, or --force to push blind.`);
    }

    let remote;
    try {
        remote = await api(base, token, `/api/projects/${encodeURIComponent(id)}`, {}, fetchImpl);
    } catch (err) {
        if (err instanceof RemoteError && err.status === 404) {
            throw new Refusal('NOT_ON_REMOTE', `Prod has no project ${id} for this token (deleted, or not yours). Push never creates a project.`);
        }
        throw err;
    }
    const remoteHash = projectHash(remote);
    const localHash = projectHash(local);

    if (entry && remoteHash !== entry.sha256 && !force) {
        throw new Refusal('CHANGED_ON_REMOTE',
            `Prod's copy of ${id} ("${remote.title}") has changed since your last pull (${entry.pulledAt}). Run backup:prod to see the current state, or --force to overwrite it.`,
            { pulledAt: entry.pulledAt, remoteTitle: remote.title });
    }
    if (localHash === remoteHash) {
        log(`Project ${id} is identical on prod — nothing to push.`);
        return { pushed: false, code: 'UNCHANGED', projectId: id };
    }

    log(`Pushing ${id} ("${local.title}") to ${base}${force ? ' (forced)' : ''}…`);
    const updated = await api(base, token, `/api/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { title: local.title, data: local.data || {}, skipSnapshots: true }
    }, fetchImpl);

    // Re-read prod so the manifest and latest/ describe what is there now.
    const after = await api(base, token, `/api/projects/${encodeURIComponent(id)}`, {}, fetchImpl);
    if (dir) {
        await writeJsonAtomic(path.join(projectsDir(dir), `${id}.json`), after);
        const next = manifest || { version: 1, url: base, pulledAt: null, by: null, scope: 'mine', projects: {} };
        next.projects[id] = {
            title: after.title || '(untitled)',
            owner: String(after.owner || '').trim().toLowerCase() || null,
            sha256: projectHash(after),
            pulledAt: now().toISOString()
        };
        await writeJsonAtomic(manifestPath(dir), next);
    }
    log(`Pushed ${id}. Prod now at ${projectHash(after).slice(0, 12)}…`);
    return { pushed: true, projectId: id, before: remoteHash, after: projectHash(after), updatedTitle: updated?.title };
}

module.exports = { pullAll, pushOne, probe, projectHash, readManifest, RemoteError, Refusal, _paths: { latestDir, projectsDir, manifestPath } };
