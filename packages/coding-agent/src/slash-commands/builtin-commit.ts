import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import { draftFor } from "../commit/selective/prelude-definition";
import commitRequestTemplate from "../prompts/commit-request.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

/** Recent commit subjects shown to the agent for style. */
const RECENT_SUBJECTS = 5;

/** `/commit`: hand the agent a draft of its own changes and ask it to commit them with the eval `commit` namespace. */
export const BUILTIN_COMMIT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "commit",
		icon: "branch",
		description: "Commit only the changes this agent and its subagents made",
		inlineHint: "[instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!runtime.session.getAdvertisedEvalPreludes().some(prelude => prelude.name === "commit")) {
				return usage("/commit needs the eval tool and the `commit.enabled` setting.", runtime);
			}
			try {
				const draft = await draftFor({
					cwd: runtime.cwd,
					artifactsDir: runtime.sessionManager.getArtifactsDir(),
					agent: runtime.session.getAgentId() ?? MAIN_AGENT_ID,
					signal: runtime.signal,
				});
				const recent = await vcs
					.requireGit(draft.root)
					.logSubjects(RECENT_SUBJECTS, runtime.signal)
					.catch(() => []);
				const instructions = command.args.trim();
				return { prompt: prompt.render(commitRequestTemplate, { summary: draft.summary(), recent, instructions }) };
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
		},
	},
];
