import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { mnemopiEmbedServerName } from "@oh-my-pi/pi-mnemopi/embed-protocol";
import { lines, MODEL, nextLine, request, spawnFixture } from "../../mnemopi/test/helpers/embed-ipc";

it("omp's real shared-worker client adopts the standalone endpoint and VERSION tag without spawning a replacement", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-standalone-"));
	// A noncanonical cache spelling must still name the same endpoint as the omp client.
	const cache = `${path.join(dir, "cache")}${path.sep}.`;
	const server = spawnFixture("serve", dir, ["--cache-dir", cache]);
	const endpoint = ipcEndpoint(path.join(dir, "run"), mnemopiEmbedServerName(MODEL, path.join(dir, "cache")));
	try {
		expect(await nextLine(lines(server.stderr))).toContain(`at ${endpoint}`);
		for (let session = 0; session < 2; session++) {
			const client = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures/mnemopi-embed-standalone.ts"), dir],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			try {
				const [stdout, stderr, code] = await Promise.all([
					new Response(client.stdout).text(),
					new Response(client.stderr).text(),
					client.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(JSON.parse(stdout)).toEqual({
					vectors: [
						[5, 7],
						[3, 7],
					],
					spawns: 0,
				});
			} finally {
				client.kill("SIGKILL");
				await client.exited;
			}
		}
		expect(server.exitCode).toBeNull();
		expect(await request(endpoint, { type: "ping", id: "still-here" })).toMatchObject({
			type: "pong",
			id: "still-here",
		});
	} finally {
		server.kill("SIGKILL");
		await server.exited;
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);
