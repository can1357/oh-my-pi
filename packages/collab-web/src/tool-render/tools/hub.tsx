/**
 * `hub` — merged agent-coordination surface: peer messaging (irc rendering),
 * background jobs (job rendering), and process supervision (generic rendering,
 * matching the pre-merge launch tool). Dispatches per op family so each
 * result keeps its original look.
 */
import type { ReactNode } from "react";
import { genericRenderer } from "../generic";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord } from "../util";
import { ircRenderer } from "./irc";
import { jobRenderer } from "./job";

const LAUNCH_OPS = new Set(["start", "ps", "logs", "stop", "restart", "describe"]);

type Family = "launch" | "jobs" | "messaging";

/** Results dispatch on what actually happened; calls fall back to the arg shape. */
function familyOf({ args, result }: ToolRenderProps): Family {
	const details = detailsRecord(result);
	if (details) {
		// `state`/`cursor` cover logs results, which may carry neither a daemon
		// snapshot nor terminal rows; coordination details never define these keys.
		if (
			"daemon" in details ||
			"daemons" in details ||
			"terminalRows" in details ||
			"spec" in details ||
			"state" in details ||
			"cursor" in details
		) {
			return "launch";
		}
		if (Array.isArray(details.jobs) || Array.isArray(details.agents)) return "jobs";
		if ("receipts" in details || "waited" in details || "inbox" in details || "peers" in details) {
			return "messaging";
		}
	}
	const op = typeof args.op === "string" ? args.op : "";
	if (LAUNCH_OPS.has(op)) return "launch";
	const name = typeof args.name === "string" && args.name.length > 0;
	const to = typeof args.to === "string" && args.to.length > 0;
	const from = typeof args.from === "string" && args.from.length > 0;
	if ((op === "send" || op === "wait") && name && !to && !from) return "launch";
	if (op === "jobs" || op === "cancel") return "jobs";
	if (op === "wait" && !from) return "jobs";
	return "messaging";
}

/** Hub args → legacy job-renderer arg shape (`poll`/`cancel`/`list`). */
function toJobProps(props: ToolRenderProps): ToolRenderProps {
	const op = typeof props.args.op === "string" ? props.args.op : "";
	const args: Record<string, unknown> =
		op === "cancel" ? { cancel: props.args.ids } : op === "jobs" ? { list: true } : { poll: props.args.ids };
	return { ...props, args };
}

function Summary(props: ToolRenderProps): ReactNode {
	switch (familyOf(props)) {
		case "launch":
			return <genericRenderer.Summary {...props} />;
		case "jobs": {
			const jobProps = toJobProps(props);
			return <jobRenderer.Summary {...jobProps} />;
		}
		default:
			return <ircRenderer.Summary {...props} />;
	}
}

function Body(props: ToolRenderProps): ReactNode {
	switch (familyOf(props)) {
		case "launch":
			return genericRenderer.Body ? <genericRenderer.Body {...props} /> : null;
		case "jobs": {
			const jobProps = toJobProps(props);
			return jobRenderer.Body ? <jobRenderer.Body {...jobProps} /> : null;
		}
		default:
			return ircRenderer.Body ? <ircRenderer.Body {...props} /> : null;
	}
}

export const hubRenderer: ToolRenderer = { Summary, Body };
