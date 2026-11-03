import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cachePlugin,
	getCachedPluginPath,
	isCached,
	isValidVersionForCache,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// ── Helpers ─────────────────────────────────────────────────────────────────

async function mkSourcePlugin(baseDir: string, name: string): Promise<string> {
	const pluginDir = path.join(baseDir, name);
	await fsp.mkdir(pluginDir, { recursive: true });
	await fsp.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ name }));
	return pluginDir;
}

// ── isValidVersionForCache ───────────────────────────────────────────────────

describe("isValidVersionForCache", () => {
	it("accepts common valid version strings", () => {
		expect(isValidVersionForCache("1.0.0")).toBe(true);
		expect(isValidVersionForCache("v2.0.0-beta.1")).toBe(true);
		expect(isValidVersionForCache("abc123")).toBe(true);
		expect(isValidVersionForCache("1.0.0+build.42")).toBe(true);
		expect(isValidVersionForCache("a")).toBe(true);
	});

	it("rejects empty string", () => {
		expect(isValidVersionForCache("")).toBe(false);
	});

	it("rejects double-dot (path traversal attempt)", () => {
		expect(isValidVersionForCache("..")).toBe(false);
	});

	it("rejects forward slash", () => {
		expect(isValidVersionForCache("1.0/0")).toBe(false);
	});

	it("rejects backslash", () => {
		expect(isValidVersionForCache("1.0\\0")).toBe(false);
	});

	it("rejects strings exceeding 128 characters", () => {
		expect(isValidVersionForCache("a".repeat(129))).toBe(false);
		expect(isValidVersionForCache("a".repeat(128))).toBe(true);
	});
});

// ── getCachedPluginPath ──────────────────────────────────────────────────────

describe("getCachedPluginPath", () => {
	it("accepts a mixed-case marketplace name", () => {
		expect(getCachedPluginPath("/cache", "HexRaysSA", "plugin", "1.0.0")).toBe(
			path.join("/cache", "HexRaysSA___plugin___1.0.0"),
		);
	});

	it("throws on invalid marketplace name (slash)", () => {
		expect(() => getCachedPluginPath("/cache", "a/b", "plugin", "1.0.0")).toThrow(/Invalid marketplace name/);
	});

	it("throws on invalid plugin name (space)", () => {
		expect(() => getCachedPluginPath("/cache", "market", "bad plugin", "1.0.0")).toThrow(/Invalid plugin name/);
	});

	it("throws on invalid version containing ..", () => {
		expect(() => getCachedPluginPath("/cache", "market", "plugin", "..")).toThrow(/Invalid version/);
	});
});

// ── cachePlugin / isCached ───────────────────────────────────────────────────

describe("cachePlugin, isCached", () => {
	let tmpDir: string;
	let cacheDir: string;
	let sourceDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cache-test-"));
		cacheDir = path.join(tmpDir, "cache");
		sourceDir = path.join(tmpDir, "sources");
		await fsp.mkdir(sourceDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	it("isCached returns false before caching", async () => {
		await mkSourcePlugin(sourceDir, "my-plugin");
		expect(isCached(cacheDir, "my-market", "my-plugin", "1.0.0")).toBe(false);
	});

	it("cachePlugin copies the directory and returns absolute cache path", async () => {
		const sourcePath = await mkSourcePlugin(sourceDir, "my-plugin");
		const cached = await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");

		expect(cached).toBe(path.join(cacheDir, "my-market___my-plugin___1.0.0"));
		expect(fs.existsSync(cached)).toBe(true);
		expect(fs.existsSync(path.join(cached, "plugin.json"))).toBe(true);
	});

	it("isCached returns true after cachePlugin", async () => {
		const sourcePath = await mkSourcePlugin(sourceDir, "my-plugin");
		await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");
		expect(isCached(cacheDir, "my-market", "my-plugin", "1.0.0")).toBe(true);
	});

	it("re-caching a version whose directory exists writes a fresh sibling and leaves the old copy untouched", async () => {
		const sourcePath = await mkSourcePlugin(sourceDir, "my-plugin");
		const first = await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");
		const original = await Bun.file(path.join(first, "plugin.json")).text();
		await fsp.writeFile(path.join(sourcePath, "plugin.json"), "rebuilt");

		// A running session keeps reading the copy it loaded.
		const second = await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");
		const third = await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");

		expect(second).toBe(`${first}___2`);
		expect(third).toBe(`${first}___3`);
		expect(await Bun.file(path.join(first, "plugin.json")).text()).toBe(original);
		expect(await Bun.file(path.join(second, "plugin.json")).text()).toBe("rebuilt");
	});

	it("a failed copy leaves no directory at the target and runs beforeCopy with the target first", async () => {
		const targets: string[] = [];
		await expect(
			cachePlugin(path.join(sourceDir, "missing"), cacheDir, "my-market", "my-plugin", "1.0.0", async target => {
				targets.push(target);
			}),
		).rejects.toThrow();
		expect(targets).toEqual([path.join(cacheDir, "my-market___my-plugin___1.0.0")]);
		expect(fs.readdirSync(cacheDir)).toEqual([]);
	});
});
