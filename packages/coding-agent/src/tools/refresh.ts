/**
 * refresh — re-read frozen-at-session-start config into the live session.
 *
 * A running session freezes its skills, rules, settings/default-model, and MCP
 * registry at start. On a long-lived agent (a wave that stays up for hours) an
 * on-disk change — a nix-synced new skill, an edited rulebook, a config.yml
 * model switch — is invisible until restart. `refresh` re-scans those surfaces
 * and swaps the fresh values in without dropping the conversation, so a
 * supervisor can broadcast "run refresh" and every agent picks up the update at
 * once.
 *
 * Pure re-READ: no config file is written (the `/model` reformat footgun is
 * avoided by construction). Scoped so an agent that only needs the roster does
 * not disturb settings/MCP. The `/refresh` slash command is the human surface.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { REFRESH_SCOPES, type RefreshResult, type RefreshScope } from "../extensibility/reload";
import { formatFailedServer } from "../mcp/startup-events";
import refreshDescription from "../prompts/tools/refresh.md" with { type: "text" };
import type { ToolSession } from "./index";
import { TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";

const refreshSchema = type({
	"scope?": type
		.enumerated(...REFRESH_SCOPES)
		.describe("which frozen config surface to re-read from disk (default: all)"),
});

/** Details payload for TUI rendering of a refresh result. */
export interface RefreshToolDetails {
	scope: RefreshScope;
	result: RefreshResult;
}

/** Human-readable one-line summary of what a refresh changed. */
export function summarizeRefresh(scope: RefreshScope, result: RefreshResult): string {
	const parts: string[] = [];
	if (result.skills !== undefined) parts.push(`${result.skills} skills`);
	if (result.rules !== undefined) parts.push(`${result.rules} rules`);
	if (result.settingsChanged !== undefined) {
		parts.push(result.settingsChanged ? "settings updated" : "settings unchanged");
	}
	if (result.modelSwapped) parts.push("model swapped");
	if (result.mcp) {
		const failed = result.mcpErrors;
		if (failed && failed.size > 0) {
			// Sanitize each failure through the same helper the MCP connection-status
			// rows use (control chars/ANSI stripped, tabs expanded, newlines
			// flattened, embedded home paths shortened, fields width-bounded) so a
			// hostile server name or a long/absolute-path stderr line cannot corrupt
			// or overflow the TUI, nor leak local filesystem layout.
			const detail = truncateToWidth(
				[...failed.entries()]
					.map(([server, error]) => formatFailedServer({ serverName: server, error }))
					.join("; "),
				TRUNCATE_LENGTHS.LINE,
			);
			parts.push(`MCP reconnected with ${failed.size} error(s) (${detail})`);
		} else {
			parts.push("MCP reconnected");
		}
	}
	const body = parts.length > 0 ? parts.join(", ") : "nothing to reload";
	return `Refreshed (${scope}): ${body}.`;
}

export class RefreshTool implements AgentTool<typeof refreshSchema, RefreshToolDetails> {
	readonly name = "refresh";
	// `exec` tier: refresh("mcp"/"all") reconnects MCP, which spawns a project
	// `.mcp.json` stdio server's `command` as a subprocess (arbitrary code
	// execution) and re-reads project config mid-session. As a model-discoverable
	// tool it must NOT auto-run in always-ask/write modes — a prompt-injected
	// repo could otherwise self-invoke refresh("mcp") to run project config
	// ungated. It also swaps the model and mutates sibling sessions' rosters.
	readonly approval = "exec" as const;
	readonly label = "Refresh";
	readonly summary = "Re-read skills, rules, settings, and MCP from disk without restarting";
	readonly description: string;
	readonly parameters = refreshSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	// refresh() mutates process-global roster/rule snapshots, reconnects MCP, and
	// can swap the model — it must not interleave with sibling tool calls in the
	// same batch reading that shared state.
	readonly concurrency = "exclusive" as const;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(refreshDescription);
	}

	async execute(
		_toolCallId: string,
		params: typeof refreshSchema.infer,
	): Promise<AgentToolResult<RefreshToolDetails>> {
		const scope: RefreshScope = params.scope ?? "all";
		if (!this.session.refresh) {
			return {
				content: [{ type: "text", text: "Refresh is unavailable in this session." }],
				isError: true,
				details: { scope, result: {} },
			};
		}
		const result = await this.session.refresh(scope);
		return {
			content: [{ type: "text", text: summarizeRefresh(scope, result) }],
			details: { scope, result },
		};
	}
}
