# Owner setup (you, once)

## 1. Repository
1. Create a **private** GitHub repo and push this folder (`src/`, `build.mjs`, `package.json`, `.github/`, `docs/`).
2. Run `npm install` once locally and commit the generated `package-lock.json`.
3. Teammates are NOT added to the repo. They only see the shared folder.

## 2. The shared folder
1. Create an empty folder in Google Drive or Dropbox, e.g. **All-in-1-Publishing**. Nothing else may live in it —
   the publish step deletes files there that are not part of the build.
2. Share it with the teammates as **view only**. Send them `docs/TEAMMATE_INSTALL.md`.

## 3. Let GitHub fill that folder (automatic updates)
1. Install rclone on your computer and run `rclone config` → create a remote (name it e.g. `team`) for Google Drive or Dropbox
   and sign in. Check: `rclone lsd team:`.
2. Make the config one line: PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$(rclone config file | Select-Object -Last 1)"))`
   — macOS/Linux `base64 -w0 "$(rclone config file | tail -1)"`.
3. GitHub repo → *Settings → Secrets and variables → Actions*:
   - **Secret** `RCLONE_CONF` = that base64 text
   - **Variable** `RCLONE_DEST` = `team:All-in-1-Publishing` (remote name : folder path)
4. Push to `main` (or Actions → *Build and publish* → *Run workflow*). Within a few minutes the folder holds the new build.

If the upload starts failing weeks later, the sign-in inside `rclone.conf` expired: redo steps 1–3.

## No GitHub upload? Do it from your computer
`npm install` once, then after each change: `node build.mjs --out "<path of your synced folder>"`.
The extension in your own browser should be loaded from `src/` (no minify, no auto-update) while you develop.

## Every release
Bump `"version"` in `src/manifest.json`, add a line to `src/CHANGELOG.md`, push. The build adds the git id to the version
label, so every push is recognised as new even if the number is the same.

## What this protects (and what it does not)
Teammates get minified JavaScript, never the repo, the comments or the history. Minified code can still be read by a
determined person, so treat it as "not casually copyable", not as secret.
