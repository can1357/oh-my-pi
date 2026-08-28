import { useCallback, useState } from "react";
import { isTauri } from "../rpc/transport";
import { pickDirectory } from "../shell/pickDirectory";
import { FolderPlusIcon } from "./Icons";

/**
 * Native folder picker, so a session can start somewhere omp has never run.
 *
 * Without this the sidebar can only ever show projects that already have
 * sessions on disk, which makes the app useless for a new repository until you
 * open a terminal — exactly the dependency it exists to remove.
 *
 * The picker is a Rust-side plugin call; the webview cannot open one itself.
 */
export function AddProjectButton({ onPick }: { onPick(directory: string): void }) {
	const [busy, setBusy] = useState(false);

	const pick = useCallback(async () => {
		if (!isTauri()) return;
		setBusy(true);
		try {
			const directory = await pickDirectory("Choose a project folder");
			if (directory) onPick(directory);
		} finally {
			setBusy(false);
		}
	}, [onPick]);

	if (!isTauri()) return null;

	return (
		<button
			className="omp-titlebar__button"
			type="button"
			disabled={busy}
			title="Add a project folder"
			onClick={() => void pick()}
		>
			<FolderPlusIcon />
		</button>
	);
}
