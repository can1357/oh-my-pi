/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses the installer that owns the active omp executable when it can be detected.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, isEnoent, VERSION } from "@pk-nerdsaver-ai/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { getDistVersion, getLatestRelease, type ReleaseInfo } from "./update-release-source";

/**
 * Binary distribution endpoint (Cloudflare Worker → private Hugging Face repo).
 * Mirrors `scripts/install.{sh,ps1}`: compiled binaries live at
 * `${DIST_BASE}/bin/<tag>/<name>` and the current tag at `${DIST_BASE}/version`.
 * Override with `OMP_DIST_BASE`. This fork publishes no GitHub Releases.
 */
const DIST_BASE = Bun.env.OMP_DIST_BASE ?? "https://oh-my-pk.pkking.computer";
const PACKAGE = "@pk-nerdsaver-ai/pi-coding-agent";
const HOMEBREW_FORMULA = "kingkillery/tap/omp";
const MISE_TOOL = "github:kingkillery/oh-my-pk";
/**
 * Official npm registry origin.
 *
 * Pinned across both the version check and the bun install step so the two
 * agree on which catalog they are talking to. A user's bun may be pointed at
 * an unofficial mirror (corporate proxy, Taobao, etc.) that lags the upstream
 * registry by minutes-to-hours, in which case `getLatestRelease` would resolve
 * a version the mirror has not yet replicated and the install would fail with
 * `No version matching "X" found for specifier "<pkg>" (but package exists)`.
 * See #1686.
 */
const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * Core native addon package. Bumped in lock-step with {@link PACKAGE} so the
 * version sentinel the loader looks up at runtime matches the `.node` on
 * disk; see {@link buildBunInstallArgs} for why this must be installed
 * explicitly rather than inherited as a transitive dependency.
 */
const NATIVES_PACKAGE = "@pk-nerdsaver-ai/pi-natives";

/**
 * Platform tags the release pipeline publishes as
 * `@pk-nerdsaver-ai/pi-natives-<tag>` leaves. Mirrors `SUPPORTED_PLATFORMS` in
 * `packages/natives/native/loader-state.js` and `LEAF_TARGETS` in
 * `packages/natives/scripts/gen-npm-packages.ts`; kept here as the local
 * source of truth so the update path stays free of cross-package imports.
 */
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	for (const formula of [HOMEBREW_FORMULA, APP_NAME]) {
		try {
			const result = await $`brew --prefix ${formula}`.quiet().nothrow();
			if (result.exitCode !== 0) continue;
			const output = result.text().trim();
			if (output.length > 0) return output;
		} catch {}
	}
	return undefined;
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved omp path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve both the file and its parent directory: the file catches manager
	// links like Homebrew's `bin/omp -> Cellar/.../bin/omp`; the parent fallback
	// still tolerates fresh install paths where the file does not exist yet.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

type UpdateMethod = "brew" | "mise" | "bun" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
}

type UpdateTarget = { method: "brew" } | { method: "mise" } | { method: "bun" } | { method: "binary"; path: string };

