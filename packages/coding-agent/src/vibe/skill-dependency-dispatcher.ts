import type { DelegatedSkillDependency, SkillDispatchResult } from "./delegated-skill-boundary";

export type SkillDependencyDispatchAdapter = {
	enabled: () => boolean;
	knownSkill: (skill: string) => boolean;
	buildMessage: (skill: string, args: string) => Promise<unknown>;
	send: (message: unknown, correlationId: string) => Promise<boolean>;
	subscribe: (listener: (event: { type: string; level?: string; message?: string }) => void) => () => void;
	timeoutMs?: number;
};

type DispatchAdapter = SkillDependencyDispatchAdapter;
export function createSkillDependencyDispatcher(adapter: DispatchAdapter) {
	return async (request: DelegatedSkillDependency, ownerSessionId: string): Promise<SkillDispatchResult> => {
		const skill = request.skill;
		if (!adapter.enabled())
			return { type: "skill-dispatch-result/v1", skill, status: "failed", evidence: "skill_commands_disabled" };
		if (!adapter.knownSkill(skill) || request.args.length > 2048)
			return {
				type: "skill-dispatch-result/v1",
				skill,
				status: "failed",
				evidence: "unregistered_or_invalid_skill",
			};
		const correlationId = `${ownerSessionId}:${skill}:${request.args}`;
		const completion = Promise.withResolvers<{ status: "success" | "failed"; evidence: string }>();
		const unsubscribe = adapter.subscribe(event => {
			if (event.type === "agent_end")
				completion.resolve({ status: "success", evidence: `parent_agent_end:${correlationId}` });
			if (event.type === "notice" && event.level === "error")
				completion.resolve({ status: "failed", evidence: event.message ?? "parent_dispatch_error" });
		});
		const timer = setTimeout(
			() => completion.resolve({ status: "failed", evidence: "parent_dispatch_timeout" }),
			adapter.timeoutMs ?? 120_000,
		);
		try {
			const message = await adapter.buildMessage(skill, request.args);
			if (!(await adapter.send(message, correlationId)))
				return {
					type: "skill-dispatch-result/v1",
					skill,
					status: "failed",
					evidence: "parent_turn_not_started",
					correlationId,
				};
			const outcome = await completion.promise;
			return {
				type: "skill-dispatch-result/v1",
				skill,
				status: outcome.status,
				evidence: outcome.evidence,
				correlationId,
			};
		} finally {
			clearTimeout(timer);
			unsubscribe();
		}
	};
}
