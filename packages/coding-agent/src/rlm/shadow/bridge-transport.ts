/**
 * Transport registry for the resident z0int bridge.
 *
 * The OMP `z0int-bridge` extension owns the Python child process and registers
 * itself here. RLM shadow must not spawn its own Python process.
 */
export type Z0intBridgeDecisionRequest = {
	op: "decision";
	trace_id?: string;
	payload: {
		backend: string;
		capability_id?: string;
		request: Record<string, unknown>;
	};
	timeoutMs?: number;
};

export type Z0intBridgeWarmRequest = {
	op: "decision_warm";
	payload: { backend: string };
	timeoutMs?: number;
};

export type Z0intBridgeResponse = Record<string, unknown>;

export interface Z0intBridgeTransport {
	readonly kind: "z0int-bridge";
	request(body: Record<string, unknown>, timeoutMs?: number): Promise<Z0intBridgeResponse>;
	/** Optional fire-and-forget warm. */
	warm?(backend: string): Promise<Z0intBridgeResponse>;
	generation?: number;
	buildId?: string;
	instanceId?: string;
}

declare global {
	// eslint-disable-next-line no-var
	var __omp_z0int_bridge_transport__: Z0intBridgeTransport | undefined;
}

let injected: Z0intBridgeTransport | undefined;

export function registerZ0intBridgeTransport(transport: Z0intBridgeTransport | null | undefined): void {
	injected = transport ?? undefined;
	(globalThis as { __omp_z0int_bridge_transport__?: Z0intBridgeTransport }).__omp_z0int_bridge_transport__ =
		transport ?? undefined;
}

export function getZ0intBridgeTransport(): Z0intBridgeTransport | undefined {
	return (
		injected ??
		(globalThis as { __omp_z0int_bridge_transport__?: Z0intBridgeTransport }).__omp_z0int_bridge_transport__
	);
}
