import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

const rule: Rule = {
	name: "ts-no-tiny-functions",
	path: "/rules/ts-no-tiny-functions.md",
	content: "Inline tiny wrappers.",
	_source: {
		provider: "test",
		providerName: "Test",
		path: "/rules/ts-no-tiny-functions.md",
		level: "project",
	},
};

describe("tool activity visibility", () => {
	it("hides TTSR notices and todo reminders with tool activity, including ones added while hidden", async () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "ttsr_triggered", rules: [rule] } as AgentSessionEvent);
		const visible = renderTranscript(ctx).join("\n");
		expect(visible).toContain("ts-no-tiny-functions");

		ctx.hideToolActivity = true;
		expect(renderTranscript(ctx).join("\n")).not.toContain("ts-no-tiny-functions");
		await controller.handleEvent({
			type: "todo_reminder",
			todos: [{ content: "finish the task", status: "in_progress" }],
			attempt: 1,
			maxAttempts: 3,
		} as AgentSessionEvent);
		expect(renderTranscript(ctx).join("\n")).not.toContain("finish the task");

		ctx.hideToolActivity = false;
		const restored = renderTranscript(ctx).join("\n");
		expect(restored).toContain("ts-no-tiny-functions");
		expect(restored).toContain("finish the task");
	});
});
