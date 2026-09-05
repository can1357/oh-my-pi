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
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	formatCurrentBranchFullHistory,
	HistoryProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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

function makeToolSession(
	cwd: string,
	sessionFile: string = path.join(cwd, "session.jsonl"),
	overrides: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async toolType => ({
			id: "history-read",
			path: path.join(cwd, "artifacts", `history-read.${toolType}.log`),
		}),
		settings: Settings.isolated(),
		...overrides,
	};
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

function currentBranchFixture(): SessionEntry[] {
	const timestamp = new Date().toISOString();
	return [
		{
			type: "message",
			id: "before-first-compaction",
			parentId: null,
			timestamp,
			message: { role: "user", content: "oldest raw request survives", timestamp: 1 },
		},
		{
			type: "compaction",
			id: "first-compaction",
			parentId: "before-first-compaction",
			timestamp,
			summary: "first compacted window",
			firstKeptEntryId: "between-compactions",
			tokensBefore: 100,
		},
		{
			type: "message",
			id: "between-compactions",
			parentId: "first-compaction",
			timestamp,
			message: { role: "user", content: "middle raw request survives", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "second-compaction",
			parentId: "between-compactions",
			timestamp,
			summary: "second compacted window",
			firstKeptEntryId: "latest-entry",
			tokensBefore: 200,
		},
		{
			type: "reset_boundary",
			id: "window-reset",
			parentId: "second-compaction",
			timestamp,
		},
		{
			type: "message",
			id: "latest-entry",
			parentId: "window-reset",
			timestamp,
			message: { role: "user", content: "latest raw request survives", timestamp: 3 },
		},
	] as unknown as SessionEntry[];
}

describe("history:// protocol", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
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

	it("preserves the existing bare history://current named-agent route", async () => {
		AgentRegistry.global().register({
			id: "current",
			displayName: "named current",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "named current transcript", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://current");

		expect(resource.content).toContain("named current transcript");
	});

	it("renders full execution output and metadata in current-branch history", () => {
		const content = formatCurrentBranchFullHistory([
			{
				type: "message",
				id: "bash-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "bashExecution",
					command: "git status",
					output: "working tree clean",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "python-entry",
				parentId: "bash-entry",
				timestamp: new Date().toISOString(),
				message: {
					role: "pythonExecution",
					code: "print('ok')",
					output: "ok",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 2,
				},
			},
		] as unknown as SessionEntry[]);

		expect(content).toContain("working tree clean");
		expect(content).toContain('"truncated": false');
		expect(content).toContain("print('ok')");
		expect(content).toContain("Output:");
	});

	it("renders the caller-bound branch's full pre-compaction transcript without a disk source", async () => {
		const branch = currentBranchFixture();
		const siblingOnly = "sibling branch text must not leak";
		const resource = await InternalUrlRouter.instance().resolve("history://current/full", {
			experimentalContextManagement: true,
			getSessionBranch: () => branch,
		});

		expect(resource.content).toContain("oldest raw request survives");
		expect(resource.content).toContain("middle raw request survives");
		expect(resource.content).toContain("latest raw request survives");
		expect(resource.content).toContain("Entry first-compaction · compaction");
		expect(resource.content).toContain("Entry window-reset · reset_boundary");
		expect(resource.content).not.toContain(siblingOnly);
		expect(resource.sourcePath).toBeUndefined();
	});

	it("rejects current/full when disabled or without a caller-bound branch", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("history://current/full", {
				experimentalContextManagement: false,
				getSessionBranch: currentBranchFixture,
			}),
		).rejects.toThrow("experimentalContextManagement");
		await expect(
			InternalUrlRouter.instance().resolve("history://current/full", {
				experimentalContextManagement: true,
			}),
		).rejects.toThrow("bound live session branch");
	});

	it("rejects malformed current history routes without consulting agent history", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("history://current/full?unexpected=true", {
				experimentalContextManagement: true,
				getSessionBranch: currentBranchFixture,
			}),
		).rejects.toThrow("Invalid history://current route");
		await expect(
			InternalUrlRouter.instance().resolve("history://current/extra", {
				experimentalContextManagement: true,
				getSessionBranch: currentBranchFixture,
			}),
		).rejects.toThrow("Invalid history://current route");
	});

	it("read applies selectors to caller-bound full history", async () => {
		const settings = Settings.isolated();
		settings.set("compaction.experimentalContextManagement", true);
		const branch = currentBranchFixture();
		const manager = {
			getBranch: () => branch,
			getSessionId: () => "current-session",
		} as unknown as NonNullable<ToolSession["sessionManager"]>;
		const tool = new ReadTool(
			makeToolSession(os.tmpdir(), undefined, {
				settings,
				getSessionId: () => "current-session",
				sessionManager: manager,
			}),
		);

		const result = await tool.execute("current-history-range", { path: "history://current/full:1-1" });
		const output = result.content.find(content => content.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("# Current branch — full history");
		expect(output.text).not.toContain("oldest raw request survives");
	});

	it("read applies line selectors to history transcripts", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});
		const tool = new ReadTool(makeToolSession(os.tmpdir()));

		const result = await tool.execute("history-range", { path: "history://HubAgent:1-1" });
		const output = result.content.find(content => content.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("# HubAgent (idle)");
		expect(output.text).not.toContain("hello from live");
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

	it("history://<id> serves an unregistered subagent's transcript from disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			// Only Main is registered; Sub1 exists solely on disk.
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sub1");
			expect(resource.content).toContain("# Sub1 (on disk)");
			expect(resource.content).toContain("parked hello");
			expect(resource.sourcePath).toBe(path.join(artifactsDir, "Sub1.jsonl"));
			expect(resource.notes?.join("\n")).toContain("unregistered");
		});
	});

	it("resolves an on-disk-only transcript case-insensitively", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "AuthLoader.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://authloader");
			expect(resource.content).toContain("# AuthLoader (on disk)");
		});
	});

	it("bare history:// and completions include on-disk agents but never advisor transcripts", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			await Bun.write(path.join(artifactsDir, "__advisor.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const index = await InternalUrlRouter.instance().resolve("history://");
			expect(index.content).toContain("| Sub1 | on disk |");
			expect(index.content).not.toContain("__advisor");

			const completions = await new HistoryProtocolHandler().complete();
			const values = completions.map(c => c.value);
			expect(values).toContain("Sub1");
			expect(values).not.toContain("__advisor");
		});
	});

	it("resolves a nested child transcript one level deeper on disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			const childDir = path.join(artifactsDir, "Parent");
			await fs.mkdir(childDir, { recursive: true });
			await Bun.write(path.join(childDir, "Parent.Child.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Parent.Child");
			expect(resource.content).toContain("# Parent.Child (on disk)");
		});
	});

	it("skips a registered artifact candidate that is a file", async () => {
		await withTempDir(async dir => {
			const candidate = path.join(dir, "not-a-directory");
			await Bun.write(candidate, "not a directory");
			registerArtifactsDir(candidate);

			await expect(new HistoryProtocolHandler().complete()).resolves.toEqual([]);
		});
	});

	it("read history:// refreshes the caller root before resolving a shared parked id", async () => {
		await withTempDir(async dir => {
			const rootA = path.join(dir, "a", "main.jsonl");
			const rootB = path.join(dir, "b", "main.jsonl");
			const childA = path.join(dir, "a", "main", "Worker.jsonl");
			const childB = path.join(dir, "b", "main", "Worker.jsonl");
			const header = (id: string) =>
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id,
					timestamp: new Date().toISOString(),
					cwd: "/tmp",
				});
			const transcript = (secret: string) =>
				`${header(`fixture-${secret}`)}\n${JSON.stringify({
					type: "message",
					id: `m-${secret}`,
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: `hello from root ${secret}`, timestamp: 1 },
				})}\n`;
			await Bun.write(rootA, `${header("a")}\n`);
			await Bun.write(rootB, `${header("b")}\n`);
			await Bun.write(childA, transcript("A"));
			await Bun.write(childB, transcript("B"));
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: null,
				sessionFile: rootA,
				status: "running",
			});
			// B's scan ran first: the process-global Worker ref targets B's file.
			AgentRegistry.global().register({
				id: "Worker",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile: childB,
				status: "parked",
			});

			// The read threads the caller session file into the resolver, which
			// refreshes the caller root and replaces the stale parked ref.
			const tool = new ReadTool(makeToolSession(dir, rootA));
			const result = await tool.execute("history-root-a", { path: "history://Worker" });
			const output = result.content.find(part => part.type === "text");
			expect(output?.type).toBe("text");
			if (output?.type !== "text") throw new Error("Expected text output");
			expect(output.text).toContain("hello from root A");
			expect(output.text).not.toContain("hello from root B");
			expect(AgentRegistry.global().get("Worker")?.sessionFile).toBe(childA);
		});
	});
});
