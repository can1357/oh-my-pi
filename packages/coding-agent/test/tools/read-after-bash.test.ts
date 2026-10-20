import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentEvent,
	type AgentMessage,
	type AgentToolContext,
	agentLoop,
	type ToolCallContext,
} from "@oh-my-pi/pi-agent-core";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	LocalProtocolHandler.resetOverrideForTests();
	InternalUrlRouter.resetForTests();
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

async function tempDirectory(): Promise<string> {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "read-after-bash-")));
	temporaryDirectories.push(directory);
	return directory;
}

function createSession(directory: string): ToolSession {
	return {
		cwd: directory,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

/**
 * One assistant message: `bash`, then `read readPath`. The bash command runs
 * `change` only once the read has returned (the test creates `go` when it sees
 * the read end), so a read that does not wait for bash always sees the file
 * before the change. A read that waits never returns first; bash then stops
 * waiting after half a second.
 */
async function bashThenRead(directory: string, change: string, readPath: string, session = createSession(directory)) {
	const command = `for i in $(seq 50); do [ -e go ] && break; sleep 0.01; done; ${change}`;
	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command } },
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: readPath } },
				],
			},
			{ content: ["done"] },
		],
	});
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[{ role: "user", content: "Run the command, then read", timestamp: Date.now() }],
		{ systemPrompt: [""], messages: [], tools: [new BashTool(session), new ReadTool(session)] },
		{
			model: mock.model,
			convertToLlm: (all: AgentMessage[]) =>
				all.filter(
					message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				) as Message[],
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
		},
		undefined,
		mock.stream,
	);
	for await (const event of stream) {
		events.push(event);
		if (event.type === "tool_execution_end" && event.toolCallId === "read-1") {
			await Bun.write(path.join(directory, "go"), "");
		}
	}
	const messages = await stream.result();
	const read = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "read-1",
	);
	if (!read) throw new Error("no read result");
	const text = read.content.map(block => (block.type === "text" ? block.text : "")).join("");
	return { text, isError: read.isError, events };
}

