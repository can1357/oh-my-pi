import { describe, expect, it } from "bun:test";
import {
	type AgentsViewRow,
	type AgentsViewStatus,
	agentDisplayText,
	agentRowKey,
	agentsViewTitle,
	attentionTransitions,
	formatAgentCwd,
	formatRelativeTime,
	groupAgentRows,
	parseAgentsViewInput,
	resumeAction,
	snapshotAgentStatuses,
} from "../src/apps/agents-view-data";
import { truncateToWidth, visibleWidth } from "../src/utils";

let seq = 0;
function row(status: AgentsViewStatus, overrides: Partial<AgentsViewRow> = {}): AgentsViewRow {
	seq++;
	return {
		instanceId: `inst-${seq}`,
		hostKey: `agent-${seq}`,
		attachable: true,
		title: `session ${seq}`,
		cwd: "/work",
		status,
		lastActivityAt: 0,
		startedAt: seq,
		...overrides,
	};
}

describe("groupAgentRows", () => {
	it("orders groups Needs input → Error → Working → Idle and folds running/compacting/starting into Working", () => {
		const rows = [row("idle"), row("running"), row("error"), row("starting"), row("waiting"), row("compacting")];
		const groups = groupAgentRows(rows);
		expect(groups.map(group => group.label)).toEqual(["Needs input", "Error", "Working", "Idle"]);
		expect(groups[2].rows.map(entry => entry.status).sort()).toEqual(["compacting", "running", "starting"]);
	});

	it("drops empty groups and lists the newest session first, independent of activity", () => {
		const older = row("running", { startedAt: 100, lastActivityAt: 9_999 });
		const newer = row("running", { startedAt: 200, lastActivityAt: 1 });
		const groups = groupAgentRows([older, newer]);
		expect(groups.map(group => group.id)).toEqual(["working"]);
		expect(groups[0].rows).toEqual([newer, older]);
	});
});

describe("agentRowKey", () => {
	it("keeps a hosted session's identity when its status record appears after the bare daemon unit", () => {
		const unitOnly = row("starting", { instanceId: undefined, hostKey: "agent-x" });
		const withRecord = row("running", { instanceId: "inst-late", hostKey: "agent-x" });
		expect(agentRowKey(withRecord)).toBe(agentRowKey(unitOnly));
	});
});

describe("formatRelativeTime", () => {
	const now = 10_000_000_000;
	it.each([
		[0, "now"],
		[4_999, "now"],
		[42_000, "42s ago"],
		[5 * 60_000 + 59_000, "5m ago"],
		[3 * 3_600_000, "3h ago"],
		[2 * 86_400_000 + 1, "2d ago"],
	])("%d ms ago reads %s", (ago, expected) => {
		expect(formatRelativeTime(now - ago, now)).toBe(expected);
	});

	it("treats a timestamp from the future (clock skew) as now", () => {
		expect(formatRelativeTime(now + 60_000, now)).toBe("now");
	});
});

describe("attentionTransitions", () => {
	it("rings for nothing on the first poll, even if sessions already wait", () => {
		expect(attentionTransitions(undefined, [row("waiting"), row("error")])).toEqual([]);
	});

	it("reports sessions that entered waiting or error, and new sessions that appear already waiting", () => {
		const a = row("running");
		const b = row("idle");
		const c = row("waiting");
		const previous = snapshotAgentStatuses([a, b, c]);
		const nowWaiting = { ...a, status: "waiting" as const };
		const nowError = { ...b, status: "error" as const };
		const appeared = row("waiting");
		const transitions = attentionTransitions(previous, [nowWaiting, nowError, c, appeared]);
		expect(transitions.map(agentRowKey)).toEqual([agentRowKey(a), agentRowKey(b), agentRowKey(appeared)]);
	});

	it("rings again when a session moves from error to waiting, but not while it stays put or goes back to work", () => {
		const a = row("error");
		const b = row("waiting");
		const previous = snapshotAgentStatuses([a, b]);
		expect(
			attentionTransitions(previous, [
				{ ...a, status: "waiting" },
				{ ...b, status: "running" },
			]).map(agentRowKey),
		).toEqual([agentRowKey(a)]);
		expect(attentionTransitions(previous, [a, b])).toEqual([]);
	});
});

