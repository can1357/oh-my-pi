import { type } from "@oh-my-pi/omptype";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { EvalPreludeDefinition } from "../eval/preludes";
import archiveDocumentation from "../prompts/tools/archive.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { cfgArchiveEnabled } from "../tools/settings";
import {
	type ArchiveView,
	archiveProjects,
	archivePrompts,
	archiveRecaps,
	archiveSession,
	archiveSessions,
} from "./archive";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import archiveDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import archiveJavascript from "./prelude.js" with { type: "text" };
import archivePython from "./prelude.py" with { type: "text" };

/** Listing size when a call omits `limit`. */
const DEFAULT_LIMIT = 20;

const limit = "1 <= number.integer <= 500";
const project = "string > 0";

const paramsSchema = type({ action: "'projects'", "limit?": limit, "+": "reject" })
	.or({ action: "'sessions' | 'recaps'", "project?": project, "limit?": limit, "+": "reject" })
	.or({ action: "'session'", id: "string > 0", "limit?": limit, "+": "reject" })
	.or({ action: "'prompts'", "query?": "string > 0", "project?": project, "limit?": limit, "+": "reject" });

type ArchiveParams = typeof paramsSchema.infer;

/**
 * Absolute project directory for a `project` argument; `undefined` spans every
 * project. Omitted means the session's own working directory, `"*"` every
 * project, anything else a path (`~` expanded, relative to the session cwd).
 */
function resolveProject(project: string | undefined, cwd: string): string | undefined {
	if (project === "*") return undefined;
	return project === undefined ? cwd : resolveToCwd(project, cwd);
}

async function archiveView(params: ArchiveParams, cwd: string): Promise<ArchiveView<unknown>> {
	const count = params.limit ?? DEFAULT_LIMIT;
	switch (params.action) {
		case "projects":
			return archiveProjects(count);
		case "sessions":
			return archiveSessions(resolveProject(params.project, cwd), count);
		case "session":
			return archiveSession(params.id.endsWith(".jsonl") ? resolveToCwd(params.id, cwd) : params.id, count);
		case "prompts":
			return archivePrompts(params.query, resolveProject(params.project, cwd), count);
		case "recaps":
			return archiveRecaps(resolveProject(params.project, cwd), count);
	}
}

/** Status-tree line for a completed archive call: `archive.search("retry")`, `archive.sessions(*)`. */
function describeArchiveCall(parameters: unknown): string | undefined {
	const parsed = paramsSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "projects":
			return "archive.projects()";
		case "session":
			return `archive.session(${parsed.id})`;
		case "prompts":
			if (parsed.query) return `archive.search(${JSON.stringify(parsed.query)})`;
			return `archive.prompts(${parsed.project ? shortenPath(parsed.project) : ""})`;
		case "sessions":
		case "recaps":
			return `archive.${parsed.action}(${parsed.project ? shortenPath(parsed.project) : ""})`;
	}
}

/** Create the read-only archive prelude: prompt history, recent projects, past sessions, and recaps. */
export function createArchivePrelude(session: ToolSession): EvalPreludeDefinition {
	return {
		name: "archive",
		documentation: archiveDocumentation,
		javascript: archiveJavascript,
		python: archivePython,
		exports: ["archive"],
		codeModeDeclarations: archiveDeclarations,
		approval: "read",
		enabled: () => cfgArchiveEnabled.get(session.settings) === true,
		invoke: async parameters => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors)
				throw new ToolError(`archive received invalid arguments: ${parsed.summary}`);
			const view = await archiveView(parsed, session.cwd);
			return { content: [{ type: "text", text: view.text }], details: view.records };
		},
		status: describeArchiveCall,
	};
}
