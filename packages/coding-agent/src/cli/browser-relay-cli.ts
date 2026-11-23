/**
 * `omp browser-relay` implementation: install and sync the omp Chrome extension, and run its native host (which
 * serves the browser relay while Chrome runs). Standalone CLI command — console output here is intentional
 * user-facing output.
 */

import { findUnpackedInstalls } from "../tools/browser/relay/chromium-profiles";
import { defaultRelayExtensionDir, extensionIdForPath } from "../tools/browser/relay/extension-files";
import { installRelayExtension, registeredRelayExtensionIds, syncRelayInstalls } from "../tools/browser/relay/installs";
import { runNativeHost } from "../tools/browser/relay/native-host";
import { registerRelayNativeHost } from "../tools/browser/relay/native-host-manifest";
import { installRelayInChrome } from "../tools/browser/relay/chrome";

/** Subcommands supported by `omp browser-relay`. */
export const BROWSER_RELAY_ACTIONS = ["install", "sync", "native-host"] as const;

/** Selected browser-relay subcommand. */
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

/** Parsed browser-relay command and options. */
export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Install into real Chrome profiles (default true; `--no-chrome` falls back to the manual steps). */
	chrome?: boolean;
	/** Chrome profile directory name for the unattended install (default: last used). */
	profile?: string;
}

/** Run a relay lifecycle command or the native messaging host. */
export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	switch (args.action) {
		case "install":
			return runInstall(args);
		case "sync":
			return runSync();
		case "native-host":
			return runNativeHost();
	}
}

async function runSync(): Promise<void> {
	const results = await syncRelayInstalls();
	if (results.length === 0) {
		console.log("No omp extension directories registered. Use `omp browser-relay install` to register one.");
		return;
	}
	let failed = false;
	for (const result of results) {
		if (result.status === "failed") {
			failed = true;
			console.error(`${result.dir}: failed (${result.error})`);
		} else {
			console.log(`${result.dir}: ${result.status}`);
		}
	}
	if (failed) process.exitCode = 1;
}

async function runInstall(args: BrowserRelayCommandArgs): Promise<void> {
	const dir = await installRelayExtension(args.dir ?? defaultRelayExtensionDir());
	await registerRelayNativeHost(await registeredRelayExtensionIds());
	console.log(`Installed the omp extension to ${dir}`);
	const extensionId = extensionIdForPath(dir);
	const profiles = await findUnpackedInstalls(extensionId);

	if (args.chrome !== false) {
		const alreadyLoaded = profiles.some(profile => profile.loaded);
		if (!alreadyLoaded) {
			const report = await installRelayInChrome({
				dir,
				profile: args.profile,
			}).catch((error: unknown) => {
				console.error(
					`Could not register the extension in Chrome: ${error instanceof Error ? error.message : String(error)}`,
				);
				return [];
			});
			for (const installed of report) {
				console.log(
					`Registered in ${installed.browser} (${installed.profileDir})` +
						`${installed.restarted ? "; Chrome was restarted" : ""}.`,
				);
			}
			if (report.length > 0) {
				// The record is live once Chrome has loaded it; give the restart a moment to prove it.
				const deadline = Date.now() + 8_000;
				while (Date.now() < deadline) {
					const loaded = await findUnpackedInstalls(extensionId);
					if (loaded.some(profile => profile.loaded)) break;
					await Bun.sleep(250);
				}
			}
		}
	}

	const loaded = (await findUnpackedInstalls(extensionId)).filter(profile => profile.loaded);
	for (const { browser, profile, enabled } of loaded) {
		console.log(
			enabled
				? `${browser} (${profile}) has it loaded and reloads into this build by itself once idle.`
				: `${browser} (${profile}) has it loaded but switched off; turn it on in chrome://extensions.`,
		);
	}
	if (loaded.length > 0) {
		console.log("");
		console.log("Optional: `omp config set browser.relay true` makes the browser tool drive this Chrome by default.");
		return;
	}
	const developerMode = profiles.some(profile => profile.developerMode);
	console.log("");
	console.log("No Chrome profile has it loaded yet. Chrome reserves that for you, once:");
	console.log(
		`  open chrome://extensions${developerMode ? "" : ", turn on Developer mode"}, click "Load unpacked" and pick ${dir}`,
	);
	console.log(
		"From then on omp updates and reloads it by itself. Its toolbar badge shows 'on' while its native host serves the relay.",
	);
	console.log("Optional: `omp config set browser.relay true` makes the browser tool drive this Chrome by default.");
}
