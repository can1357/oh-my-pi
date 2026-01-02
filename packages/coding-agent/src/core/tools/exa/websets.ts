/**
 * Exa Websets Tools
 *
 * CRUD operations for websets, items, searches, enrichments, and monitoring.
 */

import { Type } from "@sinclair/typebox";
import type { CustomTool } from "../../custom-tools/types.js";
import { callWebsetsTool, findApiKey } from "./mcp-client.js";
import type { ExaRenderDetails } from "./types.js";

/** Helper to create a websets tool with proper execute signature */
function createWebsetTool(
	name: string,
	label: string,
	description: string,
	parameters: ReturnType<typeof Type.Object>,
	mcpToolName: string,
): CustomTool<any, ExaRenderDetails> {
	return {
		name,
		label,
		description,
		parameters,
		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			try {
				const apiKey = await findApiKey();
				if (!apiKey) {
					return {
						content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
						details: { error: "EXA_API_KEY not found", toolName: name },
					};
				}
				const result = await callWebsetsTool(apiKey, mcpToolName, params as Record<string, unknown>);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
					details: { raw: result, toolName: name },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { error: message, toolName: name },
				};
			}
		},
	};
}

// CRUD Operations
const websetCreateTool = createWebsetTool(
	"webset_create",
	"Create Webset",
	"Create a new webset collection for organizing web content.",
	Type.Object({
		name: Type.String({ description: "Name of the webset" }),
		description: Type.Optional(Type.String({ description: "Optional description" })),
	}),
	"create_webset",
);

const websetListTool = createWebsetTool(
	"webset_list",
	"List Websets",
	"List all websets in your account.",
	Type.Object({}),
	"list_websets",
);

const websetGetTool = createWebsetTool(
	"webset_get",
	"Get Webset",
	"Get details of a specific webset by ID.",
	Type.Object({
		id: Type.String({ description: "Webset ID" }),
	}),
	"get_webset",
);

const websetUpdateTool = createWebsetTool(
	"webset_update",
	"Update Webset",
	"Update a webset's name or description.",
	Type.Object({
		id: Type.String({ description: "Webset ID" }),
		name: Type.Optional(Type.String({ description: "New name" })),
		description: Type.Optional(Type.String({ description: "New description" })),
	}),
	"update_webset",
);

const websetDeleteTool = createWebsetTool(
	"webset_delete",
	"Delete Webset",
	"Delete a webset and all its contents.",
	Type.Object({
		id: Type.String({ description: "Webset ID" }),
	}),
	"delete_webset",
);

// Item Management
const websetItemsListTool = createWebsetTool(
	"webset_items_list",
	"List Webset Items",
	"List items in a webset with optional pagination.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		limit: Type.Optional(Type.Number({ description: "Number of items to return" })),
		offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
	}),
	"list_webset_items",
);

const websetItemGetTool = createWebsetTool(
	"webset_item_get",
	"Get Webset Item",
	"Get a specific item from a webset.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		item_id: Type.String({ description: "Item ID" }),
	}),
	"get_item",
);

// Search Operations
const websetSearchCreateTool = createWebsetTool(
	"webset_search_create",
	"Create Webset Search",
	"Create a new search within a webset.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		query: Type.String({ description: "Search query" }),
	}),
	"create_search",
);

const websetSearchGetTool = createWebsetTool(
	"webset_search_get",
	"Get Webset Search",
	"Get the status and results of a webset search.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		search_id: Type.String({ description: "Search ID" }),
	}),
	"get_search",
);

const websetSearchCancelTool = createWebsetTool(
	"webset_search_cancel",
	"Cancel Webset Search",
	"Cancel a running webset search.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		search_id: Type.String({ description: "Search ID" }),
	}),
	"cancel_search",
);

// Enrichment Operations
const websetEnrichmentCreateTool = createWebsetTool(
	"webset_enrichment_create",
	"Create Enrichment",
	"Create a new enrichment task for a webset.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		name: Type.String({ description: "Enrichment name" }),
		prompt: Type.String({ description: "Enrichment prompt" }),
	}),
	"create_enrichment",
);

const websetEnrichmentGetTool = createWebsetTool(
	"webset_enrichment_get",
	"Get Enrichment",
	"Get the status and results of an enrichment task.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		enrichment_id: Type.String({ description: "Enrichment ID" }),
	}),
	"get_enrichment",
);

const websetEnrichmentUpdateTool = createWebsetTool(
	"webset_enrichment_update",
	"Update Enrichment",
	"Update an enrichment's name or prompt.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		enrichment_id: Type.String({ description: "Enrichment ID" }),
		name: Type.Optional(Type.String({ description: "New name" })),
		prompt: Type.Optional(Type.String({ description: "New prompt" })),
	}),
	"update_enrichment",
);

const websetEnrichmentDeleteTool = createWebsetTool(
	"webset_enrichment_delete",
	"Delete Enrichment",
	"Delete an enrichment task.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		enrichment_id: Type.String({ description: "Enrichment ID" }),
	}),
	"delete_enrichment",
);

const websetEnrichmentCancelTool = createWebsetTool(
	"webset_enrichment_cancel",
	"Cancel Enrichment",
	"Cancel a running enrichment task.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		enrichment_id: Type.String({ description: "Enrichment ID" }),
	}),
	"cancel_enrichment",
);

// Monitoring
const websetMonitorCreateTool = createWebsetTool(
	"webset_monitor_create",
	"Create Monitor",
	"Create a monitoring task for a webset with optional webhook notifications.",
	Type.Object({
		webset_id: Type.String({ description: "Webset ID" }),
		webhook_url: Type.Optional(Type.String({ description: "Webhook URL for notifications" })),
	}),
	"create_monitor",
);

export const websetsTools: CustomTool<any, ExaRenderDetails>[] = [
	websetCreateTool,
	websetListTool,
	websetGetTool,
	websetUpdateTool,
	websetDeleteTool,
	websetItemsListTool,
	websetItemGetTool,
	websetSearchCreateTool,
	websetSearchGetTool,
	websetSearchCancelTool,
	websetEnrichmentCreateTool,
	websetEnrichmentGetTool,
	websetEnrichmentUpdateTool,
	websetEnrichmentDeleteTool,
	websetEnrichmentCancelTool,
	websetMonitorCreateTool,
];
