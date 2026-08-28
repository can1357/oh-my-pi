import type { ptree } from "@oh-my-pi/pi-utils";

export type DapMessage = DapRequestMessage | DapResponseMessage | DapEventMessage;
export type DapSessionStatus = "launching" | "configuring" | "stopped" | "running" | "terminated";

export interface DapProtocolMessage {
	seq: number;
	type: "request" | "response" | "event";
}

export interface DapRequestMessage extends DapProtocolMessage {
	type: "request";
	command: string;
	arguments?: unknown;
}

export interface DapResponseMessage extends DapProtocolMessage {
	type: "response";
	request_seq: number;
	success: boolean;
	command: string;
	message?: string;
	body?: unknown;
}

export interface DapEventMessage extends DapProtocolMessage {
	type: "event";
	event: string;
	body?: unknown;
}

export interface DapErrorBody {
	id?: number;
	format: string;
	variables?: Record<string, string>;
	showUser?: boolean;
	sendTelemetry?: boolean;
	url?: string;
	urlLabel?: string;
}

export interface DapSource {
	name?: string;
	path?: string;
	sourceReference?: number;
	presentationHint?: "normal" | "emphasize" | "deemphasize";
	origin?: string;
	adapterData?: unknown;
}

export interface DapBreakpoint {
	id?: number;
	verified: boolean;
	message?: string;
	source?: DapSource;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	instructionReference?: string;
	offset?: number;
}

export interface DapSourceBreakpoint {
	line: number;
	column?: number;
	condition?: string;
	hitCondition?: string;
	logMessage?: string;
}

export interface DapFunctionBreakpoint {
	name: string;
	condition?: string;
	hitCondition?: string;
}

export interface DapInitializeArguments {
	clientID?: string;
	clientName?: string;
	adapterID?: string;
	locale?: string;
	linesStartAt1?: boolean;
	columnsStartAt1?: boolean;
	pathFormat?: "path" | "uri";
	supportsVariableType?: boolean;
	supportsVariablePaging?: boolean;
	supportsRunInTerminalRequest?: boolean;
	supportsStartDebuggingRequest?: boolean;
	supportsMemoryReferences?: boolean;
	supportsProgressReporting?: boolean;
	supportsInvalidatedEvent?: boolean;
	supportsArgsCanBeInterpretedByShell?: boolean;
}

export interface DapCapabilities {
	supportsConfigurationDoneRequest?: boolean;
	supportsFunctionBreakpoints?: boolean;
	supportsConditionalBreakpoints?: boolean;
	supportsTerminateRequest?: boolean;
	supportsTerminateThreadsRequest?: boolean;
	supportsEvaluateForHovers?: boolean;
	supportsSetVariable?: boolean;
	supportsRestartRequest?: boolean;
	supportsCompletionsRequest?: boolean;
	supportsLogPoints?: boolean;
	supportsDisassembleRequest?: boolean;
	supportsReadMemoryRequest?: boolean;
	supportsWriteMemoryRequest?: boolean;
	supportsModulesRequest?: boolean;
	supportsLoadedSourcesRequest?: boolean;
	supportsExceptionInfoRequest?: boolean;
	supportsInstructionBreakpoints?: boolean;
	supportsDataBreakpoints?: boolean;
	supportsSteppingGranularity?: boolean;
	supportsClipboardContext?: boolean;
	[key: string]: unknown;
}

export interface DapLaunchArguments {
	program: string;
	args?: string[];
	cwd?: string;
	stopOnEntry?: boolean;
	stopAtBeginningOfMainSubprogram?: boolean;
	request?: "launch";
	[key: string]: unknown;
}

export interface DapAttachArguments {
	pid?: number;
	processId?: number;
	port?: number;
	host?: string;
	cwd?: string;
	request?: "attach";
	[key: string]: unknown;
}

export interface DapConfigurationDoneArguments {
	threadId?: number;
}

export interface DapSetBreakpointsArguments {
	source: DapSource;
	breakpoints: DapSourceBreakpoint[];
	sourceModified?: boolean;
}

export interface DapSetBreakpointsResponse {
	breakpoints: DapBreakpoint[];
}

export interface DapSetFunctionBreakpointsArguments {
	breakpoints: DapFunctionBreakpoint[];
}

export interface DapSetFunctionBreakpointsResponse {
	breakpoints: DapBreakpoint[];
}

export interface DapInstructionBreakpoint {
	instructionReference: string;
	offset?: number;
	condition?: string;
	hitCondition?: string;
}

export interface DapSetInstructionBreakpointsArguments {
	breakpoints: DapInstructionBreakpoint[];
}

export interface DapDataBreakpointInfoArguments {
	variablesReference?: number;
	name: string;
	frameId?: number;
}

export interface DapDataBreakpointInfoResponse {
	dataId: string | null;
	description: string;
	accessTypes?: Array<"read" | "write" | "readWrite">;
	canPersist?: boolean;
}

