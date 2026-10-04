/**
 * Type-only conformance between the generated wire types (the contract client
 * libraries are generated from) and the server's own types. Checked by
 * `bun check`; a failure names the definition and the drifted keys.
 *
 * - Outbound (server → client): every key the server sends is on the wire,
 *   every wire-required key is always sent, and leaf values (literals, enums,
 *   primitives, arrays of them) fit. Nested objects are checked through their
 *   own definition pairs below.
 * - Inbound (client → server): the wire exposes every key the server reads,
 *   and every wire value fits the server field.
 * - Open unions (messages, assistant events) are pinned by discriminator set.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessageEvent, ImageContent, Model, Usage } from "@oh-my-pi/pi-ai";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { RpcGoalResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import type { RpcMessagesPage } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-messages";
import type {
	RpcAgentSessionEventFrame,
	RpcAskDialogQuestion,
	RpcAvailableCommandsUpdateFrame,
	RpcAvailableSlashCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
	RpcLiveEndFrame,
	RpcLiveLevelsFrame,
	RpcLivePhaseFrame,
	RpcLiveTranscriptFrame,
	RpcOpenSessionResult,
	RpcPromptError,
	RpcPromptResultFrame,
	RpcReadyFrame,
	RpcResponse,
	RpcSessionSettledFrame,
	RpcSessionState,
	RpcSubagentEventFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type * as Wire from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ContextUsage } from "@oh-my-pi/pi-tui/status-line/types";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

type Assert<T extends true> = T;
type Leaf = string | number | boolean | null;
type KeysOf<T> = T extends unknown ? keyof T : never;
type RequiredKeysOf<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Element<T> = T extends readonly (infer E)[] ? E : never;
/** String enum members compare by value: `Effort.High` and `"high"` are the same wire value. */
type Lit<T> = T extends string ? `${T}` : T;
type Defined<T> = Lit<Exclude<T, undefined>>;
type IsLeaf<T> = [Defined<T>] extends [Leaf] ? true : false;
/** `true`, or the entries that failed. */
type AllTrue<T> = [T[keyof T]] extends [true] ? true : { [K in keyof T as T[K] extends true ? never : K]: T[K] };

/** Leaf values and arrays of leaves are compared; object values are checked through their own definition pair. */
type FieldFits<From, To> =
	IsLeaf<To> extends true
		? [Defined<From>] extends [Defined<To>]
			? true
			: false
		: [null] extends [From]
			? [null] extends [To]
				? true
				: false
			: [Exclude<To, undefined | null>] extends [readonly unknown[]]
				? IsLeaf<Element<Exclude<To, undefined | null>>> extends true
					? [Lit<Element<Exclude<From, undefined | null>>>] extends [Lit<Element<Exclude<To, undefined | null>>>]
						? true
						: false
					: true
				: true;

type MismatchedKeys<From, To> = {
	[K in keyof From & keyof To]: FieldFits<From[K], To[K]> extends true ? never : K;
}[keyof From & keyof To];

type Report<Unnamed, Optional, Mismatched> = [Unnamed | Optional | Mismatched] extends [never]
	? true
	: { unnamedKeys: Unnamed; requiredButOptional: Optional; mismatchedKeys: Mismatched };

/** Server → client frame or result. */
type Outbound<Server, WireType> = Report<
	Exclude<KeysOf<Server>, KeysOf<WireType>>,
	Exclude<RequiredKeysOf<WireType>, RequiredKeysOf<Server>>,
	MismatchedKeys<Server, WireType>
>;

/** Server → client value the wire models as a subset (the server sends more fields than clients read). */
type OutboundSubset<Server, WireType> = Report<
	never,
	Exclude<RequiredKeysOf<WireType>, RequiredKeysOf<Server>>,
	MismatchedKeys<Server, WireType>
>;

/** Client → server value. */
type Inbound<WireType, Server> = Report<
	Exclude<KeysOf<Server>, KeysOf<WireType>>,
	Exclude<RequiredKeysOf<Server>, RequiredKeysOf<WireType>>,
	MismatchedKeys<WireType, Server>
>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : { left: A; right: B }) : { left: A; right: B };

// --- Commands -------------------------------------------------------------

type CommandName = RpcCommand["type"];
type ServerParams<K extends CommandName> = Omit<Extract<RpcCommand, { type: K }>, "id" | "type">;
type ServerResult<K extends CommandName> =
	Extract<RpcResponse, { command: K; success: true }> extends infer R
		? R extends { data?: infer D }
			? "data" extends keyof R
				? D
				: undefined
			: undefined
		: never;

