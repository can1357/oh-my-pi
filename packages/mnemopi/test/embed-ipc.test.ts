import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { VERSION } from "@oh-my-pi/pi-utils";
import { mnemopiEmbedServerName } from "../src/embed-protocol";
import { type FixtureProcess, lines, MODEL, MODEL_NAME, nextLine, request, spawnFixture } from "./helpers/embed-ipc";

let dir: string;
const children: FixtureProcess[] = [];
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "mn-ipc-"));
});
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	await fs.rm(dir, { recursive: true, force: true });
});
function spawn(mode: "serve" | "client" | "host", args: string[] = []): FixtureProcess {
	const child = spawnFixture(mode, dir, args);
	children.push(child);
	return child;
}
function endpoint(cacheDir = path.join(dir, "cache")): string {
	return ipcEndpoint(path.join(dir, "run"), mnemopiEmbedServerName(MODEL, cacheDir));
}
async function serve(args: string[] = []): Promise<FixtureProcess> {
	const child = spawn("serve", args);
	expect(await nextLine(lines(child.stderr))).toContain(`at ${endpoint()}`);
	return child;
}
async function init(): Promise<void> {
	expect(
		await request(endpoint(), { type: "init", id: "init", model: MODEL, cacheDir: path.join(dir, "cache") }),
	).toEqual({ type: "ready", id: "init" });
}
function embed(id: string, text: string) {
	return request(endpoint(), { type: "embed", id, model: MODEL, cacheDir: path.join(dir, "cache"), texts: [text] });
}

describe("standalone shared embedding IPC", () => {
	it("binds an empty endpoint and serves tagged ping, init, and embeddings", async () => {
		await serve();
		expect(await request(endpoint(), { type: "ping", id: "ping" })).toEqual({
			type: "pong",
			id: "ping",
			tag: VERSION,
		});
		await init();
		expect(await embed("vectors", "hello")).toEqual({ type: "vectors", id: "vectors", vectors: [[5, 7]] });
	});

	it.skipIf(process.platform === "win32")("exits nonzero and names the endpoint when binding fails", async () => {
		// A directory cannot be replaced by the native Unix socket binder.
		await fs.mkdir(endpoint(), { recursive: true });
		const child = spawn("serve");
		const stderr = new Response(child.stderr).text();
		expect(await child.exited).not.toBe(0);
		expect(await stderr).toContain(endpoint());
	});

	it("exits successfully without replacing a live owner", async () => {
		const owner = await serve();
		await init();
		const other = spawn("serve");
		const stderr = new Response(other.stderr).text();
		expect(await other.exited).toBe(0);
		expect(await stderr).toContain(`already running at ${endpoint()}`);
		expect(owner.exitCode).toBeNull();
		expect(await embed("still-live", "same owner")).toEqual({
			type: "vectors",
			id: "still-live",
			vectors: [[10, 7]],
		});
	});

	it.skipIf(process.platform === "win32")("takes over a stale socket left by a killed listener", async () => {
		const crashed = await serve();
		crashed.kill("SIGKILL");
		await crashed.exited;
		expect((await fs.lstat(endpoint())).isSocket()).toBe(true);
		await serve();
		await init();
		expect(await embed("recovered", "hello")).toMatchObject({ type: "vectors", vectors: [[5, 7]] });
	});

	it("returns errors for embed-before-init and unknown models without poisoning later requests", async () => {
		await serve();
		expect(await embed("early", "hello")).toMatchObject({
			type: "error",
			id: "early",
			error: expect.stringMatching(/init/i),
		});
		expect(await request(endpoint(), { type: "init", id: "unknown", model: "no-such-model" })).toMatchObject({
			type: "error",
			id: "unknown",
		});
		await init();
		expect(await embed("after-errors", "hello")).toMatchObject({ type: "vectors", vectors: [[5, 7]] });
	});

	it("serializes inference across clients and keeps serving after an inference error", async () => {
		await serve();
		await init();
		const results = await Promise.all([embed("a", "hello"), embed("b", "sky")]);
		expect(results).toEqual([
			{ type: "vectors", id: "a", vectors: [[5, 7]] },
			{ type: "vectors", id: "b", vectors: [[3, 7]] },
		]);
		expect(await embed("bad", "fail")).toMatchObject({ type: "error", error: "fake inference failed" });
		expect(await embed("good", "again")).toMatchObject({ type: "vectors", vectors: [[5, 7]] });
	});

	it("releases the endpoint and exits on shutdown, allowing another server to bind", async () => {
		const child = await serve();
		await init();
		const connection = await IpcConnection.connect(endpoint(), { framing: "lines" });
		connection.send(JSON.stringify({ type: "shutdown", id: "stop" }));
		await connection.drained();
		await child.exited;
		expect(child.signalCode).toBe("SIGKILL");
		connection.destroy();
		if (process.platform !== "win32") await expect(fs.lstat(endpoint())).rejects.toMatchObject({ code: "ENOENT" });
		await serve();
		await init();
		expect(await embed("new", "hello")).toMatchObject({ type: "vectors", vectors: [[5, 7]] });
	});

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		it(`uses SIGKILL after ${signal} with a loaded model and frees the endpoint`, async () => {
			const child = await serve();
			await init();
			child.kill(signal);
			await child.exited;
			expect(child.signalCode).toBe("SIGKILL");
			if (process.platform !== "win32") await expect(fs.lstat(endpoint())).rejects.toMatchObject({ code: "ENOENT" });
		});
	}

	it("selects the requested model/cache pair and rejects removed HTTP flags", async () => {
		const cache = path.join(dir, "other-cache");
		const child = spawn("serve", ["--model", MODEL_NAME, "--cache-dir", cache]);
		expect(await nextLine(lines(child.stderr))).toContain(`at ${endpoint(cache)}`);
		expect(
			await request(endpoint(cache), { type: "init", id: "custom", model: MODEL, cacheDir: cache }),
		).toMatchObject({ type: "ready" });
		expect(
			await request(endpoint(cache), {
				type: "embed",
				id: "custom-embed",
				model: MODEL,
				cacheDir: cache,
				texts: ["hello"],
			}),
		).toMatchObject({ type: "vectors", vectors: [[5, 7]] });
		for (const flag of ["--port", "--host", "--socket"]) {
			const invalid = spawn("serve", [flag, "removed"]);
			expect(await invalid.exited).toBe(2);
		}
	});
});

