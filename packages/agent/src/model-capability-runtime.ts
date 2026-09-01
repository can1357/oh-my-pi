import { Agent } from "./agent";
import type { AgentState } from "./types";
import { classifyTask } from "./task-router";
import { createModelCapabilityTelemetry, type ModelCapabilityTelemetry, type StrategyProfile } from "./model-capability";

const kPatched = Symbol.for("oh-my-pi-ultra.model-capability.patched");
const byAgent = new WeakMap<Agent, { telemetry: ModelCapabilityTelemetry; previousThinking: AgentState["thinkingLevel"]; autoThinking: boolean; unsubscribe: () => void }>();
interface CapabilityState extends AgentState { modelCapabilities?: ModelCapabilityTelemetry; }
function enabled(): boolean { return process.env.PI_MODEL_CAPABILITIES !== "0"; }
function taskFromInput(input: unknown): string | undefined {
	if (typeof input === "string") return input.trim() || undefined;
	if (!Array.isArray(input)) return undefined;
	const text = input.filter(item => item && typeof item === "object" && (item as { role?: string }).role === "user").map(item => {
		const content = (item as { content?: unknown }).content;
		if (typeof content === "string") return content;
		return Array.isArray(content) ? content.map(block => block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "").join(" ") : "";
	}).join(" ").trim();
	return text || undefined;
}
function strategyThinking(strategy: StrategyProfile): AgentState["thinkingLevel"] {
	return strategy.reasoningMode === "off" || strategy.reasoningMode === "default" ? undefined : strategy.reasoningMode;
}
function publish(agent: Agent, telemetry: ModelCapabilityTelemetry): void {
	(agent.state as CapabilityState).modelCapabilities = {
		...telemetry,
		profile: { ...telemetry.profile, reasoningLevels: [...telemetry.profile.reasoningLevels] },
		strategy: { ...telemetry.strategy, reasons: [...telemetry.strategy.reasons] },
		evidence: { ...telemetry.evidence },
	};
}
function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function capabilityAwarePrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = taskFromInput(args[0]);
		if (!task) return original.apply(this, args);
		const telemetry = createModelCapabilityTelemetry(this.state.model, classifyTask(task));
		const before = this.state.thinkingLevel;
		const desired = strategyThinking(telemetry.strategy);
		const autoThinking = before === undefined && desired !== undefined;
		const unsubscribe = this.subscribe(event => {
			if (event.type === "turn_end") {
				const results = event.toolResults as Array<{ isError?: boolean }>;
				if (results.some(result => result.isError === true)) telemetry.evidence.toolCallFailures += 1;
			}
		});
		byAgent.set(this, { telemetry, previousThinking: before, autoThinking, unsubscribe });
		publish(this, telemetry);
		if (autoThinking) this.setThinkingLevel(desired);
		try { return await original.apply(this, args); }
		finally {
			const runtime = byAgent.get(this);
			if (runtime) {
				publish(this, runtime.telemetry);
				runtime.unsubscribe();
				if (runtime.autoThinking) this.setThinkingLevel(runtime.previousThinking);
				byAgent.delete(this);
			}
		}
	};
}
patch();
export function getModelCapabilities(agent: Agent): ModelCapabilityTelemetry | undefined { return (agent.state as CapabilityState).modelCapabilities; }
export function getModelStrategy(agent: Agent): StrategyProfile | undefined { return getModelCapabilities(agent)?.strategy; }
export function shouldUseParallelTools(agent: Agent): boolean { return getModelStrategy(agent)?.allowParallelTools === true; }
export function effectiveVerificationDepth(agent: Agent): "standard" | "deep" | undefined { return getModelStrategy(agent)?.verificationDepth; }
export function currentCapabilityProfile(agent: Agent) { return getModelCapabilities(agent)?.profile; }
