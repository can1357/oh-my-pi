/**
 * A turn's long-press menu (`actions.hold`): what a phone offers on a prompt
 * or an answer. A desktop ignores it and keeps the hover controls.
 */
import type { TspMenuEntry } from "@oh-my-pi/pi-wire";

/** The hold-menu entries of a turn: its copy entry, Edit & resend (prompts only), Retry, Rewind and Fork. */
export function turnHoldEntries(role: "user" | "assistant", copy: TspMenuEntry): TspMenuEntry[] {
	return [
		copy,
		...(role === "user"
			? [
					{
						id: "edit-turn",
						label: "Edit & resend",
						icon: "edit",
						detail: "To composer",
					},
				]
			: []),
		{ id: "retry-turn", label: "Retry turn", icon: "refresh" },
		{ id: "rewind-turn", label: "Rewind to here…", icon: "rewind" },
		{
			id: "fork-turn",
			label: "Fork from here",
			icon: "branch",
			detail: "New session",
		},
	];
}
