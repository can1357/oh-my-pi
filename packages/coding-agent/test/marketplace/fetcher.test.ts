import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifySource,
	fetchMarketplace,
	parseMarketplaceCatalog,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Fixture lives at test/marketplace/fixtures/valid-marketplace/
const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "valid-marketplace");

// ── classifySource ────────────────────────────────────────────────────

describe("classifySource", () => {
	// ── local ─────────────────────────────────────────────────────────

	it("classifies './' prefix as local", () => {
		expect(classifySource("./my-marketplace")).toBe("local");
	});

	it("classifies POSIX absolute path as local", () => {
		expect(classifySource("/abs/path")).toBe("local");
	});

	it("classifies '~/' prefix as local", () => {
		expect(classifySource("~/my-marketplace")).toBe("local");
	});

	it("classifies Windows absolute path as local", () => {
		// C:\Users\me\marketplace — path.isAbsolute returns false on POSIX,
		// so the WIN_ABS_RE fallback must handle this.
		expect(classifySource("C:\\Users\\me\\marketplace")).toBe("local");
	});

	// ── url ───────────────────────────────────────────────────────────

	it("classifies https .json URL as url", () => {
		expect(classifySource("https://example.com/marketplace.json")).toBe("url");
	});

	// ── git ───────────────────────────────────────────────────────────

	it("classifies https non-.json URL as git", () => {
		expect(classifySource("https://github.com/owner/repo.git")).toBe("git");
	});

	it("classifies git@ SCP-style URL as git", () => {
		expect(classifySource("git@github.com:owner/repo.git")).toBe("git");
	});

	it("classifies ssh:// URL as git", () => {
		expect(classifySource("ssh://git@github.com/owner/repo")).toBe("git");
	});

	// ── github ────────────────────────────────────────────────────────

	it("classifies owner/repo shorthand as github", () => {
		expect(classifySource("owner/repo")).toBe("github");
	});

	// ── errors ────────────────────────────────────────────────────────

	it("throws on bare name with suggestion", () => {
		expect(() => classifySource("just-a-name")).toThrow(
			"Unrecognized source format. Did you mean './just-a-name' (local) or 'owner/repo' (GitHub)?",
		);
	});
});

// ── parseMarketplaceCatalog ───────────────────────────────────────────

