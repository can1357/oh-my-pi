import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BunPlugin } from "bun";
import { resolveBundledChangelogPath } from "../../src/utils/changelog";

interface HeapProbeResult {
	retainedChangelogStrings: number;
}

interface BundleProbeResult {
	version: string;
	entries: number;
}

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const heapProbePath = path.resolve(import.meta.dir, "..", "fixtures", "changelog-static-import-heap-probe.ts");
const bundleProbePath = path.resolve(import.meta.dir, "..", "fixtures", "changelog-bundle-fallback-probe.ts");
const utilsStubPath = path.resolve(import.meta.dir, "..", "fixtures", "changelog-utils-stub.ts");

async function runProbe(command: string[], cwd?: string): Promise<BundleProbeResult> {
	const proc = Bun.spawn(command, {
		cwd,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as BundleProbeResult;
}

/**
 * Swap `@oh-my-pi/pi-utils` and the changelog module's `../config` import for a
 * dependency-free stub. Both pull the native addon loader into the bundle graph, and
 * that loader resolves `pi_natives.<platform>.node` relative to the emitted artifact,
 * so any probe written outside the repo fails to start. The subject under test is
 * emitted-asset resolution, not native loading.
 */
function changelogUtilsStubPlugin(): BunPlugin {
	return {
		name: "changelog-utils-stub",
		setup(build) {
			build.onResolve({ filter: /^@oh-my-pi\/pi-utils$/ }, () => ({ path: utilsStubPath }));
			build.onResolve({ filter: /^\.\.\/config$/ }, args =>
				args.importer.endsWith("/utils/changelog.ts") ? { path: utilsStubPath } : undefined,
			);
		},
	};
}

describe("bundled changelog asset path resolution", () => {
	const moduleUrl = new URL("file:///opt/omp/dist/cli.js");

	test.each([
		["Windows drive-letter", String.raw`C:\omp\dist\CHANGELOG.md`],
		["Windows UNC", String.raw`\\server\share\omp\CHANGELOG.md`],
		["POSIX", "/opt/omp/dist/CHANGELOG.md"],
	])("preserves an absolute %s path", (_kind, nativePath) => {
		expect(resolveBundledChangelogPath(nativePath, moduleUrl)).toBe(nativePath);
	});

	test("resolves a relative emitted asset against the module", () => {
		expect(resolveBundledChangelogPath("./CHANGELOG-hash.md", moduleUrl)).toEqual(
			new URL("./CHANGELOG-hash.md", moduleUrl),
		);
	});
});

describe("changelog static import resources", () => {
	test("does not retain the multi-megabyte changelog text before parsing", async () => {
		const proc = Bun.spawn([process.execPath, heapProbePath], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout) as HeapProbeResult).toEqual({ retainedChangelogStrings: 0 });
	}, 30_000);

	test("reads the emitted changelog asset when run outside the bundle directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-changelog-bundle-"));
		try {
			const bundleDir = path.join(tempDir, "bundle");
			const unrelatedCwd = path.join(tempDir, "cwd");
			const missingPackageChangelogPath = path.join(tempDir, "missing-package", "CHANGELOG.md");
			await fs.mkdir(unrelatedCwd);
			const sourceResult = await runProbe([process.execPath, bundleProbePath, missingPackageChangelogPath]);

			const buildOutput = await Bun.build({
				entrypoints: [bundleProbePath],
				outdir: bundleDir,
				target: "bun",
				external: ["omp-legacy-pi-modules"],
				plugins: [changelogUtilsStubPlugin()],
			});
			expect(buildOutput.success, buildOutput.logs.map(log => log.message).join("\n")).toBe(true);

			const outputs = await fs.readdir(bundleDir);
			expect(outputs.some(output => output.endsWith(".md"))).toBe(true);
			const bundleFilename = outputs.find(output => output.endsWith(".js"));
			if (!bundleFilename) throw new Error("Changelog bundle build did not emit an entrypoint");
			const result = await runProbe(
				[process.execPath, path.join(bundleDir, bundleFilename), missingPackageChangelogPath],
				unrelatedCwd,
			);

			expect(result.entries).toBe(sourceResult.entries);
			expect(result.version).toBe(sourceResult.version);
		} finally {
			await fs.rm(tempDir, { force: true, recursive: true });
		}
	}, 30_000);

	test("reads the emitted changelog asset from a compiled binary", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-changelog-compiled-"));
		try {
			const binaryPath = path.join(tempDir, "changelog-probe");
			const unrelatedCwd = path.join(tempDir, "cwd");
			const missingPackageChangelogPath = path.join(tempDir, "missing-package", "CHANGELOG.md");
			await fs.mkdir(unrelatedCwd);
			const sourceResult = await runProbe([process.execPath, bundleProbePath, missingPackageChangelogPath]);

			const buildOutput = await Bun.build({
				entrypoints: [bundleProbePath],
				root: repoRoot,
				external: ["omp-legacy-pi-modules"],
				plugins: [changelogUtilsStubPlugin()],
				compile: {
					outfile: binaryPath,
					autoloadBunfig: false,
					autoloadDotenv: false,
					autoloadTsconfig: false,
					autoloadPackageJson: false,
				},
			});
			expect(buildOutput.success, buildOutput.logs.map(log => log.message).join("\n")).toBe(true);

			const result = await runProbe([binaryPath, missingPackageChangelogPath], unrelatedCwd);
			expect(result.entries).toBe(sourceResult.entries);
			expect(result.version).toBe(sourceResult.version);
		} finally {
			await fs.rm(tempDir, { force: true, recursive: true });
		}
	}, 30_000);
});
