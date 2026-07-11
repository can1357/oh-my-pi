#!/usr/bin/env bun
import * as path from "node:path";
/**
 * Build release binaries and publish them to the PRIVATE Hugging Face repo that
 * backs the install endpoint (oh-my-pk.pkking.computer). This installer channel
 * is independent of the binaries published in GitHub Releases by Actions.
 *
 * Layout written to the HF repo:
 *   VERSION                         -> the latest tag (e.g. "v16.1.8")
 *   <tag>/omp-linux-x64            (and the other built targets)
 *   <tag>/omp-windows-x64.exe
 *
 * The Cloudflare Worker (infra/install-redirect) serves these to installers.
 *
 * Prerequisites:
 *   - `hf` CLI:  pip install -U huggingface_hub
 *   - env HF_TOKEN  : write-scoped token for the binaries repo
 *   - env HF_REPO   : e.g. "kingkillery/oh-my-pi-binaries" (default below)
 *   - the native toolchain for each requested target (a single host usually only
 *     builds its own platform; darwin needs a Mac).
 *
 * Usage:
 *   HF_TOKEN=hf_xxx bun scripts/publish-binaries-hf.ts                 # host platform, version from package.json
 *   HF_TOKEN=hf_xxx bun scripts/publish-binaries-hf.ts --targets linux-x64,linux-arm64 --tag v16.1.8
 *   HF_TOKEN=hf_xxx bun scripts/publish-binaries-hf.ts --force-build   # rebuild/re-upload even if the target already exists
 *   bun scripts/publish-binaries-hf.ts --dry-run
 */
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");

const isDryRun = process.argv.includes("--dry-run");
const hfRepo = Bun.env.HF_REPO ?? "pkkidking/oh-my-pi-binaries";
const hfRepoType = Bun.env.HF_REPO_TYPE ?? "model";

export interface RequestedBinaryTarget {
	id: string;
	file: string;
}

export interface BinaryPublishPlan {
	requested: RequestedBinaryTarget[];
	toBuild: RequestedBinaryTarget[];
	skippedExisting: RequestedBinaryTarget[];
	presentAfterBuild: Set<string>;
	missingRequiredAfterBuild: string[];
}

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag);
}

/** Every platform binary the install endpoint must serve for a tag to be complete. */
const REQUIRED_BINARIES = [
	"omp-darwin-arm64",
	"omp-darwin-x64",
	"omp-linux-arm64",
	"omp-linux-x64",
	"omp-windows-x64.exe",
] as const;

/** Binaries already present under `<tag>/` in the HF repo (basenames); empty on any API error. */
async function existingBinariesForTag(tag: string): Promise<Set<string>> {
	const kind = hfRepoType === "dataset" ? "datasets" : "models";
	try {
		const res = await fetch(`https://huggingface.co/api/${kind}/${hfRepo}?blobs=false`, {
			headers: Bun.env.HF_TOKEN ? { Authorization: `Bearer ${Bun.env.HF_TOKEN}` } : {},
		});
		if (!res.ok) return new Set();
		const data = (await res.json()) as { siblings?: Array<{ rfilename: string }> };
		const prefix = `${tag}/`;
		return new Set(
			(data.siblings ?? [])
				.map(s => s.rfilename)
				.filter(f => f.startsWith(prefix))
				.map(f => f.slice(prefix.length)),
		);
	} catch {
		return new Set();
	}
}

/** The tag the install endpoint currently resolves (the live VERSION pointer), if readable. */
async function currentPublishedVersion(): Promise<string | undefined> {
	const base = hfRepoType === "dataset" ? `datasets/${hfRepo}` : hfRepo;
	try {
		const res = await fetch(`https://huggingface.co/${base}/resolve/main/VERSION`, {
			headers: Bun.env.HF_TOKEN ? { Authorization: `Bearer ${Bun.env.HF_TOKEN}` } : {},
		});
		if (!res.ok) return undefined;
		return (await res.text()).trim() || undefined;
	} catch {
		return undefined;
	}
}

