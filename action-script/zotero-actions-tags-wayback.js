/**
 * Save to Wayback Machine — a custom script for
 * windingwind/zotero-actions-tags ("Actions & Tags for Zotero").
 *
 * What it does: archives the URL of the target item(s) in the Internet
 * Archive Wayback Machine (anonymous Save Page Now) and records the
 * snapshot as tag `archived:wayback` plus an Extra line
 * `Wayback Machine: <snapshot-url>` — the same convention as the
 * standalone Wayback Autosave plugin, so the two interoperate (either
 * one skips items the other already archived).
 *
 * Setup in Actions & Tags:
 *   1. Create an action, operation `customScript`.
 *   2. For on-demand use: leave Event empty, set a Menu Label
 *      (e.g. "Save to Wayback Machine") and/or a shortcut, paste this
 *      whole script as Data.
 *   3. For automatic use: set Event to `createItem` (fires for every new
 *      item, however added). Note: no rate limiting or retries here — a
 *      burst of imports will hit archive.org's anonymous quota fast.
 *      For queueing, backoff, S3-key quota and auto-update, use the full
 *      plugin instead: https://github.com/the-solipsist/zotero-wayback-autosave
 *
 * Copyright (C) 2026 Pranesh Prakash
 * SPDX-License-Identifier: GPL-3.0-or-later <https://www.gnu.org/licenses/>
 */

(async () => {
  const TAG = "archived:wayback";
  const SPN = "https://web.archive.org/save/";
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function archiveOne(item) {
    if (!item || typeof item.isRegularItem !== "function" || !item.isRegularItem()) {
      return "skipped";
    }
    const url = item.getField("url") || "";
    if (!/^https?:\/\//i.test(url)) return "skipped";
    if (item.getTags().some((t) => t.tag === TAG)) return "skipped";
    let xhr;
    try {
        xhr = await Zotero.HTTP.request("GET", SPN + url, {
        responseType: "text",
      });
    } catch (e) {
        Zotero.debug(`wayback-action: request failed for ${url}: ${e}`);
      return "failed";
    }
    if (xhr.status !== 200) return "failed";
    let snapshot = null;
    try {
      const link = xhr.getResponseHeader("Link") || "";
      const m = [...link.matchAll(/<([^>]+)>;\s*rel="memento"/gi)];
      if (m.length) snapshot = new URL(m[m.length - 1][1], SPN + url).href;
    } catch (e) {
      snapshot = null;
    }
    if (!snapshot) {
      const finalURL = xhr.responseURL || "";
      if (/\/web\/\d+\//.test(finalURL)) snapshot = finalURL;
    }
    if (!snapshot) return "failed";
    const extra = item.getField("extra") || "";
    if (!extra.includes(snapshot)) {
      item.setField(
        "extra",
        extra ? `${extra}\nWayback Machine: ${snapshot}` : `Wayback Machine: ${snapshot}`
      );
    }
    if (!item.hasTag(TAG)) item.addTag(TAG);
    await item.saveTx();
    return "archived";
  }

  // Menu/shortcut path: one call for the whole selection, then per item.
  // Handle the batch call only to avoid archiving everything N times.
    if (typeof items !== "undefined" && items && items.length) {
    if (typeof item !== "undefined" && item) return;
    const counts = { archived: 0, failed: 0, skipped: 0 };
    for (const it of items) {
      counts[await archiveOne(it)]++;
      await delay(3000); // crude rate spacing; no persistent queue here
    }
    Zotero.debug(
      `wayback-action: batch done — ${counts.archived} archived, ${counts.failed} failed, ${counts.skipped} skipped`
    );
    return;
  }
  // Event path (e.g. createItem): single item, silent.
    if (typeof item !== "undefined" && item) {
    await archiveOne(item);
  }
})();
