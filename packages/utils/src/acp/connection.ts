import type {
	Agent,
	AuthenticateRequest,
	AuthenticateResponse,
	CloseSessionRequest,
	CloseSessionResponse,
	CompleteElicitationNotification,
	CreateElicitationRequest,
	CreateElicitationResponse,
	CreateTerminalRequest,
	ForkSessionRequest,
	ForkSessionResponse,
	InitializeRequest,
	InitializeResponse,
	ListSessionsRequest,
	ListSessionsResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	MaybePromise,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	ResumeSessionRequest,
	ResumeSessionResponse,
	SessionNotification,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
	SetSessionModeRequest,
	SetSessionModeResponse,
	TerminalActionResponse,
	TerminalOutputResponse,
	WaitForTerminalExitResponse,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "./protocol";
import type { Stream } from "./stream";
import { RequestError, RpcConnection } from "./transport";

/** Terminal creation response returned by a client. */
export interface CreateTerminalResponse {
	terminalId: string;
}
/** Client callbacks handled by a client-side connection. */
export interface Client {
	requestPermission(params: RequestPermissionRequest): MaybePromise<RequestPermissionResponse>;
	sessionUpdate(params: SessionNotification): MaybePromise<void>;
	readTextFile?(params: ReadTextFileRequest): MaybePromise<ReadTextFileResponse>;
	writeTextFile?(params: WriteTextFileRequest): MaybePromise<WriteTextFileResponse | void>;
	createTerminal?(params: CreateTerminalRequest): MaybePromise<CreateTerminalResponse>;
	terminalOutput?(params: { sessionId: string; terminalId: string }): MaybePromise<TerminalOutputResponse>;
	waitForTerminalExit?(params: { sessionId: string; terminalId: string }): MaybePromise<WaitForTerminalExitResponse>;
	killTerminal?(params: { sessionId: string; terminalId: string }): MaybePromise<TerminalActionResponse | void>;
	releaseTerminal?(params: { sessionId: string; terminalId: string }): MaybePromise<TerminalActionResponse | void>;
	unstable_createElicitation?(params: CreateElicitationRequest): MaybePromise<CreateElicitationResponse>;
	unstable_completeElicitation?(params: CompleteElicitationNotification): MaybePromise<void>;
	extMethod?(method: string, params: Record<string, unknown>): MaybePromise<Record<string, unknown>>;
	extNotification?(method: string, params: Record<string, unknown>): MaybePromise<void>;
}

/** Agent-side ACP connection. */
export class AgentSideConnection {
	#connection: RpcConnection;

	constructor(toAgent: (connection: AgentSideConnection) => Agent, stream: Stream) {
		this.#connection = new RpcConnection(stream, async (method, params, notification) => {
			if (!agent) throw RequestError.internalError(undefined, "Agent is not initialized");
			return dispatchAgent(agent, method, params, notification);
		});
		const agent = toAgent(this);
	}

	/** Signal aborted when the transport closes. */
	get signal(): AbortSignal {
		return this.#connection.signal;
	}
	/** Promise resolved when the transport closes. */
	get closed(): Promise<void> {
		return this.#connection.closed;
	}
	/** Sends a session update notification. */
	sessionUpdate(params: SessionNotification): Promise<void> {
		return this.#connection.notify("session/update", params);
	}
	/** Requests permission from the client. */
	requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return this.#connection.request("session/request_permission", params);
	}
	/** Reads a client-side text file. */
	readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		return this.#connection.request("fs/read_text_file", params);
	}
	/** Writes a client-side text file. */
	writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
		return this.#connection.request("fs/write_text_file", params);
	}
	/** Creates a client terminal and returns its control handle. */
	async createTerminal(params: CreateTerminalRequest): Promise<TerminalHandle> {
		const response = await this.#connection.request<CreateTerminalResponse>("terminal/create", params);
		return new TerminalHandle(response.terminalId, params.sessionId, this.#connection);
	}
	/** Creates an interactive elicitation on the client. */
	unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
		return this.#connection.request("elicitation/create", params);
	}
	/** Notifies a client that URL elicitation completed. */
	unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void> {
		return this.#connection.notify("elicitation/complete", params);
	}
	/** Sends a custom request. */
	request<Response = unknown, Params = unknown>(method: string, params?: Params): Promise<Response> {
		return this.#connection.request(method, params);
	}
	/** Sends a custom notification. */
	notify<Params = unknown>(method: string, params?: Params): Promise<void> {
		return this.#connection.notify(method, params);
	}
	/** Sends a legacy extension request. */
	extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.request(method, params);
	}
	/** Sends a legacy extension notification. */
	extNotification(method: string, params: Record<string, unknown>): Promise<void> {
		return this.notify(method, params);
	}
}