function hostTargetId(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	switch (process.platform) {
		case "win32":
			return "win32-x64";
		case "darwin":
			return `darwin-${arch}`;
		case "linux":
			return `linux-${arch}`;
		default:
			throw new Error(`Unsupported host platform: ${process.platform}`);
	}
}

/** Build-target id -> the binary filename it produces (matches ci-release-build-binaries.ts outfiles). */
const TARGET_FILE: Record<string, string> = {
	"darwin-arm64": "omp-darwin-arm64",
	"darwin-x64": "omp-darwin-x64",
	"linux-arm64": "omp-linux-arm64",
	"linux-x64": "omp-linux-x64",
	"win32-x64": "omp-windows-x64.exe",
};

export function parseRequestedBinaryTargets(targets: string): RequestedBinaryTarget[] {
	return targets
		.split(",")
		.map(t => t.trim())
		.filter(Boolean)
		.map(id => {
			const file = TARGET_FILE[id];
			if (!file) throw new Error(`Unknown target "${id}". Known: ${Object.keys(TARGET_FILE).join(", ")}`);
			return { id, file };
		});
}

export function planBinaryPublish(
	targets: string,
	existingFiles: ReadonlySet<string>,
	forceBuild: boolean,
): BinaryPublishPlan {
	const requested = parseRequestedBinaryTargets(targets);
	const toBuild = forceBuild ? requested : requested.filter(target => !existingFiles.has(target.file));
	const skippedExisting = forceBuild ? [] : requested.filter(target => existingFiles.has(target.file));
	const presentAfterBuild = new Set<string>([...existingFiles, ...toBuild.map(target => target.file)]);
	return {
		requested,
		toBuild,
		skippedExisting,
		presentAfterBuild,
		missingRequiredAfterBuild: REQUIRED_BINARIES.filter(file => !presentAfterBuild.has(file)),
	};
}

async function resolveTag(): Promise<string> {
	const explicit = arg("--tag");
	if (explicit) return explicit.startsWith("v") ? explicit : `v${explicit}`;
	const pkg = await Bun.file(path.join(repoRoot, "packages", "coding-agent", "package.json")).json();
	return `v${pkg.version}`;
}

