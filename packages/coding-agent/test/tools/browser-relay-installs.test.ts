import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getActiveProfile,
	getBrowserRelayInstallRegistryFile,
	isRecord,
	setProfile,
	TempDir,
	VERSION,
} from "@oh-my-pi/pi-utils";
import { syncRelayAfterVerifiedUpdate } from "../../src/cli/update-cli";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import {
	extensionIdForPath,
	installedRelayExtensionVersion,
	loadRelayExtension,
	writeRelayExtension,
} from "../../src/tools/browser/relay/extension-files";
import {
	installRelayExtension,
	readRelayInstallRegistry,
	readRelayInstalls,
	syncRelayInstalls,
} from "../../src/tools/browser/relay/installs";
import { writeRelayNativeHost } from "../../src/tools/browser/relay/native-host-manifest";
import {
	type RelayServer,
	startRelayServer,
} from "../../src/tools/browser/relay/server";

const OLD = "1.2.3";
const NEWER = "999.0.0";
const MANIFEST = "sh.omp.browser.json";

let home: TempDir;
let registryFile: string;
let relay: RelayServer | undefined;
const sockets: WebSocket[] = [];

beforeEach(async () => {
	home = await TempDir.create("@omp-relay-installs-");
	registryFile = home.join("state", "installs.json");
});

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	relay?.stop();
	relay = undefined;
	await home.remove();
});

describe("browser relay install registry", () => {
	it("uses the same registry path across omp profiles", () => {
		const previous = getActiveProfile();
		try {
			setProfile(undefined);
			const defaultRegistry = getBrowserRelayInstallRegistryFile();
			setProfile("browser-relay-testing");
			expect(getBrowserRelayInstallRegistryFile()).toBe(defaultRegistry);
		} finally {
			setProfile(previous);
		}
	});

	it("keeps an existing default install and records path aliases as one canonical custom install", async () => {
		expect(await readRelayInstallRegistry(registryFile)).toEqual({
			installs: [],
		});
		const defaultDir = home.join("default extension");
		await writeRelayExtension(defaultDir, OLD);
		const canonicalDefault = await fs.realpath(defaultDir);
		const customDir = home.join("custom extension");
		const alias = home.join("alias");
		await fs.mkdir(customDir);
		await fs.symlink(
			customDir,
			alias,
			process.platform === "win32" ? "junction" : "dir",
		);
		const options = { registryFile, defaultDir };

		const canonical = await installRelayExtension(alias, options);
		await installRelayExtension(customDir, options);

		expect(canonical).toBe(await fs.realpath(customDir));
		const registry = await readRelayInstallRegistry(registryFile);
		expect(registry.installs).toEqual([
			{ dir: canonical, ompVersion: VERSION, writtenAt: expect.any(Number) },
			{
				dir: canonicalDefault,
				ompVersion: null,
				writtenAt: expect.any(Number),
			},
		]);
		expect(await readRelayInstalls(options)).toEqual([
			{ dir: canonical, version: VERSION, missing: false },
			{ dir: canonicalDefault, version: null, missing: false },
		]);
	});

	it("syncs stale files, reports a deleted install without recreating it, and skips an already-synced startup", async () => {
		const installed = await installRelayExtension(home.join("present"), {
			registryFile,
		});
		const missing = await installRelayExtension(home.join("deleted"), {
			registryFile,
		});
		await writeRelayExtension(installed, OLD);
		await fs.rm(missing, { recursive: true });

		expect(await syncRelayInstalls({ registryFile, mode: "startup" })).toEqual([
			{ dir: installed, status: "written", ompVersion: VERSION },
			{ dir: missing, status: "missing" },
		]);
		expect(await installedRelayExtensionVersion(installed)).toBe(VERSION);
		expect(await fs.stat(missing).catch(() => undefined)).toBeUndefined();
		expect(await readRelayInstallRegistry(registryFile)).toMatchObject({
			lastSynced: `${VERSION}+${(await loadRelayExtension()).build}`,
		});
		expect(await readRelayInstalls({ registryFile })).toEqual([
			{ dir: installed, version: VERSION, missing: false },
			{ dir: missing, version: VERSION, missing: true },
		]);
		expect(await syncRelayInstalls({ registryFile, mode: "startup" })).toEqual(
			[],
		);
		expect(await syncRelayInstalls({ registryFile })).toEqual([
			{ dir: installed, status: "up to date", ompVersion: VERSION },
			{ dir: missing, status: "missing" },
		]);
	});
});

async function connectExtension(
	port: number,
	extensionId: string,
	stamp: { ompVersion: string; ompBuild?: string } = { ompVersion: OLD },
): Promise<{ reloaded: Promise<void> }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, {
		headers: { Origin: `chrome-extension://${extensionId}` },
	});
	sockets.push(ws);
	const opened = Promise.withResolvers<void>();
	const reload = Promise.withResolvers<void>();
	ws.addEventListener("open", () => opened.resolve(), { once: true });
	ws.addEventListener("message", (message) => {
		if (typeof message.data !== "string") return;
		const parsed: unknown = JSON.parse(message.data);
		if (isRecord(parsed) && parsed.t === "reload") reload.resolve();
	});
	await opened.promise;
	ws.send(
		JSON.stringify({
			t: "hello",
			instanceId: "chrome-test",
			userAgent: "test",
			browserVersion: "Chrome/155.0.0.0",
			...stamp,
			reloadProtocol: 1,
			tabs: [],
			attachedTabIds: [],
		}),
	);
	return { reloaded: reload.promise };
}

