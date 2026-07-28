import type { AgentTool, AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core";
import { type } from "arktype";
import {
	type ActivitySummary,
	formatTrackedMs,
	localDateOf,
	localDayWindow,
	readActivitySummary,
} from "../gopk-clips/read";
import activityDescription from "../prompts/tools/activity.md" with { type: "text" };
import type { ToolSession } from ".";

const activitySchema = type({
	"date?": type("string").describe("local calendar day as YYYY-MM-DD; defaults to today"),
	"lastHours?": type("number").describe("summarize the trailing N hours (1-24) instead of a calendar day"),
	"includeDigests?": type("boolean").describe("include sampled window-title digests per hour (default true)"),
});

export type ActivityParams = typeof activitySchema.infer;

const MAX_DIGESTS_PER_HOUR = 4;
const MAX_APPS_PER_HOUR = 4;

/**
 * Read-only lookup over the local Activity Memory ledger.
 *
 * Strictly a reader: the ledger's single writer is the always-on `gopk-ingest`
 * daemon, and this tool must never poll the handoff queue, ingest a
 * derivative, or run retention. See src/gopk-clips/read.ts.
 */
export class ActivityTool implements AgentTool<typeof activitySchema> {
	readonly name = "activity";
	readonly approval = "read" as const;
	readonly label = "Activity";
	readonly description = activityDescription;
	readonly parameters = activitySchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Look up what the user was working on, from the local activity timeline";

	// Stateless: the ledger location comes from the shared gopk-clips resolver,
	// not from session state, so there is nothing session-scoped to hold.
	static createIf(session: ToolSession): ActivityTool | null {
		return session.settings.get("gopkClips.enabled") ? new ActivityTool() : null;
	}

	async execute(_id: string, params: ActivityParams): Promise<AgentToolResult> {
		const includeDigests = params.includeDigests ?? true;
		let summary: ActivitySummary;
		let heading: string;
		try {
			if (params.lastHours !== undefined) {
				const hours = Math.floor(params.lastHours);
				if (!Number.isFinite(hours) || hours < 1 || hours > 24) {
					throw new Error("lastHours must be a whole number between 1 and 24");
				}
				const endedAt = Date.now();
				summary = readActivitySummary({ window: { startedAt: endedAt - hours * 3_600_000, endedAt } });
				heading = `Activity — last ${hours}h`;
			} else {
				const date = params.date ?? localDateOf();
				summary = readActivitySummary({ window: localDayWindow(date) });
				heading = `Activity — ${date}`;
			}
		} catch (error) {
			throw error instanceof Error ? error : new Error(String(error));
		}

		if (!summary.ledgerPresent) {
			return {
				content: [
					{
						type: "text",
						text: "No activity timeline exists yet — the Activity Memory app has not recorded anything on this machine.",
					},
				],
				details: {},
				useless: true,
			};
		}

		const active = summary.hours.filter(hour => hour.trackedMs > 0);
		if (active.length === 0) {
			return {
				content: [{ type: "text", text: `${heading}: no activity recorded in this window.` }],
				details: {},
				useless: true,
			};
		}

		const lines = [`${heading} — ${summary.clipCount} clips, ${formatTrackedMs(summary.trackedMs)} tracked`, ""];
		for (const hour of active) {
			const apps = hour.apps
				.slice(0, MAX_APPS_PER_HOUR)
				.map(([app, ms]) => `${app} ${formatTrackedMs(ms)}`)
				.join(", ");
			lines.push(`${String(hour.hourLabel).padStart(2, "0")}:00  ${formatTrackedMs(hour.trackedMs)}  ${apps}`);
			if (includeDigests) {
				for (const digest of hour.digests.slice(0, MAX_DIGESTS_PER_HOUR)) {
					lines.push(`    · ${digest.length > 160 ? `${digest.slice(0, 160)}…` : digest}`);
				}
			}
		}
		lines.push("");
		lines.push(`Top apps: ${summary.apps.map(([app, ms]) => `${app} ${formatTrackedMs(ms)}`).join(", ")}`);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { clipCount: summary.clipCount, trackedMs: summary.trackedMs, hours: active.length },
		};
	}
}
