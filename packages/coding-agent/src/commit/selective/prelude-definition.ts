import { type } from "@oh-my-pi/omptype";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import commitDocumentation from "../../prompts/tools/commit.md" with { type: "text" };
import commitGuidance from "../../prompts/tools/commit-guidance.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { ToolSession } from "../../tools";
import { resolveToCwd } from "../../tools/path-utils";
import { cfgCommitEnabled } from "../../tools/settings";
import { commitSelection } from "./apply";
import { createDraft, type Draft, type ScopeSpec } from "./draft";
import { ChangeJournal } from "./journal";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import commitJavascript from "./prelude.js" with { type: "text" };
import commitPython from "./prelude.py" with { type: "text" };

/** Drafts kept per session; older ones expire. */
const MAX_DRAFTS = 8;

const paramsSchema = type({ action: "'draft'", "agents?": "string | string[]", "repo?": "string > 0", "+": "reject" })
	.or({ action: "'show'", draft: "string > 0", "path?": "string > 0", "+": "reject" })
	.or({
		action: "'take' | 'drop'",
		draft: "string > 0",
		"path?": "string > 0",
		"units?": "string[]",
		"grep?": "string > 0",
		"+": "reject",
	})
	.or({ action: "'only'", draft: "string > 0", globs: "string[]", "+": "reject" })
	.or({ action: "'diff'", draft: "string > 0", "+": "reject" })
	.or({
		action: "'commit'",
		draft: "string > 0",
		subject: "string > 0",
		"body?": "string | string[]",
		"fixes?": "(number | string)[]",
		"amend?": "boolean",
		"noVerify?": "boolean",
		"+": "reject",
	});

type CommitParams = typeof paramsSchema.infer;

/** Inputs shared by the eval prelude and `/commit` to draft for one session's agent. */
export interface DraftContext {
	cwd: string;
	/** Session artifacts directory holding the change journal; `null` when the session keeps none. */
	artifactsDir: string | null;
	/** Agent drafting (root of the default scope). */
	agent: string;
	signal?: AbortSignal;
}

/** Draft the repository's changes for `context.agent` (see {@link createDraft}). */
export function draftFor(context: DraftContext, scope?: ScopeSpec): Promise<Draft> {
	const registry = AgentRegistry.global();
	return createDraft({
		cwd: context.cwd,
		journal: context.artifactsDir ? ChangeJournal.at(context.artifactsDir) : null,
		caller: context.agent,
		agents: scope,
		isRunning: id => {
			const ref = registry.get(id);
			return ref !== undefined && registry.isRunning(ref);
		},
		signal: context.signal,
	});
}

/** Status-tree line for a completed call: `commit.draft()`, `commit.take(CHANGELOG.md)`. */
function describeCall(parameters: unknown): string | undefined {
	const parsed = paramsSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "draft":
			return `commit.draft(${[parsed.agents, parsed.repo && `repo=${parsed.repo}`].flat().filter(Boolean).join(", ")})`;
		case "take":
		case "drop":
			return `commit.${parsed.action}(${[parsed.path, ...(parsed.units ?? []), parsed.grep && `/${parsed.grep}/`].filter(Boolean).join(" ")})`;
		case "only":
			return `commit.only(${parsed.globs.join(", ")})`;
		case "commit":
			return `commit.commit(${JSON.stringify(parsed.subject)})`;
		default:
			return `commit.${parsed.action}()`;
	}
}

/**
 * Create the `commit` eval prelude: draft the session agent tree's changes from its change
 * journal, adjust the selection, and commit it without touching other agents' work.
 */
export function createCommitPrelude(session: ToolSession): EvalPreludeDefinition {
	const drafts = new Map<string, { draft: Draft; scope: ScopeSpec }>();
	const remember = (draft: Draft, scope: ScopeSpec) => {
		drafts.set(draft.id, { draft, scope });
		for (const id of drafts.keys()) {
			if (drafts.size <= MAX_DRAFTS) break;
			drafts.delete(id);
		}
	};
	/** Draft context in `cwd`: the session cwd unless a call targets another repository. */
	const context = (signal?: AbortSignal, cwd = session.cwd): DraftContext => ({
		cwd,
		artifactsDir: session.getArtifactsDir?.() ?? null,
		agent: session.getAgentId?.() ?? MAIN_AGENT_ID,
		signal,
	});
	const lookup = (id: string) => {
		const entry = drafts.get(id);
		if (!entry) throw new ToolError(`Draft ${id} expired or was committed; call commit.draft() again.`);
		return entry;
	};

	const describe = (draft: Draft) => ({ id: draft.id, head: draft.head, scope: [...draft.scope] });
	const invoke = async (params: CommitParams, signal?: AbortSignal) => {
		if (params.action === "draft") {
			const cwd = params.repo === undefined ? session.cwd : resolveToCwd(params.repo, session.cwd);
			const draft = await draftFor(context(signal, cwd), params.agents);
			remember(draft, params.agents);
			return { text: draft.summary(), details: describe(draft) };
		}
		const { draft, scope } = lookup(params.draft);
		switch (params.action) {
			case "show":
				return { text: draft.show(params.path), details: undefined };
			case "diff":
				return { text: draft.diff(), details: undefined };
			case "only":
				return { text: `${draft.only(params.globs)}\n${draft.summary()}`, details: undefined };
			case "take":
			case "drop": {
				const target = { path: params.path, units: params.units, grep: params.grep };
				const message = params.action === "take" ? draft.take(target) : draft.drop(target);
				return { text: `${message}\n${draft.summary()}`, details: undefined };
			}
			case "commit": {
				const { agent, artifactsDir } = context(signal);
				const outcome = await commitSelection(
					draft,
					{
						subject: params.subject,
						body: params.body,
						fixes: params.fixes,
						amend: params.amend,
						noVerify: params.noVerify,
					},
					{
						journal: artifactsDir ? ChangeJournal.at(artifactsDir) : null,
						agent: { agent, parent: AgentRegistry.global().get(agent)?.parentId },
						signal,
					},
				);
				drafts.delete(draft.id);
				const remaining = await draftFor(context(signal, draft.root), scope);
				remember(remaining, scope);
				const lines = [
					`[${draft.branch ?? "HEAD"} ${outcome.sha.slice(0, 10)}] ${outcome.subject}`,
					`${outcome.paths.length} path(s): ${outcome.paths.join(", ")}`,
				];
				if (outcome.parent && outcome.parent !== draft.head) {
					lines.push(`HEAD had moved to ${outcome.parent.slice(0, 10)}; the selection applied cleanly on top.`);
				}
				lines.push(...outcome.indexNotes, "", "Remaining:", remaining.summary());
				return { text: lines.join("\n"), details: { ...outcome, remaining: describe(remaining) } };
			}
		}
	};

	return {
		name: "commit",
		documentation: commitDocumentation,
		guidance: commitGuidance,
		javascript: commitJavascript,
		python: commitPython,
		exports: ["commit"],
		enabled: () => cfgCommitEnabled.get(session.settings) === true,
		approval: parameters => {
			const parsed = paramsSchema(parameters);
			return parsed instanceof type.errors || parsed.action === "commit" ? "exec" : "read";
		},
		invoke: async (parameters, invocation) => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors) throw new ToolError(`commit received invalid arguments: ${parsed.summary}`);
			try {
				const { text, details } = await invoke(parsed, invocation.signal);
				return { content: [{ type: "text", text }], details };
			} catch (error) {
				if (error instanceof ToolError) throw error;
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
		},
		status: describeCall,
	};
}
