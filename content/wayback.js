/* Wayback Autosave for Zotero
 * Copyright (C) 2026 Pranesh Prakash
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* global Zotero */

/*
 * Wayback Autosave: archive every new item's URL in the Internet Archive
 * (Save Page Now), however the item was added (connector, CLI bridge, UI).
 *
 * Success is recorded as tag `archived:wayback` + an Extra line
 * `Wayback Machine: <snapshot-url>`. Failures get tag `wayback:failed`
 * (auto mode never retries those; the manual menu item forces a retry).
 * Requests go through a FIFO queue with a delay between them so bursts of
 * imports don't trip archive.org's rate limits.
 */

Zotero.WaybackAutosave = (function () {
	const TAG_OK = 'archived:wayback';
	const TAG_FAIL = 'wayback:failed';

	let initialized = false;
	let observerID = null;
	let prefPaneID = null;
	let menuIDs = [];
	let queue = []; // [{ id, manual, attempts, notBefore }]
	let timer = null;
	let manualPending = 0;
	let manualDone = 0;
	let manualFailed = 0;

	const MAX_RETRIES = 5;

	const pref = (k, dflt) => {
		const v = Zotero.Prefs.get(`extensions.zotero.waybackautosave.${k}`);
		return v === undefined ? dflt : v;
	};

	function log(msg) {
		Zotero.debug(`wayback-autosave: ${msg}`);
	}

	function isArchivable(item) {
		if (!item || !item.isRegularItem() || item.deleted) return false;
		const url = item.getField('url') || '';
		if (!/^https?:\/\//i.test(url)) return false;
	 const tags = item.getTags().map(t => t.tag);
		if (tags.includes(TAG_OK)) return false;
		return true;
	}

	function enqueue(id, manual = false) {
		if (queue.some(e => e.id === id)) return;
		queue.push({ id, manual, attempts: 0, notBefore: 0 });
		if (manual) manualPending++;
		pump();
	}

	function pump() {
		if (timer || !queue.length) return;
		const now = Date.now();
		const head = queue[0];
		const delay = Math.max(1000, pref('queueDelayMs', 8000));
		const wait = Math.max(delay, (head.notBefore || 0) - now);
		timer = setTimeout(async () => {
			timer = null;
			const next = queue.shift();
			if (next) {
				try {
					await archiveItem(next.id, next.manual, next);
				}
				catch (e) {
					log(`queue entry ${next.id} threw: ${e}`);
				}
				if (next.manual) {
					manualPending--;
					if (manualPending <= 0) {
						ZoteroUtilShowPopup(
							`Wayback: ${manualDone} archived, ${manualFailed} failed`,
							manualFailed ? 'Failures are tagged wayback:failed; retry from the menu. Repeated HTTP 429s mean the shared save quota is empty — use "Log in to archive.org" in the same menu first.' : ''
						);
						manualDone = 0;
						manualFailed = 0;
					}
				}
			}
			pump();
		}, delay);
	}

	function ZoteroUtilShowPopup(title, body) {
		try {
			const win = new Zotero.ProgressWindow({ closeOnClick: true });
			win.changeHeadline(title);
			if (body) {
				win.addDescription(body);
			}
			win.show();
			win.startCloseTimer(6000);
		}
		catch (e) {
			log(`popup failed: ${e}`);
		}
	}

	function extractSnapshot(xhr, requestURL) {
		// Preferred: Link: <...>; rel="memento" (last one wins)
		let link = null;
		try {
			link = xhr.getResponseHeader('Link');
		}
		catch (e) {}
		if (link) {
			const mementos = [...link.matchAll(/<([^>]+)>;\s*rel="memento"/gi)];
			if (mementos.length) {
				try {
					return new URL(mementos[mementos.length - 1][1], requestURL).href;
				}
				catch (e) {}
			}
		}
		// Fallback: Content-Location header
		let loc = null;
		try {
			loc = xhr.getResponseHeader('Content-Location');
		}
		catch (e) {}
		if (loc) {
			try {
				return new URL(loc, requestURL).href;
			}
			catch (e) {}
		}
		// Fallback: we were redirected straight to the snapshot
		const finalURL = xhr.responseURL || '';
		if (/\/web\/\d+\//.test(finalURL)) return finalURL;
		return null;
	}

	function s3keys() {
		const access = (pref('s3access', '') || '').trim();
		const secret = (pref('s3secret', '') || '').trim();
		return access && secret ? { access, secret } : null;
	}

	function sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// Authenticated SPN2 flow: POST capture -> poll status until success.
	// Returns the snapshot URL, or throws { transient: bool, message }.
	async function archiveViaSPN2(url, keys) {
		const auth = { Accept: 'application/json', Authorization: `LOW ${keys.access}:${keys.secret}` };
		let cap;
		try {
			cap = await Zotero.HTTP.request(
				'POST', 'https://web.archive.org/save',
				{
					headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
					body: `url=${encodeURIComponent(url)}&skip_first_archive=1&if_not_archived_within=30d`,
					responseType: 'text'
				}
			);
		}
		catch (e) {
			throw { transient: true, message: `capture request failed: ${e.message || e}` };
		}
		let job;
		try {
			job = JSON.parse(cap.responseText);
		}
		catch (e) {
			throw { transient: cap.status === 429 || cap.status >= 500, message: `HTTP ${cap.status} on capture` };
		}
		if (!job || !job.job_id) {
			throw { transient: false, message: `no job_id in capture response` };
		}
		for (let i = 0; i < 30; i++) {
			await sleep(10000);
			let st;
			try {
				st = await Zotero.HTTP.request(
					'GET', `https://web.archive.org/save/status/${job.job_id}`,
					{ headers: auth, responseType: 'text' }
				);
			}
			catch (e) {
				continue; // poll hiccup; keep waiting
			}
			let s;
			try {
				s = JSON.parse(st.responseText);
			}
			catch (e) {
				continue;
			}
			if (s.status === 'success' && s.timestamp) {
				const original = s.original_url || url;
				return `https://web.archive.org/web/${s.timestamp}/${original}`;
			}
			if (s.status === 'error') {
				const code = s.status_ext || '';
				const transient = /too-many-requests|too-many-daily-captures|user-session-limit|cannot-fetch|celery|no-browsers-available|service-unavailable|gateway-timeout|browsing-timeout|read-timeout|proxy-error|soft-time-limit/i.test(code);
				if (/unauthorized|invalid-url|not-found|blocked-url|blocked\b|filesize-limit/i.test(code)) {
					throw { transient: false, message: code };
				}
				throw { transient, message: code || s.message || 'capture error' };
			}
			// pending (or unknown): keep polling
		}
		throw { transient: true, message: 'capture still pending after 5 min' };
	}

	async function archiveItem(id, manual = false, entry = null) {
		const item = await Zotero.Items.getAsync(id);
		if (!item || !item.isRegularItem() || item.deleted) return { ok: false, error: 'gone' };
		if (!isArchivable(item)) return { ok: false, error: 'skipped' };
		if (!manual && item.getTags().some(t => t.tag === TAG_FAIL)) {
			return { ok: false, error: 'failed-before' };
		}
		const url = item.getField('url');
		// Authenticated SPN2 first when keys are configured (personal quota);
		// anonymous GET otherwise (shared IP quota).
		const keys = s3keys();
		if (keys) {
			try {
				const snapshot = await archiveViaSPN2(url, keys);
				return recordSuccess(item, manual, url, snapshot);
			}
			catch (e) {
				// fail() keys transience off HTTP status: 429 = retry w/backoff,
				// -1 = permanent. SPN2 already classifies; just translate.
				return fail(item, manual, entry, `spn2: ${e.message || e}`, e.transient ? 429 : -1);
			}
		}
		const spnBase = (pref('spnBase', 'https://web.archive.org/save/') || '').replace(/\/*$/, '/');
		let xhr;
		try {
			xhr = await Zotero.HTTP.request('GET', spnBase + url, { responseType: 'text' });
		}
		catch (e) {
			log(`SPN request failed for ${url}: ${e}`);
			return fail(item, manual, entry, `request failed: ${e.message || e}`, 0);
		}
		if (xhr.status !== 200) {
			return fail(item, manual, entry, `HTTP ${xhr.status}`, xhr.status);
		}
		const snapshot = extractSnapshot(xhr, spnBase + url);
		if (!snapshot) {
			return fail(item, manual, entry, `HTTP ${xhr.status}, no snapshot URL in response`, xhr.status);
		}
		return recordSuccess(item, manual, url, snapshot);
	}

	async function recordSuccess(item, manual, url, snapshot) {
	 const extra = item.getField('extra') || '';
		if (!extra.includes(snapshot)) {
			item.setField('extra', extra ? `${extra}\nWayback Machine: ${snapshot}` : `Wayback Machine: ${snapshot}`);
		}
		if (!item.hasTag(TAG_OK)) item.addTag(TAG_OK);
		if (item.hasTag(TAG_FAIL)) item.removeTag(TAG_FAIL);
		await item.saveTx();
		log(`archived ${url} -> ${snapshot}`);
		if (manual) manualDone++;
		return { ok: true, snapshot };
	}

	async function fail(item, manual, entry, error, status = 0) {
		// 429/503/504 (and network errors) are transient quota states: re-queue
		// with linear backoff instead of giving up. Anything else fails now.
		const transient = status === 0 || status === 429 || status === 503 || status === 504;
		const attempts = (entry && entry.attempts) || 0;
		if (transient && attempts < MAX_RETRIES) {
			const base = Math.max(5000, pref('retryDelayMs', 600000));
			const wait = base * (attempts + 1);
			log(`transient failure (${error}) for ${item.getField('url')}: retry ${attempts + 1}/${MAX_RETRIES} in ${Math.round(wait / 1000)}s`);
			queue.push({ id: item.id, manual, attempts: attempts + 1, notBefore: Date.now() + wait });
			if (manual) manualPending++; // balances the decrement when it is processed
			pump();
			return { ok: false, error: `retrying (${error})` };
		}
		if (transient && attempts >= MAX_RETRIES) {
			log(`gave up after ${attempts} retries: ${error}`);
		}
		log(`failed ${item.getField('url')}: ${error}`);
		try {
			if (!item.hasTag(TAG_FAIL)) item.addTag(TAG_FAIL);
			await item.saveTx();
		}
		catch (e) {
			log(`could not tag failure: ${e}`);
		}
		if (manual) manualFailed++;
		return { ok: false, error };
	}

	const observer = {
		notify: async (event, type, ids) => {
			if (event !== 'add' || type !== 'item') return;
			if (!pref('auto', true)) return;
			for (const id of ids) {
				try {
					const item = await Zotero.Items.getAsync(id);
					if (item && item.isRegularItem() && !item.deleted) enqueue(id, false);
				}
				catch (e) {
					log(`notify lookup failed: ${e}`);
				}
			}
		}
	};

	return {
		init({ id, rootURI }) {
			this.pluginID = id;
			this.rootURI = rootURI;
		},

		async startup() {
			if (initialized) return;
			observerID = Zotero.Notifier.registerObserver(observer, ['item'], 'wayback-autosave');
			try {
				prefPaneID = await Zotero.PreferencePanes.register({
					pluginID: this.pluginID,
					src: `${this.rootURI}content/preferences.xhtml`,
					label: 'Wayback Autosave'
				});
			}
			catch (e) {
				log(`preference pane registration failed: ${e}`);
			}
			for (const win of Zotero.getMainWindows()) {
				if (win.ZoteroPane) this.addToWindow(win);
			}
			initialized = true;
			log('started');
		},

		shutdown() {
			if (observerID) {
				Zotero.Notifier.unregisterObserver(observerID);
				observerID = null;
			}
			if (prefPaneID) {
				try {
					Zotero.PreferencePanes.unregister(prefPaneID);
				}
				catch (e) {
					log(`preference pane unregister failed: ${e}`);
				}
				prefPaneID = null;
			}
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			queue = [];
			try {
				for (const win of Zotero.getMainWindows()) this.removeFromWindow(win);
				if (Zotero.MenuManager) {
					for (const menuID of menuIDs) Zotero.MenuManager.unregisterMenu(menuID);
				}
			}
			catch (e) {
				log(`shutdown cleanup: ${e}`);
			}
			menuIDs = [];
			initialized = false;
		},

		addToWindow(win) {
			if (!Zotero.MenuManager) return;
			try {
				const id = Zotero.MenuManager.registerMenu({
					menuID: 'wayback-autosave-itemmenu',
					pluginID: this.pluginID,
					target: 'main/library/item',
					menus: [{
						menuType: 'menuitem',
						onShowing: (_event, context) => {
							const items = context.items ?? win.ZoteroPane.getSelectedItems();
							context.menuElem.setAttribute('label', 'Save to Wayback Machine');
							context.setVisible(items.some(i => i.isRegularItem()));
						},
						onCommand: (_event, context) => {
							const items = context.items ?? win.ZoteroPane.getSelectedItems();
							for (const item of items) {
								if (item.isRegularItem()) enqueue(item.id, true);
							}
						}
					}, {
						menuType: 'menuitem',
						onShowing: (_event, context) => {
							context.menuElem.setAttribute('label', 'Log in to archive.org (raises save quota)');
							context.setVisible(true);
						},
						onCommand: () => {
							// Login happens in Zotero's own window, so the session
							// cookies land in Zotero's cookie jar and subsequent
							// SPN requests automatically carry them. The plugin
							// never sees the credentials.
							Zotero.openInViewer('https://archive.org/account/login.php');
						}
					}]
				});
				if (id) menuIDs.push(id);
			}
			catch (e) {
				log(`menu registration failed (auto-archiving still works): ${e}`);
			}
		},

		removeFromWindow() {},

		// exposed for testing / manual triggers
		enqueue,
		archiveItem,

		// Settings-pane wiring (explicit load/save; does not rely on
		// automatic preference binding). Called from preferences.xhtml
		// inline handlers, which run in the Settings window context.
		prefsUI: {
			onLoad(win) {
				try {
					const doc = win.document;
					const auto = doc.getElementById('wayback-autosave-auto');
					if (auto) auto.checked = !!pref('auto', true);
					const acc = doc.getElementById('wayback-autosave-s3access');
					if (acc) acc.value = pref('s3access', '') || '';
					const sec = doc.getElementById('wayback-autosave-s3secret');
					if (sec) sec.value = pref('s3secret', '') || '';
				}
				catch (e) {
					log(`prefsUI.onLoad failed: ${e}`);
				}
			},
			onToggleAuto(el) {
				Zotero.Prefs.set('extensions.zotero.waybackautosave.auto', !!el.checked);
			},
			onKeyInput(key, el) {
				Zotero.Prefs.set(`extensions.zotero.waybackautosave.${key}`, el.value);
			}
		}
	};
}());
