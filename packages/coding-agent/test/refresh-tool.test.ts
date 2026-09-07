import { describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { RefreshResult, RefreshScope } from "@oh-my-pi/pi-coding-agent/extensibility/reload";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { requiresApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { RefreshTool, summarizeRefresh } from "@oh-my-pi/pi-coding-agent/tools/refresh";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

// summarizeRefresh renders a live refresh into the one-line operator summary.
// It is the sole surface the `/refresh` command and the RefreshTool print, so
// each field's rendering (and the empty → "nothing to reload" fallback) is a
// contract every caller depends on.
describe("summarizeRefresh", () => {
	it("renders skills and rules counts", () => {
		const result: RefreshResult = { skills: 12, rules: 7 };
		expect(summarizeRefresh("skills", result)).toBe("Refreshed (skills): 12 skills, 7 rules.");
	});

	it("renders a changed settings reload as 'settings updated'", () => {
		expect(summarizeRefresh("settings", { settingsChanged: true })).toBe("Refreshed (settings): settings updated.");
	});

	it("renders a no-op settings reload as 'settings unchanged'", () => {
		expect(summarizeRefresh("settings", { settingsChanged: false })).toBe(
			"Refreshed (settings): settings unchanged.",
		);
	});

	it("renders a model swap only when modelSwapped is true", () => {
		expect(summarizeRefresh("settings", { settingsChanged: true, modelSwapped: true })).toBe(
			"Refreshed (settings): settings updated, model swapped.",
		);
		// A falsy modelSwapped must NOT contribute a part.
		expect(summarizeRefresh("settings", { settingsChanged: true, modelSwapped: false })).toBe(
			"Refreshed (settings): settings updated.",
		);
	});

	it("renders an MCP reconnect only when mcp is set", () => {
		expect(summarizeRefresh("mcp", { mcp: true })).toBe("Refreshed (mcp): MCP reconnected.");
		// `mcp` is `true | undefined` (never literal false); an untouched MCP surface omits the field.
		expect(summarizeRefresh("mcp", {})).toBe("Refreshed (mcp): nothing to reload.");
	});

	it("renders MCP reconnect errors when servers fail", () => {
		// Pre-fix: refresh discarded the load result, so a failed reconnect still
		// rendered a bare "MCP reconnected" with no failure detail.
		expect(summarizeRefresh("mcp", { mcp: true, mcpErrors: new Map([["broken", "ECONNREFUSED"]]) })).toBe(
			"Refreshed (mcp): MCP reconnected with 1 error(s) (broken: ECONNREFUSED).",
		);
		// An empty error map is treated as success (no failures to surface).
		expect(summarizeRefresh("mcp", { mcp: true, mcpErrors: new Map() })).toBe("Refreshed (mcp): MCP reconnected.");
	});

	it("sanitizes and bounds hostile MCP failure text in the summary", () => {
		// A server name and error carrying a tab, CR/LF, and an over-long payload
		// must not reach the TUI verbatim (they corrupt/overflow the status row);
		// summarizeRefresh routes each failure through the same sanitize+truncate
		// helper the MCP connection-status rows use.
		const hostileError = `boom\thard\r\nsecond line ${"x".repeat(500)}`;
		const summary = summarizeRefresh("mcp", {
			mcp: true,
			mcpErrors: new Map([[`srv\tname`, hostileError]]),
		});
		// Pre-fix (raw `${server}: ${error}` interpolation) these leaked straight through.
		expect(summary).not.toContain("\t");
		expect(summary).not.toContain("\r");
		expect(summary).not.toContain("\n");
		expect(summary.length).toBeLessThan(hostileError.length);
	});

	it("bounds the assembled failure summary width for many failed servers", () => {
		// Per-entry sanitization caps each failure, but the JOINED line of every
		// failed server was never capped — with many servers it spans thousands of
		// columns and is passed verbatim to the tool result and the `/refresh` TUI.
		const mcpErrors = new Map<string, string>();
		for (let i = 0; i < 60; i++) {
			mcpErrors.set(`server-${i}`, "ECONNREFUSED");
		}
		const summary = summarizeRefresh("mcp", { mcp: true, mcpErrors });
		// The parenthesized detail (the join of all failed-server entries) must be
		// capped at the standard single-line width. Pre-fix (no cap on the join)
		// the detail ran the full concatenation of all 60 entries.
		const detail = summary.match(/error\(s\) \((.*)\)\.$/)?.[1] ?? "";
		expect(detail.length).toBeGreaterThan(0);
		expect(detail.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});

	it("renders every surface for an 'all' refresh", () => {
		const result: RefreshResult = {
			skills: 3,
			rules: 4,
			settingsChanged: true,
			modelSwapped: true,
			mcp: true,
		};
		expect(summarizeRefresh("all", result)).toBe(
			"Refreshed (all): 3 skills, 4 rules, settings updated, model swapped, MCP reconnected.",
		);
	});

	it("falls back to 'nothing to reload' for an empty result", () => {
		expect(summarizeRefresh("all", {})).toBe("Refreshed (all): nothing to reload.");
	});

	it("distinguishes a zero count from an untouched surface", () => {
		// 0 skills is a real reload outcome (all skills removed); it must render,
		// not collapse into "nothing to reload".
		expect(summarizeRefresh("skills", { skills: 0, rules: 0 })).toBe("Refreshed (skills): 0 skills, 0 rules.");
	});
});

// A minimal ToolSession carrying only what RefreshTool reads: `refresh`.
function toolSession(refresh?: ToolSession["refresh"]): ToolSession {
	return {
		cwd: "/tmp/refresh-tool-test",
		hasUI: false,
		refresh,
	} as unknown as ToolSession;
}

describe("RefreshTool.execute", () => {
	it("forwards the requested scope to session.refresh and returns the summary + details", async () => {
		const result: RefreshResult = { skills: 5, rules: 2 };
		const refresh = vi.fn(async (_scope: RefreshScope) => result);
		const tool = new RefreshTool(toolSession(refresh));

		const out = await tool.execute("call-1", { scope: "skills" });

		expect(refresh).toHaveBeenCalledWith("skills");
		expect(out.isError).toBeUndefined();
		expect(out.content).toEqual([{ type: "text", text: "Refreshed (skills): 5 skills, 2 rules." }]);
		expect(out.details).toEqual({ scope: "skills", result });
	});

	it("defaults to the 'all' scope when none is supplied", async () => {
		const refresh = vi.fn(async (_scope: RefreshScope) => ({ settingsChanged: false }) as RefreshResult);
		const tool = new RefreshTool(toolSession(refresh));

		const out = await tool.execute("call-2", {});

		expect(refresh).toHaveBeenCalledWith("all");
		expect(out.details?.scope).toBe("all");
	});

	it("returns an error result naming 'unavailable' when the session cannot refresh", async () => {
		const tool = new RefreshTool(toolSession(undefined));

		const out = await tool.execute("call-3", { scope: "all" });

		expect(out.isError).toBe(true);
		expect(out.content).toEqual([{ type: "text", text: "Refresh is unavailable in this session." }]);
		expect(out.details).toEqual({ scope: "all", result: {} });
	});
});

// Security: refresh("mcp"/"all") reconnects MCP, spawning a project `.mcp.json`
// stdio server's command as a subprocess (arbitrary exec). As a
// model-discoverable tool it must be tiered "exec" so it does NOT auto-run in
// always-ask/write approval modes — a prompt-injected repo could otherwise
// self-invoke refresh("mcp") to run project config ungated. Pre-fix: "read".
describe("RefreshTool approval tier", () => {
	it("is tiered 'exec' so it never auto-runs in always-ask/write modes", () => {
		const tool = new RefreshTool(toolSession(vi.fn(async (_scope: RefreshScope) => ({}) as RefreshResult)));
		expect(tool.approval).toBe("exec");
	});

	// The tier is only load-bearing through the approval gate: bind the real tool
	// to requiresApproval and assert the observable outcome. In always-ask and
	// write modes the exec tier forces a prompt (no auto-run); yolo still allows.
	// Pre-fix (read tier) always-ask/write would auto-allow → required:false.
	it("forces an approval prompt in always-ask and write modes, auto-allows only in yolo", () => {
		const tool = new RefreshTool(toolSession(vi.fn(async (_scope: RefreshScope) => ({}) as RefreshResult)));
		expect(requiresApproval(tool, { scope: "mcp" }, "always-ask").required).toBe(true);
		expect(requiresApproval(tool, { scope: "mcp" }, "write").required).toBe(true);
		expect(requiresApproval(tool, { scope: "mcp" }, "yolo").required).toBe(false);
	});
});

// The `/refresh [scope]` builtin validates its argument against the known scope
// list before ever calling session.refresh, and prints summarizeRefresh on
// success. Driven through the ACP dispatcher (the smallest real command surface
// with a test precedent — see compact.test.ts / shake.test.ts).
function commandRuntime(refresh?: (scope: RefreshScope) => Promise<RefreshResult>) {
	const session = { refresh } as unknown as SlashCommandRuntime["session"];
	const output = vi.fn(async (_text: string) => {});
	const runtime = { session, output } as unknown as SlashCommandRuntime;
	return { refresh, output, runtime };
}

describe("/refresh scope validation", () => {
	it("rejects an unknown scope with a usage error naming the valid scopes and never calls refresh", async () => {
		const refresh = vi.fn(async (_scope: RefreshScope) => ({}) as RefreshResult);
		const h = commandRuntime(refresh);

		const result = await executeAcpBuiltinSlashCommand("/refresh bogus", h.runtime);

		expect(refresh).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		const message = (h.output.mock.calls[0]?.[0] as string) ?? "";
		expect(message).toContain('Unknown refresh scope "bogus"');
		expect(message).toContain("skills, rules, settings, mcp, all");
	});

	it("accepts a valid scope, calls refresh with it, and prints the summary", async () => {
		const refresh = vi.fn(async (_scope: RefreshScope) => ({ skills: 9, rules: 1 }) as RefreshResult);
		const h = commandRuntime(refresh);

		await executeAcpBuiltinSlashCommand("/refresh skills", h.runtime);

		expect(refresh).toHaveBeenCalledWith("skills");
		expect(h.output).toHaveBeenCalledWith("Refreshed (skills): 9 skills, 1 rules.");
	});

	it("defaults a bare /refresh to the 'all' scope", async () => {
		const refresh = vi.fn(async (_scope: RefreshScope) => ({ settingsChanged: false }) as RefreshResult);
		const h = commandRuntime(refresh);

		await executeAcpBuiltinSlashCommand("/refresh", h.runtime);

		expect(refresh).toHaveBeenCalledWith("all");
	});
});

// A settings reload throws with the absolute config path plus raw YAML-parser
// content (tabs, newlines, long lines). The `/refresh` failure branch must run
// that message through the shared render sanitizers before handing it to the
// TUI, so the home directory is shortened to `~` and control characters / width
// can never break the renderer.
describe("/refresh failure sanitization", () => {
	it("shortens the home path, strips tabs/newlines, and truncates the reload error", async () => {
		const home = os.homedir();
		const configPath = `${home}/.config/omp/config.yml`;
		// Mimic a real malformed-YAML reload throw: the absolute config path plus
		// a multiline parser message carrying a tab and an oversized line.
		const longToken = "x".repeat(400);
		const err = new Error(
			`Settings config is invalid: ${configPath}: YAMLParseError: bad indentation\n\tat line 3: ${longToken}`,
		);
		const refresh = vi.fn(async (_scope: RefreshScope) => {
			throw err;
		});
		const h = commandRuntime(refresh);

		const result = await executeAcpBuiltinSlashCommand("/refresh settings", h.runtime);

		expect(result).toEqual({ consumed: true });
		const message = (h.output.mock.calls[0]?.[0] as string) ?? "";
		expect(message).toStartWith("Refresh failed: ");
		// Home path shortened to ~ — the absolute home directory never leaks.
		expect(message).not.toContain(home);
		expect(message).toContain("~/.config/omp/config.yml");
		// Tabs and newlines are gone: a single renderable line.
		expect(message).not.toContain("\t");
		expect(message).not.toContain("\n");
		// Width is capped, so the 400-char token cannot spill across the TUI. The
		// sanitized body is truncated to the line width; the "Refresh failed: "
		// prefix is the command's own constant framing.
		const body = message.replace(/^Refresh failed: /, "");
		expect(body.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		expect(message).not.toContain(longToken);
	});

	it("strips ANSI escapes and other terminal control bytes from the reload error", async () => {
		// A YAML-parser or filesystem error can carry terminal control bytes
		// verbatim. The whitespace replacements handle none of these, so without
		// the shared `sanitizeText` they ride through into `runtime.output`: SGR
		// sequences recolor the line, a cursor-position sequence repositions the
		// caret, and a bare `\x07`/`\x1b[2J` can clear or beep the terminal —
		// enough to spoof or corrupt the TUI from repo-controlled config content.
		const err = new Error(
			"Settings config is invalid: \x1b[31mFAKE ERROR\x1b[0m \x1b[2J\x1b[1;1Hspoofed prompt\x07\x08 tail",
		);
		const refresh = vi.fn(async (_scope: RefreshScope) => {
			throw err;
		});
		const h = commandRuntime(refresh);

		const result = await executeAcpBuiltinSlashCommand("/refresh settings", h.runtime);

		expect(result).toEqual({ consumed: true });
		const message = (h.output.mock.calls[0]?.[0] as string) ?? "";
		expect(message).toStartWith("Refresh failed: ");
		// No ESC introducer survives, so no escape sequence can be reassembled.
		expect(message).not.toContain("\x1b");
		// Nor any residual C0/C1 control byte (BEL, BS, and the rest), which the
		// tab/newline replacements never matched.
		expect(message).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		// The human-readable payload is preserved — sanitizing strips the control
		// bytes, it does not blank the diagnostic.
		expect(message).toContain("Settings config is invalid");
		expect(message).toContain("FAKE ERROR");
		expect(message).toContain("spoofed prompt");
		expect(message).toEndWith("tail");
	});
});
