import { LESSON_SOURCES } from "../tutorials/catalog";
import { clearSubmittedText } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_TUTORIAL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "tutorial",
		icon: "question",
		description: "Interactive lessons: practise a feature in a throwaway repo",
		subcommands: [
			// Ids only: lessons are parsed lazily by /tutorial, so a malformed lesson
			// cannot break registry import (and every other slash command).
			...LESSON_SOURCES.map(source => ({ name: source.id, description: `Start or resume the ${source.id} lesson` })),
			{ name: "hint", description: "Hint for the current step" },
			{ name: "skip", description: "Mark the current step done and advance" },
			{ name: "exit", description: "Leave the lesson and resume the session you came from" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.tutorialController.handleCommand(command.args);
		},
	},
];
