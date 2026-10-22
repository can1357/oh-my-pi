import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { probeEndpoint, writePrivateJson } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let dir: string;
afterEach(async () => dir && (await removeWithRetries(dir)));

describe("private endpoint", () => {
	it("probes a listening endpoint alive and one whose host is gone dead", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipc-"));
		const endpoint = ipcEndpoint(dir, "abcdef0123456789");
		const server = await IpcServer.listen(endpoint, { framing: "raw" }, () => {});
		expect(await probeEndpoint(endpoint, 500)).toBe("alive");
		await server.close();
		expect(await probeEndpoint(endpoint, 500)).toBe("dead");
	});

	it("writes owner-only JSON atomically", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipc-"));
		const target = path.join(dir, "e.json");
		const writers = Array.from({ length: 32 }, (_, n) => n);
		await Promise.all(writers.map(n => writePrivateJson(target, { n })));
		expect(writers).toContain((await Bun.file(target).json()).n);
		if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(dir)).filter(n => n.endsWith(".tmp"))).toEqual([]);
	});
});
