import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	discoverGitLabDuoWorkflowRuntimeNamespace,
	type GitLabDuoWorkflowNamespaceSelection,
} from "@oh-my-pi/pi-catalog/discovery/gitlab-duo-workflow";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";
import chatmlHistoryNote from "./gitlab-duo-workflow-chatml-note.md" with { type: "text" };
import { redactSensitiveCredentials } from "./transform-messages";

export const GITLAB_DUO_WORKFLOW_PROVIDER_ID = "gitlab-duo-agent";
export const GITLAB_DUO_WORKFLOW_API = "gitlab-duo-agent";
export const GITLAB_DUO_WORKFLOW_DEFINITION = "ambient";
export type GitLabDuoWorkflowDefinition = "ambient" | (string & {});

const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";
const GITLAB_DUO_WORKFLOW_TRACE_ENV = "GITLAB_DUO_WORKFLOW_TRACE";
const GITLAB_DUO_WORKFLOW_TRACE_FILE_ENV = "GITLAB_DUO_WORKFLOW_TRACE_FILE";
const DEFAULT_GITLAB_DUO_WORKFLOW_TRACE_FILE = path.resolve(
	import.meta.dir,
	"../../../../.tmp/gitlab-duo-workflow-trace.log",
);
const GITLAB_DUO_WORKFLOW_CLIENT_TYPE = "node-websocket";
/**
 * Idle deadline for the workflow WebSocket. The socket has no server-side
 * keepalive contract OMP can rely on, so a connection silently going half-open
 * (proxy/LB drops the TCP link without delivering FIN/RST) would otherwise leave
 * `runGitLabDuoWorkflowSocket` waiting forever. If no frame arrives within this
 * window — before open or between checkpoints — the socket is aborted and the
 * run reconnects once on the same `workflowID` (server-side resume).
 */
const GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS = 90_000;
/**
 * Absolute deadline (ms) for each REST setup fetch (`ensureGitLabDuoWorkflowSettings`,
 * `discoverGitLabDuoWorkflowProject`, `resolveGitLabDuoWorkflowNumericProjectId`,
 * `requestGitLabDuoWorkflowDirectAccess`, `createGitLabDuoWorkflow`,
 * `fetchGitLabDuoWorkflowAvailableModels`, `stopGitLabDuoWorkflow`).
 *
 * `streamGitLabDuoWorkflow` pushes its `start` event before these calls run and the
 * `gitlab-duo-agent` bypass in `streamSimple` skips the `register-builtins`
 * `iterateWithIdleTimeout` wrapper, so a stalled setup fetch would otherwise leave
 * the stream with no terminal event. 30s covers healthy p99 for every REST endpoint
 * the workflow touches while still surfacing a real stall as a provider error;
 * matches the OAuth `TOKEN_REQUEST_TIMEOUT_MS` used by sibling GitLab flows.
 */
const GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS = 30_000;
/**
 * How many times a single stream may restart on a FRESH workflow after the server
 * reports its per-workflow step (graph-recursion) limit. Long OMP tool-call loops
 * legitimately overrun the cap; each restart resets the budget. Bounded so a task
 * that perpetually overruns degrades to a graceful stop instead of looping on quota.
 */
const GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS = 4;
/**
 * How many times a single stream may restart on a FRESH workflow after the server
 * returns its de-identified catch-all FAILED (transient upstream fault wrapper).
 * Kept low because, unlike the step limit, a generic failure that repeats is more
 * likely deterministic; one bounded retry covers the common transient case without
 * looping on quota.
 */
const GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES = 1;
/**
 * How many times a single stream may restart on a FRESH workflow after detecting a
 * stalled workflow: the server emitted a fresh checkpoint at a tool-call boundary
 * but its `ui_chat_log` total did NOT advance past the previous tool-call boundary
 * of the SAME workflow. A healthy run strictly grows the log each turn (agent
 * reasoning + tool boundary entries); a flat total means the server-side turn did
 * not progress — the model re-issues the same tool call against a history that
 * never gained its prior call/result (captured live: total pinned at 2 while the
 * model repeated `next_step({"n":1})`). Restarting on a fresh workflow resends the
 * full goal transcript (rebuilt from the agent loop's intact `context.messages`,
 * so no in-flight tool result is lost) and the new run progresses. Bounded so a
 * persistently stalling endpoint degrades to a surfaced result instead of a quota
 * sink.
 */
const GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS = 2;
/**
 * Surfaced when a workflow stalled (its `ui_chat_log` total stopped advancing) and
 * every bounded fresh-workflow restart also stalled. Phrased as a transient
 * server-side failure so the agent loop treats it as a normal error rather than a
 * client bug.
 */
const GITLAB_DUO_WORKFLOW_STALL_ERROR_MESSAGE =
	"GitLab Duo Agent stopped making progress (the workflow's visible history did not advance after multiple restarts).";
/**
 * Two rendered-`goal` byte thresholds bounding three reliability zones. Empirically
 * the DWS/Workhorse transport accepts no fixed token wall (it has tokenized
 * 970k-token goals) but its failure probability rises with the rendered-goal BYTE
 * size: ≤~1MB is the reliable floor we now treat as the auto-compaction trigger,
 * ~1.4–1.7MB is a jitter band where a request fails more often than not but can still
 * go through, ≥~2MB basically always fails, and 4MB is the DWS gRPC `MAX_MESSAGE_SIZE`
 * hard cap. The soft threshold was lowered from 1.25MB to 1MB because the higher value
 * almost never fired in practice — auto-compaction needs to engage earlier.
 *
 * - `[0, SOFT)` reliable zone: send normally; an error here is a genuine upstream
 *   fault and surfaces verbatim.
 * - `[SOFT, HARD)` jitter zone: still attempt once (it can succeed); if the run then
 *   ERRORS, the size is the likely cause, so re-label it as a context-overflow to
 *   drive auto-compaction.
 * - `[HARD, ∞)` necessary-fail zone: do NOT spend the request — proactively end the
 *   stream with the overflow error so the session compacts immediately.
 *
 * `SOFT` is the auto-compaction trigger floor; `HARD` is the necessary-fail floor.
 * Re-labeling uses {@link buildGitLabDuoWorkflowGoalOverflowMessage}.
 */
const GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES = 1_048_576;
const GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES = 2_000_000;

// An overflow-pattern message for an oversized goal. The "prompt is too long" prefix
// is one of the shared overflow classifier patterns, so
// `isContextOverflow` recognizes it and the session triggers auto-compaction instead
// of surfacing a hard failure. Byte counts (not tokens) are reported because the
// budget is a byte budget.
function buildGitLabDuoWorkflowGoalOverflowMessage(goalBytes: number): string {
	return `prompt is too long: ${goalBytes} bytes exceeds the GitLab Duo Agent goal byte budget (soft ${GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES}, hard ${GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES})`;
}
const GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION = "8.104.0";
const GITLAB_DUO_WORKFLOW_AVAILABLE_MODELS_QUERY = `query omp_gitlabDuoWorkflowAvailableModels($rootNamespaceId: GroupID!) {
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
    defaultModel { name ref }
    selectableModels { name ref }
    pinnedModel { name ref }
  }
}`;

export const GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES = [
	"incremental_streaming",
	"read_file_chunked",
	"shell_command",
	"command_timeout",
	"tool_call_approval",
] as const;

const GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME = "omp_agent";
const GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID = "omp_inline_prompt";
// `on_agent_reasoning` is what makes the server tag an agent's pre-tool-call
// commentary as `message_sub_type: "reasoning"` — the chain-of-thought the
// official Duo CLI surfaces. An inline flow must opt in explicitly.
const GITLAB_DUO_WORKFLOW_INLINE_UI_LOG_EVENTS = [
	"on_agent_reasoning",
	"on_agent_final_answer",
	"on_tool_execution_success",
	"on_tool_execution_failed",
] as const;

const GITLAB_DUO_WORKFLOW_ACTION_NAMES = ["runMCPTool", "run_mcp_tool"] as const;

export interface GitLabMcpToolArgs {
	name?: string;
	tool_name?: string;
	toolName?: string;
	providerIdentifier?: string;
	provider_identifier?: string;
	toolCallId?: string;
	tool_call_id?: string;
	args?: Record<string, unknown> | string;
	arguments?: Record<string, unknown> | string;
}

export interface GitLabPlainTextResponse {
	response?: string;
	error?: string;
}

export type PlainTextResponse = GitLabPlainTextResponse;
export interface GitLabDuoWorkflowOptions extends StreamOptions {
	rootNamespaceId?: string;
	namespaceId?: string;
	projectId?: string;
	projectPath?: string;
	workflowDefinition?: GitLabDuoWorkflowDefinition;
	workflowId?: string;
	workflowToken?: string;
	cwd?: string;
	webSocketFactory?: GitLabDuoWorkflowWebSocketFactory;
	/** Idle WebSocket deadline (ms) before aborting and resuming; defaults to {@link GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS}. */
	idleTimeoutMs?: number;
	/**
	 * Tool-choice override forwarded from the stream layer. Only `"none"` is
	 * acted on: a side-request (e.g. handoff) keeps tool definitions in the cache
	 * prefix but disables tool use, so the provider must not advertise them to Duo.
	 */
	toolChoice?: ToolChoice;
}

export interface GitLabDuoWorkflowWebSocketLike {
	readyState?: number;
	binaryType?: string;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface GitLabDuoWorkflowWebSocketFactoryOptions {
	headers: Record<string, string>;
	protocols?: string[];
}

export type GitLabDuoWorkflowWebSocketFactory = (
	url: string,
	options: GitLabDuoWorkflowWebSocketFactoryOptions,
) => GitLabDuoWorkflowWebSocketLike;

export interface GitLabDirectAccessResponse {
	token?: string;
	access_token?: string;
	jwt?: string;
	workflow_token?: string;
	duo_workflow_access_token?: string;
	duo_workflow_service?: { token?: string; base_url?: string; headers?: Record<string, string> };
	gitlab_rails?: { token?: string };
	[key: string]: unknown;
}

interface GitLabDuoWorkflowDirectAccessConnection {
	token: string;
	baseUrl?: string;
	headers: Record<string, string>;
	serviceEndpoint: boolean;
}

interface GitLabCreateWorkflowResponse {
	id?: string | number;
	workflow_id?: string | number;
	workflowId?: string | number;
	[key: string]: unknown;
}

interface GitLabDuoWorkflowCreateBodyOptions {
	projectId?: string;
	goal?: string;
	workflowDefinition?: GitLabDuoWorkflowDefinition;
}

interface GitLabDuoWorkflowStartMetadataOptions {
	projectId?: string;
	projectPath?: string;
	namespaceId?: string;
	rootNamespaceId?: string;
	workflowDefinition?: GitLabDuoWorkflowDefinition;
	inlineFlow?: boolean;
}
export interface GitLabMcpToolDefinition {
	name: string;
	originalToolName: string;
	serverName: string;
	description: string;
	inputSchema: string;
	isApproved: boolean;
}

export interface GitLabDuoWorkflowAdditionalContextItem {
	id: string;
	category: "agent_user_environment" | "user_rule";
	content: string;
	metadata: {
		title: string;
		enabled: boolean;
		subType: "snippet";
		icon: string;
		secondaryText: string;
		subTypeLabel: string;
	};
}

export interface GitLabDuoWorkflowStartRequest {
	workflowID: string;
	clientVersion: "1.0";
	workflowDefinition: GitLabDuoWorkflowDefinition;
	goal: string;
	workflowMetadata: string;
	additional_context: readonly GitLabDuoWorkflowAdditionalContextItem[];
	approval?: {
		approval?: Record<string, never>;
		rejection?: { message?: string };
	};
	clientCapabilities: readonly (typeof GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES)[number][];
	mcpTools: GitLabMcpToolDefinition[];
	preapproved_tools: string[];
	flowConfigSchemaVersion?: "v1";
	flowConfigId?: string;
	flowVersion?: string;
	flowConfig?: GitLabDuoWorkflowInlineFlowConfig;
}

export interface GitLabDuoWorkflowInlineFlowComponent {
	name: string;
	type: "AgentComponent";
	prompt_id: string;
	toolset: string[];
	inputs: { from: string; as: string }[];
	ui_log_events: string[];
}

export interface GitLabDuoWorkflowInlineFlowPrompt {
	name: string;
	prompt_id: string;
	unit_primitives: string[];
	prompt_template: { system: string; user: string; placeholder: string };
}

export interface GitLabDuoWorkflowInlineFlowConfig {
	version: "v1";
	environment: "ambient";
	flow: { entry_point: string };
	components: GitLabDuoWorkflowInlineFlowComponent[];
	routers: { from: string; to: string }[];
	prompts: GitLabDuoWorkflowInlineFlowPrompt[];
}

export interface GitLabDuoWorkflowActionResponse {
	actionResponse: {
		requestID: string;
		plainTextResponse?: GitLabPlainTextResponse;
	};
}

interface GitLabDuoWorkflowActionDescriptor {
	requestID: string;
	name: string;
	args: unknown;
}

export interface GitLabDuoWorkflowActiveSession {
	workflowId: string;
	startPayload: GitLabDuoWorkflowStartRequest;
	ws: GitLabDuoWorkflowWebSocketLike;
	// Best-effort server-side stop for THIS workflow, captured with its own
	// fetch/baseUrl/apiKey so `ProviderSessionState.close()` (session reset/dispose)
	// can stop a workflow the server is still running, even though it holds none of
	// that context itself. Fire-and-forget; never throws.
	stop?: () => void;
	pendingActions?: GitLabDuoWorkflowActionDescriptor[];
	checkpointAgentContentByKey?: Record<string, string>;
	checkpointAgentContentSignatures?: Record<string, true>;
	paused?: boolean;
	pauseBuffer?: unknown[];
	// Byte length of the server's last checkpoint observed at this workflow's tool-call
	// boundaries. The control experiment proved a healthy turn emits checkpoints whose
	// byte size varies and progresses, while a stalled workflow re-emits a byte-identical
	// checkpoint — so equal lengths across consecutive boundaries flag a stall (see
	// GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS). Persisted on the session so the comparison
	// survives the resume that reuses this socket.
	lastToolBoundaryContentLength?: number;
}

export interface GitLabDuoWorkflowProviderSessionState extends ProviderSessionState {
	active?: GitLabDuoWorkflowActiveSession;
}

export interface GitLabDuoWorkflowStreamState {
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	activeTextIndex?: number;
	activeThinkingIndex?: number;
	activeCheckpointMessageKey?: string;
	started: boolean;
	checkpointAgentContentByKey?: Record<string, string>;
	checkpointAgentContentSignatures?: Record<string, true>;
	pauseRequested?: boolean;
	stepLimitRequested?: boolean;
	retryableErrorRequested?: boolean;
	// Byte length of the server's latest checkpoint seen this socket run; the action
	// handler compares it against the previous tool-call boundary's length to detect a
	// stall (a byte-identical checkpoint means the server-side turn did not advance).
	lastCheckpointContentLength?: number;
	// Set when a tool-call boundary's checkpoint byte length did not change from the
	// previous boundary — the socket settles "stalled" so the run restarts fresh.
	stalledRequested?: boolean;
	providerSessionState?: GitLabDuoWorkflowProviderSessionState;
	lastApprovalStatus?: string;
	// When the rendered goal exceeds the byte budget, this carries an overflow-pattern
	// message. A terminal/exhausted error then surfaces THIS instead of the raw server
	// error so `isContextOverflow` recognizes it and the agent loop auto-compacts. Left
	// undefined for a goal within budget, so ordinary errors surface verbatim.
	goalOverflowMessage?: string;
}

type GitLabDuoWorkflowSocketResult =
	| "closed"
	| "terminal"
	| "approval"
	| "action"
	| "pause"
	| "timeout"
	| "step_limit"
	| "retryable_error"
	| "stalled";

export interface GitLabAvailableModel {
	name?: string | null;
	ref?: string | null;
}

export interface GitLabAvailableModelsPayload {
	pinnedModel?: GitLabAvailableModel | null;
	selectedModel?: GitLabAvailableModel | null;
	defaultModel?: GitLabAvailableModel | null;
	selectableModels?: GitLabAvailableModel[] | null;
}

export const streamGitLabDuoWorkflow: StreamFunction<"gitlab-duo-agent"> = (
	model: Model<"gitlab-duo-agent">,
	context: Context,
	options: GitLabDuoWorkflowOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);
	stream.push({ type: "start", partial: output });
	const state: GitLabDuoWorkflowStreamState = { stream, output, started: true };

