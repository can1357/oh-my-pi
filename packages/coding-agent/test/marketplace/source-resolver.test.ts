import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	MarketplacePluginEntry,
	ResolveContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { resolvePluginSource } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";

// Test-injectable limits override (contract: ResolveContext.limits). The local type keeps
// these tests compiling against the pre-contract source; the field is ignored at runtime
// until the source worker lands the limits plumbing.
type NpmLimits = Partial<{
	packumentMaxBytes: number;
	tarballMaxBytes: number;
	packumentTimeoutMs: number;
	tarballTimeoutMs: number;
	maxRedirects: number;
}>;
type NpmResolveContext = ResolveContext & { limits?: NpmLimits };

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

/** Wire payload the mock registry serializes; malformed-registry fixtures may omit fields the resolver rejects. */
type MockPackumentPayload = Partial<MockPackument>;

/** Build a valid tar.gz archive containing `package/` with a plugin.json. */
async function makeValidTarball(packageName: string, packageVersion: string): Promise<Uint8Array> {
	const pluginJson = JSON.stringify({
		name: packageName,
		version: packageVersion,
		description: "test",
	});
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
	const distTags: Record<string, string> = {
		latest: latest ?? versions[versions.length - 1].version,
	};
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
function createNpmFetchMock(packuments: Map<string, MockPackumentPayload>, tarballs: Map<string, Uint8Array>) {
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

	it("throws when source string lacks the ./ prefix", async () => {
		// "plugins/hello-plugin" (no "./") hits the non-relative guard independently of pathIsWithin.
		const entry = makeEntry("plugins/hello-plugin");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/must start with/,
		);
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
		const entry = makeEntry({
			source: "github",
			repo: "nonexistent-owner/nonexistent-repo",
		});
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/git clone failed/,
		);
	});

	it.skip("resolves url object source via git clone", async () => {
		const entry = makeEntry({
			source: "url",
			url: "https://example.com/nonexistent.git",
		});
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
	}): Promise<{
		packument: MockPackument;
		tarballUrl: string;
		integrity: string;
	}> {
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.2.3",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "^1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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
		const entry = makeEntry({
			source: "npm",
			package: "INVALID_UPPER",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/Invalid.*package name/);
	});

	it("rejects empty version expression", async () => {
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "",
			registry: REGISTRY_ORIGIN,
		});
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
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;

		// Need to also serve the redirected URL
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/test-plugin`) {
				return new Response(null, {
					status: 302,
					headers: { location: `${REGISTRY_ORIGIN}/v1/test-plugin` },
				});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });

		expect(result.resolvedVersion).toBe("1.0.0");
	});

	it("rejects redirect that leaves registry origin", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/test-plugin`) {
				return new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/test-plugin" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
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
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "3.1.4",
			registry: REGISTRY_ORIGIN,
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
		});
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "^99.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/no version matching/);
	});

	// ── Contract: garbage range expression ───────────────────────────────

	it("rejects garbage version expression with /invalid version expression/", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "garbage-range!!!",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/invalid version expression/);
	});

	// ── Contract: prerelease lowest line ─────────────────────────────────

	it("resolves prerelease version when it is the only range match", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "0.0.0-alpha");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "0.0.0-alpha", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: ">=0.0.0-alpha",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.resolvedVersion).toBe("0.0.0-alpha");
	});

	// ── Contract: exact-version handoff (version omitted in tarball) ─────

	it("persists selected version when tarball package.json omits version field", async () => {
		// Tarball package.json has no "version" — only the resolver handoff can supply it.
		const pluginJson = JSON.stringify({
			name: "test-plugin",
			description: "test",
		});
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pluginJson],
			["package/.claude-plugin/plugin.json", pluginJson],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.resolvedVersion).toBe("1.0.0");
	});

	it("rejects tarball whose embedded package.json version differs from selected", async () => {
		// Tarball package.json says 9.9.9 but packument selected 1.0.0 → identity mismatch.
		const pluginJson = JSON.stringify({
			name: "test-plugin",
			version: "9.9.9",
		});
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pluginJson],
			["package/.claude-plugin/plugin.json", pluginJson],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/package identity/);
	});

	// ── Contract: identity name mismatch ─────────────────────────────────

	it("rejects tarball whose embedded package.json name differs from requested", async () => {
		const pluginJson = JSON.stringify({
			name: "evil-package",
			version: "1.0.0",
		});
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pluginJson],
			["package/.claude-plugin/plugin.json", pluginJson],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/package identity/);
	});

	// ── Contract: HTTPS-only tarball guard ───────────────────────────────

	it("rejects non-HTTPS tarball URL and never fetches the tarball", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const httpTarballUrl = `http://insecure.example/${pkg}/-/${pkg}-1.0.0.tgz`;
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity, tarball: httpTarballUrl }]);

		let tarballFetched = false;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === httpTarballUrl) {
				tarballFetched = true;
				return new Response(tarballBytes, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/must be public HTTPS/);
		expect(tarballFetched).toBe(false);
	});

	// ── Contract: redirect cap (6 hops) ──────────────────────────────────

	it("rejects after exceeding max redirects (6 same-origin hops)", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const pkg = "test-plugin";
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(null, {
					status: 302,
					headers: { location: `${REGISTRY_ORIGIN}/r1` },
				});
			}
			if (url.startsWith(`${REGISTRY_ORIGIN}/r`)) {
				const n = parseInt(url.slice(`${REGISTRY_ORIGIN}/r`.length), 10);
				return new Response(null, {
					status: 302,
					headers: { location: `${REGISTRY_ORIGIN}/r${n + 1}` },
				});
			}
			if (url === tarballUrl) {
				return new Response(tarballBytes, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/exceeded .* redirects/);
	});

	// ── Contract: redirect manualness ────────────────────────────────────

	it("uses redirect:manual and AbortSignal on every fetch call", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity }]);
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;

		const capturedInits: Array<{ redirect?: string; signal?: AbortSignal }> = [];
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			capturedInits.push({
				redirect: init?.redirect as string | undefined,
				signal: init?.signal as AbortSignal | undefined,
			});
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(null, {
					status: 302,
					headers: { location: `${REGISTRY_ORIGIN}/v1/${pkg}` },
				});
			}
			if (url === `${REGISTRY_ORIGIN}/v1/${pkg}`) {
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await resolvePluginSource(entry, { tmpDir });

		expect(capturedInits.length).toBeGreaterThan(0);
		for (const init of capturedInits) {
			expect(init.redirect).toBe("manual");
			expect(init.signal).toBeInstanceOf(AbortSignal);
		}
	});

	// ── Contract: packument byte cap ─────────────────────────────────────

	it("rejects packument exceeding byte limit", async () => {
		const pkg = "test-plugin";
		// Build a packument JSON padded with spaces to exceed the small limit.
		const smallPackument = makePackument(pkg, [{ version: "1.0.0", integrity: `sha512-${"A".repeat(86)}` }]);
		const paddedBody = JSON.stringify(smallPackument) + " ".repeat(2048);

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(paddedBody, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const ctx: NpmResolveContext = {
			tmpDir,
			limits: { packumentMaxBytes: 1024 },
		};
		await expect(resolvePluginSource(entry, ctx)).rejects.toThrow(/exceeds.*bytes/);
	});

	// ── Contract: tarball byte caps ──────────────────────────────────────

	it("rejects tarball with huge content-length header", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity }]);

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === tarballUrl) {
				return new Response(tarballBytes, {
					status: 200,
					headers: { "content-length": "999999999999" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const ctx: NpmResolveContext = {
			tmpDir,
			limits: { tarballMaxBytes: 1024 },
		};
		await expect(resolvePluginSource(entry, ctx)).rejects.toThrow(/tarball exceeds/);
	});

	it("rejects tarball whose streamed body exceeds byte limit", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity }]);

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === tarballUrl) {
				// No content-length header — the cap must fire during streaming.
				return new Response(tarballBytes, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		// tarballMaxBytes smaller than the served body so the streamed cap triggers.
		const ctx: NpmResolveContext = { tmpDir, limits: { tarballMaxBytes: 32 } };
		await expect(resolvePluginSource(entry, ctx)).rejects.toThrow(/tarball exceeds/);
	});

	// ── Contract: timeout translation ────────────────────────────────────

	it("translates AbortError to /timed out after/ message", async () => {
		const pkg = "test-plugin";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const ctx: NpmResolveContext = {
			tmpDir,
			limits: { packumentTimeoutMs: 50 },
		};
		await expect(resolvePluginSource(entry, ctx)).rejects.toThrow(/timed out after/);
	});

	// ── Contract: tarball redirect coverage ──────────────────────────────

	it("follows same-origin CDN redirect for tarball and succeeds", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const cdnOrigin = "https://cdn.example";
		const cdnTarballUrl = `${cdnOrigin}/${pkg}/-/${pkg}-1.0.0.tgz`;
		const cdnRedirectUrl = `${cdnOrigin}/redirect/${pkg}-1.0.0.tgz`;
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity, tarball: cdnTarballUrl }]);

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === cdnTarballUrl) {
				return new Response(null, {
					status: 302,
					headers: { location: cdnRedirectUrl },
				});
			}
			if (url === cdnRedirectUrl) {
				return new Response(tarballBytes, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.resolvedVersion).toBe("1.0.0");
	});

	it("rejects cross-origin tarball redirect (cdn → other origin)", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const cdnOrigin = "https://cdn.example";
		const cdnTarballUrl = `${cdnOrigin}/${pkg}/-/${pkg}-1.0.0.tgz`;
		const otherOriginUrl = "https://other.example/pkg-1.0.0.tgz";
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity, tarball: cdnTarballUrl }]);

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === cdnTarballUrl) {
				return new Response(null, {
					status: 302,
					headers: { location: otherOriginUrl },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/leaves.*origin/);
	});

	// ── Contract: redirect target credentials ────────────────────────────

	it("rejects same-origin redirect Location containing embedded credentials", async () => {
		const pkg = "test-plugin";

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(null, {
					status: 302,
					headers: {
						location: `https://user:pass@${REGISTRY_ORIGIN.slice("https://".length)}/v1/${pkg}`,
					},
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/credentials/);
	});

	// ── Contract: parseSriSha512 malformed inputs ────────────────────────

	it("rejects non-sha512 SRI algorithm (sha1-)", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const { packument } = await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0" }],
			tarballBytes,
		});
		// Wrong algorithm prefix
		packument.versions["1.0.0"].dist.integrity = `sha1-${Buffer.from("x".repeat(20)).toString("base64")}`;

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/SHA-512 SRI/);
	});

	it("rejects non-canonical base64 in SRI digest", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const { packument } = await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0" }],
			tarballBytes,
		});
		// Contains invalid base64 chars (spaces, exclamation)
		packument.versions["1.0.0"].dist.integrity = "sha512-!!!not base64!!!";

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/SHA-512 SRI/);
	});

	it("rejects wrong digest length (sha512-AAAA)", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const { packument } = await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0" }],
			tarballBytes,
		});
		// Valid base64 but decodes to only 4 bytes, not 64
		packument.versions["1.0.0"].dist.integrity = "sha512-AAAA";

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/64 bytes/);
	});

	// ── Contract: selectVersion branches ─────────────────────────────────

	it("rejects packument with no versions map", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const pkg = "test-plugin";
		const packument: MockPackumentPayload = {
			name: pkg,
			"dist-tags": { latest: "1.0.0" },
		};
		const packuments = new Map([[pkg, packument]]);
		const tarballs = new Map([[`${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`, tarballBytes]]);
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			createNpmFetchMock(packuments, tarballs) as typeof fetch,
		);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/no versions/);
	});

	it("rejects when dist-tags.latest is missing and version is omitted", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity }]);
		// Serve dist-tags with no `latest` tag
		packument["dist-tags"] = {};
		const packuments = new Map([[pkg, packument]]);
		const tarballs = new Map([[`${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`, tarballBytes]]);
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			createNpmFetchMock(packuments, tarballs) as typeof fetch,
		);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/dist-tags.latest is missing/);
	});

	it("rejects when dist-tags.latest points at a version absent from versions", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity }], "9.9.9");
		const packuments = new Map([[pkg, packument]]);
		const tarballs = new Map([[`${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`, tarballBytes]]);
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			createNpmFetchMock(packuments, tarballs) as typeof fetch,
		);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/not found in versions/);
	});

	it("range resolution ignores non-semver version keys like 'next'", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.5.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const packument = makePackument(pkg, [{ version: "1.0.0" }, { version: "1.5.0", integrity }], "1.5.0");
		// Add a non-semver key "next" that must be ignored by range resolution.
		(packument.versions as Record<string, { name: string; dist: { tarball: string; integrity: string } }>).next = {
			name: pkg,
			dist: {
				tarball: `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-next.tgz`,
				integrity,
			},
		};
		const packuments = new Map([[pkg, packument]]);
		const tarballs = new Map([
			[`${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`, tarballBytes],
			[`${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.5.0.tgz`, tarballBytes],
		]);
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			createNpmFetchMock(packuments, tarballs) as typeof fetch,
		);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "^1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.resolvedVersion).toBe("1.5.0");
	});

	// ── Contract: registry URL edges ─────────────────────────────────────

	it("rejects 'not a url' as invalid registry URL", async () => {
		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: "not a url",
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/invalid registry URL/);
	});

	it("builds packument request URL with path prefix from registry", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const pkg = "test-plugin";
		const registryWithPrefix = "https://reg.example/npm/";
		const expectedPackumentUrl = "https://reg.example/npm/test-plugin";
		const tarballUrl = `${registryWithPrefix}${pkg}/-/${pkg}-1.0.0.tgz`;
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity, tarball: tarballUrl }]);

		let capturedUrl: string | undefined;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === expectedPackumentUrl) {
				capturedUrl = url;
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

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: registryWithPrefix,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.resolvedVersion).toBe("1.0.0");
		expect(capturedUrl).toBe(expectedPackumentUrl);
	});

	// ── Contract: redirect degenerate ────────────────────────────────────

	it("rejects 302 without Location header", async () => {
		const pkg = "test-plugin";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(null, { status: 302 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/without Location/);
	});

	it("rejects 302 with invalid Location '::'", async () => {
		const pkg = "test-plugin";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `${REGISTRY_ORIGIN}/${pkg}`) {
				return new Response(null, { status: 302, headers: { location: "::" } });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/invalid redirect Location/);
	});

	// ── Contract: archive shape — top-level FILE named 'package' ─────────

	it("rejects archive with a top-level FILE named 'package' (not directory)", async () => {
		const entries: readonly [string, string][] = [
			["package", JSON.stringify({ name: "test-plugin", version: "1.0.0" })],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/top-level.*package/);
	});

	// ── Contract: version-expression boundary ────────────────────────────

	it("accepts a 256-byte version expression", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		// Build a 256-byte expression: ">=1.0.0 <2.0.0" padded with trailing spaces.
		let expr = ">=1.0.0 <2.0.0";
		while (expr.length < 256) expr += " ";
		expect(expr.length).toBe(256);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: expr,
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.resolvedVersion).toBe("1.0.0");
	});

	it("rejects a 257-byte version expression", async () => {
		const tarballBytes = await makeValidTarball("test-plugin", "1.0.0");
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		// Build a 257-byte expression.
		let expr = ">=1.0.0 <2.0.0";
		while (expr.length < 257) expr += " ";
		expect(expr.length).toBe(257);

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: expr,
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/256 bytes/);
	});

	// ── Contract: unbundled runtime dependency rejection ────────────────

	it("rejects tarball with unbundled runtime dependencies", async () => {
		const pkgJson = JSON.stringify({
			name: "test-plugin",
			version: "1.0.0",
			dependencies: { "left-pad": "^1.0.0" },
		});
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pkgJson],
			["package/.claude-plugin/plugin.json", pkgJson],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		let thrown: Error | undefined;
		try {
			await resolvePluginSource(entry, { tmpDir });
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown?.message).toMatch(/runtime dependencies its npm tarball does not ship/);
		// The message has to name the offending package, or the operator cannot act
		// on it. This caught a real defect: `.map(sanitizeFragment)` passed the
		// array index as `maxLen`, truncating every name at index 0 to "…".
		expect(thrown?.message).toContain("left-pad");
	});

	it("accepts tarball whose runtime dependencies are all bundled", async () => {
		const pkgJson = JSON.stringify({
			name: "test-plugin",
			version: "1.0.0",
			dependencies: { "left-pad": "^1.0.0" },
			bundledDependencies: ["left-pad"],
		});
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pkgJson],
			["package/.claude-plugin/plugin.json", pkgJson],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.dir).toMatch(/package$/);
		expect(result.resolvedVersion).toBe("1.0.0");
	});

	// ── Contract: control characters stripped from error messages ───────

	it("strips control characters from sibling names in error message", async () => {
		const pkgJson = JSON.stringify({ name: "test-plugin", version: "1.0.0" });
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pkgJson],
			["package/.claude-plugin/plugin.json", pkgJson],
			["pkg\t evil\nname/", ""],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		let thrown: Error | undefined;
		try {
			await resolvePluginSource(entry, { tmpDir });
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown?.message).toMatch(/found siblings/);
		expect(thrown?.message).not.toMatch(/[\t\n\r]/);
	});
	// ── Contract: optionalDependencies treated as runtime deps ──────────

	it("rejects tarball with unbundled optional dependencies", async () => {
		const pkgJson = JSON.stringify({
			name: "test-plugin",
			version: "1.0.0",
			optionalDependencies: { "left-pad": "^1.0.0" },
		});
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pkgJson],
			["package/.claude-plugin/plugin.json", pkgJson],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		let thrown: Error | undefined;
		try {
			await resolvePluginSource(entry, { tmpDir });
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown?.message).toMatch(/runtime dependencies its npm tarball does not ship/);
		expect(thrown?.message).toContain("left-pad");
	});

	it("accepts tarball whose optional dependencies are bundled", async () => {
		const pkgJson = JSON.stringify({
			name: "test-plugin",
			version: "1.0.0",
			optionalDependencies: { "left-pad": "^1.0.0" },
			bundledDependencies: ["left-pad"],
		});
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", pkgJson],
			["package/.claude-plugin/plugin.json", pkgJson],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.dir).toMatch(/package$/);
		expect(result.resolvedVersion).toBe("1.0.0");
	});

	// ── Contract: non-object manifest gives staged diagnostic ───────────

	it("rejects non-object package.json with staged diagnostic, not bare TypeError", async () => {
		const entries: readonly [string, string][] = [
			["package/", ""],
			["package/package.json", "null"],
			["package/.claude-plugin/plugin.json", JSON.stringify({ name: "test-plugin", version: "1.0.0" })],
		];
		const tarballBytes = await encodeArchive("tar.gz", entries);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		let thrown: Error | undefined;
		try {
			await resolvePluginSource(entry, { tmpDir });
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown?.message).toMatch(/missing or not a JSON object/);
		expect(thrown?.message).toContain("test-plugin");
		expect(thrown?.message).not.toContain("Cannot read properties");
	});

	// ── Contract: extraction error sanitized ────────────────────────────

	it("sanitizes control characters from extraction error messages", async () => {
		// Craft a tar archive with a hard-link entry whose name contains a tab
		// and a newline, with an invalid target (".."). readTar throws during
		// indexing with the raw member name in the message; the resolver wraps
		// it through sanitizeFragment, stripping every C0 control character.
		function makeRawTarHeader(opts: {
			name: string;
			typeflag: number;
			size?: number;
			linkname?: string;
		}): Uint8Array {
			const header = new Uint8Array(512);
			const enc = new TextEncoder();
			const writeStr = (offset: number, length: number, value: string): void => {
				const bytes = enc.encode(value);
				if (bytes.byteLength > length) throw new Error("tar header field too long");
				header.set(bytes, offset);
			};
			const writeOctal = (offset: number, length: number, value: number): void => {
				const str = value.toString(8).padStart(length - 1, "0");
				for (let i = 0; i < str.length; i++) header[offset + i] = str.charCodeAt(i);
				header[offset + length - 1] = 0;
			};
			writeStr(0, 100, opts.name);
			writeOctal(100, 8, 0o644);
			writeOctal(108, 8, 0);
			writeOctal(116, 8, 0);
			writeOctal(124, 12, opts.size ?? 0);
			writeOctal(136, 12, 0);
			for (let i = 148; i < 156; i++) header[i] = 0x20;
			header[156] = opts.typeflag;
			writeStr(157, 100, opts.linkname ?? "");
			writeStr(257, 6, "ustar");
			header[262] = 0;
			writeStr(263, 2, "00");
			let checksum = 0;
			for (const byte of header) checksum += byte;
			const chkStr = checksum.toString(8).padStart(6, "0");
			for (let i = 0; i < 6; i++) header[148 + i] = chkStr.charCodeAt(i);
			header[154] = 0;
			header[155] = 0x20;
			return header;
		}

		const evilName = "pkg\tevil\nname";
		const header = makeRawTarHeader({
			name: evilName,
			typeflag: 0x31,
			linkname: "..",
		});
		const terminator = new Uint8Array(1024);
		const tarBytes = new Uint8Array(header.byteLength + terminator.byteLength);
		tarBytes.set(header, 0);
		tarBytes.set(terminator, header.byteLength);
		const tarballBytes = Bun.gzipSync(tarBytes);
		const integrity = sriSha512(tarballBytes);
		await setupNpmMock({
			pkg: "test-plugin",
			versions: [{ version: "1.0.0", integrity }],
			tarballBytes,
		});

		const entry = makeEntry({
			source: "npm",
			package: "test-plugin",
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		let thrown: Error | undefined;
		try {
			await resolvePluginSource(entry, { tmpDir });
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown?.message).toMatch(/archive extraction failed/);
		expect(thrown?.message).not.toMatch(/[\t\n\r]/);
	});

	// ── Contract: redirect body cancelled ───────────────────────────────

	it("cancels a redirect response body before following it", async () => {
		const pkg = "test-plugin";
		const tarballBytes = await makeValidTarball(pkg, "1.0.0");
		const integrity = sriSha512(tarballBytes);
		const tarballUrl = `${REGISTRY_ORIGIN}/${pkg}/-/${pkg}-1.0.0.tgz`;
		const packument = makePackument(pkg, [{ version: "1.0.0", integrity, tarball: tarballUrl }]);
		const packumentUrl = `${REGISTRY_ORIGIN}/${pkg}`;
		const redirectedUrl = `${REGISTRY_ORIGIN}/${pkg}-redirected`;

		let redirectBodyCancelled = false;
		const redirectBody = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("redirect body"));
			},
			cancel() {
				redirectBodyCancelled = true;
			},
		});

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === packumentUrl) {
				return new Response(redirectBody, {
					status: 302,
					headers: { location: redirectedUrl },
				});
			}
			if (url === redirectedUrl) {
				return new Response(JSON.stringify(packument), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === tarballUrl) {
				return new Response(tarballBytes, {
					status: 200,
					headers: { "content-type": "application/gzip" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: pkg,
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		const result = await resolvePluginSource(entry, { tmpDir });
		expect(result.dir).toMatch(/package$/);
		expect(result.resolvedVersion).toBe("1.0.0");
		expect(redirectBodyCancelled).toBe(true);
	});

	it("cancels a redirect response body before throwing on cross-origin redirect", async () => {
		const pkg = "test-plugin";
		const packumentUrl = `${REGISTRY_ORIGIN}/${pkg}`;

		let redirectBodyCancelled = false;
		const redirectBody = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("redirect body"));
			},
			cancel() {
				redirectBodyCancelled = true;
			},
		});

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === packumentUrl) {
				return new Response(redirectBody, {
					status: 302,
					headers: { location: "https://other-origin.example/foo" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);

		const entry = makeEntry({
			source: "npm",
			package: pkg,
			version: "1.0.0",
			registry: REGISTRY_ORIGIN,
		});
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/redirect leaves registry origin/);
		expect(redirectBodyCancelled).toBe(true);
	});
});
