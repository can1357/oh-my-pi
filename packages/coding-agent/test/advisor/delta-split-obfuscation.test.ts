// Obfuscation contract for multi-message split: renderAdvisorDeltaChunks must redact
// secrets that ACTUALLY appear in rendered advisor context — toolResult
// details.diff and custom message content — matching the old single-block path.
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import { type AdvisorObfuscator, renderAdvisorDeltaChunks } from "../../src/advisor/delta-split";

function chunksToText(chunks: AgentMessage[] | null): string | null {
	if (!chunks) return null;
	return chunks.map(c => ((c as { content: unknown }).content as { text: string }[])[0].text).join("\n");
}

// Fake obfuscator for the pure renderer's text pass, typed against the narrow
// AdvisorObfuscator contract so the test exercises redaction without `any`.
function makeObfuscator(): AdvisorObfuscator {
	return {
		obfuscate: (text: string) => text.replace(/SECRETVALUE123/g, "[REDACTED]"),
	};
}

describe("renderAdvisorDeltaChunks obfuscation", () => {
	it("redacts secrets in toolResult details.diff", () => {
		const msg = {
			role: "toolResult",
			toolCallId: "c1",
			content: "ok",
			details: { diff: "--- a/x\n+++ b/x\n-SECRETVALUE123\n+new" },
			timestamp: 1,
		} as unknown as AgentMessage;
		const chunks = renderAdvisorDeltaChunks([msg], {
			wip: false,
			includeThinking: true,
			obfuscator: makeObfuscator(),
			advisorRegexSecretValues: new Set(),
		});
		const text = chunksToText(chunks) ?? "";
		expect(text).not.toContain("SECRETVALUE123");
		expect(text).toContain("[REDACTED]");
	});

	it("redacts secrets in user message text", () => {
		const msg = {
			role: "user",
			content: [{ type: "text", text: "prefix SECRETVALUE123 suffix" }],
			timestamp: 1,
		} as AgentMessage;
		const chunks = renderAdvisorDeltaChunks([msg], {
			wip: false,
			includeThinking: true,
			obfuscator: makeObfuscator(),
			advisorRegexSecretValues: new Set(),
		});
		const text = chunksToText(chunks) ?? "";
		expect(text).not.toContain("SECRETVALUE123");
		expect(text).toContain("[REDACTED]");
	});

	it("falls back when full-delta redaction spans source chunks", () => {
		const crossChunkObfuscator: AdvisorObfuscator = {
			obfuscate: text => text.replace(/first[\s\S]*second/g, "[REDACTED]"),
		};
		const chunks = renderAdvisorDeltaChunks(
			[
				{ role: "user", content: "first", timestamp: 1 } as AgentMessage,
				{ role: "user", content: "second", timestamp: 2 } as AgentMessage,
			],
			{
				wip: false,
				includeThinking: true,
				obfuscator: crossChunkObfuscator,
				advisorRegexSecretValues: new Set(),
			},
		);

		expect(chunks).toBeNull();
	});
});
