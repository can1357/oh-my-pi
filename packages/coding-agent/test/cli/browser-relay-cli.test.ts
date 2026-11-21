import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { relayExtensionFiles } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { installRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/installs";
import { serveRelayLink } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/native-relay";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { relayExtensionNotice } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type { FromNativeHost, ToNativeHost } from "../../../browser-relay/extension/messages";

/**
 * The worker's port to omp's native host. Like the host Chrome starts, it serves the worker's `link` with omp's relay
 * link on `relayPort`; {@link close} ends the host's side, as when the worker stops.
 */
class NativeHostPort {
	readonly #relayPort: number;
	readonly #listeners: Array<(message: FromNativeHost) => void> = [];
	readonly #inbox: ToNativeHost[] = [];
	#waiting: PromiseWithResolvers<ToNativeHost | null> | undefined;
	#closed = false;
	readonly onMessage = {
		addListener: (listener: (message: FromNativeHost) => void) => this.#listeners.push(listener),
	};
	readonly onDisconnect = { addListener() {} };

	constructor(relayPort: number) {
		this.#relayPort = relayPort;
	}

	postMessage(message: ToNativeHost): void {
		if (this.#closed) return;
		if (message.t === "link") {
			void serveRelayLink({
				port: this.#relayPort,
				extensionId: message.extensionId,
				next: () => this.#next(),
				send: reply => this.#deliver(reply),
				relayLine: line => this.#deliver({ t: "relay", line }),
				log() {},
			});
			return;
		}
		if (this.#waiting) {
			this.#waiting.resolve(message);
			this.#waiting = undefined;
		} else {
			this.#inbox.push(message);
		}
	}

	disconnect(): void {
		this.close();
	}

	close(): void {
		this.#closed = true;
		this.#waiting?.resolve(null);
		this.#waiting = undefined;
	}

	#next(): Promise<ToNativeHost | null> {
		const queued = this.#inbox.shift();
		if (queued) return Promise.resolve(queued);
		if (this.#closed) return Promise.resolve(null);
		this.#waiting = Promise.withResolvers();
		return this.#waiting.promise;
	}

	#deliver(message: FromNativeHost): void {
		if (this.#closed) return;
		for (const listener of this.#listeners) listener(message);
	}
}

/**
 * Run an installed `background.js` as Chrome would, linked through the native host to the relay on `port`, with
 * `manifest` as what `chrome.runtime.getManifest()` returns. Returns a stop function that ends the worker's host links.
 */
function runExtensionWorker(script: string, port: number, manifest: object): () => void {
	const hosts: NativeHostPort[] = [];
	const event = { addListener() {}, removeListener() {} };
	const known = {
		storage: {
			local: {
				get: (defaults: Record<string, unknown>) => Promise.resolve({ ...defaults }),
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
		downloads: { search: () => Promise.resolve([]), onCreated: event, onChanged: event },
		alarms: { create() {}, onAlarm: event },
		action: {
			setBadgeText: () => Promise.resolve(),
			setBadgeBackgroundColor: () => Promise.resolve(),
			onClicked: event,
		},
		runtime: {
			id: "abcdefghijklmnopabcdefghijklmnop",
			getManifest: () => manifest,
			connectNative: () => {
				const host = new NativeHostPort(port);
				hosts.push(host);
				return host;
			},
			openOptionsPage: () => Promise.resolve(),
			onInstalled: event,
			onStartup: event,
		},
	};
	// Every API the worker touches beyond the relay path (side panel, ports, overlay messaging, notifications…) is
	// inert here: `on*` members are events, anything else resolves to an empty list.
	const inert = (members: object): object =>
		new Proxy(members, {
			get(target, name, receiver) {
				if (Reflect.has(target, name)) {
					const value: unknown = Reflect.get(target, name, receiver);
					return typeof value === "object" && value !== null && !Array.isArray(value) ? inert(value) : value;
				}
				if (typeof name !== "string") return undefined;
				if (name.startsWith("on")) return event;
				return inert(Object.assign(() => Promise.resolve([]), {}));
			},
		});
	new Function("chrome", "navigator", script)(inert(known), { userAgent: "Mozilla/5.0 Chrome/154.0.0.0" });
	return () => {
		for (const host of hosts) host.close();
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
		// The shared registry stays inside the test's directory, never the user's.
		const installed = await installRelayExtension(dir.join("extension"), { registryFile: dir.join("installs.json") });
		const registry = await Bun.file(dir.join("installs.json")).json();
		expect(registry.installs.map((row: { dir: string }) => row.dir)).toContain(installed);
		const manifest = await Bun.file(dir.join("extension/manifest.json")).json();
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
		const runningScript = (await relayExtensionFiles("18.6.1"))["background.js"]!;
		const manifestOnDisk = JSON.parse((await relayExtensionFiles(VERSION))["manifest.json"]!);
		stopWorker = runExtensionWorker(runningScript, port, manifestOnDisk);
		await hello.promise;
		expect(await relayExtensionNotice(`http://127.0.0.1:${port}`)).toContain(
			`installed by omp 18.6.1; this is omp ${VERSION}`,
		);
	});
});
