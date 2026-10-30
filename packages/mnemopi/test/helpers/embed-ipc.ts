import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import type { Subprocess } from "bun";
import type { MnemopiEmbedServerRequest, MnemopiEmbedServerResponse } from "../../src/embed-protocol";

export const MODEL = "fast-bge-small-en-v1.5";
export const MODEL_NAME = "BAAI/bge-small-en-v1.5";
export type FixtureProcess = Subprocess<"pipe", "pipe", "pipe">;

export function spawnFixture(mode: "serve" | "client" | "host", dir: string, args: string[] = []): FixtureProcess {
	const env: NodeJS.ProcessEnv = { ...process.env, MNEMOPI_EMBEDDING_MODEL: MODEL_NAME };
	for (const key of [
		"NODE_ENV",
		"BUN_ENV",
		"MNEMOPI_NO_EMBEDDINGS",
		"MNEMOPI_EMBEDDINGS_VIA_API",
		"OPENROUTER_BASE_URL",
	]) {
		delete env[key];
	}
	return Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixtures/embed-ipc.ts"), mode, dir, ...args], {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

export function lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	return decodeLines(stream);
}

async function* decodeLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	for await (const line of readLines(stream)) yield new TextDecoder().decode(line);
}

export async function nextLine(output: AsyncGenerator<string>): Promise<string> {
	const timer = Promise.withResolvers<never>();
	const timeout = setTimeout(() => timer.reject(new Error("fixture output timed out")), 10_000);
	try {
		const result = await Promise.race([output.next(), timer.promise]);
		if (result.done) throw new Error("fixture exited before output");
		return result.value;
	} finally {
		clearTimeout(timeout);
	}
}

/** One real newline-JSON exchange, with close and timeout surfaced as errors. */
export async function request(
	endpoint: string,
	message: MnemopiEmbedServerRequest,
): Promise<MnemopiEmbedServerResponse> {
	const connection = await IpcConnection.connect(endpoint, { framing: "lines" });
	const response = Promise.withResolvers<MnemopiEmbedServerResponse>();
	const timer = setTimeout(() => response.reject(new Error("IPC response timed out")), 5_000);
	connection.start(
		line => response.resolve(JSON.parse(line) as MnemopiEmbedServerResponse),
		reason => response.reject(new Error(reason ?? "connection closed")),
	);
	try {
		connection.send(JSON.stringify(message));
		return await response.promise;
	} finally {
		clearTimeout(timer);
		connection.destroy();
	}
}
