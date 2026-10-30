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
	const base = { taskBatch: true, scoutAvailable: true, evalTools: true, py: true, js: true, freshAgents: false };

	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice(base);
		const disabled = renderWorkflowNotice({ ...base, evalTools: false });
		expect(enabled).toContain("Default to `workpool()`");
		expect(enabled).toContain("`@tool`");
		expect(disabled).toContain("Default to `workpool()`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});

	it("describes the pool dispatch mode the session will actually use", () => {
		const reused = renderWorkflowNotice(base);
		const fresh = renderWorkflowNotice({ ...base, freshAgents: true });
		expect(reused).toContain("keep-alive workers");
		expect(fresh).toContain("single-item agents");
		expect(fresh).not.toContain("keep-alive");
		expect(reused).not.toContain("single-item");
	});

	it("shows only the active eval runtime's call forms", () => {
		const pyOnly = renderWorkflowNotice({ ...base, js: false });
		const jsOnly = renderWorkflowNotice({ ...base, py: false });
		const both = renderWorkflowNotice(base);

		expect(pyOnly).toContain("schema_mode=None");
		expect(pyOnly).not.toContain("```js");
		expect(pyOnly).not.toContain("raiseErrors");
		expect(pyOnly).not.toContain("JS:");

		expect(jsOnly).toContain("await workpool(");
		expect(jsOnly).toContain("schemaMode?");
		expect(jsOnly).not.toContain("```python");
		expect(jsOnly).not.toContain("raise_errors");
		expect(jsOnly).not.toContain("@tool");
		expect(jsOnly).not.toContain("JS:");

		expect(both).toContain("```python");
		expect(both).toContain("```js");
		expect(both).toContain("JS: `await workpool(");
		expect(both).toContain("raise_errors");
		expect(both).toContain("raiseErrors");
	});
});