function resolveUpdateMethod(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const { homebrewPrefix, miseBinDirs = [], miseDataDir } = options;
	if (homebrewPrefix && isPathInDirectory(ompPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";
	if (bunBinDir && isPathInDirectory(ompPath, bunBinDir)) return "bun";
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, bunBinDir, options);
}

const CLI_BINARY_NAMES: ReadonlySet<string> = new Set([APP_NAME, "omp", "ompk"].map(name => name.toLowerCase()));

/**
 * Return the running executable when it is one of this CLI's compiled binary
 * names. Source and package-manager launches run through Bun, so their
 * `process.execPath` is intentionally ignored and falls back to PATH-based
 * manager detection.
 */
function resolveInvokedBinaryPath(
	executablePath: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	const basename = pathApi.basename(executablePath).toLowerCase();
	const commandName = platform === "win32" && basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
	return CLI_BINARY_NAMES.has(commandName) ? executablePath : undefined;
}

export function resolveInvokedBinaryPathForTest(executablePath: string, platform: NodeJS.Platform): string | undefined {
	return resolveInvokedBinaryPath(executablePath, platform);
}

async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunBinDir = await getBunGlobalBinDir();
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const ompPath = resolveOmpPath();

	if (ompPath) {
		const method = resolveUpdateMethod(ompPath, bunBinDir, { homebrewPrefix, miseBinDirs, miseDataDir });
		if (method === "binary") return { method, path: ompPath };
		return { method };
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	// Distribution artifact base stays "omp" (the HF/dist + install-script name),
	// independent of the renamed command/display name (APP_NAME).
	const base = "omp";
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${base}-${os}-${archName}.exe`;
	}
	return `${base}-${os}-${archName}`;
}

/**
 * Build the fork's binary download URL. Binaries are served by the Cloudflare
 * Worker at `${DIST_BASE}/bin/<tag>/<name>` (private Hugging Face backing repo),
 * exactly as `scripts/install.{sh,ps1}` resolve them — never GitHub Releases.
 */
export function buildBinaryDownloadUrl(expectedVersion: string, binaryName: string = getBinaryName()): string {
	return `${DIST_BASE}/bin/v${expectedVersion}/${binaryName}`;
}

/** Resolve the binary this process should update and later verify. */
function resolveOmpPath(): string | undefined {
	const invokedBinary = resolveInvokedBinaryPath(process.execPath);
	if (invokedBinary) return invokedBinary;

	for (const commandName of [APP_NAME, "ompk", "omp"] as const) {
		const resolved = $which(commandName);
		if (resolved) return resolved;
	}
	return undefined;
}

/**
 * Run the resolved omp binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveOmpPath();
	if (!ompPath) return { ok: false };
	try {
		const result = await $`${ompPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompPath };
		const output = result.text().trim();
		// Output format: "<bin>/X.Y.Z" (the leading token is APP_NAME, e.g. "oh-my-pk/1.2.3");
		// the regex matches the /X.Y.Z suffix regardless of the bin-name prefix.
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: ompPath };
	} catch {
		return { ok: false, path: ompPath };
	}
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * Print post-update verification result.
 */
async function printVerification(expectedVersion: string): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion);
	if (result.ok) {
		printVerifiedVersion(expectedVersion);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	const reinstall =
		process.platform === "win32" ? `irm ${DIST_BASE}/install.ps1 | iex` : `curl -fsSL ${DIST_BASE}/install.sh | sh`;
	console.log(chalk.yellow(`You may need to reinstall: ${reinstall}`));
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). The replacement and verification already
 * succeeded by the time we get here, so every error is swallowed; the leftover
 * is reclaimed by {@link sweepStaleBackups} on the next update once it is no
 * longer in use. Returns whether the file is gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update backups left by earlier runs.
 *
 * Each self-update moves the previous executable to `<binary>.<timestamp>.<pid>.bak`
 * before swapping the new one in. On Windows that backup cannot be deleted
 * while the updating process is alive, so it is left for a later run to reclaim
 * once its owning process has exited. Also matches the legacy fixed
 * `<binary>.bak` name produced before backups were timestamped, so users
 * upgrading from a buggy release get the orphaned file cleaned up.
 */
