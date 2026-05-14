#!/usr/bin/env node

const baseUrl = (process.env.SMOKE_BASE_URL || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const accessKey = process.env.SMOKE_ACCESS_KEY || process.env.APP_SECRET;
let sessionToken = '';

if (!accessKey) {
    console.error('Set SMOKE_ACCESS_KEY or APP_SECRET before running the private deployment smoke test.');
    process.exit(1);
}

async function request(path, { auth = true, expected, method = 'GET', body } = {}) {
    const headers = {};
    if (auth && sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (expected !== undefined && res.status !== expected) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path} expected ${expected}, got ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
}

async function main() {
    console.log(`Smoke testing ${baseUrl}`);

    const health = await request('/health', { auth: false, expected: 200 });
    const healthJson = await health.json();
    if (!healthJson.ok) throw new Error('/health did not return ok=true');
    console.log('ok /health');

    await request('/api/projects', { auth: false, expected: 401 });
    console.log('ok unauthenticated /api/projects rejected');

    const sessionRes = await request('/api/auth/session', {
        auth: false,
        method: 'POST',
        expected: 200,
        body: { accessKey }
    });
    const session = await sessionRes.json();
    if (!session.token || !session.expiresAt) throw new Error('/api/auth/session did not return a session token');
    sessionToken = session.token;
    console.log('ok session unlock');

    const projectsRes = await request('/api/projects', { expected: 200 });
    const projectsJson = await projectsRes.json();
    if (!Array.isArray(projectsJson.projects)) throw new Error('/api/projects did not return a projects array');
    if (!projectsJson.pagination || typeof projectsJson.pagination.total !== 'number') {
        throw new Error('/api/projects did not return pagination metadata');
    }
    console.log('ok authenticated /api/projects');

    const createdRes = await request('/api/projects', { method: 'POST', expected: 201 });
    const created = await createdRes.json();
    if (!/^\d{13,14}$/.test(created.id || '')) throw new Error('Created project did not return a timestamp id');
    console.log(`ok project create (${created.id})`);

    await request(`/api/projects/${created.id}`, { expected: 200 });
    console.log('ok project read');

    await request(`/api/export/docx/${created.id}?stage=pitch`, { expected: 400 });
    console.log('ok export route returns clean 400 for incomplete project');

    await request(`/api/projects/${created.id}`, { method: 'DELETE', expected: 200 });
    console.log('ok project cleanup');

    console.log('Private deployment smoke test passed.');
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