/** Handle for controlling a client-owned terminal. */
export class TerminalHandle {
	/** Client terminal identifier. */
	readonly id: string;
	#sessionId: string;
	#connection: RpcConnection;

	constructor(id: string, sessionId: string, connection: RpcConnection) {
		this.id = id;
		this.#sessionId = sessionId;
		this.#connection = connection;
	}
	/** Gets current terminal output. */
	currentOutput(): Promise<TerminalOutputResponse> {
		return this.#connection.request("terminal/output", { sessionId: this.#sessionId, terminalId: this.id });
	}
	/** Waits for terminal exit. */
	waitForExit(): Promise<WaitForTerminalExitResponse> {
		return this.#connection.request("terminal/wait_for_exit", { sessionId: this.#sessionId, terminalId: this.id });
	}
	/** Kills the terminal. */
	kill(): Promise<TerminalActionResponse> {
		return this.#connection.request("terminal/kill", { sessionId: this.#sessionId, terminalId: this.id });
	}
	/** Releases the terminal. */
	release(): Promise<TerminalActionResponse | void> {
		return this.#connection.request("terminal/release", { sessionId: this.#sessionId, terminalId: this.id });
	}
	/** Releases the terminal during async disposal. */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.release();
	}
}

/** Client-side ACP connection used to call an agent. */
export class ClientSideConnection {
	#connection: RpcConnection;

	constructor(toClient: (connection: ClientSideConnection) => Client, stream: Stream) {
		this.#connection = new RpcConnection(stream, async (method, params, notification) => {
			if (!client) throw RequestError.internalError(undefined, "Client is not initialized");
			return dispatchClient(client, method, params, notification);
		});
		const client = toClient(this);
	}
	/** Signal aborted when the transport closes. */
	get signal(): AbortSignal {
		return this.#connection.signal;
	}
	/** Promise resolved when the transport closes. */
	get closed(): Promise<void> {
		return this.#connection.closed;
	}
	/** Initializes protocol capabilities. */
	initialize(params: InitializeRequest): Promise<InitializeResponse> {
		return this.#connection.request("initialize", params);
	}
	/** Authenticates with an agent. */
	authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		return this.#connection.request("authenticate", params);
	}
	/** Creates a session. */
	newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		return this.#connection.request("session/new", params);
	}
	/** Loads a session. */
	loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		return this.#connection.request("session/load", params);
	}
	/** Lists sessions. */
	listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		return this.#connection.request("session/list", params);
	}
	/** Resumes a session. */
	resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		return this.#connection.request("session/resume", params);
	}
	/** Forks a session. */
	unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		return this.#connection.request("session/fork", params);
	}
	/** Closes a session. */
	closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		return this.#connection.request("session/close", params);
	}
	/** Sets a session mode. */
	setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		return this.#connection.request("session/set_mode", params);
	}
	/** Sets a session config option. */
	setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		return this.#connection.request("session/set_config_option", params);
	}
	/** Sends a prompt. */
	prompt(params: PromptRequest): Promise<PromptResponse> {
		return this.#connection.request("session/prompt", params);
	}
	/** Cancels an active prompt. */
	cancel(params: { sessionId: string }): Promise<void> {
		return this.#connection.notify("session/cancel", params);
	}
}

