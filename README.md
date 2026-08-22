# Kjeks discovery scanner

A standalone Playwright scanner that discovers cookies and similar technologies
across a WordPress Multisite, in each consent state. It runs **separately from
the WordPress runtime** — nothing here is loaded by the plugin.

Part of the **kjeks family**. It integrates with the
[Kjeks plugin](https://github.com/soderlind/kjeks) over REST only
(`scan-config` + `import`); see the
[kjeks ecosystem overview](https://github.com/soderlind/kjeks/blob/main/docs/architecture.md#9-ecosystem-the-kjeks-family).

> Discovery is observational. It records what a real browser encountered; it
> **cannot prove the absence** of tracking, and results vary by geo/IP. Imported
> observations are always **unreviewed** until an administrator classifies them.

## Why real Chromium

The scanner drives a version-pinned, real headless Chromium via Playwright's
CDP-backed API. Only CDP exposes HttpOnly cookies and full network events, and
only a real browser executes third-party code the way a visitor's browser does.
See [docs/adr/0005-scanner-uses-real-chromium.md](docs/adr/0005-scanner-uses-real-chromium.md).

## How it works end-to-end

1. **Select** — the WordPress plugin's `scan-config` auto-picks representative URLs per
   site (home, newest post/page, embed-bearing pages), capped. The scanner fetches this
   over REST or from a file.
2. **Scan** — for each site (in a bounded parallel pool with a per-host ceiling) the
   scanner opens a fresh browser context per consent state, injects the consent record,
   visits the URLs, and records cookies, storage, third-party requests, scripts, iframes,
   and beacons.
3. **Attribute** — every observation is tagged with `source_urls`, the page(s) it loaded on.
4. **Diff** — results are written as one deterministic JSON file per site and diffed
   against the committed baseline; any change exits non-zero for review.
5. **Target** — the next run always re-scans pages that previously produced a tracker
   (from `source_urls`), so coverage never silently regresses.
6. **Import** — observations are POSTed to the plugin as *unreviewed* (in the same run
   with `--import`, or separately) for an administrator to classify — optionally via the
   [AI Reviewer](https://github.com/soderlind/kjeks-ai-reviewer).

Design rationale is recorded under [docs/adr/](docs/adr): see
[0006 — REST-driven scanning](docs/adr/0006-rest-driven-scanning.md) and
[0005 — real Chromium](docs/adr/0005-scanner-uses-real-chromium.md).

## Install

Most people should **not** clone this repo. Pick the option that matches how
often you'll run it. Every option downloads a pinned Chromium (~100+ MB) via
Playwright on first run and reuses it afterwards.

### Run once, no install (recommended)

Best for CI and occasional scans — nothing to check out or keep up to date:

```bash
npx kjeks-scanner --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --out scan
```

### Install globally (recommended for repeated local use)

```bash
npm install -g kjeks-scanner
kjeks-scanner --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --out scan
```

Both `kjeks-scanner` and `kjeks-scan` commands are available after install.

### Clone (only to modify the scanner or contribute)

Clone if you need to change the code, run the test suite, or send a PR:

```bash
git clone https://github.com/soderlind/kjeks-scanner.git
cd kjeks-scanner
npm ci
npx playwright install --with-deps chromium
node src/cli.js --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --out scan
```

## Run a scan

The examples below use `node src/cli.js` (from a clone). If you installed via
npx or globally, substitute `kjeks-scanner` for `node src/cli.js`.

```bash
# From a config file (recommended for multisite):
node src/cli.js --config config.json --out scan

# Or a single URL:
node src/cli.js --url https://example.com --blog-id 1 --out scan

# Fetch the site list from WordPress over REST (recommended for CI):
KJEKS_SCAN_KEY='<key from: wp kjeks scan-key --generate>' \
  node src/cli.js --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --out scan

# Against Cloudflare Browser Run instead of local Chromium (opt-in):
node src/cli.js --config config.json --endpoint "wss://…/browser-run/…"

# Scan several sites in parallel (default 3; polite per-host cap 2):
node src/cli.js --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --concurrency 4 --out scan

# Scan and import in one step:
KJEKS_SCAN_KEY='<key>' \
  node src/cli.js --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --import --out scan
```

### Flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--concurrency <n>` | 3 | Sites scanned in parallel. |
| `--per-host <n>` | 2 | Parallel scans allowed to share one hostname (politeness for subdirectory multisites on one server). |
| `--full` | off | Scan the server selection as-is; skip re-scanning pages that previously produced a tracker. |
| `--import [<url>]` | off | After scanning, POST observations to the Kjeks import endpoint. Base URL from the value, `--site`, or `--config-url`. |

Config shape: `{ "sites": [ { "url", "blog_id", "policy_version", "paths",
"scenarios" } ] }`. Generate it with `wp kjeks scan-config` or fetch it over
REST (below); `paths`/`scenarios` shape is shown in `overlay.example.json`.

### Where the config comes from

Three interchangeable sources:

1. **Static file** — `--config config.json`.
2. **REST** — `--config-url .../wp-json/kjeks/v1/scan-config` fetches the live
   site list (auth: `KJEKS_SCAN_KEY`, or `KJEKS_USER` + `KJEKS_APP_PASSWORD`;
   the key path needs a key set via `wp kjeks scan-key`, the Basic-auth path
   needs `manage_network`). Best for CI: no committed config, new subsites appear
   automatically. Add `--overlay overlay.json` to merge repo-side `paths` and
   `scenarios` by `blog_id` (see `overlay.example.json`).
3. **WP-CLI** — generate a static file locally:

   ```bash
   wp kjeks scan-config > config.json                    # auto-selects URLs per site
   wp kjeks scan-config --cap=15 --include=1,3            # cap the auto-selection
   wp kjeks scan-config --paths=/,/about > config.json    # explicit paths (override)
   ```

Omit `--paths` (CLI) or the `paths` query param (REST) and the plugin
**auto-selects representative URLs per site** via `WP_Query` — the home page, the
newest post and page, the posts archive, and pages whose content shows an embed /
inline-script signal — capped by `--cap` (default 10). Passing explicit paths
overrides the selection.

The REST endpoint and `wp kjeks scan-config` share the same builder, so they
produce identical output.

For every site the scanner opens a **fresh browser context** per consent state:
`before-choice`, `reject-all`, `only-preferences`, `only-analytics`,
`only-marketing`, `accept-all`. It collects Set-Cookie headers, context cookies
(incl. HttpOnly/Secure/SameSite), `document.cookie`, localStorage,
sessionStorage, IndexedDB names, third-party requests, redirects, scripts,
iframes, and beacon/pixel requests.

Each derived observation records **`source_urls`** — the page(s) it actually
loaded on — so reviewers can see *where* a tracker fires. On the next run the
scanner always re-scans those pages (on top of the server selection), so a page
that once produced a tracker is never dropped by sampling. Use `--full` to scan
the server selection as-is.

## Output and diff

One deterministic JSON file per site at `<out>/<host>.json` (stable key order,
volatile fields normalized). The CLI prints a per-subsite diff (new / changed /
removed) against the previous file and exits non-zero when anything changed, so
CI can flag it for review. Commit `scan/<host>.json` as the baseline.

## Import into WordPress

```bash
KJEKS_SCAN_KEY='<key>' \
  node src/import.js --site https://network.example.com scan/*.json
```

Authenticates with the shared scanner key in the `X-Kjeks-Key` header (or an
application password via HTTP Basic as a fallback) against
`/wp-json/kjeks/v1/import`; the Basic-auth path needs `manage_network`. Never commit the
password — pass it via environment / CI secrets. Locally you can instead use
`wp kjeks import <file>`.

To scan and import in a single command, pass `--import` to `src/cli.js` (see
Flags above) instead of running `src/import.js` separately.

## Tests

```bash
npm run test:unit                       # fast unit tests (node:test), no browser
BASE_URL=http://plugins.local/ npx playwright test   # end-to-end, needs a site
```

The end-to-end suite confirms optional cookies, storage, and third-party requests
do not occur before a consent choice, and that gated scripts stay inert.

## Run from GitHub Actions

There are two ways to run the scanner in CI, depending on whether you want to
track a baseline over time.

### Easiest: drop-in workflow (no clone, no baseline)

Copy this into `.github/workflows/kjeks-scan.yml` in **any repo you already
own**. It uses `npx` (no checkout, no `npm ci`, no lockfile), scans, imports the
observations, and uploads the results as a downloadable artifact:

```yaml
name: Kjeks discovery scan

on:
  schedule:
    - cron: '0 3 * * 1' # Weekly, Monday 03:00 UTC
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx playwright install --with-deps chromium
      - name: Run discovery scan and import
        id: scan
        # The scanner exits non-zero when a subsite changed, a site errored, or
        # observations were imported — the normal outcome of a successful run.
        # continue-on-error keeps the job green and lets the upload below run.
        continue-on-error: true
        env:
          KJEKS_SCAN_KEY: ${{ secrets.KJEKS_SCAN_KEY }}
        run: >-
          npx kjeks-scanner
          --config-url "${{ secrets.KJEKS_SITE_URL }}/wp-json/kjeks/v1/scan-config"
          --import --out scan
      - uses: actions/upload-artifact@v4
        with:
          name: kjeks-scan
          path: scan/
```

Then add two repository secrets (Settings → Secrets and variables → Actions):

- `KJEKS_SITE_URL` — your network base URL, e.g. `https://network.example.com`
- `KJEKS_SCAN_KEY` — the shared scanner key from `wp kjeks scan-key --generate`

That's the whole setup. Drop `--import` (or leave `KJEKS_SCAN_KEY` unset) to
scan without importing. The `npx playwright install --with-deps` step pulls the
Linux system libraries Chromium needs on the runner. Never commit the key — it
must live only in Actions secrets.

> **Why a key, not an application password?** The key is sent in the
> `X-Kjeks-Key` header, which survives reverse proxies/CDNs that strip the
> `Authorization` header (a common cause of `401 rest_not_logged_in`). Basic
> auth with `KJEKS_USER` + `KJEKS_APP_PASSWORD` still works as a fallback where
> the `Authorization` header reaches WordPress.

**Exit codes / `continue-on-error`.** The scanner exits **non-zero** when a
subsite changed, a site errored, or observations were imported — i.e. the
normal outcome of a successful run that found something. That is deliberate so
local/baseline runs can flag changes, but in a CI job it would fail the step
and skip the artifact upload. The workflow above sets `continue-on-error: true`
on the scan step so a successful scan-with-imports stays green; review the
imported observations in **Network Admin → Cookie Consent** instead of treating
the exit code as a build failure. (Omit `continue-on-error` if you *want* CI to
go red whenever the scan detects a change.)

### Optional upgrade: committed baseline for regression tracking

If you want the scan to **diff against a committed baseline** and fail/flag when
a subsite changes, use the included
[`.github/workflows/scan.yml`](.github/workflows/scan.yml). It needs a real
checkout (to read the previous `scan/<host>.json` and commit updates back), so
fork or clone this repo — or copy `scan.yml` and the `scan/` folder into your
own repo. Set the same three secrets; the workflow runs weekly and on demand,
uploads the artifact, imports observations, and commits the updated baseline.

## Known limitations

- First/third-party classification uses an eTLD+1 approximation (last two
  labels), not the full Public Suffix List.
- Consent states are injected via the shared record schema, not by clicking the
  banner; a UI regression could pass the state matrix yet break the real banner.
- A single run from one location cannot capture geo/consent variations.
