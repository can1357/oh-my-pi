/**
 * Contracts: history:// protocol handler (rework-contracts.md §6), resolved
 * through `InternalUrlRouter.instance().resolve(...)` like real callers.
 *
 * - Bare `history://` renders an index listing registered agent ids.
 * - `history://<id>` with a live ref renders the in-memory transcript.
 * - A parked ref (session null, sessionFile retained) renders read-only from
 *   the JSONL session file.
 * - An unknown id fails with an error listing the known ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import { HistoryProtocolHandler } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls/history-protocol";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-entries";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function fakeLiveSession(messages: unknown[]): AgentSession {
	return { messages } as unknown as AgentSession;
}

/** Minimal current-version session JSONL: header + a linear user/assistant chain. */
function sessionFixtureJsonl(): string {
	const timestamp = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "fixture-session",
		timestamp,
		cwd: "/tmp",
	};
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "parked hello", timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "parked reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

describe("history:// protocol", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("bare history:// renders an index listing registered agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Agents");
		expect(resource.content).toContain("| HubAgent | idle | sub |");
	});

	it("history://<id> renders a live ref's in-memory transcript", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://HubAgent");

		expect(resource.content).toContain("# HubAgent (idle)");
		expect(resource.content).toContain("## user");
		expect(resource.content).toContain("hello from live");
		expect(resource.notes).toContain("Source: live session");
	});

	it("resolves agent ids case-insensitively", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://hubagent");
		expect(resource.content).toContain("# HubAgent (idle)");
	});

	it("history://<id> renders a parked ref read-only from its session file", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "parked.jsonl");
			await Bun.write(sessionFile, sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Sleeper",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sleeper");

			expect(resource.content).toContain("# Sleeper (parked)");
			expect(resource.content).toContain("parked hello");
			expect(resource.content).toContain("parked reply");
			expect(resource.sourcePath).toBe(sessionFile);
			expect(resource.notes?.join("\n")).toContain("read-only");
		});
	});

	it("rejects an unknown id with the list of known agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Nope")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent: Nope");
		expect(error?.message).toContain("HubAgent");
	});

	it("rejects a ref with neither session nor session file", async () => {
		AgentRegistry.global().register({
			id: "Husk",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "aborted",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Husk")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error?.message).toContain("no transcript");
	});

	it("hides advisor transcripts from the index and direct lookup", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});

		// Index lists the subagent but never the advisor.
		const index = await InternalUrlRouter.instance().resolve("history://");
		expect(index.content).toContain("HubAgent");
		expect(index.content).not.toContain("advisor");

		// Direct lookup of an advisor-kind ref is reported as unknown — the driving
		// agent must not be able to read it via history://.
		const error = await InternalUrlRouter.instance()
			.resolve("history://AdvisorProbe")
			.then(
				() => null,
				err => err as Error,
			);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent");
	});

	it("omits advisor refs from history:// completions", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			sessionFile: "/tmp/x/__advisor.jsonl",
			status: "parked",
		});

		const completions = await new HistoryProtocolHandler().complete();
		const values = completions.map(c => c.value);
		expect(values).toContain("HubAgent");
		expect(values).not.toContain("AdvisorProbe");
	});
});
