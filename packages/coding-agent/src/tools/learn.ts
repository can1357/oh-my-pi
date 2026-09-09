import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { localBackend } from "../memory-backend/local-backend";
import learnDescription from "../prompts/tools/learn.md" with { type: "text" };
import type { ToolSession } from ".";

const learnSchema = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"skill?": type({
		action: "'create' | 'update'",
		name: type("string").describe("kebab-case skill name"),
		description: type("string").describe("one-line description of when to use the skill"),
		body: type("string").describe("the SKILL.md body in markdown (no frontmatter)"),
	}).describe("also create or enhance a managed skill in the same call"),
});

export type LearnParams = typeof learnSchema.infer;

/**
 * Orchestrating "learn" tool: persists a lesson to long-term memory and,
 * given a `skill` payload, mints/enhances a managed skill via the shared
 * `writeManagedSkill` primitive. Gated behind `autolearn.enabled` plus a live
 * memory backend — `hindsight`/`mnemopi` (remote/SQLite) or `local` (the
 * file-based rollout backend, where lessons append to `learned.md`).
 */
export class LearnTool implements AgentTool<typeof learnSchema> {
	readonly name = "learn";
	readonly approval = (args: unknown) =>
		(args as Partial<LearnParams>).skill || this.session.settings.get("memory.backend") === "local"
			? "write"
			: "read";
	readonly label = "Learn";
	readonly description = learnDescription;
	readonly parameters = learnSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Capture a reusable lesson to memory (and optionally a managed skill)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LearnTool | null {
		if (!session.settings.get("autolearn.enabled")) return null;
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "local") return null;
		return new LearnTool(session);
	}

	async execute(_id: string, params: LearnParams): Promise<AgentToolResult> {
		// 1) Persist or queue the lesson to long-term memory (mirrors MemoryRetainTool).
		const backend = this.session.settings.get("memory.backend");
		let memoryMessage = "Lesson stored";
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}
			const id = state.rememberScoped(params.memory, {
				source: "coding-agent-learn",
				importance: 0.8,
				metadata: {
					session_id: state.sessionId,
					cwd: state.session.sessionManager.getCwd(),
					context: params.context ?? null,
					tool: "learn",
				},
				scope: "bank",
				extract: true,
				extractEntities: true,
				veracity: "tool",
				memoryType: "fact",
			});
			// rememberScoped returns undefined when the retain failed (closed DB /
			// disk error); mirror mnemopiBackend.save and fail loudly rather than
			// reporting (and minting a skill for) a lesson that was silently dropped.
			if (!id) {
				throw new Error("Mnemopi did not store the lesson (no memory id returned).");
			}
		} else if (backend === "local") {
			const result = await localBackend.save?.(
				{ agentDir: this.session.settings.getAgentDir(), cwd: this.session.settings.getCwd() },
				{ content: params.memory, context: params.context, source: "coding-agent-learn", importance: 0.8 },
			);
			if (!result || result.stored === 0) {
				throw new Error("Lesson was empty after sanitization; nothing stored.");
			}
		} else {
			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}
			state.enqueueRetain(params.memory, params.context);
			memoryMessage = "Lesson queued for retention";
		}

		// 2) Optionally mint/enhance a managed skill. A failure here is surfaced
		// as a partial outcome — the lesson is already stored or queued.
		if (params.skill) {
			// A managed skill resolves below any authored skill of the same name, so
			// minting one under a claimed name writes a file that never surfaces. The
			// lesson is already stored/queued; refuse the skill rather than report a
			// false "Created" (mirrors ManageSkillTool).
			let safeSkillName: string | undefined;
			try {
				safeSkillName = sanitizeSkillName(params.skill.name);
			} catch {
				safeSkillName = undefined;
			}
			if (params.skill.action === "create" && safeSkillName && isNameClaimedByAuthoredSkill(safeSkillName)) {
				return {
					content: [
						{
							type: "text",
							text: `${memoryMessage}. Did not create managed skill "${params.skill.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
						},
					],
					isError: true,
					details: { skill: null, shadowed: true },
				};
			}
			try {
				await writeManagedSkill(params.skill);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${memoryMessage}, but the managed skill could not be written: ${reason}`);
			}
			const verb = params.skill.action === "create" ? "Created" : "Updated";
			return {
				content: [{ type: "text", text: `${memoryMessage}. ${verb} managed skill "${params.skill.name}".` }],
				details: { skill: params.skill.name },
			};
		}

		return {
			content: [{ type: "text", text: `${memoryMessage}.` }],
			details: { skill: null },
		};
	}
}
