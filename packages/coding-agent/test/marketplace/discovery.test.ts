/**
 * Discovery integration tests for OMP plugin registry reading.
 *
 * NOTE: listClaudePluginRoots() lives in discovery/helpers.ts which imports
 * @oh-my-pi/pi-natives (native Rust addon via glob). We cannot call it here.
 *
 * Instead these tests validate the structural contract that listClaudePluginRoots
 * depends on:
 *   1. OMP registry lives at path.join(home, ".omp", "plugins", "installed_plugins.json")
 *      (matches getConfigDirName() == ".omp")
 *   2. The registry format passes the same validator that parseClaudePluginsRegistry uses
 *   3. readInstalledPluginsRegistry / writeInstalledPluginsRegistry produce files that
 *      satisfy that validator
 *
 * End-to-end wiring (calling listClaudePluginRoots) is covered by wiring.test.ts,
 * which runs in an environment where the native addon is available.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstalledPluginEntry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import {
	addInstalledPlugin,
	buildPluginId,
	readInstalledPluginsRegistry,
	writeInstalledPluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// ── Inline validator ───────────────────────────────────────────────────────────
//
// Mirrors parseClaudePluginsRegistry() in discovery/helpers.ts exactly.
// Kept here to avoid importing helpers.ts (which pulls in @oh-my-pi/pi-natives).
function validateClaudeRegistryFormat(content: string): Record<string, unknown> | null {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	if (
		typeof data.version !== "number" ||
		!data.plugins ||
		typeof data.plugins !== "object" ||
		Array.isArray(data.plugins)
	)
		return null;
	return data;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Matches getConfigDirName() — single source of truth is in @oh-my-pi/pi-utils,
// but we know the value is ".omp" and hardcoding it here keeps tests free of
// native-addon transitive imports.
const OMP_CONFIG_DIR = ".omp";

function makeEntry(installPath: string, version = "1.0.0"): InstalledPluginEntry {
	return {
		scope: "user",
		installPath,
		version,
		installedAt: "2025-01-15T10:30:00.000Z",
		lastUpdated: "2025-01-15T10:30:00.000Z",
	};
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpHome: string;
/** ~/.omp/plugins/installed_plugins.json inside tmpHome */
let ompRegistryPath: string;

beforeEach(() => {
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-discovery-test-"));
	ompRegistryPath = path.join(tmpHome, OMP_CONFIG_DIR, "plugins", "installed_plugins.json");
	fs.mkdirSync(path.dirname(ompRegistryPath), { recursive: true });
});

afterEach(() => {
	removeSyncWithRetries(tmpHome);
});

// ── Path contract ─────────────────────────────────────────────────────────────

describe("OMP registry path contract", () => {
	it("OMP registry lives at home/.omp/plugins/installed_plugins.json", () => {
		// This is the path that listClaudePluginRoots reads.
		// Any change to this path must be reflected in helpers.ts.
		const expected = path.join(tmpHome, ".omp", "plugins", "installed_plugins.json");
		expect(ompRegistryPath).toBe(expected);
	});
});

// ── Format compatibility ───────────────────────────────────────────────────────

