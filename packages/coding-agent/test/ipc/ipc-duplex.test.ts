import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Duplex, Readable } from "node:stream";
import { ipcDuplex } from "@oh-my-pi/pi-coding-agent/ipc/ipc-duplex";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let dir: string;
let server: IpcServer | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
	if (dir) await removeWithRetries(dir);
});

async function listen(onPeer: (peer: Duplex) => void): Promise<string> {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-duplex-"));
	const endpoint = ipcEndpoint(dir, "duplex");
	server = await IpcServer.listen(endpoint, { framing: "raw" }, connection => onPeer(ipcDuplex(connection)));
	return endpoint;
}

async function dial(endpoint: string): Promise<Duplex> {
	return ipcDuplex(await IpcConnection.connect(endpoint, { framing: "raw" }));
}

/** The bytes a stream delivers until its input ends, as the RPC transports read them. */
async function readAll(stream: Duplex): Promise<Buffer> {
	return Buffer.from(await new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>).arrayBuffer());
}

describe("ipcDuplex", () => {
	it("flushes queued writes before ending, then closes once both directions are done", async () => {
		const received = Promise.withResolvers<Buffer>();
		const endpoint = await listen(peer => {
			void readAll(peer).then(received.resolve);
			peer.end("pong\n");
		});
		const client = await dial(endpoint);
		const closed = Promise.withResolvers<void>();
		client.once("close", () => closed.resolve());

		client.end("ping\n");

		expect((await readAll(client)).toString()).toBe("pong\n");
		expect((await received.promise).toString()).toBe("ping\n");
		await closed.promise;
	});

	it("delivers a write larger than the native queue limit intact", async () => {
		const received = Promise.withResolvers<Buffer>();
		const endpoint = await listen(peer => void readAll(peer).then(received.resolve));
		const client = await dial(endpoint);
		const payload = Buffer.alloc(5 * 1024 * 1024, "a");

		client.end(payload);

		expect((await received.promise).equals(payload)).toBe(true);
	});

	it("reports a locally destroyed stream to its peer as a close", async () => {
		const peerClosed = Promise.withResolvers<void>();
		const endpoint = await listen(peer => {
			peer.resume();
			peer.once("close", () => peerClosed.resolve());
		});
		const client = await dial(endpoint);

		client.destroy();

		await peerClosed.promise;
		expect(client.destroyed).toBe(true);
	});

	it("ends a pending read cleanly instead of aborting it when destroyed locally", async () => {
		const endpoint = await listen(peer => peer.resume());
		const client = await dial(endpoint);
		const reader = (Readable.toWeb(client) as ReadableStream<Uint8Array>).getReader();
		const pending = reader.read();

		client.destroy();

		expect((await pending).done).toBe(true);
	});
});
