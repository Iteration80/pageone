# PageOne Private Tester Deployment

## Target

Deploy the existing Node/Express app as a private tester build on Railway, with persistent server storage and layered access control.

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
DATA_ROOT=<railway volume mount path>
GEMINI_API_KEY=<server-side Gemini key>
ANTHROPIC_API_KEY=<server-side Anthropic key, if used>
GEMINI_MODEL=gemini-3-flash-preview
NODE_VERSION=20

# Auth
APP_SECRET=<long random break-glass/admin key>
GOOGLE_CLIENT_ID=<google oauth web client id>
GOOGLE_CLIENT_SECRET=<google oauth web client secret>
ALLOWED_EMAILS=writer@example.com,admin@example.com
SESSION_SECRET=<long random session signing key, optional if APP_SECRET is set>
OAUTH_BASE_URL=https://pageone-production.up.railway.app
```

`OAUTH_BASE_URL` is optional when Railway forwards stable `x-forwarded-proto` and `x-forwarded-host` headers, but setting it pins the Google callback redirect URI to the exact public origin.

## Authentication Modes

- Google mode: active when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ALLOWED_EMAILS` are all set. Testers sign in through Google, then PageOne checks the signed session cookie plus the current allowlist on every request.
- Break-glass mode: `APP_SECRET` always remains valid for API access through `X-Api-Key: <APP_SECRET>` or `Authorization: Bearer <APP_SECRET>`, including when Google mode is active.
- Open mode: if neither Google auth nor `APP_SECRET` is configured, the app runs unauthenticated for local development.

Keep `APP_SECRET` set on Railway even when Google is the primary login path. It is the recovery path for maintenance endpoints, CLI checks, and OAuth misconfiguration.

## Smoke Checks

- `GET /health` returns `{ "ok": true }` plus the deployed commit/deployment id when Railway exposes them.
- `GET /api/auth-config` returns `{"mode":"google","googleEnabled":true}` for the tester build.
- `GET /api/projects` without a Google session or `APP_SECRET` returns `401`.
- `GET /api/projects` with `Authorization: Bearer <APP_SECRET>` returns projects.
- Click "Sign in with Google" using an allowlisted account and confirm the hub loads, then open Settings and confirm the account panel shows the signed-in email.
- Remove or change a test email in `ALLOWED_EMAILS`, redeploy/restart, and confirm that account loses access on the next request.
- Create a project, restart/redeploy, and confirm the project still appears.
- Import a small `.fountain` script and export one PDF/DOCX before inviting a tester.

## Notes

- API keys are deployment-managed when `APP_SECRET` is set. The Settings modal still supports model selection, but key entry is hidden unless `ALLOW_RUNTIME_API_KEYS=true`.
- Existing local projects are not uploaded automatically. Copy only selected project JSON files into the deployed `DATA_ROOT/projects` directory when you are ready.
- Cloudflare can point a subdomain to the Railway app after the Railway URL passes smoke tests.
