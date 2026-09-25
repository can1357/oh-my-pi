/**
 * Skillshare installer: resolve registry versions, verify and unpack tarballs
 * into the shared store, and maintain `skills.json` / `skills.lock.json`.
 *
 * The `*SkillPackages` / `format*` / `listInstalledSkills` functions return
 * data and report through {@link SkillInstallHooks}, so both the `omp skill`
 * CLI (the exit-code wrappers at the bottom) and the TUI `/skills` command
 * share one implementation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { formatAge, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	SKILLS_ROUTES,
	type SkillFile,
	type SkillPackument,
	type SkillSearchResponse,
	type SkillSearchSort,
	type SkillVersionManifest,
	type SkillVersionSummary,
} from "@oh-my-pi/pi-wire/skillshare";
import { parseSkillSpec, SkillshareClient, SkillshareError } from "./client";
import {
	formatSkillId,
	getGlobalSkillsInstallPaths,
	getProjectSkillsInstallPaths,
	getSkillStorePath,
	getSkillsInstallPaths,
	parseSkillId,
	readSkillsLock,
	readSkillsManifest,
	readStoredIntegrity,
	STORE_INTEGRITY_FILE,
	type SkillsInstallPaths,
	type SkillsLock,
	writeSkillsLock,
	writeSkillsManifest,
} from "./manifest";
import { readTar } from "./tar";

/** `1.2.3`, `v1.2.3`, `1.2.3-beta.1+build` — an exact version rather than a range or tag. */
const EXACT_VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const INFO_VERSION_LIMIT = 20;

// ─── Resolution ───────────────────────────────────────────────────────────────

export interface SkillResolution {
	version: string;
	summary: SkillVersionSummary;
	/** Yanked / deprecated notices for the chosen version. */
	warnings: string[];
}

/**
 * Pick a version from a packument:
 * - exact version → that version, even when yanked;
 * - dist-tag → the tagged version;
 * - range → highest non-yanked version satisfying it.
 */
export function resolveSkillVersion(packument: SkillPackument, request: string): SkillResolution {
	const id = formatSkillId(packument.scope, packument.name);
	const exact = EXACT_VERSION_RE.exec(request)?.[1];
	let version: string | undefined;
	if (exact !== undefined) {
		if (!Object.hasOwn(packument.versions, exact)) throw new Error(`${id}@${exact} does not exist`);
		version = exact;
	} else if (Object.hasOwn(packument.distTags, request)) {
		version = packument.distTags[request]!;
	} else {
		for (const candidate in packument.versions) {
			if (packument.versions[candidate]!.yanked || !Bun.semver.satisfies(candidate, request)) continue;
			if (version === undefined || Bun.semver.order(candidate, version) > 0) version = candidate;
		}
		if (version === undefined) throw new Error(`No non-yanked version of ${id} matches "${request}"`);
	}
	const summary = packument.versions[version];
	if (!summary) throw new Error(`${id}: dist-tag "${request}" points at unknown version ${version}`);
	return { version, summary, warnings: versionWarnings(id, summary) };
}

