/** Behavior-compatible reimplementation of @agentclientprotocol/sdk's used protocol surface. */

/** Metadata reserved for protocol extensions. */
export interface Meta {
	_meta?: Record<string, unknown> | null;
}

/** A value which may be produced asynchronously. */
export type MaybePromise<T> = T | Promise<T>;
/** ACP protocol version identifier. */
export type ProtocolVersion = number;
/** Current ACP protocol version. */
export const PROTOCOL_VERSION = 1;
/** Conversation session identifier. */
export type SessionId = string;
/** Tool call identifier. */
export type ToolCallId = string;
/** ACP tool category. */
export type ToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "switch_mode"
	| "other";
/** ACP tool execution state. */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
/** ACP prompt stop reason. */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
/** ACP permission choice kind. */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** Text content block. */
export interface TextContent extends Meta {
	type: "text";
	text: string;
}
/** Image content block. */
export interface ImageContent extends Meta {
	type: "image";
	data: string;
	mimeType: string;
}
/** Audio content block. */
export interface AudioContent extends Meta {
	type: "audio";
	data: string;
	mimeType: string;
}
/** Resource link content block. */
export interface ResourceLink extends Meta {
	type: "resource_link";
	uri: string;
	name?: string;
	title?: string;
	mimeType?: string | null;
	description?: string | null;
	size?: number | null;
}
/** Text or blob resource embedded in a prompt. */
export type EmbeddedResourceValue = (
	| { uri: string; text: string; mimeType?: string }
	| { uri: string; blob: string; mimeType?: string }
) &
	Meta;
