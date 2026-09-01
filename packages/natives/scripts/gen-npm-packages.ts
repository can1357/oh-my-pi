#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface LeafTarget {
	tag: string;
	os: string;
	cpu: string;
}

export interface BuildLeafManifestInput extends LeafTarget {
	files: readonly string[];
	version: string;
}

export interface LeafManifest {
	name: string;
	version: string;
	author: string;
	os: string[];
	cpu: string[];
	main: string;
	files: string[];
	license: string;
	repository: {
		type: string;
		url: string;
		directory: string;
	};
	engines: {
		bun: string;
	};
}

export interface GeneratedLeafPackage {
	tag: string;
	dir: string;
	files: string[];
	manifest: LeafManifest;
	missing: boolean;
}

export interface GenerateNpmPackagesInput {
	packageDir?: string;
	dryRun?: boolean;
	version?: string;
	tags?: readonly string[];
}

export const LEAF_TARGETS: readonly LeafTarget[] = [
	{ tag: "linux-x64", os: "linux", cpu: "x64" },
	{ tag: "linux-arm64", os: "linux", cpu: "arm64" },
	{ tag: "darwin-x64", os: "darwin", cpu: "x64" },
	{ tag: "darwin-arm64", os: "darwin", cpu: "arm64" },
	{ tag: "win32-x64", os: "win32", cpu: "x64" },
];

const packageDirDefault = path.join(import.meta.dir, "..");
const NATIVE_LEAF_LEGAL_FILES = ["LICENSE", "THIRD-PARTY-NOTICES.txt"] as const;

function expectedAddonFilenames(tag: string): string[] {
	return tag.endsWith("-x64")
		? [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}-modern.node`, `pi_natives.${tag}.node`]
		: [`pi_natives.${tag}.node`];
}

function discoverAddonFiles(nativeDir: string, tag: string): Promise<string[]> {
	return Promise.all(
		expectedAddonFilenames(tag).map(async filename =>
			(await Bun.file(path.join(nativeDir, filename)).exists()) ? filename : null,
		),
	).then(files => files.filter(file => file !== null));
}

function selectPrimaryAddonFile(tag: string, files: readonly string[]): string {
	const baseline = `pi_natives.${tag}-baseline.node`;
	if (files.includes(baseline)) return baseline;
	const defaultFile = `pi_natives.${tag}.node`;
	if (files.includes(defaultFile)) return defaultFile;
	return files[0];
}

export function buildLeafManifest({ tag, os, cpu, files, version }: BuildLeafManifestInput): LeafManifest {
	const addonFiles = [...new Set(files.map(file => path.basename(file)))];
	if (addonFiles.length === 0) throw new Error(`No native addon files found for ${tag}`);
	for (const file of addonFiles) {
		if (!file.endsWith(".node")) throw new Error(`Leaf ${tag} includes non-addon file: ${file}`);
	}
	const main = selectPrimaryAddonFile(tag, addonFiles);
	return {
		name: `@oh-my-pi/pi-natives-${tag}`,
		version,
		author: "Stencil Labs, Inc.",
		os: [os],
		cpu: [cpu],
		main: `./${main}`,
		files: ["*.node", "README.md", ...NATIVE_LEAF_LEGAL_FILES],
		license: "MIT",
		repository: {
			type: "git",
			url: "git+https://github.com/can1357/oh-my-pi.git",
			directory: "packages/natives",
		},
		engines: {
			bun: ">=1.3.14",
		},
	};
}

function buildReadme(tag: string, manifest: LeafManifest): string {
	return `# ${manifest.name}\n\nPlatform native addon package for \`@oh-my-pi/pi-natives\` on ${tag}.\n\nThis package is generated during release and installed as an optional dependency of the core package.\n`;
}

function selectTargets(tags: readonly string[] | undefined): readonly LeafTarget[] {
	if (!tags) return LEAF_TARGETS;
	const wanted = new Set(tags);
	const targets = LEAF_TARGETS.filter(target => wanted.has(target.tag));
	if (targets.length !== wanted.size) {
		const known = new Set(LEAF_TARGETS.map(target => target.tag));
		const unknown = tags.filter(tag => !known.has(tag));
		throw new Error(`Unknown native package tag(s): ${unknown.join(", ")}`);
	}
	return targets;
}

async function resolveLegalPayload(packageDir: string, file: string): Promise<string | undefined> {
	const local = path.join(packageDir, file);
	if (await Bun.file(local).exists()) return local;
	const repository = path.resolve(packageDir, "../..", file);
	return (await Bun.file(repository).exists()) ? repository : undefined;
}

export async function generateNpmPackages({
	packageDir = packageDirDefault,
	dryRun = false,
	version,
	tags,
}: GenerateNpmPackagesInput = {}): Promise<GeneratedLeafPackage[]> {
	const manifestVersion =
		version ?? ((await Bun.file(path.join(packageDir, "package.json")).json()) as { version: string }).version;
	const nativeDir = path.join(packageDir, "native");
	const npmDir = path.join(packageDir, "npm");
	const leaves: GeneratedLeafPackage[] = [];

	for (const target of selectTargets(tags)) {
		const files = await discoverAddonFiles(nativeDir, target.tag);
		const manifestFiles = files.length > 0 ? files : [expectedAddonFilenames(target.tag)[0]];
		const manifest = buildLeafManifest({ ...target, files: manifestFiles, version: manifestVersion });
		const leafDir = path.join(npmDir, target.tag);
		const missing = files.length === 0;
		leaves.push({ tag: target.tag, dir: leafDir, files, manifest, missing });

		if (dryRun) {
			const fileList = missing ? "missing" : files.join(", ");
			console.log(`DRY RUN generate ${manifest.name} (${fileList}) -> ${path.relative(packageDir, leafDir)}`);
			console.log(JSON.stringify(manifest, null, "\t"));
			continue;
		}

		if (missing) throw new Error(`Missing native addon files for ${target.tag} in ${nativeDir}`);
		await fs.rm(leafDir, { recursive: true, force: true });
		await fs.mkdir(leafDir, { recursive: true });
		for (const file of files) {
			await fs.copyFile(path.join(nativeDir, file), path.join(leafDir, file));
		}
		for (const file of NATIVE_LEAF_LEGAL_FILES) {
			const source = await resolveLegalPayload(packageDir, file);
			if (!source) throw new Error(`Missing legal payload ${file} for generated native leaf ${target.tag}`);
			await fs.copyFile(source, path.join(leafDir, file));
		}
		await Bun.write(path.join(leafDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		await Bun.write(path.join(leafDir, "README.md"), buildReadme(target.tag, manifest));
	}

	return leaves;
}

/** Parse repeatable `--tag <tag>` / `--tag=<tag>` flags; undefined means all targets. */
function parseTagArgs(argv: readonly string[]): readonly string[] | undefined {
	const tags: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--tag") {
			const value = argv[i + 1];
			if (!value) throw new Error("--tag requires a native target tag");
			tags.push(value);
			i++;
		} else if (arg.startsWith("--tag=")) {
			tags.push(arg.slice("--tag=".length));
		}
	}
	return tags.length > 0 ? tags : undefined;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	await generateNpmPackages({ dryRun: argv.includes("--dry-run"), tags: parseTagArgs(argv) });
}
