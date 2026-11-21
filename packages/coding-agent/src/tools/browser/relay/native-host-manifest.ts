import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBrowserRelayInstallRegistryFile, isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { NATIVE_HOST } from "../../../../../browser-relay/extension/messages";
import { resolveCliEntryCmd } from "../../../subprocess/worker-client";
import { writeFileAtomically } from "../../../utils/atomic-file";
import { quotePosixArgv } from "../../../utils/shell-quote";
import { chromiumUserDataDirs } from "./chromium-profiles";

const CHROME_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`;

/** Locations and executable used to install the host for this user. */
export interface RelayNativeHostOptions {
	platform?: NodeJS.Platform;
	home?: string;
	configHome?: string;
	dir?: string;
	command?: readonly string[];
}

function hostDir(): string {
	return path.dirname(getBrowserRelayInstallRegistryFile());
}

function launcherPath(dir: string, platform: NodeJS.Platform): string {
	return path.join(dir, platform === "win32" ? "native-host.cmd" : "native-host");
}

function manifestPaths(platform: NodeJS.Platform, options: RelayNativeHostOptions, dir: string): string[] {
	const file = `${NATIVE_HOST}.json`;
	if (platform === "win32") return [path.join(dir, file)];
	return chromiumUserDataDirs({
		platform,
		home: options.home,
		configHome: options.configHome,
	}).map(browser => path.join(browser.dir, "NativeMessagingHosts", file));
}

function launcherText(platform: NodeJS.Platform, command: readonly string[]): string {
	const argv = [...command, "browser-relay", "native-host"];
	// Chrome passes origin/window metadata to the launcher, not to the omp CLI.
	if (platform !== "win32") return `#!/bin/sh\nexec ${quotePosixArgv(argv)}\n`;
	const line = argv.map(arg => `"${arg.replace(/%/g, "%%")}"`).join(" ");
	return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${line}\r\nexit /b %errorlevel%\r\n`;
}

async function writeLauncher(file: string, platform: NodeJS.Platform, command: readonly string[]): Promise<void> {
	const script = launcherText(platform, command);
	const prior = await Bun.file(file)
		.text()
		.catch(error => {
			if (!isEnoent(error)) throw error;
			return null;
		});
	if (prior !== script) await writeFileAtomically(file, script, 0o700);
}

function resolveHost(options: RelayNativeHostOptions): {
	platform: NodeJS.Platform;
	dir: string;
	launcher: string;
	targets: string[];
} {
	const platform = options.platform ?? process.platform;
	const dir = path.resolve(options.dir ?? hostDir());
	const targets = manifestPaths(platform, options, dir);
	return { platform, dir, launcher: launcherPath(dir, platform), targets };
}

/** Chrome admits a native host connection only from the extension ids listed here. */
function manifestText(launcher: string, extensionIds: readonly string[]): string {
	const manifest = {
		name: NATIVE_HOST,
		description: "omp browser native messaging host",
		path: launcher,
		type: "stdio",
		allowed_origins: [...new Set(extensionIds)].sort().map(id => `chrome-extension://${id}/`),
	};
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Materialize the launcher and manifests admitting `extensionIds` (each install folder's path-derived id); the
 * Windows manifest must also be registered in HKCU.
 */
export async function writeRelayNativeHost(
	extensionIds: readonly string[],
	options: RelayNativeHostOptions = {},
): Promise<string[]> {
	const { platform, dir, launcher, targets } = resolveHost(options);
	if (targets.length === 0) return targets;
	await fs.mkdir(dir, { recursive: true });
	await writeLauncher(launcher, platform, options.command ?? resolveCliEntryCmd());
	const content = manifestText(launcher, extensionIds);
	await Promise.all(
		targets.map(async target => {
			await fs.mkdir(path.dirname(target), { recursive: true });
			await writeFileAtomically(target, content);
		}),
	);
	return targets;
}

/** Install the native host manifest admitting `extensionIds` where the user's Chromium browsers look for it. */
export async function registerRelayNativeHost(extensionIds: readonly string[]): Promise<void> {
	const [manifest] = await writeRelayNativeHost(extensionIds);
	if (process.platform !== "win32" || !manifest) return;
	const result = await $`reg.exe add ${CHROME_REGISTRY_KEY} /ve /t REG_SZ /d ${manifest} /f`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`Could not register the omp native messaging host: ${result.stderr.toString().trim()}`);
	}
}

/**
 * After an omp update or a new install folder: repoint an installed launcher and widen the manifests that already
 * exist to `extensionIds`, without creating registrations for browsers that had none.
 */
export async function refreshRelayNativeHost(
	extensionIds: readonly string[],
	options: RelayNativeHostOptions = {},
): Promise<void> {
	const { platform, launcher, targets } = resolveHost(options);
	if (!(await Bun.file(launcher).exists())) return;
	await writeLauncher(launcher, platform, options.command ?? resolveCliEntryCmd());
	const content = manifestText(launcher, extensionIds);
	await Promise.all(
		targets.map(async target => {
			const prior = await Bun.file(target)
				.text()
				.catch((error: unknown) => {
					if (isEnoent(error)) return null;
					throw error;
				});
			if (prior !== null && prior !== content) await writeFileAtomically(target, content);
		}),
	);
}