	void runGitLabDuoWorkflow(model, context, options, state).catch(error => {
		const errorText = gitLabDuoWorkflowErrorText(error);
		if (!stream.done) {
			output.stopReason = "error";
			// A throw (socket reject, abnormal 1006 close, …) on a goal already past the
			// byte budget is almost certainly the oversized request — surface it as a
			// context-overflow so the session auto-compacts rather than hard-failing.
			output.errorMessage = state.goalOverflowMessage ?? errorText;
			stream.push({ type: "error", reason: "error", error: output });
		}
	});

	return stream;
};

export function buildGitLabDuoWorkflowDirectAccessBody(
	rootNamespaceId: string,
	projectId?: string,
	workflowDefinition: GitLabDuoWorkflowDefinition = GITLAB_DUO_WORKFLOW_DEFINITION,
): Record<string, string> {
	return {
		workflow_definition: workflowDefinition,
		root_namespace_id: toGitLabGraphQLNamespaceId(rootNamespaceId),
		...(projectId ? { project_id: projectId } : undefined),
	};
}

export function buildGitLabDuoWorkflowCreateBody(
	namespaceId?: string,
	options: GitLabDuoWorkflowCreateBodyOptions = {},
): Record<string, string | boolean | string[] | number[]> {
	return {
		workflow_definition: options.workflowDefinition ?? GITLAB_DUO_WORKFLOW_DEFINITION,
		environment: "ide",
		allow_agent_to_request_user: false,
		agent_privileges: [6],
		pre_approved_agent_privileges: [6],
		requires_duo_cli_enabled: false,
		...(namespaceId && !options.projectId ? { namespace_id: namespaceId } : undefined),
		...(options.projectId ? { project_id: options.projectId } : undefined),
		...(options.goal !== undefined ? { goal: options.goal } : { goal: "" }),
	};
}

export function buildGitLabDuoWorkflowStopBody(): Record<string, string> {
	return { status_event: "stop" };
}

export function buildGitLabDuoWorkflowWebSocketUrl(
	baseUrl: string,
	options: {
		projectId?: string;
		namespaceId?: string;
		rootNamespaceId?: string;
		selectedModelIdentifier?: string;
		workflowDefinition?: GitLabDuoWorkflowDefinition;
		serviceEndpoint?: boolean;
	} = {},
): string {
	// serviceEndpoint connects to the DWS runway host (root path); otherwise route to the
	// GitLab instance, preserving any relative install base path (e.g. `https://host/gitlab`).
	const wsUrl = options.serviceEndpoint
		? new URL("/", normalizeGitLabBaseUrl(baseUrl))
		: gitLabApiUrl(baseUrl, "/api/v4/ai/duo_workflows/ws");
	wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:";
	if (options.projectId) wsUrl.searchParams.set("project_id", options.projectId);
	if (options.namespaceId && !options.serviceEndpoint)
		wsUrl.searchParams.set("namespace_id", toGitLabRestNamespaceId(options.namespaceId));
	if (options.rootNamespaceId)
		wsUrl.searchParams.set("root_namespace_id", toGitLabRestNamespaceId(options.rootNamespaceId));
	if (options.selectedModelIdentifier)
		wsUrl.searchParams.set("user_selected_model_identifier", options.selectedModelIdentifier);
	if (options.workflowDefinition) wsUrl.searchParams.set("workflow_definition", options.workflowDefinition);
	return wsUrl.toString();
}

export function buildGitLabDuoWorkflowWebSocketHeaders(options: {
	token: string;
	baseUrl?: string;
	projectId?: string;
	namespaceId?: string;
	rootNamespaceId?: string;
	extraHeaders?: Record<string, string>;
}): Record<string, string> {
	const base = new URL(normalizeGitLabBaseUrl(options.baseUrl ?? DEFAULT_GITLAB_BASE_URL));
	return {
		...options.extraHeaders,
		authorization: `Bearer ${options.token}`,
		"x-gitlab-client-type": GITLAB_DUO_WORKFLOW_CLIENT_TYPE,
		"x-gitlab-language-server-version": GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION,
		"user-agent": `unknown/unknown unknown/unknown gitlab-language-server/${GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION}`,
		origin: base.origin,
		...(options.projectId ? { "x-gitlab-project-id": options.projectId } : {}),
		...(options.namespaceId ? { "x-gitlab-namespace-id": toGitLabRestNamespaceId(options.namespaceId) } : {}),
		...(options.rootNamespaceId
			? { "x-gitlab-root-namespace-id": toGitLabRestNamespaceId(options.rootNamespaceId) }
			: {}),
	};
}
export function buildGitLabDuoWorkflowStartRequest(
	workflowId: string,
	model: Model<"gitlab-duo-agent">,
	context: Context,
	tools: Tool[] | undefined = context.tools,
	availableModels?: GitLabAvailableModelsPayload | null,
	metadataOptions: GitLabDuoWorkflowStartMetadataOptions = {},
): GitLabDuoWorkflowStartRequest {
	const workflowMetadata = buildGitLabDuoWorkflowStartMetadata(model, availableModels, metadataOptions);
	const mcpTools = buildGitLabDuoWorkflowMcpTools(tools);
	return {
		workflowID: workflowId,
		clientVersion: "1.0",
		workflowDefinition: metadataOptions.workflowDefinition ?? GITLAB_DUO_WORKFLOW_DEFINITION,
		goal: buildGitLabDuoWorkflowGoal(context),
		workflowMetadata: JSON.stringify(workflowMetadata),
		additional_context: buildGitLabDuoWorkflowClientAdditionalContext(),
		clientCapabilities: GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES,
		mcpTools,
		preapproved_tools: mcpTools.map(tool => tool.name),
		flowConfigSchemaVersion: "v1" as const,
		flowConfig: buildGitLabDuoWorkflowInlineFlowConfig(buildGitLabDuoWorkflowSystemPrompt(context)),
	};
}

// Build the inline ambient flow sent over the wire (Path B / `flowConfig`). The
// server constructs the whole flow from this struct: a single agent component
// whose system slot carries OMP's own authoritative system prompt (no GitLab jinja
// wrapper / project metadata) and `on_agent_reasoning` so pre-tool-call commentary
// streams back as reasoning. `toolset: []` because MCP tools auto-attach from
// `startRequest.mcpTools` when the workflow's `mcp_enabled` is true. The user slot
// is `{{goal}}`, which the provider fills with the flat conversation transcript.
export function buildGitLabDuoWorkflowInlineFlowConfig(systemPrompt: string): GitLabDuoWorkflowInlineFlowConfig {
	return {
		version: "v1",
		environment: "ambient",
		flow: { entry_point: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME },
		components: [
			{
				name: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME,
				type: "AgentComponent",
				prompt_id: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
				toolset: [],
				inputs: [{ from: "context:goal", as: "goal" }],
				ui_log_events: [...GITLAB_DUO_WORKFLOW_INLINE_UI_LOG_EVENTS],
			},
		],
		routers: [{ from: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME, to: "end" }],
		prompts: [
			{
				name: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
				prompt_id: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
				unit_primitives: ["duo_agent_platform"],
				prompt_template: { system: systemPrompt, user: "{{goal}}", placeholder: "history" },
			},
		],
	};
}

function buildGitLabDuoWorkflowStartMetadata(
	model: Model<"gitlab-duo-agent">,
	availableModels: GitLabAvailableModelsPayload | null | undefined,
	metadataOptions: GitLabDuoWorkflowStartMetadataOptions,
): Record<string, string> {
	return {
		environment: "ide",
		client_type: GITLAB_DUO_WORKFLOW_CLIENT_TYPE,
		...(metadataOptions.projectId ? { projectId: metadataOptions.projectId } : undefined),
		...(metadataOptions.namespaceId
			? { namespaceId: toGitLabRestNamespaceId(metadataOptions.namespaceId) }
			: undefined),
		...(metadataOptions.rootNamespaceId
			? { rootNamespaceId: toGitLabRestNamespaceId(metadataOptions.rootNamespaceId) }
			: undefined),
		selectedModelIdentifier: selectGitLabDuoWorkflowModelRef(model.id, availableModels),
	};
}

export function buildGitLabDuoWorkflowClientAdditionalContext(): GitLabDuoWorkflowAdditionalContextItem[] {
	return [];
}

export function buildGitLabDuoWorkflowMcpTools(tools: Tool[] | undefined): GitLabMcpToolDefinition[] {
	return tools?.map(buildGitLabMcpToolDefinition) ?? [];
}

export function selectGitLabDuoWorkflowModelRef(
	selectedModel: string,
	availableModels?: GitLabAvailableModelsPayload | null,
): string {
	const pinned = availableModels?.pinnedModel?.ref;
	if (pinned) return pinned;
	return selectedModel;
}

export function buildGitLabPlainTextFromToolResult(toolResult: ToolResultMessage): GitLabPlainTextResponse {
	const text = gitLabToolResultToText(toolResult);
	return toolResult.isError ? { error: text } : { response: text };
}
function findGitLabDuoWorkflowToolResultById(
	messages: readonly Message[],
	requestID: string,
): ToolResultMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolCallId === requestID) return message;
	}
	return undefined;
}

// Resolve each pending action to its tool result. The serial inline flow yields a
// single pending action per turn, but the helper stays general; it returns the
// {requestID, result} pairs only when ALL are present, so a resume that fires
// before the agent loop appended the tool result is held back rather than sent.
function resolveGitLabDuoWorkflowActionBatch(
	messages: readonly Message[],
	actions: readonly GitLabDuoWorkflowActionDescriptor[],
): { requestID: string; result: ToolResultMessage }[] | undefined {
	const resolved: { requestID: string; result: ToolResultMessage }[] = [];
	for (const action of actions) {
		const result = findGitLabDuoWorkflowToolResultById(messages, action.requestID);
		if (!result) return undefined;
		resolved.push({ requestID: action.requestID, result });
	}
	return resolved;
}

// True when the user steered mid-tool-loop: a user/developer message sits AFTER the
// last tool result the pending batch resolves to. The DWS wire has no in-flight
// channel to inject a new user message into a running workflow (the only entry,
// human_input, is gated behind a LangGraph interrupt that ends the run and forces
// the broken same-id RESUME). So the steer would be dropped if we just returned the
// tool results on the live socket. Instead the caller abandons this workflow and
// re-seeds a fresh one, where the steer rides the goal transcript as the last turn —
// matching the official CLI, which on interrupt restarts with the new instruction.
function hasGitLabDuoWorkflowSteerAfterBatch(
	messages: readonly Message[],
	batch: readonly { requestID: string; result: ToolResultMessage }[],
): boolean {
	let lastBatchResultIndex = -1;
	const requestIds = new Set(batch.map(entry => entry.requestID));
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult" && requestIds.has(message.toolCallId)) {
			lastBatchResultIndex = index;
			break;
		}
	}
	if (lastBatchResultIndex < 0) return false;
	for (let index = lastBatchResultIndex + 1; index < messages.length; index++) {
		const role = messages[index]?.role;
		if (role === "user" || role === "developer") return true;
	}
	return false;
}

function buildGitLabDuoWorkflowResponseFromToolResult(toolResult: ToolResultMessage): GitLabPlainTextResponse {
	return buildGitLabPlainTextFromToolResult(toolResult);
}

// Stream one tool_call into the assistant message and finalize the turn. The DWS
// inline ambient flow dispatches MCP tool calls serially: its ToolNode runs a
// `for tool_call ...: await tool.ainvoke(...)` loop, and each MCP `ainvoke`
// blocks in `put_action_and_wait_for_response` until this client returns the
// matching actionResponse. So only ONE `runMCPTool` action is ever in flight per
// model turn — the next is not dispatched until the previous is answered. There
// is no burst to batch; each action is its own assistant message (one `done`,
// one usage) and the single pending action is committed for the resume turn.
function emitGitLabDuoWorkflowActionToolCall(
	state: GitLabDuoWorkflowStreamState,
	action: GitLabDuoWorkflowActionDescriptor,
): void {
	endGitLabDuoWorkflowText(state);
	endGitLabDuoWorkflowThinking(state);
	const toolCall = buildGitLabDuoWorkflowActionToolCall(action);
	state.output.content.push(toolCall);
	const contentIndex = state.output.content.length - 1;
	state.stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
	state.stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(toolCall.arguments),
		partial: state.output,
	});
	state.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: state.output });
	finishGitLabDuoWorkflowStream(state, "toolUse");
	if (state.providerSessionState?.active) {
		state.providerSessionState.active.pendingActions = [action];
	}
}

// Decide whether THIS tool-call boundary signals a stalled workflow. The control
// experiment proved the checkpoint `ui_chat_log` length (messageCount) is an
// incremental-streaming slice window capped at ~2 even on a healthy FINISHED run,
// so it cannot discriminate a loop. The raw server checkpoint BYTE size does: a
// healthy turn emits checkpoints whose size varies and progresses, while a stalled
// workflow re-emits a byte-identical checkpoint (the server replays the same
// non-advancing state). So a fresh tool-call boundary whose checkpoint byte length
// exactly equals the previous boundary's length of the same workflow means the
// server-side turn did not progress. Persist the last length on the session so the
// comparison survives the resume that reuses this socket. Returns false until a
// comparable prior reading exists (first boundary of a workflow, or checkpoints that
// never carried a length) so a single boundary is never falsely flagged.
function detectGitLabDuoWorkflowStall(state: GitLabDuoWorkflowStreamState): boolean {
	const active = state.providerSessionState?.active;
	const length = state.lastCheckpointContentLength;
	if (!active || length === undefined) return false;
	const previousLength = active.lastToolBoundaryContentLength;
	const stalled = previousLength !== undefined && length === previousLength;
	active.lastToolBoundaryContentLength = length;
	return stalled;
}

function buildGitLabDuoWorkflowActionToolCall(action: GitLabDuoWorkflowActionDescriptor): ToolCall {
	const args =
		action.args && typeof action.args === "object" && !Array.isArray(action.args)
			? (action.args as Record<string, unknown>)
			: {};
	const mapped = mapGitLabDuoWorkflowActionToOmpTool(action.name, args);
	return {
		type: "toolCall",
		id: action.requestID,
		name: mapped.name,
		arguments: mapped.arguments,
	};
}

function mapGitLabDuoWorkflowActionToOmpTool(
	actionName: string,
	args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } {
	switch (actionName) {
		case "runMCPTool":
		case "run_mcp_tool":
			return mapGitLabDuoWorkflowMcpToolCall(args);
		default:
			return { name: actionName, arguments: { ...args } };
	}
}

