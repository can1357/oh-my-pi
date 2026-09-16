/**
 * Regression: `/mcp refresh` renders each server's `tools/list` failure into
 * the TUI. The error string is transport-controlled — a malicious or merely
 * chatty server can embed tabs and newlines, which punch visual holes across
 * status rows and let one server's error overflow the block. Both the
 * partial-failure branch and the all-failed branch must normalize the error
 * (strip control chars, collapse newlines to spaces, replace tabs, bound
 * width) before it reaches the transcript.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MCPRefreshOutcome } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Component } from "@oh-my-pi/pi-tui";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

interface Harness {
	controller: MCPCommandController;
	/** Plain-text (ANSI-stripped) render of whatever reached the transcript. */
	rendered(): string;
	/** Plain-text of the last showError call, if any. */
	errored(): string | undefined;
}

function makeHarness(outcomes: MCPRefreshOutcome[], rebindError?: Error): Harness {
	const presented: Component[] = [];
	let lastError: string | undefined;
	const connected = outcomes.map(o => o.name);
	const ctx = {
		mcpManager: {
			getConnectedServers: () => connected,
			refreshAllTools: () => Promise.resolve(outcomes),
			getTools: () => [],
		},
		session: {
			refreshMCPTools: () => (rebindError ? Promise.reject(rebindError) : Promise.resolve()),
		},
		presentCommandOutput: (content: Component | readonly Component[]) => {
			if (Array.isArray(content)) presented.push(...content);
			else presented.push(content as Component);
		},
		showError: (message: string) => {
			lastError = message;
		},
	} as unknown as InteractiveModeContext;

	return {
		controller: new MCPCommandController(ctx),
		rendered: () => Bun.stripANSI(presented.map(c => c.render(160).join("\n")).join("\n")),
		errored: () => (lastError === undefined ? undefined : Bun.stripANSI(lastError)),
	};
}

const TAB_ERROR = "boom\ttab\tseparated";
const NEWLINE_ERROR = "line-one\nline-two\rline-three";
// Wider than TRUNCATE_LENGTHS.LINE (110) so truncation is observable.
const LONG_ERROR = `overflow-${"x".repeat(300)}-end`;

