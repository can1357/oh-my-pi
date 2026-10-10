import { describe, expect, it } from "bun:test";
import {
	contentText,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	Type,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";

describe("legacy Pi transcript text", () => {
	it("joins only text blocks with Pi's newline separator, preserving caller overrides", () => {
		const blocks = [
			{ type: "text", text: "first" },
			{ type: "image", data: "irrelevant" },
			{ type: "text", text: "second" },
		];
		expect(contentText(blocks)).toBe("first\nsecond");
		expect(contentText(blocks, " ")).toBe("first second");
	});

	it("replays later system text and named section replacements and removals", () => {
		const transcript = [
			{ role: "system", content: "Base", sections: { rules: "old", obsolete: "remove me" } },
			{ role: "user", content: "ignored" },
			{
				role: "system",
				content: [{ type: "text", text: "Additional" }],
				sections: { rules: "new", obsolete: null },
			},
		];
		expect(getCurrentSystemPrompt(transcript)).toBe("Base\n\nAdditional\n\nnew");
		expect(getCurrentSystemPrompt([{ role: "user", content: "No system message" }])).toBe("");
	});

	it("replays tool replacement and removal without leaking earlier declarations", () => {
		const read = { name: "read", description: "read files", parameters: Type.Object({}) };
		const write = { name: "write", description: "write files", parameters: Type.Object({}) };
		const updatedRead = { name: "read", description: "read files and images", parameters: Type.Object({}) };
		const current = getCurrentSystemMessage([
			{ role: "system", content: "", toolsAdded: [read, write], timestamp: 5 },
			{ role: "assistant", content: "ignored" },
			{ role: "system", toolsRemoved: [{ name: "write" }], toolsAdded: [updatedRead], timestamp: 6 },
		]);
		expect(current).toEqual({
			role: "system",
			content: "",
			toolsAdded: [updatedRead],
			timestamp: 5,
		});
		expect(
			getCurrentTools([
				{ role: "system", toolsAdded: [read, write] },
				{ role: "system", toolsRemoved: [{ name: "write" }], toolsAdded: [updatedRead] },
			]),
		).toEqual([updatedRead]);
		expect(getCurrentSystemMessage([{ role: "user", content: "nothing" }])).toBeUndefined();
	});
});
