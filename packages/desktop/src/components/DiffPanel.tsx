import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { memo, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import { writeClipboard } from "../shell/clipboard";
import { useContextMenu } from "../shell/contextMenu";
import {
	absolute,
	type ChangedFile,
	changedFiles,
	type FileDiff,
	fileDiff,
	type RepositoryState,
	rawFileDiff,
	repositoryState,
} from "../workspace/git";
import { fileMenuItems } from "./fileMenu";

/**
 * Read-only view of what the session changed.
 *
 * Editing opens the file in the system editor rather than embedding one: a real
 * editor drags in highlighting, LSP and — the hard part — reconciling your edits
 * with the agent writing the same file underneath you.
 */
export function DiffPanel({ bridge, ready, streaming }: { bridge: RpcBridge; ready: boolean; streaming: boolean }) {
	const [files, setFiles] = useState<ChangedFile[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [diff, setDiff] = useState<FileDiff[]>([]);
	const [repo, setRepo] = useState<RepositoryState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/*
	 * Truncation is not an error and must not be silence either. The shell caps
	 * how much a command returns, so a big enough working tree comes back as a
	 * short list and a diff with its middle removed — both of which look exactly
	 * like a small, complete answer.
	 */
	const [clipped, setClipped] = useState(false);

	const refresh = useCallback(async () => {
		if (!ready) return;
		setBusy(true);
		setError(null);
		try {
			const state = await repositoryState(bridge);
			setRepo(state);
			const listing = state.kind === "repo" ? await changedFiles(bridge, state.root) : null;
			setFiles(listing?.files ?? []);
			setClipped(listing?.truncated ?? false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}, [bridge, ready]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/*
	 * Re-read when a turn ends. The panel is called "Changes" and the agent is
	 * what changes things, so a list that only moved when you pressed Refresh was
	 * showing the state of the repository before the work you just watched.
	 */
	const wasStreaming = useRef(false);
	useEffect(() => {
		if (wasStreaming.current && !streaming) void refresh();
		wasStreaming.current = streaming;
	}, [streaming, refresh]);

	const root = repo?.kind === "repo" ? repo.root : null;

	useEffect(() => {
		if (!selected || !root) {
			setDiff([]);
			return;
		}
		let cancelled = false;
		fileDiff(bridge, root, selected)
			.then(result => {
				if (cancelled) return;
				setDiff(result.diffs);
				if (result.truncated) setClipped(true);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
		/*
		 * `repo`, not just `root`: a refresh mints a new state object but the same
		 * root string, so keying on the string alone left every dependency
		 * identical and the open diff never re-read — the file list updated around
		 * a body that still showed the previous contents.
		 */
	}, [bridge, repo, root, selected]);

	/*
	 * Absolute, and loud when it fails. The path from `git status` is relative to
	 * the repository root, which means nothing to the OS opener — so a double
	 * click quietly did nothing, and `.catch(() => {})` made sure you never found
	 * out why.
	 */
	const openInEditor = useCallback(
		async (path: string) => {
			if (!root) return;
			try {
				await openPath(absolute(root, path));
			} catch (cause) {
				setError(`Could not open ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		},
		[root],
	);

	const { open: openMenu } = useContextMenu();

	const menu = useCallback(
		(event: ReactMouseEvent, path: string) => {
			if (!root) return;
			const full = absolute(root, path);
			const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
			openMenu(
				event,
				fileMenuItems({
					relative: path,
					absolute: full,
					open: () => void openInEditor(path),
					reveal: () => void revealItemInDir(full).catch(fail),
					copy: text => void writeClipboard(text).catch(fail),
					// Re-read rather than reuse what is on screen: the open diff may be
					// another file's, and the panel only holds one at a time.
					copyDiff: () => void rawFileDiff(bridge, root, path).then(writeClipboard).catch(fail),
				}),
			);
		},
		[openMenu, root, openInEditor, bridge],
	);

	if (repo?.kind === "none") {
		return <div className="omp-empty">Not a git repository.</div>;
	}

	/*
	 * Say what happened instead of asserting something false. This branch used to
	 * be folded into "not a git repository", which is what a missing `git` looked
	 * like from the outside.
	 */
	if (repo?.kind === "unknown") {
		return (
			<div className="omp-diff">
				<div className="omp-banner omp-banner--error">Could not read the repository: {repo.detail}</div>
				<div className="omp-diff__head">
					<span>&nbsp;</span>
					<button
						type="button"
						data-component="button"
						data-variant="ghost"
						data-size="normal"
						onClick={() => void refresh()}
						disabled={busy}
					>
						{busy ? "…" : "Retry"}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="omp-diff">
			<div className="omp-diff__head">
				<span>
					{files.length} changed file{files.length === 1 ? "" : "s"}
				</span>
				<button
					type="button"
					data-component="button"
					data-variant="ghost"
					data-size="normal"
					onClick={() => void refresh()}
					disabled={busy}
				>
					{busy ? "…" : "Refresh"}
				</button>
			</div>

			{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}
			{clipped ? (
				<div className="omp-banner omp-banner--info">
					The shell cut this output short, so what is shown is incomplete. Copying a diff is refused while that is
					true — a patch missing its middle applies cleanly and writes the wrong file.
				</div>
			) : null}

			<div className="omp-diff__files">
				{files.length === 0 && !busy ? (
					<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
						No uncommitted changes.
					</div>
				) : null}

				{files.map(file => (
					<button
						className="omp-diff__file"
						key={file.path}
						type="button"
						aria-current={file.path === selected}
						title={file.from ? `${file.from} → ${file.path}` : file.path}
						onClick={() => setSelected(file.path === selected ? null : file.path)}
						onDoubleClick={() => void openInEditor(file.path)}
						onContextMenu={event => menu(event, file.path)}
					>
						<span className={`omp-diff__status omp-diff__status--${file.status}`}>
							{statusLetter(file.status)}
						</span>
						{/*
						 * Name first, directory after it and dimmed. Every row in a panel
						 * this narrow shared the same long prefix, so truncation ate the
						 * one part you scan for — the filename. Now the name is never
						 * truncated and the directory gives way instead.
						 */}
						<span className="omp-diff__name">{fileName(file.path)}</span>
						<span className="omp-diff__dir">{dirName(file.path)}</span>
						<ChangeBars additions={file.additions} deletions={file.deletions} />
					</button>
				))}
			</div>

			{selected ? (
				<div className="omp-diff__body">
					{diff.length === 0 ? (
						<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
							No textual diff.
						</div>
					) : (
						diff.map(file => <FileDiffView key={file.path} file={file} />)
					)}
				</div>
			) : null}
		</div>
	);
}

/**
 * The +N/−N counts.
 *
 * Written here rather than through opencode's vendored `diff-changes` component,
 * which carried `justify-content: flex-end`: any row where its box came out
 * narrower than its text pushed the numbers out of the *left* edge and printed
 * them over the path — `rpc-mode.t+20 −0`. Two spans we size ourselves cannot do
 * that, and it was the last vendored component left.
 */
const ChangeBars = memo(function ChangeBars({ additions, deletions }: { additions: number; deletions: number }) {
	if (!additions && !deletions) return null;
	return (
		<span className="omp-diff__counts">
			{additions > 0 ? <span className="omp-diff__count omp-diff__count--add">+{additions}</span> : null}
			{deletions > 0 ? <span className="omp-diff__count omp-diff__count--del">−{deletions}</span> : null}
		</span>
	);
});

const FileDiffView = memo(function FileDiffView({ file }: { file: FileDiff }) {
	if (file.binary) {
		return <div className="omp-diff__binary">{file.path} — binary file</div>;
	}
	return (
		<div className="omp-diff__file-diff">
			{file.hunks.map(hunk => (
				<div className="omp-hunk" key={hunk.header}>
					<div className="omp-hunk__header">{hunk.header}</div>
					{hunk.lines.map((line, index) => (
						<div
							// Diff lines have no stable identity; index is the honest key here
							// and the list is fully replaced on every refresh.
							key={`${hunk.header}:${index}`}
							className={`omp-hunk__line omp-hunk__line--${line.kind}`}
						>
							<span className="omp-hunk__no">{line.oldNo ?? ""}</span>
							<span className="omp-hunk__no">{line.newNo ?? ""}</span>
							<span className="omp-hunk__sign">{sign(line.kind)}</span>
							<span className="omp-hunk__text">{line.text}</span>
						</div>
					))}
				</div>
			))}
		</div>
	);
});

function sign(kind: string): string {
	if (kind === "add") return "+";
	if (kind === "del") return "−";
	return " ";
}

function fileName(path: string): string {
	return path.split("/").at(-1) || path;
}

/**
 * The last two directory segments, which is the part that identifies a file.
 *
 * This used to be the whole directory truncated by CSS with `direction: rtl`, to
 * keep the tail visible. That is a typographic trick with a bidi bug in it: a
 * leading neutral takes the paragraph level and lands at the far end, so
 * `.github/workflows` rendered as `github/workflows.` — every dot-directory in
 * the repo. Choosing the segments here says the same thing and cannot reorder.
 */
function dirName(path: string): string {
	const cut = path.lastIndexOf("/");
	if (cut === -1) return "";
	const parts = path.slice(0, cut).split("/");
	return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}

function statusLetter(status: ChangedFile["status"]): string {
	switch (status) {
		case "modified":
			return "M";
		case "added":
			return "A";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		case "untracked":
			return "?";
		default:
			return "•";
	}
}
