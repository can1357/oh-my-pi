import { type } from "@oh-my-pi/omptype";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Judge, JudgmentRequest, NoulAnswer } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { cfgTtsrGateTimeoutMs } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TtsrCoordinator } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { type GuardJudge, ToolGuard } from "@oh-my-pi/pi-coding-agent/tools/tool-guard";
import { resolveToolCommand, type ToolCommandState } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { assistant, fakeJudge, judgedRule, setup } from "./helpers/ttsr-judged-rules";

const DELETES = "Does the command delete files outside the project?";

function gateRule(name: string, fields: Partial<Rule>): Rule {
	return judgedRule(name, { gate: "before", question: DELETES, scope: ["tool:bash"], ...fields });
}

const bash = {
	name: "bash",
	label: "bash",
	description: "bash tool",
	parameters: {} as never,
	approval: "exec",
	execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
} as AgentTool;

const RM = { command: "rm -rf /srv/data" };

const stuckJudge: Judge = { label: "stuck", judge: () => Promise.withResolvers<never>().promise };
const failingJudge: Judge = {
	label: "failing",
	judge: async () => {
		throw new Error("judge unavailable");
	},
};

/** Judge answering every question yes when the judged content contains `needle`, else no. */
function contentJudge(needle: string): Judge {
	return {
		label: "content",
		judge: async (request: JudgmentRequest) => {
			const { content } = request.state as { content: string };
			const answers: Record<string, NoulAnswer> = {};
			for (const id in request.questions) answers[id] = { type: "noul", noul: content.includes(needle) ? 1 : 0 };
			return { api: "fake", provider: "fake", model: "fake", answers, usage: {} };
		},
	} as unknown as Judge;
}

function applyPatchTool(): AgentTool {
	return new EditTool(
		{ cwd: "/work", settings: Settings.isolated() } as unknown as ToolSession,
		"apply_patch",
	) as AgentTool;
}

/** An apply_patch call adding a line to `src/a.ts`, then the given envelope sections. */
function patchAddingLineAnd(...sections: string[]) {
	return {
		input: ["*** Begin Patch", "*** Update File: src/a.ts", "@@", "+// x", ...sections, "*** End Patch"].join("\n"),
	};
}

function guardOver(coordinator: TtsrCoordinator, settings: Settings, stops: string[] = []): ToolGuard {
	const messages: AgentMessage[] = [{ role: "user", content: "Clean up.", timestamp: Date.now() } as AgentMessage];
	return new ToolGuard({
		settings,
		cwd: () => "/work",
		messages: () => messages,
		judge: () => ({}) as GuardJudge,
		stop: reason => {
			stops.push(reason);
		},
		gate: (call, signal) => coordinator.gateToolCall(call, signal),
	});
}

