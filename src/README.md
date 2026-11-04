# All in 1 Publishing by ak

> **Current version: 1.6.31 (zip v68).** What changed in each version, and what was fixed, is in **[CHANGELOG.md](CHANGELOG.md)** — read that first when you come back to this folder.
> Rule we follow: every new change = one new line in `CHANGELOG.md`, a version bump in `manifest.json`, and (if it adds a feature) a short entry in the table below.

## Feature map (where each feature lives)

| Feature | What it does | Files |
|---|---|---|
| Landing / Comparison / Blog from a Google Doc | Imports the Doc, cleans the HTML, fills WordPress | `hub_parser.js` (landing + comparison), `blog_parser.js` (blog), `hub_background.js`, `blog_background.js`, `pages/*.js` |
| **Skipped-content report** | Anything that looks like real copy but was left out of the page is listed in the popup after import (so nothing disappears silently) | `hub_parser.js`, `blog_parser.js`, `hub_popup.js`, `blog_popup.js` |
| Disclaimer switch | Disclaimer block is cut out of the article and currently NOT added (flip `BLOG_APPEND_DISCLAIMER` / `HUB_APPEND_DISCLAIMER` to `true` to add it again) | `blog_parser.js`, `hub_parser.js` |
| Image Library picker | Finds + downloads the image (landing/comparison **1400×500**, blog **1000×400**), alt text, optional "let me choose" | `images/img_popup.js`, `images/img_background.js` |
| Image upload | Landing/Comparison: uploaded + inserted in the Imagery row. Blog: uploaded, added at the very start of the post with alt text, and set as the **Featured image** | `hub_background.js`, `blog_background.js` |
| **Hub page Linking Code** | Copy-ready `<a href="/slug/">Anchor text</a>` to add on the hub page (only url + anchor text) | `hub_link.js`, `popup.html` |
| **Page type → Parent page** (landing) | 15 page types; reads the dealer site's pages from WordPress and pre-selects the best parent; always editable | `hub_parent.js`, `popup.html` |
| **Clear all button** | Top-right of the popup: wipes all saved data and reloads the popup blank | `clear_all.js`, `popup.html` |
| Salesforce ticket lookup | Finds the Doc link + website from a ticket | `salesforce/` |

## Limits to remember
- Nothing here was run against a live WordPress site by the assistant that wrote it — after each new version, test on ONE real page first.
- Parent list only contains **published** pages (public REST API); a draft/private parent needs "Other (type below)".
- Skipped-content report shows only copy-like lines (a `Note:` line, a link-only line). Field labels, comment markers and pasted code are removed silently by design.

---

A Chrome extension (Manifest V3) that combines two publishing tools into one popup:

- **Hub Pages** — generates templated DI Page Composer hub pages (Service & Parts, Make Research, Finance & Insurance) and fills them into WordPress automatically.
- **Google Doc Publishing** — imports a Google Doc and turns it into a **Comparison Page**, **Landing Page**, or **Blog Post**, cleaning the Doc's HTML and pushing it into WordPress.

This file explains how to use it, what it's good/bad at, and exactly what happens to your data — permission by permission.


## Where to edit (so a fix in one page never changes another)

| To change... | Edit only this file |
|---|---|
| Service & Parts hub content | `pages/service.js` |
| Make Research hub content | `pages/research.js` |
| Finance & Insurance hub content | `pages/finance.js` |
| Comparison Page content | `pages/comparison.js` |
| Landing Page content | `pages/landing.js` |
| Blog post (parsing, formatting, WordPress fill) | `blog_parser.js`, `blog_background.js`, `blog_popup.*` |

Each file in `pages/` is self-contained: it has its own private copies of every helper it uses (blog-feed row, URL cleaners, etc.), so editing one cannot affect the others. `core/hub-core.js` is only a lookup registry with no page content — leave it alone.

Still shared by design (change with care, test every page type afterwards): `hub_parser.js` (Google Doc parser used by Comparison and Landing), `hub_background.js` (the WordPress fill engine), and `hub_popup.js` (the Hub/Publishing form logic).


## Salesforce ticket lookup (Publishing tab)

Type a ticket number (e.g. `ST-02064125`) into the **Salesforce ticket** box on the Publishing tab and click **Find**. The extension:

