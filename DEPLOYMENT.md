# PageOne Private Tester Deployment

## Target

Deploy the existing Node/Express app as a private tester build on Railway, with persistent server storage and a shared access key.

## Railway Setup

1. Create a Railway project from the GitHub repository.
2. Use the default start command:

```sh
npm start
```

3. Add a Railway Volume for persistent app data.
4. Set `DATA_ROOT` to the mounted volume path.
5. Set environment variables:

```sh
APP_SECRET=<long random shared access key>
DATA_ROOT=<railway volume mount path>
GEMINI_API_KEY=<server-side Gemini key>
ANTHROPIC_API_KEY=<server-side Anthropic key, if used>
GEMINI_MODEL=gemini-3-flash-preview
NODE_VERSION=20
```

## Smoke Checks

- `GET /health` returns `{ "ok": true }` plus the deployed commit/deployment id when Railway exposes them.
- `GET /api/projects` without `APP_SECRET` returns `401`.
- `GET /api/projects` with `Authorization: Bearer <APP_SECRET>` returns projects.
- Create a project, restart/redeploy, and confirm the project still appears.
- Import a small `.fountain` script and export one PDF/DOCX before inviting a tester.

## Notes

- API keys are deployment-managed when `APP_SECRET` is set. The Settings modal still supports model selection, but key entry is hidden unless `ALLOW_RUNTIME_API_KEYS=true`.
- Existing local projects are not uploaded automatically. Copy only selected project JSON files into the deployed `DATA_ROOT/projects` directory when you are ready.
- Cloudflare can point a subdomain to the Railway app after the Railway URL passes smoke tests.
