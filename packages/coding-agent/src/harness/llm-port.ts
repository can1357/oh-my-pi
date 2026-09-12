import type { HarnessSessionInterface, ToolDescriptor, ToolInvocationRequest, ToolInvocationResult } from "./types";

export interface LLMPortInterface {
	connect(session: HarnessSessionInterface): Promise<void> | void;
	disconnect(): Promise<void> | void;
	isConnected(): boolean;
	getSession(): HarnessSessionInterface | undefined;
	getAvailableTools(): Promise<readonly ToolDescriptor[]> | readonly ToolDescriptor[];
	dispatchToolCall(request: ToolInvocationRequest): Promise<ToolInvocationResult>;
	dispatchToolCalls(requests: readonly ToolInvocationRequest[]): Promise<readonly ToolInvocationResult[]>;
}

export class DefaultLocalLLMPort implements LLMPortInterface {
	#session: HarnessSessionInterface | null = null;

	constructor(session?: HarnessSessionInterface) {
		if (session) {
			this.#session = session;
		}
	}

	connect(session: HarnessSessionInterface): void {
		this.#session = session;
	}

	disconnect(): void {
		this.#session = null;
	}

	isConnected(): boolean {
		return this.#session !== null && !(this.#session.isDisposed?.() ?? false);
	}

	getSession(): HarnessSessionInterface | undefined {
		return this.#session ?? undefined;
	}

	getAvailableTools(): readonly ToolDescriptor[] {
		if (!this.#session) {
			throw new Error("DefaultLocalLLMPort is not connected to a harness session");
		}
		return this.#session.getTools();
	}

	async dispatchToolCall(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
		if (!this.#session) {
			throw new Error("DefaultLocalLLMPort is not connected to a harness session");
		}
		return this.#session.invokeTool(request);
	}

	async dispatchToolCalls(requests: readonly ToolInvocationRequest[]): Promise<readonly ToolInvocationResult[]> {
		return Promise.all(requests.map(req => this.dispatchToolCall(req)));
	}
}
