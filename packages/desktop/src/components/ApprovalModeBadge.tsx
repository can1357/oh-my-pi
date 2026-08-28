import { useCallback, useEffect, useRef, useState } from "react";
import { readConfig, writeConfig } from "../manage/cli";

const MODES = [
	{ value: "always-ask", label: "Always ask", hint: "Auto-approves reads only" },
	{ value: "write", label: "Write", hint: "Prompts before running commands" },
	{ value: "yolo", label: "Yolo", hint: "Approves everything" },
] as const;

/**
 * Shows the configured tool-approval mode, and lets it be changed.
 *
 * Deliberately explicit about a limitation: there is no RPC command for approval
 * mode and `get_state` does not report it, so this reads and writes
 * `tools.approvalMode` through the CLI. A running sidecar already resolved its
 * own mode at startup, so a change here lands on the **next** session — the menu
 * says so rather than implying it took effect.
 *
 * It matters because omp's default is `yolo`, which auto-approves shell commands
 * without asking. Someone should be able to see that without opening a file.
 */
export function ApprovalModeBadge() {
	const [mode, setMode] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [saved, setSaved] = useState<string | null>(null);
	/*
	 * Its own, because this component has no bridge: it reads and writes through
	 * the CLI, so there is no session error banner to borrow. The old comment here
	 * pointed at the settings screen, which is not where you are when you use this.
	 */
	const [failed, setFailed] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		readConfig()
			.then(config => setMode(String(config["tools.approvalMode"]?.value ?? "")))
			// Outside Tauri, or if the CLI is unavailable, just render nothing.
			.catch(() => setMode(null));
	}, []);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		/*
		 * Escape closed nothing here, so it fell through to the session's handler
		 * and aborted the turn instead. `preventDefault` is what that handler
		 * checks, so this both closes the menu and spares the turn — the same fix
		 * the palette and the model menu already carry.
		 */
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const choose = useCallback(async (next: string) => {
		setFailed(null);
		try {
			await writeConfig("tools.approvalMode", next);
			setMode(next);
			setSaved(next);
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	if (!mode) return null;

	const current = MODES.find(entry => entry.value === mode);

	return (
		<div className="omp-picker" ref={root}>
			<button
				className="omp-picker__trigger"
				type="button"
				data-warn={mode === "yolo" || undefined}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				title="Tool approval mode"
			>
				{mode}
				<span className="omp-picker__caret" aria-hidden="true" />
			</button>

			{open ? (
				/*
				 * A radio group, and now it says so. It was a list of plain buttons
				 * whose only mark of the active one was a darker fill — which read as
				 * a selection artefact rather than a choice.
				 */
				<div className="omp-picker__menu omp-picker__menu--narrow" role="menu" aria-label="Tool approval mode">
					{MODES.map(entry => {
						const active = entry.value === mode;
						return (
							<button
								className="omp-choice"
								key={entry.value}
								type="button"
								role="menuitemradio"
								aria-checked={active}
								onClick={() => void choose(entry.value)}
							>
								<span className="omp-choice__mark" aria-hidden="true">
									{active ? "✓" : ""}
								</span>
								<span className="omp-choice__text">
									<span className="omp-choice__name">{entry.label}</span>
									<span className="omp-choice__desc">{entry.hint}</span>
								</span>
							</button>
						);
					})}
					<p className="omp-picker__note">
						{failed
							? `Could not save: ${failed}`
							: saved
								? "Saved. Applies to sessions started from now on — this one keeps its current mode."
								: `This session stays on ${current?.label ?? mode}. The change applies to sessions started from now on.`}
					</p>
				</div>
			) : null}
		</div>
	);
}