describe("a read after a bash call in the same message", () => {
	it("returns the file as the bash command left it, the read scheduled beside bash", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "old\n");

		const { text, events } = await bashThenRead(directory, "echo new > f", "f");

		expect(text).toContain("new");
		expect(text).not.toContain("old");
		const readStart = events.findIndex(
			event => event.type === "tool_execution_start" && event.toolCallId === "read-1",
		);
		const bashEnd = events.findIndex(event => event.type === "tool_execution_end" && event.toolCallId === "bash-1");
		expect(readStart).toBeGreaterThanOrEqual(0);
		expect(readStart).toBeLessThan(bashEnd);
	});

	it("returns a file the bash command created instead of a not-found error", async () => {
		const directory = await tempDirectory();

		const { text, isError } = await bashThenRead(directory, "echo created > f", "f");

		expect(isError).toBe(false);
		expect(text).toContain("created");
	});

	it("reports a file the bash command deleted as missing", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "doomed\n");

		const { text, isError } = await bashThenRead(directory, "rm f", "f");

		expect(isError).toBe(true);
		expect(text).not.toContain("doomed");
	});

	it("reads a file:// path the bash command rewrote", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "old\n");

		const { text } = await bashThenRead(directory, "echo new > f", `file://${path.join(directory, "f")}`);

		expect(text).toContain("new");
	});

	it("reads a file found by suffix that the bash command rewrote", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "sub", "only.txt"), "old\n");

		const { text } = await bashThenRead(directory, "echo new > sub/only.txt", "only.txt");

		expect(text).toContain("new");
	});

	it("reads an archive member the bash command rewrote", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "src.txt"), "old\n");
		Bun.spawnSync(["tar", "-cf", "a.tar", "src.txt"], { cwd: directory });

		const { text } = await bashThenRead(directory, "echo new > src.txt && tar -cf a.tar src.txt", "a.tar:src.txt");

		expect(text).toContain("new");
		expect(text).not.toContain("old");
	});

	it("reads a SQLite table the bash command updated", async () => {
		const directory = await tempDirectory();
		const db = new Database(path.join(directory, "db.sqlite"));
		db.run("create table t (v text)");
		db.run("insert into t values ('old')");
		db.close();
		await Bun.write(
			path.join(directory, "update.ts"),
			`import { Database } from "bun:sqlite"; new Database("db.sqlite").run("update t set v = 'new'");`,
		);

		const { text } = await bashThenRead(directory, `"${process.execPath}" update.ts`, "db.sqlite:t");

		expect(text).toContain("new");
		expect(text).not.toContain("old");
	});

	it("lists an entry the bash command added two levels into a listed directory", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "out", "nested", "a.txt"), "a\n");

		const { text } = await bashThenRead(directory, "echo b > out/nested/b.txt", "out");

		expect(text).toContain("b.txt");
	});

	it("reads a WAL-mode SQLite table the bash command updated while another connection holds it open", async () => {
		const directory = await tempDirectory();
		const held = new Database(path.join(directory, "db.sqlite"));
		try {
			held.run("pragma journal_mode = wal");
			held.run("create table t (v text)");
			held.run("insert into t values ('old')");
			// Everything in the main file, then an open read transaction: the
			// writer's closing checkpoint cannot copy its update past this reader,
			// so the update lives only in `db.sqlite-wal`.
			held.run("pragma wal_checkpoint(truncate)");
			held.run("begin");
			held.query("select * from t").all();
			await Bun.write(
				path.join(directory, "update.ts"),
				`import { Database } from "bun:sqlite"; new Database("db.sqlite").run("update t set v = 'new'");`,
			);

			const { text } = await bashThenRead(directory, `"${process.execPath}" update.ts`, "db.sqlite:t");

			expect(text).toContain("new");
			expect(text).not.toContain("old");
		} finally {
			held.run("rollback");
			held.close();
		}
	});

	it("lists an entry the bash command added under a directory too large to fingerprint", async () => {
		const directory = await tempDirectory();
		await Promise.all(
			Array.from({ length: 2001 }, (_, i) =>
				Bun.write(path.join(directory, "big", `f${String(i).padStart(4, "0")}`), ""),
			),
		);
		await Bun.write(path.join(directory, "big", "zz", "a.txt"), "a\n");

		const { text } = await bashThenRead(directory, "echo b > big/zz/b.txt", "big");

		expect(text).toContain("b.txt");
	});

	it("reads the exact file the bash command created where a spelling fallback matched before", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "it\u2019s.txt"), "fallback\n");

		const { text } = await bashThenRead(directory, `echo exact > "it's.txt"`, "it's.txt");

		expect(text).toContain("exact");
		expect(text).not.toContain("fallback");
	});

	it("lists the session cwd for an empty path after the bash command adds an entry", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "a.txt"), "a\n");

		const { text } = await bashThenRead(directory, "echo b > added.txt", "");

		expect(text).toContain("added.txt");
	});

	it("reads a single-slash local:/ URL instead of failing on it", async () => {
		const directory = await tempDirectory();
		const artifacts = path.join(directory, "artifacts");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifacts, getSessionId: () => "s" });
		await Bun.write(path.join(artifacts, "local", "notes.md"), "notes\n");

		const { text, isError } = await bashThenRead(directory, "true", "local:/notes.md");

		expect(isError).toBe(false);
		expect(text).toContain("notes");
	});

	it("reads a local:// file the bash command rewrote", async () => {
		const directory = await tempDirectory();
		const artifacts = path.join(directory, "artifacts");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifacts, getSessionId: () => "s" });
		await Bun.write(path.join(artifacts, "local", "notes.md"), "old\n");

		const { text } = await bashThenRead(directory, "echo new > artifacts/local/notes.md", "local://notes.md");

		expect(text).toContain("new");
		expect(text).not.toContain("old");
	});

	it("fetches a URL with a `;` in its query once, without waiting for bash", async () => {
		const directory = await tempDirectory();
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				requests++;
				return new Response("page body", { headers: { "content-type": "text/plain" } });
			},
		});
		try {
			const session = {
				...createSession(directory),
				settings: Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
					"fetch.enabled": true,
				}),
				getArtifactsDir: () => path.join(directory, "artifacts"),
				allocateOutputArtifact: async (toolType: string) => ({
					id: "test",
					path: path.join(directory, "artifacts", `test.${toolType}.log`),
				}),
			} as unknown as ToolSession;

			const { text, isError, events } = await bashThenRead(
				directory,
				"true",
				`http://127.0.0.1:${server.port}/x?a=1;b=2`,
				session,
			);

			expect(isError).toBe(false);
			expect(text).toContain("page body");
			expect(requests).toBe(1);
			const readEnd = events.findIndex(
				event => event.type === "tool_execution_end" && event.toolCallId === "read-1",
			);
			const bashEnd = events.findIndex(
				event => event.type === "tool_execution_end" && event.toolCallId === "bash-1",
			);
			expect(readEnd).toBeLessThan(bashEnd);
		} finally {
			server.stop(true);
		}
	});
});

describe("a read beside an earlier writing call", () => {
	it("stops waiting for that call when the read is aborted", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "old\n");
		const controller = new AbortController();
		const { promise: neverSettles } = Promise.withResolvers<void>();
		const toolCall: ToolCallContext = {
			batchId: "b",
			index: 1,
			total: 2,
			toolCalls: [],
			earlierEffectsSettled: neverSettles,
		};

		const read = new ReadTool(createSession(directory)).execute(
			"read-1",
			{ path: "f" },
			controller.signal,
			undefined,
			{
				toolCall,
			} as AgentToolContext,
		);
		controller.abort();

		// Settles at all: a read that ignored its signal would wait for the call forever.
		const [outcome] = await Promise.allSettled([read]);
		expect(outcome.status).toBeDefined();
	});
});
