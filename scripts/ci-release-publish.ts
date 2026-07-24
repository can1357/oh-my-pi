#!/usr/bin/env bun
/**
 * Publish workspace packages.
 *
 * The default mode publishes public JS packages and the `@pk-nerdsaver-ai/pi-natives`
 * core package. Generated native leaf packages are published separately with
 * `--native-leaf <tag>` from the release_binary matrix after that matrix entry
 * downloads the matching `.node` artifacts.
 *
 * For each public TypeScript package we:
 *   1. Emit `.d.ts` declarations into `dist/types/` so consumers get
 *      stable types regardless of their tsconfig `lib`.
 *   2. Rewrite `package.json` in place — every `types`/`exports[*].types`
 *      that points at `./src/*.ts(x)` is repointed to `./dist/types/*.d.ts`,
 *      `dist/types` (plus `dist/client` for `stats`) is added to `files`,
 *      and packages with a `publishBin` override get their `bin` swapped to
 *      the prepack bundle (coding-agent: `src/cli.ts` → `dist/cli.js`). The
 *      on-repo manifest keeps pointing at source so local dev and source
 *      installs (`bun link`, `install.sh --source`) work without a build.
 *   3. Pack with `bun pm pack` (resolves the `catalog:`/`workspace:`
 *      protocols npm cannot, and runs each package's `prepack` lifecycle),
 *      then publish the resolved tarball with `npm publish` — see
 *      `packAndPublish` for why npm and not `bun publish`.
 *
 * Intended for CI. Mutates `package.json` in place — if you run this
 * locally, expect a dirty working tree and `git restore` after.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	type GeneratedLeafPackage,
	generateNpmPackages,
	LEAF_TARGETS,
} from "../packages/natives/scripts/gen-npm-packages.ts";

export interface PublishPackage {
	dir: string;
	kind: "typescript" | "native";
	/** Extra build steps before manifest rewrite (e.g. esbuild bundles). */
	preBuild?: readonly (readonly string[])[];
	/** Extra entries to splice into `files`. */
	extraFiles?: readonly string[];
	/** Extra tsgo invocations beyond `tsconfig.publish.json`. */
	extraTypeConfigs?: readonly string[];
	/**
	 * `bin` map for the published manifest. The on-repo manifest points `bin`
	 * at TS source so source installs (`bun link`, `install.sh --source`) work
	 * without a build; publish swaps in the `prepack` bundle.
	 */
	publishBin?: Readonly<Record<string, string>>;
}

interface PreparedPublishPackage {
	pkg: PublishPackage;
	manifest: PackageManifest;
	name: string;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}
interface PackageManifest {
	[key: string]: JsonValue | undefined;
	name?: string;
	version?: string;
	private?: boolean;
	files?: JsonValue[];
	optionalDependencies?: JsonObject;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const defaultPrepareConcurrency = 4;

function nativeLeafTagFromArgs(argv: readonly string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--native-leaf") {
			const tag = argv[i + 1];
			if (!tag) throw new Error("--native-leaf requires a native target tag");
			return tag;
		}
		if (arg.startsWith("--native-leaf=")) return arg.slice("--native-leaf=".length);
	}
	return null;
}

const nativeLeafTag = nativeLeafTagFromArgs(process.argv.slice(2));
export const packages: PublishPackage[] = [
	{ dir: "packages/utils", kind: "typescript" },
	{ dir: "packages/wire", kind: "typescript" },
	{ dir: "packages/catalog", kind: "typescript" },
	{ dir: "packages/ai", kind: "typescript" },
	{ dir: "packages/natives", kind: "native" },
	{ dir: "packages/tui", kind: "typescript" },
	{ dir: "packages/hashline", kind: "typescript" },
	{ dir: "packages/mnemopi", kind: "typescript" },
	{ dir: "packages/snapcompact", kind: "typescript" },
	{
		dir: "packages/stats",
		kind: "typescript",
		preBuild: [["bun", "run", "build"]],
		extraFiles: ["dist/client"],
		extraTypeConfigs: ["tsconfig.publish.client.json"],
	},
	{ dir: "packages/agent", kind: "typescript" },
	{ dir: "packages/deep-research", kind: "typescript" },
	{
		dir: "packages/coding-agent",
		kind: "typescript",
		publishBin: { "oh-my-pk": "dist/cli.js", ompk: "dist/cli.js", omp: "dist/cli.js" },
	},
];

function rewriteSrcPath(value: string): string {
	if (!value.startsWith("./src/")) return value;
	const rel = value.slice("./src/".length).replace(/\.tsx?$/, "");
	return `./dist/types/${rel}.d.ts`;
}