describe("parseMarketplaceCatalog", () => {
	const VALID = JSON.stringify({
		name: "test-marketplace",
		owner: { name: "Test Author", email: "test@example.com" },
		metadata: { description: "A test marketplace" },
		plugins: [{ name: "hello-plugin", source: "./plugins/hello-plugin", description: "Greets" }],
	});

	it("parses a valid catalog", () => {
		const catalog = parseMarketplaceCatalog(VALID, "/fake/marketplace.json");
		expect(catalog.name).toBe("test-marketplace");
		expect(catalog.owner.name).toBe("Test Author");
		expect(catalog.plugins).toHaveLength(1);
		expect(catalog.plugins[0].name).toBe("hello-plugin");
	});

	it("throws on missing name", () => {
		const bad = JSON.stringify({ owner: { name: "x" }, plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"name"/);
	});

	it("throws when name fails isValidNameSegment", () => {
		const bad = JSON.stringify({ name: "Invalid Name", owner: { name: "x" }, plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"name"/);
	});

	it("throws on missing plugins", () => {
		const bad = JSON.stringify({ name: "valid-name", owner: { name: "x" } });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"plugins"/);
	});

	it("throws on missing owner", () => {
		const bad = JSON.stringify({ name: "valid-name", plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"owner"/);
	});

	it("empty plugins array is valid", () => {
		const catalog = parseMarketplaceCatalog(
			JSON.stringify({ name: "valid-name", owner: { name: "x" }, plugins: [] }),
			"/f.json",
		);
		expect(catalog.plugins).toHaveLength(0);
	});

	it("preserves extra fields in output", () => {
		const extra = JSON.stringify({
			name: "my-market",
			owner: { name: "x" },
			plugins: [],
			myCustomField: "preserved",
			anotherExtra: 42,
		});
		const catalog = parseMarketplaceCatalog(extra, "/f.json") as unknown as Record<string, unknown>;
		expect(catalog.myCustomField).toBe("preserved");
		expect(catalog.anotherExtra).toBe(42);
	});

	it("accepts plugin with object source (typed source object)", () => {
		const content = JSON.stringify({
			name: "my-market",
			owner: { name: "x" },
			plugins: [{ name: "p1", source: { source: "github", repo: "owner/repo" } }],
		});
		const catalog = parseMarketplaceCatalog(content, "/f.json");
		expect(catalog.plugins[0].name).toBe("p1");
	});

	it("throws on invalid JSON", () => {
		expect(() => parseMarketplaceCatalog("{not json", "/f.json")).toThrow(
			"Failed to parse marketplace catalog at /f.json",
		);
	});
});

// ── fetchMarketplace ──────────────────────────────────────────────────

describe("fetchMarketplace", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fetcher-test-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	it("resolves catalog from fixture directory", async () => {
		const result = await fetchMarketplace(FIXTURE_DIR, tmpDir);
		expect(result.catalog.name).toBe("test-marketplace");
		expect(result.catalog.owner.name).toBe("Test Author");
		expect(result.catalog.plugins).toHaveLength(1);
		expect(result.catalog.plugins[0].name).toBe("hello-plugin");
		// local fetch never returns a clonePath
		expect(result.clonePath).toBeUndefined();
	});

	it("throws a clear error for nonexistent local directory", async () => {
		const missing = path.join(tmpDir, "nonexistent");
		await expect(fetchMarketplace(missing, tmpDir)).rejects.toThrow(/Marketplace catalog not found/);
	});

	it("throws a clear error for relative nonexistent path", async () => {
		// Use a path that resolves within tmpDir but doesn't exist
		const fakeSrc = path.join(tmpDir, "ghost-marketplace");
		await expect(fetchMarketplace(fakeSrc, tmpDir)).rejects.toThrow(/Marketplace catalog not found/);
	});

	it("loads catalog from .omp-plugin/marketplace.json when present", async () => {
		const root = path.join(tmpDir, "omp-only");
		fs.mkdirSync(path.join(root, ".omp-plugin"), { recursive: true });
		const catalog = {
			name: "omp-only-marketplace",
			owner: { name: "Test" },
			plugins: [{ name: "omp-plugin", source: "./plugins/omp-plugin", description: "x" }],
		};
		fs.writeFileSync(path.join(root, ".omp-plugin", "marketplace.json"), JSON.stringify(catalog));

		const result = await fetchMarketplace(root, tmpDir);
		expect(result.catalog.name).toBe("omp-only-marketplace");
		expect(result.catalog.plugins[0].name).toBe("omp-plugin");
	});

	it("prefers .omp-plugin/marketplace.json over .claude-plugin/marketplace.json when both exist", async () => {
		const root = path.join(tmpDir, "both-catalogs");
		fs.mkdirSync(path.join(root, ".omp-plugin"), { recursive: true });
		fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
		const ompCatalog = {
			name: "from-omp-plugin",
			owner: { name: "Test" },
			plugins: [{ name: "p", source: "./p", description: "x" }],
		};
		const claudeCatalog = {
			name: "from-claude-plugin",
			owner: { name: "Test" },
			plugins: [{ name: "p", source: "./p", description: "x" }],
		};
		fs.writeFileSync(path.join(root, ".omp-plugin", "marketplace.json"), JSON.stringify(ompCatalog));
		fs.writeFileSync(path.join(root, ".claude-plugin", "marketplace.json"), JSON.stringify(claudeCatalog));

		const result = await fetchMarketplace(root, tmpDir);
		expect(result.catalog.name).toBe("from-omp-plugin");
	});

	it("falls back to .claude-plugin/marketplace.json when .omp-plugin is absent", async () => {
		// The shared fixture only ships .claude-plugin/marketplace.json — confirms
		// the legacy path still loads unchanged.
		const result = await fetchMarketplace(FIXTURE_DIR, tmpDir);
		expect(result.catalog.name).toBe("test-marketplace");
	});

	it("error message names both candidate paths when neither exists", async () => {
		const empty = path.join(tmpDir, "empty-dir");
		fs.mkdirSync(empty, { recursive: true });
		await expect(fetchMarketplace(empty, tmpDir)).rejects.toThrow(
			/\.omp-plugin[\\/]marketplace\.json.*\.claude-plugin[\\/]marketplace\.json/,
		);
	});

	it("hides temp clone paths in cloned catalog validation errors", async () => {
		const cloneSpy = spyOn(vcs, "clone").mockImplementation(async (_url, targetDir) => {
			fs.mkdirSync(path.join(targetDir, ".claude-plugin"), { recursive: true });
			fs.writeFileSync(
				path.join(targetDir, ".claude-plugin", "marketplace.json"),
				JSON.stringify({ name: "broken-marketplace", plugins: [] }),
			);
		});

		try {
			await expect(fetchMarketplace("kubeshark/kubeshark", tmpDir)).rejects.toThrow(
				'Cloned repository https://github.com/kubeshark/kubeshark.git: Missing or invalid field "owner" in catalog: .claude-plugin/marketplace.json (source: kubeshark/kubeshark)',
			);
		} finally {
			cloneSpy.mockRestore();
		}
	});

	// Network-dependent tests — skip in CI / offline environments.
	// These verify real git clone and HTTP fetch error handling.
	it.skip("github source throws on nonexistent repo", async () => {
		await expect(fetchMarketplace("nonexistent-owner-xyz/nonexistent-repo-xyz", tmpDir)).rejects.toThrow(
			/git clone failed/,
		);
	});

	it.skip("git source throws on nonexistent repo", async () => {
		await expect(
			fetchMarketplace("git@github.com:nonexistent-owner-xyz/nonexistent-repo-xyz.git", tmpDir),
		).rejects.toThrow(/git clone failed/);
	});

	it.skip("url source throws on non-2xx response", async () => {
		await expect(fetchMarketplace("https://example.com/nonexistent-catalog-xyz.json", tmpDir)).rejects.toThrow(
			/HTTP [45]\d\d/,
		);
	});
});