async function main(): Promise<void> {
	const tag = await resolveTag();
	const targets = arg("--targets") ?? hostTargetId();
	const forceBuild = hasFlag("--force-build");

	if (!isDryRun && !Bun.env.HF_TOKEN) {
		throw new Error("HF_TOKEN is required (write-scoped Hugging Face token). See script header.");
	}

	console.log(`Publishing oh-my-pi binaries`);
	console.log(`  repo:    ${hfRepo} (${hfRepoType}, private)`);
	console.log(`  tag:     ${tag}`);
	console.log(`  targets: ${targets}`);
	if (forceBuild) console.log("  force:   rebuild/re-upload existing targets");
	console.log();

	const existingBeforeBuild = await existingBinariesForTag(tag);
	const plan = planBinaryPublish(targets, existingBeforeBuild, forceBuild);
	if (plan.skippedExisting.length > 0) {
		console.log(`Already present on ${hfRepo} under ${tag}/; skipping build/upload:`);
		for (const target of plan.skippedExisting) console.log(`  ${target.id} (${target.file})`);
		console.log();
	}

	// 1. Build the requested binaries. ci-release-build-binaries.ts writes them to
	//    packages/coding-agent/binaries/ and leaves them there (its reset only
	//    touches embedded-native/bundle source placeholders).
	if (plan.toBuild.length === 0) {
		console.log("All requested binaries already exist in the distribution repo; skipping local build.");
	} else {
		const buildTargets = plan.toBuild.map(target => target.id).join(",");
		console.log(`Building binaries: ${buildTargets}`);
		const buildArgs = ["scripts/ci-release-build-binaries.ts", "--targets", buildTargets];
		if (isDryRun) buildArgs.push("--dry-run");
		await $`bun ${buildArgs}`.cwd(repoRoot);
	}

	// 2. Stage a VERSION pointer next to the binaries.
	const versionFile = path.join(binariesDir, "VERSION");
	await Bun.write(versionFile, `${tag}\n`);

	// The binaries built THIS run, derived from the requested targets — NOT a
	// readdir of binariesDir, which also picks up stale binaries from earlier
	// releases and would wrongly mark the tag complete or upload an old binary
	// under the new tag.
	const built: string[] = [];
	for (const target of plan.toBuild) {
		if (await Bun.file(path.join(binariesDir, target.file)).exists()) built.push(target.file);
		else if (isDryRun) built.push(target.file);
		else throw new Error(`Expected ${target.file} after building "${target.id}", but it was not produced.`);
	}
	console.log(`\nBuilt: ${built.join(", ") || "(none)"}`);

	const forceVersion = hasFlag("--force-version");
	const skipVersion = hasFlag("--no-version");

	if (isDryRun) {
		console.log(`\nDRY RUN — would upload:`);
		for (const f of built) console.log(`  ${binariesDir}/${f} -> ${hfRepo}:${tag}/${f}`);
		const present = new Set<string>([...existingBeforeBuild, ...built]);
		const missing = REQUIRED_BINARIES.filter(f => !present.has(f));
		if (skipVersion) console.log(`  VERSION left unchanged (--no-version)`);
		else if (missing.length === 0 || forceVersion)
			console.log(`  ${versionFile} -> ${hfRepo}:VERSION (flip to ${tag})`);
		else console.log(`  VERSION NOT flipped — ${tag} would still be missing: ${missing.join(", ")}`);
		return;
	}

	// 3. Upload the built binaries under <tag>/. `hf upload` handles LFS for the
	//    large binaries; HF_TOKEN is read from the env.
	if (built.length > 0) {
		console.log(`\nUploading to ${hfRepo} ...`);
		for (const f of built) {
			await $`hf upload ${hfRepo} ${path.join(binariesDir, f)} ${`${tag}/${f}`} --repo-type ${hfRepoType}`.cwd(
				repoRoot,
			);
		}
	} else {
		console.log(`\nNo binary uploads needed.`);
	}

	// 4. Flip the VERSION pointer ONLY when every platform binary exists for this
	//    tag (just-built ∪ already-uploaded). A host builds its own platform only
	//    (darwin needs a Mac), so flipping after a partial upload 404s the missing
	//    platforms; leave installs on the last complete tag until the rest land.
	//    `--force-version` overrides; `--no-version` never flips.
	const present = new Set<string>([...existingBeforeBuild, ...built]);
	const missing = REQUIRED_BINARIES.filter(f => !present.has(f));

	if (skipVersion) {
		console.log(`\n✓ Uploaded ${built.length} binary/binaries under ${tag}/; VERSION left unchanged (--no-version).`);
	} else if (missing.length === 0 || forceVersion) {
		await $`hf upload ${hfRepo} ${versionFile} VERSION --repo-type ${hfRepoType}`.cwd(repoRoot);
		const note = missing.length > 0 ? ` (forced; still missing ${missing.join(", ")})` : "";
		console.log(`\n✓ Published ${tag} → ${hfRepo} and flipped VERSION${note}.`);
		console.log(`  Installs via oh-my-pk.pkking.computer now resolve ${tag}.`);
	} else {
		const current = await currentPublishedVersion();
		console.log(`\n✓ Uploaded ${built.length} binary/binaries under ${tag}/ on ${hfRepo}.`);
		console.log(`⚠ VERSION NOT flipped — ${tag} is missing: ${missing.join(", ")}.`);
		console.log(`  Installs keep resolving ${current ?? "the previous complete tag"}.`);
		console.log(`  Build the rest on their hosts (darwin needs a Mac), e.g.:`);
		console.log(`    bun scripts/publish-binaries-hf.ts --tag ${tag} --targets darwin-arm64,darwin-x64`);
		console.log(`  then re-run (VERSION flips automatically once all platforms exist), or pass --force-version.`);
	}
}

if (import.meta.main) {
	await main();
}
