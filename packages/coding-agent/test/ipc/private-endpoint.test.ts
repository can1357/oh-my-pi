import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { privateEndpoint, probeEndpoint, writePrivateJson } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let dir: string;
afterEach(async () => dir && (await removeWithRetries(dir)));

describe("private endpoint", () => {
	it("relocates a socket path that would overflow sun_path and still binds it", async () => {
		if (process.platform === "win32") return;
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipc-"));
		const deep = path.join(dir, "x".repeat(120));
		await fs.mkdir(deep, { recursive: true });
		const endpoint = await privateEndpoint(deep, "abcdef0123456789", {
			prefix: "t",
			label: "test",
			fallbackBase: dir,
		});
		expect(endpoint.startsWith(deep)).toBe(false);
		const server = net.createServer();
		const listening = Promise.withResolvers<void>();
		server.listen(endpoint, () => listening.resolve());
		await listening.promise;
		expect(await probeEndpoint(endpoint, 500)).toBe("alive");
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
		expect(await probeEndpoint(endpoint, 500)).toBe("dead");
	});

	it("writes owner-only JSON atomically", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipc-"));
		const target = path.join(dir, "e.json");
		await Promise.all([writePrivateJson(target, { n: 1 }), writePrivateJson(target, { n: 2 })]);
		expect([1, 2]).toContain((await Bun.file(target).json()).n);
		if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(dir)).filter(n => n.endsWith(".tmp"))).toEqual([]);
	});
});
