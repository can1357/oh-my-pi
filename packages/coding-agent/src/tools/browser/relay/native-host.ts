/**
 * Chrome native messaging host behind the omp extension (`omp browser-relay native-host`): its chats and its relay.
 *
 * Chrome starts one host per `chrome.runtime.connectNative` port and talks to it over stdio: every message is a
 * uint32 little-endian byte length followed by that many bytes of UTF-8 JSON. stdout carries only those frames; logs
 * go to stderr. The first extension message picks the port's job:
 * - `open{cwd}`: a chat. The host starts `omp --mode rpc` there and relays rpc JSON lines both ways until either side
 *   goes away. It negotiates rpc protocol v2 itself, ahead of any extension command, and reassembles its `rpc_chunk`
 *   frames, so the extension always sees whole logical lines and large responses (a transcript full of screenshots,
 *   the model list) arrive intact.
 * - `link{extensionId}`: the browser relay, for as long as the extension's service worker lives (`native-relay.ts`).
 *
 * Chrome caps host→extension messages at 1 MiB, so long lines go out as `chunk` frames.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FromNativeHost, ToNativeHost } from "../../../../../browser-relay/extension/messages";
import { RpcFrameDecoder } from "../../../modes/rpc/rpc-frame";
import { resolveCliEntryCmd } from "../../../subprocess/worker-client";
import { DEFAULT_RELAY_URL } from "./kind";
import { serveRelayLink } from "./native-relay";

/** Largest encoded frame the host writes; under Chrome's 1 MiB host→extension cap with headroom. */
export const NATIVE_FRAME_LIMIT = 900 * 1024;
/** Characters per `chunk` piece before shrinking to fit {@link NATIVE_FRAME_LIMIT}. */
const CHUNK_CHARS = 256 * 1024;
/** Bytes of child stderr kept for the `exit` frame. */
const STDERR_TAIL_BYTES = 8 * 1024;
/** Grace between SIGTERM and SIGKILL when the extension disconnects. */
const KILL_GRACE_MS = 3_000;
/** Request id of the host's own protocol negotiation; its response is not forwarded. */
const NEGOTIATE_ID = "omp-native-host:negotiate";

/** A spawned `omp --mode rpc` as the host drives it. */
export interface RpcChild {
	pid: number;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	/** Writes raw bytes to the child's stdin. */
	write(data: string): void;
	/** Exit code, or null when killed by a signal. */
	exited: Promise<number | null>;
	kill(signal: NodeJS.Signals): void;
}

/** Process boundary of the host; tests swap the child command and stdio. */
export interface NativeHostIo {
	/** Chrome's side of the port: length-prefixed JSON frames, ends when the extension disconnects. */
	input: ReadableStream<Uint8Array>;
	/** Writes one complete length-prefixed frame to Chrome. */
	write(bytes: Uint8Array): void;
	/** Starts the rpc child in `cwd`. */
	spawn(cwd: string): RpcChild;
	/** Port a link port serves (or joins) the relay on. */
	relayPort: number;
	/** Diagnostics; never stdout. */
	log(message: string): void;
}

/** Entry for `omp browser-relay native-host`: serves Chrome on this process's stdio. */
export async function runNativeHost(): Promise<void> {
	const command = [...resolveCliEntryCmd(), "--mode", "rpc"];
	let flushed = Promise.resolve();
	await serveNativeHost({
		input: Bun.stdin.stream(),
		write: bytes => {
			const { promise, resolve } = Promise.withResolvers<void>();
			process.stdout.write(bytes, () => resolve());
			flushed = promise;
		},
		spawn: cwd => spawnRpcChild(command, cwd),
		relayPort: Number(new URL(DEFAULT_RELAY_URL).port),
		log: message => {
			process.stderr.write(`omp native host: ${message}\n`);
		},
	});
	// Deliver the final `exit` frame, then leave: nothing else may keep the host alive once Chrome is gone.
	await flushed;
	process.exit(0);
}

/**
 * Starts `command` in `cwd` with an environment for a headless panel session: the browser tool drives the user's
 * Chrome through the relay (`PI_BROWSER_RELAY=1`), whatever the configured default.
 */