function versionWarnings(id: string, summary: SkillVersionSummary): string[] {
	const warnings: string[] = [];
	if (summary.yanked) warnings.push(`${id}@${summary.version} is yanked`);
	if (summary.deprecated) warnings.push(`${id}@${summary.version} is deprecated: ${summary.deprecated}`);
	return warnings;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/** SRI `sha512-<base64>` of a tarball. */
export function computeIntegrity(bytes: Uint8Array): string {
	return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
}

/**
 * Download one version, verify its integrity BEFORE unpacking, and move it
 * into the store atomically. No-op when the store already holds a copy with
 * the same integrity. Returns the store directory.
 */
export async function storeSkillVersion(
	client: SkillshareClient,
	pkg: { scope: string; name: string; version: string; integrity: string },
): Promise<string> {
	const dir = getSkillStorePath(pkg.scope, pkg.name, pkg.version);
	if ((await readStoredIntegrity(dir)) === pkg.integrity) return dir;
	const label = `${formatSkillId(pkg.scope, pkg.name)}@${pkg.version}`;

	const tgz = await client.tarball(pkg.scope, pkg.name, pkg.version);
	const actual = computeIntegrity(tgz);
	if (actual !== pkg.integrity) {
		throw new Error(`${label}: integrity mismatch (expected ${pkg.integrity}, got ${actual}); nothing was installed`);
	}
	// readTar rejects absolute, non-normalized, duplicate, and non-regular entries.
	// Bun's gzip APIs need an ArrayBuffer-backed view; the client's bytes may sit on a SharedArrayBuffer-typed backing.
	const entries = readTar(Bun.gunzipSync(new Uint8Array(tgz)));
	if (entries.some(entry => entry.path === STORE_INTEGRITY_FILE)) {
		throw new Error(`${label}: archive contains reserved path ${STORE_INTEGRITY_FILE}`);
	}
	if (!entries.some(entry => entry.path === "SKILL.md")) throw new Error(`${label}: archive has no SKILL.md`);

	const parent = path.dirname(dir);
	await fs.mkdir(parent, { recursive: true });
	const staging = await fs.mkdtemp(path.join(parent, `.${pkg.version}.tmp-`));
	try {
		for (const entry of entries) {
			const target = path.join(staging, ...entry.path.split("/"));
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, entry.content, { flag: "wx" });
			await fs.chmod(target, entry.executable ? 0o755 : 0o644);
		}
		await fs.writeFile(path.join(staging, STORE_INTEGRITY_FILE), `${pkg.integrity}\n`);
		// A leftover copy without a matching marker is partial or tampered: replace it.
		await fs.rm(dir, { recursive: true, force: true });
		try {
			await fs.rename(staging, dir);
		} catch (error) {
			// A concurrent install may have won the rename with the same bytes.
			if ((await readStoredIntegrity(dir)) !== pkg.integrity) throw error;
			await fs.rm(staging, { recursive: true, force: true });
		}
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true });
		throw error;
	}
	return dir;
}

/**
 * Remove store dirs this operation stopped referencing, unless the global or
 * current project lock still uses them. Other projects' dirs are restored on
 * their next `omp skill update` / `omp skill install`.
 */
async function pruneReleased(
	released: ReadonlyArray<{ id: string; version: string }>,
	cwd: string,
	current: SkillsLock,
	currentPaths: SkillsInstallPaths,
): Promise<void> {
	if (released.length === 0) return;
	// The lock just written plus the other scope's lock (global ↔ project).
	const globalPaths = getGlobalSkillsInstallPaths();
	const otherLockPath =
		globalPaths.lock !== currentPaths.lock
			? globalPaths.lock
			: (await getProjectSkillsInstallPaths(cwd).catch(() => null))?.lock;
	const locks: SkillsLock[] = [current];
	if (otherLockPath && otherLockPath !== currentPaths.lock) locks.push(await readSkillsLock(otherLockPath));
	const referenced = new Set<string>();
	for (const lock of locks) {
		for (const id in lock.skills) referenced.add(`${id}@${lock.skills[id]!.version}`);
	}
	for (const { id, version } of released) {
		if (referenced.has(`${id}@${version}`)) continue;
		const parsed = parseSkillId(id);
		if (!parsed) continue;
		const dir = getSkillStorePath(parsed.scope, parsed.name, version);
		await fs.rm(dir, { recursive: true, force: true });
		// Drop now-empty `name/` and `@scope/` dirs; ENOTEMPTY means siblings remain.
		for (const emptyCandidate of [path.dirname(dir), path.dirname(path.dirname(dir))]) {
			try {
				await fs.rmdir(emptyCandidate);
			} catch {
				break;
			}
		}
	}
}

// ─── Install / update / uninstall ─────────────────────────────────────────────

export interface ScriptApprovalRequest {
	id: string;
	version: string;
	/** Executables and everything under `scripts/`. */
	files: SkillFile[];
}

export interface SkillInstallHooks {
	/** Resolve `true` to install a version that ships scripts. */
	confirmScripts(request: ScriptApprovalRequest): Promise<boolean>;
	warn(message: string): void;
}

export interface SkillChange {
	id: string;
	/** Previously locked version, when there was one. */
	from?: string;
	to: string;
	/** Manifest range recorded for the package. */
	range: string;
	/** The locked version was re-unpacked because its store dir was missing or damaged. */
	restored: boolean;
}

