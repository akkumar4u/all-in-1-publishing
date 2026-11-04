# Bulk dashboard — setup (owner, once) and daily use

## 1. The Google Sheet bridge (about 5 minutes)
1. Open your Google Sheet → **Extensions → Apps Script** (or script.google.com → your project).
2. Delete the old code, paste **`apps-script/Code.gs`** from this repo. Check `SPREADSHEET_ID` at the top (it is pre-filled with the sheet id found in your old script — change it if you use another sheet).
3. In the function list pick **`addUserHelper`**, replace `NAME` with your name inside it, press **Run** (allow the permissions), then **View → Execution log** and copy the **token**. Repeat for each teammate with their own name — one token per person.
4. **Deploy → New deployment → Web app** · Execute as **Me** · Who has access **Anyone** → Deploy → copy the URL that ends in **/exec**.
   (Already deployed before? **Deploy → Manage deployments → ✎ → Version: New version → Deploy** keeps the same URL.)
5. The first save creates three tabs by itself: **Tickets** (one row per ticket), **Content** (the full generated page — leave it alone), **History** (who did what, when).

The old secret from the previous script is not used any more. It was written in a file that was shared, so do not reuse it anywhere.

If the dashboard says **Invalid token**: run **`showTokens`** and compare with what is in ⚙ Settings (copy it again, whole, no spaces). If the log says "No tokens saved yet", `addUserHelper` was not run with a real name (or `addUser` was run directly) — run it again.
Quick alternative without running anything: Apps Script → ⚙ Project Settings → Script properties → Add property `TOKENS` = `{"choose-a-long-random-text":"Your Name"}` (exact JSON, double quotes) and use that text as the token.

## 2. In the extension
Side panel → **Bulk dashboard ↗** → **⚙ Settings** → paste the /exec URL and your token → **Test connection** → Save.
Teammates do the same with their own token (give them the URL + their token privately, e.g. in a message — never in the repo).

## 3. Daily use
1. Paste ticket numbers (one per line, up to 30) → **Fetch tickets**. Keep Salesforce and Google logged in in this Chrome. Tickets run one after another.
2. Click a ticket to review: page title, slug, meta title / description (60 / 160 limits), template, parent, the content (preview or HTML), every check and warning.
   Something wrong in the doc? Fix the doc, then **Re-fetch**.
3. **Approve** if it is right.
4. **Draft in WordPress** (VRP pages): the extension opens the site's new-page editor, fills it, runs the page check and saves it as a **draft** only when every check passed. It never publishes. Open the draft link, look, and publish by hand.
   Select several tickets → **Draft selected** to do them one after another (keep the dashboard tab open).
5. The Sheet always has the latest status, links and timings.

## What is and is not covered (v1.7.0)
- Fetch + review + Sheet: VRP, Landing, Comparison tickets (Blog / Hub / other types save the ticket details only).
- Draft button: VRP pages only. Landing / Comparison need the banner-image step — use the side panel for those for now.
- You must be logged in to the dealer's WordPress in this Chrome for Draft.
- Tickets whose subject says neither "new" nor "used" show an error (parent unknown) and cannot be drafted until fixed.

## Taking someone's access away
Apps Script → run **`removeUserHelper`** after putting their name inside it. Their token stops working immediately.
