/**
 * Update CLI command handler.
 *
 * Handles `pi update` to check for and install updates.
 * Uses bun if available, otherwise downloads binary from GitHub releases.
 */

import { execSync, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import chalk from "chalk";
import { VERSION } from "../config";

/**
 * Detect if we're running as a Bun compiled binary.
 */
const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

const REPO = "can1357/oh-my-pi";
const PACKAGE = "@oh-my-pi/pi-coding-agent";

interface ReleaseInfo {
	tag: string;
	version: string;
	assets: Array<{ name: string; url: string }>;
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

/**
 * Check if bun is available in PATH.
 */
function hasBun(): boolean {
	try {
		const result = spawnSync("bun", ["--version"], { encoding: "utf-8", stdio: "pipe" });
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Get the latest release info from GitHub.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const data = (await response.json()) as {
		tag_name: string;
		assets: Array<{ name: string; browser_download_url: string }>;
	};

	return {
		tag: data.tag_name,
		version: data.tag_name.replace(/^v/, ""),
		assets: data.assets.map((a) => ({ name: a.name, url: a.browser_download_url })),
	};
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
		return `pi-${os}-${archName}.exe`;
	}
	return `pi-${os}-${archName}`;
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(): Promise<void> {
	console.log(chalk.dim("Updating via bun..."));

	try {
		execSync(`bun update -g ${PACKAGE}`, { stdio: "inherit" });
		console.log(chalk.green("\n✓ Update complete"));
	} catch {
		throw new Error("bun update failed");
	}
}

/**
 * Update by downloading binary from GitHub releases.
 */
async function updateViaBinary(release: ReleaseInfo): Promise<void> {
	const binaryName = getBinaryName();
	const asset = release.assets.find((a) => a.name === binaryName);

	if (!asset) {
		throw new Error(`No binary found for ${binaryName}`);
	}

	const execPath = process.execPath;
	const _execDir = dirname(execPath);
	const tempPath = `${execPath}.new`;
	const backupPath = `${execPath}.bak`;

	console.log(chalk.dim(`Downloading ${binaryName}...`));

	// Download to temp file
	const response = await fetch(asset.url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}

	const fileStream = createWriteStream(tempPath, { mode: 0o755 });
	const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
	await pipeline(nodeStream, fileStream);

	// Replace current binary
	console.log(chalk.dim("Installing update..."));

	try {
		// Backup current binary
		if (existsSync(backupPath)) {
			unlinkSync(backupPath);
		}
		renameSync(execPath, backupPath);

		// Move new binary into place
		renameSync(tempPath, execPath);

		// Clean up backup
		unlinkSync(backupPath);

		console.log(chalk.green(`\n✓ Updated to ${release.version}`));
		console.log(chalk.dim("Restart pi to use the new version"));
	} catch (err) {
		// Restore from backup if possible
		if (existsSync(backupPath) && !existsSync(execPath)) {
			renameSync(backupPath, execPath);
		}
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		throw err;
	}
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green("✓ Already up to date"));
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

	// Choose update method
	try {
		if (!isBunBinary && hasBun()) {
			await updateViaBun();
		} else {
			await updateViaBinary(release);
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
	console.log(`${chalk.bold("pi update")} - Check for and install updates

${chalk.bold("Usage:")}
  pi update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  pi update           Update to latest version
  pi update --check   Check if updates are available
  pi update --force   Force reinstall
`);
}
