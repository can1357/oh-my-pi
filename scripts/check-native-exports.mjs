#!/usr/bin/env node
// Fail fast when the checkout's native export surface differs from the
// release addon PR CI tests against. Without this, every missing export
// surfaces as a scattered `X is not a function` TypeError deep in some test
// shard; with it, one step names the missing exports and the fix (wait for
// the next @oh-my-pi/pi-natives release, or port the consumer to TS per
// 95337cf2) is obvious.
//
// Usage: node scripts/check-native-exports.mjs <addon.node> [<addon.node> ...]
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const INDEX = "packages/natives/native/index.js";

// A gate that passes vacuously is worse than no gate: zero addon arguments
// would otherwise loop zero times, find zero missing exports, and exit 0
// while checking nothing.
const addons = process.argv.slice(2);
if (addons.length === 0) {
	console.error(`usage: node scripts/check-native-exports.mjs <addon.node> [<addon.node> ...]`);
	process.exit(1);
}

// Every `nativeBindings.<key>` reference in index.js is a symbol the surface
// requires: plain re-exports (`export const X = nativeBindings.X;`) and
// adapted ones alike (`export const DesktopSession = adaptDesktopSession(
// nativeBindings.DesktopSession)`). A regex pinned to the plain re-export
// shape silently skips adapted bindings, and an addon missing that class
// would pass while constructing the export crashes. Match all references.
const source = fs.readFileSync(INDEX, "utf8");
const expected = new Set();
for (const match of source.matchAll(/nativeBindings\??\.([A-Za-z_$][\w$]*)/g)) {
	// `__piNativesV*` is the loader's version sentinel. It moves every
	// release and the committed index.js lags it by design; loadNative()
	// resolves the addon's own sentinel, so a sentinel mismatch is not a
	// missing export and must not fail the check.
	if (!match[1].startsWith("__piNatives")) expected.add(match[1]);
}
if (expected.size === 0) {
	console.error(`no native exports parsed from ${INDEX}; the parser no longer matches the generated shape`);
	process.exit(1);
}

const require = createRequire(import.meta.url);
const missing = [];
const extras = [];
for (const addonArg of addons) {
	const addonPath = path.resolve(addonArg);
	const addon = require(addonPath);
	const actual = new Set(Object.keys(addon));
	for (const name of expected) {
		if (!actual.has(name)) missing.push(`${path.basename(addonPath)}: ${name}`);
	}
	for (const name of actual) {
		if (!expected.has(name)) extras.push(name);
	}
}
if (extras.length > 0) {
	const unique = [...new Set(extras)].sort();
	console.error(
		`note: the release addon exports ${unique.length} symbol(s) not re-exported verbatim by ${INDEX} (e.g. ${unique.slice(0, 5).join(", ")})`,
	);
}

if (missing.length > 0) {
	console.error(`the fetched release addon predates ${missing.length} export(s) the checkout expects:`);
	for (const line of missing.sort()) console.error(`  missing ${line}`);
	console.error(
		"PR CI tests against the latest release addon by design; native changes are validated post-merge on main and at release. Wait for the next @oh-my-pi/pi-natives release, or drop the napi export and port the consumer to TS if the behavior is pure (precedent: 95337cf2).",
	);
	process.exit(1);
}
console.log(`all ${expected.size} native exports present in the release addon(s)`);