interface PlannedInstall {
	scope: string;
	name: string;
	id: string;
	range: string;
	version: string;
	integrity: string;
	hasScripts: boolean;
}

interface InstallState {
	paths: SkillsInstallPaths;
	manifest: { skills: Record<string, string> };
	lock: SkillsLock;
	cwd: string;
	yes: boolean;
}

/** Human-readable listing of the files a script-bearing version ships. */
export function formatScriptApproval(request: ScriptApprovalRequest): string {
	const lines = [`${request.id}@${request.version} ships scripts:`];
	for (const file of request.files) lines.push(`  ${file.path}${file.executable ? " (executable)" : ""}`);
	return lines.join("\n");
}

async function fetchPackument(client: SkillshareClient, scope: string, name: string): Promise<SkillPackument> {
	try {
		return await client.packument(scope, name);
	} catch (error) {
		if (error instanceof SkillshareError && error.status === 404) {
			throw new Error(`${formatSkillId(scope, name)} was not found in the registry`);
		}
		throw error;
	}
}

function planFromResolution(
	scope: string,
	name: string,
	range: string,
	resolution: SkillResolution,
	hooks: SkillInstallHooks,
): PlannedInstall {
	for (const warning of resolution.warnings) hooks.warn(warning);
	return {
		scope,
		name,
		id: formatSkillId(scope, name),
		range,
		version: resolution.version,
		integrity: resolution.summary.integrity,
		hasScripts: resolution.summary.hasScripts,
	};
}

/**
 * Apply plans in three phases so a failure never leaves a half-written
 * manifest: (1) drop plans already satisfied and ask about scripts for every
 * version that must be unpacked, (2) download + verify + unpack, (3) write
 * the manifest and lock once, then prune store dirs the lock released.
 * A version already in the store was approved when it was first unpacked.
 */
async function applyPlans(
	client: SkillshareClient,
	plans: PlannedInstall[],
	state: InstallState,
	hooks: SkillInstallHooks,
): Promise<SkillChange[]> {
	const work: Array<{ plan: PlannedInstall; stored: boolean }> = [];
	for (const plan of plans) {
		const locked = state.lock.skills[plan.id];
		if (locked?.version === plan.version && locked.integrity !== plan.integrity) {
			throw new Error(
				`${plan.id}@${plan.version}: registry integrity ${plan.integrity} differs from the lock (${locked.integrity})`,
			);
		}
		const stored =
			(await readStoredIntegrity(getSkillStorePath(plan.scope, plan.name, plan.version))) === plan.integrity;
		if (stored && locked?.version === plan.version && state.manifest.skills[plan.id] === plan.range) continue;
		if (!stored && plan.hasScripts && !state.yes) {
			const manifest: SkillVersionManifest = await client.version(plan.scope, plan.name, plan.version);
			const files = manifest.files.filter(file => file.executable || file.path.startsWith("scripts/"));
			if (!(await hooks.confirmScripts({ id: plan.id, version: plan.version, files }))) {
				throw new Error(`Installation of ${plan.id}@${plan.version} was declined`);
			}
		}
		work.push({ plan, stored });
	}
	if (work.length === 0) return [];

	for (const { plan, stored } of work) {
		if (!stored) await storeSkillVersion(client, plan);
	}

	const changes: SkillChange[] = [];
	const released: Array<{ id: string; version: string }> = [];
	for (const { plan, stored } of work) {
		const previous = state.lock.skills[plan.id];
		if (previous && previous.version !== plan.version) released.push({ id: plan.id, version: previous.version });
		state.manifest.skills[plan.id] = plan.range;
		state.lock.skills[plan.id] = {
			version: plan.version,
			integrity: plan.integrity,
			resolved: SKILLS_ROUTES.tarball(plan.scope, plan.name, plan.version),
		};
		changes.push({
			id: plan.id,
			from: previous?.version,
			to: plan.version,
			range: plan.range,
			restored: !stored && previous?.version === plan.version,
		});
	}
	await writeSkillsManifest(state.paths.manifest, state.manifest);
	await writeSkillsLock(state.paths.lock, state.lock);
	await pruneReleased(released, state.cwd, state.lock, state.paths);
	return changes;
}

