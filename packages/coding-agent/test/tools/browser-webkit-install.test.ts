import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { currentBuildHost, type Fetch } from "@oh-my-pi/pi-coding-agent/cli/build-service";
import {
	ABKIT_BUILD,
	ENGINE_VERSION_FILE,
	installWebKitEngine,
} from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/install";
import { TempDir, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const DOWNLOAD = "https://r2.test/abkit.tar.gz";
/** The newest stable ABKit build the fake build service answers. */
const LATEST = "0.2.0";

let temp: TempDir;

beforeEach(async () => {
	temp = await TempDir.create("@omp-webkit-install-");
});

afterEach(async () => {
	await temp.remove();
});

/** A gzipped tar of `files` (relative path → content; every file executable), as ABKit's release workflow packs it. */
async function archive(files: Record<string, string>): Promise<Uint8Array> {
	const source = path.join(temp.path(), `src-${crypto.randomUUID()}`);
	for (const name in files) {
		await Bun.write(path.join(source, name), files[name]);
		await fs.chmod(path.join(source, name), 0o755);
	}
	const out = path.join(temp.path(), `${crypto.randomUUID()}.tar.gz`);
	await $`tar -czf ${out} -C ${source} ${await fs.readdir(source)}`.quiet();
	return new Uint8Array(await Bun.file(out).arrayBuffer());
}

/** The build service, whose newest stable ABKit is {@link LATEST}, and its download as `bytes`; `requests` records every URL asked for. */
async function buildService(bytes: Uint8Array, requests: string[]): Promise<Fetch> {
	const host = await currentBuildHost();
	return async input => {
		const url = String(input);
		requests.push(url);
		const asked = new URL(url);
		if (
			asked.pathname === `/api/products/abkit/latest/${host.target}` &&
			asked.searchParams.get("channel") === "stable"
		) {
			return Response.json({
				build: { version: LATEST },
				file: {
					name: ABKIT_BUILD.fileName(host, LATEST),
					size: bytes.byteLength,
					sha256: Bun.SHA256.hash(bytes, "hex"),
				},
				download: DOWNLOAD,
			});
		}
		if (url === DOWNLOAD) return new Response(bytes);
		return new Response(null, { status: 404 });
	};
}

/** Entries beside the engine directory, other than it, its versions and its install lock. */
async function leftovers(engineDir: string): Promise<string[]> {
	const base = path.basename(engineDir);
	return (await fs.readdir(path.dirname(engineDir))).filter(
		name => name !== base && name !== `${base}-versions` && !name.startsWith(`${base}.install`),
	);
}

/** An installed engine version folder `<engineDir>-versions/<version>` whose host is bun, as a running ABHost stands in. */
async function versionFolder(engineDir: string, version: string): Promise<string> {
	const folder = path.join(`${engineDir}-versions`, version);
	await Bun.write(path.join(folder, ENGINE_VERSION_FILE), `${version}\n`);
	await fs.symlink(process.execPath, path.join(folder, "ABHost"));
	return folder;
}

// ABKit ships a `.zip` on Windows, which this tar fixture does not stand in for.
describe.skipIf(process.platform === "win32")("omp's WebKit engine install", () => {
	it("replaces a partial engine directory with the archive's abkit/ and downloads nothing once installed", async () => {
		const bytes = await archive({ "abkit/ABHost": "#!/bin/sh\n", "abkit/lib/libengine.so": "engine" });
		const requests: string[] = [];
		const fetchImpl = await buildService(bytes, requests);
		const engineDir = path.join(temp.path(), "lib", "abkit");
		await Bun.write(path.join(engineDir, "stale.so"), "partial copy without a host");

		const host = await installWebKitEngine(engineDir, { fetchImpl });

		expect(host).toBe(path.join(engineDir, "ABHost"));
		expect(await Bun.file(path.join(engineDir, "lib", "libengine.so")).text()).toBe("engine");
		expect((await fs.stat(host)).mode & 0o111).not.toBe(0);
		expect(await Bun.file(path.join(engineDir, "stale.so")).exists()).toBe(false);
		expect(await Bun.file(path.join(engineDir, ENGINE_VERSION_FILE)).text()).toBe(`${LATEST}\n`);
		// The engine directory is now a link to the version's own folder.
		expect(await fs.readlink(engineDir)).toBe(path.join(`${engineDir}-versions`, LATEST));
		expect(await fs.readdir(`${engineDir}-versions`)).toEqual([LATEST]);
		expect(await leftovers(engineDir)).toEqual([]);
		expect(requests).toHaveLength(2);

		// Checked once per process: the next open asks the build service nothing.
		expect(await installWebKitEngine(engineDir, { fetchImpl })).toBe(host);
		expect(requests).toHaveLength(2);
	});

	it("replaces an engine older than the newest build or naming none, and keeps a current, newer or local one", async () => {
		const bytes = await archive({ "abkit/ABHost": "#!/bin/sh\n", "abkit/lib/libengine.so": "new engine" });
		const installed = async (version: string | undefined): Promise<{ engine: string; requests: number }> => {
			const engineDir = path.join(temp.path(), crypto.randomUUID(), "abkit");
			await Bun.write(path.join(engineDir, "ABHost"), "#!/bin/sh\n");
			await fs.chmod(path.join(engineDir, "ABHost"), 0o755);
			await Bun.write(path.join(engineDir, "lib", "libengine.so"), "old engine");
			if (version !== undefined) await Bun.write(path.join(engineDir, ENGINE_VERSION_FILE), `${version}\n`);
			const requests: string[] = [];
			await installWebKitEngine(engineDir, { fetchImpl: await buildService(bytes, requests) });
			return {
				engine: await Bun.file(path.join(engineDir, "lib", "libengine.so")).text(),
				requests: requests.length,
			};
		};

		// Engines installed before omp recorded a version, and older releases, are updated.
		expect(await installed(undefined)).toEqual({ engine: "new engine", requests: 2 });
		expect(await installed("0.1.9")).toEqual({ engine: "new engine", requests: 2 });
		// The newest build and a newer one (another omp's or Tern's) stay after the check; a local build asks nothing.
		expect(await installed(LATEST)).toEqual({ engine: "old engine", requests: 1 });
		expect(await installed("999.0.0")).toEqual({ engine: "old engine", requests: 1 });
		expect(await installed("dev")).toEqual({ engine: "old engine", requests: 0 });
	});

	it("updates a linked engine while a host runs from its version, keeping that version and deleting idle ones", async () => {
		const bytes = await archive({ "abkit/ABHost": "#!/bin/sh\n", "abkit/lib/libengine.so": "new engine" });
		const requests: string[] = [];
		const engineDir = path.join(temp.path(), "lib", "abkit");
		const idle = await versionFolder(engineDir, "0.1.0");
		const running = await versionFolder(engineDir, "0.1.9");
		await fs.symlink(running, engineDir);
		// A host started from its version's real path, as omp and Tern start ABHost.
		const host = Bun.spawn([path.join(running, "ABHost"), "-e", "await Bun.sleep(30_000)"], { stdout: "ignore" });
		try {
			await installWebKitEngine(engineDir, { fetchImpl: await buildService(bytes, requests) });

			expect(await fs.readlink(engineDir)).toBe(path.join(`${engineDir}-versions`, LATEST));
			expect(await Bun.file(path.join(engineDir, "lib", "libengine.so")).text()).toBe("new engine");
			expect(await Bun.file(path.join(running, ENGINE_VERSION_FILE)).exists()).toBe(true);
			expect(await Bun.file(path.join(idle, ENGINE_VERSION_FILE)).exists()).toBe(false);
			expect((await fs.readdir(`${engineDir}-versions`)).sort()).toEqual(["0.1.9", LATEST]);
		} finally {
			host.kill();
			await host.exited;
		}
	});

	it("runs an installed engine at once while another omp holds the install lock or the build service is down", async () => {
		const requests: string[] = [];
		const fetchImpl = await buildService(await archive({ "abkit/ABHost": "#!/bin/sh\n" }), requests);
		const busyDir = path.join(temp.path(), "busy", "abkit");
		await fs.symlink(await versionFolder(busyDir, "0.1.9"), busyDir);
		// Another omp downloading an update holds this lock for as long as the download takes.
		const lock = tryAcquireFileLock(`${busyDir}.install`);
		expect(lock).not.toBeNull();
		try {
			expect(await installWebKitEngine(busyDir, { fetchImpl })).toBe(path.join(busyDir, "ABHost"));
		} finally {
			lock?.release();
		}
		expect(requests).toEqual([]);

		const offlineDir = path.join(temp.path(), "offline", "abkit");
		await fs.symlink(await versionFolder(offlineDir, "0.1.9"), offlineDir);
		const offline: Fetch = async () => {
			throw new TypeError("fetch failed");
		};
		expect(await installWebKitEngine(offlineDir, { fetchImpl: offline })).toBe(path.join(offlineDir, "ABHost"));
	});

	it("does not replace a plain engine folder a process runs from", async () => {
		const bytes = await archive({ "abkit/ABHost": "#!/bin/sh\n" });
		const requests: string[] = [];
		const engineDir = path.join(temp.path(), "lib", "ab.kit");
		await Bun.write(path.join(engineDir, ENGINE_VERSION_FILE), "0.0.9\n");
		// A host started from the engine: bun, by a path inside it, as omp starts ABHost. Its sleep only
		// keeps it alive until the test kills it; spawn returns after exec, so pgrep sees it at once.
		await fs.symlink(process.execPath, path.join(engineDir, "ABHost"));
		const host = Bun.spawn([path.join(engineDir, "ABHost"), "-e", "await Bun.sleep(30_000)"], { stdout: "ignore" });
		try {
			await expect(
				installWebKitEngine(engineDir, { fetchImpl: await buildService(bytes, requests) }),
			).rejects.toThrow(`process ${host.pid}`);
		} finally {
			host.kill();
			await host.exited;
		}

		// It learned a newer build is out, and downloaded nothing.
		expect(requests).toHaveLength(1);
		expect(requests).not.toContain(DOWNLOAD);
		expect(await Bun.file(path.join(engineDir, ENGINE_VERSION_FILE)).text()).toBe("0.0.9\n");
	});

	it("leaves an outdated engine another app manages to that app", async () => {
		const bytes = await archive({ "abkit/ABHost": "#!/bin/sh\n" });
		const requests: string[] = [];
		const root = path.join(temp.path(), "tern-abkit");
		const version = path.join(root, "versions", "0.0.9");
		await Bun.write(path.join(root, "manager.json"), JSON.stringify({ manager: "tern", name: "Tern" }));
		await Bun.write(path.join(version, "ABHost"), "#!/bin/sh\n");
		await fs.chmod(path.join(version, "ABHost"), 0o755);
		await Bun.write(path.join(version, ENGINE_VERSION_FILE), "0.0.9\n");
		const engineDir = path.join(temp.path(), "lib", "abkit");
		await fs.mkdir(path.dirname(engineDir), { recursive: true });
		await fs.symlink(version, engineDir);

		expect(await installWebKitEngine(engineDir, { fetchImpl: await buildService(bytes, requests) })).toBe(
			path.join(engineDir, "ABHost"),
		);

		expect(requests).toEqual([]);
		expect(await fs.realpath(engineDir)).toBe(await fs.realpath(version));
		expect(await Bun.file(path.join(engineDir, ENGINE_VERSION_FILE)).text()).toBe("0.0.9\n");
	});

	it("refuses an archive without abkit/ABHost and keeps the directory already there", async () => {
		const bytes = await archive({ "engine/ABHost": "#!/bin/sh\n" });
		const fetchImpl = await buildService(bytes, []);
		const engineDir = path.join(temp.path(), "lib", "abkit");
		await Bun.write(path.join(engineDir, "keep.txt"), "user's files");

		await expect(installWebKitEngine(engineDir, { fetchImpl })).rejects.toThrow("holds no abkit/ABHost executable");

		expect(await Bun.file(path.join(engineDir, "keep.txt")).text()).toBe("user's files");
		expect(await leftovers(engineDir)).toEqual([]);
	});
});