describe("agentsViewTitle", () => {
	it("counts sessions awaiting input in the window title", () => {
		expect(agentsViewTitle([row("waiting"), row("waiting"), row("error"), row("running")])).toBe(
			"2 awaiting input · omp agents",
		);
		expect(agentsViewTitle([row("running")])).toBe("omp agents");
	});
});

describe("formatAgentCwd", () => {
	it("renders a hostile working directory as one line with no escape or control bytes, home shortened", () => {
		const shown = formatAgentCwd("/home/u/evil\x1b]0;x\x07dir\nnext\tcol\x9b2J", "/home/u");
		expect(shown).toBe("~/evildir next   col");
		expect(shown).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	});
});

describe("agentDisplayText", () => {
	it("drops VS16 so a text-default emoji title is one cell in every terminal, keeping padded cells aligned", () => {
		const title = agentDisplayText("⏱️ JOB: nightly");
		expect(title).toBe("⏱ JOB: nightly");
		// One cell per code point: terminals that ignore VS16 draw it the same width as the model counts.
		expect(visibleWidth(title)).toBe([...title].length);
		expect(visibleWidth(truncateToWidth(title, 20, undefined, true))).toBe(20);
		// An emoji that is wide on its own stays wide.
		expect(visibleWidth(agentDisplayText("✅️ done"))).toBe(7);
	});
});

describe("parseAgentsViewInput", () => {
	it("reads `/resume foo bar` as the resume command with its query, case-insensitively", () => {
		expect(parseAgentsViewInput("  /Resume  foo bar ")).toEqual({ kind: "command", name: "resume", arg: "foo bar" });
		expect(parseAgentsViewInput("/resume")).toEqual({ kind: "command", name: "resume", arg: "" });
	});

	it("never turns a slash line into a new-session prompt: unknown names and a bare `/ ` are unknown", () => {
		expect(parseAgentsViewInput("/unknown x")).toEqual({ kind: "unknown", name: "unknown" });
		expect(parseAgentsViewInput("/ resume")).toEqual({ kind: "unknown", name: "" });
		expect(parseAgentsViewInput("/")).toEqual({ kind: "unknown", name: "" });
	});

	it("keeps ordinary text, including a slash later in the line, as a prompt; blank input is empty", () => {
		expect(parseAgentsViewInput(" fix src/a.ts /resume ")).toEqual({ kind: "prompt", prompt: "fix src/a.ts /resume" });
		expect(parseAgentsViewInput("   ")).toEqual({ kind: "empty" });
	});
});

describe("resumeAction", () => {
	const picked = { path: "/s/a.jsonl", id: "sess-a" };

	it("attaches a picked session a hosted process already runs, even if a foreground row also matches", () => {
		const foreground = row("idle", { attachable: false, hostKey: undefined, sessionId: "sess-a" });
		const hosted = row("running", { hostKey: "agent-a", sessionFile: "/s/a.jsonl" });
		expect(resumeAction([foreground, hosted], picked)).toEqual({ kind: "attach", hostKey: "agent-a" });
	});

	it("refuses a picked session that runs in another terminal instead of starting a second process", () => {
		const foreground = row("idle", { attachable: false, hostKey: undefined, sessionId: "sess-a" });
		expect(resumeAction([foreground], picked)).toEqual({ kind: "foreground", row: foreground });
	});

	it("launches only a session no live row matches by file or id", () => {
		const other = row("idle", { sessionId: "sess-b", sessionFile: "/s/b.jsonl" });
		expect(resumeAction([other], picked)).toEqual({ kind: "launch" });
	});
});