/** Embedded resource content block. */
export interface EmbeddedResource extends Meta {
	type: "resource";
	resource: EmbeddedResourceValue;
}
/** Displayable ACP content. */
export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;
/** Content wrapper used by tool calls. */
export interface ToolContent extends Meta {
	type: "content";
	content: ContentBlock;
}
/** File diff emitted by a tool call. */
export interface ToolDiff extends Meta {
	type: "diff";
	path: string;
	oldText?: string | null;
	newText: string;
}
/** Terminal reference emitted by a tool call. */
export interface ToolTerminal extends Meta {
	type: "terminal";
	terminalId: string;
}
/** Tool call output item. */
export type ToolCallContent = ToolContent | ToolDiff | ToolTerminal;
/** File location associated with a tool call. */
export interface ToolCallLocation extends Meta {
	path: string;
	line?: number | null;
}
/** Initial tool call notification. */
export interface ToolCall extends Meta {
	toolCallId: ToolCallId;
	title: string;
	kind?: ToolKind | null;
	status?: ToolCallStatus | null;
	content?: ToolCallContent[] | null;
	locations?: ToolCallLocation[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
}
/** Partial update to a tool call. */
export interface ToolCallUpdate extends Meta {
	toolCallId: ToolCallId;
	title?: string | null;
	kind?: ToolKind | null;
	status?: ToolCallStatus | null;
	content?: ToolCallContent[] | null;
	locations?: ToolCallLocation[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
}
/** Permission option presented by the client. */
export interface PermissionOption extends Meta {
	optionId: string;
	name: string;
	kind: PermissionOptionKind;
}
/** Request for permission to execute a tool call. */
export interface RequestPermissionRequest extends Meta {
	sessionId: SessionId;
	toolCall: ToolCallUpdate;
	options: PermissionOption[];
}
/** Permission request response. */
export interface RequestPermissionResponse extends Meta {
	outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
}

/** Client filesystem capabilities. */
export interface FileSystemCapabilities {
	readTextFile?: boolean;
	writeTextFile?: boolean;
}
/** Capabilities advertised by an ACP client. */
export interface ClientCapabilities {
	fs?: FileSystemCapabilities;
	terminal?: boolean;
	auth?: { terminal?: boolean };
	elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
	_meta?: Record<string, unknown>;
}
/** Implementation identity sent during initialization. */
export interface Implementation {
	name: string;
	version: string;
	title?: string;
}
/** Initialization request. */
export interface InitializeRequest extends Meta {
	protocolVersion: ProtocolVersion;
	clientCapabilities?: ClientCapabilities;
	clientInfo?: Implementation | null;
}
/** Authentication method using an environment variable. */
export interface AuthMethodEnvVar extends Meta {
	type: "env_var";
	id: string;
	name: string;
	description?: string | null;
	variable: string;
}
/** Authentication method using a terminal command. */
export interface AuthMethodTerminal extends Meta {
	type: "terminal";
	id: string;
	name: string;
	description?: string | null;
	command?: string;
	args?: string[];
}
/** Authentication method handled by the agent. */
export interface AuthMethodAgent extends Meta {
	type?: "agent";
	id: string;
	name: string;
	description?: string | null;
}
/** Authentication method advertised by an agent. */
export type AuthMethod = AuthMethodEnvVar | AuthMethodTerminal | AuthMethodAgent;
/** Initialization response. */
export interface InitializeResponse extends Meta {
	protocolVersion: ProtocolVersion;
	agentCapabilities?: Record<string, unknown>;
	authMethods?: AuthMethod[];
	agentInfo?: Implementation | null;
}
/** Authentication request. */
export interface AuthenticateRequest extends Meta {
	methodId: string;
}
/** Authentication response. */
export interface AuthenticateResponse extends Meta {}

/** ACP MCP server configuration. */
export type McpServer = (
	| { type?: "stdio"; name: string; command: string; args?: string[]; env: Array<{ name: string; value: string }> }
	| { type: "http" | "sse" | "acp"; name: string; url: string; headers: Array<{ name: string; value: string }> }
) &
	Meta;
/** Session mode descriptor. */
export interface SessionMode extends Meta {
	id: string;
	name: string;
	description?: string | null;
}
/** Current session mode and available choices. */
export interface SessionModeState extends Meta {
	currentModeId: string;
	availableModes: SessionMode[];
}
/** Select configuration value. */
export interface SessionConfigSelectOption extends Meta {
	value: string;
	name: string;
	description?: string | null;
}
/** Session configuration option. */
export type SessionConfigOption = (
	| { type: "select"; currentValue: string; options: SessionConfigSelectOption[] }
	| { type: "boolean"; currentValue: boolean }
) & { id: string; name: string; description?: string | null; category?: string | null } & Meta;
/** Shared fields for creating or restoring a session. */
export interface SessionSetupRequest extends Meta {
	cwd: string;
	mcpServers: McpServer[];
	additionalDirectories?: string[];
}
/** New-session request. */
export interface NewSessionRequest extends SessionSetupRequest {}
/** New-session response. */
export interface NewSessionResponse extends Meta {
	sessionId: SessionId;
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
}
/** Load-session request. */
export interface LoadSessionRequest extends SessionSetupRequest {
	sessionId: SessionId;
}
/** Load-session response. */
export interface LoadSessionResponse extends Meta {
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
}
/** Resume-session request. */
export interface ResumeSessionRequest extends LoadSessionRequest {}
/** Resume-session response. */
export interface ResumeSessionResponse extends LoadSessionResponse {}
/** Fork-session request. */
export interface ForkSessionRequest extends LoadSessionRequest {}
/** Fork-session response. */
export interface ForkSessionResponse extends NewSessionResponse {}
/** Close-session request. */
export interface CloseSessionRequest extends Meta {
	sessionId: SessionId;
}
/** Close-session response. */
export interface CloseSessionResponse extends Meta {}
/** Session-list request. */
export interface ListSessionsRequest extends Meta {
	cwd?: string | null;
	cursor?: string | null;
	additionalDirectories?: string[];
}
/** Session metadata. */
export interface SessionInfo extends Meta {
	sessionId: SessionId;
	cwd: string;
	additionalDirectories?: string[];
	title?: string | null;
	updatedAt?: string | null;
}
/** Session-list response. */
export interface ListSessionsResponse extends Meta {
	sessions: SessionInfo[];
	nextCursor?: string | null;
}
/** Set-mode request. */
export interface SetSessionModeRequest extends Meta {
	sessionId: SessionId;
	modeId: string;
}
/** Set-mode response. */
export interface SetSessionModeResponse extends Meta {}
/** Set-config request. */
export interface SetSessionConfigOptionRequest extends Meta {
	sessionId: SessionId;
	configId: string;
	value: string | boolean;
}
/** Set-config response. */
export interface SetSessionConfigOptionResponse extends Meta {
	configOptions: SessionConfigOption[];
}

/** Slash command advertised by an agent. */
export interface AvailableCommand extends Meta {
	name: string;
	description: string;
	input?: { hint: string } | null;
}
/** Session plan entry. */
export interface PlanEntry extends Meta {
	content: string;
	priority: "high" | "medium" | "low";
	status: "pending" | "in_progress" | "completed";
}
/** Session update payload. */
export type SessionUpdate =
	| ({
			sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
			content: ContentBlock;
			messageId?: string;
	  } & Meta)
	| ({ sessionUpdate: "tool_call" } & ToolCall)
	| ({ sessionUpdate: "tool_call_update" } & ToolCallUpdate)
	| ({ sessionUpdate: "plan"; entries: PlanEntry[] } & Meta)
	| ({ sessionUpdate: "current_mode_update"; currentModeId: string } & Meta)
	| ({ sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] } & Meta)
	| ({ sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] } & Meta)
	| ({ sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null } & Meta)
	| ({
			sessionUpdate: "usage_update";
			size: number;
			used: number;
			cost?: { amount: number; currency: string } | null;
	  } & Meta);