1. opens Salesforce (`cars-commerce.lightning.force.com`) in a helper window using your normal logged-in session,
2. always opens the global search by clicking the header "Search..." button first (never types into some other search-looking field on the page), waits for the page to finish loading, then types the ticket number in the box that opened with real (trusted) keystrokes and checks that the box really contains the exact ticket number (retyping if a letter got lost), clicks the matching "Service Task" suggestion — Chrome will briefly show a "…is debugging this browser" bar in the helper window; that is expected and goes away when the lookup finishes (falls back to Enter / the results page if no suggestion appears),
3. reads the Google Doc link from the **Details** tab,
4. reads the website from the **Account** (hover card first, Account page as fallback),
5. fills the Google Doc URL and the WordPress Admin URL (`<website>/wp/wp-admin`) for Comparison, Landing and Blog, and — if "Run the import automatically" is ticked — clicks the matching Import button.

If Salesforce really shows a login page, the helper window stays open: log in, then click Find again. (Salesforce redirects a few times when it opens; the extension waits for that to finish before deciding.) If a ticket has several Google Docs you pick one from a list. Check the guessed WordPress Admin URL before filling WordPress.

Files (all in `salesforce/`, independent of the page templates and blog code):

| To change... | Edit |
|---|---|
| Salesforce address, field labels ("Account", "Website"), `/wp/wp-admin` path, timeouts | `sf_config.js` |
| How the Salesforce page is read (search box, Details tab, hover card) | `sf_page.js` |
| How the ticket is typed/clicked (real keystrokes + clicks) | `sf_search.js` |
| Order of steps / website + admin URL logic | `sf_background.js` |
| The card in the popup | `sf_popup.js`, `sf_popup.css`, and the `#sf-card` block in `popup.html` |

If a step fails, open **Lookup details** under the card — it lists what each step found, including exactly which element it clicked and typed into. If the header search box can't be found, the extension automatically opens Salesforce's search-results page by URL instead.

### Google Doc link: read from the ticket's Details field (any wording)

The Details text is different on every ticket (`Content Bank: <url>`, `Template: <url>`, a bare link, `Publish this document:` + link, `n/a`). The extension reads the whole Details field line by line, collects every Google Doc URL in it, and labels each by the words in front of it. The best guess is selected (Publish / Content Bank / unlabeled first, Template last). After **Find** a review panel appears where you can change the task type, the Google Doc (dropdown or paste your own), the website / WordPress admin URL, and the Group 1 box — then click **Apply to form**. If no link is found, open *Lookup details*: it prints the Details text that was read.

### Task type is worked out from the ticket subject

You only type the ticket number. The extension reads the ticket's **Subject** (and whether it is a **Group 1** ticket), works out the task type, and fills the right form:

| Subject says… | Task type | What happens |
|---|---|---|
| mentions *Enhancement* + *VRP* | Enhancement — VRP Enhancement | Uses the Lightning template and selects New Vehicles or Used Vehicles as parent from the subject. Imports the Doc title, slug and meta fields, then puts H2-led content in the Lightning VRP SEO Content editor. No banner image or blog row is added. |
| mentions *Enhancement* (+ *inventory*) or other Enhancement | Enhancement — Landing Page / Inventory Page Optimization | Identified and shown. No automatic flow yet. |
| *Service & Parts*, *Make Research*, *Finance & Insurance* | Hub Pages | Hub tab + hub type selected, admin URL filled (no Google Doc needed). Enter the brand name, then Generate Preview. |
| mentions *inventory* | Publishing — Inventory Page Creation | Identified and shown. No automatic flow yet. |
| *comparison* / *vs* | Publishing — Comparison | Doc + admin URL filled, import runs. |
| mentions *blog* | Publishing — Blog | Doc + admin URL filled, blog import runs. |
| anything else | Publishing — Landing Page | Doc + admin URL filled, import runs. |

**Group 1** tickets are mostly landing pages: if the subject does not mention blog, it is a Landing Page. The card shows the task type and a "Group 1 ticket" box — both detected automatically and both correctable before you click **Apply to form**. If the subject can't be read, nothing is guessed: you pick the type. (Group 1's contact form, instead of the blog feed, is not built yet.)

| To change… | Edit |
|---|---|
| The subject keywords / which subject = which task type | `salesforce/sf_classify.js` |
| The label names read from the ticket (Subject / Account), the "Group 1" text pattern | `salesforce/sf_config.js` |


---

## 1. Install

