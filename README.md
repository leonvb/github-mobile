# Pocket Commit

Commit files to any GitHub repository from your phone. It is a static web app:
open the page, paste a personal access token, and you can browse a repo, edit
text files, upload photos, and push a real commit — no server, no backend, no
third-party service in the middle.

**[Open the app →](https://leonvb.github.io/github-mobile/)**

Add it to your home screen and it runs full-screen like a native app.

---

## Why it exists

The GitHub mobile web UI is fine for reading code and awkward for writing it.
Uploading a photo, adding a Markdown note, or fixing a typo on the go usually
means fighting a desktop-oriented flow. Pocket Commit is one screen: a file
browser, an editor, an upload button, and a commit button.

## How it works

```
your phone ──── HTTPS ────► api.github.com
     │                           ▲
     └── static page ────────────┘
         (GitHub Pages)
```

The page is plain HTML, CSS and ES modules. It calls the GitHub REST API
directly from the browser — GitHub's API sends `Access-Control-Allow-Origin: *`
and allows `Authorization` in preflight, so writes work cross-origin. There is
no place to put a server, and nothing to trust but GitHub.

Commits use the Git Data API rather than uploading a single file through the
Contents API:

1. read the branch tip (`GET /git/ref/heads/...`)
2. upload each file as a blob
3. build one tree on top of the branch's existing tree (`base_tree`), with
   `null` entries for deletions
4. create one commit whose parent is the tip we read
5. fast-forward the ref to it

That makes a multi-file commit **atomic** (one commit, not N), and it refuses to
silently clobber someone else's push: GitHub rejects the ref update if the
branch moved between step 1 and step 5, and the app surfaces that as an error.

## Setup

### 1. Create a token

Go to **GitHub → Settings → Developer settings → Personal access tokens** and
create a **fine-grained token**:

- **Repository access:** only the repositories you want to commit to
- **Permissions:** `Contents: Read and write`

A classic token with the `repo` scope also works if you prefer.

### 2. Open the app and connect

Paste the token into the connect screen. Pick a repository, and you are in.

### Token storage — read this

This app has no backend, which is the point: nothing to breach, nothing to
subscribe to. The trade-off is that the token lives in your browser.

- By default the token is kept **in memory only** and is gone when you close the
  tab. Handy on a borrowed phone.
- Turn on **Remember token** to keep it in `localStorage` and stay signed in.
- Either way it is readable by anything running on this origin. Use a
  fine-grained token limited to the repositories you actually need, and hit
  **Sign out** before you hand the phone to someone.

The app has a strict Content-Security-Policy: no inline scripts, no `eval`, no
requests to any host except `api.github.com`.

## What you can do

| | |
|---|---|
| **Browse** | Folders and files on any branch, with sizes and icons |
| **Edit** | Text, code and Markdown, with a Markdown preview and a diff summary |
| **Create** | New files at any path — folders are created for you |
| **Upload** | Photos and files straight from the camera roll, into any folder |
| **Delete** | Stage a deletion and commit it with the rest |
| **Branch** | Switch branches, or commit to a brand-new branch without touching the current one |
| **Recover** | Downloads and GitHub links for any file |

Staged changes survive navigating around the repo and are committed together in
one reviewable commit. Nothing is sent until you press **Commit**.

## Run it locally

```bash
npm run dev        # serves docs/ on http://localhost:8000
```

Any static file server works (`python3 -m http.server --directory docs`).
ES modules need HTTP — opening `index.html` from the filesystem will not work.

## Tests

```bash
npm install
npm test
```

Two suites run under jsdom against a fake GitHub backend that mirrors the
Git Data API's real semantics (fast-forward checks, `base_tree` inheritance,
null-sha deletions):

- `test/commit-api.test.mjs` — the commit engine: atomic multi-file commits,
  deletions in the same tree, branch creation from a base, binary uploads,
  error mapping, and the token-storage policy.
- `test/ui-flows.test.mjs` — drives the actual UI: upload folder sheet,
  duplicate-name handling, editor staging with diff stats, committing to a new
  branch, and validation guards.

`npm run inspect` prints the rendered DOM for the welcome, repo and staged
screens, which is handy when changing markup.

## Deploy to GitHub Pages

The included workflow publishes `docs/` on every push to `main`:

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main` (or run the *Deploy to GitHub Pages* workflow manually).

The app is served from `https://<user>.github.io/<repo>/`. All asset URLs are
relative, so a project page, a user page, or a custom domain all work without
changes. Forking the repo works too — no configuration refers to this account.

## Files

```
docs/
  index.html              app shell, inline SVG icon sprite
  app.css                 design tokens, light/dark themes, sheets
  manifest.webmanifest    home-screen metadata
  sw.js                   offline shell cache (never caches API calls)
  404.html                fallback that redirects to the app root
  js/
    app.js                screens, editor, uploads, commit UI
    github.js             REST client, auth checks, atomic commit builder
    ui.js                 bottom sheets, toasts, form controls
    store.js              settings, recent repos, token policy
    util.js               paths, encoding, formatting, validation
  icons/                  generated PNG icons
test/                     jsdom suites + screen inspector
.github/workflows/
  deploy-pages.yml        Pages deployment
```

## Limits worth knowing

- **100 MB per file** — a GitHub limit; the app warns well before that.
- **~4 MB for the in-browser editor** — larger files can still be uploaded,
  just not edited as text.
- **Rate limits** — 5,000 authenticated requests/hour. Each commit uses roughly
  two to four requests per file.
- **No history view, no PRs, no merges.** This is a commit tool, not a client.

## License

MIT
