import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { runBrowserRelayCommand } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";
import { relayExtensionFiles } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { relayExtensionNotice } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

/**
 * Run an installed `background.js` as Chrome would, against the relay on `port`, with `manifest` as what
 * `chrome.runtime.getManifest()` returns. Returns a stop function that keeps the worker from dialing again.
 */
function runExtensionWorker(script: string, port: number, manifest: object): () => void {
	let stopped = false;
	const event = { addListener() {} };
	const chrome = {
		storage: {
			local: {
				get: (defaults: Record<string, unknown>) =>
					stopped ? Promise.withResolvers<never>().promise : Promise.resolve({ ...defaults, port }),
				set: () => Promise.resolve(),
			},
			session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
			onChanged: event,
		},
		tabs: {
			query: () => Promise.resolve([]),
			onCreated: event,
			onUpdated: event,
			onActivated: event,
			onRemoved: event,
		},
		tabGroups: { query: () => Promise.resolve([]) },
		debugger: { getTargets: () => Promise.resolve([]), onEvent: event, onDetach: event },
		alarms: { create() {}, onAlarm: event },
		action: {
			setBadgeText: () => Promise.resolve(),
			setBadgeBackgroundColor: () => Promise.resolve(),
			onClicked: event,
		},
		runtime: {
			getManifest: () => manifest,
			openOptionsPage: () => Promise.resolve(),
			onInstalled: event,
			onStartup: event,
		},
	};
	new Function("chrome", "navigator", script)(chrome, { userAgent: "Mozilla/5.0 Chrome/154.0.0.0" });
	return () => {
		stopped = true;
	};
}

describe("omp browser-relay install", () => {
	let dir: TempDir;
	let relay: RelayServer | undefined;
	let stopWorker: (() => void) | undefined;

	beforeEach(async () => {
		dir = await TempDir.create("@omp-relay-install-");
		spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		stopWorker?.();
		relay?.stop();
		stopWorker = undefined;
		relay = undefined;
		mock.restore();
		await dir.remove();
	});

	it("stamps the installing omp's version into the extension manifest", async () => {
		await runBrowserRelayCommand({ action: "install", port: 0, dir: dir.path() });
		const manifest = await Bun.file(dir.join("manifest.json")).json();
		expect(manifest.version_name).toBe(VERSION);
		expect(manifest.manifest_version).toBe(3);
	});

	it("reports the omp that installed the running script when Chrome restarts onto a newer manifest", async () => {
		// After reinstalling, a Chrome restart re-reads manifest.json but keeps running the old service worker.
		const port = await findFreeCdpPort();
		const hello = Promise.withResolvers<void>();
		relay = startRelayServer({
			port,
			group: false,
			log: message => {
				if (message === "extension connected") hello.resolve();
			},
		});
		const runningScript = relayExtensionFiles("18.6.1")["background.js"]!;
		const manifestOnDisk = JSON.parse(relayExtensionFiles(VERSION)["manifest.json"]!);
		stopWorker = runExtensionWorker(runningScript, port, manifestOnDisk);
		await hello.promise;
		expect(await relayExtensionNotice(`http://127.0.0.1:${port}`)).toContain(
			`installed by omp 18.6.1; this is omp ${VERSION}`,
		);
	});
});