function mapGitLabDuoWorkflowMcpToolCall(args: Record<string, unknown>): {
	name: string;
	arguments: Record<string, unknown>;
} {
	const rawName = stringField(args, "toolName") ?? stringField(args, "tool_name") ?? stringField(args, "name") ?? "";
	const toolName = rawName.startsWith("mcp__omp__") ? rawName.slice("mcp__omp__".length) : rawName;
	const parsedArgs = parseGitLabDuoWorkflowMcpArguments(args.args ?? args.arguments);
	if (toolName === "edit" && typeof parsedArgs.input === "string") {
		return { name: "edit", arguments: { input: parsedArgs.input } };
	}
	return { name: toolName, arguments: parsedArgs };
}

function parseGitLabDuoWorkflowMcpArguments(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function gitLabDuoWorkflowProviderSessionStateKey(
	baseUrl: string,
	modelId: string,
	sessionId: string | undefined,
): string {
	return `gitlab-duo-agent:${baseUrl}\u0000${modelId}\u0000${sessionId ?? ""}`;
}

function createGitLabDuoWorkflowProviderSessionState(): GitLabDuoWorkflowProviderSessionState {
	const state: GitLabDuoWorkflowProviderSessionState = {
		close: () => {
			// Stop the server-side workflow before tearing down the socket. The session
			// is being reset/disposed, so no resume will return the result; without this
			// PATCH a workflow the server is still running on OMP would be stranded.
			try {
				state.active?.stop?.();
			} catch {
				// Best-effort: never let a stop failure block disposal.
			}
			try {
				state.active?.ws.close();
			} catch {
				// Ignore close failures from already-closed sockets.
			}
			state.active = undefined;
		},
	};
	return state;
}

function getGitLabDuoWorkflowProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	baseUrl: string,
	modelId: string,
	sessionId: string | undefined,
): GitLabDuoWorkflowProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = gitLabDuoWorkflowProviderSessionStateKey(baseUrl, modelId, sessionId);
	const existing = providerSessionState.get(key) as GitLabDuoWorkflowProviderSessionState | undefined;
	if (existing) return existing;
	const created = createGitLabDuoWorkflowProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

interface GitLabDuoWorkflowAccountState {
	namespaceSelection?: GitLabDuoWorkflowNamespaceSelection;
	// Once the namespace's Duo settings (agent platform + MCP + experiment flags)
	// have been ensured for this ACCOUNT, later turns and side-requests should not
	// re-send the best-effort enablement PUT. This is account-scoped, not session-
	// scoped: compaction/handoff are independent side-requests that must benefit from
	// the same prepared account state without reusing the main workflow session.
	settingsEnsured?: boolean;
}

// Per-(account, workspace) provider state. The discovered root namespace is a
// function of the GitLab credential AND the current cwd's git remote (a token with
// several top-level groups resolves a different namespace per repo), so caching it
// account-only would reuse the first workspace's namespace in a second repo and skip
// re-discovery (and skip per-namespace settings enablement). Key by credential +
// baseUrl + cwd; reuse across turns/sessions in the SAME workspace, re-discover only
// when a cached namespace later proves invalid. Explicit namespace/project config
// bypasses this cache entirely. Keyed by a non-reversible credential fingerprint
// (never the raw token).
const gitLabDuoWorkflowAccountState = new Map<string, GitLabDuoWorkflowAccountState>();

function gitLabDuoWorkflowAccountKey(apiKey: string, baseUrl: string, cwd: string | undefined): string {
	return `${Bun.hash(apiKey).toString(36)}\u0000${baseUrl}\u0000${cwd ?? ""}`;
}

function getGitLabDuoWorkflowAccountState(
	apiKey: string,
	baseUrl: string,
	cwd: string | undefined,
): GitLabDuoWorkflowAccountState {
	const key = gitLabDuoWorkflowAccountKey(apiKey, baseUrl, cwd);
	const existing = gitLabDuoWorkflowAccountState.get(key);
	if (existing) return existing;
	const created: GitLabDuoWorkflowAccountState = {};
	gitLabDuoWorkflowAccountState.set(key, created);
	return created;
}

function getGitLabDuoWorkflowCachedNamespace(
	apiKey: string,
	baseUrl: string,
	cwd: string | undefined,
): GitLabDuoWorkflowNamespaceSelection | undefined {
	return getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).namespaceSelection;
}

function setGitLabDuoWorkflowCachedNamespace(
	apiKey: string,
	baseUrl: string,
	cwd: string | undefined,
	selection: GitLabDuoWorkflowNamespaceSelection,
): void {
	getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).namespaceSelection = selection;
}

function clearGitLabDuoWorkflowCachedNamespace(apiKey: string, baseUrl: string, cwd: string | undefined): void {
	getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).namespaceSelection = undefined;
}

function isGitLabDuoWorkflowSettingsEnsured(apiKey: string, baseUrl: string, cwd: string | undefined): boolean {
	return getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).settingsEnsured === true;
}

function markGitLabDuoWorkflowSettingsEnsured(apiKey: string, baseUrl: string, cwd: string | undefined): void {
	getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).settingsEnsured = true;
}

// True when the user pinned a namespace/project explicitly (option or env). Explicit
// configuration is authoritative and cheap to resolve, so it bypasses the account
// cache entirely (neither read nor written).
function hasGitLabDuoWorkflowExplicitNamespace(options: GitLabDuoWorkflowOptions): boolean {
	return Boolean(
		nonEmptyString(options.rootNamespaceId) ??
		nonEmptyString(options.namespaceId) ??
		nonEmptyString(Bun.env.GITLAB_DUO_NAMESPACE_ID) ??
		nonEmptyString(options.projectId) ??
		nonEmptyString(options.projectPath) ??
		nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_ID) ??
		nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_PATH),
	);
}

export function gitLabDuoWorkflowErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Absolute-deadline signal for one REST setup fetch (`fetch`, `direct_access`, etc.).
// The caller's abort signal — when present — is folded in with `AbortSignal.any`, so
// either the request being cancelled OR the local timeout aborts the fetch. Called
// per-fetch so each REST call gets its OWN fresh budget; a shared timeout would race
// several fetches on the same clock and starve the later ones after the first spent
// the whole budget. The workflow's `start` event already streamed before any of
// these calls run, so an unbounded fetch would leave the assistant stream with no
// terminal event — see {@link GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS}.
function gitLabDuoWorkflowRestSignal(callerSignal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS);
	return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

async function readGitLabDuoWorkflowResponseErrorMessage(response: Response): Promise<string | undefined> {
	try {
		const payload: unknown = await response.json();
		const message =
			getGitLabDuoWorkflowErrorField(payload, "message") ?? getGitLabDuoWorkflowErrorField(payload, "error");
		return message ? gitLabDuoWorkflowErrorText(message) : undefined;
	} catch {
		return undefined;
	}
}

function getGitLabDuoWorkflowErrorField(payload: unknown, field: "message" | "error"): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const value = (payload as Record<string, unknown>)[field];
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	return value;
}

// Everything `setupForNamespace` resolves for a chosen namespace: the REST/root ids,
// the discovered project scoping, the prepared START payload, and the direct_access
// connection. Named (not `ReturnType<...>`) per repo convention so the contract stays
// explicit for the cached-namespace and re-discovery branches that consume it.
interface GitLabDuoWorkflowNamespaceSetup {
	rootNamespaceId: string;
	restNamespaceId: string;
	createNamespaceId: string;
	restProjectId: string | undefined;
	startPayload: GitLabDuoWorkflowStartRequest;
	webSocketProjectId: string | undefined;
	workflowConnection: GitLabDuoWorkflowDirectAccessConnection;
	workflowId: string;
	selectedModelIdentifier: string;
}