1. Unzip the extension folder.
2. Go to `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked**, select the unzipped folder.
4. Pin the extension so it's easy to open from the toolbar.

There's no build step — it's plain HTML/CSS/JS, no bundler, no external dependencies.

---

## 2. How to use it

Open the popup. There are two tabs at the top: **Hub Pages** and **Google Doc Publishing**.

### Hub Pages tab (templated, no Google Doc)

1. Pick a **Hub Type**: Service & Parts Information, Make Research, or Finance & Insurance Information.
2. Enter the **Brand Name** (required) and **WordPress Admin URL** (required).
3. Optionally expand **Optional URL overrides** to set specials/cross-link URLs — sensible defaults are used if you skip them.
4. Click **Generate Preview** — this builds the page title, slug, template, meta fields, and each content section entirely from the brand name (no external content source).
5. Click **Open WordPress & Fill Basics** — this opens (or reuses) a `post-new.php?post_type=page` tab on your WordPress site and auto-fills the title, slug, template, and each row's content using the DI Page Composer's own "Add Row" UI.
6. Each content section also has its own **Copy** button, in case a specific row needs to be pasted in by hand.

### Google Doc Publishing tab

Pick a **Publishing Type**:

- **Comparison Page** / **Landing Page Publishing** — both pull from a Google Doc and build a DI Page Composer page (Page Title row + Full Width WYSIWYG row(s) + a "More from %%di_name%%" blog-feed row). Landing Page skips the comparison table.
- **Blog Publishing** — pulls from a Google Doc and queues a standard WordPress blog post draft.

Steps (Comparison/Landing):

1. Paste the **Google Doc URL** and click **Import from Google Doc**. The Doc must be shared as "Anyone with the link → Viewer" — the extension fetches it directly, unauthenticated.
2. Review/adjust the auto-filled **Page Title**, **Page Slug**, **Meta Title/Description**, CTA button URLs, and the **Content HTML** box (this is what lands in the WYSIWYG row — CTA buttons get inserted right after the first paragraph automatically).
3. Enter the **WordPress Admin URL**, click **Generate Preview**, then **Open WordPress & Fill Basics**.

For Comparison Pages, the generated row order is: **Page Title (H1) → blank Full Width WYSIWYG → Direct Compare Data Row → Full Width WYSIWYG content → remaining standard rows**. The comparison table's first data row is written with explicit `<strong>` tags, and CTA buttons found in the Google Doc are carried into the content row.

Steps (Blog Publishing):

1. Paste the **Google Doc URL** and **WordPress Admin URL**, click **Import & queue blog post**.
2. Review the imported title/slug/meta/category/tags and the cleaned content HTML.
3. Click **Open & fill WordPress** — opens `post-new.php` and fills the post.

### A note on "Content Review" / section selection

Both Publishing flows show you the parsed sections before anything is sent to WordPress — nothing is auto-published without you seeing it first and clicking the "fill" step yourself.

---

## 3. Pros

- **Nothing leaves your machine except two places you already trust**: the Google Doc you paste in, and the WordPress site whose admin URL you paste in. There's no third-party backend, no analytics, no telemetry (see §5).
- **Fast, consistent hub-page generation** — the Service/Research/Finance templates remove a lot of manual, repetitive WordPress data entry.
- **Handles Google Docs' messy export HTML** — strips Docs' own CSS/classes, converts its per-bullet `<ul>` fragments back into real lists (matched by Docs' own list ID so genuinely separate lists don't get merged into one), and recovers bold/italic that Docs encodes via CSS classes rather than `<strong>`/`<em>` tags.
- **You see everything before it's sent** — a preview step for both Hub Pages and Google Doc Publishing, plus per-section Copy buttons as a manual fallback if auto-fill misses something.
- **Front-matter/metadata filtering** — Post/Meta Title, Meta Description, Keywords, CTA button code, "Recommended Internal Links," Notes, and comment threads are automatically excluded from the body content, so a Doc built from a brief template doesn't dump its whole header block into the page.

## 4. Cons / limitations

- **Fragile to WordPress admin UI changes.** The "fill" step works by locating specific buttons/fields/labels in the DI Page Composer and classic editor DOM. If a theme/plugin update changes that markup, auto-fill can silently stop finding the right field — always check the preview against what actually lands in WordPress.
- **Google Docs export format is not officially documented/stable.** Detection of list identity (`lst-kix_...` class) and bold/italic (CSS class → `font-weight`/`font-style`) is based on how Docs happens to export today. If Google changes its export markup, these heuristics can break again without warning.
- **No undo.** Once you click "Fill," WordPress fields are overwritten directly in the open tab. If you don't review the preview first, a bad import (wrong doc, mis-parsed section) can land straight into a real post/page.
- **`chrome.debugger` dependency for Hub Pages.** Reliably clicking DI Page Composer's "Add Row" popups needs a browser-trusted click, which only `chrome.debugger` can send. See §5 for what this means in practice.
- **Single global admin URL.** Both tools share the same saved WordPress admin URL (`chrome.storage.local`) — convenient for one site, but you have to re-paste it each time if you manage more than one WordPress install.
- **No retry/queue for network failures.** If the Google Doc fetch or WordPress page load fails, you re-run the import — there's no background retry.

## 5. Data handling / "any data leaks?"

Below is what each permission in `manifest.json` is used for, and where your data actually goes. There is no remote server owned by this extension's author(s) — everything is either local to the browser or a direct request to a domain you explicitly gave it (Google Docs, your WordPress site).

| Permission | Used for | Data exposure |
|---|---|---|
| `storage` | Saves the WordPress admin URL (`chrome.storage.local`) and the queued blog draft (`chrome.storage.session`) | Stays on-device, in the browser profile's extension storage. Not synced, not sent anywhere. `session` storage clears when the browser closes. |
| `tabs` | Opens/finds the WordPress `post-new.php` tab to fill | Only reads tab URLs to detect "is this the right WordPress admin tab" — doesn't read tab content. |
| `scripting` | Injects the fill logic into the WordPress admin tab (`chrome.scripting.executeScript`) | Runs only against the WordPress origin you supplied, only after you click a "Fill"/"Open WordPress" button. |
| `clipboardWrite` | Powers the per-section **Copy** button | Only writes to your own clipboard when you click Copy; nothing is read from the clipboard. |
| `debugger` | Sends a **browser-trusted mouse click** (via `Input.dispatchMouseEvent`) so DI Page Composer's "Add Row" popup opens the same way it would from a real click | This is the most powerful permission here — it's the same API Chrome DevTools uses, and Chrome shows a visible **"[Extension] started debugging this browser"** bar whenever it's attached. It's attached only for the duration of the fill step on the WordPress tab you opened, then detached (`detachDebugger`) when the fill finishes or fails. It is not used to read passwords, cookies, or any other tab's data — only to dispatch the specific mouse-click sequence needed to open the row-type popup. Worth knowing this permission exists and is broad in *capability* even though the code's actual use of it is narrow. |
| `offscreen` | Runs an offscreen document (`parser.html`) so the background service worker can use `DOMParser` to clean the Google Doc's HTML | Purely local HTML parsing — no network access from that document itself. |
| `host_permissions: http://*/*, https://*/*` | Broad — required because the extension has to work on *your* WordPress site, whatever its domain is, plus `docs.google.com` for the export fetch | This is the main thing worth being deliberate about: as written, the extension *could* be granted the technical ability to run scripts/fetch on any site, not just the ones you use it on. In practice `scripting.executeScript` is only called against the admin URL tab you opened deliberately, and `fetch()` is only called against `docs.google.com/document/d/.../export` — but a broad host permission is what Chrome shows in the install/permissions prompt, and it's fair to want a narrower one. If you want to reduce this: you could hard-code your dealership/agency's actual WordPress domain(s) into `host_permissions` instead of `http://*/*` / `https://*/*`, trading flexibility (works on any site) for a tighter, auditable permission grant. |

