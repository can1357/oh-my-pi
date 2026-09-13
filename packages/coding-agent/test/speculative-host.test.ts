import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentContext,
	AgentLoopConfig,
	SpeculativeCommitContext,
	SpeculativeOperationContext,
} from "@oh-my-pi/pi-agent-core";
import { SpeculativeOperationCoordinator } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"images.autoResize": false,
			"tools.approvalMode": "yolo",
			"tools.speculativeExecution.enabled": true,
		}),
	};
}

it("admits validated local reads without a risk-bearing operation grant", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
	temporaryDirectories.push(directory);
	await fs.writeFile(path.join(directory, "note.txt"), "content");
	const session = createSession(directory);
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
	).toEqual({ allowed: true, deferBeforeToolCall: true });
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
		// Coordinator protocol order: evidence is captured pre-execution (after
		// the hook gate), so capture here before executing directly.
		expect(await host.captureEvidence(context)).toBe(true);
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		if (physicalOutcome.kind !== "result") throw new Error("expected speculative read result");
		const commitContext: SpeculativeCommitContext = { ...context, physicalOutcome };
		expect(await host.validate(commitContext)).toBe(true);
		expect(await host.commit(commitContext, async () => physicalOutcome.result)).toMatchObject({
			kind: "committed",
		});
		expect(await host.validate(commitContext)).toBe(false);
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

	it("touches no file content for reads denied by policy or lifecycle handlers", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "approved content");
		await fs.writeFile(path.join(directory, "blob.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const operationContext = (
			candidateId: string,
			target: string,
			effect: SpeculativeOperationContext["effect"],
		): SpeculativeOperationContext => ({
			candidateId,
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: candidateId, name: "read", arguments: { path: target } },
			args: { path: target },
			effect,
		});

		// Assessment is metadata-only: a missing path and an unreadable-looking
		// binary both admit provisionally, without realpath/stat/sniff. Either
		// admission failed before content inspection moved behind authorization.
		const missing = await policy.assess({ args: { path: "missing.txt" } });
		if (!missing.eligible || missing.effect.kind !== "local_read") {
			throw new Error("expected provisional admission for a missing path");
		}
		expect(missing.effect.resources[0].path).toBe(path.join(directory, "missing.txt"));
		const binary = await policy.assess({ args: { path: "blob.dat" } });
		if (!binary.eligible) throw new Error("expected provisional admission for binary content");

		// A denying lifecycle handler wins before any filesystem access: even
		// the missing path reports the handler, not an I/O failure, and the
		// binary reports the handler, not the sniff verdict.
		const denyingHost = new CodingAgentSpeculativeExecutionHost(session.settings, session, {
			hasHandlers: () => true,
		});
		await expect(
			denyingHost.authorize(operationContext("denied-missing", "missing.txt", missing.effect)),
		).resolves.toEqual({ allowed: false, reason: "active extension lifecycle handler" });
		await expect(
			denyingHost.authorize(operationContext("denied-binary", "blob.dat", binary.effect)),
		).resolves.toEqual({ allowed: false, reason: "active extension lifecycle handler" });
		// An explicit deny policy is refused the same way, before the sniff.
		const denyingPolicySession: ToolSession = {
			...session,
			settings: Settings.isolated({
				"images.autoResize": false,
				"tools.approvalMode": "yolo",
				"tools.speculativeExecution.enabled": true,
				"tools.approval": { read: "deny" },
			}),
		};
		const denyingPolicyHost = new CodingAgentSpeculativeExecutionHost(
			denyingPolicySession.settings,
			denyingPolicySession,
			{ hasHandlers: () => false },
		);
		await expect(
			denyingPolicyHost.authorize(operationContext("denied-binary", "blob.dat", binary.effect)),
		).resolves.toEqual({ allowed: false, reason: "tool approval is not auto-allow" });

		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		// Content inspection runs at pre-execution capture (after the hook gate),
		// not at authorization: the binary provisionally authorizes here and is
		// vetoed by capture instead.
		const unsafeContext = operationContext("unsafe-binary", "blob.dat", binary.effect);
		await expect(host.authorize(unsafeContext)).resolves.toEqual({ allowed: true, deferBeforeToolCall: true });
		await expect(host.captureEvidence(unsafeContext)).resolves.toBe(false);
		// While an approved identical read still speculates and commits.
		const approved = await policy.assess({ args: { path: "note.txt" } });
		if (!approved.eligible) throw new Error("expected local read assessment to succeed");
		const context = operationContext("approved-read", "note.txt", approved.effect);
		await expect(host.authorize(context)).resolves.toEqual({ allowed: true, deferBeforeToolCall: true });
		expect(await host.captureEvidence(context)).toBe(true);
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		if (physicalOutcome.kind !== "result") throw new Error("expected speculative read result");
		expect(await host.validate({ ...context, physicalOutcome })).toBe(true);
		await expect(
			host.commit({ ...context, physicalOutcome }, async () => physicalOutcome.result),
		).resolves.toMatchObject({ kind: "committed" });
	});

	it("reads no file content while authorizing", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "authorized content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const assessment = await policy.assess({ args: { path: "note.txt" } });
		if (!assessment.eligible || assessment.effect.kind !== "local_read") {
			throw new Error("expected provisional admission for note.txt");
		}
		// Content evidence moved to the pre-execution capture (after the hook
		// gate): authorization must resolve without opening the file, so a call
		// that `beforeToolCall` later blocks never triggers content I/O.
		const spy = spyOn(fs, "readFile");
		try {
			const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, {
				hasHandlers: () => false,
			});
			await expect(
				host.authorize({
					candidateId: "no-content-read",
					source: "direct",
					dependencies: [],
					tool,
					toolCall: { type: "toolCall", id: "no-content-read", name: "read", arguments: { path: "note.txt" } },
					args: { path: "note.txt" },
					effect: assessment.effect,
				}),
			).resolves.toEqual({ allowed: true, deferBeforeToolCall: true });
			expect(spy).toHaveBeenCalledTimes(0);
		} finally {
			spy.mockRestore();
		}
	});

	it("starts no speculative read before the beforeToolCall gate releases it", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "hook-gated content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		// Observe coordinator-started execution without changing what it runs.
		const speculativeExecutions: string[] = [];
		const recordingExecute: typeof policy.execute = async (context, signal) => {
			const target = context.args.path;
			speculativeExecutions.push(typeof target === "string" ? target : "<unknown>");
			return policy.execute(context, signal);
		};
		const observedTool = Object.create(tool, {
			speculation: { value: { finalized: { ...policy, execute: recordingExecute } } },
		}) as ReadTool;
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [observedTool] };
		const loopConfig: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: messages =>
				messages.filter(
					message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				) as Message[],
			beforeToolCall: async () => ({ block: true, reason: "denied by test hook" }),
		};
		const coordinator = new SpeculativeOperationCoordinator({ enabled: true, host }, { context, loopConfig });
		const toolCall = {
			type: "toolCall" as const,
			id: "hook-gated-read",
			name: "read",
			arguments: { path: "note.txt" },
		};
		coordinator.admitFinalized(context, toolCall, loopConfig, undefined);
		await coordinator.settleAdmissions();
		// Admission ran (and the host authorized), but the `beforeToolCall`
		// gate inside `prepareToolCallDispatch()` has not run yet: with
		// deferral the speculative read must not have started. Without the
		// defer flag the coordinator drains immediately and this already
		// holds the read target.
		expect(speculativeExecutions).toEqual([]);
		// The loop omits hook-blocked calls from final reconciliation, then
		// releases survivors. A discarded candidate must never execute.
		await coordinator.reconcileFinalCalls(new Map());
		await coordinator.finalizeAdmissions();
		expect(speculativeExecutions).toEqual([]);
		await coordinator.close("test complete");
	});

	it("runs and commits the deferred read when the beforeToolCall gate allows it", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "hook-allowed content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const speculativeExecutions: string[] = [];
		const orderedEvents: string[] = [];
		const recordingExecute: typeof policy.execute = async (context, signal) => {
			const target = context.args.path;
			speculativeExecutions.push(typeof target === "string" ? target : "<unknown>");
			orderedEvents.push("execute");
			return policy.execute(context, signal);
		};
		const observedTool = Object.create(tool, {
			speculation: { value: { finalized: { ...policy, execute: recordingExecute } } },
		}) as ReadTool;
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const captureEvidence = host.captureEvidence.bind(host);
		host.captureEvidence = async context => {
			orderedEvents.push("capture");
			return captureEvidence(context);
		};
		const tools: NonNullable<AgentContext["tools"]> = [observedTool];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools };
		const loopConfig: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: messages =>
				messages.filter(
					message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				) as Message[],
			beforeToolCall: async () => undefined,
		};
		const coordinator = new SpeculativeOperationCoordinator({ enabled: true, host }, { context, loopConfig });
		const toolCall = {
			type: "toolCall" as const,
			id: "hook-allowed-read",
			name: "read",
			arguments: { path: "note.txt" },
		};
		coordinator.admitFinalized(context, toolCall, loopConfig, undefined);
		await coordinator.settleAdmissions();
		expect(speculativeExecutions).toEqual([]);
		// The hook allowed the unchanged call: reconciliation keeps it,
		// finalizing releases the deferred read, and the claim commits it.
		await coordinator.reconcileFinalCalls(new Map([[toolCall.id, { ...toolCall }]]));
		await coordinator.finalizeAdmissions();
		const executionArgs = coordinator.directExecutionArgsFor(toolCall.id, toolCall.arguments);
		if (!executionArgs) throw new Error("expected admission execution args for the allowed call");
		// The loop holds tools as `AgentTool<any>`; claim through the same
		// view (matching `executeToolCalls`) so `execute` variance agrees.
		const outcome = await coordinator.claim(tools[0], toolCall, executionArgs);
		expect(speculativeExecutions).toEqual(["note.txt"]);
		// The coordinator captures evidence strictly before executing: a
		// coordinator regression that stops calling the hook would surface here
		// (execution without a preceding capture), not just at validate time.
		expect(orderedEvents).toEqual(["capture", "execute"]);
		if (!outcome) throw new Error("expected the deferred read to commit");
		const text = outcome.result.content.find(entry => entry.type === "text")?.text ?? "";
		expect(text).toContain("hook-allowed content");
		await coordinator.close("test complete");
	});

	it("refuses a speculative read whose symlink target changed after authorization", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-outside-"));
		temporaryDirectories.push(outside);
		await fs.writeFile(path.join(directory, "real.txt"), "inside content");
		await fs.writeFile(path.join(outside, "secret.txt"), "outside secret");
		await fs.symlink(path.join(directory, "real.txt"), path.join(directory, "link.txt"));
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const assessment = await policy.assess({ args: { path: "link.txt" } });
		if (!assessment.eligible || assessment.effect.kind !== "local_read") {
			throw new Error("expected provisional admission for the link path");
		}
		const context: SpeculativeOperationContext = {
			candidateId: "swapped-link",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "swapped-link", name: "read", arguments: { path: "link.txt" } },
			args: { path: "link.txt" },
			effect: assessment.effect,
		};
		await expect(host.authorize(context)).resolves.toMatchObject({ allowed: true });
		// Repoint the link outside the workspace between authorization and execution.
		await fs.unlink(path.join(directory, "link.txt"));
		await fs.symlink(path.join(outside, "secret.txt"), path.join(directory, "link.txt"));
		// The pre-execution capture (which runs after the hook gate) sees the
		// swapped target and vetoes before anything executes — and the execution
		// layer independently refuses the escaped target.
		await expect(host.captureEvidence(context)).resolves.toBe(false);
		await expect(policy.execute(context, new AbortController().signal)).rejects.toThrow(
			"Speculative read target is unavailable",
		);
	});

	it("vetoes a commit when the symlink target changed after execution", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "a.txt"), "content A");
		await fs.writeFile(path.join(directory, "b.txt"), "content B");
		await fs.symlink(path.join(directory, "a.txt"), path.join(directory, "link.txt"));
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const assessment = await policy.assess({ args: { path: "link.txt" } });
		if (!assessment.eligible || assessment.effect.kind !== "local_read") {
			throw new Error("expected provisional admission for the link path");
		}
		const context: SpeculativeOperationContext = {
			candidateId: "reswapped-link",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "reswapped-link", name: "read", arguments: { path: "link.txt" } },
			args: { path: "link.txt" },
			effect: assessment.effect,
		};
		await expect(host.authorize(context)).resolves.toMatchObject({ allowed: true });
		expect(await host.captureEvidence(context)).toBe(true);
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		if (physicalOutcome.kind !== "result") throw new Error("expected speculative read result");
		// Swap to another safe in-workspace file after execution: re-authorization
		// passes its gates, but the commit must still fail — the captured result
		// is for bytes authoritative dispatch would never read.
		await fs.unlink(path.join(directory, "link.txt"));
		await fs.symlink(path.join(directory, "b.txt"), path.join(directory, "link.txt"));
		expect(await host.validate({ ...context, physicalOutcome })).toBe(false);
	});
});
