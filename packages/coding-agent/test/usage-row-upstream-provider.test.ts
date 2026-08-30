/**
 * Coverage for the responding-aggregator (`upstreamProvider`) in transcript
 * usage rows — OpenRouter-style responses carry the routed backend that
 * actually generated the turn; direct provider connections leave it undefined
 * and the row renders unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { formatUsageRow } from "@oh-my-pi/pi-coding-agent/modes/components/usage-row";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const PROMPT_AT = new Date(2026, 0, 2, 3, 4, 5).getTime();
const REQUEST_DURATION_MS = 30_000;

const BASE_USAGE: Usage = {
	input: 4242,
	output: 7,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 4249,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AssistantFixture = Extract<AgentMessage, { role: "assistant" }>;

function assistantMessage(overrides: Partial<AssistantFixture> = {}): AssistantFixture {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: BASE_USAGE,
		timestamp: PROMPT_AT + 1_000,
		duration: REQUEST_DURATION_MS,
		...overrides,
	} as unknown as AssistantFixture;
}

function userMessage(text = "build it"): AgentMessage {
	return { role: "user", content: text, timestamp: PROMPT_AT } as unknown as AgentMessage;
}

function toEntries(
	messages: AgentMessage[],
): Array<{ type: "message"; id: string; parentId: string | null; timestamp: string; message: AgentMessage }> {
	return messages.map((message, index) => ({
		type: "message",
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		timestamp: new Date(0).toISOString(),
		message,
	}));
}

function renderedText(container: { render(width: number): readonly string[] }): string {
	return Bun.stripANSI(container.render(120).join("\n"));
}

describe("formatUsageRow upstream provider", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("appends the routed provider after the throughput rate", () => {
		const row = formatUsageRow(BASE_USAGE, REQUEST_DURATION_MS, undefined, undefined, undefined, "Z.AI");
		const rateIndex = row.indexOf("/s");
		expect(row).toContain("via Z.AI");
		expect(row.indexOf("via Z.AI")).toBeGreaterThan(rateIndex);
	});

	it("strips ANSI escapes, control characters, and caps provider length", () => {
		const hostile = "[31mEvil\u0007Corp[0m";
		const row = formatUsageRow(BASE_USAGE, REQUEST_DURATION_MS, undefined, undefined, undefined, hostile);
		expect(row).toContain("via EvilCorp");
		expect(row).not.toContain("[");
		const long = "A".repeat(100);
		expect(formatUsageRow(BASE_USAGE, REQUEST_DURATION_MS, undefined, undefined, undefined, long)).toContain(
			`via ${"A".repeat(40)}`,
		);
	});

	it("renders the provider even when the rate is suppressed (sub-minimum duration)", () => {
		const row = formatUsageRow(BASE_USAGE, 50, undefined, undefined, undefined, "Z.AI");
		expect(row).not.toContain("/s");
		expect(row).toContain("via Z.AI");
	});

	it("renders no provider for direct connections", () => {
		expect(formatUsageRow(BASE_USAGE, REQUEST_DURATION_MS)).not.toContain("via");
	});
});

describe("ChatTranscriptBuilder upstream provider", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.showTokenUsage", true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	function builder(): ChatTranscriptBuilder {
		return new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
	}

	it("shows the routed provider on the rebuilt usage row", () => {
		const transcript = builder();
		transcript.rebuild(toEntries([userMessage(), assistantMessage({ upstreamProvider: "Z.AI" })]));
		expect(renderedText(transcript.container)).toContain("via Z.AI");
	});

	it("hides the provider when the message carries none", () => {
		const transcript = builder();
		transcript.rebuild(toEntries([userMessage(), assistantMessage()]));
		expect(renderedText(transcript.container)).not.toContain("via");
	});
});

describe("ReadToolGroupComponent upstream provider", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme();
	});
	afterAll(() => {
		resetSettingsForTest();
	});

	it("keeps the routed provider on usage attached to a read group", () => {
		const component = new ReadToolGroupComponent();
		const examplePath = "/tmp/example.ts";
		component.updateArgs({ path: examplePath }, "read-0");
		component.updateResult({ content: [{ type: "text", text: "line 1" }] }, false, "read-0");
		expect(
			component.attachUsage(["read-0"], BASE_USAGE, REQUEST_DURATION_MS, undefined, undefined, undefined, "Z.AI"),
		).toBe(true);
		expect(renderedText(component)).toContain("via Z.AI");
	});
});
