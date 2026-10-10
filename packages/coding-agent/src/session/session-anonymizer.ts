/**
 * Allowlist anonymizer for session JSONL files.
 *
 * Every field is exported by an explicit rule in {@link FIELD_RULES}: usage, timing, models, ids,
 * tool names, and other metadata omp writes are kept; turn contents become size-annotated markers;
 * paths become mock paths; shell commands keep program names and flags. A field without a rule —
 * and every payload omp does not define (extension/MCP data, non-built-in tool details or args,
 * `eval` display output) — becomes an opaque marker under a tokenized key. Nothing is kept because
 * of how a value looks.
 *
 * One instance carries a single token table, so equal originals map to equal tokens across every
 * line and file it processes. Path segments and placeholders share the index space:
 * `name: "Probe"` → `PLACEHOLDER_7` and `agent://Probe` → `agent://seg7`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { getBundledAgentsMap } from "../task/agents";
import { BUILTIN_TOOL_NAMES, isMCPToolName } from "../tools/builtin-names";
import { lexShellCommand } from "../tools/shell-tokenize";
import type { SessionEntry, SessionHeader } from "./session-entries";
import { collectSubSessions, type SubSession } from "./sub-sessions";

type JsonObject = Record<string, unknown>;

/** Shown wherever an anonymized export is written: the redaction is rule-based, not a guarantee. */
export const ANONYMIZED_REVIEW_NOTE =
	"Turn contents and error text are redacted and paths/literals replaced; metadata such as model names is kept — review before sharing.";

/**
 * Export rule for a field omp writes. Numbers, booleans, and null under any rule except `opaque`
 * and `label` are kept (counts, sizes, timings, flags).
 * - `num`: numeric/flag field; a string there is redacted.
 * - `time`: ISO timestamp or epoch ms.
 * - `enum`/`identity`: omp- or provider-written identifier (stop reason, model id); other shapes are tokenized.
 * - `agent`/`spawns`: bundled agent names kept, custom agent names tokenized.
 * - `id`: machine-minted ids kept; named ids mapped like the `agent://` segment they mirror.
 * - `path`/`cmd`: mock paths / shell rewrite. `text`: redaction marker. `label`: placeholder.
 * - `error`: redacted except a leading HTTP status.
 * - `tool`/`name`/`customType`: code-chosen identifiers kept; MCP (user-configured) names tokenized.
 * - `content`: string or content blocks. `struct`: nested omp structure.
 * - `args`/`details`/`data`: tool-call args, tool-result details, custom-entry data — walked only
 *   for built-in tools / omp's own entries, otherwise opaque.
 * - `opaque`: replaced whole by a marker.
 */
type Rule =
	| "num"
	| "time"
	| "enum"
	| "identity"
	| "agent"
	| "spawns"
	| "id"
	| "path"
	| "cmd"
	| "text"
	| "label"
	| "error"
	| "tool"
	| "name"
	| "customType"
	| "content"
	| "struct"
	| "args"
	| "details"
	| "data"
	| "opaque"
	| "transforms"
	| "sessionPath";

function fields(rule: Rule, keys: readonly string[]): Record<string, Rule> {
	return Object.fromEntries(keys.map(key => [key, rule]));
}