function rewriteExports(exports: JsonValue): JsonValue {
	if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return exports;
	const src = exports as JsonObject;
	const out: JsonObject = {};
	for (const key in src) {
		const val = src[key];
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			typeof (val as JsonObject).types === "string" &&
			((val as JsonObject).types as string).startsWith("./src/")
		) {
			const next: JsonObject = { ...(val as JsonObject) };
			next.types = rewriteSrcPath(next.types as string);
			out[key] = next;
		} else {
			out[key] = val;
		}
	}
	return out;
}

async function rewriteManifest(pkg: PublishPackage, write: boolean): Promise<PackageManifest> {
	const manifestPath = path.join(repoRoot, pkg.dir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	if (pkg.publishBin) manifest.bin = { ...pkg.publishBin };
	if (typeof manifest.types === "string" && manifest.types.startsWith("./src/")) {
		manifest.types = rewriteSrcPath(manifest.types);
	}
	if (manifest.exports !== undefined) manifest.exports = rewriteExports(manifest.exports);
	const files = Array.isArray(manifest.files) ? [...manifest.files] : [];
	const hasDist = files.includes("dist");
	if (!hasDist && !files.includes("dist/types")) files.push("dist/types");
	for (const extra of pkg.extraFiles ?? []) {
		if (!hasDist && !files.includes(extra)) files.push(extra);
	}
	manifest.files = files;
	if (write) await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

async function preparePackage(pkg: PublishPackage): Promise<PackageManifest> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	for (const argv of pkg.preBuild ?? []) {
		await $`${argv}`.cwd(pkgDir);
	}
	await $`bun x tsgo -p tsconfig.publish.json`.cwd(pkgDir);
	for (const cfg of pkg.extraTypeConfigs ?? []) {
		await $`bun x tsgo -p ${cfg}`.cwd(pkgDir);
	}
	return rewriteManifest(pkg, !isDryRun);
}

function parsePrepareConcurrency(): number {
	const raw = Bun.env.PUBLISH_PREPARE_CONCURRENCY?.trim();
	if (!raw) return defaultPrepareConcurrency;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`PUBLISH_PREPARE_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}`);
	}
	return value;
}

async function mapConcurrent<T, U>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
	const results: Array<{ value: U } | undefined> = new Array(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(concurrency, items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		for (;;) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) return;
			const item = items[currentIndex];
			if (item === undefined) throw new Error(`Missing work item at index ${currentIndex}`);
			results[currentIndex] = { value: await mapper(item, currentIndex) };
		}
	});
	await Promise.all(workers);
	return results.map((result, index) => {
		if (!result) throw new Error(`Missing concurrent result at index ${index}`);
		return result.value;
	});
}

/**
 * Apply only the published `bin` rewrite to a package's working-tree
 * manifest. Used by `scripts/install-tests/run-ci.sh` to pack the coding
 * agent with its published topology (bin → prepack bundle) without running
 * the type-emission steps; the caller backs up and restores the manifest.
 */
