import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type ContextProfile, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildNativeToolSchemaFragments } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import {
	buildStaticContextReport,
	combineStaticContextSources,
} from "@oh-my-pi/pi-coding-agent/modes/utils/static-context-report";
import { buildSystemPrompt, projectSystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { xdevDocsAll, xdevEntries } from "@oh-my-pi/pi-coding-agent/tools/xdev";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

const EMPTY_TREE = { rootPath: "/tmp", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };
const PROFILE_LIMITS = { balanced: 8_160, aggressive: 5_440 } as const;

async function staticTokens(contextProfile: ContextProfile): Promise<number> {
	const settings = Settings.isolated({ contextProfile, "tools.xdev": false });
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
	const directTools = await createTools(session);
	const enabledTools = session.xdev?.tools ?? new Map(directTools.map(tool => [tool.name, tool]));
	const directToolNames = directTools.map(tool => tool.name);
	const prompt = await buildSystemPrompt({
		cwd: "/tmp",
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
		includeWorkspaceTree: false,
		contextProfile,
		toolNames: directToolNames,
		directToolNames,
		tools: projectSystemPromptToolMetadata(enabledTools, { mode: "compact", toolNames: directToolNames }),
		xdevTools: session.xdev ? xdevEntries(session.xdev) : [],
		xdevDocs: session.xdev ? xdevDocsAll(session.xdev, "catalog", [], true) : "",
	});
	const sources = combineStaticContextSources(prompt.staticContext, buildNativeToolSchemaFragments(directTools));
	return buildStaticContextReport({ sources, tokenizer: new Tokenizer() }).total.tokens;
}

describe("context profile static budgets", () => {
	for (const contextProfile of ["balanced", "aggressive"] as const) {
		it(`${contextProfile} stays within its static token budget`, async () => {
			expect(await staticTokens(contextProfile)).toBeLessThanOrEqual(PROFILE_LIMITS[contextProfile]);
		});
	}
});
