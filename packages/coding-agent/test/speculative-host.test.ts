import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SpeculativeCommitContext, SpeculativeOperationContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import { SpeculativePalCommitConflictError } from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function createSession(
	cwd: string,
	allowedRiskyOperations: string[] | null = ["direct.write", "direct.edit"],
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"images.autoResize": false,
			"inspect_image.enabled": false,
			"tools.approvalMode": "yolo",
			"tools.speculativeExecution.enabled": true,
			...(allowedRiskyOperations === null
				? {}
				: { "tools.speculativeExecution.allowedRiskyOperations": allowedRiskyOperations }),
		}),
	};
}

it("admits validated local reads without a risk-bearing operation grant", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
	temporaryDirectories.push(directory);
	await fs.writeFile(path.join(directory, "note.txt"), "content");
	const session = createSession(directory, null);
	const tool = new ReadTool(session);
	const assessment = await tool.speculation.finalized?.assess({ args: { path: "note.txt" } });
	if (!assessment?.eligible) throw new Error("expected local read assessment to succeed");
	const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

	expect(
		await host.authorize({
			candidateId: "read-disabled",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: {
				type: "toolCall",
				id: "read-disabled",
				name: "read",
				arguments: { path: "note.txt" },
			},
			args: { path: "note.txt" },
			effect: assessment.effect,
		}),
	).toMatchObject({
		allowed: true,
		deferBeforeToolCall: true,
	});
});

it("requires explicit risk opt-in before staging a write", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
	temporaryDirectories.push(directory);
	const session = createSession(directory, null);
	const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
	const target = path.join(directory, "note.txt");

	expect(
		await host.authorize({
			candidateId: "write-risk-denied",
			source: "direct",
			dependencies: [],
			tool: { name: "write" },
			toolCall: {
				type: "toolCall",
				id: "write-risk-denied",
				name: "write",
				arguments: { path: "note.txt", content: "after" },
			},
			args: { path: "note.txt", content: "after" },
			effect: {
				kind: "reversible_write",
				isolation: "pal",
				resources: [{ scheme: "file", path: target, access: "write" }],
			},
		}),
	).toEqual({
		allowed: false,
		reason: 'speculative operation "direct.write" requires explicit risk opt-in',
	});
});

it("keeps remote GET outside the supported operation set", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
	temporaryDirectories.push(directory);
	const session = createSession(directory, ["direct.get"]);
	const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

	expect(
		await host.authorize({
			candidateId: "remote-get-denied",
			source: "direct",
			dependencies: [],
			tool: { name: "fetch" },
			toolCall: {
				type: "toolCall",
				id: "remote-get-denied",
				name: "fetch",
				arguments: { url: "https://example.test/data" },
			},
			args: { url: "https://example.test/data" },
			effect: {
				kind: "remote_read",
				transport: {
					url: "https://example.test/data",
					headers: {},
					credentials: "omit",
					cache: "no-store",
					redirect: "error",
				},
				egress: [{ authority: "https://example.test", origins: [{ kind: "provider_literal" }] }],
			},
		}),
	).toEqual({
		allowed: false,
		reason: "tool and effect pair is not supported for speculative execution",
	});
});

