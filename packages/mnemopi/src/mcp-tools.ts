import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DB_FILENAME, dataDir } from "./config";
import { BankManager } from "./core/banks";
import { BeamMemory, type RecallOptions } from "./core/beam";
import { addTriple, queryTriples } from "./core/triples";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ToolArguments = Record<string, unknown>;
export type ToolResult = Record<string, unknown>;

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: {
		readonly type: "object";
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

const EMPTY_SCHEMA = { type: "object", properties: {} } as const;

export const REMEMBER_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "string", description: "The memory content to store." },
		importance: { type: "number", description: "Importance score from 0.0 to 1.0.", default: 0.5 },
		source: { type: "string", description: "Source tag for this memory.", default: "user" },
		scope: {
			type: "string",
			description: "Memory scope: session, global, channel, or a custom scope.",
			default: "session",
		},
		valid_until: { type: "string", description: "Optional expiry date or timestamp." },
		extract_entities: {
			type: "boolean",
			description: "Extract named entities for fuzzy recall.",
			default: false,
		},
		extract: {
			type: "boolean",
			description: "Extract structured facts from content.",
			default: false,
		},
		metadata: { type: "object", description: "Optional key-value metadata.", default: {} },
		veracity: {
			type: "string",
			description: "Confidence label for the memory.",
			default: "unknown",
		},
		author_id: { type: "string", description: "Author identifier for this MCP call." },
		author_type: { type: "string", description: "Author type: human, agent, or system." },
		channel_id: { type: "string", description: "Channel or group this memory belongs to." },
		bank: { type: "string", description: "Memory bank to store in.", default: "default" },
	},
	required: ["content"],
} as const;

export const RECALL_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "Natural-language search query." },
		limit: { type: "integer", description: "Maximum results to return.", default: 5 },
		top_k: { type: "integer", description: "Maximum results to return.", default: 5 },
		bank: { type: "string", description: "Memory bank to search.", default: "default" },
		temporal_weight: {
			type: "number",
			description: "Temporal boost weight. 0.0 disables recency boost.",
			default: 0.0,
		},
		query_time: {
			type: "string",
			description: "ISO timestamp to treat as now for temporal scoring.",
		},
		temporal_halflife: {
			type: "number",
			description: "Temporal decay half-life in hours.",
			default: 24,
		},
		vec_weight: { type: "number", description: "Vector similarity weight." },
		fts_weight: { type: "number", description: "Full-text search weight." },
		importance_weight: { type: "number", description: "Importance score weight." },
		author_id: { type: "string", description: "Filter by author identifier." },
		author_type: { type: "string", description: "Filter by author type." },
		channel_id: { type: "string", description: "Filter by channel/group." },
	},
	required: ["query"],
} as const;

export const SHARED_REMEMBER_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "string", description: "Surface memory content to store." },
		kind: {
			type: "string",
			description: "meta | preference | correction | identity",
			default: "meta",
		},
		importance: { type: "number", description: "Importance score from 0.0 to 1.0.", default: 0.8 },
		veracity: { type: "string", description: "Confidence label.", default: "unknown" },
		metadata: { type: "object", description: "Optional metadata object.", default: {} },
	},
	required: ["content"],
} as const;

export const SHARED_RECALL_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "Surface memory query." },
		limit: { type: "integer", default: 5 },
	},
	required: ["query"],
} as const;

export const SHARED_FORGET_SCHEMA = {
	type: "object",
	properties: { memory_id: { type: "string", description: "Memory ID to delete." } },
	required: ["memory_id"],
} as const;

export const SLEEP_SCHEMA = {
	type: "object",
	properties: {
		dry_run: {
			type: "boolean",
			description: "Preview consolidation without writes.",
			default: false,
		},
		all_sessions: {
			type: "boolean",
			description: "Consolidate all eligible sessions.",
			default: false,
		},
		bank: { type: "string", description: "Memory bank to consolidate.", default: "default" },
	},
} as const;

export const INVALIDATE_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of memory to invalidate." },
		replacement_id: { type: "string", description: "Optional replacement memory ID." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id"],
} as const;

