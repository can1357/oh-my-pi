import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MarketplacePluginEntry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { resolvePluginSource } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";

// Fixture: a cloned marketplace with a single plugin at ./plugins/hello-plugin
const FIXTURE_DIR = path.resolve(import.meta.dir, "fixtures/valid-marketplace");

// Helper — build a minimal MarketplacePluginEntry with the given source
function makeEntry(source: MarketplacePluginEntry["source"]): MarketplacePluginEntry {
	return { name: "hello-plugin", source };
}

// ── npm test helpers ────────────────────────────────────────────────

const REGISTRY_ORIGIN = "https://registry.test-npm.example";

interface MockPackument {
	name: string;
	"dist-tags": Record<string, string>;
	versions: Record<
		string,
		{
			name: string;
			dist: { tarball: string; integrity: string };
		}
	>;
}

/** Build a valid tar.gz archive containing `package/` with a plugin.json. */
async function makeValidTarball(packageName: string, packageVersion: string): Promise<Uint8Array> {
	const pluginJson = JSON.stringify({ name: packageName, version: packageVersion, description: "test" });
	const entries: readonly [string, string][] = [
		["package/", ""],
		["package/package.json", pluginJson],
		["package/.claude-plugin/plugin.json", pluginJson],
	];
	return encodeArchive("tar.gz", entries);
}

/** Compute canonical SHA-512 SRI from raw bytes. */
function sriSha512(bytes: Uint8Array): string {
	const digest = crypto.createHash("sha512").update(Buffer.from(bytes)).digest("base64");
	return `sha512-${digest}`;
}

/** Build a mock packument for a package with given versions. */
function makePackument(
	pkg: string,
	versions: Array<{ version: string; tarball?: string; integrity?: string }>,
	latest?: string,
): MockPackument {
	const distTags: Record<string, string> = { latest: latest ?? versions[versions.length - 1].version };
	const versionMap: MockPackument["versions"] = {};
	for (const v of versions) {
		const tarball = v.tarball ?? `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-${v.version}.tgz`;
		// integrity will be filled by the test when it has the tarball bytes
		versionMap[v.version] = {
			name: pkg,
			dist: { tarball, integrity: v.integrity ?? "sha512-placeholder" },
		};
	}
	return { name: pkg, "dist-tags": distTags, versions: versionMap };
}