export function spawnRpcChild(command: readonly string[], cwd: string): RpcChild {
	const child = Bun.spawn([...command], {
		cwd,
		env: { ...process.env, PI_BROWSER_RELAY: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		pid: child.pid,
		stdout: child.stdout,
		stderr: child.stderr,
		write: data => {
			child.stdin.write(data);
			child.stdin.flush();
		},
		exited: child.exited.then(code => (child.signalCode ? null : code)),
		kill: signal => child.kill(signal),
	};
}

/** Encodes one host→extension message as a native messaging frame. */
export function encodeNativeFrame(message: FromNativeHost | ToNativeHost): Uint8Array {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const frame = new Uint8Array(4 + body.byteLength);
	new DataView(frame.buffer).setUint32(0, body.byteLength, true);
	frame.set(body, 4);
	return frame;
}

/** Incremental decoder for length-prefixed native messaging frames. */
export class NativeFrameReader {
	#buffer = new Uint8Array(0);

	/** Appends bytes and returns every message they complete. */
	push(bytes: Uint8Array): unknown[] {
		const joined = new Uint8Array(this.#buffer.byteLength + bytes.byteLength);
		joined.set(this.#buffer, 0);
		joined.set(bytes, this.#buffer.byteLength);
		const messages: unknown[] = [];
		let offset = 0;
		while (joined.byteLength - offset >= 4) {
			const length = new DataView(joined.buffer, offset, 4).getUint32(0, true);
			if (joined.byteLength - offset - 4 < length) break;
			const body = joined.subarray(offset + 4, offset + 4 + length);
			messages.push(JSON.parse(new TextDecoder().decode(body)));
			offset += 4 + length;
		}
		this.#buffer = joined.slice(offset);
		return messages;
	}
}

/**
 * Splits one rpc or relay line into the native frames that carry it: a single `t` frame when it fits under
 * {@link NATIVE_FRAME_LIMIT}, else `chunk` frames the extension concatenates in `index` order.
 */
export function lineFrames(t: "rpc" | "relay", line: string, chunkId: number): FromNativeHost[] {
	const whole: FromNativeHost = { t, line };
	if (Buffer.byteLength(JSON.stringify(whole), "utf8") <= NATIVE_FRAME_LIMIT) return [whole];
	const frames: FromNativeHost[] = [];
	let start = 0;
	while (start < line.length) {
		let end = Math.min(line.length, start + CHUNK_CHARS);
		for (;;) {
			// Never split a surrogate pair (high surrogate D800–DBFF last) across chunks.
			const last = line.charCodeAt(end - 1);
			if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--;
			const frame: FromNativeHost = {
				t: "chunk",
				id: chunkId,
				index: frames.length,
				last: end === line.length,
				data: line.slice(start, end),
			};
			if (Buffer.byteLength(JSON.stringify(frame), "utf8") <= NATIVE_FRAME_LIMIT) {
				frames.push(frame);
				break;
			}
			end = start + Math.max(1, Math.floor((end - start) / 2));
		}
		start = end;
	}
	return frames;
}

/** Expands `~` and `~/…`; an empty path means the home directory. */
export function resolveSessionCwd(cwd: string): string {
	const home = os.homedir();
	if (cwd === "" || cwd === "~") return home;
	if (cwd.startsWith("~/") || cwd.startsWith("~\\")) return path.join(home, cwd.slice(2));
	return path.resolve(cwd);
}

function isToNativeHost(value: unknown): value is ToNativeHost {
	if (typeof value !== "object" || value === null) return false;
	const t: unknown = Reflect.get(value, "t");
	if (t === "open") return typeof Reflect.get(value, "cwd") === "string";
	if (t === "link") return typeof Reflect.get(value, "extensionId") === "string";
	if (t === "rpc" || t === "relay") return typeof Reflect.get(value, "line") === "string";
	return false;
}

/**
 * Runs one host session over `io`; resolves once the chat's child exited, the extension disconnected, or a relay this
 * host leads accepted a restart.
 */
export async function serveNativeHost(io: NativeHostIo): Promise<void> {
	let disconnected = false;
	const send = (message: FromNativeHost) => {
		if (!disconnected) io.write(encodeNativeFrame(message));
	};
	const reader = io.input.getReader();
	const frames = new NativeFrameReader();
	const queued: ToNativeHost[] = [];

	/** Next extension message, or null once the port closed. */
	const next = async (): Promise<ToNativeHost | null> => {
		for (;;) {
			const message = queued.shift();
			if (message) return message;
			const { done, value } = await reader.read();
			if (done) {
				disconnected = true;
				return null;
			}
			for (const decoded of frames.push(value)) {
				if (isToNativeHost(decoded)) queued.push(decoded);
				else io.log(`ignoring malformed message ${JSON.stringify(decoded).slice(0, 200)}`);
			}
		}
	};

	const open = await next();
	if (open === null) return;
	if (open.t === "link") {
		let chunkSeq = 0;
		return serveRelayLink({
			port: io.relayPort,
			extensionId: open.extensionId,
			next,
			send,
			relayLine: line => {
				for (const frame of lineFrames("relay", line, ++chunkSeq)) send(frame);
			},
			log: io.log,
		});
	}
	if (open.t !== "open") {
		send({ t: "exit", code: null, stderr: "the first message must be open{cwd} or link{extensionId}" });
		return;
	}
	const cwd = resolveSessionCwd(open.cwd);
	const stat = await fs.stat(cwd).catch(() => null);
	if (!stat?.isDirectory()) {
		send({ t: "exit", code: null, stderr: `directory not found: ${cwd}` });
		return;
	}

	let child: RpcChild;
	try {
		child = io.spawn(cwd);
	} catch (error) {
		send({
			t: "exit",
			code: null,
			stderr: `failed to start omp: ${error instanceof Error ? error.message : String(error)}`,
		});
		return;
	}
	send({ t: "ready", pid: child.pid });
	// First on stdin, so the child answers every extension command under v2's limits: a command queued behind the
	// negotiation would get v1's 1 MiB ceiling and fail (an early `get_available_models` does).
	child.write(`${JSON.stringify({ id: NEGOTIATE_ID, type: "negotiate_protocol", protocolVersion: 2 })}\n`);

	let stderrTail = "";
	const stderrDone = (async () => {
		const decoder = new TextDecoder();
		for await (const bytes of child.stderr) {
			stderrTail = (stderrTail + decoder.decode(bytes, { stream: true })).slice(-STDERR_TAIL_BYTES);
		}
	})().catch(() => {});

	let chunkSeq = 0;
	const stdoutDone = (async () => {
		const decoder = new TextDecoder();
		let rpcFrames = new RpcFrameDecoder();
		let negotiating = true;
		let pending = "";
		const forward = (line: string) => {
			if (line.length === 0) return;
			let logical = line;
			if (line.startsWith('{"type":"rpc_chunk"')) {
				let frame: object | undefined;
				try {
					frame = rpcFrames.push(JSON.parse(line));
				} catch (error) {
					io.log(
						`dropping a broken rpc chunk sequence: ${error instanceof Error ? error.message : String(error)}`,
					);
					rpcFrames = new RpcFrameDecoder();
					return;
				}
				if (!frame) return;
				logical = JSON.stringify(frame);
			} else if (negotiating && line.includes(`"id":"${NEGOTIATE_ID}"`)) {
				negotiating = false;
				return;
			}
			const id = ++chunkSeq;
			for (const frame of lineFrames("rpc", logical, id)) send(frame);
		};
		for await (const bytes of child.stdout) {
			pending += decoder.decode(bytes, { stream: true });
			let start = 0;
			for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n", start)) {
				forward(pending.slice(start, newline));
				start = newline + 1;
			}
			pending = pending.slice(start);
		}
		forward(pending + decoder.decode());
	})().catch(error => io.log(`rpc output failed: ${error instanceof Error ? error.message : String(error)}`));

	let exited = false;
	const exit = child.exited.then(async code => {
		exited = true;
		await Promise.all([stdoutDone, stderrDone]);
		send({ t: "exit", code, stderr: stderrTail });
	});

	const inbound = (async () => {
		for (;;) {
			const message = await next();
			if (message === null) return;
			if (exited) continue;
			if (message.t !== "rpc") {
				io.log("ignoring a second open");
				continue;
			}
			try {
				child.write(`${message.line}\n`);
			} catch (error) {
				io.log(`rpc input failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	})();

	await Promise.race([exit, inbound]);
	if (exited) {
		await exit;
		await reader.cancel().catch(() => {});
		await inbound.catch(() => {});
		return;
	}
	// The extension disconnected: stop the session it owned.
	child.kill("SIGTERM");
	const timer = setTimeout(() => {
		if (!exited) child.kill("SIGKILL");
	}, KILL_GRACE_MS);
	await exit;
	clearTimeout(timer);
}