export async function sweepStaleBackups(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`) || !entry.endsWith(".bak")) continue;
		// Legacy "<base>.bak" → empty middle; new "<base>.<timestamp>.<pid>.bak"
		// → dot-separated numeric run. Anything else is an unrelated *.bak file.
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		await removeBackupBestEffort(path.join(dir, entry));
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, so a
		// failure here must NOT fail an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

/**
 * Build the bun argv used to globally install a specific omp version.
 *
 * The version is selected by hitting {@link NPM_REGISTRY} directly in
 * {@link getLatestRelease}, so the install MUST observe the same catalog:
 *
 * - `--registry=${NPM_REGISTRY}` pins the install to the official registry
 *   regardless of the user's bunfig/`.npmrc`. A mirror (corporate proxy,
 *   Taobao, …) that hasn't yet replicated the release would otherwise reject
 *   a version the upstream registry already advertises.
 * - `--no-cache` tells bun to ignore its on-disk manifest snapshot so it
 *   re-fetches metadata from that registry on every invocation.
 *
 * Together these two flags make `omp update` produce exactly the registry
 * lookup the version check just performed. See #1686.
 *
 * Also pins {@link NATIVES_PACKAGE} and the platform-specific
 * `@pk-nerdsaver-ai/pi-natives-<tag>` leaf to `expectedVersion`. `bun install -g`
 * does not reliably refresh transitive `optionalDependencies` when the
 * top-level package is the only one bumped, so the native addon and its
 * version sentinel can drift out of sync with the freshly installed
 * `@pk-nerdsaver-ai/pi-coding-agent` and the loader aborts at
 * `validateLoadedBindings` on the next launch
 * (`The .node file on disk is from a different release than this loader`).
 * Listing the natives explicitly forces bun to replace them in lock-step.
 * The leaf is added only on tags the release pipeline actually publishes
 * ({@link SUPPORTED_NATIVE_TAGS}) so unsupported platforms still fail with
 * the original "no matching version" message instead of `EBADPLATFORM`.
 * See #1824.
 */
export function buildBunInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	const args = [
		"install",
		"-g",
		"--no-cache",
		`--registry=${NPM_REGISTRY}`,
		`${PACKAGE}@${expectedVersion}`,
		`${NATIVES_PACKAGE}@${expectedVersion}`,
	];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${NATIVES_PACKAGE}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

export function buildHomebrewUpdateArgs(force: boolean): string[] {
	return [force ? "reinstall" : "upgrade", HOMEBREW_FORMULA];
}

export function buildMiseUpgradeArgs(): string[] {
	return ["upgrade", MISE_TOOL, "--bump"];
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(expectedVersion: string): Promise<void> {
	console.log(chalk.dim("Updating via bun..."));
	const args = buildBunInstallArgs(expectedVersion);
	const result = await $`bun ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`bun install failed with exit code ${result.exitCode}`);
	}

	await printVerification(expectedVersion);
}

async function updateViaHomebrew(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating Homebrew formulae..."));
	const update = await $`brew update`.nothrow();
	if (update.exitCode !== 0) {
		throw new Error(`brew update failed with exit code ${update.exitCode}`);
	}

	console.log(chalk.dim("Updating via Homebrew..."));
	const args = buildHomebrewUpdateArgs(force);
	const result = await $`brew ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`brew ${args[0]} failed with exit code ${result.exitCode}`);
	}

	await printVerification(expectedVersion);
}

async function updateViaMise(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating via mise..."));
	const args = buildMiseUpgradeArgs();
	const result = await $`mise ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`mise upgrade failed with exit code ${result.exitCode}`);
	}

	if (force) {
		const forceArgs = buildMiseForceInstallArgs(expectedVersion);
		const forceResult = await $`mise ${forceArgs}`.nothrow();
		if (forceResult.exitCode !== 0) {
			throw new Error(`mise install --force failed with exit code ${forceResult.exitCode}`);
		}
	}

	await printVerification(expectedVersion);
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	// The fork serves binaries off DIST_BASE/version (the canonical pointer for
	// the binary surface); prefer it over the npm-derived version so a binary
	// update always matches what the endpoint actually serves.
	const version = (await getDistVersion(DIST_BASE)) ?? expectedVersion;
	const binaryName = getBinaryName();
	const url = buildBinaryDownloadUrl(version, binaryName);

	const tempPath = `${targetPath}.new`;
	// Unique per attempt: a stale backup from an earlier update may still be
	// locked (it is the previous process image on Windows), and a fixed name
	// would force the move-aside rename to overwrite it. pid + timestamp keeps
	// two forced updates in the same millisecond from colliding.
	const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);

	console.log(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion: version,
		verifyInstalledVersion,
	});
	// Reclaim backups from earlier updates whose owning process has since exited.
	await sweepStaleBackups(targetPath);
	printVerifiedVersion(version);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease({ distBase: DIST_BASE, packageName: PACKAGE, npmRegistry: NPM_REGISTRY });
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// Choose update method based on the prioritized omp binary in PATH
	try {
		const target = await resolveUpdateTarget();
		if (target.method === "brew") {
			await updateViaHomebrew(release.version, opts.force);
		} else if (target.method === "mise") {
			await updateViaMise(release.version, opts.force);
		} else if (target.method === "bun") {
			await updateViaBun(release.version);
		} else {
			await updateViaBinaryAt(target.path, release.version);
		}
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}
