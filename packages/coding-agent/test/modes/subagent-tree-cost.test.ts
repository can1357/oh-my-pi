import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { sumSubagentTreeCost } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import type { AgentMetricsSummary, AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";

const root = path.resolve("sessions", "root.jsonl");
const artifacts = path.resolve("sessions", "root");

function ref(id: string, overrides: Partial<AgentRef> & { cost?: number } = {}): AgentRef {
	const { cost, ...rest } = overrides;
	const metrics: AgentMetricsSummary | undefined =
		cost === undefined ? undefined : { tokens: 1, requests: 1, tools: 0, cost, durationMs: 0 };
	return {
		id,
		displayName: id,
		kind: "sub",
		status: "parked",
		session: null,
		sessionFile: path.join(artifacts, `${id}.jsonl`),
		createdAt: 0,
		lastActivity: 0,
		history: metrics ? { metrics } : undefined,
		...rest,
	};
}

describe("sumSubagentTreeCost", () => {
	it("sums the root's subagent tree and nothing outside it", () => {
		const observers = new SessionObserverRegistry();
		const cost = sumSubagentTreeCost({
			refs: [
				ref("Main", { kind: "main", sessionFile: root, cost: 10 }),
				ref("A", { cost: 0.1 }),
				// Grandchild transcripts live in the child's artifacts dir.
				ref("A.B", { parentId: "A", sessionFile: path.join(artifacts, "A", "A.B.jsonl"), cost: 0.02 }),
				// Subagent advisors are part of the tree; the main advisor is billed separately.
				ref("A/advisor", {
					kind: "advisor",
					parentId: "A",
					sessionFile: path.join(artifacts, "A", "__advisor.jsonl"),
					cost: 0.003,
				}),
				ref("Main/advisor", {
					kind: "advisor",
					parentId: "Main",
					sessionFile: path.join(artifacts, "__advisor.jsonl"),
					cost: 5,
				}),
				// A previous session's agent still in the process-global registry.
				ref("Old", { sessionFile: path.resolve("sessions", "old", "Old.jsonl"), cost: 7 }),
				// File-less and not observed by this session.
				ref("Stray", { sessionFile: null, cost: 9 }),
			],
			observers,
			rootSessionFile: root,
			sessionMetrics: new WeakMap(),
		});
		expect(cost).toBeCloseTo(0.123);
	});

	it("prefers live observer progress over persisted history", () => {
		const observers = new SessionObserverRegistry();
		const bus = new EventTarget();
		observers.subscribeToEventBus(
			{
				on: (channel, listener) => {
					const handler = (event: Event) => listener((event as CustomEvent).detail);
					bus.addEventListener(channel, handler);
					return () => bus.removeEventListener(channel, handler);
				},
			},
			{ on: () => () => {} },
		);
		bus.dispatchEvent(
			new CustomEvent("task:subagent:progress", {
				detail: {
					index: 0,
					agent: "task",
					agentSource: "bundled",
					task: "t",
					progress: { id: "A", tokens: 5, requests: 2, toolCount: 1, cost: 0.25, durationMs: 100 },
				},
			}),
		);
		const cost = sumSubagentTreeCost({
			refs: [ref("A", { status: "running", cost: 0.1 })],
			observers,
			rootSessionFile: root,
			sessionMetrics: new WeakMap(),
		});
		expect(cost).toBeCloseTo(0.25);
	});
});
