import { describe, expect, it } from "bun:test";
import type { McpToolOutput } from "@oh-my-pi/pi-ai/providers/antigravity-cli/mcp-bridge";
import {
	RELAY_CONTROL_TOOL,
	type RelayClock,
	resolveRelayConfig,
	ToolRelay,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/relay";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";

class Clock implements RelayClock {
	readonly timers = new Map<object, { ms: number; callback(): void }>();
	setTimeout(callback: () => void, ms: number): unknown {
		const token = {};
		this.timers.set(token, { ms, callback });
		return token;
	}
	clearTimeout(timer: unknown): void {
		this.timers.delete(timer as object);
	}
	fire(ms: number): void {
		for (const token of this.timers.keys()) {
			const timer = this.timers.get(token);
			if (!timer || timer.ms !== ms) continue;
			this.timers.delete(token);
			timer.callback();
		}
	}
}

const body: McpToolOutput = { content: [{ type: "text", text: "actual file body" }] };

function textOf(output: McpToolOutput): string {
	return output.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function relayed(thresholdMs = 20) {
	const clock = new Clock();
	const relay = new ToolRelay({ enabled: true, thresholdMs }, clock);
	const result = Promise.withResolvers<McpToolOutput>();
	relay.beginTurn();
	const parked = relay.park({ id: "call-1", name: "read", arguments: { path: "a.txt" } }, result.promise);
	return { clock, relay, result, parked };
}

describe("resolveRelayConfig", () => {
	it("stays off until an explicit positive window is set", () => {
		expect(resolveRelayConfig({})).toEqual({ enabled: false, thresholdMs: 0 });
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "  " })).toEqual({ enabled: false, thresholdMs: 0 });
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "0" })).toEqual({ enabled: false, thresholdMs: 0 });
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "-1" })).toEqual({ enabled: false, thresholdMs: 0 });
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "fast" })).toEqual({ enabled: false, thresholdMs: 0 });
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "120000" })).toEqual({ enabled: true, thresholdMs: 120_000 });
	});

	it("clamps an explicit window to the 5s..165s range", () => {
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "1" }).thresholdMs).toBe(5_000);
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "4999" }).thresholdMs).toBe(5_000);
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "165001" }).thresholdMs).toBe(165_000);
		expect(resolveRelayConfig({ OMP_ACP_TOOL_RELAY_MS: "999999999" }).thresholdMs).toBe(165_000);
	});
});