describe("TTSR gate rules", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("[gate-01] refuses a matching call the judge flags, before it runs, quoting the rule", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.9 });
		const { coordinator } = setup([gateRule("no-rm", {})], judge, Settings.isolated());

		const { refusal } = await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" });

		expect(refusal).toContain("no-rm guidance");
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0].state)).toContain("rm -rf /srv/data");
	});

	it("[gate-02] runs a call the judge answers below the threshold, reporting the gate covered it", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.69 });
		const { coordinator } = setup([gateRule("no-rm", {})], judge, Settings.isolated());

		expect(await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).toEqual({ covered: true });
		expect(requests).toHaveLength(1);
	});

	it("[gate-03] bounds a judge that never answers by ttsr.gateTimeoutMs, then applies onJudgeError", async () => {
		const settings = Settings.isolated({ "ttsr.gateTimeoutMs": 50 });
		const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], stuckJudge, settings);
		const allowing = setup([gateRule("no-rm", {})], stuckJudge, settings);

		const started = Date.now();
		const { refusal } = await blocking.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" });
		const { refusal: allowed } = await allowing.coordinator.gateToolCall({
			tool: bash,
			args: RM,
			toolCallId: "call-2",
		});

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(refusal).toContain("no-rm guidance");
		expect(allowed).toBeUndefined();
	});

	it("[gate-23] waits the default when the operator's ttsr.gateTimeoutMs is out of range", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.9 });
		const { coordinator } = setup([gateRule("no-rm", {})], judge, Settings.isolated());
		// A project value can hide an invalid operator value from load-time validation.
		vi.spyOn(cfgTtsrGateTimeoutMs, "get").mockReturnValue(-5);

		const { refusal } = await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" });

		expect(refusal).toContain("no-rm guidance");
		expect(requests).toHaveLength(1);
	});

	it("[gate-04] a failing judge refuses under onJudgeError block and runs the call by default", async () => {
		const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], failingJudge, Settings.isolated());
		const allowing = setup([gateRule("no-rm", {})], failingJudge, Settings.isolated());

		expect(
			(await blocking.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).refusal,
		).toContain("no-rm guidance");
		expect(
			(await allowing.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-2" })).refusal,
		).toBeUndefined();
	});

	it("[gate-05] with judged rules off, onJudgeError block refuses and allow runs", async () => {
		const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], undefined, Settings.isolated());
		const allowing = setup([gateRule("no-rm", { onJudgeError: "allow" })], undefined, Settings.isolated());

		expect(
			(await blocking.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).refusal,
		).toContain("no-rm guidance");
		expect(
			(await allowing.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-2" })).refusal,
		).toBeUndefined();
	});

	it("[gate-08] never judges a gate rule after the output completes", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 1 });
		const { coordinator, warnings } = setup([gateRule("no-rm", { scope: undefined })], judge, Settings.isolated());

		coordinator.onAssistantMessageEnd(
			assistant([
				{ type: "text", text: "Clearing the data." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: RM },
			]),
		);
		await coordinator.settleJudgments();

		expect(requests).toHaveLength(0);
		expect(warnings).toHaveLength(0);
	});

	it("[gate-09] judges and refuses every identical call, whatever the repeat mode", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.9 });
		const { coordinator } = setup([gateRule("no-rm", { repeatMode: "once" })], judge, Settings.isolated());

		expect((await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).refusal).toContain(
			"no-rm guidance",
		);
		expect((await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-2" })).refusal).toContain(
			"no-rm guidance",
		);
		expect(requests).toHaveLength(2);
	});

	it("[gate-10] registers gates only with a question, for tool calls only", async () => {
		const manager = new TtsrManager({});
		const tool = { source: "tool" as const, toolName: "bash" };

		expect(manager.addRule(gateRule("no-question", { question: undefined, condition: ["rm"] }))).toBe(false);

		expect(manager.addRule(gateRule("texty", { scope: ["text", "tool:bash"] }))).toBe(true);
		expect((await manager.gateCandidates("rm", tool)).map(candidate => candidate.rule.name)).toEqual(["texty"]);
		expect(await manager.gateCandidates("rm", { source: "text" })).toEqual([]);

		const bare = new TtsrManager({});
		expect(bare.addRule(gateRule("bare", { scope: undefined }))).toBe(true);
		expect((await bare.gateCandidates("rm", tool)).map(candidate => candidate.rule.name)).toEqual(["bare"]);
		expect(await bare.gateCandidates("rm", { source: "text" })).toEqual([]);
		expect(bare.hasJudgedRules()).toBe(false);
	});

	it("[gate-11] keeps gate behaviour across replaceRules", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.9 });
		const { coordinator, manager } = setup([], judge, Settings.isolated());

		expect(manager.replaceRules([gateRule("no-rm", {})])).toEqual(new Set(["no-rm"]));
		coordinator.onAssistantMessageEnd(assistant([{ type: "toolCall", id: "call-0", name: "bash", arguments: RM }]));
		await coordinator.settleJudgments();
		expect(requests).toHaveLength(0);

		expect((await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).refusal).toContain(
			"no-rm guidance",
		);
		expect(requests).toHaveLength(1);
	});

	it("[gate-13] reports each refusal as ttsr_triggered and stops the run after three in a row", async () => {
		const { judge } = fakeJudge({ [DELETES]: 0.9 });
		const settings = Settings.isolated();
		const { coordinator, events } = setup([gateRule("no-rm", {})], judge, settings);
		const stops: string[] = [];
		const guard = guardOver(coordinator, settings, stops);

		for (let i = 0; i < 3; i++) {
			const refusal = await guard.check({ toolCallId: `call-${i}`, tool: bash, args: RM, tier: "exec" });
			expect(refusal).toContain("no-rm guidance");
		}

		expect(events.filter(event => event.type === "ttsr_triggered")).toHaveLength(3);
		expect(stops).toEqual(["The tool guard refused 3 tool calls in a row; the run stopped."]);
	});

	it("[gate-16] a read-tier call a gate judged and allowed ends a run of refusals", async () => {
		const SECRETS = "Does this call read a file under secrets/?";
		const verdicts = { [SECRETS]: 0 };
		const { judge } = fakeJudge(verdicts);
		const settings = Settings.isolated();
		const { coordinator } = setup([judgedRule("no-secrets", { gate: "before", question: SECRETS })], judge, settings);
		const stops: string[] = [];
		const guard = guardOver(coordinator, settings, stops);
		const read = { ...bash, name: "read", label: "read", approval: "read" } as AgentTool;
		const results: (string | undefined)[] = [];

		for (let i = 0; i < 5; i++) {
			const refused = i % 2 === 0;
			verdicts[SECRETS] = refused ? 1 : 0;
			const path = refused ? `secrets/${i}` : `src/${i}.ts`;
			results.push(await guard.check({ toolCallId: `call-${i}`, tool: read, args: { path }, tier: "read" }));
		}

		expect(results.map(result => result !== undefined)).toEqual([true, false, true, false, true]);
		expect(stops).toEqual([]);
	});

	it("[gate-15] neither refuses, reports nor counts calls aborted while the judge is pending", async () => {
		const settings = Settings.isolated();
		const asked = Promise.withResolvers<void>();
		let pending = 0;
		const judge: Judge = {
			label: "pending",
			judge: () => {
				if (++pending === 3) asked.resolve();
				return Promise.withResolvers<never>().promise;
			},
		};
		const { coordinator, events } = setup([gateRule("no-rm", { onJudgeError: "block" })], judge, settings);
		const stops: string[] = [];
		const guard = guardOver(coordinator, settings, stops);
		const controller = new AbortController();

		const checks = [0, 1, 2].map(i =>
			guard.check({ toolCallId: `call-${i}`, tool: bash, args: RM, tier: "exec" }, controller.signal),
		);
		await asked.promise;
		controller.abort();
		const settled = await Promise.allSettled(checks);

		expect(settled.map(result => result.status)).toEqual(["rejected", "rejected", "rejected"]);
		expect(events.filter(event => event.type === "ttsr_triggered")).toHaveLength(0);
		expect(stops).toEqual([]);
	});

	it.each([
		{ found: "a blocking rule", tool: "bash", stuck: false },
		{ found: "no rule", tool: "edit", stuck: false },
		{ found: "nothing yet", tool: "bash", stuck: true },
	])("[gate-23] neither refuses nor runs a call aborted while prefiltering finds $found", async ({ tool, stuck }) => {
		const settings = Settings.isolated();
		const rule = gateRule("no-rm", { onJudgeError: "block", scope: [`tool:${tool}`] });
		const { coordinator, manager, events } = setup([rule], undefined, settings);
		const controller = new AbortController();
		const prefilter = manager.gateCandidates.bind(manager);
		vi.spyOn(manager, "gateCandidates").mockImplementation(async (content, context) => {
			controller.abort();
			return stuck ? Promise.withResolvers<never>().promise : prefilter(content, context);
		});

		const checked = guardOver(coordinator, settings).check(
			{ toolCallId: "call-1", tool: bash, args: RM, tier: "exec" },
			controller.signal,
		);

		// Nothing here waits on I/O or a timer: by the next event-loop turn the check has settled, unless
		// it hangs on prefiltering the abort did not end.
		const nextTurn = Promise.withResolvers<string>();
		setImmediate(() => nextTurn.resolve("still pending"));
		const outcome = await Promise.race([
			checked.then(
				refusal => (refusal === undefined ? "ran" : "refused"),
				() => "rejected",
			),
			nextTurn.promise,
		]);

		expect(outcome).toBe("rejected");
		expect(events.filter(event => event.type === "ttsr_triggered")).toHaveLength(0);
	});

	it("[gate-14] refuses through the tool wrapper without running the tool", async () => {
		const { judge } = fakeJudge({ [DELETES]: 0.9 });
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		const { coordinator } = setup([gateRule("no-rm", {})], judge, settings);
		const { refusal: expected } = await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" });
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			"/work",
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		runner.setToolGuard(guardOver(coordinator, settings));
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
		const wrapped = new ExtensionToolWrapper({ ...bash, execute } as AgentTool, runner) as ExtensionToolWrapper<any>;

		const error = await wrapped.execute("call-1", RM, undefined, undefined, { settings } as AgentToolContext).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(expected).toContain("no-rm guidance");
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(expected!);
		expect(execute).not.toHaveBeenCalled();
	});

	it("[gate-17] refuses through the tool wrapper a call the user approved in a prompt", async () => {
		const { judge } = fakeJudge({ [DELETES]: 0.9 });
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
		const { coordinator, events } = setup([gateRule("no-rm", {})], judge, settings);
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			"/work",
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		const select = vi.fn(async () => "Approve");
		runner.initialize({} as ExtensionActions, {} as ExtensionContextActions, undefined, {
			select,
		} as unknown as ExtensionUIContext);
		runner.setToolGuard(guardOver(coordinator, settings));
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
		const wrapped = new ExtensionToolWrapper({ ...bash, execute } as AgentTool, runner) as ExtensionToolWrapper<any>;

		const error = await wrapped.execute("call-1", RM, undefined, undefined, { settings } as AgentToolContext).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("no-rm guidance");
		expect(events.filter(event => event.type === "ttsr_triggered")).toHaveLength(1);
		expect(execute).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"[gate-21] stops the run after three refused tool commands, though each one's bash call passes",
		async () => {
			const REWRITES = "Does the call rewrite code?";
			const { judge } = fakeJudge({ [REWRITES]: 0.9 });
			const settings = Settings.isolated({ "tools.approvalMode": "yolo", "bash.autoBackground.enabled": false });
			const rule = judgedRule("no-rewrite", { gate: "before", question: REWRITES, scope: ["tool:ast_edit"] });
			const { coordinator, events } = setup([rule], judge, settings);
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ttsr-gate-"));
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					cwd,
					SessionManager.inMemory(),
					{} as ModelRegistry,
				);
				const stops: string[] = [];
				runner.setToolGuard(guardOver(coordinator, settings, stops));
				const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "rewrote" }] }));
				const command = {
					name: "ast_edit",
					label: "ast_edit",
					description: "structural rewrite",
					parameters: type({ pattern: "string" }),
					approval: "write",
					execute,
				} as AgentTool;
				const toolCommands: ToolCommandState = {
					tools: new Map([["ast_edit", new ExtensionToolWrapper(command, runner) as unknown as Tool]]),
					mountedNames: new Set(["ast_edit"]),
					builtInNames: new Set(),
					isActive: () => false,
					resolve: name => resolveToolCommand(toolCommands, name),
				};
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionId: () => cwd,
					getSessionSpawns: () => "*",
					settings,
					toolCommands,
					isToolActive: name => name === "bash",
				};
				const shell = new ExtensionToolWrapper(new BashTool(session) as unknown as AgentTool, runner);
				// The `$` keeps the line from resolving to `read`: the `bash` call itself passes the guard and
				// would end the run, were its tool command not refused right after it.
				const line = { command: "ast_edit --pattern 'foo($A)'" };

				for (let i = 0; i < 3; i++) {
					const outcome = await shell
						.execute(`call-${i}`, line, undefined, undefined, {
							settings,
						} as AgentToolContext)
						.then(
							result => JSON.stringify(result.content),
							(err: unknown) => (err instanceof Error ? err.message : String(err)),
						);
					expect(outcome).toContain("no-rewrite guidance");
				}

				expect(execute).not.toHaveBeenCalled();
				expect(events.filter(event => event.type === "ttsr_triggered")).toHaveLength(3);
				expect(stops).toEqual(["The tool guard refused 3 tool calls in a row; the run stopped."]);
			} finally {
				releaseShellSessions(cwd);
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	);

	it("[gate-22] judges a call under the wire name it arrived by, as rule scopes name it", async () => {
		const { judge } = fakeJudge({ [DELETES]: 0.9 });
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		const { coordinator } = setup([gateRule("no-rm-patch", { scope: ["tool:apply_patch"] })], judge, settings);
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			"/work",
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		runner.setToolGuard(guardOver(coordinator, settings));
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
		const patcher = { ...bash, name: "edit", customWireName: "apply_patch", approval: "write", execute } as AgentTool;
		const wrapped = new ExtensionToolWrapper(patcher, runner) as ExtensionToolWrapper<any>;
		const toolCall = { batchId: "batch-1", index: 0, total: 1, toolCalls: [{ id: "call-1", name: "apply_patch" }] };

		await expect(
			wrapped.execute("call-1", RM, undefined, undefined, { settings, toolCall } as AgentToolContext),
		).rejects.toThrow("no-rm-patch guidance");
		expect(execute).not.toHaveBeenCalled();
	});

	it("[gate-26] judges a bridged call under both the tool's name and its wire name", async () => {
		const { judge } = fakeJudge({ [DELETES]: 0.9 });
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		for (const scope of ["tool:apply_patch", "tool:edit"]) {
			const { coordinator } = setup([gateRule("no-rm-patch", { scope: [scope] })], judge, settings);
			const runner = new ExtensionRunner(
				[],
				new ExtensionRuntime(),
				"/work",
				SessionManager.inMemory(),
				{} as ModelRegistry,
			);
			runner.setToolGuard(guardOver(coordinator, settings));
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
			const patcher = {
				...bash,
				name: "edit",
				customWireName: "apply_patch",
				approval: "write",
				execute,
			} as AgentTool;
			const wrapped = new ExtensionToolWrapper(patcher, runner) as ExtensionToolWrapper<any>;
			// An eval cell's `tool.edit(…)`: the batch holds the eval call, not this one.
			const toolCall = { batchId: "batch-1", index: 0, total: 1, toolCalls: [{ id: "call-1", name: "eval" }] };

			await expect(
				wrapped.execute("js-edit-1", RM, undefined, undefined, { settings, toolCall } as AgentToolContext),
			).rejects.toThrow("no-rm-patch guidance");
			expect(execute).not.toHaveBeenCalled();
		}
	});

	it("[gate-27] takes a probability outside 0..1 as no answer, leaving the call to onJudgeError", async () => {
		for (const noul of [-1, 1.5]) {
			const { judge } = fakeJudge({ [DELETES]: noul });
			const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], judge, Settings.isolated());
			const allowing = setup([gateRule("no-rm", {})], judge, Settings.isolated());

			expect(
				(await blocking.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).refusal,
			).toContain("no-rm guidance");
			expect(
				(await allowing.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-2" })).refusal,
			).toBeUndefined();
		}
	});

	it("[gate-18] judges the whole edit call, so a file it deletes beside an added line cannot slip past", async () => {
		const edit = applyPatchTool();
		const DELETES_FILE = "Does this call delete a file?";
		const rule = judgedRule("no-delete", {
			gate: "before",
			question: DELETES_FILE,
			onJudgeError: "block",
			scope: ["tool:edit"],
		});
		const { coordinator } = setup([rule], contentJudge("Delete File: secrets.env"), Settings.isolated(), [edit]);

		const { refusal } = await coordinator.gateToolCall({
			tool: edit,
			args: patchAddingLineAnd("*** Delete File: secrets.env"),
			toolCallId: "call-1",
		});

		expect(refusal).toContain("no-delete guidance");
	});

	it.each([
		{ name: "deletes", sections: ["*** Delete File: secrets.env"] },
		{ name: "moves to", sections: ["*** Update File: config.txt", "*** Move to: secrets.env"] },
		{ name: "only removes lines from", sections: ["*** Update File: secrets.env", "@@", "-TOKEN=1"] },
	])("[gate-19] asks a gate globbed to a file the edit call $name, beside an added line", async ({ sections }) => {
		const edit = applyPatchTool();
		const rule = judgedRule("env-files", {
			gate: "before",
			question: "Does this call change an env file?",
			scope: ["tool:edit"],
			globs: ["*.env"],
		});
		const { coordinator } = setup([rule], contentJudge("secrets.env"), Settings.isolated(), [edit]);

		const verdict = await coordinator.gateToolCall({
			tool: edit,
			args: patchAddingLineAnd(...sections),
			toolCallId: "call-1",
		});

		expect(verdict.covered).toBe(true);
		expect(verdict.refusal).toContain("env-files guidance");
	});

	it.each([
		{ name: "removes lines from", sections: ["*** Update File: README.md", "@@", "-secrets.env"] },
		{ name: "deletes", sections: ["*** Delete File: secrets.env"] },
	])(
		"[gate-24] shows a gate globbed to one file nothing of a sibling file the edit call $name",
		async ({ sections }) => {
			const edit = applyPatchTool();
			const rule = judgedRule("ts-files", {
				gate: "before",
				question: "Does this call change an env file?",
				scope: ["tool:edit(*.ts)"],
			});
			const { coordinator } = setup([rule], contentJudge("secrets.env"), Settings.isolated(), [edit]);

			const verdict = await coordinator.gateToolCall({
				tool: edit,
				args: patchAddingLineAnd(...sections),
				toolCallId: "call-1",
			});

			expect(verdict).toEqual({ covered: true });
		},
	);

	it("[gate-20] leaves a call too long for the judge to read in full to onJudgeError", async () => {
		const { judge } = fakeJudge({ [DELETES]: 0.05 });
		const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], judge, Settings.isolated());
		const allowing = setup([gateRule("no-rm", {})], judge, Settings.isolated());
		const padded = { command: `cat <<'EOF' >/dev/null\n${"filler ".repeat(40_000)}EOF\nrm -rf /srv/data` };

		expect(
			(await blocking.coordinator.gateToolCall({ tool: bash, args: padded, toolCallId: "call-1" })).refusal,
		).toContain("no-rm guidance");
		expect(
			(await allowing.coordinator.gateToolCall({ tool: bash, args: padded, toolCallId: "call-2" })).refusal,
		).toBeUndefined();
		expect(
			(await blocking.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-3" })).refusal,
		).toBeUndefined();
	});

	it("asks nothing and runs a call outside the gate's scope, globs or prefilter", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 1 });
		const { coordinator } = setup(
			[
				gateRule("edit-only", { scope: ["tool:edit"] }),
				gateRule("globbed", { globs: ["*.sql"] }),
				gateRule("prefiltered", { condition: ["\\bdd\\b"] }),
			],
			judge,
			Settings.isolated(),
		);

		expect(await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).toEqual({
			covered: false,
		});
		expect(requests).toHaveLength(0);
	});

	it("never interrupts the stream on a gate's condition", () => {
		const manager = new TtsrManager({});
		expect(manager.addRule(gateRule("no-rm", { condition: ["rm -rf"] }))).toBe(true);

		const context = { source: "tool" as const, toolName: "bash" };
		expect(manager.checkDelta(JSON.stringify(RM), context, { final: true })).toEqual([]);
		expect(manager.checkSnapshot(JSON.stringify(RM), context)).toEqual([]);
	});

	it("registers no gate while TTSR is off", async () => {
		const manager = new TtsrManager({ enabled: false });
		expect(manager.addRule(gateRule("no-rm", {}))).toBe(false);
		expect(await manager.gateCandidates("rm", { source: "tool", toolName: "bash" })).toEqual([]);
	});
});
