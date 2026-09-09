import { beforeAll, describe, expect, it } from "bun:test";
import {
	containsOrchestrate,
	highlightOrchestrate,
	renderOrchestrateNotice,
} from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { containsUltrathink, highlightUltrathink } from "@oh-my-pi/pi-coding-agent/modes/ultrathink";
import { clearBundledCommandsCache, loadBundledCommands } from "@oh-my-pi/pi-coding-agent/task/commands";

beforeAll(() => {
	// highlightOrchestrate/highlightUltrathink read the global theme's color mode.
	initTheme();
});

describe("orchestrate keyword detection", () => {
	it("matches the lowercase word delimited by whitespace or a string edge", () => {
		expect(containsOrchestrate("orchestrate")).toBe(true);
		expect(containsOrchestrate("please orchestrate this rollout")).toBe(true);
		expect(containsOrchestrate("orchestrate the rollout")).toBe(true);
		// A newline is whitespace, and end-of-string is a valid right boundary.
		expect(containsOrchestrate("do it now\norchestrate")).toBe(true);
	});

	it("matches the lowercase word beside prose punctuation and quotes", () => {
		for (const text of ["do it. orchestrate.", "please orchestrate, then report", 'say "orchestrate" now']) {
			expect(containsOrchestrate(text)).toBe(true);
		}
	});

	it("ignores casing, inflections, and path-embedded forms", () => {
		expect(containsOrchestrate("Orchestrate")).toBe(false);
		expect(containsOrchestrate("ORCHESTRATE")).toBe(false);
		expect(containsOrchestrate("orchestrated the build")).toBe(false);
		expect(containsOrchestrate("orchestrating now")).toBe(false);
		expect(containsOrchestrate("a clean orchestration")).toBe(false);
		expect(containsOrchestrate("it orchestrates well")).toBe(false);
		expect(containsOrchestrate("reorchestrate everything")).toBe(false);
		// A path/extension must not trigger even though sentence punctuation does.
		expect(containsOrchestrate("packages/coding-agent/src/modes/orchestrate.ts")).toBe(false);
		expect(containsOrchestrate("nothing to see here")).toBe(false);
	});

	it("ignores keywords inside code spans, fenced blocks, and XML sections", () => {
		expect(containsOrchestrate("use `orchestrate` here")).toBe(false);
		expect(containsOrchestrate("```\norchestrate\n```")).toBe(false);
		expect(containsOrchestrate("<note>orchestrate</note>")).toBe(false);
		// A real prose request alongside code still triggers.
		expect(containsOrchestrate("run `setup` then orchestrate the rollout")).toBe(true);
	});
});

describe("orchestrate keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const decorated = highlightOrchestrate("please orchestrate this");
		expect(decorated).not.toBe("please orchestrate this");
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe("please orchestrate this");
	});

	it("decorates punctuation-adjacent prose while preserving visible text", () => {
		const input = 'please "orchestrate," then continue';
		const decorated = highlightOrchestrate(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightOrchestrate("nothing here")).toBe("nothing here");
		// Probe hits the substring but token/path boundaries fail — no decoration.
		expect(highlightOrchestrate("orchestrated builds")).toBe("orchestrated builds");
		expect(highlightOrchestrate("Orchestrate this")).toBe("Orchestrate this");
		// The reported bug: a filename must not be painted.
		const filePath = "packages/coding-agent/src/modes/orchestrate.ts";
		expect(highlightOrchestrate(filePath)).toBe(filePath);
	});

	it("does not cross-trigger with the ultrathink highlighter", () => {
		expect(highlightOrchestrate("ultrathink")).toBe("ultrathink");
		expect(highlightUltrathink("orchestrate")).toBe("orchestrate");
		expect(containsUltrathink("orchestrate")).toBe(false);
		expect(containsOrchestrate("ultrathink")).toBe(false);
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

describe("orchestrate slash command removal", () => {
	it("is no longer bundled as a slash command", () => {
		clearBundledCommandsCache();
		const names = loadBundledCommands().map(command => command.name);
		expect(names).not.toContain("orchestrate");
		expect(names).toContain("init");
	});
});