/** Every field omp writes in session records, messages, content blocks, and built-in tool details. */
const FIELD_RULES: Record<string, Rule> = {
	...fields("num", [
		"version",
		"resolvedModelIsFallback",
		"display",
		"synthetic",
		"steering",
		"liveSteered",
		"userInitiated",
		"credentialId",
		"isError",
		"useless",
		"prunedAt",
		"exitCode",
		"cancelled",
		"truncated",
		"excludeFromContext",
		"tokensBefore",
		"tokensAfter",
		"fromExtension",
		"readOnly",
		"restrictToolNames",
		"readSummarize",
		"isolated",
		"isIsolated",
		"streamIndex",
		"errorStatus",
		"errorId",
		"requestBodyReadTimeoutFullReplay",
		"duration",
		"ttft",
		"dt",
		"exactTail",
		"lineCount",
		"messageIndex",
		"attempt",
		"promptTokens",
		"nonMessageTokens",
		"historyRewriteTokensRemoved",
		"compactionEpoch",
		"lastMessageTimestamp",
		"historyRewriteAt",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"reasoningTokens",
		"total",
		"ephemeral1h",
		"ephemeral5m",
		"thresholdPercent",
		"thresholdTokens",
		"totalLines",
		"startLine",
		"lineNumbers",
		"fileSize",
		"outputBytes",
		"totalBytes",
		"outputLines",
		"start",
		"end",
		"fileCount",
		"nextOffset",
		"lastLinePartial",
		"firstLineExceedsLimit",
		"matchCount",
		"count",
		"timeoutSeconds",
		"wallTimeMs",
		"maxBytes",
		"maxColumn",
		"firstChangedLine",
		"elidedLines",
		"elidedBytes",
		"artifactElidedBytes",
		"durationMs",
		"totalDurationMs",
		"snapshotsPruned",
		"index",
		"lines",
		"elidedSpans",
		"perFileLimitReached",
		"linesTruncated",
		"fileLimitReached",
		"pagedSource",
		"toolCount",
		"requests",
		"tokens",
		"isDirectory",
		"timedOut",
		"pid",
		"resultLimitReached",
		"reached",
		"suggestion",
		"restartCount",
		"persist",
		"detached",
		"ready",
		"completionPercent",
		"errored",
		"__interrupted",
		"__synthetic",
		"executed",
		"interrupted",
		"conflictCount",
		"madeExecutable",
		"chars",
		"multi",
		"wakeRelay",
		"partialLine",
		"requestedTimeoutSeconds",
	]),
	...fields("time", [
		"timestamp",
		"startedAt",
		"recordedAt",
		"updatedAt",
		"createdAt",
		"completedAt",
		"recoveredAt",
		"exitedAt",
		"readyAt",
		"interruptedAt",
		"ts",
	]),
	...fields("enum", [
		"type",
		"role",
		"titleSource",
		"thinkingLevel",
		"configured",
		"serviceTier",
		"purpose",
		"stopReason",
		"source",
		"trigger",
		"attribution",
		"method",
		"modelRole",
		"outputSchemaMode",
		"mimeType",
		"detail",
		"kind",
		"status",
		"recovery",
		"category",
		"reason",
		"phase",
		"clearAt",
		"effort",
		"topLevel",
		"tail",
		"disabledFeatures",
		"mode",
		"truncatedBy",
		"direction",
		"unit",
		"contentType",
		"op",
		"state",
		"language",
		"languages",
		"agentSource",
		"execution",
		"outcome",
		"resolvedThinkingLevel",
		"storage",
		"server",
		"customWireName",
		"visibility",
	]),
	...fields("identity", [
		"api",
		"provider",
		"model",
		"resolvedModel",
		"upstreamProvider",
		"upstreamModel",
		"advisor",
		"selector",
		"resolvedModelIdentity",
	]),
	agent: "agent",
	spawns: "spawns",
	...fields("id", [
		"id",
		"parentId",
		"toolCallId",
		"call_id",
		"responseId",
		"firstKeptEntryId",
		"providerReplayThroughEntryId",
		"fromId",
		"targetId",
		"sourceEntryId",
		"itemId",
		"turn_id",
		"artifactId",
		"jobId",
		"agentUrlId",
		"owner",
		"replyTo",
		"from",
		"to",
	]),
	...fields("path", [
		"cwd",
		"path",
		"paths",
		"file",
		"files",
		"file_path",
		"additionalDirectories",
		"scopePath",
		"searchPath",
		"resolvedPath",
		"displayTarget",
		"url",
		"finalUrl",
		"missingPaths",
		"fullOutputPath",
		"readFiles",
		"modifiedFiles",
		// `meta.source.value` of a read: the path or URL it came from.
		"value",
	]),
	command: "cmd",
	...fields("text", [
		"text",
		"thinking",
		"summary",
		"shortSummary",
		"systemPrompt",
		"task",
		"output",
		"code",
		"warning",
		"note",
		"rawBlock",
		"filesText",
		"diff",
		"oldText",
		"newText",
		"resultText",
		"errorText",
		"error",
		"question",
		"customInput",
		"preview",
		"assignment",
		"log",
		"messages",
		"body",
	]),
	...fields("label", ["title", "previousTitle", "label", "injectedRules", "intent", "emoji", "nf"]),
	...fields("error", ["errorMessage", "explanation", "errorClassificationMessage", "upstreamError"]),
	...fields("tool", ["toolName", "tools", "declared", "deferred", "active"]),
	name: "name",
	customType: "customType",
	inputTransformations: "transforms",
	parentSession: "sessionPath",
	previousSessionFiles: "sessionPath",
	content: "content",
	...fields("struct", [
		"message",
		"usage",
		"cost",
		"cttl",
		"card",
		"contextSnapshot",
		"retryRecovery",
		"supersededBy",
		"stopDetails",
		"requestControls",
		"providerPayload",
		"items",
		"compactionThreshold",
		"toolChanges",
		"meta",
		"truncation",
		"limits",
		"columnTruncated",
		"shownRange",
		"headRange",
		"tailRange",
		"resultLimit",
		"async",
		"service",
		"daemon",
		"daemons",
		"jobs",
		"progress",
		"cells",
		"fileMatches",
		"fileReplacements",
		"perFileResults",
		"displayContent",
		"diagnostics",
		"receipts",
		"waited",
	]),
	...fields("args", ["arguments", "partialArgs", "args", "input"]),
	details: "details",
	data: "data",
	// Known fields whose payload is never useful or never safe: keep the key, redact the value.
	...fields("opaque", [
		"textSignature",
		"thinkingSignature",
		"thoughtSignature",
		"encrypted_content",
		"encryptedContent",
		"signature",
		"hash",
		"preserveData",
		"outputSchema",
		"retryFallback",
		"workPoolYieldItems",
		"providerPromptCacheKey",
		"providerFile",
		"providerMetadata",
		"toolCallAbortMessages",
		"fallbackCreditHandle",
		"annotations",
		"logprobs",
		"retainedFiles",
		"metadata",
		"internal_chat_message_metadata_passthrough",
		"block",
		"jsonOutputs",
		"structured",
		"xdev",
		"response",
		"results",
		"projectAgentsDir",
		"recentTools",
		"recentOutput",
		"statusEvents",
		"options",
		"selectedOptions",
		"phases",
		"tasks",
		"completedTasks",
		"proc",
		"cfg",
		"terminalRows",
		"notes",
	]),
};

/** Built-in tool argument keys holding prose: redacted rather than tokenized. */
const TEXT_ARG_KEYS: Record<string, true> = {
	content: true,
	text: true,
	code: true,
	task: true,
	context: true,
	prompt: true,
	message: true,
	body: true,
	input: true,
	summary: true,
	description: true,
	old_text: true,
	new_text: true,
};

/** Path/URI keys not covered by {@link PATH_KEY}. */
const PATH_KEYS: Record<string, true> = {
	file_path: true,
	dir: true,
	directory: true,
	parentSession: true,
	rename: true,
	url: true,
	uri: true,
};

/** MIME types kept verbatim in tool-written data and content blocks. */
const MIME_TYPES: ReadonlySet<string> = new Set([
	"text/markdown",
	"text/plain",
	"text/html",
	"text/css",
	"text/csv",
	"text/xml",
	"text/javascript",
	"text/typescript",
	"application/json",
	"application/xml",
	"application/pdf",
	"application/octet-stream",
	"application/feed",
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
	"video/mp4",
	"audio/mpeg",
	"unknown",
]);

/**
 * Option values of built-in tools and built-in tool details, kept only when listed. An extension may
 * shadow a built-in tool name and the transcript does not record provenance, so a built-in-looking
 * name never lets an arbitrary value through: unlisted values become placeholders.
 */
const TOOL_ENUM_VALUES: Record<string, ReadonlySet<string>> = {
	op: new Set([
		"init",
		"start",
		"done",
		"drop",
		"rm",
		"append",
		"update",
		"block",
		"wait",
		"jobs",
		"send",
		"stop",
		"cancel",
		"logs",
		"view",
		"delete",
		"list",
		"kill",
	]),
	language: new Set(["py", "js", "python", "javascript", "typescript", "ts"]),
	languages: new Set(["py", "js", "python", "javascript", "typescript", "ts"]),
	recency: new Set(["day", "week", "month", "year"]),
	case: new Set(["smart", "sensitive", "insensitive"]),
	status: new Set([
		"complete",
		"completed",
		"running",
		"success",
		"pending",
		"error",
		"failed",
		"cancelled",
		"skipped",
		"done",
		"aborted",
	]),
	direction: new Set(["head", "middle", "tail"]),
	truncatedBy: new Set(["lines", "bytes", "middle"]),
	unit: new Set(["bytes", "chars", "lines"]),
	type: new Set(["path", "internal", "url", "file", "directory", "task", "bash"]),
	state: new Set(["running", "ready", "exited", "starting", "failed", "stopped"]),
	kind: new Set(["url", "file", "directory"]),
	method: new Set([
		"text",
		"json",
		"failed",
		"native",
		"raw",
		"image",
		"jina",
		"trafilatura",
		"md-suffix",
		"content-negotiation",
		"alternate-feed",
		"alternate-markdown",
		"github-pr",
		"github-repo",
		"github-issue",
		"github-raw",
		"github-commit",
		"github-tree",
		"twitter-nitter",
	]),
	source: new Set(["interrupt_skipped", "assistant_stop_aborted", "assistant_stop_error"]),
	execution: new Set(["started", "completed"]),
	storage: new Set(["session", "file"]),
	agentSource: new Set(["bundled", "user", "project"]),
	modelRole: new Set(["default", "smol", "slow", "plan", "vision", "commit"]),
	resolvedThinkingLevel: new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
	outcome: new Set(["injected", "woken", "revived", "failed"]),
	server: new Set(["typescript-native", "typescript-language-server", "rust-analyzer", "gopls", "pyright", "clangd"]),
	contentType: MIME_TYPES,
	mimeType: MIME_TYPES,
	detail: new Set(["auto", "low", "high", "original"]),
};