async function runGitLabDuoWorkflow(
	model: Model<"gitlab-duo-agent">,
	context: Context,
	options: GitLabDuoWorkflowOptions,
	state: GitLabDuoWorkflowStreamState,
): Promise<void> {
	const apiKey = options.apiKey;
	if (!apiKey) throw new AIError.MissingApiKeyError("gitlab-duo-agent");
	const baseUrl = normalizeGitLabBaseUrl(model.baseUrl || DEFAULT_GITLAB_BASE_URL);
	const fetchImpl = options.fetch ?? fetch;
	const providerSessionState = getGitLabDuoWorkflowProviderSessionState(
		options.providerSessionState,
		baseUrl,
		model.id,
		options.sessionId,
	);
	state.providerSessionState = providerSessionState;
	const pendingSession = providerSessionState?.active;
	if (pendingSession) {
		hydrateGitLabDuoWorkflowCheckpointState(state, pendingSession);
	}
	const pendingActions = pendingSession?.pendingActions;
	const resolvedBatch =
		pendingSession && pendingActions && pendingActions.length > 0
			? resolveGitLabDuoWorkflowActionBatch(context.messages, pendingActions)
			: undefined;
	// Steer mid-tool-loop: the user added a new instruction after this batch's tool
	// results. Returning the results on the live socket would silently drop the steer
	// (no in-flight user-message channel). Abandon the workflow and re-seed a fresh one
	// below — the steer rides the goal transcript as the last turn.
	const steeredMidBatch = Boolean(
		resolvedBatch && hasGitLabDuoWorkflowSteerAfterBatch(context.messages, resolvedBatch),
	);
	if (pendingSession && resolvedBatch && !steeredMidBatch) {
		const responses = resolvedBatch.map(({ requestID, result }) =>
			buildGitLabDuoWorkflowActionResponse(requestID, buildGitLabDuoWorkflowResponseFromToolResult(result)),
		);
		pendingSession.pendingActions = undefined;
		const resumeResult = await resumeGitLabDuoWorkflowSocket(
			{ fetchImpl, baseUrl, apiKey, workflowId: pendingSession.workflowId, state, providerSessionState },
			() => runGitLabDuoWorkflowSocket(pendingSession.ws, pendingSession.startPayload, state, options, responses),
		);
		// A stall on the resumed socket means the server-side turn stopped advancing even
		// after the tool result was returned. The helper already stopped that workflow and
		// dropped `active`; fall through to seed a FRESH workflow whose rebuilt goal
		// transcript includes the just-returned tool result, breaking the loop.
		if (resumeResult !== "stalled") return;
	}
	if (providerSessionState?.active?.paused) {
		const session = providerSessionState.active;
		const replay = session.pauseBuffer ?? [];
		session.paused = false;
		session.pauseBuffer = [];
		const sessionWorkflowId = session.workflowId;
		const resumeResult = await resumeGitLabDuoWorkflowSocket(
			{ fetchImpl, baseUrl, apiKey, workflowId: sessionWorkflowId, state, providerSessionState },
			() => runGitLabDuoWorkflowSocket(session.ws, session.startPayload, state, options, undefined, replay),
		);
		// As with the action resume, a stall falls through to a fresh-workflow seed
		// (the helper already stopped the stalled workflow and dropped `active`).
		if (resumeResult !== "stalled") return;
	}
	// Two cases reach here with a live `pendingSession` that must be abandoned before
	// seeding a fresh workflow:
	//  1. A mid-batch steer (resolvedBatch present, user message after it).
	//  2. Pending actions that did NOT resolve to tool results (resolvedBatch
	//     undefined): the requestID↔toolResult.toolCallId pairing broke, so the live
	//     socket can never be answered. Silently creating a fresh workflow while
	//     leaving the old one running strands it server-side — its LangGraph still
	//     treats the tool call as pending, so the model never sees the result and
	//     re-issues the same tool call (the observed "repeats the same tool, ignores
	//     the result" loop). Both cases need the same cleanup: close the socket, stop
	//     the workflow server-side, and drop the resumable session so the fresh
	//     workflow below owns `active`. The accumulated history (including the
	//     unanswered tool's result) replays through the new goal transcript.
	const abandonStaleSession = Boolean(
		pendingSession && (steeredMidBatch || (pendingActions && pendingActions.length > 0 && !resolvedBatch)),
	);
	if (abandonStaleSession && pendingSession) {
		traceGitLabDuoWorkflow(steeredMidBatch ? "workflow.steer_restart" : "workflow.stale_action_restart", {
			workflowId: pendingSession.workflowId,
		});
		pendingSession.pendingActions = undefined;
		try {
			pendingSession.ws.close();
		} catch {
			// Ignore close failures from already-closed sockets.
		}
		if (providerSessionState) providerSessionState.active = undefined;
		await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, pendingSession.workflowId);
	}
	const workflowDefinition = resolveGitLabDuoWorkflowDefinition(options.workflowDefinition);
	const explicitNamespace = hasGitLabDuoWorkflowExplicitNamespace(options);
	const configuredProjectPath = nonEmptyString(options.projectPath) ?? nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_PATH);
	const configuredProjectId = nonEmptyString(options.projectId) ?? nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_ID);
	const goal = extractLatestUserPrompt(context.messages);

	// Resolve the namespace and everything scoped to it (settings enable, project
	// auto-discovery, direct_access, workflow create). With auto-discovery the
	// namespace is cached per account and reused as the first choice; only if a
	// cached namespace turns out stale (the dependent calls fail) do we invalidate
	// it and re-discover once. Explicit namespace/project config bypasses the cache.
	const setupForNamespace = async (
		namespaceSelection: GitLabDuoWorkflowNamespaceSelection,
	): Promise<GitLabDuoWorkflowNamespaceSetup> => {
		const rootNamespaceId = namespaceSelection.rootNamespaceId;
		const restNamespaceId = toGitLabRestNamespaceId(rootNamespaceId);
		const createNamespaceId = namespaceSelection.namespacePath ?? restNamespaceId;
		traceGitLabDuoWorkflow("run.start", {
			baseUrl,
			model: model.id,
			rootNamespaceId,
			restNamespaceId,
			namespaceSource: namespaceSelection.source,
			toolCount: context.tools?.length ?? 0,
		});
		// Once per session, make sure the namespace has the Duo agent-platform + MCP +
		// beta flags on. The inline ambient flow needs them; a fresh group ships with
		// them off. Best-effort (PUT needs maintainer) and idempotent, never blocks.
		if (
			!isGitLabDuoWorkflowSettingsEnsured(apiKey, baseUrl, options.cwd) &&
			isGitLabDuoWorkflowInlineFlow(workflowDefinition)
		) {
			// Mark the workspace ensured only after a definitive attempt (HTTP response,
			// success or 4xx). A transient network error / 5xx returns false so a later
			// turn retries instead of permanently skipping the PUT on a namespace whose
			// flags are still off.
			if (await ensureGitLabDuoWorkflowSettings(fetchImpl, baseUrl, apiKey, restNamespaceId, options.signal)) {
				markGitLabDuoWorkflowSettingsEnsured(apiKey, baseUrl, options.cwd);
			}
		}
		// The inline `ambient` flow fails server-side without a project, and OMP has
		// no project of its own, so auto-discover one when nothing is configured. Prefer
		// the project the namespace was resolved from (the workspace git remote or an
		// explicit project), so a group with multiple projects scopes to the actual
		// repository instead of a generic group-listing pick. Fall back to the generic
		// membership lookup only when the namespace carries no project. `chat` runs
		// namespace-only.
		const discoveredProject =
			!configuredProjectPath && !configuredProjectId && isGitLabDuoWorkflowInlineFlow(workflowDefinition)
				? namespaceSelection.projectPath
					? { path: namespaceSelection.projectPath }
					: await discoverGitLabDuoWorkflowProject(fetchImpl, baseUrl, apiKey, restNamespaceId, options.signal)
				: undefined;
		if (discoveredProject) {
			traceGitLabDuoWorkflow("project.discover", {
				projectId: discoveredProject.id,
				hasPath: Boolean(discoveredProject.path),
				fromRemote: Boolean(namespaceSelection.projectPath),
			});
		}
		// A configured `projectId` that carries a slash is really a full `group/project`
		// path (namespace discovery accepts that form too): route it through the path flow
		// so `webSocketProjectId` is resolved to a numeric id instead of sending the raw
		// path string as `project_id` on the WebSocket, which fails project-scoped routing.
		const configuredProjectIdIsPath = Boolean(configuredProjectId?.includes("/"));
		const numericConfiguredProjectId = configuredProjectIdIsPath ? undefined : configuredProjectId;
		const pathConfiguredProjectId = configuredProjectIdIsPath ? configuredProjectId : undefined;
		const projectPath = configuredProjectPath ?? pathConfiguredProjectId ?? discoveredProject?.path;
		const projectId = numericConfiguredProjectId ?? discoveredProject?.id;
		const restProjectId = configuredProjectPath ?? configuredProjectId ?? discoveredProject?.path;
		const webSocketProjectId =
			projectId ??
			(projectPath
				? await resolveGitLabDuoWorkflowNumericProjectId(fetchImpl, baseUrl, apiKey, projectPath, options.signal)
				: undefined);
		const workflowConnection: GitLabDuoWorkflowDirectAccessConnection = options.workflowToken
			? { token: options.workflowToken, headers: {}, serviceEndpoint: false }
			: await requestGitLabDuoWorkflowDirectAccess(
					fetchImpl,
					baseUrl,
					apiKey,
					rootNamespaceId,
					restProjectId,
					workflowDefinition,
					options.signal,
				);
		const workflowId =
			options.workflowId ??
			(await createGitLabDuoWorkflow(
				fetchImpl,
				baseUrl,
				apiKey,
				createNamespaceId,
				goal,
				restProjectId,
				workflowDefinition,
				options.signal,
			));
		const availableModels = await fetchGitLabDuoWorkflowAvailableModels(
			fetchImpl,
			baseUrl,
			apiKey,
			rootNamespaceId,
			options.signal,
		);
		const selectedModelIdentifier = selectGitLabDuoWorkflowModelRef(model.id, availableModels);
		// A `toolChoice: "none"` side-request (e.g. handoff keeps live tool definitions
		// in the cache prefix but disables tool use) must not advertise the tools to
		// Duo: if the model picked one, the provider would emit a `toolUse` message and
		// the text-only handoff consumer would yield an empty/partial document. Drop the
		// advertised tools in that case; named/`auto`/`any` choices keep them.
		const advertisedTools = options.toolChoice === "none" ? [] : context.tools;
		const startPayload = buildGitLabDuoWorkflowStartRequest(
			workflowId,
			model,
			context,
			advertisedTools,
			availableModels,
			{
				projectId: webSocketProjectId,
				projectPath,
				namespaceId: restNamespaceId,
				rootNamespaceId: restNamespaceId,
				workflowDefinition,
				inlineFlow: isGitLabDuoWorkflowInlineFlow(workflowDefinition),
			},
		);
		return {
			rootNamespaceId,
			restNamespaceId,
			createNamespaceId,
			restProjectId,
			startPayload,
			webSocketProjectId,
			workflowConnection,
			workflowId,
			selectedModelIdentifier,
		};
	};

	const cachedNamespace = explicitNamespace
		? undefined
		: getGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd);
	let setup: GitLabDuoWorkflowNamespaceSetup;
	if (cachedNamespace) {
		try {
			setup = await setupForNamespace(cachedNamespace);
		} catch (cachedError) {
			// The cached account namespace no longer works (revoked access, deleted
			// group, membership change). Drop it and re-discover once from scratch.
			traceGitLabDuoWorkflow("namespace.cache_invalidate", {
				rootNamespaceId: cachedNamespace.rootNamespaceId,
				error: gitLabDuoWorkflowErrorText(cachedError),
			});
			clearGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd);
			const rediscovered = await resolveGitLabDuoWorkflowNamespaceSelection(
				model,
				options,
				apiKey,
				baseUrl,
				fetchImpl,
			);
			setup = await setupForNamespace(rediscovered);
			setGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd, rediscovered);
		}
	} else {
		const namespaceSelection = await resolveGitLabDuoWorkflowNamespaceSelection(
			model,
			options,
			apiKey,
			baseUrl,
			fetchImpl,
		);
		setup = await setupForNamespace(namespaceSelection);
		// Cache the freshly discovered namespace per account so the next session/turn
		// reuses it instead of re-discovering. Explicit config is never cached.
		if (!explicitNamespace) {
			setGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd, namespaceSelection);
		}
	}
	const restNamespaceId = setup.restNamespaceId;
	const createNamespaceId = setup.createNamespaceId;
	const restProjectId = setup.restProjectId;
	const webSocketProjectId = setup.webSocketProjectId;
	const workflowConnection = setup.workflowConnection;
	const selectedModelIdentifier = setup.selectedModelIdentifier;
	let workflowId = setup.workflowId;
	let startPayload = setup.startPayload;
	// Three byte zones (see GITLAB_DUO_WORKFLOW_GOAL_*_OVERFLOW_BYTES):
	//  - [HARD, ∞): necessary-fail. Do NOT spend the request — emit the overflow error
	//    now so the session compacts immediately. The fresh-workflow already created in
	//    setup is stopped by the `finally` below.
	//  - [SOFT, HARD): jitter. Attempt once (it can succeed); stash the overflow label so
	//    that IF the run errors it is re-labeled as a context-overflow rather than a
	//    transient fault.
	//  - [0, SOFT): reliable. Leave the label undefined; ordinary errors surface verbatim.
	const renderedGoalBytes = Buffer.byteLength(startPayload.goal, "utf8");
	if (renderedGoalBytes >= GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES) {
		traceGitLabDuoWorkflow("goal.over_budget", {
			renderedGoalBytes,
			zone: "hard",
			soft: GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES,
			hard: GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES,
		});
		if (!state.stream.done) {
			state.output.stopReason = "error";
			state.output.errorMessage = buildGitLabDuoWorkflowGoalOverflowMessage(renderedGoalBytes);
			state.stream.push({ type: "error", reason: "error", error: state.output });
		}
		// Stop the freshly created server-side workflow so it is not stranded, then
		// return without opening the socket — the request is never spent.
		if (providerSessionState) providerSessionState.active = undefined;
		await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
		return;
	}
	if (renderedGoalBytes >= GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES) {
		state.goalOverflowMessage = buildGitLabDuoWorkflowGoalOverflowMessage(renderedGoalBytes);
		traceGitLabDuoWorkflow("goal.over_budget", {
			renderedGoalBytes,
			zone: "jitter",
			soft: GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES,
			hard: GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES,
		});
	}
	let lastSocketResult: GitLabDuoWorkflowSocketResult = "closed";
	let timeoutReconnected = false;
	let stepLimitRestarts = 0;
	let genericErrorRetries = 0;
	let stallRestarts = 0;
	let settledNormally = false;
	try {
		for (let attempt = 0; attempt < 12; attempt++) {
			const ws = openGitLabDuoWorkflowSocket(workflowConnection.baseUrl ?? baseUrl, {
				token: workflowConnection.token,
				projectId: webSocketProjectId,
				// Pass the resolved namespace/root even when no numeric project id is
				// available (project path unresolved, or auto-discovery found none): the
				// REST direct_access/create calls may be namespace- or path-scoped, but the
				// socket must still route inside the selected namespace. Dropping them with
				// the project left the socket scope-less and could route/fail outside it.
				namespaceId: restNamespaceId,
				rootNamespaceId: restNamespaceId,
				selectedModelIdentifier,
				workflowDefinition,
				serviceEndpoint: workflowConnection.serviceEndpoint,
				extraHeaders: workflowConnection.headers,
				originBaseUrl: baseUrl,
				webSocketFactory: options.webSocketFactory,
			});
			if (providerSessionState) {
				// Capture the CURRENT workflow id (it is reassigned across timeout/step-limit/
				// retry restarts) so a later session-dispose stops the right workflow.
				const stopWorkflowId = workflowId;
				providerSessionState.active = {
					workflowId,
					startPayload,
					ws,
					stop: () => {
						void stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, stopWorkflowId);
					},
				};
			}
			lastSocketResult = await runGitLabDuoWorkflowSocket(ws, startPayload, state, options);
			if (lastSocketResult === "approval") {
				startPayload = buildGitLabDuoWorkflowApprovalStartRequest(startPayload);
				state.lastApprovalStatus = undefined;
				continue;
			}
			// A silent half-open socket (no frame within the idle window) leaves the
			// remote workflow stuck. Same-id reconnect is NOT recoverable on an inline
			// flow: a second connection re-compiles the flow from the live `flowConfig`
			// and the LangGraph checkpoint replay rejects the rebuilt graph topology
			// (server-side FAILED, agent never runs — verified live). So recover the
			// same way step_limit does: stop the dead workflow and create a FRESH one
			// (status CREATED → START branch, no checkpoint replay), then reopen the
			// socket. The accumulated conversation replays through the goal transcript.
			// Bounded to a single retry so a persistently dead endpoint can't loop on quota.
			if (lastSocketResult === "timeout" && !timeoutReconnected) {
				timeoutReconnected = true;
				traceGitLabDuoWorkflow("websocket.idle_restart", { workflowId });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}
			// The server caps each workflow at a fixed step (graph-recursion) limit.
			// A long but healthy OMP tool-call loop legitimately overruns it; that is
			// not a real failure. Stop the exhausted run and create a FRESH workflow
			// (a new id resets the step budget — unlike the timeout case, resending on
			// the same id would not), then reopen the socket. The conversation so far
			// (assistant text + tool results accumulated in `context`) replays through
			// the goal envelope, so the new workflow continues where it left off; the
			// checkpoint dedupe drops any re-sent ui_chat_log entries. Bounded so a
			// task that perpetually overruns degrades to a graceful stop, not a quota
			// sink.
			if (lastSocketResult === "step_limit" && stepLimitRestarts < GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS) {
				stepLimitRestarts++;
				state.stepLimitRequested = false;
				traceGitLabDuoWorkflow("websocket.step_limit_restart", { workflowId, restart: stepLimitRestarts });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}
			// The server emitted a fresh tool-call boundary whose `ui_chat_log` total did
			// not advance past the previous boundary of this workflow — the server-side
			// turn stopped progressing (captured live: total pinned while the model
			// repeated one tool call). Recover exactly like step_limit: stop the stalled
			// workflow and create a FRESH one (a new id with no checkpoint replay), then
			// reopen the socket. The conversation replays through the goal transcript,
			// rebuilt from the agent loop's intact `context.messages`, so no in-flight
			// tool result is lost. Bounded so a persistently stalling endpoint degrades to
			// a surfaced result instead of looping on quota.
			if (lastSocketResult === "stalled" && stallRestarts < GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS) {
				stallRestarts++;
				state.stalledRequested = false;
				traceGitLabDuoWorkflow("websocket.stall_restart", { workflowId, restart: stallRestarts });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}
			// The server returned its de-identified catch-all FAILED — a wrapper over a
			// transient upstream fault (model 5xx, AgentStuckError, …). Retry on a FRESH
			// workflow exactly like step_limit (same-id reconnect is broken on inline
			// flows): the conversation replays through the goal transcript. Bounded low
			// so a deterministic failure surfaces instead of looping on quota.
			if (
				lastSocketResult === "retryable_error" &&
				genericErrorRetries < GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES
			) {
				genericErrorRetries++;
				state.retryableErrorRequested = false;
				// Clear the stashed message: it only surfaces if the retry also fails.
				state.output.errorMessage = undefined;
				traceGitLabDuoWorkflow("websocket.generic_error_retry", { workflowId, retry: genericErrorRetries });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}
			// A retryable error that exhausted its retries must surface as a real error;
			// the FAILED branch suppressed the error event expecting a retry, so emit it
			// now before falling through to the terminal break.
			if (lastSocketResult === "retryable_error" && !state.stream.done) {
				state.output.stopReason = "error";
				// An oversized goal that exhausted its retry is almost certainly failing on
				// the byte size, not a transient fault — surface it as a context-overflow so
				// the session auto-compacts instead of hard-failing.
				if (state.goalOverflowMessage) state.output.errorMessage = state.goalOverflowMessage;
				state.stream.push({ type: "error", reason: "error", error: state.output });
			}
			// A stall that exhausted its fresh-workflow restarts is a persistent failure to
			// progress; surface it as a real error so the run does not stop silently.
			if (lastSocketResult === "stalled" && !state.stream.done) {
				state.output.stopReason = "error";
				state.output.errorMessage =
					state.goalOverflowMessage ?? state.output.errorMessage ?? GITLAB_DUO_WORKFLOW_STALL_ERROR_MESSAGE;
				state.stream.push({ type: "error", reason: "error", error: state.output });
			}
			break;
		}
		settledNormally = true;
		finalizeGitLabDuoWorkflowResumeResult(state, providerSessionState, lastSocketResult);
	} finally {
		// The socket loop can exit several ways that leave the remote workflow running
		// and `active` referencing a dead socket: a user abort; `runGitLabDuoWorkflowSocket`
		// rejecting (e.g. `ws.onerror`) so the settle block never ran (`settledNormally`
		// stays false); or the socket reached a half-open/stuck terminal state with no
		// real completion — `lastSocketResult === "closed"` (proxy/server drop),
		// `"timeout"` (idle deadline, retry already exhausted), or `"stalled"` (the
		// workflow's visible history stopped advancing and the bounded restarts were
		// exhausted). In all of these the local stream is finalized but the server
		// workflow has no explicit stop, so drop the resumable session and stop it with a
		// FRESH signal (the request's own signal may be aborted, which would cancel the
		// PATCH before it is sent). The happy path that intentionally keeps `active` for
		// an `action`/`pause` resume reaches a real terminal status, never
		// "closed"/"timeout"/"stalled", so it is not affected.
		const aborted = options.signal?.aborted ?? false;
		if (
			aborted ||
			!settledNormally ||
			lastSocketResult === "closed" ||
			lastSocketResult === "timeout" ||
			lastSocketResult === "stalled"
		) {
			if (providerSessionState) {
				providerSessionState.active = undefined;
			}
			await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
		}
	}
}

async function fetchGitLabDuoWorkflowAvailableModels(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	rootNamespaceId: string,
	signal?: AbortSignal,
): Promise<GitLabAvailableModelsPayload | undefined> {
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, "/api/graphql"), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				query: GITLAB_DUO_WORKFLOW_AVAILABLE_MODELS_QUERY,
				variables: { rootNamespaceId: toGitLabGraphQLNamespaceId(rootNamespaceId) },
			}),
			signal: gitLabDuoWorkflowRestSignal(signal),
		});
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		const models = getRecord(getRecord(payload, "data"), "aiChatAvailableModels");
		return parseGitLabAvailableModelsPayload(models);
	} catch {
		// Timeout (AbortSignal.timeout) surfaces as an AbortError here; matches the pre-fix
		// transient-network behavior (undefined -> caller falls back to defaults), so a
		// stalled models fetch degrades rather than hanging the whole stream.
		return undefined;
	}
}

function parseGitLabAvailableModelsPayload(value: unknown): GitLabAvailableModelsPayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	return {
		pinnedModel: parseGitLabAvailableModel(getRecord(value, "pinnedModel")),
		selectedModel: parseGitLabAvailableModel(getRecord(value, "selectedModel")),
		defaultModel: parseGitLabAvailableModel(getRecord(value, "defaultModel")),
		selectableModels: parseGitLabAvailableModelArray((value as Record<string, unknown>).selectableModels),
	};
}

