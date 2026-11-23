import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentTool, BeforeToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { logger } from "@oh-my-pi/pi-utils";
import { assistant, fakeJudge, judgedRule, setup } from "./helpers/ttsr-judged-rules";

const DELETES = "Does the command delete files outside the project?";

function probeRule(name: string, command: string, fields: Partial<Rule> = {}): Rule {
	const rule = judgedRule(name, { gate: "before", command, condition: ["rm"], scope: ["tool:bash"], ...fields });
	return { ...rule, _source: { ...rule._source, level: "user" }, ...fields };
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

describe("TTSR gate command probes", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttsr-probe-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A coordinator over `rules`, its probes run in `dir`. */
	function probeSetup(rules: Rule[], settings = Settings.isolated(), judge = fakeJudge({}).judge) {
		const session = setup(rules, judge, settings);
		vi.spyOn(session.host.sessionManager, "getCwd").mockReturnValue(dir);
		return session;
	}

	it("[probe-01] runs a call the command exits 0 on, after feeding it the call as JSON on stdin", async () => {
		const { coordinator, events } = probeSetup([probeRule("no-rm", "cat > call.json")]);

		expect(await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).toEqual({ covered: true });
		expect(JSON.parse(fs.readFileSync(path.join(dir, "call.json"), "utf8"))).toEqual({
			tool: "bash",
			toolCallId: "call-1",
			arguments: RM,
		});
		expect(events).toHaveLength(0);
	});

	it("[probe-02] refuses a call the command exits nonzero on, quoting the rule", async () => {
		const { coordinator, events } = probeSetup([probeRule("no-rm", "grep -q /srv/data && exit 3; exit 0")]);

		const { refusal, covered } = await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" });

		expect(covered).toBe(true);
		expect(refusal).toContain("no-rm guidance");
		expect(events.map(event => event.type)).toEqual(["ttsr_triggered"]);
		expect(
			(await coordinator.gateToolCall({ tool: bash, args: { command: "rm ./tmp" }, toolCallId: "call-2" })).refusal,
		).toBeUndefined();
	});

	it("[probe-03] bounds a command by ttsr.gateTimeoutMs, then applies onJudgeError", async () => {
		const settings = Settings.isolated({ "ttsr.gateTimeoutMs": 200 });
		const blocking = probeSetup([probeRule("no-rm", "sleep 5", { onJudgeError: "block" })], settings);
		const allowing = probeSetup([probeRule("no-rm", "sleep 5")], settings);

		const started = Date.now();
		const { refusal } = await blocking.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" });
		const allowed = await allowing.coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-2" });

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(refusal).toContain("no-rm guidance");
		expect(allowed).toEqual({ covered: true });
	});

	it("[probe-04] lets command win over question with a load-time warning, never asking the judge", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { judge, requests } = fakeJudge({ [DELETES]: 0.9 });
		const { coordinator, manager } = probeSetup(
			[probeRule("no-rm", "exit 0", { question: DELETES })],
			undefined,
			judge,
		);

		expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ruleName: "no-rm" }));
		expect(manager.hasJudgedGateRules()).toBe(false);
		expect(await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).toEqual({ covered: true });
		expect(requests).toHaveLength(0);
	});

	it("[probe-05] probes once per call and decides alongside question gates in rule order", async () => {
		const { judge, requests } = fakeJudge({ [DELETES]: 0.9 });
		const { coordinator } = probeSetup(
			[
				probeRule("count", "echo x >> runs; exit 0"),
				judgedRule("asked", { gate: "before", question: DELETES, scope: ["tool:bash"] }),
			],
			undefined,
			judge,
		);

		const { refusal } = await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" });

		expect(refusal).toContain("asked guidance");
		expect(requests).toHaveLength(1);
		expect(Object.keys(requests[0].questions)).toHaveLength(1);
		expect(fs.readFileSync(path.join(dir, "runs"), "utf8")).toBe("x\n");
	});

	it("[probe-06] refuses to register a command without gate: before or without a condition", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const manager = new TtsrManager({});

		expect(manager.addRule(probeRule("no-gate", "exit 0", { gate: undefined }))).toBe(false);
		expect(manager.addRule(probeRule("no-condition", "exit 0", { condition: undefined }))).toBe(false);
		expect(manager.hasGateRules()).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ruleName: "no-gate" }));
		expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ruleName: "no-condition" }));
	});

	it("[probe-07] leaves a matching streamed bash call to its probe instead of interrupting it", async () => {
		const { coordinator, abort, events } = probeSetup([probeRule("no-rm", "exit 0")]);
		const call: ToolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: RM };
		const message = assistant([call], "toolUse");
		const streamed = (assistantMessageEvent: unknown) =>
			coordinator.checkMessageUpdate({ type: "message_update", message, assistantMessageEvent } as AgentEvent);

		coordinator.onAssistantMessageStart();
		expect(
			await streamed({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(RM), partial: message }),
		).toBe(false);
		expect(await streamed({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message })).toBe(false);

		expect(abort).not.toHaveBeenCalled();
		expect(events).toHaveLength(0);
		expect(await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).toEqual({ covered: true });
	});

	it("[probe-08] leaves a call matching an astCondition probe to its probe instead of blocking it", async () => {
		const args = { path: "src/a.ts", content: "console.log('x');" };
		const write = {
			name: "write",
			label: "write",
			description: "write tool",
			parameters: {} as never,
			matcherDigest: () => args.content,
			execute: async () => ({ content: [{ type: "text", text: "written" }] }),
		} as AgentTool;
		const rule = probeRule("no-log", "exit 0", {
			condition: undefined,
			astCondition: ["console.log($$$)"],
			scope: ["tool:write(*.ts)"],
		});
		const { coordinator, manager, abort } = setup([rule], undefined, Settings.isolated(), [write]);
		const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "write", arguments: args };

		const blocked = await coordinator.beforeToolCall({
			assistantMessage: assistant([toolCall], "toolUse"),
			toolCall,
			tool: write,
			args,
		} as unknown as BeforeToolCallContext);

		expect(blocked).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
		expect(manager.hasAstRules()).toBe(false);
	});

	it("[probe-09] runs only user-level command rules, never project-level ones", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const manager = new TtsrManager({});
		const project = probeRule("evil", "touch ran", {
			_source: {
				provider: "cursor",
				providerName: "Cursor",
				path: "/repo/.cursor/rules/evil.mdc",
				level: "project",
			},
		});

		expect(manager.addRule(project)).toBe(false);
		expect(manager.hasGateRules()).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ruleName: "evil" }));

		const { coordinator } = probeSetup([probeRule("trusted", "touch ran")]);
		expect(await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).toEqual({ covered: true });
		expect(fs.existsSync(path.join(dir, "ran"))).toBe(true);
	});

	it("[probe-10] runs the probe through the operator's configured shell", async () => {
		const shell = path.join(dir, "probe-shell");
		fs.writeFileSync(shell, '#!/bin/sh\necho "$@" > shell-args\nexit 0\n', { mode: 0o755 });
		const { coordinator } = probeSetup([probeRule("no-rm", "exit 9")], Settings.isolated({ shellPath: shell }));

		expect(await coordinator.gateToolCall({ tool: bash, args: RM, toolCallId: "call-1" })).toEqual({ covered: true });
		expect(fs.readFileSync(path.join(dir, "shell-args"), "utf8").trim()).toMatch(/-c exit 9$/);
	});
});