export const VALIDATE_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of memory to validate." },
		action: { type: "string", enum: ["attest", "update", "invalidate", "delete"] },
		validator: { type: "string", description: "Agent identifier performing validation." },
		new_content: { type: "string", description: "New content for action=update." },
		note: { type: "string", description: "Optional reason or evidence." },
		bank: { type: "string", enum: ["private", "surface"], default: "private" },
	},
	required: ["memory_id", "action"],
} as const;

export const GET_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "The memory ID to retrieve." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id"],
} as const;

export const TRIPLE_ADD_SCHEMA = {
	type: "object",
	properties: {
		subject: { type: "string" },
		predicate: { type: "string" },
		object: { type: "string" },
		valid_from: { type: "string", description: "ISO date." },
		source: { type: "string", default: "conversation" },
		confidence: { type: "number", default: 1.0 },
		bank: { type: "string", default: "default" },
	},
	required: ["subject", "predicate", "object"],
} as const;

export const TRIPLE_QUERY_SCHEMA = {
	type: "object",
	properties: {
		subject: { type: "string" },
		predicate: { type: "string" },
		object: { type: "string" },
		as_of: { type: "string" },
		bank: { type: "string", default: "default" },
	},
} as const;

export const SCRATCHPAD_WRITE_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "string", description: "Content to write to scratchpad." },
		bank: { type: "string", default: "default" },
	},
	required: ["content"],
} as const;

export const SCRATCHPAD_READ_SCHEMA = {
	type: "object",
	properties: { bank: { type: "string", default: "default" } },
} as const;

export const SCRATCHPAD_CLEAR_SCHEMA = {
	type: "object",
	properties: { bank: { type: "string", default: "default" } },
} as const;

export const EXPORT_SCHEMA = {
	type: "object",
	properties: {
		output_path: { type: "string", description: "File path to write the export JSON." },
		bank: { type: "string", default: "default" },
	},
	required: ["output_path"],
} as const;

export const UPDATE_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of the memory to update." },
		content: { type: "string", description: "New content for the memory." },
		importance: { type: "number", description: "New importance score." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id", "content"],
} as const;

export const FORGET_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of the memory to delete." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id"],
} as const;

export const IMPORT_SCHEMA = {
	type: "object",
	properties: {
		input_path: { type: "string", description: "File path to read the export JSON from." },
		force: {
			type: "boolean",
			description: "Overwrite existing records instead of skipping.",
			default: false,
		},
		bank: { type: "string", default: "default" },
	},
	required: ["input_path"],
} as const;

export const GRAPH_QUERY_SCHEMA = {
	type: "object",
	properties: {
		seed_memory_id: { type: "string" },
		max_hops: { type: "integer", default: 2 },
		edge_type: { type: "string" },
		min_weight: { type: "number", default: 0.0 },
		bank: { type: "string", default: "default" },
	},
	required: ["seed_memory_id"],
} as const;

export const GRAPH_LINK_SCHEMA = {
	type: "object",
	properties: {
		source_id: { type: "string" },
		target_id: { type: "string" },
		relationship: { type: "string" },
		weight: { type: "number", default: 0.5 },
		bank: { type: "string", default: "default" },
	},
	required: ["source_id", "target_id", "relationship"],
} as const;

