import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { sumSubagentTreeCost } from "../src/modes/agent-hub-runtime";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const children = 8;
const turns = Number(process.argv[2] ?? 2_000);
const updates = 500;
const root = path.resolve("benchmark-sessions", "root.jsonl");
const authStorage = await AuthStorage.create(":memory:");
const sessions: AgentSession[] = [];
let statsReads = 0;

function assistant(model: Model, turn: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `Reviewed file ${turn}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
		stopReason: "stop",
		timestamp: turn,
	};
}

try {
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
	if (!model) throw new Error("Expected a bundled model");
	const registry = new AgentRegistry();
	const tails: AssistantMessage[] = [];
	for (let child = 0; child < children; child++) {
		const manager = SessionManager.inMemory();
		for (let turn = 0; turn < turns; turn++) {
			manager.appendMessage({ role: "user", content: `Review ${turn}`, timestamp: turn });
			manager.appendMessage(assistant(model, turn));
		}
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const tail = assistant(model, turns);
		tail.usage.cost.total = 0;
		tail.usage.cost.output = 0;
		session.agent.appendMessage(tail);
		tails.push(tail);
		sessions.push(session);
		const getSessionStats = session.getSessionStats.bind(session);
		session.getSessionStats = () => {
			statsReads++;
			return getSessionStats();
		};
		registry.register({
			id: `Worker${child}`,
			displayName: `Worker ${child}`,
			kind: "sub",
			parentId: "Main",
			session,
			sessionFile: path.resolve("benchmark-sessions", "root", `Worker${child}.jsonl`),
			status: "running",
		});
	}
	const args = {
		refs: registry.list(),
		observers: new SessionObserverRegistry(),
		rootSessionFile: root,
		sessionCosts: new WeakMap(),
	};
	const expectedCost = children * turns * 0.001;
	for (let i = 0; i < 20; i++) sumSubagentTreeCost(args);
	statsReads = 0;
	let checksum = 0;
	const start = performance.now();
	for (let i = 0; i < updates; i++) {
		for (const tail of tails) tail.usage.output++;
		const cost = sumSubagentTreeCost(args);
		if (Math.abs(cost - expectedCost) > 1e-8) throw new Error(`Cost changed: ${cost} != ${expectedCost}`);
		checksum += cost;
	}
	const elapsedMs = performance.now() - start;
	console.log(
		JSON.stringify({ children, turns, updates, elapsedMs, msPerUpdate: elapsedMs / updates, statsReads, checksum }),
	);
} finally {
	await Promise.all(sessions.map(session => session.dispose()));
	authStorage.close();
}
