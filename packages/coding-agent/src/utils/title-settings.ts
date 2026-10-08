/**
 * Automatic session-title settings: which generator names a session, how its
 * card icon shows, and whether a todo replan refreshes it.
 */
import { register } from "../config/registry";

/** The `title.icons` styles. */
export const TITLE_ICONS = ["nf+emoji", "emoji", "boring"] as const;
/** How a session title shows its card icon: see {@link cfgTitleIcons}. */
export type TitleIcons = (typeof TITLE_ICONS)[number];

export const cfgTitleIcons = register({
	id: "title.icons",
	type: "enum",
	values: TITLE_ICONS,
	default: "nf+emoji",
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Title Icons",
		description: "Icon and short code that head new generated session titles",
		options: [
			{
				value: "nf+emoji",
				label: "Nerd Font + Emoji",
				description: "Nerd Font glyph where the Nerd Font symbol preset renders it, else the emoji (default)",
			},
			{ value: "emoji", label: "Emoji", description: "Always the emoji" },
			{ value: "boring", label: "Boring", description: "Plain title: no icon or code" },
		],
	},
});

export const cfgTitleGenerator = register({
	id: "title.generator",
	type: "enum",
	values: ["fork", "tiny"] as const,
	default: "fork",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Title Generator",
		description: "What names an untitled session from the user's messages",
		options: [
			{
				value: "fork",
				label: "Fork",
				description:
					"A side turn of the reply on the session's model: reads its prompt cache, adds the card icon (default)",
			},
			{ value: "tiny", label: "Tiny", description: "The title model role only; plain titles without a card" },
		],
	},
});

export const cfgTitleRefreshOnReplan = register({
	id: "title.refreshOnReplan",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Refresh Title on Replan",
		description: "Refresh generated session titles after todo init replans unless the title was set by the user",
	},
});
