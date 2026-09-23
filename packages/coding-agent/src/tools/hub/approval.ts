import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";

/**
 * Leaf module: the `hub` tool's parameter-dependent approval tier, plus the
 * advisor's review carve-out. Kept free of hub runtime imports (IrcBus, job
 * manager, launch) so consumers outside the tool — the advisor cadence gate —
 * can read the policy without pulling the whole coordination surface into
 * their module graph.
 */

/** Mutating process ops require exec approval; messaging, jobs, and inspection are read-only. */
export function hubApproval(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	const op = params.op;
	switch (op) {
		case "wait":
		case "inbox":
		case "list":
		case "jobs":
		case "cancel":
		case "ps":
		case "logs":
		case "describe":
			return "read";
		case "send": {
			// Peer DMs are read-tier; writing to a process stdin is exec-tier.
			const name = "name" in params ? params.name : undefined;
			const to = "to" in params ? params.to : undefined;
			return typeof name === "string" && name.length > 0 && !to ? "exec" : "read";
		}
		default:
			// start / stop / restart and anything unrecognized.
			return "exec";
	}
}

/**
 * `hub` ops that a mid-turn advisor review can skip under `advisor.reviewOn:
 * mutation`: pure inspection and inbox drains, which observe coordination
 * state without changing it.
 *
 * Deliberately narrower than the read approval tier, which answers "does the
 * user need to confirm this" rather than "is this worth reviewing". `cancel`
 * kills background work and `send` steers a peer agent — both are read-tier
 * because they need no confirmation, and both are exactly the kind of
 * mid-flight decision an advisor should see.
 */
const HUB_ADVISOR_EXEMPT_OPS: Record<string, true> = {
	list: true,
	jobs: true,
	inbox: true,
	logs: true,
	ps: true,
	describe: true,
	wait: true,
};

/** Whether a `hub` tool call is pure inspection, so a mid-turn advisor review can skip it. */
export function isHubReviewExempt(params: unknown): boolean {
	if (typeof params !== "object" || params === null || !("op" in params)) return false;
	const op = params.op;
	return typeof op === "string" && HUB_ADVISOR_EXEMPT_OPS[op] === true;
}