export const TOOLS: readonly ToolDefinition[] = [
	{
		name: "mnemopi_remember",
		description: "Store a durable memory in Mnemopi.",
		inputSchema: REMEMBER_SCHEMA,
	},
	{
		name: "mnemopi_recall",
		description: "Search memories with hybrid scoring.",
		inputSchema: RECALL_SCHEMA,
	},
	{
		name: "mnemopi_shared_remember",
		description: "Store compact cross-agent surface memory.",
		inputSchema: SHARED_REMEMBER_SCHEMA,
	},
	{
		name: "mnemopi_shared_recall",
		description: "Search only the shared Mnemopi surface DB.",
		inputSchema: SHARED_RECALL_SCHEMA,
	},
	{
		name: "mnemopi_shared_forget",
		description: "Delete one shared-surface memory by ID.",
		inputSchema: SHARED_FORGET_SCHEMA,
	},
	{
		name: "mnemopi_shared_stats",
		description: "Return shared surface DB path and counts.",
		inputSchema: EMPTY_SCHEMA,
	},
	{
		name: "mnemopi_sleep",
		description: "Run the consolidation sleep cycle.",
		inputSchema: SLEEP_SCHEMA,
	},
	{
		name: "mnemopi_stats",
		description: "Return Mnemopi memory statistics.",
		inputSchema: EMPTY_SCHEMA,
	},
	{
		name: "mnemopi_invalidate",
		description: "Mark a memory as expired or superseded.",
		inputSchema: INVALIDATE_SCHEMA,
	},
	{
		name: "mnemopi_validate",
		description: "Attest, update, invalidate, or delete a memory.",
		inputSchema: VALIDATE_SCHEMA,
	},
	{ name: "mnemopi_get", description: "Retrieve one memory by ID.", inputSchema: GET_SCHEMA },
	{
		name: "mnemopi_triple_add",
		description: "Add a temporal fact triple.",
		inputSchema: TRIPLE_ADD_SCHEMA,
	},
	{
		name: "mnemopi_triple_query",
		description: "Query temporal fact triples.",
		inputSchema: TRIPLE_QUERY_SCHEMA,
	},
	{
		name: "mnemopi_scratchpad_write",
		description: "Write a temporary scratchpad note.",
		inputSchema: SCRATCHPAD_WRITE_SCHEMA,
	},
	{
		name: "mnemopi_scratchpad_read",
		description: "Read scratchpad entries.",
		inputSchema: SCRATCHPAD_READ_SCHEMA,
	},
	{
		name: "mnemopi_scratchpad_clear",
		description: "Clear scratchpad entries.",
		inputSchema: SCRATCHPAD_CLEAR_SCHEMA,
	},
	{
		name: "mnemopi_export",
		description: "Export Mnemopi memories to a JSON file.",
		inputSchema: EXPORT_SCHEMA,
	},
	{
		name: "mnemopi_update",
		description: "Update the content or importance of an existing memory.",
		inputSchema: UPDATE_SCHEMA,
	},
	{
		name: "mnemopi_forget",
		description: "Permanently delete a memory by ID.",
		inputSchema: FORGET_SCHEMA,
	},
	{
		name: "mnemopi_import",
		description: "Import Mnemopi memories from a JSON file.",
		inputSchema: IMPORT_SCHEMA,
	},
	{
		name: "mnemopi_diagnose",
		description: "Run PII-safe diagnostics on the active Mnemopi database.",
		inputSchema: EMPTY_SCHEMA,
	},
	{
		name: "mnemopi_graph_query",
		description: "Traverse the memory graph from a seed memory.",
		inputSchema: GRAPH_QUERY_SCHEMA,
	},
	{
		name: "mnemopi_graph_link",
		description: "Declare a semantic edge between two memories.",
		inputSchema: GRAPH_LINK_SCHEMA,
	},
];

function stringArg(args: ToolArguments, key: string, fallback = ""): string {
	const value = args[key];
	return typeof value === "string" ? value : fallback;
}

function optionalStringArg(args: ToolArguments, key: string): string | null {
	const value = stringArg(args, key);
	return value.length > 0 ? value : null;
}

