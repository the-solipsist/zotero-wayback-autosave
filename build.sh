#!/bin/sh
# Build wayback-autosave.xpi from this directory.
# Wayback Autosave for Zotero. Copyright (C) 2026 Pranesh Prakash.
# SPDX-License-Identifier: GPL-3.0-or-later. See COPYING.
set -e
cd "$(dirname "$0")"
rm -f wayback-autosave.xpi
zip -q -r wayback-autosave.xpi manifest.json bootstrap.js prefs.js content/ skin/ -x '*/.*'
ls -la wayback-autosave.xpi
