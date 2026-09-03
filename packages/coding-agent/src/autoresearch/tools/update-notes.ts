import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Text } from "@oh-my-pi/pi-tui";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { buildExperimentState } from "../state";
import { openAutoresearchStorageIfExists } from "../storage";
import type { AutoresearchToolFactoryOptions } from "../types";

const updateNotesSchema = type({
	body: type("string").describe("replacement notes body"),
	"append_idea?": type("string").describe("append as bullet under Ideas instead of replacing body"),
});

interface UpdateNotesDetails {
	notes: string;
}

export function createUpdateNotesTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof updateNotesSchema, UpdateNotesDetails> {
	return {
		name: "update_notes",
		label: "Update Notes",
		description:
			"Persist the durable autoresearch playbook (goal, scope notes, hypotheses, ideas backlog) on the active session. Pass `body` to replace the entire notes blob, or `append_idea` to append a single bullet under an `## Ideas` section.",
		parameters: updateNotesSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			const currentBranch = (await vcs.git(ctx.cwd)?.currentBranch()) ?? null;
			const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
			if (!storage || !session) {
				return {
					content: [
						{
							type: "text",
							text: "Error: no active autoresearch session for the current branch. Call init_experiment first.",
						},
					],
				};
			}

			const nextNotes =
				params.append_idea !== undefined && params.append_idea.trim().length > 0
					? appendIdea(session.notes, params.append_idea.trim())
					: params.body;

			storage.updateSession(session.id, { notes: nextNotes });
			const refreshed = storage.getSessionById(session.id);
			const loggedRuns = storage.listLoggedRuns(session.id);
			const runtime = options.getRuntime(ctx);
			if (refreshed) {
				runtime.state = buildExperimentState(refreshed, loggedRuns);
			}
			options.dashboard.updateWidget(ctx, runtime);

			return {
				content: [
					{
						type: "text",
						text:
							params.append_idea !== undefined
								? `Appended idea (${nextNotes.length} chars total).`
								: `Notes updated (${nextNotes.length} chars).`,
					},
				],
				details: { notes: nextNotes },
			};
		},
		renderCall(args, _options, theme): Text {
			const preview = args.append_idea ?? args.body.slice(0, 100);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("update_notes"))} ${theme.fg("muted", truncateToWidth(replaceTabs(preview), 100))}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme: Theme): Text {
			const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
			return new Text(theme.fg("muted", text), 0, 0);
		},
	};
}

const IDEAS_HEADING = "## Ideas";

function appendIdea(currentNotes: string, idea: string): string {
	const trimmed = currentNotes.trimEnd();
	if (trimmed.length === 0) {
		return `${IDEAS_HEADING}\n- ${idea}\n`;
	}
	if (trimmed.includes(IDEAS_HEADING)) {
		const lines = trimmed.split("\n");
		const ideasIndex = lines.findIndex(line => line.trim() === IDEAS_HEADING);
		// find end of ideas section (next heading or end of file)
		let insertAt = lines.length;
		for (let i = ideasIndex + 1; i < lines.length; i += 1) {
			if (/^#{1,6}\s/.test(lines[i] ?? "")) {
				insertAt = i;
				break;
			}
		}
		lines.splice(insertAt, 0, `- ${idea}`);
		return `${lines.join("\n")}\n`;
	}
	return `${trimmed}\n\n${IDEAS_HEADING}\n- ${idea}\n`;
}
