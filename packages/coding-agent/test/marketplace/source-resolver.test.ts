import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MarketplacePluginEntry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { resolvePluginSource, validatePluginSource } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
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

	it("validates relative sources without mutating or cloning", async () => {
		await expect(
			validatePluginSource(makeEntry("./plugins/hello-plugin"), { marketplaceClonePath: FIXTURE_DIR }),
		).resolves.toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
	});

	it("rejects unsupported npm sources during validation", async () => {
		await expect(validatePluginSource(makeEntry({ source: "npm", package: "hello-plugin" }), {})).rejects.toThrow(
			/npm plugin sources are not yet supported/,
		);
	});

	it("rejects git-subdir traversal during validation", async () => {
		await expect(
			validatePluginSource(makeEntry({ source: "git-subdir", url: "owner/repo", path: "../../escape" }), {}),
		).rejects.toThrow(/escapes the cloned repository/);
	});

	it("allows git-subdir parent segments that remain contained", async () => {
		await expect(
			validatePluginSource(
				makeEntry({ source: "git-subdir", url: "owner/repo", path: "packages/../plugins/foo" }),
				{},
			),
		).resolves.toBeUndefined();
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

	it("resolves bare names under catalogMetadata.pluginRoot and ./ sources from the marketplace root", async () => {
		const expected = path.resolve(FIXTURE_DIR, "plugins/hello-plugin");
		const resolve = (source: string, pluginRoot: string) =>
			resolvePluginSource(makeEntry(source), {
				marketplaceClonePath: FIXTURE_DIR,
				catalogMetadata: { pluginRoot },
				tmpDir,
			});
		expect((await resolve("hello-plugin", "./plugins")).dir).toBe(expected);
		expect((await resolve("./plugins/hello-plugin", "./plugins")).dir).toBe(expected);
		const legacy = await resolve("./hello-plugin", "plugins");
		expect(legacy.dir).toBe(expected);
	});

	it("prefers a ./ source that exists from the marketplace root over the same path under pluginRoot", async () => {
		const root = path.join(tmpDir, "marketplace");
		fs.mkdirSync(path.join(root, "tools"), { recursive: true });
		fs.mkdirSync(path.join(root, "plugins", "tools"), { recursive: true });
		const resolved = await validatePluginSource(makeEntry("./tools"), {
			marketplaceClonePath: root,
			catalogMetadata: { pluginRoot: "./plugins" },
		});
		expect(resolved).toBe(path.join(root, "tools"));
	});

	it("falls back to pluginRoot when a file shadows the ./ path's first segment", async () => {
		const root = path.join(tmpDir, "marketplace");
		fs.mkdirSync(path.join(root, "plugins", "team", "plugin"), { recursive: true });
		fs.writeFileSync(path.join(root, "team"), "");
		const resolved = await validatePluginSource(makeEntry("./team/plugin"), {
			marketplaceClonePath: root,
			catalogMetadata: { pluginRoot: "plugins" },
		});
		expect(resolved).toBe(path.join(root, "plugins", "team", "plugin"));
	});

	it("does not fall back to pluginRoot when the primary probe fails with a filesystem error", async () => {
		const root = path.join(tmpDir, "marketplace");
		fs.mkdirSync(path.join(root, "plugins", "loop"), { recursive: true });
		fs.symlinkSync("loop", path.join(root, "loop"), "dir");
		await expect(
			validatePluginSource(makeEntry("./loop"), {
				marketplaceClonePath: root,
				catalogMetadata: { pluginRoot: "plugins" },
			}),
		).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("falls back to pluginRoot when the marketplace is reached through a symlink", async () => {
		const real = path.join(tmpDir, "real");
		fs.mkdirSync(path.join(real, "plugins", "foo"), { recursive: true });
		const link = path.join(tmpDir, "link");
		fs.symlinkSync(real, link, "dir");
		const resolved = await validatePluginSource(makeEntry("./foo"), {
			marketplaceClonePath: link,
			catalogMetadata: { pluginRoot: "plugins" },
		});
		expect(resolved).toBe(path.join(link, "plugins", "foo"));
	});

	it("throws when resolved directory does not exist", async () => {
		const entry = makeEntry("./plugins/nonexistent-plugin");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/does not exist/,
		);
	});
});
