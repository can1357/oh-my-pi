import type { MenuItem } from "../shell/contextMenu";

/**
 * What a right click offers on a file, in Changes and in the tree alike.
 *
 * Both paths, because they are for different places: the relative one is what
 * you paste into a prompt, the absolute one is what you paste into a terminal.
 * The panels disagreed about which they held once already — the tree listed the
 * session's directory while the diff listed repo-relative paths — so both are
 * derived here from one root rather than each panel deciding.
 */
export function fileMenuItems(input: {
	relative: string;
	absolute: string;
	/** Only Changes has one; the tree passes nothing. */
	copyDiff?: () => void;
	/** Absent for a folder, which has nothing to open in an editor. */
	open?: () => void;
	reveal(): void;
	copy(text: string): void;
}): MenuItem[] {
	const items: MenuItem[] = [];
	if (input.open) items.push({ kind: "action", id: "open", label: "Open in editor", run: input.open });
	items.push(
		{ kind: "action", id: "reveal", label: "Reveal in Finder", run: input.reveal },
		{ kind: "separator", id: "sep" },
		{ kind: "action", id: "copy-rel", label: "Copy relative path", run: () => input.copy(input.relative) },
		{ kind: "action", id: "copy-abs", label: "Copy absolute path", run: () => input.copy(input.absolute) },
	);

	if (input.copyDiff) {
		items.push({ kind: "action", id: "copy-diff", label: "Copy the file's diff", run: input.copyDiff });
	}
	return items;
}