/** Built-in tool argument keys holding free-form structures (env maps, schemas, structured output). */
const OPAQUE_ARG_KEYS: Record<string, true> = {
	env: true,
	data: true,
	result: true,
	outputSchema: true,
	schema: true,
	headers: true,
	json: true,
	variables: true,
	params: true,
	payload: true,
};

/** Declared argument keys of a built-in tool (at any depth) and which of them are numeric. */
interface ArgSchema {
	keys: ReadonlySet<string>;
	numeric: ReadonlySet<string>;
}

/** `"path limit#"` → keys `path`, `limit`; `#` marks a numeric field. */
function argSchema(spec: string): ArgSchema {
	const fields = spec.split(/\s+/).filter(Boolean);
	return {
		keys: new Set(fields.map(field => field.replace(/#$/, ""))),
		numeric: new Set(fields.filter(field => field.endsWith("#")).map(field => field.slice(0, -1))),
	};
}

/** Harness-level keys every tool call may carry (`i` is the intent field). */
const COMMON_ARG_KEYS = new Set(["i", "intent"]);

/**
 * Argument schemas of built-in tools, from their declared parameters. A built-in name without an
 * entry here exports its arguments as one opaque marker.
 */
const ARG_SCHEMAS: Record<string, ArgSchema> = {
	read: argSchema("path limit# offset#"),
	write: argSchema("path content"),
	edit: argSchema(
		"path input old_string new_string replace_all edits old_text new_text oldText newText op rename file_path diff content",
	),
	bash: argSchema("command timeout# cwd pty async name ready log port# host description"),
	grep: argSchema("pattern path case gitignore skip# limit# hidden glob context#"),
	glob: argSchema("path pattern hidden gitignore limit# skip#"),
	find: argSchema("query path grep_keywords limit# hidden"),
	eval: argSchema("code language title timeout# reset"),
	task: argSchema("op context tasks name task agent solutionSpace tools isolated schemaMode"),
	todo: argSchema("op items task phase list reason tasks content status phase_note"),
	wait: argSchema("ids timeout#"),
	web_search: argSchema("query limit# recency num_search_results# max_tokens# temperature#"),
	ask: argSchema("questions id question options label description recommended# header preview multi"),
	ast_grep: argSchema("pat path lang skip# limit#"),
	ast_edit: argSchema("pat out ops paths path lang"),
	github: argSchema(
		"op repo branch path pr# force forceWithLease title body base head draft fill reviewer assignee label query since until dateField limit# run tail#",
	),
	checkpoint: argSchema("goal report"),
	rewind: argSchema("goal report"),
	context_notes: argSchema("text"),
	new_context: argSchema("text"),
	memory_edit: argSchema("op id content importance# replacement_id"),
	retain: argSchema("items content context scope"),
	recall: argSchema("query"),
	reflect: argSchema("query context"),
};

/** Tool-call argument keys holding search text: always a placeholder, never path-mapped. */
const PATTERN_ARG_KEYS: Record<string, true> = {
	pattern: true,
	query: true,
	regex: true,
	search: true,
	replace: true,
};

/** Content blocks whose `name` field is a tool name. */
const TOOL_CALL_TYPES: Record<string, true> = {
	toolCall: true,
	function_call: true,
	custom_tool_call: true,
	tool_use: true,
	server_tool_use: true,
};

/**
 * Fields of each content-block type. A block is projected onto its type's fields: tools and
 * extensions build result blocks, and extra fields on an otherwise valid block are their payload.
 * Unknown block types are opaque.
 */
const CONTENT_BLOCK_KEYS: Record<string, ReadonlySet<string>> = {
	text: new Set(["type", "text", "textSignature"]),
	image: new Set(["type", "data", "mimeType", "detail", "providerFile", "url"]),
	thinking: new Set(["type", "thinking", "thinkingSignature", "itemId"]),
	redactedThinking: new Set(["type", "data"]),
	toolCall: new Set([
		"type",
		"id",
		"name",
		"arguments",
		"intent",
		"partialArgs",
		"streamIndex",
		"thoughtSignature",
		"rawBlock",
		"customWireName",
		"providerMetadata",
	]),
	fallback: new Set(["type", "from", "to"]),
	anthropicServerTool: new Set(["type", "block"]),
	output_text: new Set(["type", "text", "annotations", "logprobs"]),
};

/** Path segments too generic to identify a project; kept verbatim. */
const KEEP_SEGMENTS: Record<string, true> = {
	src: true,
	lib: true,
	test: true,
	tests: true,
	__tests__: true,
	spec: true,
	docs: true,
	doc: true,
	dist: true,
	build: true,
	out: true,
	bin: true,
	scripts: true,
	packages: true,
	crates: true,
	node_modules: true,
	target: true,
	assets: true,
	public: true,
	config: true,
	include: true,
	examples: true,
	tmp: true,
	temp: true,
	Temp: true,
	Users: true,
	home: true,
	AppData: true,
	Local: true,
	Roaming: true,
	index: true,
	main: true,
	mod: true,
	package: true,
	README: true,
	CHANGELOG: true,
	AGENTS: true,
	CLAUDE: true,
	Cargo: true,
	tsconfig: true,
	".git": true,
	".github": true,
	".vscode": true,
	".omp": true,
	".claude": true,
	".cargo": true,
	agent: true,
	sessions: true,
};

/** Programs whose name is kept when they start a shell command. A Set: `then` keys would make a Record thenable. */
const SHELL_COMMANDS = new Set([
	"git",
	"gh",
	"jj",
	"bun",
	"bunx",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"node",
	"deno",
	"python",
	"python3",
	"py",
	"pip",
	"uv",
	"cargo",
	"rustc",
	"rustup",
	"go",
	"make",
	"cmake",
	"cd",
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"fd",
	"find",
	"sed",
	"awk",
	"sort",
	"uniq",
	"wc",
	"cut",
	"tr",
	"echo",
	"printf",
	"cp",
	"mv",
	"rm",
	"mkdir",
	"rmdir",
	"touch",
	"chmod",
	"chown",
	"ln",
	"pwd",
	"which",
	"where",
	"env",
	"export",
	"set",
	"unset",
	"source",
	"test",
	"true",
	"false",
	"sleep",
	"kill",
	"ps",
	"curl",
	"wget",
	"tar",
	"zip",
	"unzip",
	"gzip",
	"docker",
	"kubectl",
	"ssh",
	"scp",
	"rsync",
	"jq",
	"xargs",
	"tee",
	"diff",
	"patch",
	"time",
	"timeout",
	"sudo",
	"nohup",
	"powershell",
	"pwsh",
	"cmd",
	"bash",
	"sh",
	"zsh",
	"nu",
	"omp",
	"gcc",
	"clang",
	"dotnet",
	"java",
	"javac",
	"mvn",
	"gradle",
	"tsc",
	"eslint",
	"prettier",
	"biome",
	"oxlint",
	"vitest",
	"jest",
	"pytest",
	"ruff",
	"mypy",
	"file",
	"stat",
	"du",
	"df",
	"date",
	"whoami",
	"uname",
	"for",
	"do",
	"done",
	"if",
	"then",
	"else",
	"fi",
	"while",
]);

/** Subcommand words of allowlisted programs (`git status`, `cargo build`), kept in first position. */
const SUBCOMMANDS: Record<string, true> = {
	add: true,
	api: true,
	apply: true,
	auth: true,
	bench: true,
	blame: true,
	branch: true,
	build: true,
	check: true,
	checkout: true,
	"cherry-pick": true,
	clean: true,
	clippy: true,
	clone: true,
	commit: true,
	compose: true,
	config: true,
	create: true,
	delete: true,
	describe: true,
	diff: true,
	doc: true,
	exec: true,
	fetch: true,
	fmt: true,
	get: true,
	grep: true,
	help: true,
	info: true,
	init: true,
	install: true,
	issue: true,
	list: true,
	log: true,
	logs: true,
	"ls-files": true,
	merge: true,
	nextest: true,
	pr: true,
	ps: true,
	publish: true,
	pull: true,
	push: true,
	rebase: true,
	remote: true,
	remove: true,
	repo: true,
	reset: true,
	restore: true,
	"rev-parse": true,
	revert: true,
	run: true,
	show: true,
	stash: true,
	status: true,
	switch: true,
	sync: true,
	tag: true,
	test: true,
	tidy: true,
	uninstall: true,
	update: true,
	upgrade: true,
	version: true,
	view: true,
	worktree: true,
	x: true,
};

/** Prefix programs after which a new command name follows. */
const COMMAND_PREFIXES = new Set(["sudo", "env", "time", "timeout", "nohup", "xargs", "do", "then", "else"]);

/** Programs whose `-N` is a count selector (`head -3`, `git log -3`). */
const NUMERIC_FLAG_PROGRAMS = new Set(["head", "tail", "git", "jj"]);

/** Long options kept verbatim for allowlisted programs; any other `--word` may carry a name. */
const LONG_FLAGS = new Set([
	"--help",
	"--version",
	"--verbose",
	"--quiet",
	"--silent",
	"--json",
	"--all",
	"--force",
	"--global",
	"--recursive",
	"--dry-run",
	"--watch",
	"--color",
	"--no-color",
	"--oneline",
	"--stat",
	"--format",
	"--pretty",
	"--graph",
	"--decorate",
	"--no-pager",
	"--short",
	"--porcelain",
	"--name-only",
	"--name-status",
	"--cached",
	"--staged",
	"--exit-code",
	"--since",
	"--until",
	"--author",
	"--message",
	"--amend",
	"--no-edit",
	"--no-verify",
	"--continue",
	"--abort",
	"--skip",
	"--rebase",
	"--ff-only",
	"--prune",
	"--tags",
	"--branch",
	"--depth",
	"--set-upstream",
	"--force-with-lease",
	"--delete",
	"--merged",
	"--remote",
	"--repo",
	"--jq",
	"--limit",
	"--state",
	"--title",
	"--body",
	"--head",
	"--base",
	"--draft",
	"--web",
	"--comments",
	"--patch",
	"--squash",
	"--merge",
	"--auto",
	"--admin",
	"--label",
	"--release",
	"--workspace",
	"--features",
	"--all-features",
	"--manifest-path",
	"--lib",
	"--tests",
	"--test",
	"--bin",
	"--target",
	"--frozen-lockfile",
	"--filter",
	"--cwd",
	"--timeout",
	"--run",
	"--bail",
	"--coverage",
	"--reporter",
	"--only",
	"--update-snapshots",
	"--ignore-case",
	"--line-number",
	"--count",
	"--files-with-matches",
	"--glob",
	"--type",
	"--hidden",
	"--no-ignore",
	"--max-count",
	"--context",
	"--after-context",
	"--before-context",
	"--fixed-strings",
	"--word-regexp",
	"--include",
	"--exclude",
	"--max-depth",
	"--sort",
	"--reverse",
	"--unique",
	"--raw-output",
	"--compact-output",
	"--slurp",
	"--null-input",
	"--method",
	"--header",
	"--data",
	"--request",
	"--location",
	"--show-error",
	"--fail",
	"--compressed",
	"--output",
	"--check",
	"--fix",
	"--write",
	"--list",
	"--interactive",
]);

/** Environment variable names kept verbatim; any other name may embed a project or tenant. */
const ENV_NAMES = new Set([
	"PATH",
	"HOME",
	"PWD",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"CI",
	"DEBUG",
	"NODE_ENV",
	"NODE_OPTIONS",
	"RUST_LOG",
	"RUST_BACKTRACE",
	"CARGO_TARGET_DIR",
	"GOPATH",
	"GOOS",
	"GOARCH",
	"PYTHONPATH",
	"VIRTUAL_ENV",
	"FORCE_COLOR",
	"NO_COLOR",
	"PAGER",
	"GIT_PAGER",
	"EDITOR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
]);

/** URI schemes kept verbatim: standard web/file schemes and omp's built-in internal schemes. */
const KNOWN_SCHEMES = new Set([
	"http",
	"https",
	"file",
	"ssh",
	"git",
	"ftp",
	"ws",
	"wss",
	"agent",
	"artifact",
	"attachment",
	"cfg",
	"conflict",
	"history",
	"issue",
	"local",
	"mcp",
	"memory",
	"omp",
	"pr",
	"proc",
	"rule",
	"security",
	"skill",
	"vault",
	"xd",
]);

/** File extensions kept on mock names; `.test`/`.spec`/`.d` qualify a known final extension. */
const KNOWN_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonl",
	"jsonc",
	"md",
	"mdx",
	"txt",
	"yml",
	"yaml",
	"toml",
	"kdl",
	"ini",
	"cfg",
	"conf",
	"env",
	"lock",
	"log",
	"csv",
	"tsv",
	"xml",
	"html",
	"css",
	"scss",
	"less",
	"svg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"ico",
	"pdf",
	"zip",
	"tar",
	"gz",
	"tgz",
	"xz",
	"rs",
	"go",
	"py",
	"rb",
	"java",
	"kt",
	"swift",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"php",
	"lua",
	"sh",
	"bash",
	"zsh",
	"ps1",
	"bat",
	"sql",
	"proto",
	"graphql",
	"vue",
	"svelte",
	"wasm",
	"diff",
	"patch",
	"ttf",
	"otf",
	"woff",
	"woff2",
	"mp3",
	"mp4",
	"wav",
	"exe",
	"dll",
	"so",
	"dylib",
]);

/** Whether every dotted part of `ext` (`.ts`, `.test.ts`, `.d.ts`) is file-extension vocabulary. */
function isKnownExtension(ext: string): boolean {
	const parts = ext.toLowerCase().split(".").filter(Boolean);
	return (
		parts.length > 0 &&
		KNOWN_EXTENSIONS.has(parts[parts.length - 1]) &&
		parts.slice(0, -1).every(part => part === "test" || part === "spec" || part === "d" || KNOWN_EXTENSIONS.has(part))
	);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTIFIER = /^[\w.:/@+-]{1,128}$/;

const ID_KEY = /(?:^id|Id|_id|Ids)$/;
/** Machine-minted ids: hex/uuid, or `prefix_<digits>` / `prefix_<token containing a digit>` (`toolu_01…`, `call_…|fc_…`). */
const RANDOM_ID = /^(?:[0-9a-f-]{6,}|[a-z]+_(?:\d+|(?=[\w|=-]*\d)[\w|=-]{6,}))$/i;
const SESSION_STEM = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+(?:\.jsonl)?$/;
const PATH_KEY = /(?:^path|Path|^paths|Paths|^cwd|Cwd|Dir|Directory|Directories|^file|File|Files)$/;
const SCHEME = /^[a-zA-Z][\w+.-]*:\/\//;
const DRIVE = /^[a-zA-Z]:(?=[\\/]|$)/;
const READ_SELECTOR = /(?::(?:raw|img|conflicts|\d[\d,+-]*|-\d+))+$/;
const EXTENSION = /^(.+?)((?:\.(?:test|spec|d))?\.[A-Za-z0-9]{1,8})$/;
const GLOB_CHARS = /([*?[\]{},])/;
const EXT_ONLY = /^(?:\.[A-Za-z0-9]{1,10})+$/;
/** Provider transcript addresses (`messages.3.content.0`), not filesystem paths. */
const MESSAGE_ADDRESS = /^messages(?:\.\w+)+$/;
const SHELL_FLAG = /^--?[A-Za-z][\w-]*$/;
const ENV_REF = /^\$\{?\w+\}?$/;
const ENV_ASSIGN = /^([A-Za-z_]\w*)=([\s\S]*)$/;
const MAX_PLACEHOLDER_LENGTH = 120;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuiltinTool(name: unknown): boolean {
	return typeof name === "string" && (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

function looksLikePath(value: string): boolean {
	// Compact JSON/brace blobs (`{"a":"b/c"}`) contain slashes but are not paths.
	if (value.length === 0 || /[\s"]/.test(value) || /^[{[(]/.test(value)) return false;
	return SCHEME.test(value) || /[\\/]/.test(value) || value.startsWith("~") || DRIVE.test(value);
}

export class SessionAnonymizer {
	#tokens = new Map<string, number>();
	/** Ids of tool calls seen in assistant messages; the execution log may only echo these raw. */
	#toolCallIds = new Set<string>();

	#index(value: string): number {
		let index = this.#tokens.get(value);
		if (index === undefined) {
			index = this.#tokens.size + 1;
			this.#tokens.set(value, index);
		}
		return index;
	}

	/** Consistent opaque stand-in for a short string literal. */
	placeholder(value: string): string {
		return value === "" ? "" : `PLACEHOLDER_${this.#index(value)}`;
	}

	/** Size-annotated marker replacing turn content. */
	redactText(value: string): string {
		if (value === "") return "";
		const lines = value.split("\n").length;
		return `[redacted #${this.#index(value)}: ${value.length} chars, ${lines} line${lines === 1 ? "" : "s"}]`;
	}

	/** Mock path preserving separators, scheme, drive, extensions, and read selectors. Accepts `;`-joined lists. */
	path(value: string): string {
		return value
			.split(";")
			.map(part => {
				// `a; b` lists: keep the separator spacing out of the mapped segment.
				const trimmed = part.trim();
				return trimmed === "" ? part : part.replace(trimmed, () => this.#singlePath(trimmed));
			})
			.join(";");
	}

	/** Mock name for a single path segment (also used for output file names). */
	segment(value: string): string {
		// Numeric segments are often tenant/ticket/account ids; only `.`/`..`/`~` pass through.
		if (value === "" || value === "." || value === ".." || value === "~") return value;
		if (KEEP_SEGMENTS[value] === true) return value;
		if (GLOB_CHARS.test(value)) {
			return value
				.split(GLOB_CHARS)
				.map(piece =>
					piece === "" || GLOB_CHARS.test(piece) || (EXT_ONLY.test(piece) && isKnownExtension(piece))
						? piece
						: this.#name(piece),
				)
				.join("");
		}
		return this.#name(value);
	}

	/** Anonymize one session record (header or entry). */
	entry(value: unknown): unknown {
		return isObject(value) ? this.#struct(value) : this.#opaque(value);
	}

	#name(value: string): string {
		if (value.startsWith(".") && value.length > 1) return `.${this.#name(value.slice(1))}`;
		const match = EXTENSION.exec(value);
		// Only real file extensions survive; `customer.alice` is a name, not a `.alice` file.
		if (match && !/^\d+$/.test(match[1]) && isKnownExtension(match[2])) {
			// Index the whole name so `Probe.v2` shares its token with `PLACEHOLDER_N` and `agent://`.
			return `${KEEP_SEGMENTS[match[1]] === true ? match[1] : `seg${this.#index(value)}`}${match[2]}`;
		}
		return `seg${this.#index(value)}`;
	}

	#singlePath(raw: string): string {
		if (raw.trim() === "") return raw;
		let rest = raw;
		let prefix = "";
		let suffix = "";
		const scheme = SCHEME.exec(rest);
		if (scheme) {
			// Custom schemes (MCP resources) can name a server or customer; only known ones stay.
			const name = scheme[0].slice(0, -3);
			prefix = KNOWN_SCHEMES.has(name.toLowerCase()) ? scheme[0] : `${this.placeholder(name)}://`;
			rest = rest.slice(scheme[0].length);
			const query = rest.indexOf("?");
			if (query >= 0) {
				suffix = `?${this.placeholder(rest.slice(query + 1))}`;
				rest = rest.slice(0, query);
			}
		} else {
			const drive = DRIVE.exec(rest);
			if (drive) {
				prefix = drive[0];
				rest = rest.slice(prefix.length);
			}
		}
		const selector = READ_SELECTOR.exec(rest);
		if (selector && selector.index > 0) {
			suffix = selector[0] + suffix;
			rest = rest.slice(0, selector.index);
		}
		const mapped = rest
			.split(/([\\/]+)/)
			.map(piece => (/^[\\/]*$/.test(piece) ? piece : this.segment(piece)))
			.join("");
		return prefix + mapped + suffix;
	}

	/** String in an unknown slot: path-shaped → mock path, short → placeholder, else redacted. */
	#literal(value: string, detectPath = true): string {
		if (detectPath && looksLikePath(value)) return this.path(value);
		if (!value.includes("\n") && value.length <= MAX_PLACEHOLDER_LENGTH) return this.placeholder(value);
		return this.redactText(value);
	}

	/** Opaque marker for a value with no export rule; keeps only its size and an equality index. */
	#opaque(value: unknown): unknown {
		if (value === undefined) return value;
		return this.redactText(typeof value === "string" ? value : JSON.stringify(value));
	}

	/**
	 * Walk an omp-defined object: ruled fields by rule, unknown fields opaque under a tokenized key.
	 * `fromTool` marks built-in tool details, whose writer cannot be verified from the transcript.
	 */
	#struct(object: JsonObject, fromTool = false): JsonObject {
		// Real tool-call ids, so execution-log entries (which extensions can spoof) only keep ids that exist.
		if (!fromTool && TOOL_CALL_TYPES[String(object.type)] === true && typeof object.id === "string") {
			this.#toolCallIds.add(object.id);
		}
		const out: JsonObject = {};
		for (const [key, value] of Object.entries(object)) {
			const rule = Object.hasOwn(FIELD_RULES, key) ? FIELD_RULES[key] : undefined;
			if (rule === undefined) out[this.placeholder(key)] = this.#opaque(value);
			else out[key] = this.#field(rule, value, object, key, fromTool);
		}
		return out;
	}

	/** A content block projected onto its type's fields; extra fields become opaque under tokenized keys. */
	#contentBlock(block: JsonObject, fromTool: boolean): unknown {
		const allowed = typeof block.type === "string" ? CONTENT_BLOCK_KEYS[block.type] : undefined;
		if (!allowed) return this.#opaque(block);
		const out: JsonObject = {};
		for (const [key, value] of Object.entries(block)) {
			const rule = allowed.has(key) && Object.hasOwn(FIELD_RULES, key) ? FIELD_RULES[key] : undefined;
			if (rule === undefined) out[this.placeholder(key)] = this.#opaque(value);
			// A tool call is the model's own request (its id must stay joinable with the result).
			else out[key] = this.#field(rule, value, block, key, fromTool && block.type !== "toolCall");
		}
		if (block.type === "toolCall" && typeof block.id === "string") this.#toolCallIds.add(block.id);
		return out;
	}

	/**
	 * `tool_execution_start` data, projected onto its exact schema. Extensions can append a custom entry
	 * under any `customType`, so nothing beyond these fields is trusted, and the call id stays raw only
	 * when it names a tool call already seen in the transcript.
	 */
	#executionLog(data: JsonObject): JsonObject {
		const out: JsonObject = {};
		for (const [key, value] of Object.entries(data)) {
			switch (key) {
				case "toolCallId":
					// A known call id gets the same treatment as in its message; anything else is tokenized.
					out[key] = this.#field(
						"id",
						value,
						data,
						key,
						!(typeof value === "string" && this.#toolCallIds.has(value)),
					);
					break;
				case "toolName":
					out[key] = this.#field("tool", value, data, key, true);
					break;
				case "startedAt":
					out[key] = this.#field("time", value, data, key, true);
					break;
				case "args":
					out[key] = this.#toolArgs(value, data);
					break;
				case "intent":
					out[key] = this.#field("label", value, data, key, true);
					break;
				default:
					out[this.placeholder(key)] = this.#opaque(value);
			}
		}
		return out;
	}

	#field(rule: Rule, value: unknown, parent: JsonObject, key: string, fromTool: boolean): unknown {
		// Payload scopes come first: a primitive inside an untrusted payload is still untrusted.
		switch (rule) {
			case "opaque":
				return this.#opaque(value);
			case "args":
				// `input` is also a usage counter; only a tool-call envelope makes it arguments.
				if (typeof parent.name === "string" || typeof parent.toolName === "string") {
					return this.#toolArgs(value, parent);
				}
				break;
			case "details":
				// Built-in tools write their own details; anything else is an extension payload.
				return parent.role === "toolResult" && isBuiltinTool(parent.toolName) && isObject(value)
					? this.#struct(value, true)
					: this.#opaque(value);
			case "data":
				// omp's execution log mirrors the tool call; every other custom entry is extension state.
				return parent.type === "custom" && parent.customType === "tool_execution_start" && isObject(value)
					? this.#executionLog(value)
					: this.#opaque(value);
			case "name":
				return this.#field(
					TOOL_CALL_TYPES[String(parent.type)] === true ? "tool" : "label",
					value,
					parent,
					key,
					fromTool,
				);
		}
		if (value === null || typeof value === "number" || typeof value === "boolean") {
			return rule === "label" ? this.placeholder(String(value)) : value;
		}
		if (Array.isArray(value)) return value.map(item => this.#field(rule, item, parent, key, fromTool));
		if (isObject(value)) {
			if (rule === "content") {
				// Tool results and extension messages carry tool-built blocks: their enum fields are untrusted.
				const untrusted =
					fromTool ||
					parent.role === "toolResult" ||
					parent.role === "custom" ||
					parent.role === "hookMessage" ||
					parent.type === "custom_message";
				return this.#contentBlock(value, untrusted);
			}
			// Only structural rules descend; a scalar field holding an object is not omp's shape.
			const descends = rule === "struct" || rule === "enum" || rule === "id" || rule === "path" || rule === "tool";
			if (rule === "transforms") {
				// Provider input transformations address transcript slots (`messages.3.content.0`), not files.
				const out = this.#struct(value, fromTool);
				if (typeof value.path === "string" && MESSAGE_ADDRESS.test(value.path)) out.path = value.path;
				return out;
			}
			return descends ? this.#struct(value, fromTool) : this.#opaque(value);
		}
		if (typeof value !== "string") return this.#opaque(value);
		return this.#string(rule, value, key, fromTool);
	}

	#string(rule: Rule, value: string, key: string, fromTool: boolean): string {
		switch (rule) {
			case "time":
				return ISO_TIMESTAMP.test(value) ? value : this.placeholder(value);
			case "enum":
				// Tool-written values come from a closed list: a shadowing extension can reuse any field name.
				if (fromTool) return TOOL_ENUM_VALUES[key]?.has(value) ? value : this.placeholder(value);
				return value.length <= 64 && IDENTIFIER.test(value) ? value : this.placeholder(value);
			case "identity":
				if (fromTool) return /^[\w.-]+\/[\w.:@+-]+$/.test(value) ? value : this.placeholder(value);
				return IDENTIFIER.test(value) ? value : this.placeholder(value);
			case "agent":
				return getBundledAgentsMap().has(value) ? value : this.placeholder(value);
			case "spawns":
				return value === "" || value === "*"
					? value
					: value
							.split(",")
							.map(part => this.#string("agent", part.trim(), key, fromTool))
							.join(",");
			case "id":
				// Machine-minted ids omp writes stay joinable with provider logs; tool-written and named
				// ids (subagent names) are mapped like the `agent://` segment they mirror.
				return !fromTool && RANDOM_ID.test(value) ? value : this.segment(value);
			case "path":
				return this.path(value);
			case "sessionPath": {
				// A session file name (`<iso-time>_<session-id>.jsonl`) only repeats kept metadata; keeping it
				// leaves `parentSession` pointing at the anonymized parent. Directories are mocked as usual.
				const base = /[^\\/]*$/.exec(value)?.[0] ?? "";
				const dir = value.slice(0, value.length - base.length);
				return (dir ? this.path(dir) : "") + (SESSION_STEM.test(base) ? base : this.segment(base));
			}
			case "cmd":
				return this.command(value);
			case "label":
			case "struct":
				return this.placeholder(value);
			case "error": {
				// Provider errors can echo request content or credentials: only a leading HTTP status survives.
				const status = /^\d{3}\b/.exec(value);
				return status
					? `${status[0]} ${this.redactText(value.slice(status[0].length).trimStart())}`
					: this.redactText(value);
			}
			case "tool":
				// Built-in and extension tool names are chosen in code; MCP names embed user-configured server names.
				return isBuiltinTool(value) || (!isMCPToolName(value) && /^[A-Za-z][\w.-]{0,63}$/.test(value))
					? value
					: this.placeholder(value);
			case "customType":
				return /^[a-z][a-z0-9_:.-]{0,63}$/.test(value) ? value : this.placeholder(value);
			default:
				// `num`, `text`, `content`: a string here is turn content (or not omp's shape).
				return this.redactText(value);
		}
	}

	/** Tool-call args: built-in tools walk their known schema; any other tool's args are opaque. */
	#toolArgs(value: unknown, parent: JsonObject): unknown {
		const toolName = typeof parent.name === "string" ? parent.name : parent.toolName;
		const schema = typeof toolName === "string" && isBuiltinTool(toolName) ? ARG_SCHEMAS[toolName] : undefined;
		if (!schema) return this.#opaque(value);
		if (typeof value !== "string") return this.#argValue(value, undefined, schema);
		// Wire payloads carry arguments as JSON text; partial streams may not parse.
		try {
			return JSON.stringify(this.#argValue(JSON.parse(value), undefined, schema));
		} catch {
			return this.redactText(value);
		}
	}

	/**
	 * One built-in tool argument. Only keys the tool's schema declares stay (a shadowing extension can
	 * send any record), and numbers stay only in the schema's numeric fields (limits, timeouts, lines).
	 */
	#argValue(value: unknown, key: string | undefined, schema: ArgSchema): unknown {
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			return key !== undefined && schema.numeric.has(key) ? value : this.placeholder(String(value));
		}
		if (Array.isArray(value)) return value.map(item => this.#argValue(item, key, schema));
		if (isObject(value)) {
			const out: JsonObject = {};
			for (const [childKey, child] of Object.entries(value)) {
				if (OPAQUE_ARG_KEYS[childKey] === true) out[childKey] = this.#opaque(child);
				else if (schema.keys.has(childKey) || COMMON_ARG_KEYS.has(childKey)) {
					out[childKey] = this.#argValue(child, childKey, schema);
				} else out[this.placeholder(childKey)] = this.#opaque(child);
			}
			return out;
		}
		if (typeof value !== "string") return this.#opaque(value);
		if (key === undefined) return this.#literal(value);
		// Model-written ids are tokenized (consistently), never exported raw.
		if (ID_KEY.test(key)) return this.segment(value);
		if (PATH_KEYS[key] === true || PATH_KEY.test(key)) return this.path(value);
		if (key === "command" || key === "cmd") return this.command(value);
		if (key === "agent") return this.#string("agent", value, key, true);
		if (TOOL_ENUM_VALUES[key]?.has(value)) return value;
		if (TEXT_ARG_KEYS[key] === true) return this.redactText(value);
		return this.#literal(value, PATTERN_ARG_KEYS[key] !== true);
	}

	/** Shell command with allowlisted programs, their flags/subcommands, and operators kept; literals replaced. */
	command(value: string): string {
		let out = "";
		let commandStart = true;
		let program: string | undefined;
		let argIndex = 0;
		let redirectTarget = false;
		let previousWord = "";
		let descriptorNext = false;
		let optionsEnded = false;
		for (const token of lexShellCommand(value)) {
			if (token.kind === "separator") {
				out += token.raw;
				// The shared lexer splits `2>&1` at `&`; the word after a trailing `>`/`<` is a descriptor.
				descriptorNext = token.raw === "&" && /[<>]$/.test(previousWord);
				if (descriptorNext) {
					redirectTarget = false;
				} else if (/[\n;&|()]/.test(token.raw)) {
					commandStart = true;
					program = undefined;
					optionsEnded = false;
				}
				continue;
			}
			const word = token.raw;
			previousWord = word;
			if (descriptorNext && /^\d+$/.test(word)) {
				descriptorNext = false;
				out += word;
				continue;
			}
			descriptorNext = false;
			// The lexer keeps redirections inside words (`>out.txt`, `2>`, `<<EOF`); their operand is a path.
			const redirect = /^\d*(?:>>?|<<?-?)/.exec(word);
			if (redirect) {
				const target = word.slice(redirect[0].length);
				out += redirect[0] + (target === "" ? "" : this.#shellValue(target, true));
				redirectTarget = target === "";
				continue;
			}
			if (redirectTarget) {
				redirectTarget = false;
				out += this.#shellValue(word, true);
				continue;
			}
			if (commandStart) {
				const assign = ENV_ASSIGN.exec(word);
				if (assign) {
					out += `${this.#envName(assign[1])}=${this.#shellValue(assign[2], false)}`;
					continue;
				}
				commandStart = COMMAND_PREFIXES.has(word);
				program = SHELL_COMMANDS.has(word) ? word : undefined;
				out += program ?? this.#shellValue(word, false);
				argIndex = 0;
				optionsEnded = false;
				continue;
			}
			// After `--` every word is an operand (`head -- -123456789` reads a file named `-123456789`).
			if (optionsEnded) {
				out += this.#shellValue(word, false);
				continue;
			}
			if (word === "--") {
				optionsEnded = true;
				out += word;
				continue;
			}
			out += this.#shellArg(word, program, argIndex);
			// Positional index only: `git --no-pager log` still sees `log` as the subcommand.
			if (!word.startsWith("-")) argIndex++;
		}
		return out;
	}

	#shellArg(word: string, program: string | undefined, argIndex: number): string {
		if (ENV_REF.test(word)) return this.#envRef(word);
		// Flag names are vocabulary only for allowlisted programs; an unknown script's flags may name things.
		if (program === undefined) return this.#shellValue(word, false);
		// `-3` is a count selector only for programs that define one; elsewhere (`echo -123`) it is data.
		if (/^-\d+$/.test(word)) return NUMERIC_FLAG_PROGRAMS.has(program) ? word : this.#shellValue(word, false);
		// A short option is one letter; anything attached (`-ehunter2`, `-ecustomer=secret`) is its value.
		if (/^-[A-Za-z]/.test(word)) {
			return word.length <= 2 ? word : word.slice(0, 2) + this.#shellValue(word.slice(2), false);
		}
		if (SHELL_FLAG.test(word)) return LONG_FLAGS.has(word) ? word : this.#shellValue(word, false);
		// Long options must be known vocabulary; their `=value` is a literal.
		const flagValue = /^(--[A-Za-z][\w-]*)=([\s\S]*)$/.exec(word);
		if (flagValue && LONG_FLAGS.has(flagValue[1])) {
			return `${flagValue[1]}=${this.#shellValue(flagValue[2], false)}`;
		}
		if (argIndex === 0 && SUBCOMMANDS[word] === true) return word;
		return this.#shellValue(word, false);
	}

	/** Transform one shell word, preserving surrounding quotes. */
	#shellValue(word: string, isPath: boolean): string {
		const quote = word[0];
		if ((quote === '"' || quote === "'") && word.length >= 2 && word.endsWith(quote)) {
			return quote + this.#shellValue(word.slice(1, -1), isPath) + quote;
		}
		if (word === "") return word;
		if (ENV_REF.test(word)) return this.#envRef(word);
		if (isPath || looksLikePath(word)) return this.path(word);
		return this.#literal(word);
	}

	/** Environment variable name: well-known names stay, user-defined ones share the token table. */
	#envName(name: string): string {
		return ENV_NAMES.has(name) ? name : this.placeholder(name);
	}

	/** `$NAME` / `${NAME}` with the name mapped like its assignment. */
	#envRef(word: string): string {
		return word.replace(/\w+/, name => this.#envName(name));
	}
}

