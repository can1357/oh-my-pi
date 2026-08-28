import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../rpc/transport";

/**
 * The native folder picker, as a plain question: which directory, or none.
 *
 * The webview cannot open one itself — it is a Rust-side plugin call — and two
 * callers now need the same answer, so the narrowing lives here rather than
 * being repeated. `open` resolves to `null` when cancelled and to `string[]` if
 * multiple selection were ever turned on; both collapse to `undefined`, which
 * every caller must treat as "the user said no".
 */
export async function pickDirectory(title: string): Promise<string | undefined> {
	if (!isTauri()) return undefined;
	const selected = await open({ directory: true, multiple: false, title });
	const directory = Array.isArray(selected) ? selected[0] : selected;
	return typeof directory === "string" && directory ? directory : undefined;
}
