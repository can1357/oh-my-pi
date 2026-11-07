import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import {
	extensionIdForPath,
	installedRelayExtensionVersion,
	relayExtensionFiles,
	unpackedExtensionId,
	writeRelayExtension,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import type { RelayToExtMessage, TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

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
	reloadProtocol?: number;
	extensionId?: string;
	attachedTabIds?: number[];
}

function hello(bridge: RelayBridge, socket: FakeExtSocket, opts: Hello = {}): void {
	const {
		instanceId = "chrome",
		ompVersion = OLD,
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
			reloadProtocol,
			tabs: [tab(1)],
			attachedTabIds,
		}),
	);
}

/** A bridge whose updater records the ids it was asked about and resolves when the test says. */
function bridgeWithUpdater(): { bridge: RelayBridge; calls: string[]; finish: (updated: boolean) => Promise<void> } {
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
		hello(bridge, new FakeExtSocket(), { instanceId: "edge", ompVersion: VERSION });
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
				JSON.stringify({ id: 1, method: "Target.createTarget", params: { background: true } }),
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
				JSON.stringify({ t: "rpcResult", id: create.id, ok: true, result: { tab: tab(2) } }),
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
		bridge.cdpMessage(conn, JSON.stringify({ id: 1, method: "Target.createTarget", params: { background: true } }));
		await flushMicrotasks();
		const create = socket.messages.find(msg => msg.t === "rpc" && msg.op === "createTab") as { id: number };
		bridge.cdpClosed(conn);
		await finish(true);
		// A reload now would cut the create off, and the reloaded extension's new browser session retires its tab id.
		expect(calls).toEqual([]);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: create.id, ok: true, result: { tab: tab(2) } }));
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
			JSON.stringify({ id: 1, method: "Target.closeTarget", params: { targetId: `PAGE${code}.1` } }),
		);
		await flushMicrotasks();
		const refused = socket.messages.find(msg => msg.t === "rpc" && msg.op === "removeTab") as { id: number };
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: refused.id, ok: false, error: "dragging" }));
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

describe("relay extension self-update on a real relay", () => {
	let home: TempDir;
	let relay: RelayServer | undefined;
	const sockets: WebSocket[] = [];

	beforeEach(async () => {
		home = await TempDir.create("@omp-relay-self-update-");
	});

	afterEach(async () => {
		for (const socket of sockets.splice(0)) socket.close();
		relay?.stop();
		relay = undefined;
		await home.remove();
	});

	/** Start a relay keeping `dir` current; `settled` resolves after `count` reload requests or stopped updates. */
	async function startRelay(
		dir: string,
		count = 1,
	): Promise<{ port: number; events: string[]; settled: Promise<void> }> {
		const port = await findFreeCdpPort();
		const events: string[] = [];
		const settled = Promise.withResolvers<void>();
		let outcomes = 0;
		relay = startRelayServer({
			port,
			group: false,
			extensionDir: dir,
			log: message => {
				events.push(message);
				if (message !== "extension reloading into update" && message !== "extension update stopped") return;
				if (++outcomes === count) settled.resolve();
			},
		});
		return { port, events, settled: settled.promise };
	}

	/** Dial the relay as the extension Chrome loaded from `loadedFrom` in browser `instanceId`, and say hello. */
	async function dialExtension(port: number, loadedFrom: string, instanceId = "chrome"): Promise<void> {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ext`, {
			headers: { Origin: `chrome-extension://${await unpackedExtensionId(loadedFrom)}` },
		});
		sockets.push(socket);
		const opened = Promise.withResolvers<void>();
		socket.addEventListener("open", () => opened.resolve(), { once: true });
		await opened.promise;
		socket.send(
			JSON.stringify({
				t: "hello",
				instanceId,
				userAgent: "test",
				browserVersion: "Chrome/155.0.0.0",
				discardedTabsProtocol: 1,
				ompVersion: OLD,
				reloadProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
	}

	async function expectCurrentFiles(dir: string): Promise<void> {
		const files = relayExtensionFiles(VERSION);
		for (const name in files) expect(await Bun.file(`${dir}/${name}`).text()).toBe(files[name]!);
	}

	it("rewrites the copy Chrome loaded from the install directory to this omp's files and asks for a reload", async () => {
		const dir = home.join("extension");
		await writeRelayExtension(dir, OLD);
		const { port, events, settled } = await startRelay(dir);
		await dialExtension(port, dir);
		await settled;
		expect(events).toContain("extension reloading into update");
		await expectCurrentFiles(dir);
	});

	it("reloads every Chrome profile that loaded the install directory, writing its files one at a time", async () => {
		const dir = home.join("extension");
		await writeRelayExtension(dir, OLD);
		const { port, events, settled } = await startRelay(dir, 3);
		await Promise.all(["work", "home", "test"].map(profile => dialExtension(port, dir, profile)));
		await settled;
		expect(events.filter(event => event === "extension reloading into update")).toHaveLength(3);
		expect(events).not.toContain("extension update stopped");
		await expectCurrentFiles(dir);
	});

	it("leaves an extension loaded from another directory alone", async () => {
		const dir = home.join("extension");
		const elsewhere = home.join("dev-build");
		await writeRelayExtension(dir, OLD);
		await writeRelayExtension(elsewhere, OLD);
		const { port, events, settled } = await startRelay(dir);
		await dialExtension(port, elsewhere);
		await settled;
		expect(events).toContain("extension update stopped");
		expect(await installedRelayExtensionVersion(dir)).toBe(OLD);
		expect(await installedRelayExtensionVersion(elsewhere)).toBe(OLD);
	});

	it("leaves files a newer omp installed for that omp's relay", async () => {
		const dir = home.join("extension");
		await writeRelayExtension(dir, "999.0.0");
		const { port, events, settled } = await startRelay(dir);
		await dialExtension(port, dir);
		await settled;
		expect(events).toContain("extension update stopped");
		expect(await installedRelayExtensionVersion(dir)).toBe("999.0.0");
	});

	it("writes background.js last, so an update that fails midway leaves the old version reported", async () => {
		const dir = home.join("extension");
		await writeRelayExtension(dir, OLD);
		// Publishing the new manifest fails (a full disk, an I/O error); background.js has not been written yet.
		const rename = nodeFs.promises.rename.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith("manifest.json")) {
				throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
			}
			return rename(from, to);
		});
		try {
			await expect(writeRelayExtension(dir, VERSION)).rejects.toThrow("EIO");
		} finally {
			spy.mockRestore();
		}
		expect(await Bun.file(home.join("extension/background.js")).text()).toBe(
			relayExtensionFiles(OLD)["background.js"]!,
		);
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
			relayExtensionFiles(VERSION)["background.js"]!,
		);
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".tmp") || name.endsWith(".bak"))).toEqual([]);
	});
});
