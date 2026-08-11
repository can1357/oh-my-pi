import type {
	MCPNormalizedServerCapabilities,
	MCPServerCapabilities,
	MCPServerConnection,
	MCPTransport,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";

/**
 * Creates a queued mock transport. Error queue entries reject the matching
 * request, allowing negotiation tests to model JSON-RPC protocol failures.
 */
export function createMockTransport(
	responses: Map<string, unknown[]>,
	onRequest?: (method: string, params: Record<string, unknown> | undefined) => void,
	onNotify?: (method: string, params: Record<string, unknown> | undefined) => void,
): MCPTransport {
	const callCounts = new Map<string, number>();
	return {
		connected: true,
		async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
			onRequest?.(method, params);
			const count = callCounts.get(method) ?? 0;
			callCounts.set(method, count + 1);
			const queue = responses.get(method);
			if (!queue || count >= queue.length) {
				throw new Error(`No mock response for ${method} call #${count}`);
			}
			const response = queue[count];
			if (response instanceof Error) throw response;
			return response as T;
		},
		async notify(method: string, params?: Record<string, unknown>): Promise<void> {
			onNotify?.(method, params);
		},
		async close() {},
	};
}

export function createMockConnection(
	capabilities: MCPServerCapabilities,
	transport: MCPTransport,
): MCPServerConnection {
	return {
		name: "test-server",
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities,
		protocol: {
			era: "legacy",
			version: "2025-03-26",
			capabilities,
		},
	};
}

export function createModernMockConnection(
	capabilities: MCPNormalizedServerCapabilities,
	transport: MCPTransport,
): MCPServerConnection {
	return {
		name: "test-modern-server",
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name: "test-modern", version: "2.0" },
		capabilities,
		protocol: {
			era: "modern",
			version: "2026-07-28",
			supportedVersions: ["2026-07-28"],
			clientCapabilities: {},
			capabilities,
		},
	};
}