/** A session transcript to anonymize: its header, entries, and file (for subagent discovery). */
export interface AnonymizeSessionInput {
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	sessionFile?: string;
	/** Malformed records the caller skipped while loading the main transcript. */
	malformedRecords?: number;
}

/** Anonymized JSONL bodies for a session and its persisted subagents. */
export interface AnonymizedTranscripts {
	/** `[member path, JSONL body]`: `session.jsonl`, then `subagents/<mapped agent path>.jsonl`. */
	files: Array<readonly [string, string]>;
	subagentCount: number;
	/** Why subagent discovery failed; the main transcript is anonymized regardless. */
	subagentError?: string;
	/** `[member path, count]` for transcripts whose malformed JSONL records were skipped. */
	malformed: Array<readonly [string, number]>;
	/** Subagent transcripts (mapped member paths) skipped because no session header could be read. */
	unreadable: string[];
}

/**
 * Anonymize a session and every subagent transcript stored next to it with one
 * shared token table, so names, paths, and literals correlate across files.
 */
export async function anonymizeSessionTranscripts(session: AnonymizeSessionInput): Promise<AnonymizedTranscripts> {
	const anonymizer = new SessionAnonymizer();
	const toJsonl = (header: SessionHeader | null, entries: readonly SessionEntry[]): string => {
		const records: unknown[] = header ? [header, ...entries] : [...entries];
		return `${records.map(record => JSON.stringify(anonymizer.entry(record))).join("\n")}\n`;
	};
	const files: Array<readonly [string, string]> = [["session.jsonl", toJsonl(session.header, session.entries)]];
	const malformed: Array<readonly [string, number]> = [];
	if (session.malformedRecords) malformed.push(["session.jsonl", session.malformedRecords]);
	const unreadable: string[] = [];
	// Agent ids map through the same table as `agent://<id>` path segments.
	const memberFor = (key: string): string =>
		`subagents/${key
			.split("/")
			.map(part => anonymizer.segment(part))
			.join("/")}.jsonl`;
	let subSessions: Record<string, SubSession> = {};
	let subagentError: string | undefined;
	try {
		if (session.sessionFile) {
			subSessions = await collectSubSessions(session.sessionFile, key => unreadable.push(memberFor(key)));
		}
	} catch (error) {
		subagentError = error instanceof Error ? error.message : String(error);
		logger.warn("Failed to collect subagent transcripts for anonymization", { error: subagentError });
	}
	for (const [key, sub] of Object.entries(subSessions)) {
		const member = memberFor(key);
		files.push([member, toJsonl(sub.header, sub.entries)]);
		if (sub.malformedRecords > 0) malformed.push([member, sub.malformedRecords]);
	}
	return { files, subagentCount: files.length - 1, subagentError, malformed, unreadable };
}