async function dispatchAgent(agent: Agent, method: string, params: unknown, notification: boolean): Promise<unknown> {
	switch (method) {
		case "initialize":
			return agent.initialize(params as InitializeRequest);
		case "authenticate":
			return invokeRequired(agent, agent.authenticate, method, params as AuthenticateRequest);
		case "session/new":
			return agent.newSession(params as NewSessionRequest);
		case "session/load":
			return invokeRequired(agent, agent.loadSession, method, params as LoadSessionRequest);
		case "session/list":
			return invokeRequired(agent, agent.listSessions, method, params as ListSessionsRequest);
		case "session/resume":
			return invokeRequired(agent, agent.resumeSession, method, params as ResumeSessionRequest);
		case "session/fork":
			return invokeRequired(agent, agent.unstable_forkSession, method, params as ForkSessionRequest);
		case "session/close":
			return invokeRequired(agent, agent.closeSession, method, params as CloseSessionRequest);
		case "session/set_mode":
			return invokeRequired(agent, agent.setSessionMode, method, params as SetSessionModeRequest);
		case "session/set_config_option":
			return invokeRequired(agent, agent.setSessionConfigOption, method, params as SetSessionConfigOptionRequest);
		case "session/prompt":
			return agent.prompt(params as PromptRequest);
		case "session/cancel":
			return agent.cancel(params as { sessionId: string });
		default:
			if (method === "$/cancel_request") return;
			if (notification && agent.extNotification)
				return agent.extNotification(method, params as Record<string, unknown>);
			if (!notification && agent.extMethod) return agent.extMethod(method, params as Record<string, unknown>);
			throw RequestError.methodNotFound(method);
	}
}

async function dispatchClient(
	client: Client,
	method: string,
	params: unknown,
	notification: boolean,
): Promise<unknown> {
	switch (method) {
		case "session/request_permission":
			return client.requestPermission(params as RequestPermissionRequest);
		case "session/update":
			return client.sessionUpdate(params as SessionNotification);
		case "fs/read_text_file":
			return invokeRequired(client, client.readTextFile, method, params as ReadTextFileRequest);
		case "fs/write_text_file":
			return invokeRequired(client, client.writeTextFile, method, params as WriteTextFileRequest);
		case "terminal/create":
			return invokeRequired(client, client.createTerminal, method, params as CreateTerminalRequest);
		case "terminal/output":
			return invokeRequired(
				client,
				client.terminalOutput,
				method,
				params as { sessionId: string; terminalId: string },
			);
		case "terminal/wait_for_exit":
			return invokeRequired(
				client,
				client.waitForTerminalExit,
				method,
				params as { sessionId: string; terminalId: string },
			);
		case "terminal/kill":
			return invokeRequired(
				client,
				client.killTerminal,
				method,
				params as { sessionId: string; terminalId: string },
			);
		case "terminal/release":
			return invokeRequired(
				client,
				client.releaseTerminal,
				method,
				params as { sessionId: string; terminalId: string },
			);
		case "elicitation/create":
			return invokeRequired(client, client.unstable_createElicitation, method, params as CreateElicitationRequest);
		case "elicitation/complete":
			return invokeRequired(
				client,
				client.unstable_completeElicitation,
				method,
				params as CompleteElicitationNotification,
			);
		default:
			if (notification && client.extNotification)
				return client.extNotification(method, params as Record<string, unknown>);
			if (!notification && client.extMethod) return client.extMethod(method, params as Record<string, unknown>);
			throw RequestError.methodNotFound(method);
	}
}

function invokeRequired<Params, Response>(
	receiver: Agent | Client,
	handler: ((params: Params) => MaybePromise<Response>) | undefined,
	method: string,
	params: Params,
): MaybePromise<Response> {
	if (!handler) throw RequestError.methodNotFound(method);
	return handler.call(receiver, params);
}
