import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { filterAdvisorInput } from "../../src/advisor/input-filter";

function assistant(content: unknown[]): AgentMessage {
	return { role: "assistant", content, timestamp: 1 } as AgentMessage;
}

function result(toolCallId: string, toolName: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	} as AgentMessage;
}

describe("filterAdvisorInput", () => {
	it("removes shell Git calls and their results", () => {
		const messages = [
			assistant([{ type: "toolCall", id: "git-call", name: "bash", arguments: { command: "git status --short" } }]),
			result("git-call", "bash", "M src/app.ts"),
		];

		expect(filterAdvisorInput(messages)).toEqual([]);
	});

	it("recognizes gh and gt through shell wrappers and command chains", () => {
		const messages = [
			assistant([
				{ type: "toolCall", id: "gh-call", name: "shell", arguments: { command: "env GH_REPO=x/y gh pr view 1" } },
				{ type: "toolCall", id: "gt-call", name: "bash", arguments: { command: "printf ready && sudo gt submit" } },
			]),
			result("gh-call", "shell", "PR data"),
			result("gt-call", "bash", "submitted"),
		];

		expect(filterAdvisorInput(messages)).toEqual([]);
	});

	it("removes namespaced repository tools", () => {
		const messages = [
			assistant([
				{ type: "toolCall", id: "github-call", name: "xd.github", arguments: { op: "pr_create" } },
				{ type: "toolCall", id: "graphite-call", name: "mcp__graphite__submit", arguments: { op: "submit" } },
			]),
			result("github-call", "xd.github", "created"),
			result("graphite-call", "mcp__graphite__submit", "submitted"),
		];

		expect(filterAdvisorInput(messages)).toEqual([]);
	});

	it("hides a result delivered after its operational call", () => {
		const hiddenCallIds = new Set<string>();
		const call = assistant([
			{ type: "toolCall", id: "git-call", name: "bash", arguments: { command: "git fetch origin" } },
		]);

		expect(filterAdvisorInput([call], hiddenCallIds)).toEqual([]);
		expect(filterAdvisorInput([result("git-call", "bash", "fetched")], hiddenCallIds)).toEqual([]);
	});

	it("removes an entire mixed message and every paired result", () => {
		const mixed = assistant([
			{ type: "text", text: "The parser needs a bounded retry." },
			{ type: "toolCall", id: "git-call", name: "bash", arguments: { command: "git diff -- src/parser.ts" } },
			{ type: "toolCall", id: "edit-call", name: "edit", arguments: { path: "src/parser.ts" } },
		]);

		expect(
			filterAdvisorInput([mixed, result("git-call", "bash", "diff"), result("edit-call", "edit", "updated parser")]),
		).toEqual([]);
	});

	it("preserves commands where git-like text is an argument rather than an executable", () => {
		const call = assistant([
			{ type: "toolCall", id: "search-call", name: "bash", arguments: { command: "printf '%s' git status" } },
		]);
		const callResult = result("search-call", "bash", "gitstatus");

		expect(filterAdvisorInput([call, callResult])).toEqual([call, callResult]);
	});
});