function parseGitLabAvailableModel(value: unknown): GitLabAvailableModel | null {
	if (!value || typeof value !== "object") return null;
	return { name: getRecordString(value, "name") ?? null, ref: getRecordString(value, "ref") ?? null };
}

function parseGitLabAvailableModelArray(value: unknown): GitLabAvailableModel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map(parseGitLabAvailableModel).filter((model): model is GitLabAvailableModel => Boolean(model));
}

async function resolveGitLabDuoWorkflowNumericProjectId(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	projectPath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, `/api/v4/projects/${encodeURIComponent(projectPath)}`), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			signal: gitLabDuoWorkflowRestSignal(signal),
		});
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		return getRecordString(payload, "id");
	} catch {
		// Timeout / abort behaves like a transient network fault: undefined leaves the
		// caller to fall back to the workflow's namespace-only routing rather than block
		// the stream on a hanging project lookup.
		return undefined;
	}
}

interface GitLabDuoWorkflowDiscoveredProject {
	// Numeric id is known when discovered via the projects API; for a project carried
	// from the resolved namespace (git remote / explicit path) only the full path is
	// known and the numeric id is resolved later from the path for WebSocket routing.
	id?: string;
	path: string;
}

// OMP has no GitLab project of its own, but the inline `ambient` flow fails
// server-side without a project context. When the caller did not configure a
// project, discover one the credential can access: prefer a project inside the
// resolved namespace group, then fall back to any membership project. Returns
// the numeric id (WebSocket routing) and full path (REST scoping) together so
// no second lookup is needed.
async function discoverGitLabDuoWorkflowProject(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	restNamespaceId: string,
	signal?: AbortSignal,
): Promise<GitLabDuoWorkflowDiscoveredProject | undefined> {
	const query = "per_page=1&min_access_level=30&order_by=last_activity_at&sort=desc";
	const endpoints = [
		`/api/v4/groups/${encodeURIComponent(restNamespaceId)}/projects?include_subgroups=true&${query}`,
		`/api/v4/projects?membership=true&${query}`,
	];
	for (const endpoint of endpoints) {
		try {
			const response = await fetchImpl(gitLabApiUrl(baseUrl, endpoint), {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				signal: gitLabDuoWorkflowRestSignal(signal),
			});
			if (!response.ok) continue;
			const payload: unknown = await response.json();
			const first = Array.isArray(payload) ? payload[0] : undefined;
			const id = getRecordString(first, "id");
			const path = getRecordString(first, "path_with_namespace");
			if (id && path) return { id, path };
		} catch {
			// Timeout/abort on one endpoint: fall through to the next fallback rather than
			// aborting discovery. Each endpoint gets its own fresh REST budget.
		}
	}
	return undefined;
}

async function requestGitLabDuoWorkflowDirectAccess(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	rootNamespaceId: string,
	projectId?: string,
	workflowDefinition: GitLabDuoWorkflowDefinition = GITLAB_DUO_WORKFLOW_DEFINITION,
	signal?: AbortSignal,
): Promise<GitLabDuoWorkflowDirectAccessConnection> {
	// A timeout here throws `AbortError`/`TimeoutError` (per `AbortSignal.timeout`),
	// which surfaces through the outer `streamGitLabDuoWorkflow` catch as a real
	// stream `error` event — matching the existing HTTP-error path rather than the
	// swallowed best-effort helpers (settings ensure / project discovery / models).
	const response = await fetchImpl(gitLabApiUrl(baseUrl, "/api/v4/ai/duo_workflows/direct_access"), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(buildGitLabDuoWorkflowDirectAccessBody(rootNamespaceId, projectId, workflowDefinition)),
		signal: gitLabDuoWorkflowRestSignal(signal),
	});
	traceGitLabDuoWorkflow("direct_access.response", {
		status: response.status,
		ok: response.ok,
		rootNamespaceId,
		hasProjectId: Boolean(projectId),
	});
	if (!response.ok) {
		const message = await readGitLabDuoWorkflowResponseErrorMessage(response);
		// Always embed the HTTP status, even when the body carries a message: the
		// streaming auth-retry/rotation path (`extractStatusFromAssistantError` ->
		// `extractHttpStatusFromError`) refreshes/rotates broker credentials only
		// when the assistant error exposes `errorStatus` or the message embeds an
		// `HTTP <status>` token. A 401 `{"message":"Unauthorized"}` or a 429 quota
		// body would otherwise surface as a hard failure with no recoverable status.
		throw new AIError.GitLabDuoWorkflowApiError(
			message
				? `GitLab Duo Workflow direct_access failed with HTTP ${response.status}: ${message}`
				: `GitLab Duo Workflow direct_access failed with HTTP ${response.status}`,
			response.status,
		);
	}
	const payload = (await response.json()) as GitLabDirectAccessResponse;
	const token = extractGitLabWorkflowToken(payload);
	if (!token) {
		throw new AIError.ProviderResponseError("GitLab Duo Workflow direct_access did not return credentials", {
			provider: "gitlab-duo-agent",
			kind: "empty-body",
		});
	}
	traceGitLabDuoWorkflow("direct_access.token", { hasToken: true });
	const serviceEndpoint = !payload.gitlab_rails?.token && Boolean(payload.duo_workflow_service?.base_url);
	return {
		token,
		...(serviceEndpoint && payload.duo_workflow_service?.base_url
			? { baseUrl: normalizeGitLabDuoWorkflowServiceBaseUrl(payload.duo_workflow_service.base_url) }
			: {}),
		headers: serviceEndpoint ? (payload.duo_workflow_service?.headers ?? {}) : {},
		serviceEndpoint,
	};
}

async function createGitLabDuoWorkflow(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	namespaceId: string,
	goal?: string,
	projectId?: string,
	workflowDefinition: GitLabDuoWorkflowDefinition = GITLAB_DUO_WORKFLOW_DEFINITION,
	signal?: AbortSignal,
): Promise<string> {
	const body = buildGitLabDuoWorkflowCreateBody(namespaceId, {
		goal: isGitLabDuoWorkflowInlineFlow(workflowDefinition) ? "" : goal,
		projectId,
		workflowDefinition,
	});
	const response = await fetchImpl(gitLabApiUrl(baseUrl, "/api/v4/ai/duo_workflows/workflows"), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
		signal: gitLabDuoWorkflowRestSignal(signal),
	});
	traceGitLabDuoWorkflow("workflow.create.response", {
		status: response.status,
		ok: response.ok,
		namespaceId,
		hasProjectId: Boolean(projectId),
	});
	if (!response.ok) {
		throw new AIError.GitLabDuoWorkflowApiError(
			`GitLab Duo Workflow create failed with HTTP ${response.status}`,
			response.status,
		);
	}
	const payload = (await response.json()) as GitLabCreateWorkflowResponse;
	const workflowId = payload.id ?? payload.workflow_id ?? payload.workflowId;
	if (workflowId === undefined) {
		throw new AIError.ProviderResponseError(
			`GitLab Duo Workflow create response missing workflow id (HTTP ${response.status})`,
			{ provider: "gitlab-duo-agent", kind: "empty-body" },
		);
	}
	traceGitLabDuoWorkflow("workflow.create.id", { workflowId });
	return String(workflowId);
}

async function stopGitLabDuoWorkflow(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	workflowId: string,
): Promise<void> {
	// Stop rides a FRESH timeout signal, deliberately decoupled from `options.signal`
	// (see the `finally` block in `runGitLabDuoWorkflow`): a run cancelled by the
	// caller must still fire the server-side stop, but a stalled PATCH here would
	// otherwise leave the `runGitLabDuoWorkflow` promise unresolved forever — the
	// bounded budget keeps cleanup best-effort in both directions.
	try {
		await fetchImpl(gitLabApiUrl(baseUrl, `/api/v4/ai/duo_workflows/workflows/${encodeURIComponent(workflowId)}`), {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(buildGitLabDuoWorkflowStopBody()),
			signal: gitLabDuoWorkflowRestSignal(),
		});
	} catch (error) {
		// Server-side stop is best-effort: a timeout / network fault must not reject
		// the caller (the local stream already emitted its terminal event). Trace and
		// swallow so the enclosing `finally` never surfaces a spurious rejection.
		traceGitLabDuoWorkflow("workflow.stop_error", {
			workflowId,
			error: gitLabDuoWorkflowErrorText(error),
		});
	}
}

// Body the group PUT carries to turn on exactly the three flags the inline MCP-only
// ambient flow requires. Kept minimal on purpose: it never touches `duo_availability`,
// foundational flows, tool-approval, usage-data, or any other setting the operator may
// have configured. Idempotent — re-enabling an already-on flag is a server-side no-op.
export function buildGitLabDuoWorkflowSettingsBody(): Record<string, unknown> {
	return {
		experiment_features_enabled: true,
		ai_settings_attributes: {
			duo_agent_platform_enabled: true,
			duo_workflow_mcp_enabled: true,
		},
	};
}

// Best-effort enable of the namespace Duo settings the agent flow needs. Without
// `duo_agent_platform_enabled` / `duo_workflow_mcp_enabled` / `experiment_features_enabled`
// the inline ambient flow is rejected server-side, so a fresh group must have them on.
// PUT requires owner/maintainer; a 4xx (insufficient rights, no namespace) is logged via
// trace and swallowed — the run proceeds and surfaces the real error if the flow is still
// disabled, rather than blocking login/turns on a permission the user may not hold.
async function ensureGitLabDuoWorkflowSettings(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	restNamespaceId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	// Returns whether the attempt was DEFINITIVE (so the caller may stop retrying):
	// any HTTP response — 2xx (flags now on) or 4xx (insufficient rights / no such
	// namespace, which retrying never fixes) — is definitive. A thrown network error
	// or a 5xx is transient, so the caller should keep the guard retryable and try
	// again on a later turn rather than permanently skipping the PUT.
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, `/api/v4/groups/${encodeURIComponent(restNamespaceId)}`), {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(buildGitLabDuoWorkflowSettingsBody()),
			signal: gitLabDuoWorkflowRestSignal(signal),
		});
		traceGitLabDuoWorkflow("settings.ensure", { status: response.status, ok: response.ok });
		return response.status < 500;
	} catch (error) {
		traceGitLabDuoWorkflow("settings.ensure_error", { error: gitLabDuoWorkflowErrorText(error) });
		return false;
	}
}

function openGitLabDuoWorkflowSocket(
	baseUrl: string,
	options: {
		token: string;
		projectId?: string;
		namespaceId?: string;
		rootNamespaceId?: string;
		selectedModelIdentifier?: string;
		originBaseUrl?: string;
		workflowDefinition?: GitLabDuoWorkflowDefinition;
		serviceEndpoint?: boolean;
		extraHeaders?: Record<string, string>;
		webSocketFactory?: GitLabDuoWorkflowWebSocketFactory;
	},
): GitLabDuoWorkflowWebSocketLike {
	const url = buildGitLabDuoWorkflowWebSocketUrl(baseUrl, options);
	const headers = buildGitLabDuoWorkflowWebSocketHeaders({
		...options,
		baseUrl: normalizeGitLabBaseUrl(options.originBaseUrl ?? baseUrl),
	});
	const factory = options.webSocketFactory ?? defaultGitLabDuoWorkflowWebSocketFactory;
	traceGitLabDuoWorkflow("websocket.create", { url });
	return factory(url, { headers });
}
function defaultGitLabDuoWorkflowWebSocketFactory(
	url: string,
	options: GitLabDuoWorkflowWebSocketFactoryOptions,
): GitLabDuoWorkflowWebSocketLike {
	return new (WebSocket as unknown as new (
		url: string,
		options: Bun.WebSocketOptions,
	) => GitLabDuoWorkflowWebSocketLike)(url, { headers: options.headers });
}

export function runGitLabDuoWorkflowSocket(
	ws: GitLabDuoWorkflowWebSocketLike,
	startPayload: GitLabDuoWorkflowStartRequest,
	state: GitLabDuoWorkflowStreamState,
	options: GitLabDuoWorkflowOptions,
	resumeResponse?: GitLabDuoWorkflowActionResponse | readonly GitLabDuoWorkflowActionResponse[],
	replayMessages?: readonly unknown[],
): Promise<GitLabDuoWorkflowSocketResult> {
	const { promise, resolve, reject } = Promise.withResolvers<GitLabDuoWorkflowSocketResult>();
	let settled = false;
	let idleTimer: NodeJS.Timeout | undefined;
	const clearIdleTimer = (): void => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	const settle = (result: GitLabDuoWorkflowSocketResult = "closed", error?: unknown): void => {
		if (settled) return;
		settled = true;
		clearIdleTimer();
		if (error) reject(error);
		else resolve(result);
	};
	const idleTimeoutMs =
		options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0
			? options.idleTimeoutMs
			: GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS;
	const resetIdleTimer = (): void => {
		clearIdleTimer();
		if (settled) return;
		idleTimer = setTimeout(() => {
			traceGitLabDuoWorkflow("websocket.idle_timeout", { timeoutMs: idleTimeoutMs });
			close();
			settle("timeout");
		}, idleTimeoutMs);
	};
	const close = (): void => {
		try {
			ws.close();
		} catch {
			// Ignore close failures from test doubles or already closed sockets.
		}
	};
	const abort = (): void => {
		close();
		settle("closed", new AIError.AbortError("GitLab Duo Workflow request aborted"));
	};
	if (options.signal?.aborted) {
		abort();
		return promise;
	}
	options.signal?.addEventListener("abort", abort, { once: true });

	const active = state.providerSessionState?.active;
	const handleSocketResult = (
		result: GitLabDuoWorkflowMessageResult,
		data: unknown,
		remaining: readonly unknown[],
	): boolean => {
		if (result === "pause") {
			if (active) {
				active.paused = true;
				active.pauseBuffer = [data, ...remaining, ...(active.pauseBuffer ?? [])];
			}
			pauseGitLabDuoWorkflowStream(state);
			settle("pause");
			return false;
		}
		if (result === "action") {
			// One MCP tool_call per turn: DWS ToolNode awaits each action's response
			// before dispatching the next, so the turn is complete at this single
			// action. Settle now (the agent loop runs the tool, then resumes by
			// sending the actionResponse on this SAME socket — so do NOT close it).
			settle("action");
			return false;
		}
		if (result !== "continue") {
			close();
			settle(result);
			return false;
		}
		return true;
	};
	ws.onerror = event => {
		const detail = describeGitLabDuoWorkflowSocketEvent(event);
		traceGitLabDuoWorkflow("websocket.error", { event: detail });
		settle(
			"closed",
			new AIError.ProviderResponseError(`GitLab Duo Workflow WebSocket error: ${detail}`, {
				provider: "gitlab-duo-agent",
				kind: "runtime",
			}),
		);
	};
	ws.onclose = event => {
		traceGitLabDuoWorkflow("websocket.close", { code: event.code, reason: event.reason });
		settle(state.lastApprovalStatus ? "approval" : "closed");
	};
	ws.onmessage = event => {
		resetIdleTimer();
		if (active?.paused) {
			active.pauseBuffer ??= [];
			active.pauseBuffer.push(event.data);
			return;
		}
		void handleGitLabDuoWorkflowSocketMessage(event.data, state).then(
			result => {
				handleSocketResult(result, event.data, []);
			},
			error => settle("closed", error),
		);
	};
	if (replayMessages && replayMessages.length > 0) {
		ws.onopen = null;
		void (async () => {
			if (active) active.paused = true;
			const pending: unknown[] = [...replayMessages];
			while (!settled) {
				if (pending.length === 0) {
					if (active?.pauseBuffer && active.pauseBuffer.length > 0) {
						pending.push(...active.pauseBuffer);
						active.pauseBuffer = [];
						continue;
					}
					// Replay queue fully drained and no buffered frames remain.
					break;
				}
				const data = pending.shift();
				let result: GitLabDuoWorkflowMessageResult;
				try {
					result = await handleGitLabDuoWorkflowSocketMessage(data, state);
				} catch (error) {
					settle("closed", error);
					return;
				}
				if (!handleSocketResult(result, data, pending)) {
					// An `action` result stops the replay loop to hand the tool call back
					// to OMP. Clear the pause flag first: the live `onmessage` handler must
					// process the resume continuation directly instead of buffering it
					// (a buffered continuation would idle the turn until timeout).
					if (active) active.paused = false;
					return;
				}
				if (active?.pauseBuffer && active.pauseBuffer.length > 0) {
					pending.push(...active.pauseBuffer);
					active.pauseBuffer = [];
				}
			}
			if (!settled && active) active.paused = false;
		})();
	} else if (resumeResponse && (!Array.isArray(resumeResponse) || resumeResponse.length > 0)) {
		ws.onopen = null;
		// Resume the live socket by returning the tool result for the single pending
		// action of this turn. (Accepts an array for forward-compat, but the serial
		// inline flow only ever has one.) DWS matches it by requestID to the awaiting
		// outbox future and the workflow continues on the same connection.
		const responses = Array.isArray(resumeResponse) ? resumeResponse : [resumeResponse];
		for (const response of responses) {
			ws.send(JSON.stringify(response));
		}
	} else {
		ws.onopen = () => {
			traceGitLabDuoWorkflow("websocket.open", {
				workflowId: startPayload.workflowID,
				workflowDefinition: startPayload.workflowDefinition,
				flowConfigId: startPayload.flowConfigId,
				flowVersion: startPayload.flowVersion,
				flowConfigSchemaVersion: startPayload.flowConfigSchemaVersion,
				mcpTools: startPayload.mcpTools.length,
				preapprovedTools: startPayload.preapproved_tools.length,
			});
			ws.send(JSON.stringify({ startRequest: startPayload }));
		};
	}
	resetIdleTimer();
	return promise.finally(() => {
		clearIdleTimer();
		options.signal?.removeEventListener("abort", abort);
	});
}

