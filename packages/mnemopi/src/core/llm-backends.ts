import type { FetchImpl } from "@oh-my-pi/pi-ai";

export interface CompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
	fetch?: FetchImpl;
}

export interface LlmBackend {
	name?: string;
	complete(prompt: string, opts?: CompleteOptions): string | null | Promise<string | null>;
}

let hostBackend: LlmBackend | null = null;

export function setHostLlmBackend(backend: LlmBackend | null | undefined): void {
	hostBackend = backend ?? null;
}

export function getHostLlmBackend(): LlmBackend | null {
	return hostBackend;
}

export function resetHostLlmBackendForTests(): void {
	hostBackend = null;
}

export async function callHostLlm(prompt: string, opts: CompleteOptions = {}): Promise<string | null> {
	const backend = getHostLlmBackend();
	if (backend === null) {
		return null;
	}

	try {
		const result = await backend.complete(prompt, opts);
		return typeof result === "string" ? result : null;
	} catch {
		return null;
	}
}

export class CallableLlmBackend implements LlmBackend {
	constructor(
		public name: string,
		private readonly fn: (prompt: string, opts?: CompleteOptions) => string | null | Promise<string | null>,
	) {}

	complete(prompt: string, opts?: CompleteOptions): string | null | Promise<string | null> {
		return this.fn(prompt, opts);
	}
}
