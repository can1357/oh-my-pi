import type { A2aIncomingRequest } from "./rpc";

/** Criteria for atomically claiming one request addressed to a local agent. */
export interface IncomingRequestMatch {
	to: string;
	from?: string;
	messageId?: string;
}

export interface IncomingRequestsApi {
	note(request: A2aIncomingRequest): Promise<void>;
	consume(match: IncomingRequestMatch): Promise<A2aIncomingRequest | undefined>;
	list(to?: string): Promise<A2aIncomingRequest[]>;
}

/** Main-owned ledger; worker threads install a proxy to the same ledger. */
export class IncomingRequests implements IncomingRequestsApi {
	static #global: IncomingRequestsApi | undefined;

	static global(): IncomingRequestsApi {
		if (!IncomingRequests.#global) IncomingRequests.#global = new IncomingRequests();
		return IncomingRequests.#global;
	}

	static installGlobal(api: IncomingRequestsApi): void {
		IncomingRequests.#global = api;
	}

	static resetGlobalForTests(): void {
		IncomingRequests.#global = undefined;
	}

	readonly #requests: A2aIncomingRequest[] = [];

	async note(request: A2aIncomingRequest): Promise<void> {
		this.#requests.push(request);
	}

	async consume(match: IncomingRequestMatch): Promise<A2aIncomingRequest | undefined> {
		const index = this.#requests.findIndex(
			request =>
				request.to === match.to &&
				(match.from === undefined || request.from === match.from) &&
				(match.messageId === undefined || request.messageId === match.messageId),
		);
		if (index < 0) return undefined;
		return this.#requests.splice(index, 1)[0];
	}

	async list(to?: string): Promise<A2aIncomingRequest[]> {
		return to === undefined ? [...this.#requests] : this.#requests.filter(request => request.to === to);
	}
}