describe("outdated extension reload", () => {
	it("publishes every registered stale install before reloading a registered folder's extension, without downgrading newer files", async () => {
		const first = await installRelayExtension(home.join("work install"), {
			registryFile,
		});
		const second = await installRelayExtension(home.join("home install"), {
			registryFile,
		});
		const newer = await installRelayExtension(home.join("newer install"), {
			registryFile,
		});
		await Promise.all([
			writeRelayExtension(first, OLD),
			writeRelayExtension(second, OLD),
			writeRelayExtension(newer, NEWER),
		]);
		const port = await findFreeCdpPort();
		relay = startRelayServer({
			port,
			group: false,
			installRegistryFile: registryFile,
		});

		const { reloaded } = await connectExtension(
			port,
			extensionIdForPath(second),
		);
		await reloaded;
		expect(await installedRelayExtensionVersion(first)).toBe(VERSION);
		expect(await installedRelayExtensionVersion(second)).toBe(VERSION);
		expect(await installedRelayExtensionVersion(newer)).toBe(NEWER);
	});

	it("rewrites nothing and stays connected for an extension whose ID is no registered folder's", async () => {
		const dir = await installRelayExtension(home.join("registered"), {
			registryFile,
		});
		await writeRelayExtension(dir, OLD);
		const port = await findFreeCdpPort();
		const stopped = Promise.withResolvers<void>();
		const logs: string[] = [];
		relay = startRelayServer({
			port,
			group: false,
			installRegistryFile: registryFile,
			log(message) {
				logs.push(message);
				if (message === "extension update stopped") stopped.resolve();
			},
		});

		await connectExtension(
			port,
			extensionIdForPath(home.join("someone else's folder")),
		);
		await stopped.promise;
		expect(logs).not.toContain("extension reloading into update");
		expect(await installedRelayExtensionVersion(dir)).toBe(OLD);
		expect(relay.bridge.ready).toBe(true);
	});

	it("reloads a registered extension running another build than its folder holds, without rewriting the folder", async () => {
		const dir = await installRelayExtension(home.join("checkout install"), {
			registryFile,
		});
		const script = await Bun.file(path.join(dir, "background.js")).text();
		const port = await findFreeCdpPort();
		relay = startRelayServer({
			port,
			group: false,
			installRegistryFile: registryFile,
		});

		const { reloaded } = await connectExtension(port, extensionIdForPath(dir), {
			ompVersion: VERSION,
			ompBuild: "0000000000000000",
		});
		await reloaded;
		expect(await Bun.file(path.join(dir, "background.js")).text()).toBe(script);
	});
});

describe("Chrome native host install", () => {
	const pathCases: Array<{ platform: NodeJS.Platform; roots: string[] }> = [
		{
			platform: "darwin",
			roots: [
				"Google/Chrome",
				"Google/Chrome Beta",
				"Google/Chrome Dev",
				"Google/Chrome Canary",
				"Chromium",
				"BraveSoftware/Brave-Browser",
			].map(
				(browser) =>
					`Library/Application Support/${browser}/NativeMessagingHosts`,
			),
		},
		{
			platform: "linux",
			roots: [
				"google-chrome",
				"google-chrome-beta",
				"google-chrome-unstable",
				"google-chrome-canary",
				"chromium",
				"BraveSoftware/Brave-Browser",
			].map((browser) => `.config/${browser}/NativeMessagingHosts`),
		},
		{ platform: "win32", roots: [".omp/browser-relay"] },
	];
	for (const { platform, roots } of pathCases) {
		it(`writes a native host manifest admitting every install's ID to every ${platform} browser location`, async () => {
			const dir = home.join(".omp/browser-relay");
			const ids = [
				"pppppppppppppppppppppppppppppppp",
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"pppppppppppppppppppppppppppppppp",
			];
			const targets = await writeRelayNativeHost(ids, {
				platform,
				home: home.path(),
				dir,
				command: [process.execPath],
			});
			expect(targets).toEqual(roots.map((root) => home.join(root, MANIFEST)));
			for (const target of targets) {
				expect(await Bun.file(target).json()).toEqual({
					name: "sh.omp.browser",
					description: "omp browser native messaging host",
					path: path.join(
						dir,
						platform === "win32" ? "native-host.cmd" : "native-host",
					),
					type: "stdio",
					allowed_origins: [
						"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
						"chrome-extension://pppppppppppppppppppppppppppppppp/",
					],
				});
			}
		});
	}

	it.skipIf(process.platform === "win32")(
		"execs a source launcher with quoted arguments and discards Chrome's transport arguments",
		async () => {
			const dir = home.join("relay");
			const source = home.join("omp's launcher.ts");
			await Bun.write(
				source,
				"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
			);
			await writeRelayNativeHost([], {
				platform: "linux",
				home: home.path(),
				dir,
				command: [process.execPath, source],
			});
			const launcher = Bun.spawn(
				[path.join(dir, "native-host"), "chrome-extension://unused/"],
				{ stdout: "pipe" },
			);
			expect(await new Response(launcher.stdout).json()).toEqual([
				"browser-relay",
				"native-host",
			]);
			expect(await launcher.exited).toBe(0);
		},
	);
});

it.skipIf(process.platform === "win32")(
	"invokes the verified new executable to sync and does not fail the update on a nonzero sync exit",
	async () => {
		const launcher = home.join("new omp launcher");
		await Bun.write(
			launcher,
			'#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\nexit 7\n',
		);
		await fs.chmod(launcher, 0o700);
		await syncRelayAfterVerifiedUpdate(launcher);
		expect(await Bun.file(`${launcher}.args`).text()).toBe(
			"browser-relay\nsync\n",
		);
	},
);
