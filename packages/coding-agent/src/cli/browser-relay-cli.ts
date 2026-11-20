/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */

import { findUnpackedInstalls } from "../tools/browser/relay/chromium-profiles";
import { probeRelayServer } from "../tools/browser/relay/daemon";
import {
	defaultRelayExtensionDir,
	extensionIdForPath,
} from "../tools/browser/relay/extension-files";
import {
	installRelayExtension,
	registeredRelayExtensionIds,
	syncRelayInstalls,
} from "../tools/browser/relay/installs";
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { runNativeHost } from "../tools/browser/relay/native-host";
import { registerRelayNativeHost } from "../tools/browser/relay/native-host-manifest";
import {
	type RelayServer,
	startRelayServer,
} from "../tools/browser/relay/server";

/** Subcommands supported by `omp browser-relay`. */
export const BROWSER_RELAY_ACTIONS = [
	"serve",
	"install",
	"sync",
	"native-host",
] as const;

/** Selected browser-relay subcommand. */
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

/** Parsed browser-relay command and options. */
export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
}

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

/** Run a relay lifecycle command or the native messaging host. */
export async function runBrowserRelayCommand(
	args: BrowserRelayCommandArgs,
): Promise<void> {
	switch (args.action) {
		case "install":
			return runInstall(args.dir);
		case "sync":
			return runSync();
		case "native-host":
			return runNativeHost();
		case "serve":
			return runServe(args);
	}
}

async function runSync(): Promise<void> {
	const results = await syncRelayInstalls();
	if (results.length === 0) {
		console.log(
			"No omp extension directories registered. Use `omp browser-relay install` to register one.",
		);
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

async function runInstall(dirOverride: string | undefined): Promise<void> {
	const dir = await installRelayExtension(
		dirOverride ?? defaultRelayExtensionDir(),
	);
	await registerRelayNativeHost(await registeredRelayExtensionIds());
	console.log(`Installed the omp extension to ${dir}`);
	const profiles = await findUnpackedInstalls(extensionIdForPath(dir));
	const loaded = profiles.filter((profile) => profile.loaded);
	for (const { browser, profile, enabled } of loaded) {
		console.log(
			enabled
				? `${browser} (${profile}) has it loaded and reloads into this build by itself once idle.`
				: `${browser} (${profile}) has it loaded but switched off; turn it on in chrome://extensions.`,
		);
	}
	if (loaded.length > 0) return;
	// Chrome offers no API, flag or file a program may use to add an unpacked extension to a profile; only the user can.
	const developerMode = profiles.some((profile) => profile.developerMode);
	console.log("");
	console.log(
		"No Chrome profile has it loaded yet. Chrome reserves that for you, once:",
	);
	console.log(
		`  open chrome://extensions${developerMode ? "" : ", turn on Developer mode"}, click "Load unpacked" and pick ${dir}`,
	);
	console.log(
		"From then on omp updates and reloads it by itself. Its toolbar badge shows 'on' once it reaches a relay.",
	);
	console.log(
		"Optional: `omp config set browser.relay true` makes the browser tool drive this Chrome by default.",
	);
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(
					`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`,
				);
			}
		: undefined;
	let relay: RelayServer;
	try {
		relay = startRelayServer({
			port: args.port,
			token: args.token,
			group: args.group !== false,
			log,
		});
	} catch (err) {
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
				console.log(
					`omp browser relay already running on http://127.0.0.1:${args.port}; nothing to do.`,
				);
				return;
			}
			console.error(
				`Port ${args.port} is in use by something that is not an omp browser relay.`,
			);
			process.exit(1);
		}
		throw err;
	}

	console.log(`omp browser relay listening on http://127.0.0.1:${args.port}`);
	console.log(
		`  extension endpoint  ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`,
	);
	if (args.port === DEFAULT_RELAY_PORT) {
		console.log("  enable with         omp config set browser.relay true");
	} else {
		console.log(
			`  enable with         omp config set browser.relay true && omp config set browser.relayUrl http://127.0.0.1:${args.port}`,
		);
	}
	console.log(
		"Waiting for the omp extension to connect (omp browser-relay install)...",
	);

	let announced = false;
	const readiness = setInterval(() => {
		if (relay.bridge.ready && !announced) {
			announced = true;
			console.log(
				"Extension connected. The omp browser prelude can now drive your tabs.",
			);
		} else if (!relay.bridge.ready && announced) {
			announced = false;
			console.log("Extension disconnected; waiting for it to reconnect...");
		}
	}, 500);

	const shutdown = () => {
		clearInterval(readiness);
		relay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}