describe("CodingAgentSpeculativeExecutionHost", () => {
	it("rejects a read candidate whose source resource changed before claim", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const stableMtime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
		await fs.utimes(target, stableMtime, stableMtime);
		const originalState = await fs.stat(target);
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const assessment = await tool.speculation.finalized?.assess({ args: { path: "note.txt" } });
		if (!assessment?.eligible) throw new Error("expected local read assessment to succeed");
		const context: SpeculativeOperationContext = {
			candidateId: "read-1",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "read-1", name: "read", arguments: { path: "note.txt" } },
			args: { path: "note.txt" },
			effect: assessment.effect,
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

		expect(await host.authorize(context)).toMatchObject({ allowed: true });
		await fs.writeFile(target, "update");
		await fs.utimes(target, originalState.atime, originalState.mtime);
		const rewrittenState = await fs.stat(target);
		expect({
			inode: rewrittenState.ino,
			mtimeMs: rewrittenState.mtimeMs,
			size: rewrittenState.size,
		}).toEqual({ inode: originalState.ino, mtimeMs: originalState.mtimeMs, size: originalState.size });
		const commit: SpeculativeCommitContext = {
			...context,
			physicalOutcome: { kind: "result", result: { content: [{ type: "text", text: "before" }] }, isError: false },
		};
		expect(await host.validate(commit)).toBe(false);
	});

	it("rejects bytes read during an ABA rewrite even after the original file is restored", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const stableMtime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
		await fs.utimes(target, stableMtime, stableMtime);
		const originalState = await fs.stat(target);
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "note.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected local read assessment to succeed");
		const context: SpeculativeOperationContext = {
			candidateId: "aba-read",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "aba-read", name: "read", arguments: args },
			args,
			effect: assessment.effect,
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

		expect(await host.authorize(context)).toMatchObject({ allowed: true });
		await fs.writeFile(target, "during");
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		await fs.writeFile(target, "before");
		await fs.utimes(target, originalState.atime, originalState.mtime);
		const restoredState = await fs.stat(target);
		expect({
			inode: restoredState.ino,
			mtimeMs: restoredState.mtimeMs,
			size: restoredState.size,
		}).toEqual({ inode: originalState.ino, mtimeMs: originalState.mtimeMs, size: originalState.size });

		expect(await host.validate({ ...context, physicalOutcome })).toBe(false);
		await policy.discard?.({ ...context, reason: "test complete" });
	});

	it("releases local-read evidence after a successful commit", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "note.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected local read assessment to succeed");
		const context: SpeculativeOperationContext = {
			candidateId: "committed-read",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "committed-read", name: "read", arguments: args },
			args,
			effect: assessment.effect,
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

		expect(await host.authorize(context)).toMatchObject({ allowed: true });
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		if (physicalOutcome.kind !== "result") throw new Error("expected speculative read result");
		const commitContext: SpeculativeCommitContext = { ...context, physicalOutcome };
		expect(await host.validate(commitContext)).toBe(true);
		expect(await host.commit(commitContext, async () => physicalOutcome.result)).toMatchObject({
			kind: "committed",
		});
		expect(await host.validate(commitContext)).toBe(false);
	});

	it("authorizes hashline edits only when every parsed target matches the staged resources", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		await Promise.all([
			fs.writeFile(path.join(directory, "first.txt"), "before\n"),
			fs.writeFile(path.join(directory, "second.txt"), "before\n"),
		]);
		const session = createSession(directory);
		const tool = new EditTool(session, "hashline");
		const input = [
			"*** Begin Patch",
			"[first.txt#ABCD]",
			"PUT 1.=1:",
			"+after",
			"[second.txt#EF01]",
			"PUT 1.=1:",
			"+after",
			"*** End Patch",
		].join("\n");
		const args = { input };
		const assessment = await tool.speculation.finalized?.assess({ args });
		if (!assessment?.eligible) throw new Error("expected hashline edit assessment to succeed");
		if (assessment.effect.kind !== "reversible_write") {
			throw new Error("expected reversible hashline edit effect");
		}
		const context: SpeculativeOperationContext = {
			candidateId: "edit-1",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "edit-1", name: "edit", arguments: args },
			args,
			effect: assessment.effect,
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

		expect(await host.authorize(context)).toMatchObject({ allowed: true, deferBeforeToolCall: true });
		expect(
			await host.authorize({
				...context,
				effect: { ...assessment.effect, resources: assessment.effect.resources.slice(1) },
			}),
		).toEqual({ allowed: false, reason: "PAL edit resources changed" });
	});

	it("preserves a concurrent source change when commit verification rejects the staged write", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const session = createSession(directory);
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const transaction = {
			verify: async () => false,
			restore: async () => fs.writeFile(target, "before"),
		};
		const context: SpeculativeCommitContext = {
			candidateId: "write-1",
			source: "direct",
			dependencies: [],
			tool: { name: "write" },
			toolCall: {
				type: "toolCall",
				id: "write-1",
				name: "write",
				arguments: { path: "note.txt", content: "speculative" },
			},
			args: { path: "note.txt", content: "speculative" },
			effect: {
				kind: "reversible_write",
				isolation: "pal",
				resources: [{ scheme: "file", path: target, access: "write" }],
			},
			physicalOutcome: { kind: "staged", token: { transaction } },
		};
		await fs.writeFile(target, "concurrent");

		const decision = await host.commit(context, async () => {
			throw new SpeculativePalCommitConflictError("source changed");
		});

		expect(decision).toEqual({
			kind: "fallback",
			reason: "speculative commit was rejected because the source changed",
			restored: false,
		});
		expect(await fs.readFile(target, "utf8")).toBe("concurrent");
	});

	it("rechecks lifecycle policy before committing a staged write", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const session = createSession(directory);
		let lifecycleActive = false;
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, {
			hasHandlers: () => lifecycleActive,
		});
		const context: SpeculativeOperationContext = {
			candidateId: "write-1",
			source: "direct",
			dependencies: [],
			tool: { name: "write" },
			toolCall: {
				type: "toolCall",
				id: "write-1",
				name: "write",
				arguments: { path: "note.txt", content: "after" },
			},
			args: { path: "note.txt", content: "after" },
			effect: {
				kind: "reversible_write",
				isolation: "pal",
				resources: [{ scheme: "file", path: target, access: "write" }],
			},
		};
		expect(await host.authorize(context)).toMatchObject({ allowed: true });
		lifecycleActive = true;
		let verified = false;

		expect(
			await host.validate({
				...context,
				physicalOutcome: {
					kind: "staged",
					token: {
						transaction: {
							verify: async () => {
								verified = true;
								return true;
							},
							restore: async () => {},
						},
					},
				},
			}),
		).toBe(false);
		expect(verified).toBe(false);
	});

	it("remains usable after one coordinator closes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const assessment = await tool.speculation.finalized?.assess({ args: { path: "note.txt" } });
		if (!assessment?.eligible) throw new Error("expected local read assessment to succeed");
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		host.close();

		expect(
			await host.authorize({
				candidateId: "read-2",
				source: "direct",
				dependencies: [],
				tool,
				toolCall: { type: "toolCall", id: "read-2", name: "read", arguments: { path: "note.txt" } },
				args: { path: "note.txt" },
				effect: assessment.effect,
			}),
		).toMatchObject({ allowed: true });
	});
});
