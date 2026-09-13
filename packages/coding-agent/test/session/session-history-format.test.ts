/**
 * Contracts: history:// transcript serializer (rework-contracts.md §5).
 *
 * - `## user` / `## assistant` headers carry full text.
 * - Thinking blocks are elided entirely.
 * - Each toolCall collapses with its toolResult into ONE `→ name(…) ⇒ …`
 *   line (ok and error variants); result bodies are never dumped.
 * - Custom messages render as one-liners (`[irc] from → me: …`).
 * - No system prompt / tool catalog sections.
 */
import { describe, expect, it } from "bun:test";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function buildMessages(): unknown[] {
	return [
		{ role: "user", content: "Please read the config.", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET-THOUGHT about the approach" },
				{ type: "text", text: "Reading it now." },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/config.ts" } },
				{ type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "bun test" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "tc-2",
			toolName: "bash",
			content: [{ type: "text", text: "FAIL: 1 test failed" }],
			isError: true,
			timestamp: 4,
		},
		{
			role: "custom",
			customType: "irc:incoming",
			content: "full rendered irc prompt that must not appear",
			details: { from: "Main", message: "status update please" },
			timestamp: 5,
		},
	];
}

describe("formatSessionHistoryMarkdown", () => {
	it("renders role headers, collapses tool pairs to one line, and elides thinking", () => {
		const output = formatSessionHistoryMarkdown(buildMessages());

		expect(output).toContain("## user");
		expect(output).toContain("Please read the config.");
		expect(output).toContain("## assistant");
		expect(output).toContain("Reading it now.");

		// Thinking is elided entirely.
		expect(output).not.toContain("SECRET-THOUGHT");

		// Tool call + result collapse to one line each; bodies are not dumped.
		expect(output).toContain("→ read(src/config.ts) ⇒ ok · 3 lines");
		expect(output).not.toContain("const a = 1;");

		// Error variant carries the first line of the error output.
		expect(output).toContain("→ bash(bun test) ⇒ error · 1 line — FAIL: 1 test failed");

		// Consumed toolResults do not render a second orphan line.
		const toolLines = output.split("\n").filter(line => line.startsWith("→ "));
		expect(toolLines).toHaveLength(2);

		// Custom messages are one-liners; the rendered prompt body is dropped.
		expect(output).toContain("[irc] Main → me: status update please");
		expect(output).not.toContain("full rendered irc prompt");

		// Concise transcript: no prompt/tool-catalog sections.
		expect(output).not.toContain("System Prompt");
		expect(output).not.toContain("Available Tools");
	});

	it("prefixes an H1 title when requested", () => {
		const output = formatSessionHistoryMarkdown(buildMessages(), { title: "Spawnling (idle)" });
		expect(output.startsWith("# Spawnling (idle)\n")).toBe(true);
	});

	it("renders watched roles using bold text rather than level-2 headers when watchedRoles is true", () => {
		const output = formatSessionHistoryMarkdown(buildMessages(), { watchedRoles: true });
		expect(output).toContain("**user**:");
		expect(output).toContain("**agent**:");
		expect(output).not.toContain("## user");
		expect(output).not.toContain("## assistant");
	});

	it("renders an orphan toolResult (truncated history) as its own line", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "toolResult",
				toolCallId: "tc-orphan",
				toolName: "grep",
				content: [{ type: "text", text: "one match" }],
				isError: false,
				timestamp: 1,
			},
		]);
		expect(output).toContain("→ grep() ⇒ ok · 1 line");
	});

	it("uses retained async-progress details instead of truncating the model-facing XML prefix", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "custom",
				customType: "async-progress",
				content: '<job-progress id="bash_1" type="bash" elapsed="1s"><output>unhelpful XML body</output>',
				details: {
					jobs: [
						{
							jobId: "bash_1",
							text: "tick 12\ntick 13",
							truncated: true,
							suppressedEvents: 4,
							artifactId: "art-9",
						},
					],
				},
				timestamp: 1,
			},
		]);

		expect(output).toContain("bash_1: tick 12 tick 13");
		expect(output).toContain("[4 progress events suppressed]");
		expect(output).toContain("[full output: artifact://art-9]");
		expect(output).not.toContain("<job-progress");
	});

	it("keeps both ends of a bounded async-progress head/tail split", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "custom",
				customType: "async-progress",
				content: "",
				details: {
					jobs: [
						{
							jobId: "bash_2",
							head: `first ${"a".repeat(300)}`,
							tail: `last ${"z".repeat(300)}`,
							truncated: true,
							artifactId: "art-10",
						},
					],
				},
				timestamp: 1,
			},
		]);
		const progressLine = output.split("\n").find(line => line.startsWith("[async-progress]"));
		if (!progressLine) throw new Error("Expected async-progress history line");

		expect(progressLine).toContain("bash_2: first ");
		expect(progressLine).toContain(" … last ");
		expect(progressLine).toContain("[full output: artifact://art-10]");
		expect(progressLine.length).toBeLessThan(250);
	});

	it("renders find paths without falling back to JSON arguments", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-glob",
						name: "glob",
						arguments: { path: "packages/coding-agent/src/**/*.ts" },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-glob",
				toolName: "glob",
				content: [{ type: "text", text: "session-history-format.ts" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("→ glob(packages/coding-agent/src/**/*.ts) ⇒ ok · 1 line");
		expect(output).not.toContain('{"paths"');
	});

	it("renders search path scope alongside the pattern", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-grep",
						name: "grep",
						arguments: { pattern: "PRIMARY_ARG_KEYS", path: "packages/coding-agent/src/session" },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-grep",
				toolName: "grep",
				content: [{ type: "text", text: "timed out" }],
				isError: true,
				timestamp: 2,
			},
		]);

		expect(output).toContain(
			"→ grep(PRIMARY_ARG_KEYS @ packages/coding-agent/src/session) ⇒ error · 1 line — timed out",
		);
	});

	it("keeps the ast_grep pattern visible instead of only its paths scope", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-astgrep",
						name: "ast_grep",
						arguments: { pat: "console.log($$$)", path: "packages/coding-agent/src/**/*.ts" },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-astgrep",
				toolName: "ast_grep",
				content: [{ type: "text", text: "match" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("→ ast_grep(console.log($$$)) ⇒ ok · 1 line");
	});

	it("keeps the ast_edit op pattern visible instead of only its paths scope", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-astedit",
						name: "ast_edit",
						arguments: {
							ops: [{ pat: "oldApi($$$A)", out: "newApi($$$A)" }],
							paths: ["packages/coding-agent/src/**/*.ts"],
						},
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-astedit",
				toolName: "ast_edit",
				content: [{ type: "text", text: "1 change" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("oldApi($$$A)");
		expect(output).not.toContain("→ ast_edit(packages/coding-agent/src/**/*.ts)");
	});

	it("renders tool intent comments immediately before tool call lines when includeToolIntent is true", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-intent",
						name: "read",
						arguments: { path: "src/config.ts", [INTENT_FIELD]: "reading config file" },
					},
					{
						type: "toolCall",
						id: "tc-long-intent",
						name: "read",
						arguments: {
							path: "src/config.ts",
							[INTENT_FIELD]:
								"reading config file with a very very long and descriptive intent that will exceed the maximum length limit of eighty characters",
						},
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "tc-intent",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
			{
				role: "toolResult",
				toolCallId: "tc-long-intent",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		];

		const outputWithIntent = formatSessionHistoryMarkdown(messages, { includeToolIntent: true });
		expect(outputWithIntent).toContain("// reading config file\n→ read(src/config.ts) ⇒ ok · 1 line");
		// The long intent should be flattened to one line and truncated to 80 characters (including ellipsis).
		expect(outputWithIntent).toContain(
			"// reading config file with a very very long and descriptive intent that will exce…\n→ read(src/config.ts) ⇒ ok · 1 line",
		);

		const outputWithoutIntent = formatSessionHistoryMarkdown(messages);
		expect(outputWithoutIntent).not.toContain("// reading config file");
		expect(outputWithoutIntent).toContain("→ read(src/config.ts) ⇒ ok · 1 line");
	});
	it("summarizes advise tool calls by their note and severity", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-advise-1",
						name: "advise",
						// Severity is intentionally placed before note so the test proves
						// PRIMARY_ARG_KEYS / the special-case picks the note, not insertion order.
						arguments: { severity: "concern", note: "Avoid shadowing the outer variable." },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-advise-1",
				toolName: "advise",
				content: [{ type: "text", text: "Recorded." }],
				isError: false,
				timestamp: 2,
			},
		];

		const output = formatSessionHistoryMarkdown(messages);
		expect(output).toContain("→ advise(concern: Avoid shadowing the outer variable.) ⇒ ok · 1 line");
		expect(output).not.toContain("Recorded.");
	});

	it("attributes a user bang command to the user, not the preceding agent turn", () => {
		const delta = [
			{
				role: "assistant",
				content: [{ type: "text", text: "It's safe to remove it. I'd run `rm -rf .wt/foo` but will stop here." }],
				stopReason: "endTurn",
				timestamp: 1,
			},
			{
				role: "bashExecution",
				command: "rm -rf .wt/foo",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: false,
				timestamp: 2,
			},
			{ role: "user", content: "Done!", timestamp: 3 },
		];

		const output = formatSessionHistoryMarkdown(delta, { watchedRoles: true });

		// The execution line is prefixed `user-bash!` and sits under a `**user**:`
		// label, not trailing the `**agent**:` block, so the advisor cannot read
		// the user-run command as an agent action.
		expect(output).toContain("→ user-bash! rm -rf .wt/foo ⇒ ok · 0 lines");
		const agentIdx = output.indexOf("**agent**:");
		const userIdx = output.indexOf("**user**:");
		const execIdx = output.indexOf("→ user-bash!");
		expect(agentIdx).toBeGreaterThanOrEqual(0);
		expect(userIdx).toBeGreaterThan(agentIdx);
		expect(execIdx).toBeGreaterThan(userIdx);
	});

	it("prefixes a user python bang execution with user-python in watched mode", () => {
		const output = formatSessionHistoryMarkdown(
			[
				{
					role: "pythonExecution",
					code: "print(1)",
					output: "1",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			],
			{ watchedRoles: true },
		);
		expect(output).toContain("**user**:");
		expect(output).toContain("→ user-python! print(1) ⇒ ok · 1 line");
	});

	it("keeps the bare user-prefixed line without a role label outside watched mode", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [{ type: "text", text: "Recommending cleanup." }],
				stopReason: "endTurn",
				timestamp: 1,
			},
			{
				role: "bashExecution",
				command: "rm -rf .wt/foo",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			},
		]);
		expect(output).toContain("→ user-bash! rm -rf .wt/foo ⇒ ok · 0 lines");
		expect(output).not.toContain("**user**:");
		expect(output).toContain("## assistant");
	});
});