describe("OMP registry format compatibility with Claude parser", () => {
	it("empty registry written by writeInstalledPluginsRegistry passes validator", async () => {
		await writeInstalledPluginsRegistry(ompRegistryPath, { version: 2, plugins: {} });

		const content = fs.readFileSync(ompRegistryPath, "utf8");
		const parsed = validateClaudeRegistryFormat(content);
		expect(parsed).not.toBeNull();
		expect((parsed as Record<string, unknown>).version).toBe(2);
	});

	it("registry with installed plugin passes validator", async () => {
		const pluginId = buildPluginId("quality-review", "example-marketplace");
		const entry = makeEntry(path.join(tmpHome, "plugins", "cache", "example-marketplace--quality-review--1.0.0"));

		let reg = await readInstalledPluginsRegistry(ompRegistryPath);
		reg = addInstalledPlugin(reg, pluginId, entry);
		await writeInstalledPluginsRegistry(ompRegistryPath, reg);

		const content = fs.readFileSync(ompRegistryPath, "utf8");
		const parsed = validateClaudeRegistryFormat(content);
		expect(parsed).not.toBeNull();

		const plugins = (parsed as { plugins: Record<string, unknown[]> }).plugins;
		expect(Array.isArray(plugins[pluginId])).toBe(true);
		expect((plugins[pluginId] as InstalledPluginEntry[])[0]?.installPath).toBe(entry.installPath);
	});

	it("file with missing version field fails validator (regression)", () => {
		// Ensures validator correctly rejects what parseClaudePluginsRegistry rejects.
		const badContent = JSON.stringify({ plugins: {} });
		expect(validateClaudeRegistryFormat(badContent)).toBeNull();
	});

	it("file with plugins as array fails validator (regression)", () => {
		const badContent = JSON.stringify({ version: 2, plugins: [] });
		expect(validateClaudeRegistryFormat(badContent)).toBeNull();
	});

	it("file with non-numeric version fails validator (regression)", () => {
		const badContent = JSON.stringify({ version: "2", plugins: {} });
		expect(validateClaudeRegistryFormat(badContent)).toBeNull();
	});
});

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("OMP registry round-trip", () => {
	it("reads back what was written — single plugin", async () => {
		const id = buildPluginId("hello-plugin", "test-marketplace");
		const entry = makeEntry("/tmp/fake-plugin-path");

		let reg = await readInstalledPluginsRegistry(ompRegistryPath);
		reg = addInstalledPlugin(reg, id, entry);
		await writeInstalledPluginsRegistry(ompRegistryPath, reg);

		const readBack = await readInstalledPluginsRegistry(ompRegistryPath);
		expect(readBack.plugins[id]).toBeDefined();
		expect(readBack.plugins[id]?.[0]?.installPath).toBe(entry.installPath);
		expect(readBack.plugins[id]?.[0]?.version).toBe("1.0.0");
		expect(readBack.plugins[id]?.[0]?.scope).toBe("user");
	});

	it("reads back what was written — multiple plugins", async () => {
		const id1 = buildPluginId("plugin-a", "mkt");
		const id2 = buildPluginId("plugin-b", "mkt");
		const entry1 = makeEntry("/tmp/fake-a", "1.0.0");
		const entry2 = makeEntry("/tmp/fake-b", "2.0.0");

		let reg = await readInstalledPluginsRegistry(ompRegistryPath);
		reg = addInstalledPlugin(reg, id1, entry1);
		reg = addInstalledPlugin(reg, id2, entry2);
		await writeInstalledPluginsRegistry(ompRegistryPath, reg);

		const readBack = await readInstalledPluginsRegistry(ompRegistryPath);
		expect(Object.keys(readBack.plugins)).toHaveLength(2);
		expect(readBack.plugins[id1]?.[0]?.version).toBe("1.0.0");
		expect(readBack.plugins[id2]?.[0]?.version).toBe("2.0.0");
	});

	it("reads back scope:project entry — scope is preserved through registry round-trip", async () => {
		const id = buildPluginId("proj-plugin", "test-marketplace");
		const entry: InstalledPluginEntry = {
			scope: "project",
			installPath: path.join(os.tmpdir(), "fake-project-plugin"),
			version: "1.0.0",
			installedAt: "2025-01-15T10:30:00.000Z",
			lastUpdated: "2025-01-15T10:30:00.000Z",
		};

		let reg = await readInstalledPluginsRegistry(ompRegistryPath);
		reg = addInstalledPlugin(reg, id, entry);
		await writeInstalledPluginsRegistry(ompRegistryPath, reg);

		const readBack = await readInstalledPluginsRegistry(ompRegistryPath);
		expect(readBack.plugins[id]?.[0]?.scope).toBe("project");
	});

	it("missing file returns empty registry (not an error)", async () => {
		// listClaudePluginRoots treats absent file as empty, not a failure.
		// readInstalledPluginsRegistry must match this behaviour.
		const missingPath = path.join(tmpHome, "nonexistent", "installed_plugins.json");
		const reg = await readInstalledPluginsRegistry(missingPath);
		expect(reg).toEqual({ version: 2, plugins: {} });
	});
});

// ── Precedence contract (structural) ─────────────────────────────────────────
//
// listClaudePluginRoots must replace Claude entries with OMP entries when the same
// plugin ID appears in both registries. We cannot call that function here, but we
// can verify the data shapes that the replacement logic reads are correct.

describe("OMP precedence contract (registry structure)", () => {
	it("same plugin ID in both registries — OMP entry has required fields for deduplication", () => {
		// The replacement logic: roots.filter(r => r.id !== pluginId) keyed by id.
		// OMP entries must have installPath so they can be added to roots[].
		const id = buildPluginId("shared-plugin", "common-mkt");
		const ompEntry = makeEntry("/omp/cached/path");

		// OMP registry entry has installPath (required by listClaudePluginRoots)
		expect(ompEntry.installPath).toBeTruthy();
		expect(typeof ompEntry.installPath).toBe("string");
		// ID parses correctly with lastIndexOf("@")
		const atIndex = id.lastIndexOf("@");
		expect(atIndex).toBeGreaterThan(0);
		expect(id.slice(0, atIndex)).toBe("shared-plugin");
		expect(id.slice(atIndex + 1)).toBe("common-mkt");
	});
});
