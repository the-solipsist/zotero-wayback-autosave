# Wayback Autosave for Zotero

Automatically archives every new Zotero item's URL in the Internet Archive
Wayback Machine (Save Page Now) — however the item was added (browser
connector, CLI, or manual entry). Manual saves via the item context menu.

- **Author:** Muse Spark (idea and instigation: Pranesh Prakash)
- **Copyright:** © 2026 Pranesh Prakash
- **Contributors:** Pranesh Prakash, Muse Spark
- **License:** [GNU General Public License v3.0 or later](COPYING) —
  copyleft: share and share alike. (SPDX: `GPL-3.0-or-later`)
- **Zotero:** 7–10. No dependencies, no build step beyond zipping.

## Install

Download `wayback-autosave.xpi` from
[Releases](https://github.com/the-solipsist/zotero-wayback-autosave/releases),
then in Zotero: Tools → Plugins → gear icon → Install Plugin From File.

## Use

Nothing to configure for the basics: every item with an `http(s)` URL gets
archived in the background (one at a time, ~8s apart, so bursts of imports
don't trip archive.org's rate limits). Success is recorded as:

- tag `archived:wayback`, and
- an Extra line `Wayback Machine: <snapshot-url>`

Failures get tag `wayback:failed` and are retried automatically with
backoff (up to 5 attempts). Right-click → **Save to Wayback Machine** archives
on demand (multi-select works — good for backlogs) and forces a retry.

## Raising the save quota

Anonymous saves share a per-IP quota that runs dry fast. For your personal
quota (~100k captures/day):

1. Get free S3 keys at [archive.org/account/s3.php](https://archive.org/account/s3.php).
2. Paste them into the plugin's Settings pane (Zotero Settings → Wayback
   Autosave). They stay in your local Zotero prefs — never transmitted
   anywhere except to archive.org itself.
3. Optionally use **Log in to archive.org** in the same item menu, which
   puts a session in Zotero's cookie jar as a second quota path.

## Build from source

```sh
./build.sh   # produces wayback-autosave.xpi
```

Layout: `manifest.json`, `bootstrap.js`, `prefs.js`,
`content/wayback.js` (all logic), `content/preferences.xhtml` (Settings
pane), `skin/default/icon.svg`. See `AGENTS.md` for the design notes.

## Limits

- Internet Archive only (no archive.today fallback — it has no stable API).
- IA honors robots.txt, so some sites (e.g. NYT) fail by design.
- archive.org login sessions expire every few days; S3 keys don't.
