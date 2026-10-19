import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { bridgeValueFromToolResult } from "../../src/eval/js/tool-bridge";

/** The eval bridge's `read` call against a session whose artifacts live in `artifactsDir`: real tool, real bridge value. */
export function artifactReadBridge(cwd: string, artifactsDir: string): (args: { path: string }) => Promise<unknown> {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		settings: Settings.isolated(),
		localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "artifact-owner" },
	};
	const tool = wrapToolWithMetaNotice(new ReadTool(session));
	return async args => bridgeValueFromToolResult("read", args, await tool.execute("eval-read", args));
}
