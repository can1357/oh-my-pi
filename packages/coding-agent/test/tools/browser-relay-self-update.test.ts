import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import {
	extensionIdForPath,
	installedRelayExtensionVersion,
	relayExtensionFiles,
	writeRelayExtension,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import type {
	RelayExtensionStamp,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

const OLD = "18.6.1";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	closed = false;
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {
		this.closed = true;
	}
	get reloads(): number {
		return this.messages.filter(msg => msg.t === "reload").length;
	}
}

const FAKE_CDP: RelaySocket = { send() {}, close() {} };

function tab(tabId: number): TabSnapshot {
	return {
		tabId,
		url: "https://example.com/",
		title: "Example",
		active: true,
		discarded: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
	};
}

interface Hello {
	instanceId?: string;
	ompVersion?: string;
	ompBuild?: string;
	reloadProtocol?: number;
	extensionId?: string;
	attachedTabIds?: number[];
}

function hello(bridge: RelayBridge, socket: FakeExtSocket, opts: Hello = {}): void {
	const {
		instanceId = "chrome",
		ompVersion = OLD,
		ompBuild,
		reloadProtocol = 1,
		extensionId = EXTENSION_ID,
		attachedTabIds = [],
	} = opts;
	bridge.extConnected(socket, extensionId || undefined);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			instanceId,
			userAgent: "test",
			browserVersion: "Chrome/155.0.0.0",
			discardedTabsProtocol: 1,
			ompVersion,
			ompBuild,
			reloadProtocol,
			tabs: [tab(1)],
			attachedTabIds,
		}),
	);
}

