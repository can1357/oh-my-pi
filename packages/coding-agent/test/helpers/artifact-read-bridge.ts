import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { bridgeValueFromToolResult } from "../../src/eval/js/tool-bridge";

/**
 * The eval bridge's calls against a session whose artifacts live in
 * `artifactsDir`: the real `read` tool and the real bridge value.
 *
 * An artifact read also asks whether a copy is still filling that directory
 * (`__artifacts_ready__`), which here is answered at once: these sessions run
 * no copy.
 */
export function artifactReadBridge(
	cwd: string,
	artifactsDir: string,
): (args: { path: string }, name?: string) => Promise<unknown> {
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
	return async (args, name) => {
		if (name === "__artifacts_ready__") return "";
		return bridgeValueFromToolResult("read", args, await tool.execute("eval-read", args));
	};
}
