import { describe, expect, it } from "bun:test";
import {
	MAGIC_KEYWORDS,
	renderOrchestrateNotice,
	renderWorkflowNotice,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";

describe("magic keyword registry", () => {
	it("keeps ids and words unique so notice types and settings keys cannot collide", () => {
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.id)).size).toBe(MAGIC_KEYWORDS.length);
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.word)).size).toBe(MAGIC_KEYWORDS.length);
	});
});

describe("orchestrate notice", () => {
	it("is a self-contained system notice carrying the orchestration contract", () => {
		const notice = renderOrchestrateNotice({
			tools: ["read", "task", "edit", "write", "lsp", "bash", "todo"],
		});
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice.endsWith("</system-notice>")).toBe(true);
		expect(notice).toContain("orchestrator");
		// The contract must not retain the slash-command input placeholder.
		expect(notice).not.toContain("$@");
	});

	it("omits tool-budget mentions for tools absent from the session", () => {
		const notice = renderOrchestrateNotice({ tools: ["read"] });
		expect(notice).not.toContain("`task` for dispatch");
		expect(notice).not.toContain("`edit`");
		expect(notice).not.toContain("`write`");
		expect(notice).not.toContain("`lsp diagnostics`");
		expect(notice).not.toContain("via `bash`");
		expect(notice).not.toContain("`todo` for tracking");
	});

	it("does not name edit when only write is available", () => {
		const writeOnly = renderOrchestrateNotice({ tools: ["read", "write"] });
		expect(writeOnly).toContain("with `write`");
		expect(writeOnly).not.toContain("`edit`/`write`");
		expect(writeOnly).not.toContain("with `edit`");
	});

	it("does not name write when only edit is available", () => {
		const editOnly = renderOrchestrateNotice({ tools: ["read", "edit"] });
		expect(editOnly).toContain("with `edit`");
		expect(editOnly).not.toContain("`edit`/`write`");
	});
});

describe("workflow notice", () => {
	const base = {
		tools: ["task", "eval", "wait"],
		taskBatch: true,
		scoutAvailable: true,
		evalTools: true,
		py: true,
		js: true,
		evalDocTopics: {},
	};

	it("takes its helper reference verbatim from the eval tool's agents, judge, and helpers docs", () => {
		const notice = renderWorkflowNotice({
			...base,
			evalDocTopics: {
				helpers: "budget → `budget.total`",
				browser: "browser prelude doc",
				judge: 'judge(state, { images?: [path] }) → `{id: answer}` & "probabilities"',
				agents: "agent(prompt) → AgentHandle <dag>",
			},
		});
		// Unescaped, in reference order, and without prelude topics the workflow does not use.
		expect(notice).toContain(
			'agent(prompt) → AgentHandle <dag>\n\njudge(state, { images?: [path] }) → `{id: answer}` & "probabilities"\n\nbudget → `budget.total`',
		);
		expect(notice).not.toContain("browser prelude doc");
		expect(renderWorkflowNotice(base)).not.toContain("<helpers>");
	});

	it("suggests kernel-defined tools for shared pool state only when eval tools are enabled", () => {
		expect(renderWorkflowNotice(base)).toContain("`@tool` / `tool(fn)`");
		expect(renderWorkflowNotice({ ...base, py: false })).not.toContain("@tool");
		expect(renderWorkflowNotice({ ...base, evalTools: false })).not.toContain("tool(fn)");
	});

	it("points blocked callers at the wait tool only when the session has it", () => {
		expect(renderWorkflowNotice(base)).toContain("call the `wait` tool");
		expect(renderWorkflowNotice({ ...base, tools: ["task", "eval"] })).not.toContain("`wait` tool");
	});

	it("shows only the active eval runtime's call forms", () => {
		const pyOnly = renderWorkflowNotice({ ...base, js: false });
		const jsOnly = renderWorkflowNotice({ ...base, py: false });
		const both = renderWorkflowNotice(base);

		expect(pyOnly).toContain("review.push(*[");
		expect(pyOnly).not.toContain("```js");
		expect(pyOnly).not.toContain("JS:");

		expect(jsOnly).toContain("await review.push(");
		expect(jsOnly).not.toContain("```python");
		expect(jsOnly).not.toContain("JS:");

		expect(both).toContain("```python");
		expect(both).toContain("```js");
		expect(both).toContain("JS: `await` both.");
	});
});
