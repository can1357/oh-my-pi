import type { Tool } from "../../packages/ai/src/types.ts";
import probeToolBashDescription from "./probe-tool-bash-description.md" with { type: "text" };
import probeToolEditDescription from "./probe-tool-edit-description.md" with { type: "text" };
import probeToolGlobDescription from "./probe-tool-glob-description.md" with { type: "text" };
import probeToolGrepDescription from "./probe-tool-grep-description.md" with { type: "text" };
import probeToolReadDescription from "./probe-tool-read-description.md" with { type: "text" };
import probeToolTodoWriteDescription from "./probe-tool-todo-write-description.md" with { type: "text" };
import probeToolWebFetchDescription from "./probe-tool-web-fetch-description.md" with { type: "text" };
import probeToolWebSearchDescription from "./probe-tool-web-search-description.md" with { type: "text" };
import probeToolWriteDescription from "./probe-tool-write-description.md" with { type: "text" };

/** Standard six-tool omp set used by keep-model / pipeline probes. */
export function probeOmpTools(): Tool[] {
	return [
		{
			name: "bash",
			description: probeToolBashDescription.trim(),
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } as const,
		},
		{
			name: "read",
			description: probeToolReadDescription.trim(),
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as const,
		},
		{
			name: "write",
			description: probeToolWriteDescription.trim(),
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			} as const,
		},
		{
			name: "edit",
			description: probeToolEditDescription.trim(),
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
				required: ["path", "old", "new"],
			} as const,
		},
		{
			name: "grep",
			description: probeToolGrepDescription.trim(),
			parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } as const,
		},
		{
			name: "glob",
			description: probeToolGlobDescription.trim(),
			parameters: { type: "object", properties: { glob: { type: "string" } }, required: ["glob"] } as const,
		},
	];
}

/** Extended omp set with unmapped tools for field-9 allowlist probes. */
export function probeOmpToolsExtended(): Tool[] {
	return [
		...probeOmpTools(),
		{
			name: "todoWrite",
			description: probeToolTodoWriteDescription.trim(),
			parameters: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"] } as const,
		},
		{
			name: "webSearch",
			description: probeToolWebSearchDescription.trim(),
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as const,
		},
		{
			name: "webFetch",
			description: probeToolWebFetchDescription.trim(),
			parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } as const,
		},
	];
}

/** Minimal bash/read pair for automation wire probes. */
export function probeOmpToolsAutomation(): Tool[] {
	return probeOmpTools().filter(tool => tool.name === "bash" || tool.name === "read");
}
