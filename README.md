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

## Install

```bash
npm ci
npx playwright install --with-deps chromium
```

## Run a scan

```bash
# From a config file (recommended for multisite):
node src/cli.js --config config.json --out scan

# Or a single URL:
node src/cli.js --url https://example.com --blog-id 1 --out scan

# Fetch the site list from WordPress over REST (recommended for CI):
KJEKS_USER=admin KJEKS_APP_PASSWORD='xxxx xxxx xxxx xxxx' \
  node src/cli.js --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --out scan

# Against Cloudflare Browser Run instead of local Chromium (opt-in):
node src/cli.js --config config.json --endpoint "wss://…/browser-run/…"

# Scan several sites in parallel (default 3; polite per-host cap 2):
node src/cli.js --config-url "https://network.example.com/wp-json/kjeks/v1/scan-config" --concurrency 4 --out scan

# Scan and import in one step:
KJEKS_USER=admin KJEKS_APP_PASSWORD='xxxx xxxx xxxx xxxx' \
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
   site list (auth: `KJEKS_USER` + `KJEKS_APP_PASSWORD`, caller needs
   `manage_network`). Best for CI: no committed config, new subsites appear
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
KJEKS_USER=admin KJEKS_APP_PASSWORD='xxxx xxxx xxxx xxxx' \
  node src/import.js --site https://network.example.com scan/*.json
```

Uses a WordPress application password (HTTP Basic) against
`/wp-json/kjeks/v1/import`; the caller needs `manage_network`. Never commit the
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

## Scheduled scanning

`.github/workflows/scan.yml` runs the scan weekly, uploads the full artifact,
imports observations (if secrets are set), and commits baseline changes. Set
`KJEKS_SITE_URL`, `KJEKS_USER`, and `KJEKS_APP_PASSWORD` as repository secrets.

## Known limitations

- First/third-party classification uses an eTLD+1 approximation (last two
  labels), not the full Public Suffix List.
- Consent states are injected via the shared record schema, not by clicking the
  banner; a UI regression could pass the state matrix yet break the real banner.
- A single run from one location cannot capture geo/consent variations.
