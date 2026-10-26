import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { closeDashboard, getClosable } from "../api";
import { isDialogOpen, isTypingTarget } from "./keys";

/**
 * Close, while the host shows the dashboard in place of its terminal
 * (`omp stats` in Tern), where the page is the only way out: the button, Esc,
 * or Ctrl+C with nothing selected, as in the terminal it covers. Renders
 * nothing anywhere else.
 */
export function CloseButton() {
	const closable = useClosable();

	useEffect(() => {
		if (!closable) return;
		const onKey = (e: KeyboardEvent) => {
			if (!isCloseKey(e)) return;
			e.preventDefault();
			close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [closable]);

	if (!closable) return null;
	return (
		<button type="button" className="btn" data-variant="ghost" onClick={close} title="Close the dashboard (Esc)">
			<X size={15} />
			Close
			<span className="kbd">Esc</span>
		</button>
	);
}

function close(): void {
	closeDashboard().catch(error => console.error("Closing the dashboard failed", error));
}

function useClosable(): boolean {
	const [closable, setClosable] = useState(false);
	useEffect(() => {
		const abort = new AbortController();
		getClosable(abort.signal).then(setClosable, () => {});
		return () => abort.abort();
	}, []);
	return closable;
}

/** Esc, or Ctrl+C with no text selected (with a selection it copies), outside fields and dialogs. */
function isCloseKey(e: KeyboardEvent): boolean {
	if (e.defaultPrevented || e.altKey || e.metaKey || e.shiftKey) return false;
	if (isTypingTarget(e.target) || isDialogOpen()) return false;
	if (e.key === "Escape") return !e.ctrlKey;
	return e.ctrlKey && e.key.toLowerCase() === "c" && !window.getSelection()?.toString();
}
