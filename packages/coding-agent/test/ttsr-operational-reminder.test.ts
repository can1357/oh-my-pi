import { expect, test, vi } from "bun:test";
import { Agent, type AgentEvent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";
import type { Rule } from "../src/capability/rule";
import { Settings } from "../src/config/settings";
import { buildRuleFromMarkdown } from "../src/discovery/helpers";
import { TtsrManager } from "../src/export/ttsr";
import { SessionManager } from "../src/session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "../src/session/ttsr-coordinator";

const source = { provider: "test", providerName: "test", path: "/tmp/reminder.md", level: "project" as const };
const tool: AgentTool = {
	name: "bash",
	label: "fixture",
	description: "fixture",
	parameters: type({ command: "string" }),
	execute: async () => ({ content: [{ type: "text", text: "fixture-result" }] }),
};
const full =
	"Do not publish private data. Approval remains human-only.\n\n## History\nHISTORICAL_CASE: 200 prior failures.\n## Matrix\nPOS NEG provenance is retained.";
function loaded(reminder?: unknown, mode = "never") {
	const reminderField = reminder === undefined ? "" : "reminder: " + JSON.stringify(reminder) + "\n";
	return buildRuleFromMarkdown(
		"fixture",
		"---\ncondition: FORBIDDEN\nscope: tool:bash\ninterruptMode: " + mode + "\n" + reminderField + "---\n" + full,
		source.path,
		source,
	);
}
function coordinator(rule: Rule, agent = new Agent({ initialState: { tools: [tool], systemPrompt: ["fixture"] } })) {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "keep",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
	});
	expect(manager.addRule(rule)).toBe(true);

	const host: TtsrCoordinatorHost = {
		agent,
		sessionManager: SessionManager.inMemory("/tmp"),
		settings: Settings.isolated(),
		emitSessionEvent: async () => {},
		schedulePostPromptTask: () => {},
		scheduleAgentContinue: () => {},
		promptGeneration: () => 0,
		ruleJudge: () => undefined,
		deliverRuleWarning: async () => {},
		sessionGeneration: () => 0,
	};
	return new TtsrCoordinator(host, manager);
}

test("a completed streamed warning queues operational guidance without historical instructions", async () => {
	const rule = { ...loaded("Do not publish private data. Approval remains human-only."), scope: ["text"] };
	const agent = new Agent({ initialState: { tools: [], systemPrompt: ["fixture"] } });
	const followUp = vi.spyOn(agent, "followUp");
	const consumer = coordinator(rule, agent);
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "FORBIDDEN" }],
		stopReason: "stop",
		timestamp: 1,
	} as AssistantMessage;
	expect(
		await consumer.checkMessageUpdate({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "FORBIDDEN", partial: message },
		} as AgentEvent),
	).toBe(false);
	consumer.onAssistantMessageEnd(message);
	const delivery = followUp.mock.calls[0][0];
	expect(delivery.role).toBe("custom");
	if (delivery.role !== "custom") throw new Error("Expected a trusted custom reminder message");
	expect(delivery.content).toContain("Approval remains human-only");
	expect(delivery.content).not.toContain("HISTORICAL_CASE");
	expect(rule.content).toContain("POS NEG provenance");
	followUp.mockRestore();
});
for (const mode of ["never", "always"] as const) {
	test(
		"actual " + mode + " delivery uses explicit instructions while retaining history for full rule reads",
		async () => {
			const rule = loaded(
				"Do not publish private data. Approval remains human-only. Inspect scope before acting.",
				mode,
			);
			const consumer = coordinator(rule);
			expect(await consumer.beforeBridgedToolCall("control", tool, { command: "allowed" })).toBeUndefined();
			expect(
				consumer.afterBridgedToolCall("control", { content: [{ type: "text", text: "unchanged" }] }),
			).toBeUndefined();
			const blocked = await consumer.beforeBridgedToolCall("matched", tool, { command: "FORBIDDEN" });
			const delivery =
				mode === "always"
					? blocked?.reason
					: consumer
							.afterBridgedToolCall("matched", { content: [{ type: "text", text: "unchanged" }] })
							?.content.map(part => (part.type === "text" ? part.text : ""))
							.join("\n");
			expect(delivery).toContain("Approval remains human-only");
			expect(delivery).toContain("Do not publish private data");
			expect(delivery).not.toContain("HISTORICAL_CASE");
			expect(rule.content).toContain("HISTORICAL_CASE");
			expect(rule.content).toContain("POS NEG provenance");
			expect(mode === "always" ? blocked?.block : blocked).toBe(mode === "always" ? true : undefined);
		},
	);
}
for (const reminder of ["", "界".repeat(342), 42, null]) {
	test("invalid operational payload preserves the full security rule: " + typeof reminder, async () => {
		const consumer = coordinator(loaded(reminder));
		await consumer.beforeBridgedToolCall("matched", tool, { command: "FORBIDDEN" });
		const delivery = consumer.afterBridgedToolCall("matched", { content: [] });
		const text = delivery?.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("Approval remains human-only");
		expect(text).toContain("HISTORICAL_CASE");
	});
}
test("an existing rule without an opt-in summary retains its complete reminder", async () => {
	const consumer = coordinator(loaded());
	await consumer.beforeBridgedToolCall("matched", tool, { command: "FORBIDDEN" });
	expect(consumer.afterBridgedToolCall("matched", { content: [] })?.content).toContainEqual(
		expect.objectContaining({ type: "text", text: expect.stringContaining("POS NEG provenance") }),
	);
});

test("an exactly 1024-byte multibyte reminder is delivered rather than mistaken for overflow", async () => {
	const lead = "Approval remains human-only.";
	const remaining = 1024 - Buffer.byteLength(lead);
	const payload = lead + "界".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
	const consumer = coordinator(loaded(payload));
	await consumer.beforeBridgedToolCall("boundary", tool, { command: "FORBIDDEN" });
	const text = consumer
		.afterBridgedToolCall("boundary", { content: [] })
		?.content.map(part => (part.type === "text" ? part.text : ""))
		.join("\n");
	expect(text).toContain(payload);
	expect(text).not.toContain("HISTORICAL_CASE");
});