describe("mnemopi local embedding discovery", () => {
	it("uses the shared model without loading another runtime", async () => {
		await serve();
		const client = spawn("client");
		const output = lines(client.stdout);
		client.stdin.write("hello\n");
		expect(JSON.parse(await nextLine(output))).toEqual({ vectors: [[5, 7]], loads: 0 });
	});

	it("falls back to one in-process model when no endpoint answers", async () => {
		const client = spawn("client");
		const output = lines(client.stdout);
		for (const text of ["hello", "sky"]) {
			client.stdin.write(`${text}\n`);
			expect(JSON.parse(await nextLine(output))).toEqual({ vectors: [[text.length, 3]], loads: 1 });
		}
	});

	it("preserves the host initializer even while a shared server is running", async () => {
		await serve();
		const client = spawn("host");
		client.stdin.write("hello\n");
		expect(JSON.parse(await nextLine(lines(client.stdout)))).toEqual({ vectors: [[5, 9]], loads: 0 });
	});

	it("fails a call when the server dies, then recovers with the local fallback", async () => {
		const server = await serve();
		const events = lines(server.stdout);
		const client = spawn("client");
		const output = lines(client.stdout);
		client.stdin.write("hold\n");
		expect(await nextLine(events)).toBe("inference-started");
		server.kill("SIGKILL");
		await server.exited;
		// embed() preserves its nullable error contract; the next request retries discovery.
		expect(JSON.parse(await nextLine(output))).toEqual({ vectors: null, loads: 0 });
		client.stdin.write("recovery\n");
		expect(JSON.parse(await nextLine(output))).toEqual({ vectors: [[8, 3]], loads: 1 });
	});
});
