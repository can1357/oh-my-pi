import { useEffect, useMemo, useState } from "react";
import { buildProjects, loadSessions, type ProjectChoice, projectChoices } from "../projects/discover";
import { pickDirectory } from "../shell/pickDirectory";

/**
 * Which project does this chat belong to?
 *
 * A session's directory is fixed at spawn and decides what the agent can reach,
 * what Changes diffs and what Files lists, so it cannot be inferred — but the
 * answer is almost always a project you already have. Asking the OS for a folder
 * makes you re-navigate to somewhere the sidebar is already showing, so this
 * lists those first and keeps the native picker as the last row, for a folder
 * omp has never run in.
 *
 * Worktrees are listed in their own right: they are separate working
 * directories, which is exactly what is being chosen here.
 */
export function ProjectPicker({
	open,
	onClose,
	onChoose,
}: {
	open: boolean;
	onClose(): void;
	onChoose(cwd: string): void;
}) {
	const [projects, setProjects] = useState<ProjectChoice[] | null>(null);
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);
	const [error, setError] = useState<string | null>(null);

	// Re-read on each open: sessions are created outside this window too, and a
	// list cached from launch would go stale the first time you used the CLI.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setHighlight(0);
		setError(null);
		let cancelled = false;

		loadSessions()
			.then(sessions => {
				if (!cancelled) setProjects(projectChoices(buildProjects(sessions)));
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				// The native picker below still works, so this is a degraded list,
				// not a dead dialog.
				setProjects([]);
				setError(cause instanceof Error ? cause.message : String(cause));
			});

		return () => {
			cancelled = true;
		};
	}, [open]);

	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return projects ?? [];
		return (projects ?? []).filter(
			choice => choice.name.toLowerCase().includes(needle) || choice.cwd.toLowerCase().includes(needle),
		);
	}, [projects, query]);

	// The browse row is always last and always reachable, so it is part of the
	// keyboard list rather than a button off to the side.
	const rowCount = matches.length + 1;

	const browse = async () => {
		const directory = await pickDirectory("Choose a folder for this session");
		if (directory) {
			onChoose(directory);
			onClose();
		}
	};

	const choose = (index: number) => {
		if (index >= matches.length) return void browse();
		onChoose(matches[index].cwd);
		onClose();
	};

	if (!open) return null;

	return (
		<div
			className="omp-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label="New session"
			onClick={onClose}
			onKeyDown={event => {
				// Claim the key, or the window listener in session.tsx aborts the
				// running turn as well as closing this.
				if (event.key !== "Escape") return;
				event.preventDefault();
				onClose();
			}}
		>
			<div className="omp-modal omp-palette" onClick={event => event.stopPropagation()}>
				<input
					className="omp-input"
					autoFocus
					placeholder="New session in…"
					value={query}
					onChange={event => {
						setQuery(event.target.value);
						setHighlight(0);
					}}
					onKeyDown={event => {
						if (event.key === "Escape") {
							event.preventDefault();
							return onClose();
						}
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setHighlight(index => (index + 1) % rowCount);
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							setHighlight(index => (index - 1 + rowCount) % rowCount);
						}
						if (event.key === "Enter") {
							event.preventDefault();
							choose(highlight);
						}
					}}
				/>

				<div className="omp-palette__list">
					{projects === null ? (
						<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
							Reading your projects…
						</div>
					) : null}

					{error ? <div className="omp-banner omp-banner--error">Could not list projects: {error}</div> : null}

					{projects !== null && projects.length > 0 && matches.length === 0 ? (
						<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
							No project matches.
						</div>
					) : null}

					{matches.map((choice, index) => (
						<button
							className="omp-slash__item"
							data-active={index === highlight || undefined}
							key={choice.cwd}
							type="button"
							title={choice.cwd}
							onMouseEnter={() => setHighlight(index)}
							onClick={() => choose(index)}
						>
							<span>{choice.name}</span>
							<span className="omp-slash__desc">{describe(choice)}</span>
						</button>
					))}

					<button
						className="omp-slash__item"
						data-active={highlight === matches.length || undefined}
						type="button"
						onMouseEnter={() => setHighlight(matches.length)}
						onClick={() => void browse()}
					>
						<span>Choose another folder…</span>
						<span className="omp-slash__desc">a folder omp has not run in yet</span>
					</button>
				</div>
			</div>
		</div>
	);
}

function describe(choice: ProjectChoice): string {
	if (choice.kind === "worktree") return `worktree of ${choice.parent}`;
	return choice.sessions === 1 ? "1 session" : `${choice.sessions} sessions`;
}