/** Create a mock fetch that serves packuments and tarballs. */
function createNpmFetchMock(packuments: Map<string, MockPackument>, tarballs: Map<string, Uint8Array>) {
	return async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		// Tarball request — check before packument to avoid false matches
		for (const [tarballUrl, bytes] of tarballs) {
			if (url === tarballUrl) {
				return new Response(bytes, {
					status: 200,
					headers: { "content-type": "application/gzip" },
				});
			}
		}

		// Packument request (excludes tarball URLs which contain /-/)
		if (!url.includes("/-/") && (url.includes("/@") || url.match(/\/[a-z0-9][a-z0-9._~-]*$/))) {
			// Decode package name from URL
			let pkg: string;
			if (url.includes("/@")) {
				// Scoped: /@scope/name → @scope/name
				const afterSlash = url.lastIndexOf("/@");
				pkg = decodeURIComponent(url.slice(afterSlash + 1));
			} else {
				const parts = url.split("/");
				pkg = parts[parts.length - 1];
			}

			const packument = packuments.get(pkg);
			if (!packument) {
				return new Response("not found", { status: 404 });
			}
			return new Response(JSON.stringify(packument), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		return new Response("not found", { status: 404 });
	};
}

// ── Tests ───────────────────────────────────────────────────────────

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

// ── npm source tests ────────────────────────────────────────────────

describe("resolvePluginSource — npm", () => {
	let tmpDir: string;
	let fetchSpy: { mockRestore: () => void } | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-npm-test-"));
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		removeSyncWithRetries(tmpDir);
	});

	async function setupNpmMock(opts: {
		pkg?: string;
		versions?: Array<{ version: string; integrity?: string }>;
		latest?: string;
		tarballBytes?: Uint8Array;
	}): Promise<{ packument: MockPackument; tarballUrl: string; integrity: string }> {
		const pkg = opts.pkg ?? "test-plugin";
		const defaultVersion = opts.versions?.[opts.versions.length - 1]?.version ?? "1.0.0";
		const tarballBytes = opts.tarballBytes ?? (await makeValidTarball(pkg, defaultVersion));
		const integrity = opts.versions?.[opts.versions.length - 1]?.integrity ?? sriSha512(tarballBytes);
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-${defaultVersion}.tgz`;

		const versions = (opts.versions ?? [{ version: "1.0.0" }]).map(v => ({
			version: v.version,
			integrity: v.integrity ?? (v.version === defaultVersion ? integrity : sriSha512(tarballBytes)),
			tarball: `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-${v.version}.tgz`,
		}));

		const packument = makePackument(pkg, versions, opts.latest);
		const packuments = new Map([[pkg, packument]]);
		const tarballs = new Map([[tarballUrl, tarballBytes]]);

		// Also register tarballs for other versions
		for (const v of versions) {
			if (v.tarball !== tarballUrl) {
				tarballs.set(v.tarball, tarballBytes);
			}
		}

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			createNpmFetchMock(packuments, tarballs) as typeof fetch,
		);

		return { packument, tarballUrl, integrity };
	}

	it("resolves exact version from npm registry", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.2.3");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.2.3", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.2.3", registry: REGISTRY_ORIGIN });
		const result = await resolvePluginSource(entry, { tmpDir });

		expect(result.dir).toMatch(/package$/);
		expect(result.resolvedVersion).toBe("1.2.3");
		expect(result.tempCloneRoot).toBeDefined();
		expect(fs.existsSync(path.join(result.dir, "package.json"))).toBe(true);
	});

	it("resolves latest version when version is omitted", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "2.0.0");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0" }, { version: "2.0.0", integrity }],
			latest: "2.0.0",
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", registry: REGISTRY_ORIGIN });
		const result = await resolvePluginSource(entry, { tmpDir });

		expect(result.resolvedVersion).toBe("2.0.0");
		expect(fs.existsSync(path.join(result.dir, "package.json"))).toBe(true);
	});

	it("resolves highest semver match for a range expression", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.5.0");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0" }, { version: "1.3.0" }, { version: "1.5.0", integrity }, { version: "2.0.0" }],
			latest: "2.0.0",
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "^1.0.0", registry: REGISTRY_ORIGIN });
		const result = await resolvePluginSource(entry, { tmpDir });

		expect(result.resolvedVersion).toBe("1.5.0");
	});

	it("encodes scoped package name correctly in packument URL", async () => {
		const tarballBytes = await makeValidTarball("@scope/test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "@scope/test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "@scope/test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });

		expect(result.resolvedVersion).toBe("1.0.0");
		expect(fs.existsSync(path.join(result.dir, "package.json"))).toBe(true);
	});

	it("throws on metadata name mismatch", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const { packument } = await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});
		// Corrupt the name in the packument
		packument.versions["1.0.0"].name = "wrong-name";

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/name mismatch/);
	});

	it("throws on SRI integrity mismatch (mutation check)", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		// Use a wrong integrity hash
		const wrongIntegrity = sriSha512(new Uint8Array(64));
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity: wrongIntegrity }],
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/integrity verification failed/);
	});

	it("throws on missing integrity hash", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const { packument } = await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0" }],
			tarballBytes,
		});
		// Remove integrity
		packument.versions["1.0.0"].dist.integrity = "";

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/missing integrity/);
	});

	it("rejects non-HTTPS registry URL", async () => {
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: "http://insecure.example",
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/HTTPS/);
	});

	it("rejects registry URL with credentials", async () => {
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: "https://user:pass@registry.example",
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/credentials/);
	});

	it("rejects registry URL with query string", async () => {
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: "https://registry.example?foo=bar",
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/query/);
	});

	it("rejects registry URL with fragment", async () => {
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: "https://registry.example#frag",
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/fragment/);
	});

	it("rejects invalid package name", async () => {
		const entry = makeEntry({ source: "npm", package: "INVALID_UPPER", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/Invalid.*package name/);
	});

	it("rejects empty version expression", async () => {
		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/nonempty/);
	});

	it("rejects version expression exceeding 256 bytes", async () => {
		const longVersion = `^${"1.0.0".repeat(60)}`;
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: longVersion,
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/256 bytes/);
	});

	it("follows same-origin HTTPS redirects for packument", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity }]);
		const packuments = new Map([[pkg, packument]]);
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;
		const tarballs = new Map([[tarballUrl, tarballBytes]]);

		// Need to also serve the redirected URL
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/test-plugin`) {
				return new Response(null, { status: 302, headers: { location: `${REGISTRY_ORIGIN}/v1/test-plugin` } });
			}
			if (url === `${REGISTRY_ORIGIN}/v1/test-plugin`) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === tarballUrl) {
				return new Response(tarballBytes, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		const result = await resolvePluginSource(entry, { tmpDir });

		expect(result.resolvedVersion).toBe("1.0.0");
	});

	it("rejects redirect that leaves registry origin", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity }]);
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/test-plugin`) {
				return new Response(null, { status: 302, headers: { location: "https://evil.example/test-plugin" } });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/leaves registry origin/);
	});

	it("rejects archive without top-level package/ directory", async () => {
		// Create a tarball with wrong top-level directory name
		const entries: readonly [string, string][] = [
			["wrong-dir/", ""],
			["wrong-dir/package.json", JSON.stringify({ name: "test-plugin", version: "1.0.0" })],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/top-level.*package/);
	});

	it("rejects archive with sibling directories alongside package/", async () => {
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", JSON.stringify({ name: "test-plugin", version: "1.0.0" })],
			["extra-dir/", ""],
			["extra-dir/file.txt", "extra"],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/siblings/);
	});

	it("cleans up temp root on failure", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const wrongIntegrity = sriSha512(new Uint8Array(64));
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity: wrongIntegrity }],
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/integrity verification failed/);

		// Verify no npm-* temp dirs left in tmpDir
		const entries = fs.readdirSync(tmpDir);
		const npmDirs = entries.filter(e => e.startsWith("npm-"));
		expect(npmDirs).toEqual([]);
	});

	it("returns resolvedVersion for exact version selection", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "3.1.4");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0" }, { version: "2.0.0" }, { version: "3.1.4", integrity }],
			latest: "3.1.4",
			tarballBytes,
		});
		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "3.1.4", registry: REGISTRY_ORIGIN });
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.resolvedVersion).toBe("3.1.4");
		// Verify the resolved version is the exact one, not latest or a range match
		expect(result.dir).toMatch(/package$/);
	});
	it("uses default registry when registry is omitted", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const tarballUrl = `https://registry.npmjs.org/${pkg}/-/${pkg}-1.0.0.tgz`;
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity, tarball: tarballUrl }]);
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `https://registry.npmjs.org/${pkg}`) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === tarballUrl) {
				return new Response(tarballBytes, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "1.0.0" });
		const result = await resolvePluginSource(entry, { tmpDir });

		expect(result.resolvedVersion).toBe("1.0.0");
	});

	it("throws on package not found (404)", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "nonexistent-pkg",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/not found/);
	});

	it("throws on no version matching range", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({ source: "npm", package: "test-plugin", version: "^99.0.0", registry: REGISTRY_ORIGIN });
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/no version matching/);
	});
});
