import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { logger } from "@oh-my-pi/pi-utils";
import { fakeJudge, judgedRule, setup } from "./helpers/ttsr-judged-rules";

const DELETES = "Does the command delete files outside the project?";

function probeRule(name: string, command: string, fields: Partial<Rule> = {}): Rule {
	return judgedRule(name, { gate: "before", command, condition: ["rm"], scope: ["tool:bash"], ...fields });
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
		expect(refusal).toContain("check command refused it");
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
		expect(refusal).toContain("check command did not finish");
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

		expect(warn).toHaveBeenCalledWith("TTSR gate rule sets both command and question; the command decides", {
			ruleName: "no-rm",
		});
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
		expect(warn).toHaveBeenCalledWith("TTSR command rule is not a gate: before rule, skipping rule", {
			ruleName: "no-gate",
		});
		expect(warn).toHaveBeenCalledWith("TTSR command rule has no condition, skipping rule", {
			ruleName: "no-condition",
		});
	});
});