type GitLabDuoWorkflowMessageResult =
	| "continue"
	| "terminal"
	| "approval"
	| "action"
	| "pause"
	| "step_limit"
	| "retryable_error"
	| "stalled";

type GitLabDuoWorkflowCheckpointKind = "text" | "thinking";

interface GitLabDuoWorkflowCheckpointAgentEntry {
	kind: GitLabDuoWorkflowCheckpointKind;
	messageIndex: number;
	messageKey: string;
	content: string;
}

interface GitLabDuoWorkflowCheckpointBoundaryEntry {
	kind: "boundary";
	messageIndex: number;
}

type GitLabDuoWorkflowCheckpointEntry =
	| GitLabDuoWorkflowCheckpointAgentEntry
	| GitLabDuoWorkflowCheckpointBoundaryEntry;

interface GitLabDuoWorkflowContextUsage {
	used: number;
	window: number;
}

interface GitLabDuoWorkflowCheckpointContent {
	entries: GitLabDuoWorkflowCheckpointEntry[];
	contentLength: number;
	latestMessageType?: string;
	contextUsage?: GitLabDuoWorkflowContextUsage;
}

async function handleGitLabDuoWorkflowSocketMessage(
	data: unknown,
	state: GitLabDuoWorkflowStreamState,
): Promise<GitLabDuoWorkflowMessageResult> {
	const event = parseGitLabDuoWorkflowSocketData(data);
	if (!event) return "continue";
	const status =
		getRecordString(event, "status") ??
		getNestedRecordString(event, "workflowStatus", "status") ??
		getNestedRecordString(event, "newCheckpoint", "status");
	const checkpoint = extractGitLabDuoWorkflowCheckpoint(event);
	traceGitLabDuoWorkflow("websocket.message", {
		keys: Object.keys(event),
		status,
		hasCheckpoint: Boolean(getRecord(event, "newCheckpoint") ?? getRecord(event, "checkpoint")),
		checkpointLength: checkpoint?.contentLength ?? 0,
	});
	if (checkpoint) {
		emitGitLabDuoWorkflowCheckpoint(state, checkpoint);
	}
	if (state.pauseRequested) {
		state.pauseRequested = false;
		return "pause";
	}
	if (isGitLabWorkflowApprovalStatus(status)) {
		state.lastApprovalStatus = status;
		traceGitLabDuoWorkflow("websocket.approval", { status });
		return "approval";
	}
	if (isGitLabWorkflowCompletionStatus(status)) {
		traceGitLabDuoWorkflow("websocket.terminal", { status, checkpointLength: checkpoint?.contentLength ?? 0 });
		finishGitLabDuoWorkflowStream(state, "stop");
		return "terminal";
	}
	if (status === "FAILED" || status === "STOPPED") {
		const message = gitLabDuoWorkflowErrorText(
			getRecordString(event, "error") ?? getRecordString(event, "message") ?? status,
		);
		// The server caps each workflow at a fixed graph-recursion limit (DWS
		// RECURSION_LIMIT). A long but healthy OMP tool-call loop legitimately hits
		// it and surfaces as FAILED with this message. That is not a real failure —
		// resume by starting a fresh workflow that continues the same conversation
		// (the accumulated context/tool results replay via the goal envelope).
		if (status === "FAILED" && isGitLabDuoWorkflowStepLimitMessage(message)) {
			traceGitLabDuoWorkflow("websocket.step_limit", { status });
			state.stepLimitRequested = true;
			return "step_limit";
		}
		// The DWS catch-all FAILED ("...error processing your request in the Duo Agent
		// Platform...") is a de-identified wrapper over transient upstream faults
		// (model 5xx that exhausted retries, AgentStuckError, etc.). Retry ONCE on a
		// FRESH workflow (the broken same-id reconnect is never used): the accumulated
		// conversation replays through the goal transcript. Bounded so a deterministic
		// failure degrades to a surfaced error instead of a quota sink.
		if (status === "FAILED" && isGitLabDuoWorkflowGenericProcessingError(message)) {
			traceGitLabDuoWorkflow("websocket.generic_error", { status });
			state.retryableErrorRequested = true;
			// Stash the real message but do NOT push an error event yet: the loop retries
			// on a fresh workflow and only surfaces this if retries are exhausted.
			state.output.errorMessage = message;
			return "retryable_error";
		}
		traceGitLabDuoWorkflow("websocket.failed", { status });
		state.output.stopReason = "error";
		// An oversized goal that fails terminally is almost certainly failing on the byte
		// size — surface it as a context-overflow so the session auto-compacts.
		state.output.errorMessage = state.goalOverflowMessage ?? message;
		state.stream.push({ type: "error", reason: "error", error: state.output });
		return "terminal";
	}
	const action = extractGitLabDuoWorkflowAction(event);
	if (!action) return "continue";
	traceGitLabDuoWorkflow("websocket.action", {
		actionName: action.name,
		requestID: action.requestID,
		toolName:
			getRecordString(action.args as Record<string, unknown>, "name") ??
			getRecordString(action.args as Record<string, unknown>, "toolName") ??
			getRecordString(action.args as Record<string, unknown>, "tool_name"),
		argKeys: Object.keys(action.args as Record<string, unknown>).slice(0, 20),
	});
	// A fresh tool-call boundary whose `ui_chat_log` total did not advance past the
	// previous boundary of this workflow means the server-side turn did not progress:
	// emitting and answering this tool call would only feed the same non-advancing loop.
	// Settle "stalled" so the socket loop restarts on a fresh workflow (resending the
	// full goal transcript) instead of running the doomed tool call.
	if (detectGitLabDuoWorkflowStall(state)) {
		traceGitLabDuoWorkflow("websocket.stalled", {
			checkpointLength: state.lastCheckpointContentLength,
			actionName: action.name,
		});
		state.stalledRequested = true;
		return "stalled";
	}
	// Finalize this tool_call as its own assistant message and commit it as the
	// single pending action; the socket loop settles "action" so the agent loop
	// runs the tool and resumes.
	emitGitLabDuoWorkflowActionToolCall(state, action);
	return "action";
}
function isGitLabWorkflowApprovalStatus(status: string | undefined): boolean {
	return status === "PLAN_APPROVAL_REQUIRED" || status === "TOOL_CALL_APPROVAL_REQUIRED";
}

function isGitLabWorkflowCompletionStatus(status: string | undefined): boolean {
	return status === "INPUT_REQUIRED" || status === "FINISHED";
}
// Matches the DWS GraphRecursionError surface ("The workflow reached its maximum
// step limit and could not complete."). The leading clause is stable across
// flows; match on it case-insensitively so a fresh workflow can continue the run.
function isGitLabDuoWorkflowStepLimitMessage(message: string): boolean {
	return message.toLowerCase().includes("reached its maximum step limit");
}
// Matches the DWS de-identified catch-all FAILED ("There was an error processing
// your request in the Duo Agent Platform, please contact support if the issue
// persists.") — server-side wrapper over transient upstream faults. Match on the
// stable middle clause case-insensitively (the surrounding text varies slightly
// across server versions).
function isGitLabDuoWorkflowGenericProcessingError(message: string): boolean {
	return message.toLowerCase().includes("error processing your request in the duo agent platform");
}
export function buildGitLabDuoWorkflowApprovalStartRequest(
	startPayload: GitLabDuoWorkflowStartRequest,
): GitLabDuoWorkflowStartRequest {
	return {
		...startPayload,
		goal: "",
		additional_context: [],
		approval: { approval: {} },
	};
}

function buildGitLabDuoWorkflowActionResponse(
	requestID: string,
	response: GitLabPlainTextResponse,
): GitLabDuoWorkflowActionResponse {
	return { actionResponse: { requestID, plainTextResponse: response } };
}

function gitLabToolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function buildGitLabMcpToolDefinition(tool: Tool): GitLabMcpToolDefinition {
	const schema = toolWireSchema(tool);
	// Register the tool under its BARE name (no `mcp__omp__` prefix). The server does
	// not strip prefixes — it registers `_executable_tools` and binds the model schema
	// under exactly the wire `name` (sanitize_llm_name only replaces illegal chars), so
	// the name the model sees, the toolset key it is matched against, and OMP's own
	// tool docs must all be the same bare name. A prefixed wire name only forced the
	// model to learn `mcp__omp__read` while OMP docs say `read`, with no upside.
	// `originalToolName`/`serverName` stay as MCP metadata; they are not the match key.
	return {
		name: tool.name,
		originalToolName: tool.name,
		serverName: "omp",
		description: tool.description || "",
		inputSchema: JSON.stringify(
			schema && typeof schema === "object" ? schema : { type: "object", properties: {}, required: [] },
		),
		isApproved: true,
	};
}

function createAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function hydrateGitLabDuoWorkflowCheckpointState(
	state: GitLabDuoWorkflowStreamState,
	session: GitLabDuoWorkflowActiveSession,
): void {
	state.checkpointAgentContentByKey = session.checkpointAgentContentByKey;
	state.checkpointAgentContentSignatures = session.checkpointAgentContentSignatures;
}

function syncGitLabDuoWorkflowCheckpointState(state: GitLabDuoWorkflowStreamState): void {
	const active = state.providerSessionState?.active;
	if (!active) return;
	active.checkpointAgentContentByKey = state.checkpointAgentContentByKey;
	active.checkpointAgentContentSignatures = state.checkpointAgentContentSignatures;
}

function emitGitLabDuoWorkflowCheckpoint(
	state: GitLabDuoWorkflowStreamState,
	checkpoint: GitLabDuoWorkflowCheckpointContent,
): void {
	if (checkpoint.contextUsage) {
		applyGitLabDuoWorkflowContextUsage(state, checkpoint.contextUsage);
	}
	// Track the server's latest checkpoint byte length so the action handler can detect
	// a workflow whose state stopped advancing (stall). The control experiment proved a
	// healthy turn emits checkpoints whose byte size varies and grows, while a stalled
	// workflow re-emits a byte-identical checkpoint.
	state.lastCheckpointContentLength = checkpoint.contentLength;
	// GitLab checkpoints are full ui_chat_log snapshots, so a later frame replays
	// earlier request/tool boundaries before the new agent delta. Pause only on a
	// boundary that follows a delta emitted in THIS checkpoint (`deltaThisCheckpoint`),
	// not any delta emitted earlier in the socket call — otherwise a stale replayed
	// boundary would fire one pause_turn per snapshot and hit the loop's continuation cap.
	let deltaThisCheckpoint = false;
	// Turn position within this full-snapshot replay: a request/tool boundary
	// starts a new turn. The content-signature fallback below is scoped to this
	// index so it suppresses only a replayed message reappearing at the SAME turn
	// position (e.g. GitLab renames a message_id across a shrunk snapshot, so the
	// per-key lookup misses but the text was already emitted for that turn). A
	// genuinely new later message with text equal to an earlier one lands at a
	// LATER turn (after an extra boundary), so its signature differs and it still
	// emits — repeated assistant output across turns is no longer swallowed.
	let turnIndex = 0;
	for (const entry of checkpoint.entries) {
		if (entry.kind === "boundary") {
			if (deltaThisCheckpoint && state.providerSessionState?.active) {
				state.pauseRequested = true;
				return;
			}
			endGitLabDuoWorkflowText(state);
			endGitLabDuoWorkflowThinking(state);
			turnIndex += 1;
			continue;
		}

		const contentByKey = state.checkpointAgentContentByKey ?? {};
		const contentSignatures = state.checkpointAgentContentSignatures ?? {};
		const previousContent = contentByKey[entry.messageKey];
		const contentSignature = `${turnIndex}\u0000${entry.kind}\u0000${entry.content}`;
		const contentOnlySignature = `${turnIndex}\u0000content\u0000${entry.content}`;
		const duplicateContent =
			previousContent === undefined &&
			(contentSignatures[contentSignature] === true || contentSignatures[contentOnlySignature] === true);
		const rewroteExistingContent =
			previousContent !== undefined &&
			!entry.content.startsWith(previousContent) &&
			previousContent !== entry.content;
		const delta = duplicateContent
			? ""
			: rewroteExistingContent
				? ""
				: previousContent !== undefined
					? entry.content.slice(previousContent.length)
					: entry.content;

		contentByKey[entry.messageKey] = entry.content;
		contentSignatures[contentSignature] = true;
		contentSignatures[contentOnlySignature] = true;
		state.checkpointAgentContentByKey = contentByKey;
		state.checkpointAgentContentSignatures = contentSignatures;
		syncGitLabDuoWorkflowCheckpointState(state);

		if (delta.length === 0) continue;

		if (
			state.activeCheckpointMessageKey &&
			state.activeCheckpointMessageKey !== entry.messageKey &&
			previousContent === undefined
		) {
			endGitLabDuoWorkflowText(state);
			endGitLabDuoWorkflowThinking(state);
		}
		emitGitLabDuoWorkflowCheckpointSegment(state, entry.kind, delta);
		state.activeCheckpointMessageKey = entry.messageKey;
		deltaThisCheckpoint = true;
	}
}

