import type { ToolInfo } from "../../../extensibility/extensions/types";
import type { LiveToolRecord, ToolRuntimeSource } from "./inspector-model";

/** Session methods the `/extensions` live-tool join actually uses. */
export interface LiveToolSessionLookup {
	getToolByName(name: string):
		| {
				name: string;
				label?: string;
				description?: string;
				parameters?: unknown;
				hidden?: boolean;
				loadMode?: "essential" | "discoverable";
		  }
		| undefined;
	getAllToolInfos(): ToolInfo[];
}

/** Convert an already-fetched ToolInfo plus the registered tool. */
export function liveToolRecordFromInfo(session: LiveToolSessionLookup, info: ToolInfo): LiveToolRecord | undefined {
	const tool = session.getToolByName(info.name);
	if (!tool) return undefined;
	const origin = info.sourceInfo.source;
	const originPath = info.sourceInfo.path;
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		loadMode: tool.loadMode,
		source:
			origin === "builtin" || origin === "mcp" || origin === "sdk" || origin === "extension" ? origin : undefined,
		sourcePath: originPath && !originPath.startsWith("<") ? originPath : undefined,
	};
}

/** One-name lookup. Obtains a fresh ToolInfo snapshot for that name. */
export function liveToolRecordFromSession(session: LiveToolSessionLookup, name: string): LiveToolRecord | undefined {
	const info = session.getAllToolInfos().find(entry => entry.name === name);
	return info ? liveToolRecordFromInfo(session, info) : undefined;
}

/** List every live tool. Calls `getAllToolInfos()` once. */
export function listLiveToolRecords(session: LiveToolSessionLookup): LiveToolRecord[] {
	const tools: LiveToolRecord[] = [];
	for (const info of session.getAllToolInfos()) {
		const live = liveToolRecordFromInfo(session, info);
		if (live) tools.push(live);
	}
	return tools;
}

/** One list snapshot for a dashboard/list/inspector render. Not a persistent cache. */
export function snapshotToolRuntimeSource(source: ToolRuntimeSource | undefined): ToolRuntimeSource | undefined {
	if (!source) return undefined;
	if (!source.listLiveTools) return source;
	const listed = source.listLiveTools();
	const byName = new Map(listed.map(entry => [entry.name, entry]));
	return {
		getLiveTool: name => byName.get(name),
		listLiveTools: () => listed,
	};
}
