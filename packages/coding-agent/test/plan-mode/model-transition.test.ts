import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ResolvedModelRoleValue } from "../../src/config/model-resolver";
import { resolvePlanModelTransition } from "../../src/plan-mode/model-transition";
import { AUTO_THINKING } from "../../src/thinking";

/**
 * Plan-mode model transition policy (issue #5657). The active model in plan
 * mode IS the plan-role model, so reassigning that role mid-planning must move
 * the session onto the new model — or defer the switch when a turn is streaming.
 */
const model = (provider: string, id: string): Model => ({ provider, id }) as unknown as Model;

const resolved = (
	m: Model | undefined,
	thinking?: ResolvedModelRoleValue["thinkingLevel"],
): ResolvedModelRoleValue => ({
	model: m,
	thinkingLevel: thinking,
	explicitThinkingLevel: thinking !== undefined,
	warning: undefined,
});

describe("resolvePlanModelTransition", () => {
	it("switches to the resolved plan model when it differs from the active one", () => {
		const plan = model("anthropic", "opus");
		const transition = resolvePlanModelTransition(model("openai", "gpt"), resolved(plan), false);
		expect(transition).toEqual({ kind: "apply", model: plan, thinkingLevel: undefined, deferred: false });
	});

	it("defers the switch while the session is streaming", () => {
		const plan = model("anthropic", "opus");
		const transition = resolvePlanModelTransition(model("openai", "gpt"), resolved(plan), true);
		expect(transition).toEqual({ kind: "apply", model: plan, thinkingLevel: undefined, deferred: true });
	});

	it("carries the plan role's explicit thinking level into the switch", () => {
		const plan = model("anthropic", "opus");
		const transition = resolvePlanModelTransition(model("openai", "gpt"), resolved(plan, ThinkingLevel.High), false);
		expect(transition).toEqual({ kind: "apply", model: plan, thinkingLevel: ThinkingLevel.High, deferred: false });
	});

	it("only adjusts thinking when the model is unchanged but the level is explicit", () => {
		const plan = model("anthropic", "opus");
		const transition = resolvePlanModelTransition(plan, resolved(model("anthropic", "opus"), AUTO_THINKING), false);
		expect(transition).toEqual({ kind: "thinking", thinkingLevel: AUTO_THINKING });
	});

	it("is a no-op when the model matches and no explicit thinking level is set", () => {
		const plan = model("anthropic", "opus");
		const transition = resolvePlanModelTransition(plan, resolved(model("anthropic", "opus")), false);
		expect(transition).toEqual({ kind: "none" });
	});

	it("is a no-op when the plan role resolves to no model", () => {
		const transition = resolvePlanModelTransition(model("openai", "gpt"), resolved(undefined), false);
		expect(transition).toEqual({ kind: "none" });
	});
});