/** A bridge whose updater records the ids it was asked about and resolves when the test says. */
function bridgeWithUpdater(): {
	bridge: RelayBridge;
	calls: string[];
	finish: (updated: boolean) => Promise<void>;
} {
	const calls: string[] = [];
	const pending: Array<(updated: boolean) => void> = [];
	const bridge = new RelayBridge({
		updateExtension: extensionId => {
			calls.push(extensionId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			pending.push(resolve);
			return promise;
		},
	});
	const finish = async (updated: boolean) => {
		for (const resolve of pending.splice(0)) resolve(updated);
		for (let i = 0; i < 6; i++) await Promise.resolve();
	};
	return { bridge, calls, finish };
}

/** Let the bridge's promise chains for a CDP command or an extension answer run. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("relay extension self-update decisions", () => {
	it("rewrites an older extension that reloads on request, then asks it to reload", async () => {
		const { bridge, calls, finish } = bridgeWithUpdater();
		const socket = new FakeExtSocket();
		hello(bridge, socket);
		expect(calls).toEqual([EXTENSION_ID]);
		// Not ready while the files change, so a client waits for the reloaded extension.
		expect(bridge.ready).toBe(false);
		expect(socket.reloads).toBe(0);
		await finish(true);
		expect(socket.reloads).toBe(1);
		// The relay retires the socket as it asks, so nothing new reaches the reloading browser.
		expect(socket.closed).toBe(true);
		expect(bridge.ready).toBe(false);
		const reloaded = new FakeExtSocket();
		hello(bridge, reloaded, { ompVersion: VERSION });
		expect(bridge.ready).toBe(true);
		expect(bridge.versionInfo("ws://x/cdp").ompExtensionVersion).toBe(VERSION);
		expect(calls).toHaveLength(1);
	});

	it("sends nothing more to a browser it asked to reload while another browser stays connected", async () => {
		const { bridge, finish } = bridgeWithUpdater();
		const reloading = new FakeExtSocket();
		hello(bridge, reloading, { instanceId: "chrome" });
		hello(bridge, new FakeExtSocket(), {
			instanceId: "edge",
			ompVersion: VERSION,
		});
		await finish(true);
		expect(reloading.reloads).toBe(1);
		expect(bridge.ready).toBe(true);
		const sent = reloading.messages.length;
		const conn = bridge.cdpConnected(FAKE_CDP);
		const code = new Bun.CryptoHasher("sha256").update("chrome").digest("base64url").slice(0, 8);
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: 1,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${code}.1`, flatten: true },
			}),
		);
		for (let i = 0; i < 6; i++) await Promise.resolve();
		expect(reloading.messages.length).toBe(sent);
	});

	it("leaves an extension without the reload capability for the manual update", () => {
		const { bridge, calls } = bridgeWithUpdater();
		hello(bridge, new FakeExtSocket(), { reloadProtocol: 0 });
		expect(calls).toEqual([]);
		expect(bridge.ready).toBe(true);
	});

	it("leaves an extension installed by this omp or a newer one alone", () => {
		const { bridge, calls } = bridgeWithUpdater();
		hello(bridge, new FakeExtSocket(), { ompVersion: VERSION });
		hello(bridge, new FakeExtSocket(), { ompVersion: "999.0.0" });
		expect(calls).toEqual([]);
	});

	it("leaves an extension with no omp version stamp alone", () => {
		const { bridge, calls } = bridgeWithUpdater();
		hello(bridge, new FakeExtSocket(), { ompVersion: "" });
		hello(bridge, new FakeExtSocket(), { ompVersion: "dev" });
		expect(calls).toEqual([]);
	});

	it("leaves an extension whose socket named no Chrome extension id alone", () => {
		const { bridge, calls } = bridgeWithUpdater();
		hello(bridge, new FakeExtSocket(), { extensionId: "" });
		expect(calls).toEqual([]);
	});

	it("waits while a CDP client is connected and updates once the last one leaves", async () => {
		const { bridge, calls, finish } = bridgeWithUpdater();
		const first = bridge.cdpConnected(FAKE_CDP);
		const second = bridge.cdpConnected(FAKE_CDP);
		const socket = new FakeExtSocket();
		hello(bridge, socket);
		expect(calls).toEqual([]);
		expect(bridge.ready).toBe(true);
		bridge.cdpClosed(first);
		await finish(true);
		expect(calls).toEqual([]);
		bridge.cdpClosed(second);
		await finish(true);
		expect(calls).toEqual([EXTENSION_ID]);
		await finish(true);
		expect(socket.reloads).toBe(1);
	});

	it("waits while one of the extension's tabs holds a debugger attachment", () => {
		const { bridge, calls } = bridgeWithUpdater();
		hello(bridge, new FakeExtSocket(), { attachedTabIds: [1] });
		expect(calls).toEqual([]);
		expect(bridge.ready).toBe(true);
	});

	it("does not reload when a CDP client connected while the files were written", async () => {
		const { bridge, finish } = bridgeWithUpdater();
		const socket = new FakeExtSocket();
		hello(bridge, socket);
		bridge.cdpConnected(FAKE_CDP);
		await finish(true);
		expect(socket.reloads).toBe(0);
		expect(bridge.ready).toBe(true);
	});

	it("does not reload when the files were not rewritten", async () => {
		const { bridge, finish } = bridgeWithUpdater();
		const socket = new FakeExtSocket();
		hello(bridge, socket);
		await finish(false);
		expect(socket.reloads).toBe(0);
		expect(bridge.ready).toBe(true);
	});

	it("waits for a tab create that outlived its timeout, whose late result closes the tab", async () => {
		vi.useFakeTimers();
		try {
			const { bridge, calls, finish } = bridgeWithUpdater();
			const conn = bridge.cdpConnected(FAKE_CDP);
			const socket = new FakeExtSocket();
			hello(bridge, socket);
			bridge.cdpMessage(
				conn,
				JSON.stringify({
					id: 1,
					method: "Target.createTarget",
					params: { background: true },
				}),
			);
			await flushMicrotasks();
			const create = socket.messages.find(msg => msg.t === "rpc" && msg.op === "createTab") as { id: number };
			vi.advanceTimersByTime(20_000);
			await flushMicrotasks();
			bridge.cdpClosed(conn);
			await finish(true);
			// Chrome can still create the tab; a reload now would lose the late result that closes it.
			expect(calls).toEqual([]);
			bridge.extMessage(
				socket,
				JSON.stringify({
					t: "rpcResult",
					id: create.id,
					ok: true,
					result: { tab: tab(2) },
				}),
			);
			await flushMicrotasks();
			const close = socket.messages.find(msg => msg.t === "rpc" && msg.op === "removeTab") as {
				id: number;
				tabId: number;
			};
			expect(close.tabId).toBe(2);
			expect(calls).toEqual([]);
			bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: close.id, ok: true, result: {} }));
			await flushMicrotasks();
			expect(calls).toEqual([EXTENSION_ID]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("releases an attach the last client left mid-way, then updates", async () => {
		const { bridge, calls, finish } = bridgeWithUpdater();
		const conn = bridge.cdpConnected(FAKE_CDP);
		const socket = new FakeExtSocket();
		hello(bridge, socket);
		const code = new Bun.CryptoHasher("sha256").update("chrome").digest("base64url").slice(0, 8);
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: 1,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${code}.1`, flatten: true },
			}),
		);
		await flushMicrotasks();
		const attach = socket.messages.find(msg => msg.t === "rpc" && msg.op === "attach") as { id: number };
		bridge.cdpClosed(conn);
		await finish(true);
		expect(calls).toEqual([]);
		// Chrome attaches after the client left: nobody holds the tab, so the relay detaches it and then updates.
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: attach.id, ok: true, result: {} }));
		await flushMicrotasks();
		const detach = socket.messages.find(msg => msg.t === "rpc" && msg.op === "detach") as { id: number };
		expect(detach).toBeDefined();
		expect(calls).toEqual([]);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: detach.id, ok: true, result: {} }));
		await flushMicrotasks();
		expect(calls).toEqual([EXTENSION_ID]);
		await finish(true);
		expect(socket.reloads).toBe(1);
	});

	it("waits out a tab create and its close when the client left mid-create, so the tab omp opened is closed", async () => {
		const { bridge, calls, finish } = bridgeWithUpdater();
		const conn = bridge.cdpConnected(FAKE_CDP);
		const socket = new FakeExtSocket();
		hello(bridge, socket);
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: 1,
				method: "Target.createTarget",
				params: { background: true },
			}),
		);
		await flushMicrotasks();
		const create = socket.messages.find(msg => msg.t === "rpc" && msg.op === "createTab") as { id: number };
		bridge.cdpClosed(conn);
		await finish(true);
		// A reload now would cut the create off, and the reloaded extension's new browser session retires its tab id.
		expect(calls).toEqual([]);
		bridge.extMessage(
			socket,
			JSON.stringify({
				t: "rpcResult",
				id: create.id,
				ok: true,
				result: { tab: tab(2) },
			}),
		);
		await flushMicrotasks();
		const close = socket.messages.find(msg => msg.t === "rpc" && msg.op === "removeTab") as {
			id: number;
			tabId: number;
		};
		expect(close.tabId).toBe(2);
		expect(calls).toEqual([]);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: close.id, ok: true, result: {} }));
		await flushMicrotasks();
		expect(calls).toEqual([EXTENSION_ID]);
		await finish(true);
		expect(socket.reloads).toBe(1);
	});

	it("waits for a tab close queued for the next hello, which a reload's new browser session would drop", async () => {
		const { bridge, calls, finish } = bridgeWithUpdater();
		const conn = bridge.cdpConnected(FAKE_CDP);
		const socket = new FakeExtSocket();
		hello(bridge, socket);
		const code = new Bun.CryptoHasher("sha256").update("chrome").digest("base64url").slice(0, 8);
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: 1,
				method: "Target.closeTarget",
				params: { targetId: `PAGE${code}.1` },
			}),
		);
		await flushMicrotasks();
		const refused = socket.messages.find(msg => msg.t === "rpc" && msg.op === "removeTab") as { id: number };
		bridge.extMessage(
			socket,
			JSON.stringify({
				t: "rpcResult",
				id: refused.id,
				ok: false,
				error: "dragging",
			}),
		);
		await flushMicrotasks();
		bridge.cdpClosed(conn);
		await finish(true);
		expect(calls).toEqual([]);
		// Its next hello retries the close; the update follows once Chrome confirms it.
		const again = new FakeExtSocket();
		hello(bridge, again);
		const retry = again.messages.find(msg => msg.t === "rpc" && msg.op === "removeTab") as { id: number };
		expect(calls).toEqual([]);
		bridge.extMessage(again, JSON.stringify({ t: "rpcResult", id: retry.id, ok: true, result: {} }));
		await flushMicrotasks();
		expect(calls).toEqual([EXTENSION_ID]);
		await finish(true);
		expect(again.reloads).toBe(1);
	});

	it("reloads once per version, so an extension that comes back with a version it had is not reloaded again", async () => {
		const { bridge, calls, finish } = bridgeWithUpdater();
		hello(bridge, new FakeExtSocket());
		await finish(true);
		const again = new FakeExtSocket();
		hello(bridge, again);
		await finish(true);
		expect(again.reloads).toBe(0);
		bridge.extClosed(again);
		const newer = new FakeExtSocket();
		hello(bridge, newer, { ompVersion: "18.7.0" });
		await finish(true);
		expect(newer.reloads).toBe(1);
		const back = new FakeExtSocket();
		hello(bridge, back);
		await finish(true);
		expect(back.reloads).toBe(0);
		expect(calls).toHaveLength(2);
		expect(bridge.ready).toBe(true);
	});
});

describe("reloading into the installed folder", () => {
	/** A bridge whose extension folder holds `installed.stamp`, and that must never rewrite a folder itself. */
	function bridgeWithFolder(stamp: RelayExtensionStamp | null): {
		bridge: RelayBridge;
		installed: { stamp: RelayExtensionStamp | null };
		writes: string[];
	} {
		const installed = { stamp };
		const writes: string[] = [];
		const bridge = new RelayBridge({
			installedStamp: () => Promise.resolve(installed.stamp),
			updateExtension: extensionId => {
				writes.push(extensionId);
				return Promise.resolve(true);
			},
		});
		return { bridge, installed, writes };
	}

	it("reloads an extension running another build of this omp version, once per running build", async () => {
		const { bridge, writes } = bridgeWithFolder({
			ompVersion: VERSION,
			ompBuild: "rebuilt",
		});
		const socket = new FakeExtSocket();
		hello(bridge, socket, { ompVersion: VERSION, ompBuild: "stale" });
		await flushMicrotasks();
		expect(socket.reloads).toBe(1);
		expect(socket.closed).toBe(true);
		// Chrome kept the old service worker: the same build is back, and asking again would loop.
		const back = new FakeExtSocket();
		hello(bridge, back, { ompVersion: VERSION, ompBuild: "stale" });
		await flushMicrotasks();
		expect(back.reloads).toBe(0);
		expect(writes).toEqual([]);
	});

	it("leaves an extension running its folder's build alone until a recheck finds the folder changed", async () => {
		const { bridge, installed } = bridgeWithFolder({
			ompVersion: VERSION,
			ompBuild: "current",
		});
		const socket = new FakeExtSocket();
		hello(bridge, socket, { ompVersion: VERSION, ompBuild: "current" });
		await flushMicrotasks();
		expect(socket.reloads).toBe(0);
		installed.stamp = { ompVersion: VERSION, ompBuild: "rebuilt" };
		bridge.recheckExtensions();
		await flushMicrotasks();
		expect(socket.reloads).toBe(1);
	});

	it("waits for the last CDP client to leave before reloading", async () => {
		const { bridge } = bridgeWithFolder({
			ompVersion: VERSION,
			ompBuild: "rebuilt",
		});
		const conn = bridge.cdpConnected(FAKE_CDP);
		const socket = new FakeExtSocket();
		hello(bridge, socket, { ompVersion: VERSION, ompBuild: "stale" });
		await flushMicrotasks();
		expect(socket.reloads).toBe(0);
		bridge.cdpClosed(conn);
		await flushMicrotasks();
		expect(socket.reloads).toBe(1);
	});

	it("never reloads an extension whose folder omp does not manage", async () => {
		const { bridge } = bridgeWithFolder(null);
		const socket = new FakeExtSocket();
		hello(bridge, socket, { ompVersion: VERSION, ompBuild: "anything" });
		await flushMicrotasks();
		expect(socket.reloads).toBe(0);
	});
});