export type CommandSet = Assert<Same<keyof Wire.RpcWireCommands, CommandName>>;
export type CommandParams = Assert<
	AllTrue<{
		[K in CommandName]: Wire.RpcWireCommands[K]["params"] extends undefined
			? Same<keyof ServerParams<K>, never>
			: Inbound<Wire.RpcWireCommands[K]["params"], ServerParams<K>>;
	}>
>;
export type CommandResults = Assert<
	AllTrue<{
		[K in CommandName]: Wire.RpcWireCommands[K]["result"] extends undefined
			? Same<ServerResult<K>, undefined>
			: [Exclude<Wire.RpcWireCommands[K]["result"], null>] extends [Wire.ModelInfo]
				? OutboundSubset<
						Exclude<ServerResult<K>, null | undefined>,
						Exclude<Wire.RpcWireCommands[K]["result"], null>
					>
				: Outbound<Exclude<ServerResult<K>, null | undefined>, Exclude<Wire.RpcWireCommands[K]["result"], null>>;
	}>
>;
/** A nullable result is exactly a server result that can be `null`. */
export type CommandNullability = Assert<
	AllTrue<{
		[K in CommandName]: Same<
			null extends ServerResult<K> ? true : false,
			null extends Wire.RpcWireCommands[K]["result"] ? true : false
		>;
	}>
>;

// --- Session events and notifications ---------------------------------------

type ServerEventType = RpcAgentSessionEventFrame["type"];
export type SessionEventSet = Assert<Same<Wire.RpcAgentEvent["type"], ServerEventType>>;
export type SessionEvents = Assert<
	AllTrue<{
		[K in ServerEventType]: Outbound<
			Extract<RpcAgentSessionEventFrame, { type: K }>,
			Extract<Wire.RpcAgentEvent, { type: K }>
		>;
	}>
>;

type ServerUiMethod = RpcExtensionUIRequest["method"];
export type UiRequestSet = Assert<Same<Wire.ExtensionUiRequest["method"], ServerUiMethod>>;
export type UiRequests = Assert<
	AllTrue<{
		[K in ServerUiMethod]: Outbound<
			Extract<RpcExtensionUIRequest, { method: K }>,
			Extract<Wire.ExtensionUiRequest, { method: K }>
		>;
	}>
>;

export type Frames = Assert<
	AllTrue<{
		ready: Outbound<RpcReadyFrame, Wire.ReadyEvent>;
		promptResult: Outbound<RpcPromptResultFrame, Wire.PromptResultEvent>;
		promptError: Outbound<RpcPromptError, Wire.PromptError>;
		sessionSettled: Outbound<RpcSessionSettledFrame, Wire.SessionSettledEvent>;
		availableCommands: Outbound<RpcAvailableCommandsUpdateFrame, Wire.AvailableCommandsUpdateEvent>;
		subagentLifecycle: Outbound<RpcSubagentLifecycleFrame, Wire.SubagentLifecycleEvent>;
		subagentLifecyclePayload: Outbound<RpcSubagentLifecycleFrame["payload"], Wire.SubagentLifecyclePayload>;
		subagentProgress: Outbound<RpcSubagentProgressFrame, Wire.SubagentProgressEvent>;
		subagentProgressPayload: Outbound<RpcSubagentProgressFrame["payload"], Wire.SubagentProgressPayload>;
		subagentEvent: Outbound<RpcSubagentEventFrame, Wire.SubagentEvent>;
		subagentEventPayload: Outbound<RpcSubagentEventFrame["payload"], Wire.SubagentEventPayload>;
		livePhase: Outbound<RpcLivePhaseFrame, Wire.LivePhaseEvent>;
		liveLevels: Outbound<RpcLiveLevelsFrame, Wire.LiveLevelsEvent>;
		liveTranscript: Outbound<RpcLiveTranscriptFrame, Wire.LiveTranscriptEvent>;
		liveEnd: Outbound<RpcLiveEndFrame, Wire.LiveEndEvent>;
		hostToolCall: Outbound<RpcHostToolCallRequest, Wire.HostToolCallRequest>;
		hostToolCancel: Outbound<RpcHostToolCancelRequest, Wire.HostToolCancelRequest>;
		hostUriRequest: Outbound<RpcHostUriRequest, Wire.HostUriRequest>;
		hostUriCancel: Outbound<RpcHostUriCancelRequest, Wire.HostUriCancelRequest>;
		askQuestion: Outbound<RpcAskDialogQuestion, Wire.AskQuestion>;
		askOption: Outbound<RpcAskDialogQuestion["options"][number], Wire.AskOption>;
		askAnswer: Inbound<Wire.AskAnswer, Extract<RpcExtensionUIResponse, { answers: unknown }>["answers"][number]>;
		hostToolDefinition: Inbound<Wire.HostToolDefinition, RpcHostToolDefinition>;
		hostUriScheme: Inbound<Wire.HostUriSchemeDefinition, RpcHostUriSchemeDefinition>;
		hostToolUpdate: Inbound<Wire.HostToolUpdate, RpcHostToolUpdate>;
		hostToolResult: Inbound<Wire.HostToolResult, RpcHostToolResult>;
		hostToolPayload: Inbound<Wire.HostToolResultPayload, RpcHostToolResult["result"]>;
		hostUriResult: Inbound<Wire.HostUriResult, RpcHostUriResult>;
		uiValue: Inbound<Wire.ValueUiResponse, Extract<RpcExtensionUIResponse, { value: unknown }>>;
		uiConfirm: Inbound<Wire.ConfirmUiResponse, Extract<RpcExtensionUIResponse, { confirmed: unknown }>>;
		uiCancel: Inbound<Wire.CancelUiResponse, Extract<RpcExtensionUIResponse, { cancelled: unknown }>>;
		uiAnswers: Inbound<Wire.AnswersUiResponse, Extract<RpcExtensionUIResponse, { answers: unknown }>>;
		responseFailure: Outbound<Extract<RpcResponse, { success: false }>, Wire.RpcResponse>;
	}>
