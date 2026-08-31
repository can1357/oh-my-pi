import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildContextReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/context-report";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function noModelRuntime(): SlashCommandRuntime {
	const tokenizer = new Tokenizer();
	const session = {
		model: null,
		agent: { tokenizer },
		settings: { get: (path: string) => (path === "snapcompact.systemPrompt" ? "none" : false) },
		getContextBreakdown: () => ({
			messagesTokens: 0,
			systemToolsTokens: 0,
			systemContextTokens: 0,
			systemPromptTokens: 0,
			usedTokens: 0,
		}),
		getStaticContextSources: () => ({
			completeStaticContext: ["system", "schema"],
			renderedSystemTemplate: ["system"],
			nativeToolSchemas: ["schema"],
			projectContextBlocks: [],
			skillCatalog: [],
		}),
		getContextUsage: () => undefined,
	} as unknown as AgentSession;
	return { session } as SlashCommandRuntime;
}

describe("context report", () => {
	it("reports exact static totals before a model is selected", () => {
		const text = buildContextReportText(noModelRuntime());

		expect(text).toContain("no model is selected");
		expect(text).toContain("Static context:");
		expect(text).toContain("Total static: 12 bytes");
		expect(text).toContain("Model context window: unknown");
	});
});