describe("Chrome's unpacked extension id", () => {
	// Chromium's own fixtures: components/crx_file/id_util_unittest.cc, GenerateIDForPath.
	it("matches Chromium's id for a path on macOS and Linux", () => {
		expect(extensionIdForPath("/path/to/file.ext", "darwin")).toBe("lnkgfdknojmdambfcanadbhmfjfljobb");
		expect(extensionIdForPath("/path/to/file.ext", "linux")).toBe("lnkgfdknojmdambfcanadbhmfjfljobb");
	});

	it("matches Chromium's id for a path on Windows, which hashes UTF-16 and upper-cases the drive letter", () => {
		expect(extensionIdForPath("/path/to/file.ext", "win32")).toBe("jjlkojfgbeklddcpckipekckcmgcbfjn");
		expect(extensionIdForPath("c:\\Users\\me\\ext", "win32")).toBe(extensionIdForPath("C:\\Users\\me\\ext", "win32"));
	});
});

describe("writing the omp extension", () => {
	let home: TempDir;

	beforeEach(async () => {
		home = await TempDir.create("@omp-relay-self-update-");
	});

	afterEach(async () => {
		await home.remove();
	});

	it("installs the side panel, worker, content scripts, and icons under Chrome's expected paths", async () => {
		const dir = home.join("extension");
		expect(await writeRelayExtension(dir, VERSION)).toBe(true);

		const files = await relayExtensionFiles(VERSION);
		for (const name of [
			"LICENSE",
			"background.js",
			"manifest.json",
			"offscreen.html",
			"offscreen.js",
			"options.html",
			"options.js",
			"overlay.js",
			"panel.css",
			"panel.html",
			"panel.js",
			"recorder.js",
		]) {
			const expected = files[name];
			if (typeof expected !== "string") throw new Error(`${name} should be a text asset`);
			const installed = await Bun.file(home.join(`extension/${name}`)).text();
			expect(installed).not.toBe("");
			expect(installed).toBe(expected);
		}

		for (const size of [16, 32, 48, 128]) {
			const name = `icons/omp-${size}.png`;
			const icon = Buffer.from(await Bun.file(home.join(`extension/${name}`)).arrayBuffer());
			expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
			expect(icon.readUInt32BE(16)).toBe(size);
			expect(icon.readUInt32BE(20)).toBe(size);
			const expected = files[name];
			if (!(expected instanceof Uint8Array)) throw new Error(`${name} should be a binary asset`);
			expect(icon).toEqual(Buffer.from(expected));
		}
	});

	it("repairs a corrupted nested icon even when the installed version matches", async () => {
		const dir = home.join("extension");
		const icon = home.join("extension/icons/omp-32.png");
		await writeRelayExtension(dir, VERSION);
		const original = await Bun.file(icon).bytes();
		await Bun.write(icon, original.with(0, 0));

		expect(await writeRelayExtension(dir, VERSION)).toBe(true);
		expect(await Bun.file(icon).bytes()).toEqual(original);
		expect(await writeRelayExtension(dir, VERSION)).toBe(false);
	});

	it("writes background.js last, so an update that fails midway leaves the old version reported", async () => {
		const dir = home.join("extension");
		await writeRelayExtension(dir, OLD);
		// Publishing the new manifest fails (a full disk, an I/O error); background.js has not been written yet.
		const rename = nodeFs.promises.rename.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith("manifest.json")) {
				throw Object.assign(new Error("EIO: i/o error, rename"), {
					code: "EIO",
				});
			}
			return rename(from, to);
		});
		try {
			await expect(writeRelayExtension(dir, VERSION)).rejects.toThrow("EIO");
		} finally {
			spy.mockRestore();
		}
		expect(await Bun.file(home.join("extension/background.js")).text()).toBe(
			(await relayExtensionFiles(OLD))["background.js"],
		);
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("replaces a file Windows refuses to rename over, as when Chrome or antivirus holds it", async () => {
		const dir = home.join("extension");
		await writeRelayExtension(dir, OLD);
		const rename = nodeFs.promises.rename.bind(nodeFs.promises);
		let refused = 0;
		const spy = spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			// Windows answers a rename over a held file with EPERM; moving the held file aside still works.
			if (String(from).endsWith(".tmp") && refused++ === 0) {
				throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
			}
			return rename(from, to);
		});
		try {
			await writeRelayExtension(dir, VERSION);
		} finally {
			spy.mockRestore();
		}
		expect(refused).toBeGreaterThan(1);
		expect(await installedRelayExtensionVersion(dir)).toBe(VERSION);
		expect(await Bun.file(home.join("extension/background.js")).text()).toBe(
			(await relayExtensionFiles(VERSION))["background.js"],
		);
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".tmp") || name.endsWith(".bak"))).toEqual([]);
	});
});