describe("ToolRelay", () => {
	it("returns a relay notice at the threshold instead of holding the MCP call", async () => {
		const { clock, relay, parked } = relayed();
		expect(clock.timers.size).toBe(1);
		clock.fire(20);
		const notice = await parked;
		expect(notice.isError).toBe(false);
		expect(textOf(notice)).toContain("Tool still running.");
		expect(textOf(notice)).toContain('Call omp_await_result with {"call_id":"call-1"}');
		expect(clock.timers.size).toBe(0);
		expect(relay.awaiting("call-1")).toBe(false);
	});

	it("hands the original result to the control call without running the tool again", async () => {
		const { clock, relay, result, parked } = relayed();
		clock.fire(20);
		await parked;
		const awaiting = relay.awaitResult("call-1");
		expect(relay.awaiting("call-1")).toBe(true);
		result.resolve(body);
		expect(await awaiting).toEqual(body);
		expect(await relay.awaitResult("call-1")).toEqual(body);
		expect(relay.awaiting("call-1")).toBe(false);
	});

	it("returns the result immediately when it lands before the control call", async () => {
		const { clock, relay, result, parked } = relayed();
		clock.fire(20);
		await parked;
		result.resolve(body);
		await Promise.resolve();
		expect(await relay.awaitResult("call-1")).toEqual(body);
	});

	it("repeats the notice when the control call also outlives its threshold", async () => {
		const { clock, relay, parked } = relayed();
		clock.fire(20);
		await parked;
		const awaiting = relay.awaitResult("call-1");
		clock.fire(20);
		const repeated = await awaiting;
		expect(textOf(repeated)).toContain('"call_id":"call-1"');
		expect(repeated.isError).toBe(false);
	});

	it("keeps a late result for the next turn and expires it after one more", async () => {
		const { clock, relay, result, parked } = relayed();
		clock.fire(20);
		await parked;
		relay.beginTurn();
		result.resolve(body);
		await Promise.resolve();
		expect(await relay.awaitResult("call-1")).toEqual(body);
		relay.beginTurn();
		const expired = await relay.awaitResult("call-1");
		expect(expired.isError).toBe(true);
		expect(textOf(expired)).toContain("Unknown or expired relay call id");
	});

	it("cancels an outstanding call when its turn is pruned", async () => {
		const { relay, result, parked } = relayed();
		const awaiting = relay.awaitResult("call-1");
		expect(relay.awaiting("call-1")).toBe(true);
		relay.beginTurn();
		relay.beginTurn();
		const cancelled = await awaiting;
		expect(cancelled.isError).toBe(true);
		expect(textOf(cancelled)).toContain("expired turn");
		result.resolve(body);
		await Promise.resolve();
		await parked;
		expect(textOf(await relay.awaitResult("call-1"))).toContain("Unknown or expired relay call id");
	});

	it("reports unknown ids and disables itself when relay is off", async () => {
		const clock = new Clock();
		const relay = new ToolRelay({ enabled: true, thresholdMs: 20 }, clock);
		relay.beginTurn();
		expect(textOf(await relay.awaitResult("missing"))).toContain("Unknown or expired relay call id");
		const off = new ToolRelay({ enabled: false, thresholdMs: 0 }, clock);
		off.beginTurn();
		const result = Promise.withResolvers<McpToolOutput>();
		const parked = off.park({ id: "call-2", name: "read", arguments: {} }, result.promise);
		expect(clock.timers.size).toBe(0);
		result.resolve(body);
		expect(await parked).toEqual(body);
		expect(textOf(await off.awaitResult("call-2"))).toContain("Tool relay is disabled");
	});

	it("answers an identical outstanding call with the same notice so it never runs twice", () => {
		const { relay, parked } = relayed();
		const duplicate = relay.duplicateNotice("read", { path: "a.txt" });
		expect(duplicate === undefined ? "" : textOf(duplicate)).toContain('"call_id":"call-1"');
		expect(relay.duplicateNotice("read", { path: "b.txt" })).toBeUndefined();
		expect(relay.duplicateNotice("write", { path: "a.txt" })).toBeUndefined();
		void parked;
	});

	it("fails every outstanding call and clears its timers on cancelAll", async () => {
		const { clock, relay, parked } = relayed();
		const awaiting = relay.awaitResult("call-1");
		relay.cancelAll("host stopped");
		expect(clock.timers.size).toBe(0);
		expect(textOf(await parked)).toContain("host stopped");
		expect(textOf(await awaiting)).toContain("host stopped");
		expect((await relay.awaitResult("call-1")).isError).toBe(true);
	});

	it("keeps one released call awaitable across cancelAll", async () => {
		const { clock, relay, result, parked } = relayed();
		clock.fire(20);
		await parked;
		const second = Promise.withResolvers<McpToolOutput>();
		relay.beginTurn();
		const other = relay.park({ id: "call-2", name: "read", arguments: { path: "b.txt" } }, second.promise);
		relay.cancelAll("host restarted", "call-1");
		expect(clock.timers.size).toBe(0);
		expect(textOf(await other)).toContain("host restarted");
		result.resolve(body);
		await Promise.resolve();
		expect(await relay.awaitResult("call-1")).toEqual(body);
	});

	it("detaches a waiting control call when its transport stops and keeps the result awaitable", async () => {
		const { clock, relay, result, parked } = relayed();
		clock.fire(20);
		await parked;
		const awaiting = relay.awaitResult("call-1");
		expect(relay.awaiting("call-1")).toBe(true);
		relay.detach("call-1");
		expect(relay.awaiting("call-1")).toBe(false);
		expect(clock.timers.size).toBe(0);
		expect(textOf(await awaiting)).toContain("transport stopped");
		result.resolve(body);
		await Promise.resolve();
		expect(await relay.awaitResult("call-1")).toEqual(body);
	});

	it("disarms the threshold for a call whose result is already in hand", async () => {
		const { clock, relay, result, parked } = relayed();
		relay.hold("call-1");
		expect(clock.timers.size).toBe(0);
		clock.fire(20);
		result.resolve(body);
		expect(await parked).toEqual(body);
	});

	it("advertises a control tool omp never projects", () => {
		expect(RELAY_CONTROL_TOOL.name).toBe("omp_await_result");
		expect(validateJsonSchemaValue(RELAY_CONTROL_TOOL.inputSchema, { call_id: "call-1" }).success).toBe(true);
		expect(validateJsonSchemaValue(RELAY_CONTROL_TOOL.inputSchema, { call_id: "" }).success).toBe(false);
		expect(validateJsonSchemaValue(RELAY_CONTROL_TOOL.inputSchema, {}).success).toBe(false);
	});
});