export interface InstallSkillPackagesOptions {
	/** `@scope/name[@range|version|tag]`; empty installs everything the manifest lists. */
	specs: string[];
	global: boolean;
	yes: boolean;
	cwd: string;
}

/**
 * Install packages. With specs: resolve each (default range `^<latest>`,
 * recorded in the manifest like npm). Without specs: restore every locked
 * version exactly and resolve manifest entries the lock lacks. Returns what
 * changed; already-satisfied packages are omitted.
 */
export async function installSkillPackages(
	client: SkillshareClient,
	opts: InstallSkillPackagesOptions,
	hooks: SkillInstallHooks,
): Promise<SkillChange[]> {
	const paths = await getSkillsInstallPaths(opts);
	const [manifest, lock] = await Promise.all([readSkillsManifest(paths.manifest), readSkillsLock(paths.lock)]);
	const plans: PlannedInstall[] = [];

	for (const spec of opts.specs) {
		const parsed = parseSkillSpec(spec);
		if (!parsed) throw new Error(`Invalid skill spec "${spec}": expected @scope/name[@version|range|tag]`);
		const packument = await fetchPackument(client, parsed.scope, parsed.name);
		if (parsed.range === undefined && !packument.distTags.latest) {
			throw new Error(
				`${formatSkillId(parsed.scope, parsed.name)} has no "latest" version; specify a version, range, or tag`,
			);
		}
		const resolution = resolveSkillVersion(packument, parsed.range ?? "latest");
		const range = parsed.range ?? `^${resolution.version}`;
		plans.push(planFromResolution(parsed.scope, parsed.name, range, resolution, hooks));
	}

	if (opts.specs.length === 0) {
		for (const id in manifest.skills) {
			const parsed = parseSkillId(id)!;
			const range = manifest.skills[id]!;
			const locked = lock.skills[id];
			if (!locked) {
				const packument = await fetchPackument(client, parsed.scope, parsed.name);
				plans.push(
					planFromResolution(parsed.scope, parsed.name, range, resolveSkillVersion(packument, range), hooks),
				);
				continue;
			}
			const stored = await readStoredIntegrity(getSkillStorePath(parsed.scope, parsed.name, locked.version));
			if (stored === locked.integrity) continue;
			// Restore the exact locked version; applyPlans rejects registry bytes that differ from the lock.
			const summary = await client.version(parsed.scope, parsed.name, locked.version);
			for (const warning of versionWarnings(id, summary)) hooks.warn(warning);
			plans.push({
				scope: parsed.scope,
				name: parsed.name,
				id,
				range,
				version: locked.version,
				integrity: summary.integrity,
				hasScripts: summary.hasScripts,
			});
		}
	}

	return applyPlans(client, plans, { paths, manifest, lock, cwd: opts.cwd, yes: opts.yes }, hooks);
}

export interface UpdateSkillPackagesOptions {
	/** `@scope/name` ids; empty updates every manifest entry. */
	names: string[];
	global: boolean;
	cwd: string;
	/** Skip the scripts confirmation for versions that ship scripts. */
	yes?: boolean;
}

/**
 * Re-resolve manifest ranges and install versions that changed. Also restores
 * locked versions whose store dir went missing. Returns only actual changes.
 */
export async function updateSkillPackages(
	client: SkillshareClient,
	opts: UpdateSkillPackagesOptions,
	hooks: SkillInstallHooks,
): Promise<SkillChange[]> {
	const paths = await getSkillsInstallPaths(opts);
	const [manifest, lock] = await Promise.all([readSkillsManifest(paths.manifest), readSkillsLock(paths.lock)]);
	const ids = opts.names.length > 0 ? opts.names : Object.keys(manifest.skills);
	const plans: PlannedInstall[] = [];
	for (const id of ids) {
		const parsed = parseSkillId(id);
		if (!parsed) throw new Error(`Invalid skill name "${id}": expected @scope/name`);
		const range = manifest.skills[id];
		if (range === undefined) throw new Error(`${id} is not listed in ${paths.manifest}`);
		const packument = await fetchPackument(client, parsed.scope, parsed.name);
		plans.push(planFromResolution(parsed.scope, parsed.name, range, resolveSkillVersion(packument, range), hooks));
	}
	return applyPlans(client, plans, { paths, manifest, lock, cwd: opts.cwd, yes: opts.yes === true }, hooks);
}

