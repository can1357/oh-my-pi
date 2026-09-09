import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MarketplacePluginEntry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { resolvePluginSource } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Fixture: a cloned marketplace with a single plugin at ./plugins/hello-plugin
const FIXTURE_DIR = path.resolve(import.meta.dir, "fixtures/valid-marketplace");

// Helper — build a minimal MarketplacePluginEntry with the given source
function makeEntry(source: MarketplacePluginEntry["source"]): MarketplacePluginEntry {
	return { name: "hello-plugin", source };
}

describe("resolvePluginSource", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-src-res-test-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	it("resolves relative source to absolute plugin directory", async () => {
		const entry = makeEntry("./plugins/hello-plugin");
		const resolved = await resolvePluginSource(entry, {
			marketplaceClonePath: FIXTURE_DIR,
			tmpDir,
		});
		expect(resolved.dir).toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
		expect(resolved.tempCloneRoot).toBeUndefined();
	});

	it("throws when source string would escape marketplace root", async () => {
		// "../../escape" does not start with "./" — hits the non-relative guard
		const entry = makeEntry("../../escape");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow();
	});

	it("throws when relative source would escape via path traversal (./../../escape)", async () => {
		// Starts with "./" but resolves outside marketplace root
		const entry = makeEntry("./../../escape");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/outside marketplace root/,
		);
	});

	it("throws when marketplaceClonePath is missing for relative source", async () => {
		const entry = makeEntry("./plugins/hello-plugin");
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/marketplaceClonePath/);
	});

	it("prepends catalogMetadata.pluginRoot to the relative source path", async () => {
		// pluginRoot "plugins" + source "./hello-plugin" → ./plugins/hello-plugin
		const entry = makeEntry("./hello-plugin");
		const resolved = await resolvePluginSource(entry, {
			marketplaceClonePath: FIXTURE_DIR,
			catalogMetadata: { pluginRoot: "plugins" },
			tmpDir,
		});
		expect(resolved.dir).toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
		expect(resolved.tempCloneRoot).toBeUndefined();
	});

	// Network-dependent: object sources attempt real git clones
	it.skip("resolves github object source via git clone", async () => {
		const entry = makeEntry({ source: "github", repo: "nonexistent-owner/nonexistent-repo" });
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/git clone failed/,
		);
	});

	it.skip("resolves url object source via git clone", async () => {
		const entry = makeEntry({ source: "url", url: "https://example.com/nonexistent.git" });
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/git clone failed/,
		);
	});

	it("throws when resolved directory does not exist", async () => {
		const entry = makeEntry("./plugins/nonexistent-plugin");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/does not exist/,
		);
	});
});
