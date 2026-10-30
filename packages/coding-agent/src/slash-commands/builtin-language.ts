import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText, refuseImages } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_LANGUAGE_SLASH_COMMAND: SlashCommandSpec = {
	name: "language",
	description: __ompTranslate("Switch UI language (restarts omp and resumes this session)"),
	allowArgs: true,
	subcommands: [
		{ name: "ko", description: "한국어" },
		{ name: "en", description: "English" },
	],
	handleTui: async (command, runtime) => {
		if (refuseImages(command, runtime)) return;
		const language = command.args.trim();
		if (language !== "ko" && language !== "en") {
			runtime.ctx.showWarning(__ompTranslate("Usage: /language ko | /language en"));
			return;
		}
		clearSubmittedText(runtime);
		// Restart reloads UI labels captured at module initialization, preserving the session.
		process.env.OMP_LANG = language;
		await runtime.ctx.restart();
	},
};
