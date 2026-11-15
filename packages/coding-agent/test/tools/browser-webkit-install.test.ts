import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { currentBuildHost, type Fetch } from "@oh-my-pi/pi-coding-agent/cli/build-service";
import {
	ABKIT_BUILD,
	ABKIT_VERSION,
	ENGINE_VERSION_FILE,
	installWebKitEngine,
} from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/install";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const DOWNLOAD = "https://r2.test/abkit.tar.gz";

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

/** The build service and its download for ABKit {@link ABKIT_VERSION} as `bytes`; `requests` records every URL asked for. */
async function buildService(bytes: Uint8Array, requests: string[]): Promise<Fetch> {
	const host = await currentBuildHost();
	return async input => {
		const url = String(input);
		requests.push(url);
		if (new URL(url).pathname === `/api/products/abkit/versions/${ABKIT_VERSION}/${host.target}`) {
			return Response.json({
				build: { version: ABKIT_VERSION },
				file: {
					name: ABKIT_BUILD.fileName(host, ABKIT_VERSION),
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

/** Entries beside the engine directory, other than it and its install lock. */
async function leftovers(engineDir: string): Promise<string[]> {
	const base = path.basename(engineDir);
	return (await fs.readdir(path.dirname(engineDir))).filter(
		name => name !== base && !name.startsWith(`${base}.install`),
	);
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
		expect(await Bun.file(path.join(engineDir, ENGINE_VERSION_FILE)).text()).toBe(`${ABKIT_VERSION}\n`);
		expect(await leftovers(engineDir)).toEqual([]);
		expect(requests).toHaveLength(2);

		expect(await installWebKitEngine(engineDir, { fetchImpl })).toBe(host);
		expect(requests).toHaveLength(2);
	});

	it("replaces an engine older than ABKIT_VERSION or naming none, and keeps a current, newer or local one", async () => {
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
		expect(await installed("0.0.9")).toEqual({ engine: "new engine", requests: 2 });
		// The pinned release, a newer one (another omp's or Tern's), and a local build stay, asking nothing.
		expect(await installed(ABKIT_VERSION)).toEqual({ engine: "old engine", requests: 0 });
		expect(await installed("999.0.0")).toEqual({ engine: "old engine", requests: 0 });
		expect(await installed("dev")).toEqual({ engine: "old engine", requests: 0 });
	});

	it("does not update an outdated engine a process runs from", async () => {
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

		expect(requests).toEqual([]);
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
