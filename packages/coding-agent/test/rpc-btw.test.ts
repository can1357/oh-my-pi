import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { isRecord, removeWithRetries } from "@oh-my-pi/pi-utils";

/** Settle a request before `expect` sees it (see rpc-goal.test.ts). */
async function rejectionOf(request: Promise<unknown>): Promise<Error> {
	return await request.then(
		() => new Error("expected the request to fail"),
		(error: unknown) => error as Error,
	);
}

describe("RPC /btw", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (directory) await removeWithRetries(directory);
		directory = undefined;
	});

	async function start() {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-btw-"));
		const rpc = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "btw-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		client = rpc;
		const deltas: string[] = [];
		const records: BtwHistoryRecord[] = [];
		const waiters: Array<() => void> = [];
		const wake = () => {
			for (const resolve of waiters.splice(0)) resolve();
		};
		rpc.onBtwDelta(frame => {
			deltas.push(frame.delta);
			wake();
		});
		rpc.onBtwRecord(record => {
			records.push(record);
			wake();
		});
		rpc.onSessionEvent(wake);
		/** Resolves once `ready` returns a value; re-checked after every btw frame and session event. */
		const until = async <T>(ready: () => T | undefined): Promise<T> => {
			for (;;) {
				const value = ready();
				if (value !== undefined) return value;
				const { promise, resolve } = Promise.withResolvers<void>();
				waiters.push(resolve);
				await promise;
			}
		};
		/** Consumes the first `btw_record` frame for `id` whose latest turn left `running`. */
		const settled = async (id: string): Promise<BtwHistoryRecord> => {
			const done = await until(() =>
				records.find(record => record.id === id && (record.followUps?.at(-1) ?? record).status !== "running"),
			);
			records.splice(records.indexOf(done), 1);
			return done;
		};
		await rpc.start();
		return { rpc, deltas, until, settled };
	}

	test("streams a side answer into history without touching the transcript", async () => {
		const { rpc, deltas, settled } = await start();
		const started = await rpc.btw("  what is 2+2?  ");
		expect(started).toMatchObject({ question: "what is 2+2?", status: "running", answer: "" });

		const done = await settled(started.id);
		expect(done).toMatchObject({ status: "complete", answer: "Answer with 0 context messages." });
		expect(deltas.join("")).toBe("Answer with 0 context messages.");

		expect(await rpc.getBtwHistory()).toEqual([done]);
		expect((await rpc.getState()).messageCount).toBe(0);
	}, 30_000);

	test("a follow-up replays the topic's earlier turn as context", async () => {
		const { rpc, settled } = await start();
		const first = await rpc.btw("first");
		await settled(first.id);

		const followUp = await rpc.btw("second", first.id);
		expect(followUp.id).toBe(first.id);
		const done = await settled(first.id);
		expect(done.followUps).toHaveLength(1);
		expect(done.followUps![0]).toMatchObject({
			question: "second",
			status: "complete",
			answer: "Answer with 2 context messages.",
		});
		expect(await rpc.getBtwHistory()).toHaveLength(1);
	}, 30_000);

	test("one side question runs at a time and can be cancelled", async () => {
		const { rpc, deltas, until, settled } = await start();
		const slow = await rpc.btw("slow one");
		await until(() => deltas[0]);
		expect((await rejectionOf(rpc.btw("another"))).message).toContain("still running");
		// The live partial answer is visible to a late reader.
		expect((await rpc.getBtwHistory())[0]).toMatchObject({ status: "running", answer: "Thinking" });

		expect(await rpc.cancelBtw("some-other-id")).toBe(false);
		expect(await rpc.cancelBtw(slow.id)).toBe(true);
		expect(await settled(slow.id)).toMatchObject({ status: "cancelled", answer: "Thinking" });
		expect(await rpc.cancelBtw()).toBe(false);
		// The turn was really aborted, and its late chunk never reached the host.
		expect(await Bun.file(path.join(directory!, "btw-aborted")).exists()).toBe(true);
		expect(deltas).toEqual(["Thinking"]);

		// The slot is free again; a cancelled topic accepts follow-ups.
		await rpc.btw("follow after cancel", slow.id);
		expect((await settled(slow.id)).followUps?.[0]?.status).toBe("complete");
	}, 30_000);

	test("a failed turn is recorded with its error", async () => {
		const { rpc, settled } = await start();
		const failing = await rpc.btw("please fail");
		expect(await settled(failing.id)).toMatchObject({ status: "error", error: "provider exploded" });
		expect((await rpc.getBtwHistory())[0]?.status).toBe("error");
	}, 30_000);

	test("rejects blank questions and unknown topics", async () => {
		const { rpc } = await start();
		expect((await rejectionOf(rpc.btw("   "))).message).toContain("question");
		expect((await rejectionOf(rpc.btw("hi", "missing"))).message).toContain("missing");
	}, 30_000);

	test("a session change cancels the running question; history stays with its session", async () => {
		const { rpc, deltas, until, settled } = await start();
		const original = (await rpc.getState()).sessionFile!;
		const slow = await rpc.btw("slow before switching");
		await until(() => deltas[0]);

		expect((await rpc.newSession()).cancelled).toBe(false);
		expect(await settled(slow.id)).toMatchObject({ status: "cancelled" });
		expect(await rpc.getBtwHistory()).toEqual([]);

		expect((await rpc.switchSession(original)).cancelled).toBe(false);
		const history = await rpc.getBtwHistory();
		expect(history.map(record => [record.id, record.status])).toEqual([[slow.id, "cancelled"]]);
	}, 30_000);

	test("runs beside a streaming main turn", async () => {
		const { rpc, settled } = await start();
		await rpc.prompt("slow main turn");
		const side = await rpc.btw("quick side question");
		expect(await settled(side.id)).toMatchObject({ status: "complete" });
		expect((await rpc.getState()).isStreaming).toBe(true);
	}, 30_000);

	test("a checkpoint that fails after the response is reported, and blocks session changes until saved", async () => {
		const { rpc, deltas, until, settled } = await start();
		const notices: string[] = [];
		rpc.onSessionEvent(event => {
			if (event.type === "notice" && event.source === "btw-history") notices.push(event.message);
		});
		const sessionFile = (await rpc.getState()).sessionFile!;
		const slow = await rpc.btw("slow, then unsavable");
		await until(() => deltas[0]);
		const entry = path.join(sessionFile.replace(/\.jsonl$/, ""), "btw-history", `entry-${slow.id}.json`);
		const running = await fs.readFile(entry);
		await fs.rm(entry);
		await fs.mkdir(entry);
		expect(await rpc.cancelBtw()).toBe(true);
		await settled(slow.id);
		await until(() => notices[0]);
		expect(notices[0]).toContain("Could not save /btw history");

		// The answer is not on disk yet: the session must not move away from it.
		expect((await rejectionOf(rpc.newSession())).message).toContain("/btw history could not be saved");
		expect((await rpc.getState()).sessionFile).toBe(sessionFile);
		expect((await rpc.getBtwHistory())[0]).toMatchObject({ status: "cancelled", answer: "Thinking" });

		// Storage recovers: the move retries the checkpoint, then proceeds.
		await fs.rm(entry, { recursive: true });
		await fs.writeFile(entry, running);
		expect((await rpc.newSession()).cancelled).toBe(false);
		expect(await Bun.file(entry).json()).toMatchObject({ status: "cancelled", answer: "Thinking" });
	}, 30_000);

	test("over raw stdio: the response precedes the turn's frames, and EOF saves a running question", async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-btw-"));
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "btw-rpc-agent.ts")], {
			cwd: directory,
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		const frames: unknown[] = [];
		/** The value at `keys` inside a parsed frame, or `undefined` when the shape differs. */
		const at = (value: unknown, ...keys: string[]): unknown =>
			keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
		let waiter: (() => void) | undefined;
		const wake = () => waiter?.();
		const reading = (async () => {
			let buffer = "";
			for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					frames.push(JSON.parse(buffer.slice(0, newline)));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
				wake();
			}
			wake();
		})();
		const frame = async (match: (frame: unknown) => boolean) => {
			for (;;) {
				const index = frames.findIndex(match);
				if (index !== -1) return index;
				const { promise, resolve } = Promise.withResolvers<void>();
				waiter = resolve;
				await promise;
			}
		};
		const send = (command: object) => {
			child.stdin.write(`${JSON.stringify(command)}\n`);
			child.stdin.flush();
		};

		send({ id: "fail", type: "btw", question: "please fail" });
		const failed = await frame(f => at(f, "type") === "btw_record" && at(f, "record", "status") === "error");
		expect(await frame(f => at(f, "type") === "response" && at(f, "id") === "fail")).toBeLessThan(failed);

		send({ id: "state", type: "get_state" });
		const state = frames[await frame(f => at(f, "type") === "response" && at(f, "id") === "state")];
		send({ id: "slow", type: "btw", question: "slow at shutdown" });
		const started = frames[await frame(f => at(f, "type") === "response" && at(f, "id") === "slow")];
		await frame(f => at(f, "type") === "btw_delta");
		child.stdin.end();
		await child.exited;
		await reading;
		const entry = path.join(
			String(at(state, "data", "sessionFile")).replace(/\.jsonl$/, ""),
			"btw-history",
			`entry-${String(at(started, "data", "record", "id"))}.json`,
		);
		expect(await Bun.file(entry).json()).toMatchObject({ status: "cancelled", answer: "Thinking" });
	}, 30_000);
});