// Map the server's per-agent context occupancy onto the assistant usage so the per-message
// usage row reflects the real prompt/context size. total_tokens is GitLab's full-history
// estimate (the input/prompt side); there is no separate billing usage on this transport.
function applyGitLabDuoWorkflowContextUsage(
	state: GitLabDuoWorkflowStreamState,
	contextUsage: GitLabDuoWorkflowContextUsage,
): void {
	const usage = state.output.usage;
	usage.input = contextUsage.used;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function emitGitLabDuoWorkflowCheckpointSegment(
	state: GitLabDuoWorkflowStreamState,
	kind: GitLabDuoWorkflowCheckpointKind,
	delta: string,
): void {
	if (kind === "thinking") {
		emitGitLabDuoWorkflowThinking(state, delta);
		return;
	}
	emitGitLabDuoWorkflowText(state, delta);
}

function emitGitLabDuoWorkflowText(state: GitLabDuoWorkflowStreamState, text: string): void {
	if (!text) return;
	endGitLabDuoWorkflowThinking(state);
	let activeTextIndex = state.activeTextIndex;
	if (activeTextIndex === undefined) {
		const block = { type: "text" as const, text: "" };
		state.output.content.push(block);
		activeTextIndex = state.output.content.length - 1;
		state.activeTextIndex = activeTextIndex;
		state.stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: state.output });
	}
	const block = state.output.content[activeTextIndex];
	if (block?.type !== "text") return;
	block.text += text;
	state.stream.push({ type: "text_delta", contentIndex: activeTextIndex, delta: text, partial: state.output });
}

function emitGitLabDuoWorkflowThinking(state: GitLabDuoWorkflowStreamState, thinking: string): void {
	if (!thinking) return;
	endGitLabDuoWorkflowText(state);
	let activeThinkingIndex = state.activeThinkingIndex;
	if (activeThinkingIndex === undefined) {
		const block = { type: "thinking" as const, thinking: "" };
		state.output.content.push(block);
		activeThinkingIndex = state.output.content.length - 1;
		state.activeThinkingIndex = activeThinkingIndex;
		state.stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: state.output });
	}
	const block = state.output.content[activeThinkingIndex];
	if (block?.type !== "thinking") return;
	block.thinking += thinking;
	state.stream.push({
		type: "thinking_delta",
		contentIndex: activeThinkingIndex,
		delta: thinking,
		partial: state.output,
	});
}

function endGitLabDuoWorkflowText(state: GitLabDuoWorkflowStreamState): void {
	if (state.activeTextIndex === undefined) return;
	const block = state.output.content[state.activeTextIndex];
	if (block?.type === "text") {
		state.stream.push({
			type: "text_end",
			contentIndex: state.activeTextIndex,
			content: block.text,
			partial: state.output,
		});
	}
	state.activeTextIndex = undefined;
}

function endGitLabDuoWorkflowThinking(state: GitLabDuoWorkflowStreamState): void {
	if (state.activeThinkingIndex === undefined) return;
	const block = state.output.content[state.activeThinkingIndex];
	if (block?.type === "thinking") {
		state.stream.push({
			type: "thinking_end",
			contentIndex: state.activeThinkingIndex,
			content: block.thinking,
			partial: state.output,
		});
	}
	state.activeThinkingIndex = undefined;
}

function finishGitLabDuoWorkflowStream(
	state: GitLabDuoWorkflowStreamState,
	reason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
): void {
	endGitLabDuoWorkflowText(state);
	endGitLabDuoWorkflowThinking(state);
	state.output.stopReason = reason;
	state.stream.push({ type: "done", reason, message: state.output });
}

// Finalize a resumed-socket turn. `action`/`pause` keep the session alive for the
// next resume; every other result (`terminal`/`closed`/`approval`/`timeout`) drops
// the resumable session, and — because only `terminal` carries a server `done` —
// emits a terminal `done` for the rest so the assistant stream never hangs open
// after a tool result the way the fresh-workflow loop already finalizes.
function finalizeGitLabDuoWorkflowResumeResult(
	state: GitLabDuoWorkflowStreamState,
	providerSessionState: GitLabDuoWorkflowProviderSessionState | undefined,
	result: GitLabDuoWorkflowSocketResult,
): void {
	if (result === "action" || result === "pause") return;
	if (providerSessionState) {
		providerSessionState.active = undefined;
	}
	if (result !== "terminal" && !state.stream.done) {
		finishGitLabDuoWorkflowStream(state, "stop");
	}
}

// Run a resume on a preserved socket (action-result or pause replay) and finalize it
// the same way the fresh-workflow loop does, returning the settled socket result so
// the caller can react to a stall. If the resume rejects — the preserved WebSocket
// errored, or `ws.send` threw because it closed while the local tool ran — the
// preserved session would otherwise be left with `active` still set and the server
// workflow still running. Drop `active` and fire a best-effort stop before rethrowing
// so the next turn never resumes a dead socket or strands the workflow.
async function resumeGitLabDuoWorkflowSocket(
	args: {
		fetchImpl: FetchImpl;
		baseUrl: string;
		apiKey: string;
		workflowId: string;
		state: GitLabDuoWorkflowStreamState;
		providerSessionState: GitLabDuoWorkflowProviderSessionState | undefined;
	},
	run: () => Promise<GitLabDuoWorkflowSocketResult>,
): Promise<GitLabDuoWorkflowSocketResult> {
	let socketResult: GitLabDuoWorkflowSocketResult;
	try {
		socketResult = await run();
	} catch (error) {
		if (args.providerSessionState) {
			args.providerSessionState.active = undefined;
		}
		await stopGitLabDuoWorkflow(args.fetchImpl, args.baseUrl, args.apiKey, args.workflowId);
		throw error;
	}
	// A stall on the resumed socket must NOT finalize the stream: the caller re-seeds a
	// fresh workflow (rebuilt goal includes the just-returned tool result) to break the
	// non-advancing loop. Stop the stalled workflow and drop `active` here so the caller
	// owns a clean slate, but leave the stream open for the fresh run.
	if (socketResult === "stalled") {
		if (args.providerSessionState) args.providerSessionState.active = undefined;
		await stopGitLabDuoWorkflow(args.fetchImpl, args.baseUrl, args.apiKey, args.workflowId);
		return socketResult;
	}
	finalizeGitLabDuoWorkflowResumeResult(args.state, args.providerSessionState, socketResult);
	// `action`/`pause` keep the session alive for the next resume; `terminal` is a real
	// server completion. But `closed`/`timeout` (and an exhausted `approval`) settle the
	// local stream while the remote workflow may still be running — mirror the fresh-
	// workflow `finally` and send the stop PATCH so a half-open/dropped socket after a
	// tool result never strands the server-side workflow with no local handle left.
	if (socketResult === "closed" || socketResult === "timeout") {
		await stopGitLabDuoWorkflow(args.fetchImpl, args.baseUrl, args.apiKey, args.workflowId);
	}
	return socketResult;
}

function pauseGitLabDuoWorkflowStream(state: GitLabDuoWorkflowStreamState): void {
	endGitLabDuoWorkflowText(state);
	endGitLabDuoWorkflowThinking(state);
	state.output.stopReason = "stop";
	state.output.stopDetails = { type: "pause_turn" };
	state.stream.push({ type: "done", reason: "stop", message: state.output });
}
interface GitLabDuoWorkflowReplayToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface GitLabDuoWorkflowReplayMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	toolCalls?: GitLabDuoWorkflowReplayToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

// Trimmed once: the static note tells the model the goal transcript's ChatML/`<ran>`
// markers are a historical record, not a syntax to emit.
const GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE = chatmlHistoryNote.trim();

// The OMP system prompt that rides the inline flow's `prompt_template.system` slot.
// DWS wraps it in its own gateway boilerplate, but the slot content is delivered to
// the model verbatim, so OMP's authoritative rules go here directly — no redirect
// preamble and no embedding inside the goal. When the goal is a multi-turn ChatML
// transcript (not a lone bare-text prompt), append the history-note so the model does
// not mimic the transcript's `<|im_start|>`/`<ran …>` markers as its own tool-call
// output — markers it kept copying even after they were reframed to past tense.
function buildGitLabDuoWorkflowSystemPrompt(context: Context): string {
	const base = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	if (!isGitLabDuoWorkflowChatMlGoal(context)) return base;
	return base ? `${base}\n\n${GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE}` : GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE;
}

// A goal renders as a literal ChatML transcript only when more than one turn survives
// the replay filter; a lone turn is sent as bare text (see buildGitLabDuoWorkflowGoal),
// so the history-note would describe markers that are not present.
function isGitLabDuoWorkflowChatMlGoal(context: Context): boolean {
	return buildGitLabDuoWorkflowConversationHistory(context.messages).length > 1;
}

// The goal carries ONLY the conversation, rendered as a bare ChatML transcript. The
// system prompt lives in the flow's system slot, so the goal needs no envelope, no
// `<instructions>` section, and no preamble. A lone turn is sent verbatim; a real
// multi-turn session becomes the flat ChatML transcript, every turn equal-weight,
// ending naturally on the last turn. ChatML markers are literal text here (DWS does
// not tokenize the goal as a chat template), chosen because `<|im_start|>`/`<|im_end|>`
// effectively never collide with natural message content and are not Claude-reserved
// conversation sequences the way `Human:`/`Assistant:` are.
function buildGitLabDuoWorkflowGoal(context: Context): string {
	const conversation = buildGitLabDuoWorkflowConversationHistory(context.messages);
	// The goal transcript bypasses transformMessages, so apply the outbound
	// credential redaction here — the same scrub the flow-config system slot
	// already receives — before the payload leaves the process.
	if (conversation.length <= 1) {
		return redactSensitiveCredentials(extractLatestUserPrompt(context.messages));
	}
	return redactSensitiveCredentials(renderGitLabDuoWorkflowChatMl(conversation));
}

const GITLAB_DUO_WORKFLOW_CHATML_START = "<|im_start|>";
const GITLAB_DUO_WORKFLOW_CHATML_END = "<|im_end|>";

// Render the flat transcript as literal ChatML. Each turn is
// `<|im_start|>role\n<body><|im_end|>`. An assistant turn that issued tool calls
// renders them after its text as `<ran NAME>{args}</ran>` records — a PAST-tense log
// of a call that already executed, deliberately NOT the `{name,arguments}` shape the
// live structured tool-use channel uses, so the model reads history as a record and
// does not mimic it as emittable call grammar. The paired result rides the next
// `tool` turn, linked by adjacency (1 call/turn), so the chain stays intact.
function renderGitLabDuoWorkflowChatMl(conversation: readonly GitLabDuoWorkflowReplayMessage[]): string {
	return conversation.map(renderGitLabDuoWorkflowChatMlTurn).join("\n");
}

function renderGitLabDuoWorkflowChatMlTurn(message: GitLabDuoWorkflowReplayMessage): string {
	const body = gitLabDuoWorkflowChatMlBody(message);
	return `${GITLAB_DUO_WORKFLOW_CHATML_START}${message.role}\n${body}${GITLAB_DUO_WORKFLOW_CHATML_END}`;
}

function gitLabDuoWorkflowChatMlBody(message: GitLabDuoWorkflowReplayMessage): string {
	const parts: string[] = [];
	if (message.content.length > 0) parts.push(message.content);
	if (message.role === "assistant" && message.toolCalls) {
		for (const toolCall of message.toolCalls) {
			parts.push(renderGitLabDuoWorkflowChatMlToolCall(toolCall));
		}
	}
	if (message.role === "tool") {
		const header = gitLabDuoWorkflowChatMlToolResultHeader(message);
		return header ? `${header}\n${message.content}\n` : `${message.content}\n`;
	}
	return `${parts.join("\n")}\n`;
}

function gitLabDuoWorkflowChatMlToolResultHeader(message: GitLabDuoWorkflowReplayMessage): string | undefined {
	if (!message.toolName && !message.toolCallId) return undefined;
	const status = message.isError ? " status=error" : "";
	// The tool name is omitted: the result rides the turn immediately after its call
	// (1:1, adjacent), so the model pairs them by position; repeating the name is dead
	// weight and makes the result read like an independent construct. `<ran:result>` is
	// past-tense — the adjacent output of the prior historical run, not emittable grammar.
	return `<ran:result${status}>`;
}

function renderGitLabDuoWorkflowChatMlToolCall(toolCall: GitLabDuoWorkflowReplayToolCall): string {
	// The goal is a plain text transcript fed to the model, not an HTML/script
	// context, so `<`/`>` need no escaping. Render as a past-tense `<ran NAME>` record:
	// the tag names the tool, the body is just the arguments JSON (the `{name,arguments}`
	// wrapper is dropped — it was the exact shape the model copied as a would-be live
	// call). The call id is OMP-internal wiring the model never reads (call→result pair
	// by adjacency), so it is omitted to save bytes. `arguments` carries the `i` (intent)
	// key only at live dispatch; on replay it is stripped (see gitLabDuoWorkflowAssistantToolCalls).
	const args = JSON.stringify(toolCall.arguments) ?? "null";
	return `<ran ${toolCall.name}>${args}</ran>`;
}

// The whole session as a flat, equal-weight transcript. Every turn — including the
// latest user message — is one entry; nothing is elevated to a privileged
// `<current_request>`. DWS' goal blob has no native turn priority, so elevating the
// last turn (the old template) caused mid-task reminders / IRC wakes to outrank the
// actual task. A flat transcript ending naturally on the last turn removes that skew.
function buildGitLabDuoWorkflowConversationHistory(messages: readonly Message[]): GitLabDuoWorkflowReplayMessage[] {
	const history: GitLabDuoWorkflowReplayMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const replayMessage = buildGitLabDuoWorkflowReplayMessage(messages[index]);
		if (replayMessage) history.push(replayMessage);
	}
	return history;
}

function buildGitLabDuoWorkflowReplayMessage(message: Message | undefined): GitLabDuoWorkflowReplayMessage | undefined {
	if (!message) return undefined;
	if (message.role === "toolResult") {
		const content = gitLabDuoWorkflowMessageContentToText(message);
		return {
			role: "tool",
			content,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
		};
	}
	if (message.role === "assistant") {
		const content = gitLabDuoWorkflowMessageContentToText(message);
		const toolCalls = gitLabDuoWorkflowAssistantToolCalls(message);
		if (content.length === 0 && toolCalls.length === 0) return undefined;
		return toolCalls.length > 0 ? { role: "assistant", content, toolCalls } : { role: "assistant", content };
	}
	const content = gitLabDuoWorkflowMessageContentToText(message);
	if (content.length === 0) return undefined;
	return { role: "user", content };
}

function gitLabDuoWorkflowAssistantToolCalls(message: AssistantMessage): GitLabDuoWorkflowReplayToolCall[] {
	const toolCalls: GitLabDuoWorkflowReplayToolCall[] = [];
	for (const item of message.content) {
		if (item.type === "toolCall") {
			toolCalls.push({
				id: item.id,
				name: item.name,
				arguments: stripGitLabDuoWorkflowReplayIntent(item.arguments),
			});
		}
	}
	return toolCalls;
}

// The `i` key is OMP's per-call intent narration (e.g. "Reading kernel smoke body").
// It is UI-time metadata describing the call as it is made; on replay the tool name
// plus arguments already say what the call did, so the intent is dead transcript
// weight. Drop it from the rendered history. (Live dispatch never reads the replayed
// args, so this only affects the bytes the model sees, never tool execution.)
function stripGitLabDuoWorkflowReplayIntent(args: Record<string, unknown>): Record<string, unknown> {
	if (!("i" in args)) return args;
	const { i: _intent, ...rest } = args;
	return rest;
}

function extractLatestUserPrompt(messages: readonly Message[]): string {
	const index = findLatestGitLabDuoWorkflowUserMessageIndex(messages);
	if (index < 0) return "";
	return gitLabDuoWorkflowUserContentToText(messages[index] as Exclude<Message, AssistantMessage>);
}

