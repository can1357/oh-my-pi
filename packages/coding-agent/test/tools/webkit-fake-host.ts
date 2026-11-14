/**
 * A fake WebKit host for browser-backend tests: an engine directory whose
 * `ABHost` is a real executable speaking the host's protocol over its
 * standard streams (`u32` LE length-prefixed JSON, hello/welcome, browser ops
 * answered by id). Like the real host its welcome lists `dom`, `console` and
 * `network`. It records the ops it received (the `scripts` lists among them),
 * its pid and whether it saw the end of its input into files beside itself.
 * The test-only op `{ op: "emit", block, events }` appends events to a
 * block's stream, as the engine would for console messages and resource loads.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

/**
 * How the fake behaves:
 * - `ok`: answers everything; exits when its input ends.
 * - `exit-on-hello`: exits with code 3 instead of welcoming.
 * - `fail-open`: answers `open` with a `failed` error.
 * - `fail-navigation`: reports a `failed` load for every `goto`.
 * - `ignore-eof`: keeps running after its input ended.
 */
export type FakeHostMode = "ok" | "exit-on-hello" | "fail-open" | "fail-navigation" | "ignore-eof";

/** A fake engine directory. */
export interface FakeHost {
	/** The engine directory. */
	dir: string;
	/** The `ABHost` executable inside it. */
	executable: string;
	/** Every browser op the host received so far, in order. */
	requests(): Promise<Array<Record<string, unknown>>>;
	/** The pid of the last host process started. */
	pid(): Promise<number>;
	/** Whether a host process saw the end of its input. */
	sawEndOfInput(): Promise<boolean>;
	remove(): Promise<void>;
}

const HOST_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const mode = process.argv[2];
const dir = __dirname;
fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
const send = message => {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	process.stdout.write(Buffer.concat([head, body]));
};
const events = new Map();
// The events call with wait each block holds, as the host does: { id, after }.
const waiting = new Map();
let nextBlock = 1;
const eventsAfter = (block, after) => {
	const list = events.get(block) ?? [];
	return { ok: { events: list.filter(event => event.seq > (after ?? 0)), next: list.length, dropped: 0 } };
};
const answerWaiting = block => {
	const held = waiting.get(block);
	if (!held) return;
	waiting.delete(block);
	send({ id: held.id, browser: eventsAfter(block, held.after) });
};
const push = (block, event) => {
	const list = events.get(block) ?? [];
	list.push({ seq: list.length + 1, ...event });
	events.set(block, list);
	answerWaiting(block);
};
function answer(op, id) {
	switch (op.op) {
		case "open": {
			if (mode === "fail-open") return { error: { kind: "failed", message: "no display to create a view on" } };
			const block = nextBlock++;
			push(block, { type: "loaded", url: "about:blank" });
			return { ok: { block, url: "about:blank" } };
		}
		case "events": {
			// A new call answers the held one with what it has.
			answerWaiting(op.block);
			const result = eventsAfter(op.block, op.after);
			if (op.wait && result.ok.events.length === 0) {
				waiting.set(op.block, { id, after: op.after });
				return null;
			}
			return result;
		}
		case "state":
			return {
				ok: { url: "about:blank", title: "", loading: false, shown: false, focused: true, width: 1280, height: 800 },
			};
		case "viewport":
			if (op.width > 16384) return { error: { kind: "invalid", message: "width is out of range" } };
			return { ok: {} };
		case "goto":
			if (mode === "fail-navigation") push(op.block, { type: "failed", message: "host not found" });
			else {
				push(op.block, { type: "committed", url: op.url });
				push(op.block, { type: "loaded", url: op.url });
			}
			return { ok: {} };
		case "eval":
			return { ok: { value: { value: [] } } };
		case "emit":
			for (const event of op.events) push(op.block, event);
			return { ok: {} };
		case "echo":
			return { ok: { echo: op.value } };
		case "missing":
			return { error: { kind: "not_found", message: "no such block" } };
		case "hang":
			return null;
		case "die":
			process.exit(7);
		default:
			return { ok: {} };
	}
}
let buffered = Buffer.alloc(0);
process.stdin.on("data", chunk => {
	buffered = Buffer.concat([buffered, chunk]);
	while (buffered.length >= 4) {
		const length = buffered.readUInt32LE(0);
		if (buffered.length < 4 + length) break;
		const message = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
		buffered = buffered.subarray(4 + length);
		if (message.hello) {
			if (mode === "exit-on-hello") process.exit(3);
			send({ welcome: { ops: ["browser", "dom", "console", "network"] } });
		} else if (message.browser) {
			fs.appendFileSync(path.join(dir, "requests.jsonl"), JSON.stringify(message.browser) + "\n");
			const result = answer(message.browser, message.id);
			if (result) send({ id: message.id, browser: result });
		}
	}
});
process.stdin.on("end", () => {
	fs.writeFileSync(path.join(dir, "eof"), "");
	if (mode !== "ignore-eof") process.exit(0);
});
if (mode === "ignore-eof") setInterval(() => {}, 1000);
`;

/** Create a fake engine directory whose host behaves as `mode` says. */
export async function createFakeHost(mode: FakeHostMode = "ok"): Promise<FakeHost> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webkit-fake-"));
	const executable = path.join(dir, "ABHost");
	const script = path.join(dir, "host.cjs");
	await Bun.write(script, HOST_SOURCE);
	await Bun.write(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${mode}\n`);
	await fs.chmod(executable, 0o755);
	const read = async (name: string): Promise<string | null> => {
		try {
			return await Bun.file(path.join(dir, name)).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	};
	return {
		dir,
		executable,
		requests: async () => Bun.JSONL.parse((await read("requests.jsonl")) ?? "") as Array<Record<string, unknown>>,
		pid: async () => Number(await read("pid")),
		sawEndOfInput: async () => (await read("eof")) !== null,
		remove: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/** Whether process `pid` still exists. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
