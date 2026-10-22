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
const INDEX_TYPES = "packages/natives/native/index.d.ts";

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
// `__piNativesV<version>` is the loader's version sentinel. It moves every release and the
// committed index.js lags it by design; loadNative() resolves the addon's own sentinel, so a
// sentinel mismatch is not a missing export. `__piNativesBuildVersion` is a stable public
// function that index.js re-exports, so only the versioned names are exempt.
const VERSION_SENTINEL = /^__piNativesV\d/;

const source = fs.readFileSync(INDEX, "utf8");
const expected = new Set();
for (const match of source.matchAll(/nativeBindings\??\.([A-Za-z_$][\w$]*)/g)) {
	if (!VERSION_SENTINEL.test(match[1])) expected.add(match[1]);
}
if (expected.size === 0) {
	console.error(`no native exports parsed from ${INDEX}; the parser no longer matches the generated shape`);
	process.exit(1);
}

// index.js keeps a single `nativeBindings.<Class>` reference when a native PR adds a method to an
// existing napi class, so only the generated typings show the new member. An addon that predates
// it would pass the export check and the consumer would fail later with "... is not a function".
// Read each `export declare class` body from index.d.ts and check the addon's constructor
// (statics) and prototype (instance methods, accessors and properties) carry every member.
const CLASS_START = /^export declare class ([A-Za-z_$][\w$]*)\b/;
const CLASS_MEMBER = /^ {2}(static\s+)?(?:readonly\s+)?(?:(?:get|set)\s+)?([A-Za-z_$][\w$]*)\??\s*[(:<]/;
function declaredClassMembers(typings) {
	const classes = new Map();
	let current;
	let inComment = false;
	for (const line of typings.split("\n")) {
		if (!current) {
			const start = CLASS_START.exec(line);
			if (start) {
				current = { statics: new Set(), instance: new Set() };
				classes.set(start[1], current);
			}
			continue;
		}
		if (line.startsWith("}")) {
			current = undefined;
			continue;
		}
		const trimmed = line.trim();
		if (inComment) {
			if (trimmed.includes("*/")) inComment = false;
			continue;
		}
		if (trimmed.startsWith("/*")) {
			if (!trimmed.includes("*/")) inComment = true;
			continue;
		}
		const member = CLASS_MEMBER.exec(line);
		if (!member || member[2] === "constructor") continue;
		(member[1] ? current.statics : current.instance).add(member[2]);
	}
	return classes;
}
const classMembers = declaredClassMembers(fs.readFileSync(INDEX_TYPES, "utf8"));

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
	for (const [className, members] of classMembers) {
		const ctor = addon[className];
		// A class missing outright is already reported above.
		if (typeof ctor !== "function") continue;
		for (const member of members.statics) {
			if (!(member in ctor)) missing.push(`${path.basename(addonPath)}: ${className}.${member}`);
		}
		for (const member of members.instance) {
			if (!(member in ctor.prototype)) missing.push(`${path.basename(addonPath)}: ${className}#${member}`);
		}
	}
	for (const name of actual) {
		// Every addon exports its own versioned sentinel, which `expected` skips above, so it
		// would always land here and print a false extras note.
		if (!expected.has(name) && !VERSION_SENTINEL.test(name)) extras.push(name);
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