export interface DapDataBreakpoint {
	dataId: string;
	accessType?: "read" | "write" | "readWrite";
	condition?: string;
	hitCondition?: string;
}

export interface DapSetDataBreakpointsArguments {
	breakpoints: DapDataBreakpoint[];
}

export interface DapContinueArguments {
	threadId: number;
	singleThread?: boolean;
}

export interface DapContinueResponse {
	allThreadsContinued?: boolean;
}

export interface DapPauseArguments {
	threadId: number;
}

export interface DapStepArguments {
	threadId: number;
	singleThread?: boolean;
	granularity?: "statement" | "line" | "instruction";
}

export interface DapTerminateArguments {
	restart?: boolean;
}

export interface DapDisconnectArguments {
	restart?: boolean;
	terminateDebuggee?: boolean;
	suspendDebuggee?: boolean;
}

export interface DapStackTraceArguments {
	threadId: number;
	startFrame?: number;
	levels?: number;
	format?: Record<string, unknown>;
}

export interface DapStackFrame {
	id: number;
	name: string;
	source?: DapSource;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	instructionPointerReference?: string;
	moduleId?: number | string;
	presentationHint?: "normal" | "label" | "subtle";
}

export interface DapStackTraceResponse {
	stackFrames: DapStackFrame[];
	totalFrames?: number;
}

export interface DapScopesArguments {
	frameId: number;
}

export interface DapScope {
	name: string;
	presentationHint?: "arguments" | "locals" | "registers" | string;
	variablesReference: number;
	expensive: boolean;
	source?: DapSource;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
}

export interface DapScopesResponse {
	scopes: DapScope[];
}

export interface DapVariablesArguments {
	variablesReference: number;
	filter?: "indexed" | "named";
	start?: number;
	count?: number;
	format?: Record<string, unknown>;
}

export interface DapVariable {
	name: string;
	value: string;
	type?: string;
	presentationHint?: {
		kind?: string;
		attributes?: string[];
		visibility?: string;
		lazy?: boolean;
	};
	evaluateName?: string;
	variablesReference: number;
	namedVariables?: number;
	indexedVariables?: number;
	memoryReference?: string;
}

export interface DapVariablesResponse {
	variables: DapVariable[];
}

export interface DapDisassembleArguments {
	memoryReference: string;
	offset?: number;
	instructionOffset?: number;
	instructionCount: number;
	resolveSymbols?: boolean;
}

export interface DapDisassembledInstruction {
	address: string;
	instructionBytes?: string;
	instruction: string;
	symbol?: string;
	location?: DapSource;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
}

export interface DapDisassembleResponse {
	instructions: DapDisassembledInstruction[];
}

export interface DapReadMemoryArguments {
	memoryReference: string;
	offset?: number;
	count: number;
}

export interface DapReadMemoryResponse {
	address: string;
	unreadableBytes?: number;
	data?: string;
}

export interface DapWriteMemoryArguments {
	memoryReference: string;
	offset?: number;
	data: string;
	allowPartial?: boolean;
}

export interface DapWriteMemoryResponse {
	offset?: number;
	bytesWritten?: number;
}

export interface DapModule {
	id: number | string;
	name: string;
	path?: string;
	isOptimized?: boolean;
	isUserCode?: boolean;
	version?: string;
	symbolStatus?: string;
	symbolFilePath?: string;
	dateTimeStamp?: string;
	addressRange?: string;
}

export interface DapModulesArguments {
	startModule?: number;
	moduleCount?: number;
}

export interface DapModulesResponse {
	modules: DapModule[];
	totalModules?: number;
}

export interface DapLoadedSourcesResponse {
	sources: DapSource[];
}

export interface DapEvaluateArguments {
	expression: string;
	frameId?: number;
	context?: "watch" | "repl" | "hover" | "clipboard" | "variables";
	format?: Record<string, unknown>;
}

export interface DapEvaluateResponse {
	result: string;
	type?: string;
	presentationHint?: {
		kind?: string;
		attributes?: string[];
		visibility?: string;
		lazy?: boolean;
	};
	variablesReference: number;
	namedVariables?: number;
	indexedVariables?: number;
	memoryReference?: string;
}

export interface DapThread {
	id: number;
	name: string;
}

export interface DapThreadsResponse {
	threads: DapThread[];
}

export interface DapOutputEventBody {
	category?: "console" | "important" | "stdout" | "stderr" | "telemetry" | string;
	output: string;
	group?: "start" | "startCollapsed" | "end";
	variablesReference?: number;
	source?: DapSource;
	line?: number;
	column?: number;
	data?: unknown;
}

export interface DapStoppedEventBody {
	reason: string;
	description?: string;
	threadId?: number;
	preserveFocusHint?: boolean;
	text?: string;
	allThreadsStopped?: boolean;
	hitBreakpointIds?: number[];
}

export interface DapContinuedEventBody {
	threadId: number;
	allThreadsContinued?: boolean;
}