describe("/mcp refresh error rendering normalizes transport-controlled errors", () => {
	it("partial-failure branch strips tabs and collapses newlines before rendering", async () => {
		const harness = makeHarness([
			{ name: "healthy", ok: true },
			{ name: "warmup", ok: false, error: `${TAB_ERROR} ${NEWLINE_ERROR}` },
		]);

		await harness.controller.handle("/mcp refresh");

		const out = harness.rendered();
		expect(out).toContain("1 server(s) failed to refresh");
		// The raw error had a literal tab and CR/LF — neither may survive.
		expect(out).not.toContain("\t");
		expect(out).not.toContain("\n\nline-two");
		expect(out).toContain("line-one line-two line-three");
		expect(out).toContain("boom   tab   separated");
	});

	it("partial-failure branch bounds an overlong error to the standard width", async () => {
		const harness = makeHarness([
			{ name: "healthy", ok: true },
			{ name: "warmup", ok: false, error: LONG_ERROR },
		]);

		await harness.controller.handle("/mcp refresh");

		const out = harness.rendered();
		// The line carrying the error must not contain the full 300-char payload.
		const errorRow = out.split("\n").find(line => line.includes("warmup:")) ?? "";
		expect(errorRow.length).toBeLessThan(LONG_ERROR.length);
		expect(errorRow).toContain("overflow-");
		expect(errorRow).not.toContain(`${"x".repeat(300)}`);
	});

	it("shortens an absolute home path in a server error", async () => {
		// A server error can embed a path under the user's home directory; the
		// status-row pipeline already shortens these, and this one must too.
		const home = os.homedir();
		const harness = makeHarness([
			{ name: "warmup", ok: false, error: `cannot read ${path.join(home, "secrets", "mcp.json")}` },
		]);

		await harness.controller.handle("/mcp refresh");

		const out = `${harness.rendered()}${harness.errored() ?? ""}`;
		// RED (pre-fix): the full home path reached the transcript.
		expect(out).not.toContain(home);
		expect(out).toContain("~/secrets/mcp.json");
	});

	it("bounds the complete error row including its label prefix", async () => {
		// Truncating only the payload and then prepending "Failed to refresh MCP
		// tools: " left the row wider than the cap by the label's own width. The
		// The per-server rows are indented by these same call sites, so their
		// indentation comes out of the same budget — see the tests below.
		const thrown = makeHarness([{ name: "warmup", ok: true }], new Error(LONG_ERROR));
		await thrown.controller.handle("/mcp refresh");
		const errorRow = thrown.errored() ?? "";
		expect(errorRow).toContain("Failed to refresh MCP tools:");
		expect(visibleWidth(errorRow.trimEnd())).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});

	it("counts the row indentation against the width cap", async () => {
		// `#formatRefreshFailureRow` spent the whole budget, then the call site
		// prepended four spaces (two in the all-failed branch) — so the row's own
		// visible width came out over the cap by the indent and could overflow.
		//
		// The transcript component pads every line it renders by one column, so
		// that frame column is stripped before measuring: the cap governs the row
		// this controller produces, not the frame around it.
		const partial = makeHarness([
			{ name: "healthy", ok: true },
			{ name: "warmup", ok: false, error: LONG_ERROR },
		]);
		await partial.controller.handle("/mcp refresh");
		const indentedRow = (
			partial
				.rendered()
				.split("\n")
				.find(line => line.includes("warmup:")) ?? ""
		).replace(/^ /, "");
		expect(indentedRow).toMatch(/^ {4}warmup:/);
		// RED (pre-fix): 114 — the cap plus the four-space indent.
		expect(visibleWidth(indentedRow.trimEnd())).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);

		// `showError` is not rendered through the component, so it carries no pad.
		const all = makeHarness([{ name: "warmup", ok: false, error: LONG_ERROR }]);
		await all.controller.handle("/mcp refresh");
		const allRow = (all.errored() ?? "").split("\n").find(line => line.includes("warmup:")) ?? "";
		expect(allRow).toMatch(/^ {2}warmup:/);
		// RED (pre-fix): 112 — the cap plus the two-space indent.
		expect(visibleWidth(allRow.trimEnd())).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});

	it("all-failed branch also normalizes each server error", async () => {
		const harness = makeHarness([
			{ name: "alpha", ok: false, error: TAB_ERROR },
			{ name: "beta", ok: false, error: NEWLINE_ERROR },
		]);

		await harness.controller.handle("/mcp refresh");

		const message = harness.errored();
		expect(message).toBeDefined();
		expect(message).toContain("Failed to refresh MCP tools from all 2 connected servers");
		expect(message).not.toContain("\t");
		// The per-server error lines collapse their own newlines to spaces; the
		// only newlines left are the deliberate `\n` joins between server rows.
		expect(message).toContain("alpha: boom   tab   separated");
		expect(message).toContain("beta: line-one line-two line-three");
	});

	it("partial-failure branch sanitizes a control-laden server name", async () => {
		const harness = makeHarness([
			{ name: "healthy", ok: true },
			{ name: "evil\tname\nwith\rcontrol", ok: false, error: "boom" },
		]);

		await harness.controller.handle("/mcp refresh");

		const out = harness.rendered();
		expect(out).toContain("1 server(s) failed to refresh");
		// The server-controlled name carried a tab, LF, and CR — none may reach
		// the transcript to punch holes across rows.
		const errorRow = out.split("\n").find(line => line.includes("boom")) ?? "";
		expect(errorRow).not.toContain("\t");
		expect(errorRow).not.toContain("\r");
		expect(errorRow).toContain("evil");
		expect(errorRow).toContain("control: boom");
	});

	it("all-failed branch sanitizes and bounds each server name", async () => {
		const longName = `alpha-${"z".repeat(300)}-end`;
		const harness = makeHarness([
			{ name: "beta\tname", ok: false, error: "boom" },
			{ name: longName, ok: false, error: "boom" },
		]);

		await harness.controller.handle("/mcp refresh");

		const message = harness.errored() ?? "";
		expect(message).toContain("Failed to refresh MCP tools from all 2 connected servers");
		expect(message).not.toContain("\t");
		// The overlong name row is truncated below the raw name length.
		const longRow = message.split("\n").find(line => line.includes("alpha-")) ?? "";
		expect(longRow.length).toBeLessThan(longName.length);
		expect(longRow).not.toContain(`${"z".repeat(300)}`);
	});

	it("final rebind failure is sanitized and truncated like a per-server error", async () => {
		// After the per-server `tools/list` refreshes, `/mcp refresh` rebinds the
		// results into the session via `session.refreshMCPTools`. When THAT
		// rejects, the catch used to pass the raw error straight to showError,
		// bypassing the sanitize+tab-replace+truncate applied to per-server
		// rows — a rebind error carrying tabs, newlines, control chars, or an
		// overlong payload would corrupt or overflow the TUI. It must go through
		// the same normalization.
		const rawMessage = `${TAB_ERROR} ${NEWLINE_ERROR} ${LONG_ERROR}`;
		const harness = makeHarness([{ name: "healthy", ok: true }], new Error(rawMessage));

		await harness.controller.handle("/mcp refresh");

		const message = harness.errored();
		expect(message).toBeDefined();
		expect(message).toContain("Failed to refresh MCP tools:");
		// Tabs, CR, and LF from the raw error must not survive.
		expect(message).not.toContain("\t");
		expect(message).not.toContain("\r");
		expect(message).not.toContain("\n");
		expect(message).toContain("boom   tab   separated");
		expect(message).toContain("line-one line-two line-three");
		// The overlong payload is bounded to the standard width.
		expect(message?.length).toBeLessThan(rawMessage.length);
		expect(message).not.toContain(`${"x".repeat(300)}`);
	});
});