function numberArg(args: ToolArguments, key: string, fallback: number): number {
	const value = args[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanArg(args: ToolArguments, key: string, fallback = false): boolean {
	const value = args[key];
	return typeof value === "boolean" ? value : fallback;
}

function metadataArg(args: ToolArguments): Record<string, JsonValue> | null {
	const value = args.metadata;
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, JsonValue>)
		: null;
}

function resolveBank(args: ToolArguments): string {
	return stringArg(args, "bank") || process.env.MNEMOPI_MCP_BANK || "default";
}

function bankDbPath(bank: string): string {
	return new BankManager(dataDir()).getBankDbPath(bank);
}

function createBeam(args: ToolArguments, bank = resolveBank(args)): BeamMemory {
	const sessionId = process.env.MNEMOPI_SESSION_ID || `mcp_${bank}`;
	return new BeamMemory({
		sessionId,
		dbPath: bankDbPath(bank),
		authorId: optionalStringArg(args, "author_id") ?? process.env.MNEMOPI_AUTHOR_ID ?? null,
		authorType: optionalStringArg(args, "author_type") ?? process.env.MNEMOPI_AUTHOR_TYPE ?? null,
		channelId: optionalStringArg(args, "channel_id") ?? process.env.MNEMOPI_CHANNEL_ID ?? sessionId,
	});
}

function sharedBeam(): BeamMemory {
	const configured = process.env.MNEMOPI_SHARED_SURFACE_DB;
	const dbPath = configured && configured.length > 0 ? configured : join(dataDir(), "shared", DEFAULT_DB_FILENAME);
	return new BeamMemory({ sessionId: "mcp_shared_surface", dbPath });
}

async function withBeam<T>(args: ToolArguments, fn: (beam: BeamMemory, bank: string) => T | Promise<T>): Promise<T> {
	const bank = resolveBank(args);
	const beam = createBeam(args, bank);
	try {
		const result = await fn(beam, bank);
		// Drain background fact-extraction and embedding tasks before close so
		// the SQLite handle stays open until in-flight `embed()` writes commit;
		// otherwise the short-lived MCP `remember`/`update`/`sleep` paths race
		// the close and silently drop the new dense-recall rows.
		await beam.flushExtractions();
		return result;
	} finally {
		beam.close();
	}
}
function serialize(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(serialize);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key in value) out[key] = serialize((value as Record<string, unknown>)[key]);
		return out;
	}
	return value;
}

function cloneRowForBankImport(value: unknown, sessionId: string, channelId: string | null): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const row: Record<string, unknown> & { session_id: string; channel_id?: string } = {
		...(value as Record<string, unknown>),
		session_id: sessionId,
	};
	if (channelId !== null) row.channel_id = channelId;
	return row;
}

function routeImportToBeamSession(data: Record<string, unknown>, beam: BeamMemory): Record<string, unknown> {
	return {
		...data,
		working_memory: Array.isArray(data.working_memory)
			? data.working_memory.map(row => cloneRowForBankImport(row, beam.sessionId, beam.channelId))
			: data.working_memory,
		episodic_memory: Array.isArray(data.episodic_memory)
			? data.episodic_memory.map(row => cloneRowForBankImport(row, beam.sessionId, beam.channelId))
			: data.episodic_memory,
		scratchpad: Array.isArray(data.scratchpad)
			? data.scratchpad.map(row => cloneRowForBankImport(row, beam.sessionId, null))
			: data.scratchpad,
		consolidation_log: Array.isArray(data.consolidation_log)
			? data.consolidation_log.map(row => cloneRowForBankImport(row, beam.sessionId, null))
			: data.consolidation_log,
	};
}

function required(args: ToolArguments, key: string): string | ToolResult {
	const value = stringArg(args, key).trim();
	return value.length > 0 ? value : { error: `${key} is required` };
}

async function handleRemember(args: ToolArguments): Promise<ToolResult> {
	const content = required(args, "content");
	if (typeof content !== "string") return content;
	return withBeam(args, (beam, bank) => {
		const memoryId = beam.remember(content, {
			source: stringArg(args, "source", "mcp"),
			importance: numberArg(args, "importance", 0.5),
			metadata: metadataArg(args),
			extractEntities: booleanArg(args, "extract_entities"),
			extract: booleanArg(args, "extract"),
			veracity: stringArg(args, "veracity", "unknown"),
			scope: stringArg(args, "scope", "session"),
		});
		return { status: "stored", memory_id: memoryId, bank, content_preview: content.slice(0, 100) };
	});
}