export interface DapExitedEventBody {
	exitCode?: number;
}

export interface DapTerminatedEventBody {
	restart?: boolean | Record<string, unknown>;
}

export interface DapInitializedEventBody {}

export interface DapRunInTerminalArguments {
	kind?: "integrated" | "external";
	title?: string;
	cwd?: string;
	args: string[];
	env?: Record<string, string | null>;
}

export interface DapRunInTerminalResponse {
	processId?: number;
	shellProcessId?: number;
}

export interface DapStartDebuggingArguments {
	request: "launch" | "attach";
	configuration: Record<string, unknown>;
}

export interface DapPendingRequest {
	resolve: (body: unknown) => void;
	reject: (error: Error) => void;
	command: string;
}

export interface DapClientState {
	adapterName: string;
	cwd: string;
	proc: ptree.ChildProcess<"pipe">;
	requestSeq: number;
	pendingRequests: Map<number, DapPendingRequest>;
	messageBuffer: Uint8Array;
	isReading: boolean;
	lastActivity: number;
	capabilities?: DapCapabilities;
}

export interface DapAttachDefaults extends Record<string, unknown> {
	/** When true, the adapter is already attached and needs no DAP attach request. */
	skipAttachRequest?: boolean;
}

export interface DapAdapterConfig {
	command: string;
	args?: string[];
	languages?: string[];
	fileTypes?: string[];
	rootMarkers?: string[];
	launchDefaults?: Record<string, unknown>;
	attachDefaults?: DapAttachDefaults;
	/** "stdio" (default): communicate via stdin/stdout pipes.
	 *  "socket": adapter-specific socket launch (currently Delve).
	 *  "tcp": spawn a DAP server with `${port}` substituted in `args`, then connect to it. */
	connectMode?: "stdio" | "socket" | "tcp";
	/** When true, the adapter accepts a directory as the launch `program`
	 *  (e.g. dlv treats it as a Go package path). When false/undefined, the
	 *  debug tool rejects directory programs upfront. */
	acceptsDirectoryProgram?: boolean;
}

export interface DapResolvedAdapter {
	name: string;
	command: string;
	args: string[];
	resolvedCommand: string;
	languages: string[];
	fileTypes: string[];
	rootMarkers: string[];
	launchDefaults: Record<string, unknown>;
	attachDefaults: DapAttachDefaults;
	connectMode: "stdio" | "socket" | "tcp";
	acceptsDirectoryProgram: boolean;
}

export interface DapBreakpointRecord {
	id?: number;
	verified: boolean;
	line: number;
	condition?: string;
	message?: string;
}

export interface DapInstructionBreakpointRecord {
	id?: number;
	verified: boolean;
	instructionReference: string;
	offset?: number;
	condition?: string;
	hitCondition?: string;
	message?: string;
}

export interface DapDataBreakpointRecord {
	id?: number;
	verified: boolean;
	dataId: string;
	accessType?: "read" | "write" | "readWrite";
	condition?: string;
	hitCondition?: string;
	message?: string;
}

export interface DapFunctionBreakpointRecord {
	id?: number;
	verified: boolean;
	name: string;
	condition?: string;
	message?: string;
}

export interface DapStopLocation {
	threadId?: number;
	frameId?: number;
	reason?: string;
	description?: string;
	text?: string;
	frameName?: string;
	instructionPointerReference?: string;
	source?: DapSource;
	line?: number;
	column?: number;
}

export interface DapSessionSummary {
	id: string;
	adapter: string;
	cwd: string;
	program?: string;
	status: DapSessionStatus;
	launchedAt: string;
	lastUsedAt: string;
	threadId?: number;
	frameId?: number;
	stopReason?: string;
	stopDescription?: string;
	frameName?: string;
	instructionPointerReference?: string;
	source?: DapSource;
	line?: number;
	column?: number;
	breakpointFiles: number;
	breakpointCount: number;
	functionBreakpointCount: number;
	outputBytes: number;
	outputTruncated: boolean;
	exitCode?: number;
	needsConfigurationDone: boolean;
	parentSessionId?: string;
	childSessionIds?: string[];
}

export interface DapContinueOutcome {
	snapshot: DapSessionSummary;
	state: "running" | "stopped" | "terminated";
	timedOut: boolean;
}

export interface DapLaunchSessionOptions {
	adapter: DapResolvedAdapter;
	program: string;
	args?: string[];
	cwd: string;
	/** Per-launch overrides merged over `adapter.launchDefaults`. Used to
	 *  inject adapter-specific values that depend on the resolved program
	 *  (e.g. dlv's `mode` switches between `debug` and `exec` based on
	 *  whether `program` is a Go package path or a compiled binary). */
	extraLaunchArguments?: Record<string, unknown>;
}

export interface DapAttachSessionOptions {
	adapter: DapResolvedAdapter;
	cwd: string;
	pid?: number;
	port?: number;
	host?: string;
}
