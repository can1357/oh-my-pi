import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage, AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Judge } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TtsrCoordinator } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";
import { type GuardJudge, ToolGuard } from "@oh-my-pi/pi-coding-agent/tools/tool-guard";
import { logger } from "@oh-my-pi/pi-utils";
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

const stuckJudge = { label: "stuck", judge: () => Promise.withResolvers<never>().promise } as unknown as Judge;
const failingJudge = {
	label: "failing",
	judge: async () => {
		throw new Error("judge unavailable");
	},
} as unknown as Judge;

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
		gate: (tool, args, toolCallId, signal) => coordinator.gateToolCall(tool, args, toolCallId, signal),
	});
}

describe("TTSR gate rules", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("[gate-01] refuses a matching call the judge flags, before it runs, quoting the rule", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.9 });
		const { coordinator } = setup([gateRule("no-rm", {})], judge, Settings.isolated());

		const refusal = await coordinator.gateToolCall(bash, RM, "call-1");

		expect(refusal).toContain("did not run");
		expect(refusal).toContain('rule="no-rm"');
		expect(refusal).toContain("no-rm guidance");
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0].state)).toContain("rm -rf /srv/data");
	});

	it("[gate-02] runs a call the judge answers below the threshold", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.69 });
		const { coordinator } = setup([gateRule("no-rm", {})], judge, Settings.isolated());

		expect(await coordinator.gateToolCall(bash, RM, "call-1")).toBeUndefined();
		expect(requests).toHaveLength(1);
	});

	it("[gate-03] bounds a judge that never answers by ttsr.gateTimeoutMs, then applies onJudgeError", async () => {
		const settings = Settings.isolated({ "ttsr.gateTimeoutMs": 50 });
		const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], stuckJudge, settings);
		const allowing = setup([gateRule("no-rm", {})], stuckJudge, settings);

		const started = Date.now();
		const refusal = await blocking.coordinator.gateToolCall(bash, RM, "call-1");
		const allowed = await allowing.coordinator.gateToolCall(bash, RM, "call-2");

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(refusal).toContain("did not run");
		expect(refusal).toContain("no-rm guidance");
		expect(allowed).toBeUndefined();
	});

	it("[gate-04] a failing judge refuses under onJudgeError block and runs the call by default", async () => {
		const warn = spyOn(logger, "warn");
		const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], failingJudge, Settings.isolated());
		const allowing = setup([gateRule("no-rm", {})], failingJudge, Settings.isolated());

		expect(await blocking.coordinator.gateToolCall(bash, RM, "call-1")).toContain("no-rm guidance");
		expect(await allowing.coordinator.gateToolCall(bash, RM, "call-2")).toBeUndefined();
		expect(warn.mock.calls.some(([message]) => String(message).includes("gate"))).toBe(true);
	});

	it("[gate-05] with judged rules off, onJudgeError block refuses and allow runs", async () => {
		const blocking = setup([gateRule("no-rm", { onJudgeError: "block" })], undefined, Settings.isolated());
		const allowing = setup([gateRule("no-rm", { onJudgeError: "allow" })], undefined, Settings.isolated());

		expect(await blocking.coordinator.gateToolCall(bash, RM, "call-1")).toContain("no-rm guidance");
		expect(await allowing.coordinator.gateToolCall(bash, RM, "call-2")).toBeUndefined();
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

		expect(await coordinator.gateToolCall(bash, RM, "call-1")).toContain("no-rm guidance");
		expect(await coordinator.gateToolCall(bash, RM, "call-2")).toContain("no-rm guidance");
		expect(requests).toHaveLength(2);
	});

	it("[gate-10] registers gates only with a question, for tool calls only", async () => {
		const warn = spyOn(logger, "warn");
		const manager = new TtsrManager({});
		const tool = { source: "tool" as const, toolName: "bash" };

		expect(manager.addRule(gateRule("no-question", { question: undefined, condition: ["rm"] }))).toBe(false);
		expect(warn.mock.calls.some(([message]) => String(message).includes("gate"))).toBe(true);

		warn.mockClear();
		expect(manager.addRule(gateRule("texty", { scope: ["text", "tool:bash"] }))).toBe(true);
		expect(warn.mock.calls.some(([message]) => String(message).includes("gate"))).toBe(true);
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

		expect(await coordinator.gateToolCall(bash, RM, "call-1")).toContain("no-rm guidance");
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

	it("[gate-14] refuses through the tool wrapper without running the tool", async () => {
		const { judge } = fakeJudge({ [DELETES]: 0.9 });
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		const { coordinator } = setup([gateRule("no-rm", {})], judge, settings);
		const expected = await coordinator.gateToolCall(bash, RM, "call-1");
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

		expect(await coordinator.gateToolCall(bash, RM, "call-1")).toBeUndefined();
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