function findLatestGitLabDuoWorkflowUserMessageIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user" || message?.role === "developer") return index;
	}
	return -1;
}

function gitLabDuoWorkflowMessageContentToText(message: Message): string {
	if (message.role === "assistant") {
		return message.content
			.map(item => {
				if (item.type === "text") return item.text;
				if (item.type === "thinking" || item.type === "redactedThinking") return "";
				return "";
			})
			.join("\n");
	}
	return gitLabDuoWorkflowUserContentToText(message);
}

function gitLabDuoWorkflowUserContentToText(message: Exclude<Message, AssistantMessage>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

export function describeGitLabDuoWorkflowSocketEvent(event: unknown): string {
	const fields: string[] = [];
	if (event && typeof event === "object") {
		const type = getRecordString(event, "type");
		const message = getRecordString(event, "message");
		const code = getRecordString(event, "code");
		const reason = getRecordString(event, "reason");
		const error = socketEventErrorText((event as Record<string, unknown>).error);
		if (type) fields.push(`type=${type}`);
		if (message) fields.push(`message=${message}`);
		if (error) fields.push(`error=${error}`);
		if (code) fields.push(`code=${code}`);
		if (reason) fields.push(`reason=${reason}`);
	}
	const fallback = fields.length > 0 ? fields.join(", ") : String(event);
	return gitLabDuoWorkflowErrorText(fallback);
}

function socketEventErrorText(error: unknown): string | undefined {
	if (typeof error === "string" || typeof error === "number") return String(error);
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		return getRecordString(error, "message") ?? getRecordString(error, "name");
	}
	return undefined;
}

export function traceGitLabDuoWorkflow(event: string, data: Record<string, unknown> = {}): void {
	if (Bun.env[GITLAB_DUO_WORKFLOW_TRACE_ENV] !== "1") return;
	const traceFile = Bun.env[GITLAB_DUO_WORKFLOW_TRACE_FILE_ENV]?.trim() || DEFAULT_GITLAB_DUO_WORKFLOW_TRACE_FILE;
	const line = `${JSON.stringify({
		time: new Date().toISOString(),
		event,
		...truncateGitLabTraceData(data),
	})}\n`;
	void fs
		.mkdir(path.dirname(traceFile), { recursive: true })
		.then(() => fs.appendFile(traceFile, line, "utf8"))
		.catch(() => {});
}

function truncateGitLabTraceData(data: Record<string, unknown>): Record<string, unknown> {
	const truncated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		truncated[key] = truncateGitLabTraceValue(value);
	}
	return truncated;
}

function truncateGitLabTraceValue(value: unknown): unknown {
	if (typeof value === "string") return value.slice(0, 500);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 20).map(item => truncateGitLabTraceValue(item));
	if (value && typeof value === "object") return truncateGitLabTraceData(value as Record<string, unknown>);
	return value;
}

function normalizeGitLabBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "") || DEFAULT_GITLAB_BASE_URL;
}

// Join a GitLab API path onto a base URL while preserving any relative install path
// (e.g. self-managed `https://host/gitlab`). `new URL("/api/...", base)` discards the
// base path; concatenating onto the trailing-slash-trimmed base keeps it.
function gitLabApiUrl(baseUrl: string, path: string): URL {
	const normalized = normalizeGitLabBaseUrl(baseUrl);
	return new URL(`${normalized}${path.startsWith("/") ? path : `/${path}`}`);
}

function normalizeGitLabDuoWorkflowServiceBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return normalizeGitLabBaseUrl(absolute);
}

function toGitLabGraphQLNamespaceId(rootNamespaceId: string): string {
	if (/^\d+$/.test(rootNamespaceId)) return `gid://gitlab/Group/${rootNamespaceId}`;
	return rootNamespaceId;
}

function toGitLabRestNamespaceId(rootNamespaceId: string): string {
	const match = rootNamespaceId.match(/^gid:\/\/gitlab\/(?:Group|Namespace)\/(\d+)$/);
	return match?.[1] ?? rootNamespaceId;
}

export function extractGitLabWorkflowToken(payload: GitLabDirectAccessResponse): string | undefined {
	return (
		payload.gitlab_rails?.token ??
		payload.duo_workflow_service?.token ??
		payload.duo_workflow_access_token ??
		payload.workflow_token ??
		payload.token ??
		payload.access_token ??
		payload.jwt
	);
}

export async function resolveGitLabDuoWorkflowNamespaceSelection(
	model: Model<"gitlab-duo-agent">,
	options: GitLabDuoWorkflowOptions,
	apiKey: string,
	baseUrl: string,
	fetchImpl: FetchImpl,
): Promise<GitLabDuoWorkflowNamespaceSelection> {
	// Re-discover the namespace from the current credentials/cwd each turn rather than
	// trusting model.gitlabDuoWorkflowRootNamespaceId, which can be stale (the account's
	// other top-level groups, or a cwd/env shift between model refresh and this turn).
	void model;
	const configured =
		nonEmptyString(options.rootNamespaceId) ??
		nonEmptyString(options.namespaceId) ??
		nonEmptyString(Bun.env.GITLAB_DUO_NAMESPACE_ID);

	try {
		const projectId =
			nonEmptyString(options.projectId) ??
			nonEmptyString(options.projectPath) ??
			nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_ID) ??
			nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_PATH);
		return await discoverGitLabDuoWorkflowRuntimeNamespace({
			apiKey,
			baseUrl,
			fetch: fetchImpl,
			namespaceId: configured,
			projectId,
			cwd: options.cwd,
		});
	} catch (error) {
		throw new AIError.ProviderResponseError(
			`GitLab Duo Workflow runtime namespace resolution failed: ${gitLabDuoWorkflowErrorText(error)}`,
			{ provider: "gitlab-duo-agent", kind: "runtime" },
		);
	}
}

export async function resolveGitLabDuoWorkflowRootNamespaceId(
	model: Model<"gitlab-duo-agent">,
	options: GitLabDuoWorkflowOptions,
	apiKey: string,
	baseUrl: string,
	fetchImpl: FetchImpl,
): Promise<string> {
	const selection = await resolveGitLabDuoWorkflowNamespaceSelection(model, options, apiKey, baseUrl, fetchImpl);
	return selection.rootNamespaceId;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveGitLabDuoWorkflowDefinition(
	workflowDefinition: GitLabDuoWorkflowDefinition | undefined,
): GitLabDuoWorkflowDefinition {
	const configured =
		nonEmptyString(workflowDefinition) ??
		nonEmptyString(Bun.env.GITLAB_DUO_WORKFLOW_DEFINITION) ??
		GITLAB_DUO_WORKFLOW_DEFINITION;
	return configured;
}

// Every workflow definition OMP ships is the inline ambient flow (Path B /
// `flowConfig`); the predicate is kept as a seam for future server-side flows.
function isGitLabDuoWorkflowInlineFlow(workflowDefinition: GitLabDuoWorkflowDefinition): boolean {
	void workflowDefinition;
	return true;
}

function parseGitLabDuoWorkflowSocketData(data: unknown): Record<string, unknown> | null {
	if (typeof data === "string") return parseJsonRecord(data);
	if (data instanceof ArrayBuffer) return parseJsonRecord(new TextDecoder().decode(data));
	if (data instanceof Uint8Array) return parseJsonRecord(new TextDecoder().decode(data));
	if (data && typeof data === "object") return data as Record<string, unknown>;
	return null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	return nonEmptyString(record[key]);
}

function extractGitLabDuoWorkflowCheckpoint(
	event: Record<string, unknown>,
): GitLabDuoWorkflowCheckpointContent | undefined {
	const action = getRecord(event, "action");
	const checkpoint =
		getRecord(action, "newCheckpoint") ?? getRecord(event, "newCheckpoint") ?? getRecord(event, "checkpoint");
	if (!checkpoint) return undefined;
	const directText =
		getRecordString(checkpoint, "message") ??
		getRecordString(checkpoint, "text") ??
		getRecordString(checkpoint, "content") ??
		getNestedRecordString(checkpoint, "checkpoint", "message") ??
		getNestedRecordString(checkpoint, "checkpoint", "text");
	const contextUsage = extractGitLabDuoWorkflowContextUsage(event, action, checkpoint);
	if (directText) {
		return {
			entries: [{ kind: "text", messageIndex: 0, messageKey: "direct:text", content: directText }],
			contentLength: directText.length,
			contextUsage,
		};
	}
	const checkpointJson = getRecordString(checkpoint, "checkpoint");
	const content = checkpointJson ? extractGitLabCheckpointEntries(checkpointJson) : undefined;
	if (content) {
		if (contextUsage) content.contextUsage = contextUsage;
		return content;
	}
	if (contextUsage) {
		return { entries: [], contentLength: 0, contextUsage };
	}
	return undefined;
}

// GitLab Duo Workflow Service attaches per-agent context occupancy to every checkpoint
// (`checkpointer/notifier.py`): agent_context_usage[<agent>] = { total_tokens, max_tokens }.
// total_tokens is the server-side token estimate of that agent's full history; max_tokens
// is the model context window (claude_opus_4_8 observed at 1_000_000). The field rides on
// the event root in practice but can also appear under `action`/`newCheckpoint`.
function extractGitLabDuoWorkflowContextUsage(
	...sources: (Record<string, unknown> | undefined)[]
): GitLabDuoWorkflowContextUsage | undefined {
	for (const source of sources) {
		const usageMap = getRecord(source, "agent_context_usage");
		if (!usageMap) continue;
		const selected = selectGitLabDuoWorkflowContextUsageAgent(usageMap);
		if (selected) return selected;
	}
	return undefined;
}

const GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY = ["Chat Agent", "context_builder"];

function selectGitLabDuoWorkflowContextUsageAgent(
	usageMap: Record<string, unknown>,
): GitLabDuoWorkflowContextUsage | undefined {
	for (const preferred of GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY) {
		const usage = readGitLabDuoWorkflowAgentUsage(usageMap[preferred]);
		if (usage) return usage;
	}
	for (const value of Object.values(usageMap)) {
		const usage = readGitLabDuoWorkflowAgentUsage(value);
		if (usage) return usage;
	}
	return undefined;
}

function readGitLabDuoWorkflowAgentUsage(value: unknown): GitLabDuoWorkflowContextUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const used = numberField(record, "total_tokens");
	const window = numberField(record, "max_tokens");
	if (used === undefined || window === undefined || window <= 0) return undefined;
	return { used, window };
}

function extractGitLabCheckpointEntries(checkpointJson: string): GitLabDuoWorkflowCheckpointContent | undefined {
	const checkpoint = parseJsonRecord(checkpointJson);
	const channelValues = getRecord(checkpoint, "channel_values");
	const chatLog = channelValues?.ui_chat_log;
	if (!Array.isArray(chatLog)) return undefined;
	const entries: GitLabDuoWorkflowCheckpointEntry[] = [];
	for (let index = 0; index < chatLog.length; index++) {
		const entry = chatLog[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const messageType = getRecordString(record, "message_type");
		if (messageType === "agent") {
			const content = getRecordString(record, "content");
			if (!content) continue;
			const messageId = getRecordString(record, "message_id");
			// `message_sub_type: "reasoning"` is the agent's pre-tool-call
			// commentary the inline flow opts into via `on_agent_reasoning`; map it
			// to a thinking block. Other agent text is the answer → text.
			const isReasoning = getRecordString(record, "message_sub_type") === "reasoning";
			const fallbackKey = isReasoning ? `reasoning:${index}` : `agent:${index}`;
			entries.push({
				kind: isReasoning ? "thinking" : "text",
				messageIndex: index,
				messageKey: messageId ? `agent:${messageId}` : fallbackKey,
				content,
			});
			continue;
		}
		if (messageType === "request" || messageType === "tool") {
			entries.push({ kind: "boundary", messageIndex: index });
		}
	}
	return {
		entries,
		contentLength: checkpointJson.length,
		latestMessageType: getGitLabDuoWorkflowLatestMessageType(chatLog),
	};
}

function getGitLabDuoWorkflowLatestMessageType(chatLog: unknown[]): string | undefined {
	for (let index = chatLog.length - 1; index >= 0; index--) {
		const entry = chatLog[index];
		if (!entry || typeof entry !== "object") continue;
		const messageType = getRecordString(entry, "message_type");
		if (messageType) return messageType;
	}
	return undefined;
}

function extractGitLabDuoWorkflowAction(event: Record<string, unknown>): GitLabDuoWorkflowActionDescriptor | undefined {
	const wrappedAction =
		getRecord(event, "action") ?? getRecord(event, "workflowAction") ?? getRecord(event, "toolCall");
	if (wrappedAction) {
		if (getRecord(wrappedAction, "newCheckpoint")) return undefined;
		const name =
			getRecordString(wrappedAction, "name") ??
			getRecordString(wrappedAction, "action") ??
			getRecordString(wrappedAction, "type") ??
			getRecordString(event, "actionName");
		if (!name) return undefined;
		const requestID =
			getRecordString(wrappedAction, "requestID") ??
			getRecordString(wrappedAction, "requestId") ??
			getRecordString(wrappedAction, "id") ??
			getRecordString(event, "requestID") ??
			getRecordString(event, "requestId");
		const resolvedRequestID = requireGitLabDuoWorkflowRequestID(requestID, name, wrappedAction);
		const args = getRecord(wrappedAction, "args") ?? getRecord(wrappedAction, "arguments") ?? wrappedAction;
		return { requestID: resolvedRequestID, name, args: withGitLabDuoWorkflowToolCallId(args, resolvedRequestID) };
	}
	for (const name of GITLAB_DUO_WORKFLOW_ACTION_NAMES) {
		const args = getRecord(event, name);
		if (args) {
			const requestID = getRecordString(event, "requestID") ?? getRecordString(event, "requestId");
			const resolvedRequestID = requireGitLabDuoWorkflowRequestID(requestID, name, event);
			return { requestID: resolvedRequestID, name, args: withGitLabDuoWorkflowToolCallId(args, resolvedRequestID) };
		}
	}
	return undefined;
}

// DWS assigns every executor Action a non-empty `requestID` (contract.proto Action
// field 1; emitted verbatim by Workhorse's proto->JSON relay). The client MUST echo
// that exact id back in `actionResponse.requestID` or the server's outbox silently
// discards the response (outbox.set_action_response: a non-empty id that misses the
// awaiting-futures map hits the "doesn't expect responses, discarding" branch) and
// the tool call's future never resolves — the model then re-issues the same tool
// call, looping. A synthesized id is therefore never correct: it is either redundant
// (the real id was present) or actively harmful (guaranteed-discarded). Fail fast so
// the socket loop surfaces a protocol drift instead of stalling.
function requireGitLabDuoWorkflowRequestID(
	requestID: string | undefined,
	actionName: string,
	source: Record<string, unknown>,
): string {
	if (requestID) return requestID;
	throw new AIError.ValidationError(
		`GitLab Duo Workflow action "${actionName}" missing requestID (keys: ${Object.keys(source).slice(0, 20).join(", ")})`,
	);
}

function withGitLabDuoWorkflowToolCallId(args: unknown, requestID: string): unknown {
	const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	if (typeof record.toolCallId === "string" || typeof record.tool_call_id === "string") {
		return record;
	}
	return { ...record, toolCallId: requestID, tool_call_id: requestID };
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
}

function getRecordString(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return typeof nested === "string" || typeof nested === "number" ? String(nested) : undefined;
}

function getNestedRecordString(value: unknown, parentKey: string, key: string): string | undefined {
	return getRecordString(getRecord(value, parentKey), key);
}