/** Notification containing a session update. */
export interface SessionNotification extends Meta {
	sessionId: SessionId;
	update: SessionUpdate;
}
/** Prompt request. */
export interface PromptRequest extends Meta {
	sessionId: SessionId;
	prompt: ContentBlock[];
}
/** Prompt token usage. */
export interface Usage extends Meta {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cachedReadTokens?: number | null;
	cachedWriteTokens?: number | null;
	thoughtTokens?: number | null;
}
/** Prompt response. */
export interface PromptResponse extends Meta {
	stopReason: StopReason;
	usage?: Usage | null;
}

/** Read-file request. */
export interface ReadTextFileRequest extends Meta {
	sessionId: string;
	path: string;
	line?: number | null;
	limit?: number | null;
}
/** Read-file response. */
export interface ReadTextFileResponse extends Meta {
	content: string;
}
/** Write-file request. */
export interface WriteTextFileRequest extends Meta {
	sessionId: string;
	path: string;
	content: string;
}
/** Write-file response. */
export interface WriteTextFileResponse extends Meta {}
/** Create-terminal request. */
export interface CreateTerminalRequest extends Meta {
	sessionId: string;
	command: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	cwd?: string;
	outputByteLimit?: number;
}
/** Terminal output response. */
export interface TerminalOutputResponse extends Meta {
	output: string;
	truncated: boolean;
	exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
}
/** Terminal exit response. */
export interface WaitForTerminalExitResponse extends Meta {
	exitCode?: number | null;
	signal?: string | null;
}
/** Empty terminal response. */
export interface TerminalActionResponse extends Meta {}

/** Elicitation scalar value. */
export type ElicitationContentValue = string | number | boolean | string[];
/** Elicitation property schema. */
export type ElicitationPropertySchema = Record<string, unknown> & {
	type: string;
	title?: string;
	description?: string;
};
/** Elicitation creation request. */
export type CreateElicitationRequest =
	| ({
			mode: "form";
			sessionId: string;
			message: string;
			requestedSchema: {
				type: "object";
				properties: Record<string, ElicitationPropertySchema>;
				required?: string[];
			};
	  } & Meta)
	| ({ mode: "url"; sessionId: string; message: string; url: string; elicitationId: string } & Meta)
	| ({
			mode: string;
			sessionId: string;
			message: string;
			requestedSchema?: {
				type: "object";
				properties: Record<string, ElicitationPropertySchema>;
				required?: string[];
			};
			url?: string;
			elicitationId?: string;
	  } & Meta);
/** Elicitation creation response. */
export type CreateElicitationResponse =
	| ({ action: "accept"; content: Record<string, ElicitationContentValue> } & Meta)
	| ({ action: "decline" | "cancel"; content?: never } & Meta)
	| ({ action: string; content?: Record<string, ElicitationContentValue> } & Meta);
/** Completion notification for URL elicitation. */
export interface CompleteElicitationNotification extends Meta {
	sessionId: string;
	elicitationId: string;
}

/** Agent-side request handler contract. */
export interface Agent {
	initialize(params: InitializeRequest): MaybePromise<InitializeResponse>;
	newSession(params: NewSessionRequest): MaybePromise<NewSessionResponse>;
	prompt(params: PromptRequest): MaybePromise<PromptResponse>;
	cancel(params: { sessionId: string }): MaybePromise<void>;
	authenticate?(params: AuthenticateRequest): MaybePromise<AuthenticateResponse | void>;
	loadSession?(params: LoadSessionRequest): MaybePromise<LoadSessionResponse | void>;
	listSessions?(params: ListSessionsRequest): MaybePromise<ListSessionsResponse>;
	resumeSession?(params: ResumeSessionRequest): MaybePromise<ResumeSessionResponse>;
	unstable_forkSession?(params: ForkSessionRequest): MaybePromise<ForkSessionResponse>;
	closeSession?(params: CloseSessionRequest): MaybePromise<CloseSessionResponse | void>;
	setSessionMode?(params: SetSessionModeRequest): MaybePromise<SetSessionModeResponse | void>;
	setSessionConfigOption?(params: SetSessionConfigOptionRequest): MaybePromise<SetSessionConfigOptionResponse>;
	extMethod?(method: string, params: Record<string, unknown>): MaybePromise<Record<string, unknown>>;
	extNotification?(method: string, params: Record<string, unknown>): MaybePromise<void>;
}