/** Remove packages from the manifest and lock, pruning their store dirs. Returns removed ids. */
export async function uninstallSkillPackages(opts: {
	names: string[];
	global: boolean;
	cwd: string;
}): Promise<string[]> {
	const paths = await getSkillsInstallPaths(opts);
	const [manifest, lock] = await Promise.all([readSkillsManifest(paths.manifest), readSkillsLock(paths.lock)]);
	const released: Array<{ id: string; version: string }> = [];
	for (const id of opts.names) {
		if (!parseSkillId(id)) throw new Error(`Invalid skill name "${id}": expected @scope/name`);
		if (!Object.hasOwn(manifest.skills, id) && !Object.hasOwn(lock.skills, id)) {
			throw new Error(`${id} is not installed (${paths.manifest})`);
		}
	}
	for (const id of opts.names) {
		const locked = lock.skills[id];
		if (locked) released.push({ id, version: locked.version });
		delete manifest.skills[id];
		delete lock.skills[id];
	}
	await writeSkillsManifest(paths.manifest, manifest);
	await writeSkillsLock(paths.lock, lock);
	await pruneReleased(released, opts.cwd, lock, paths);
	return opts.names;
}

export interface InstalledSkillInfo {
	id: string;
	/** Manifest range; undefined for a lock entry without a manifest entry. */
	range?: string;
	/** Locked version; undefined when the manifest entry was never installed. */
	version?: string;
	scope: "project" | "user";
	/** Store dir present with the locked integrity. */
	stored: boolean;
}

