/**
 * X (Twitter) search via xAI's Responses `x_search` server tool.
 *
 * Any model can call this. The backing model is the `xsearch` role chain
 * (`modelRoles.xsearch`, else `xai/grok-4.6` then `xai-oauth/grok-4.6`), not
 * the caller's chat model — same split `web_search` uses for its `web` role.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import xSearchSystemPrompt from "../../prompts/system/x-search.md" with { type: "text" };
import xSearchDescription from "../../prompts/tools/x-search.md" with { type: "text" };
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { cfgXSearchEnabled } from "../../tools/settings";
import { executeSearch } from "./index";
import type { XSearchOptions } from "./providers/base";
import type { SearchResultDetails } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

const RECENCY_DAYS: Record<NonNullable<XSearchToolParams["recency"]>, number> = {
	day: 1,
	week: 7,
	month: 31,
	year: 366,
};

/** `auto` enables x_search only when an xAI credential resolves; unlike web_search there is no anonymous path. */
export function isXSearchEnabled(session: ToolSession): boolean {
	const mode = cfgXSearchEnabled.get(session.settings);
	if (mode !== "auto") return mode === "on";
	const authStorage = session.authStorage;
	if (authStorage === undefined) return false;
	// `xai` covers API-key auth; `xai-oauth` covers SuperGrok OAuth, whose own
	// env bearer is the only dedicated env leg, so aliases let it borrow
	// XAI_API_KEY the same way `xai` does.
	return (
		authStorage.keys.source("xai", { env: "aliases" }) !== undefined ||
		authStorage.keys.source("xai-oauth", { env: "aliases" }) !== undefined
	);
}

/** X search tool parameters schema */
export const xSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	"allowed_x_handles?": "string[]",
	"excluded_x_handles?": "string[]",
	"from_date?": "string",
	"to_date?": "string",
	"enable_image_understanding?": "boolean",
	"enable_video_understanding?": "boolean",
	num_search_results: "number?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
});

export type XSearchToolParams = typeof xSearchSchema.infer;

/** Map tool params onto the shared executeSearch xSearch spec. Shared with tests so the recency/date mapping is exercised through the real builder. */
export function buildXSearchSpec(params: XSearchToolParams): { systemPrompt: string; options: XSearchOptions } {
	const recencyDays = params.recency ? RECENCY_DAYS[params.recency] : undefined;
	return {
		systemPrompt: xSearchSystemPrompt,
		options: {
			allowedHandles: params.allowed_x_handles,
			excludedHandles: params.excluded_x_handles,
			// `from_date`/`to_date` win over recency when both are set.
			fromDate:
				params.from_date ??
				(recencyDays !== undefined
					? new Date(Date.now() - recencyDays * DAY_MS).toISOString().slice(0, 10)
					: undefined),
			toDate: params.to_date,
			enableImageUnderstanding: params.enable_image_understanding,
			enableVideoUnderstanding: params.enable_video_understanding,
		},
	};
}

/** X search tool. Backed by the xsearch role, independent of the caller's chat model. */
export class XSearchTool implements AgentTool<typeof xSearchSchema, SearchResultDetails> {
	readonly name = "x_search";
	readonly approval = "read" as const;
	readonly label = "X Search";
	readonly description: string;
	readonly parameters = xSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search X (Twitter) posts via xAI";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(xSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: XSearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchResultDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchResultDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch("", params, {
			authStorage,
			modelRegistry: this.#session.modelRegistry,
			sessionId,
			signal,
			xSearch: buildXSearchSpec(params),
		});
	}
}