async function handleRecall(args: ToolArguments): Promise<ToolResult> {
	const query = required(args, "query");
	if (typeof query !== "string") return query;
	return withBeam(args, async (beam, bank) => {
		const topK = Math.trunc(numberArg(args, "top_k", numberArg(args, "limit", 5)));
		const options: RecallOptions & Record<string, unknown> = {
			temporalWeight: numberArg(args, "temporal_weight", 0.0),
			queryTime: optionalStringArg(args, "query_time"),
			temporalHalflife: numberArg(args, "temporal_halflife", 24),
			authorId: optionalStringArg(args, "author_id"),
			authorType: optionalStringArg(args, "author_type"),
			channelId: optionalStringArg(args, "channel_id"),
		};
		for (const key of ["vec_weight", "fts_weight", "importance_weight"] as const) {
			if (key in args) options[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = args[key];
		}
		const results = (await beam.recall(query, topK, options)).map(row => ({ ...row, bank }));
		return { status: "ok", query, count: results.length, results: serialize(results), bank };
	});
}

async function handleSleep(args: ToolArguments): Promise<ToolResult> {
	return withBeam(args, (beam, bank) => {
		const dryRun = booleanArg(args, "dry_run");
		const allSessions = booleanArg(args, "all_sessions");
		const result = allSessions ? beam.sleepAllSessions(dryRun) : beam.sleep(dryRun);
		return {
			status: "ok",
			dry_run: dryRun,
			all_sessions: allSessions,
			result: serialize(result),
			working: serialize(beam.getWorkingStats()),
			episodic: serialize(beam.getEpisodicStats()),
			bank,
		};
	});
}

async function handleStats(args: ToolArguments): Promise<ToolResult> {
	return withBeam(args, (beam, bank) => ({
		status: "ok",
		provider: "mnemopi",
		bank,
		working: serialize(beam.getWorkingStats()),
		episodic: serialize(beam.getEpisodicStats()),
		memoria: serialize(beam.getMemoriaStats()),
		stats: {
			working: serialize(beam.getWorkingStats()),
			episodic: serialize(beam.getEpisodicStats()),
			memoria: serialize(beam.getMemoriaStats()),
		},
	}));
}

async function handleScratchpadWrite(args: ToolArguments): Promise<ToolResult> {
	const content = required(args, "content");
	if (typeof content !== "string") return content;
	return withBeam(args, (beam, bank) => {
		const entryId = beam.scratchpadWrite(content);
		return { status: "written", id: entryId, entry_id: entryId, bank };
	});
}

async function handleScratchpadRead(args: ToolArguments): Promise<ToolResult> {
	return withBeam(args, (beam, bank) => {
		const entries = beam.scratchpadRead();
		return {
			status: "ok",
			entries_count: entries.length,
			count: entries.length,
			entries: serialize(entries),
			bank,
		};
	});
}

async function handleScratchpadClear(args: ToolArguments): Promise<ToolResult> {
	return withBeam(args, (beam, bank) => {
		beam.scratchpadClear();
		return { status: "cleared", bank };
	});
}

async function handleInvalidate(args: ToolArguments): Promise<ToolResult> {
	const memoryId = required(args, "memory_id");
	if (typeof memoryId !== "string") return memoryId;
	return withBeam(args, (beam, bank) => ({
		status: beam.invalidate(memoryId, optionalStringArg(args, "replacement_id")) ? "invalidated" : "not_found",
		memory_id: memoryId,
		bank,
	}));
}

async function handleGet(args: ToolArguments): Promise<ToolResult> {
	const memoryId = required(args, "memory_id");
	if (typeof memoryId !== "string") return memoryId;
	return withBeam(args, (beam, bank) => {
		const memory = beam.get(memoryId);
		return memory === null
			? { status: "not_found", memory_id: memoryId, bank }
			: { status: "ok", memory: serialize(memory), bank };
	});
}

async function handleUpdate(args: ToolArguments): Promise<ToolResult> {
	const memoryId = required(args, "memory_id");
	if (typeof memoryId !== "string") return memoryId;
	return withBeam(args, (beam, bank) => {
		if (!("content" in args) && !("importance" in args)) return { error: "content or importance is required" };
		const content = "content" in args ? stringArg(args, "content") : null;
		if (content !== null && content.trim().length === 0) return { error: "content is required" };
		const importance = "importance" in args ? numberArg(args, "importance", Number.NaN) : null;
		const ok = beam.updateWorking(
			memoryId,
			content,
			importance !== null && Number.isFinite(importance) ? importance : null,
		);
		return { status: ok ? "updated" : "not_found", memory_id: memoryId, bank };
	});
}

async function handleForget(args: ToolArguments): Promise<ToolResult> {
	const memoryId = required(args, "memory_id");
	if (typeof memoryId !== "string") return memoryId;
	return withBeam(args, (beam, bank) => ({
		status: beam.forgetWorking(memoryId) ? "deleted" : "not_found",
		memory_id: memoryId,
		bank,
	}));
}

async function handleTripleAdd(args: ToolArguments): Promise<ToolResult> {
	const subject = required(args, "subject");
	if (typeof subject !== "string") return subject;
	const predicate = required(args, "predicate");
	if (typeof predicate !== "string") return predicate;
	const object = required(args, "object");
	if (typeof object !== "string") return object;
	const bank = resolveBank(args);
	const tripleId = addTriple(subject, predicate, object, {
		dbPath: bankDbPath(bank),
		validFrom: optionalStringArg(args, "valid_from"),
		source: stringArg(args, "source", "conversation"),
		confidence: numberArg(args, "confidence", 1.0),
	});
	return { status: "stored", triple_id: tripleId, store: "triples", bank };
}

async function handleTripleQuery(args: ToolArguments): Promise<ToolResult> {
	const bank = resolveBank(args);
	const results = queryTriples({
		dbPath: bankDbPath(bank),
		subject: optionalStringArg(args, "subject"),
		predicate: optionalStringArg(args, "predicate"),
		object: optionalStringArg(args, "object"),
		asOf: optionalStringArg(args, "as_of"),
	});
	return {
		count: results.length,
		results: serialize(results),
		results_count: results.length,
		store: "triples",
		bank,
	};
}

async function handleExport(args: ToolArguments): Promise<ToolResult> {
	const outputPath = required(args, "output_path");
	if (typeof outputPath !== "string") return outputPath;
	return withBeam(args, (beam, bank) => {
		mkdirSync(dirname(outputPath), { recursive: true });
		const data = beam.exportToDict();
		writeFileSync(outputPath, JSON.stringify(data, null, 2));
		return {
			status: "exported",
			output_path: outputPath,
			bank,
			stats: serialize(beam.getWorkingStats()),
		};
	});
}

async function handleImport(args: ToolArguments): Promise<ToolResult> {
	const inputPath = required(args, "input_path");
	if (typeof inputPath !== "string") return { error: "Either input_path (for file import) is required" };
	if (!existsSync(inputPath)) return { error: `input_path does not exist: ${inputPath}` };
	return withBeam(args, (beam, bank) => {
		const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
		const routed = routeImportToBeamSession(parsed, beam);
		const stats = beam.importFromDict(routed, booleanArg(args, "force"));
		return { status: "imported", stats: serialize(stats), bank };
	});
}

function surfaceLabel(content: string, kind: string): string {
	const lower = content.toLowerCase();
	if (
		lower.startsWith("surface meta:") ||
		lower.startsWith("surface preference:") ||
		lower.startsWith("surface correction:") ||
		lower.startsWith("surface identity:")
	)
		return content;
	const label =
		kind === "preference"
			? "Surface preference"
			: kind === "correction"
				? "Surface correction"
				: kind === "identity"
					? "Surface identity"
					: "Surface meta";
	return `${label}: ${content}`;
}

async function withSharedBeam<T>(fn: (beam: BeamMemory) => T | Promise<T>): Promise<T> {
	const beam = sharedBeam();
	try {
		const result = await fn(beam);
		await beam.flushExtractions();
		return result;
	} finally {
		beam.close();
	}
}

async function handleSharedRemember(args: ToolArguments): Promise<ToolResult> {
	const content = required(args, "content");
	if (typeof content !== "string") return content;
	const kind = stringArg(args, "kind", "meta").trim().toLowerCase();
	if (!["meta", "preference", "correction", "identity"].includes(kind))
		return { error: "kind must be one of: meta, preference, correction, identity" };
	return withSharedBeam(beam => {
		const labelled = surfaceLabel(content, kind);
		const memoryId = beam.remember(labelled, {
			source: "surface_manual",
			importance: Math.max(0, Math.min(1, numberArg(args, "importance", 0.8))),
			metadata: { ...metadataArg(args), shared_memory: true, surface_kind: kind },
			veracity: stringArg(args, "veracity", "unknown"),
			scope: "global",
		});
		return {
			status: "stored_shared",
			memory_id: memoryId,
			kind,
			content_preview: labelled.slice(0, 120),
		};
	});
}

async function handleSharedRecall(args: ToolArguments): Promise<ToolResult> {
	const query = required(args, "query");
	if (typeof query !== "string") return query;
	return withSharedBeam(async beam => {
		const results = (await beam.recall(query, Math.trunc(numberArg(args, "limit", 5)))).map(row => ({
			...row,
			bank: "surface",
			shared_surface: true,
		}));
		return { query, count: results.length, results: serialize(results) };
	});
}

async function handleSharedForget(args: ToolArguments): Promise<ToolResult> {
	const memoryId = required(args, "memory_id");
	if (typeof memoryId !== "string") return memoryId;
	return withSharedBeam(beam => ({
		status: beam.forgetWorking(memoryId) ? "deleted" : "not_found",
		memory_id: memoryId,
	}));
}

async function handleSharedStats(): Promise<ToolResult> {
	return withSharedBeam(beam => ({
		provider: "mnemopi_shared",
		working: serialize(beam.getWorkingStats()),
		episodic: serialize(beam.getEpisodicStats()),
	}));
}

async function handleValidate(args: ToolArguments): Promise<ToolResult> {
	const memoryId = required(args, "memory_id");
	if (typeof memoryId !== "string") return memoryId;
	const action = stringArg(args, "action");
	if (!["attest", "update", "invalidate", "delete"].includes(action)) return { error: `unknown action: ${action}` };
	if (action === "update" && !optionalStringArg(args, "new_content"))
		return { error: "new_content is required for action='update'" };
	return withBeam(args, (beam, bank) => {
		const existing = beam.get(memoryId) as { content?: string; author_id?: string | null } | null;
		if (existing === null) return { error: "memory_not_found", memory_id: memoryId, bank };
		let status: string;
		if (action === "delete") status = beam.forgetWorking(memoryId) ? "validation_delete" : "not_found";
		else if (action === "update")
			status = beam.updateWorking(memoryId, stringArg(args, "new_content"), null)
				? "validation_update"
				: "not_found";
		else if (action === "invalidate") status = beam.invalidate(memoryId) ? "validation_invalidate" : "not_found";
		else status = "validation_attest";
		return {
			status,
			memory_id: memoryId,
			bank,
			validator: stringArg(args, "validator", "unknown"),
			author_id: existing.author_id ?? null,
			previous_content: existing.content?.slice(0, 200) ?? null,
		};
	});
}

async function handleDiagnose(args: ToolArguments): Promise<ToolResult> {
	return withBeam(args, (beam, bank) => ({
		status: "ok",
		bank,
		db_path: beam.dbPath ?? null,
		working: serialize(beam.getWorkingStats()),
		episodic: serialize(beam.getEpisodicStats()),
		memoria: serialize(beam.getMemoriaStats()),
	}));
}

interface GraphEdgeInput {
	readonly source: string;
	readonly target: string;
	readonly edgeType: string;
	readonly weight: number;
	readonly timestamp: string;
}

interface GraphQueryApi {
	findRelatedMemories(memoryId: string, depth?: number, edgeType?: string, minWeight?: number): readonly unknown[];
}

interface GraphLinkApi {
	addEdge(edge: GraphEdgeInput): void;
}

function graphQueryApi(beam: BeamMemory): GraphQueryApi | null {
	const graph = beam.episodicGraph;
	if (graph === null || typeof graph !== "object") return null;
	const candidate = graph as { findRelatedMemories?: unknown };
	return typeof candidate.findRelatedMemories === "function" ? (candidate as GraphQueryApi) : null;
}

function graphLinkApi(beam: BeamMemory): GraphLinkApi | null {
	const graph = beam.episodicGraph;
	if (graph === null || typeof graph !== "object") return null;
	const candidate = graph as { addEdge?: unknown };
	return typeof candidate.addEdge === "function" ? (candidate as GraphLinkApi) : null;
}

async function handleGraphQuery(args: ToolArguments): Promise<ToolResult> {
	const seedId = required(args, "seed_memory_id");
	if (typeof seedId !== "string") return seedId;
	const maxHops = Math.max(0, Math.trunc(numberArg(args, "max_hops", 2)));
	const edgeType = stringArg(args, "edge_type");
	const minWeight = numberArg(args, "min_weight", 0);
	return withBeam(args, (beam, bank) => {
		const graph = graphQueryApi(beam);
		if (graph === null) return { error: "Episodic graph not available", seed_memory_id: seedId, bank };
		const related = graph.findRelatedMemories(seedId, maxHops, edgeType, minWeight);
		return {
			status: "ok",
			seed_memory_id: seedId,
			count: related.length,
			results_count: related.length,
			results: serialize(related),
			related_memories: serialize(related),
			bank,
		};
	});
}

async function handleGraphLink(args: ToolArguments): Promise<ToolResult> {
	const sourceId = required(args, "source_id");
	if (typeof sourceId !== "string") return sourceId;
	const targetId = required(args, "target_id");
	if (typeof targetId !== "string") return targetId;
	const relationship = required(args, "relationship");
	if (typeof relationship !== "string") return relationship;
	return withBeam(args, (beam, bank) => {
		const graph = graphLinkApi(beam);
		if (graph === null)
			return {
				error: "Episodic graph not available",
				source_id: sourceId,
				target_id: targetId,
				relationship,
				bank,
			};
		const weight = numberArg(args, "weight", 0.5);
		graph.addEdge({
			source: sourceId,
			target: targetId,
			edgeType: relationship,
			weight,
			timestamp: new Date().toISOString(),
		});
		return {
			status: "linked",
			source_id: sourceId,
			target_id: targetId,
			relationship,
			edge_type: relationship,
			weight,
			bank,
		};
	});
}

type Handler = (args: ToolArguments) => ToolResult | Promise<ToolResult>;

const TOOL_HANDLERS: Record<string, Handler> = {
	mnemopi_remember: handleRemember,
	mnemopi_recall: handleRecall,
	mnemopi_shared_remember: handleSharedRemember,
	mnemopi_shared_recall: handleSharedRecall,
	mnemopi_shared_forget: handleSharedForget,
	mnemopi_shared_stats: () => handleSharedStats(),
	mnemopi_sleep: handleSleep,
	mnemopi_stats: handleStats,
	mnemopi_get_stats: handleStats,
	mnemopi_invalidate: handleInvalidate,
	mnemopi_validate: handleValidate,
	mnemopi_get: handleGet,
	mnemopi_triple_add: handleTripleAdd,
	mnemopi_triple_query: handleTripleQuery,
	mnemopi_scratchpad_write: handleScratchpadWrite,
	mnemopi_scratchpad_read: handleScratchpadRead,
	mnemopi_scratchpad_clear: handleScratchpadClear,
	mnemopi_export: handleExport,
	mnemopi_update: handleUpdate,
	mnemopi_forget: handleForget,
	mnemopi_import: handleImport,
	mnemopi_diagnose: handleDiagnose,
	mnemopi_graph_query: handleGraphQuery,
	mnemopi_graph_link: handleGraphLink,
};

export async function handleToolCall(name: string, args: ToolArguments = {}): Promise<ToolResult> {
	const handler = TOOL_HANDLERS[name];
	if (handler === undefined) throw new Error(`Unknown tool: ${name}`);
	return handler(args);
}
export function getToolDefinitions(): readonly ToolDefinition[] {
	return TOOLS;
}
