import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	InstalledPluginEntry,
	InstalledPluginsRegistry,
	MarketplaceRegistryEntry,
	MarketplacesRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	buildPluginId,
	getInstalledPlugin,
	getMarketplaceEntry,
	isValidNameSegment,
	parsePluginId,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Inline the parseClaudePluginsRegistry validation logic to avoid pulling
// in discovery/helpers.ts which transitively imports @oh-my-pi/pi-natives.
// Matches the exact checks in helpers.ts parseClaudePluginsRegistry().
function validateClaudeRegistryFormat(content: string): Record<string, unknown> | null {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(content);
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

// ── ID helpers ───────────────────────────────────────────────────────

describe("isValidNameSegment", () => {
	it("accepts lowercase alphanumeric with hyphens", () => {
		expect(isValidNameSegment("hello")).toBe(true);
		expect(isValidNameSegment("my-plugin")).toBe(true);
		expect(isValidNameSegment("a1-b2-c3")).toBe(true);
		expect(isValidNameSegment("x")).toBe(true);
	});

	it("rejects invalid segments", () => {
		expect(isValidNameSegment("")).toBe(false);
		expect(isValidNameSegment("Hello")).toBe(false);
		expect(isValidNameSegment("my plugin")).toBe(false);
		expect(isValidNameSegment("my@plugin")).toBe(false);
		expect(isValidNameSegment("my/plugin")).toBe(false);
		expect(isValidNameSegment("-leading")).toBe(false);
		expect(isValidNameSegment("trailing-")).toBe(false);
		expect(isValidNameSegment("UPPER")).toBe(false);
		expect(isValidNameSegment("a".repeat(65))).toBe(false);
	});
});

describe("buildPluginId / parsePluginId", () => {
	it("round-trips valid IDs", () => {
		const id = buildPluginId("my-plugin", "my-market");
		expect(id).toBe("my-plugin@my-market");

		const parsed = parsePluginId(id);
		expect(parsed).toEqual({ name: "my-plugin", marketplace: "my-market" });
	});

	it("buildPluginId rejects invalid names", () => {
		expect(() => buildPluginId("Bad", "market")).toThrow(/Invalid plugin name/);
		expect(() => buildPluginId("ok", "Bad Market")).toThrow(/Invalid marketplace name/);
	});

	it("buildPluginId rejects combined length > 128", () => {
		const longName = "a".repeat(64);
		const longMarket = "b".repeat(64);
		// 64 + "@" + 64 = 129 > 128
		expect(() => buildPluginId(longName, longMarket)).toThrow(/exceeds 128/);
	});

	it("parsePluginId returns null for missing @", () => {
		expect(parsePluginId("no-at-sign")).toBeNull();
	});

	it("parsePluginId returns null for @ at start or end", () => {
		expect(parsePluginId("@market")).toBeNull();
		expect(parsePluginId("plugin@")).toBeNull();
	});

	it("parsePluginId returns null for invalid segments", () => {
		expect(parsePluginId("BAD@market")).toBeNull();
		expect(parsePluginId("plugin@BAD")).toBeNull();
	});

	it("parsePluginId splits on last @", () => {
		// "a@b" is not a valid name segment (contains @), so this returns null
		expect(parsePluginId("a@b@c")).toBeNull();
	});
});

// ── Marketplace CRUD (pure functions) ────────────────────────────────

describe("marketplace registry CRUD", () => {
	const entry: MarketplaceRegistryEntry = {
		name: "test-market",
		sourceType: "local",
		sourceUri: "/tmp/market",
		catalogPath: "/tmp/market/catalog.json",
		addedAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
	};
	const empty: MarketplacesRegistry = { version: 1, marketplaces: [] };

	it("addMarketplaceEntry + getMarketplaceEntry round-trip", () => {
		const reg = addMarketplaceEntry(empty, entry);
		expect(getMarketplaceEntry(reg, "test-market")).toEqual(entry);
	});

	it("addMarketplaceEntry throws on duplicate", () => {
		const reg = addMarketplaceEntry(empty, entry);
		expect(() => addMarketplaceEntry(reg, entry)).toThrow(/already exists/);
	});

	it("removeMarketplaceEntry removes entry, leaves others", () => {
		const other: MarketplaceRegistryEntry = { ...entry, name: "other" };
		let reg = addMarketplaceEntry(empty, entry);
		reg = addMarketplaceEntry(reg, other);
		reg = removeMarketplaceEntry(reg, "test-market");
		expect(getMarketplaceEntry(reg, "test-market")).toBeUndefined();
		expect(getMarketplaceEntry(reg, "other")).toEqual(other);
	});

	it("removeMarketplaceEntry throws on not found", () => {
		expect(() => removeMarketplaceEntry(empty, "ghost")).toThrow(/not found/);
	});
});

// ── Installed plugin CRUD (pure functions) ───────────────────────────

describe("installed plugin CRUD", () => {
	const entry: InstalledPluginEntry = {
		scope: "user",
		installPath: "/tmp/plugins/cache/my-market--my-plugin--1.0.0",
		version: "1.0.0",
		installedAt: "2025-01-01T00:00:00.000Z",
		lastUpdated: "2025-01-01T00:00:00.000Z",
	};
	const empty: InstalledPluginsRegistry = { version: 2, plugins: {} };

	it("addInstalledPlugin + getInstalledPlugin round-trip", () => {
		const id = "my-plugin@my-market";
		const reg = addInstalledPlugin(empty, id, entry);
		expect(getInstalledPlugin(reg, id)).toEqual([entry]);
	});

	it("addInstalledPlugin appends to existing entries for same ID", () => {
		const id = "my-plugin@my-market";
		const entry2: InstalledPluginEntry = {
			...entry,
			version: "2.0.0",
			installPath: "/tmp/plugins/cache/my-market--my-plugin--2.0.0",
		};
		let reg = addInstalledPlugin(empty, id, entry);
		reg = addInstalledPlugin(reg, id, entry2);
		expect(getInstalledPlugin(reg, id)).toEqual([entry, entry2]);
	});

	it("removeInstalledPlugin removes all entries for that ID", () => {
		const id = "my-plugin@my-market";
		const otherId = "other@other";
		const otherEntry: InstalledPluginEntry = { ...entry, installPath: "/other" };
		let reg = addInstalledPlugin(empty, id, entry);
		reg = addInstalledPlugin(reg, otherId, otherEntry);
		reg = removeInstalledPlugin(reg, id);
		expect(getInstalledPlugin(reg, id)).toBeUndefined();
		expect(getInstalledPlugin(reg, otherId)).toEqual([otherEntry]);
	});

	it("removeInstalledPlugin throws on not found", () => {
		expect(() => removeInstalledPlugin(empty, "ghost@nowhere")).toThrow(/not found/);
	});
});

// ── Registry file I/O ────────────────────────────────────────────────
// Tests use temp directory paths directly — no singleton override needed.

describe("registry file I/O", () => {
	let tmpDir: string;
	let marketplacesPath: string;
	let installedPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mkt-test-"));
		marketplacesPath = path.join(tmpDir, "marketplaces.json");
		installedPath = path.join(tmpDir, "installed_plugins.json");
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	// ── Marketplaces registry ────────────────────────────────────────

	it("readMarketplacesRegistry returns empty on missing file", async () => {
		const reg = await readMarketplacesRegistry(marketplacesPath);
		expect(reg).toEqual({ version: 1, marketplaces: [] });
	});

	it("readMarketplacesRegistry returns empty on malformed JSON", async () => {
		await Bun.write(marketplacesPath, "not json{{{");
		const reg = await readMarketplacesRegistry(marketplacesPath);
		expect(reg).toEqual({ version: 1, marketplaces: [] });
	});

	it("marketplaces registry round-trip", async () => {
		const entry: MarketplaceRegistryEntry = {
			name: "test-market",
			sourceType: "github",
			sourceUri: "owner/repo",
			catalogPath: path.join(tmpDir, "cache", "marketplaces", "test-market", "marketplace.json"),
			addedAt: "2025-01-15T10:00:00.000Z",
			updatedAt: "2025-01-15T10:00:00.000Z",
		};
		const reg: MarketplacesRegistry = {
			version: 1,
			marketplaces: [entry],
		};
		await writeMarketplacesRegistry(marketplacesPath, reg);
		const read = await readMarketplacesRegistry(marketplacesPath);
		expect(read).toEqual(reg);
	});

	// ── Installed plugins registry ───────────────────────────────────

	it("readInstalledPluginsRegistry returns empty on missing file", async () => {
		const reg = await readInstalledPluginsRegistry(installedPath);
		expect(reg).toEqual({ version: 2, plugins: {} });
	});

	it("readInstalledPluginsRegistry returns empty on malformed JSON", async () => {
		await Bun.write(installedPath, "}{broken");
		const reg = await readInstalledPluginsRegistry(installedPath);
		expect(reg).toEqual({ version: 2, plugins: {} });
	});

	it("installed plugins registry round-trip", async () => {
		const entry: InstalledPluginEntry = {
			scope: "user",
			installPath: path.join(tmpDir, "cache", "plugins", "mkt--plug--1.0.0"),
			version: "1.0.0",
			installedAt: "2025-01-15T10:30:00.000Z",
			lastUpdated: "2025-01-15T10:30:00.000Z",
		};
		const reg: InstalledPluginsRegistry = {
			version: 2,
			plugins: { "plug@mkt": [entry] },
		};
		await writeInstalledPluginsRegistry(installedPath, reg);
		const read = await readInstalledPluginsRegistry(installedPath);
		expect(read).toEqual(reg);
	});

	it("written installed registry passes Claude Code registry validation", async () => {
		const entry: InstalledPluginEntry = {
			scope: "user",
			installPath: path.join(tmpDir, "cache", "plugins", "mkt--plug--1.0.0"),
			version: "1.0.0",
			installedAt: "2025-01-15T10:30:00.000Z",
			lastUpdated: "2025-01-15T10:30:00.000Z",
		};
		const reg: InstalledPluginsRegistry = {
			version: 2,
			plugins: { "plug@mkt": [entry] },
		};
		await writeInstalledPluginsRegistry(installedPath, reg);

		const content = await Bun.file(installedPath).text();
		const parsed = validateClaudeRegistryFormat(content);
		expect(parsed).not.toBeNull();
		expect(parsed!.version).toBe(2);
		const plugins = parsed!.plugins as Record<string, unknown>;
		expect(plugins["plug@mkt"]).toBeDefined();
	});

	it("atomic write leaves no .tmp file after success", async () => {
		const reg: InstalledPluginsRegistry = { version: 2, plugins: {} };
		await writeInstalledPluginsRegistry(installedPath, reg);

		const tmpFilePath = `${installedPath}.tmp`;
		expect(fs.existsSync(tmpFilePath)).toBe(false);
	});

	it("read-modify-write preserves unknown fields", async () => {
		// Write a registry with an extra field that our types don't define
		const data = {
			version: 2,
			plugins: {
				"plug@mkt": [
					{
						scope: "user",
						installPath: "/some/path",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00.000Z",
						lastUpdated: "2025-01-01T00:00:00.000Z",
						someExtraField: "preserved",
					},
				],
			},
		};
		await Bun.write(installedPath, JSON.stringify(data));

		const reg = await readInstalledPluginsRegistry(installedPath);
		const entries = getInstalledPlugin(reg, "plug@mkt");
		expect(entries).toBeDefined();
		expect((entries![0] as unknown as Record<string, unknown>).someExtraField).toBe("preserved");
	});
});
