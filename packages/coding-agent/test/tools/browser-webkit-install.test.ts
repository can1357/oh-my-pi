import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { currentBuildHost, type Fetch } from "@oh-my-pi/pi-coding-agent/cli/build-service";
import { ABKIT_BUILD, installWebKitEngine } from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/install";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const VERSION = "1.2.3";
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

/** The build service and its download for one ABKit build of `bytes`; `requests` records every URL asked for. */
async function buildService(bytes: Uint8Array, requests: string[]): Promise<Fetch> {
	const host = await currentBuildHost();
	return async input => {
		const url = String(input);
		requests.push(url);
		if (new URL(url).pathname === `/api/products/abkit/latest/${host.target}`) {
			return Response.json({
				build: { version: VERSION },
				file: {
					name: ABKIT_BUILD.fileName(host, VERSION),
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
		expect(await leftovers(engineDir)).toEqual([]);
		expect(requests).toHaveLength(2);

		expect(await installWebKitEngine(engineDir, { fetchImpl })).toBe(host);
		expect(requests).toHaveLength(2);
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