**External network calls the extension makes, in total:**
1. `GET https://docs.google.com/document/d/<id>/export?format=html` — fetches the Doc's exported HTML. The Doc must be link-shared (Viewer), so **anyone with the link can read it** — that's a property of how you shared the Doc, not something this extension adds, but worth remembering since the extension's fetch is unauthenticated (no Google login involved).
2. Requests to your own **WordPress admin URL** (opened as a normal browser tab, using your existing logged-in WordPress session) — standard admin-area page loads, not a hidden background request.

There is **no analytics, telemetry, crash reporting, or third-party endpoint** anywhere in the code — I read through `manifest.json`, both background scripts, both parsers, and both popup scripts, and the only `fetch`/`chrome.tabs.create` calls are the two above.

**Practical recommendations:**
- Don't paste a Google Doc URL for a doc you don't intend to be link-shareable — the extension has no way to fetch a Doc that requires sign-in.
- Only use "Open WordPress & Fill Basics" / "Open & fill WordPress" on a WordPress admin tab you trust — `scripting`+`debugger` together mean the extension can interact with whatever page is in that tab.
- If you manage multiple WordPress sites from one browser profile, re-check the **WordPress Admin URL** field each time — it's a single shared saved value, so it's easy to accidentally reuse the wrong site's saved URL after switching projects.
- Consider narrowing `host_permissions` in `manifest.json` to your actual site(s) if you want the Chrome permissions prompt to reflect exactly what you use this for.
