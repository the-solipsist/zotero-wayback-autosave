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

/* exported install, startup, onMainWindowLoad, onMainWindowUnload, shutdown, uninstall */

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	Services.scriptloader.loadSubScript(`${rootURI}content/wayback.js`);
	Zotero.WaybackAutosave.init({ id, version, rootURI });
	await Zotero.WaybackAutosave.startup();
}

function onMainWindowLoad({ window }) {
	Zotero.WaybackAutosave?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	Zotero.WaybackAutosave?.removeFromWindow(window);
}

function shutdown() {
	if (Zotero.WaybackAutosave) {
		Zotero.WaybackAutosave.shutdown();
		delete Zotero.WaybackAutosave;
	}
}

function uninstall() {}
