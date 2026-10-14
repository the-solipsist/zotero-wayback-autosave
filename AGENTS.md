# AGENTS.md — wayback-autosave (Zotero plugin)

Minimal Zotero plugin: automatically archives every new item's URL in the
Internet Archive Wayback Machine (Save Page Now), however the item was added
(connector, `zotero-cli`/bridge, UI). Manual save via item context menu
("Save to Wayback Machine", works on multi-select for backlogs).

## Files

| File | What it is |
|---|---|
| `manifest.json` | Plugin meta; id `wayback-autosave@pranesh`, Zotero 7–10 |
| `bootstrap.js` | Standard bootstrap; loads `content/wayback.js`, owns lifecycle |
| `prefs.js` | Defaults: `auto=true`, `spnBase=https://web.archive.org/save/`, `queueDelayMs=8000` |
| `content/wayback.js` | Everything: `Zotero.WaybackAutosave` (observer, FIFO queue, SPN + SPN2, menu) |
| `content/preferences.xhtml` | Settings pane: auto toggle + S3 key fields (explicit JS wiring via `prefsUI`, NOT automatic `preference` binding — that silently failed to persist, 2026-10-14; descriptions carry wrapping CSS) |
| `skin/default/icon.svg` | Clock logo (manifest icons) |
| `build.sh` | Zips the XPI (`./build.sh` → `wayback-autosave.xpi`) |

No npm, no scaffold, no toolkit dependency. Edit the JS, rebuild, reinstall.

## Design (read before changing)

- **Trigger:** `Zotero.Notifier` observer on `['item']`, event `add` only.
  Add-events fire for connector, bridge/CLI and UI saves alike — that is the
  whole point. Own `saveTx` calls (tag/Extra writes) emit `modify`, never
  `add`, so no self-trigger loop.
- **Queue:** one FIFO, one in flight, `queueDelayMs` between requests
  (archive.org rate-limits aggressively; bursts of imports must not hammer
  it). Timer cleared on shutdown.
- **Retries:** 429/503/504 and network errors are transient quota states
  (archive.org throttles SPN per exit-IP; our ISP's CGNAT shares the bucket,
  so anonymous saves 429 while browsing works fine). They re-queue with
  linear backoff (`retryDelayMs` × attempt, max 5 attempts); anything else
  fails immediately. Authenticated archive.org sessions get personal quotas —
  not supported yet (would need account/S3 keys).
- **Skip rules:** non-regular items, deleted items, non-http(s) URLs,
  already tagged `archived:wayback`; auto mode also skips `wayback:failed`
  (manual menu forces a retry and clears the tag on success).
- **SPN protocol:** anonymous `GET <spnBase><url>` (raw concat, as
  documented), snapshot URL from the `Link: <…>; rel="memento"` response
  header (last wins), falling back to `Content-Location`, then to a
  `/web/<ts>/` redirect target. Never fabricate a snapshot URL.
- **Authenticated SPN2 (v1.1+, when S3 keys are set):** `POST
  https://web.archive.org/save` with `Authorization: LOW <access>:<secret>`,
  body `url=…&skip_first_archive=1&if_not_archived_within=30d` → `job_id` →
  poll `GET …/save/status/<job_id>` every 10s (≤5 min) → snapshot URL from
  `web/<timestamp>/<original_url>`. Error `status_ext` values are classified:
  quota/overload ones re-queue via the normal backoff, auth/URL ones fail
  immediately. Keys live only in local prefs (`s3access`, `s3secret`), entered
  by the user in the Settings pane — never in chat, code, or VCS.
- **Record:** tag `archived:wayback` + Extra line `Wayback Machine: <url>`;
  failures get tag `wayback:failed`. No popups in auto mode (silent);
  manual batches get one summary popup.
- **Prefs** (full branch `extensions.zotero.waybackautosave.*`):
  `auto`, `spnBase` (trailing slash optional; also the test hook — point it
  at a local stub), `queueDelayMs`, `retryDelayMs`.
- **Menu:** via `Zotero.MenuManager` when present; if registration fails,
  auto-archiving still works (the failure is logged, not thrown). The item
  menu has "Save to Wayback Machine" (manual, multi-select OK) and
  "Log in to archive.org (raises save quota)" — login happens in Zotero's
  own window so session cookies land in Zotero's jar and SPN requests carry
  them automatically; the plugin never sees credentials. Needed because
  anonymous SPN shares a per-IP quota bucket (our ISP's CGNAT), while
  logged-in sessions get personal quotas.

## Install / verify

```sh
./build.sh   # → wayback-autosave.xpi
```

Install via Tools → Plugins → Install Plugin From File, or headlessly via
the JS bridge (`AddonManager.getInstallForFile` + `install.install()` —
see session notes; needs the file on disk, not a URL).

> **TODO — real `update_url`:** Zotero 10 refuses manifests without
> `applications.zotero.update_url`, so the manifest currently points at a
> `https://localhost/…` placeholder (install works; background update checks
> fail quietly). When this gets a GitHub repo + releases, point it at the
> release `update.json` and remove this note.

End-to-end test without touching archive.org: point `spnBase` at a local
stub server that answers with a `Link: <http://example/web/<ts>/<url>>;
rel="memento"` header, create an item with a URL (e.g. via `zotero-add`),
and check for the tag + Extra line. Then restore the real base and try one
real archive; a 429/limit shows up as `wayback:failed`, never a crash.

## Known limits (v1)

- Internet Archive only (no archive.today fallback — it has no stable API).
- IA honors robots.txt (e.g. NYT): those saves fail by design.
- Anonymous SPN is rate-limited; sustained bulk backlogs should go through
  the menu in modest batches, not all at once.
