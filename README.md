# All in 1 Publishing — build repo
- `src/` — the Chrome extension (what you edit; load this folder in Chrome while developing).
- `build.mjs` — minifies `src/` into `dist/` (or a synced folder) and writes `build.json` (version + file hashes).
- `.github/workflows/build.yml` — builds on every push and copies the result into the shared Drive/Dropbox folder.
- `docs/SETUP_OWNER.md` — one-time setup. `docs/TEAMMATE_INSTALL.md` — the page you send to teammates.
- `apps-script/Code.gs` — the Google Sheet bridge for the Bulk dashboard. `docs/BULK_SETUP.md` — how to connect it and use the dashboard.

Private source and automated build pipeline for the All in 1 Publishing Chrome extension.