export async function applyPublishBin(pkgRelDir: string, write: boolean): Promise<PackageManifest> {
	const pkg = packages.find(entry => entry.dir === pkgRelDir);
	if (!pkg?.publishBin) throw new Error(`No publishBin override declared for ${pkgRelDir}`);
	const manifestPath = path.join(repoRoot, pkgRelDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	manifest.bin = { ...pkg.publishBin };
	if (write) await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

function buildNativeOptionalDependencies(version: string): JsonObject {
	const optionalDependencies: JsonObject = {};
	for (const target of LEAF_TARGETS) {
		optionalDependencies[`@pk-nerdsaver-ai/pi-natives-${target.tag}`] = version;
	}
	return optionalDependencies;
}

export async function prepareNativeCorePackage(pkgDir: string, write: boolean): Promise<PackageManifest> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	if (typeof manifest.version !== "string") throw new Error(`Missing version in ${manifestPath}`);
	manifest.optionalDependencies = buildNativeOptionalDependencies(manifest.version);
	manifest.files = [
		"native/index.js",
		"native/index.d.ts",
		"native/loader-state.js",
		"native/loader-state.d.ts",
		"native/embedded-addon.js",
		"README.md",
	];
	if (write) await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

/**
 * Pack with `bun pm pack`, then publish the resolved tarball with `npm publish`.
 *
 * `bun pm pack` builds the tarball because it resolves the `catalog:` and
 * `workspace:` protocols (npm would ship them verbatim, producing
 * uninstallable manifests) and runs the `prepack` lifecycle, baking generated
 * sources (e.g. coding-agent's docs index) into the tarball.
 *
 * The tarball is handed to `npm publish` — not `bun publish` — because only the
 * npm CLI performs the OIDC trusted-publishing token exchange; `bun publish`
 * has no OIDC support (oven-sh/bun#22423). In CI with `id-token: write` granted
 * and `NODE_AUTH_TOKEN` set, npm tries OIDC per package and silently falls back
 * to the configured token when the package has no matching trusted publisher —
 * which also covers a package's first-ever publish. npm auto-enables provenance
 * only on the OIDC path, so we never pass `--provenance` (it would hard-fail the
 * token fallback).
 */
async function packAndPublish(dir: string, name: string): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun pm pack && npm publish --access public (${path.relative(repoRoot, dir)})`);
		return;
	}
	console.log(`Publishing ${name}…`);
	const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pack-"));
	try {
		const packed = await $`bun pm pack --quiet --destination ${packDir}`.cwd(dir).quiet().nothrow();
		const packOutput = `${packed.stdout.toString()}${packed.stderr.toString()}`.trim();
		if (packed.exitCode !== 0) {
			if (packOutput) console.log(packOutput);
			process.exit(packed.exitCode ?? 1);
		}
		const tarball = (await fs.readdir(packDir)).find(entry => entry.endsWith(".tgz"));
		if (!tarball) throw new Error(`bun pm pack produced no tarball for ${name} (${path.relative(repoRoot, dir)})`);
		const result = await $`npm publish ${path.join(packDir, tarball)} --access public`.quiet().nothrow();
		const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
		if (output) console.log(output);
		if (result.exitCode !== 0) {
			// Idempotent re-runs: tolerate this exact version already being on the
			// registry (the `bun publish --tolerate-republish` equivalent), but
			// surface every other failure.
			if (isVersionAlreadyPublished(output)) {
				console.log(`Skipping ${name} (version already published)`);
				return;
			}
			process.exit(result.exitCode ?? 1);
		}
	} finally {
		await fs.rm(packDir, { recursive: true, force: true });
	}
}

/** Match npm's rejection when this exact version already exists on the registry. */
function isVersionAlreadyPublished(output: string): boolean {
	return /cannot publish over the previously published version|EPUBLISHCONFLICT/i.test(output);
}

async function publishGeneratedLeafPackage(leaf: GeneratedLeafPackage): Promise<void> {
	await packAndPublish(leaf.dir, leaf.manifest.name);
}

async function publishNativeLeafPackage(tag: string): Promise<void> {
	const pkg = packages.find(candidate => candidate.kind === "native");
	if (!pkg) throw new Error("No native package configured");
	const pkgDir = path.join(repoRoot, pkg.dir);
	const coreManifest = (await Bun.file(path.join(pkgDir, "package.json")).json()) as PackageManifest;
	if (typeof coreManifest.version !== "string") throw new Error(`Missing version in ${pkg.dir}/package.json`);
	const leaves = await generateNpmPackages({
		packageDir: pkgDir,
		dryRun: isDryRun,
		version: coreManifest.version,
		tags: [tag],
	});
	const leaf = leaves[0];
	if (!leaf) throw new Error(`No native leaf generated for ${tag}`);
	await publishGeneratedLeafPackage(leaf);
}

async function preparePublishPackage(pkg: PublishPackage): Promise<PreparedPublishPackage> {
	if (pkg.kind === "native") {
		const pkgDir = path.join(repoRoot, pkg.dir);
		const manifest = await prepareNativeCorePackage(pkgDir, !isDryRun);
		const name = manifest.name ?? path.basename(pkg.dir);
		if (isDryRun) {
			console.log(`DRY RUN native core manifest rewrite (${pkg.dir})`);
			console.log(
				JSON.stringify({ optionalDependencies: manifest.optionalDependencies, files: manifest.files }, null, "\t"),
			);
		}
		return { pkg, manifest, name };
	}
	const manifest = await preparePackage(pkg);
	const name = manifest.name ?? path.basename(pkg.dir);
	return { pkg, manifest, name };
}

async function publishPreparedPackage(prepared: PreparedPublishPackage): Promise<void> {
	if (prepared.manifest.private) {
		console.log(`Skipping ${prepared.name} (private)`);
		return;
	}
	await packAndPublish(path.join(repoRoot, prepared.pkg.dir), prepared.name);
}

async function publishAllPackages(): Promise<void> {
	const concurrency = parsePrepareConcurrency();
	console.log(`Preparing ${packages.length} package manifests/types (concurrency=${concurrency})...`);
	const prepared = await mapConcurrent(packages, concurrency, pkg => preparePublishPackage(pkg));
	for (const entry of prepared) {
		await publishPreparedPackage(entry);
	}
}

if (import.meta.main) {
	if (nativeLeafTag) {
		await publishNativeLeafPackage(nativeLeafTag);
	} else {
		await publishAllPackages();
	}
}
