import type { MCPServerCapabilities, MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";

export function createMockTransport(
	responses: Map<string, unknown[]>,
	onRequest?: (method: string, params: Record<string, unknown> | undefined) => void,
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
			return queue[count] as T;
		},
		async notify() {},
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
	};
}