/** Project (when `cwd` is inside one) and user-global installs. */
export async function listInstalledSkills(cwd: string): Promise<InstalledSkillInfo[]> {
	const sources: Array<{ scope: "project" | "user"; paths: SkillsInstallPaths }> = [];
	const project = await getProjectSkillsInstallPaths(cwd).catch(() => null);
	const global = getGlobalSkillsInstallPaths();
	if (project && project.lock !== global.lock) sources.push({ scope: "project", paths: project });
	sources.push({ scope: "user", paths: global });
	const out: InstalledSkillInfo[] = [];
	for (const { scope, paths } of sources) {
		const [manifest, lock] = await Promise.all([readSkillsManifest(paths.manifest), readSkillsLock(paths.lock)]);
		const ids = new Set([...Object.keys(manifest.skills), ...Object.keys(lock.skills)]);
		for (const id of [...ids].sort()) {
			const locked = lock.skills[id];
			const parsed = parseSkillId(id)!;
			const stored =
				locked !== undefined &&
				(await readStoredIntegrity(getSkillStorePath(parsed.scope, parsed.name, locked.version))) ===
					locked.integrity;
			out.push({ id, range: manifest.skills[id], version: locked?.version, scope, stored });
		}
	}
	return out;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Styling hooks so the same text renders colored in a terminal and plain in the TUI. */
export interface SkillOutputPaint {
	name(text: string): string;
	dim(text: string): string;
	warn(text: string): string;
}

export const PLAIN_PAINT: SkillOutputPaint = { name: text => text, dim: text => text, warn: text => text };
const ANSI_PAINT: SkillOutputPaint = {
	name: text => chalk.bold.cyan(text),
	dim: text => chalk.dim(text),
	warn: text => chalk.yellow(text),
};

function ago(timestampMs: number): string {
	return formatAge(Math.max(1, Math.floor((Date.now() - timestampMs) / 1000)));
}

export function formatSkillSearch(response: SkillSearchResponse, paint: SkillOutputPaint = PLAIN_PAINT): string {
	if (response.hits.length === 0) return "No skills found.";
	const lines: string[] = [];
	for (const hit of response.hits) {
		lines.push(`${paint.name(formatSkillId(hit.scope, hit.name))} ${hit.version}`);
		if (hit.description) lines.push(`  ${hit.description}`);
		const meta = [
			`${formatNumber(hit.weeklyDownloads)} weekly downloads`,
			`updated ${ago(hit.updatedAt)}`,
			`by ${hit.publisher.username}`,
		];
		if (hit.keywords.length > 0) meta.push(hit.keywords.join(", "));
		lines.push(`  ${paint.dim(meta.join(" · "))}`);
		if (hit.deprecated) lines.push(`  ${paint.warn(`deprecated: ${hit.deprecated}`)}`);
	}
	const shown = (response.page - 1) * response.perPage + response.hits.length;
	if (response.total > shown) lines.push(paint.dim(`… ${response.total - shown} more (page ${response.page})`));
	return lines.join("\n");
}

/** Packument summary; `version` selects the highlighted version (default `latest`). */
export function formatSkillInfo(
	packument: SkillPackument,
	version?: string,
	paint: SkillOutputPaint = PLAIN_PAINT,
): string {
	const id = formatSkillId(packument.scope, packument.name);
	const shownVersion = version ?? packument.distTags.latest;
	const summary = shownVersion ? packument.versions[shownVersion] : undefined;
	const lines: string[] = [];
	const header = [paint.name(shownVersion ? `${id}@${shownVersion}` : id)];
	if (packument.license) header.push(packument.license);
	lines.push(header.join(" · "));
	if (packument.description) lines.push(packument.description);
	if (summary?.yanked) lines.push(paint.warn("This version is yanked."));
	if (summary?.deprecated) lines.push(paint.warn(`Deprecated: ${summary.deprecated}`));
	lines.push("");
	if (packument.keywords.length > 0) lines.push(`keywords: ${packument.keywords.join(", ")}`);
	if (packument.repository) lines.push(`repository: ${packument.repository}`);
	if (packument.homepage) lines.push(`homepage: ${packument.homepage}`);

	const tags: string[] = [];
	for (const tag in packument.distTags) tags.push(`${tag}: ${packument.distTags[tag]}`);
	if (tags.length > 0) lines.push(`dist-tags: ${tags.join(", ")}`);

	const versions = Object.keys(packument.versions).sort((a, b) => Bun.semver.order(b, a));
	const versionLabels = versions.slice(0, INFO_VERSION_LIMIT).map(v => {
		const entry = packument.versions[v]!;
		const flags = [entry.yanked ? "yanked" : "", entry.deprecated ? "deprecated" : ""].filter(Boolean);
		return flags.length > 0 ? `${v} (${flags.join(", ")})` : v;
	});
	if (versions.length > INFO_VERSION_LIMIT) versionLabels.push(`… ${versions.length - INFO_VERSION_LIMIT} more`);
	lines.push(`versions: ${versionLabels.join(", ")}`);
	lines.push(`owners: ${packument.owners.map(owner => owner.username).join(", ")}`);
	lines.push(
		`downloads: ${formatNumber(packument.downloads.weekly)} weekly, ${formatNumber(packument.downloads.total)} total`,
	);
	if (summary) {
		lines.push(
			paint.dim(
				`published ${ago(summary.publishedAt)} by ${summary.publisher.username} · ${summary.fileCount} files${summary.hasScripts ? " · ships scripts" : ""}`,
			),
		);
	}
	lines.push(paint.dim(`updated ${ago(packument.updatedAt)}`));
	return lines.join("\n");
}

/** One line per change: `+ @a/b@1.0.0`, `@a/b 1.0.0 → 1.1.0`, restores, and range-only edits. */
export function formatSkillChanges(changes: SkillChange[], paint: SkillOutputPaint = PLAIN_PAINT): string {
	return changes
		.map(change => {
			const label = paint.name(`${change.id}@${change.to}`);
			if (change.from === undefined) return `+ ${label}`;
			if (change.from !== change.to) return `${paint.name(change.id)} ${change.from} → ${change.to}`;
			return change.restored
				? `✓ ${label} ${paint.dim("(restored)")}`
				: `✓ ${label} ${paint.dim(`(${change.range})`)}`;
		})
		.join("\n");
}

export function formatInstalledSkills(skills: InstalledSkillInfo[], paint: SkillOutputPaint = PLAIN_PAINT): string {
	if (skills.length === 0) return "No registry skills installed.";
	return skills
		.map(skill => {
			const version = skill.version ?? paint.warn("not installed");
			const notes = [skill.scope, skill.range ? `range ${skill.range}` : "not in manifest"];
			if (skill.version && !skill.stored) notes.push(paint.warn("missing from store; run update"));
			return `${paint.name(skill.id)} ${version} ${paint.dim(`(${notes.join(", ")})`)}`;
		})
		.join("\n");
}

// ─── CLI entry points (exit codes) ────────────────────────────────────────────

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function confirmScriptsOnTty(request: ScriptApprovalRequest): Promise<boolean> {
	const listing = formatScriptApproval(request);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(`${listing}\nRefusing to install scripts without confirmation; re-run with --yes to allow them.`);
	}
	process.stdout.write(`${chalk.yellow(listing)}\n`);
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question("Install anyway? [y/N] ");
		return /^y(?:es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

const CLI_HOOKS: SkillInstallHooks = {
	confirmScripts: confirmScriptsOnTty,
	warn: message => process.stderr.write(`${chalk.yellow("warn")} ${message}\n`),
};

async function withClient(run: (client: SkillshareClient) => Promise<number>): Promise<number> {
	let client: SkillshareClient | undefined;
	try {
		client = await SkillshareClient.create();
		return await run(client);
	} catch (error) {
		process.stderr.write(`${chalk.red("error")} ${describeError(error)}\n`);
		return 1;
	} finally {
		client?.close();
	}
}

export function installSkills(opts: { specs: string[]; global: boolean; yes: boolean; cwd: string }): Promise<number> {
	return withClient(async client => {
		const changes = await installSkillPackages(client, opts, CLI_HOOKS);
		const paths = await getSkillsInstallPaths(opts);
		process.stdout.write(
			changes.length > 0
				? `${formatSkillChanges(changes, ANSI_PAINT)}\n${chalk.dim(`Saved ${paths.manifest}`)}\n`
				: "Already up to date.\n",
		);
		return 0;
	});
}

export function updateSkills(opts: { names: string[]; global: boolean; cwd: string; yes?: boolean }): Promise<number> {
	return withClient(async client => {
		const changes = await updateSkillPackages(client, opts, CLI_HOOKS);
		process.stdout.write(
			changes.length > 0 ? `${formatSkillChanges(changes, ANSI_PAINT)}\n` : "All skills are up to date.\n",
		);
		return 0;
	});
}

export async function uninstallSkills(opts: { names: string[]; global: boolean; cwd: string }): Promise<number> {
	try {
		const removed = await uninstallSkillPackages(opts);
		for (const id of removed) process.stdout.write(`- ${ANSI_PAINT.name(id)}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`${chalk.red("error")} ${describeError(error)}\n`);
		return 1;
	}
}

export function searchSkills(opts: { query: string; sort: SkillSearchSort; json: boolean }): Promise<number> {
	return withClient(async client => {
		const response = await client.search(opts.query, { sort: opts.sort });
		process.stdout.write(
			opts.json ? `${JSON.stringify(response, null, 2)}\n` : `${formatSkillSearch(response, ANSI_PAINT)}\n`,
		);
		return 0;
	});
}

/** `@scope/name` shows the package; `@scope/name@<range|tag|version>` highlights (JSON: returns) that version. */
export function showSkillInfo(opts: { spec: string; json: boolean }): Promise<number> {
	return withClient(async client => {
		const parsed = parseSkillSpec(opts.spec);
		if (!parsed) throw new Error(`Invalid skill spec "${opts.spec}": expected @scope/name[@version|range|tag]`);
		const packument = await fetchPackument(client, parsed.scope, parsed.name);
		const version = parsed.range === undefined ? undefined : resolveSkillVersion(packument, parsed.range).version;
		if (opts.json) {
			const body = version ? await client.version(parsed.scope, parsed.name, version) : packument;
			process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		} else {
			process.stdout.write(`${formatSkillInfo(packument, version, ANSI_PAINT)}\n`);
		}
		return 0;
	});
}