>;
/** Every inbound frame type the server reads is a wire inbound frame. */
export type InboundSet = Assert<
	Same<
		Wire.RpcInbound["type"],
		RpcExtensionUIResponse["type"] | RpcHostToolUpdate["type"] | RpcHostToolResult["type"] | RpcHostUriResult["type"]
	>
>;

// --- State and results --------------------------------------------------------

export type State = Assert<
	AllTrue<{
		sessionState: Outbound<RpcSessionState, Wire.SessionState>;
		queuedMessages: Outbound<RpcSessionState["queuedMessages"], Wire.QueuedMessagesState>;
		dumpTool: Outbound<NonNullable<RpcSessionState["dumpTools"]>[number], Wire.ToolDescriptor>;
		contextUsage: Outbound<ContextUsage, Wire.ContextUsage>;
		todoPhase: Outbound<TodoPhase, Wire.TodoPhase>;
		todoItem: Outbound<TodoItem, Wire.TodoItem>;
		todoPhaseInbound: Inbound<Wire.TodoPhase, TodoPhase>;
		todoItemInbound: Inbound<Wire.TodoItem, TodoItem>;
		goal: Outbound<Goal, Wire.Goal>;
		goalModeState: Outbound<GoalModeState, Wire.GoalModeState>;
		goalResult: Outbound<RpcGoalResult, Wire.GoalResult>;
		bashResult: Outbound<BashResult, Wire.BashResult>;
		compactionResult: Outbound<CompactionResult, Wire.CompactionResult>;
		sessionStats: Outbound<SessionStats, Wire.SessionStats>;
		sessionStatsTokens: Outbound<SessionStats["tokens"], Wire.TokenUsage>;
		sessionCredits: Outbound<NonNullable<SessionStats["credits"]>, Wire.SessionCredits>;
		messagesPage: Outbound<RpcMessagesPage, Wire.MessagesPage>;
		openSession: Outbound<RpcOpenSessionResult, Wire.OpenSessionResult>;
		slashCommand: Outbound<RpcAvailableSlashCommand, Wire.AvailableSlashCommand>;
		slashSubcommand: Outbound<NonNullable<RpcAvailableSlashCommand["subcommands"]>[number], Wire.SlashSubcommand>;
		subagentSnapshot: Outbound<RpcSubagentSnapshot, Wire.SubagentSnapshot>;
		subagentMessages: Outbound<RpcSubagentMessagesResult, Wire.SubagentMessages>;
		model: OutboundSubset<Model, Wire.ModelInfo>;
		modelCost: OutboundSubset<Model["cost"], Wire.ModelCost>;
		thinkingConfig: OutboundSubset<NonNullable<Model["thinking"]>, Wire.ThinkingConfig>;
		usage: Outbound<Usage, Wire.Usage>;
		image: Outbound<ImageContent, Wire.ImageContent>;
	}>
>;

// --- Open unions ------------------------------------------------------------------

export type MessageRoles = Assert<Same<Wire.AgentMessage["role"], AgentMessage["role"]>>;
export type AssistantEventTypes = Assert<Same<Wire.AssistantMessageEvent["type"], AssistantMessageEvent["type"]>>;
export type AssistantContentTypes = Assert<
	Same<Wire.AssistantContent["type"], Extract<AgentMessage, { role: "assistant" }>["content"][number]["type"]>
>;
