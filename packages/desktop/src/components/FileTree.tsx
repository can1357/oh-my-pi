import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { memo, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import { writeClipboard } from "../shell/clipboard";
import { useContextMenu } from "../shell/contextMenu";
import { absolute, listFiles, repositoryState } from "../workspace/git";
import { fileMenuItems } from "./fileMenu";

interface TreeNode {
	name: string;
	path: string;
	children: Map<string, TreeNode>;
}

/**
 * Workspace file tree, built from `git ls-files` so it honours `.gitignore`
 * for free — no ignore parsing, and no walking into `node_modules` or `target`.
 */
export function FileTree({ bridge, ready }: { bridge: RpcBridge; ready: boolean }) {
	const [paths, setPaths] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	/** The repository root, kept so a click can build an absolute path. */
	const [repoRoot, setRepoRoot] = useState<string | null>(null);
	const { open: openMenu } = useContextMenu();

	/*
	 * Anchored at the repository root, like the Changes tab. They used to disagree
	 * — this listed the session's directory while the diff listed repo-relative
	 * paths — so the same file had two names depending on which tab you were on.
	 */
	useEffect(() => {
		if (!ready) return;
		let cancelled = false;
		setError(null);

		(async () => {
			const state = await repositoryState(bridge);
			if (cancelled) return;
			if (state.kind !== "repo") {
				setRepoRoot(null);
				setPaths([]);
				// Say which of the two silences this is.
				setNotice(
					state.kind === "none" ? "Not a git repository." : `Could not read the repository: ${state.detail}`,
				);
				return;
			}
			setRepoRoot(state.root);
			const listing = await listFiles(bridge, state.root);
			if (cancelled) return;
			setPaths(listing.paths);
			setNotice(
				listing.truncated
					? `Showing ${listing.paths.length} files. The listing was cut short — the shell caps how much it returns.`
					: null,
			);
		})().catch((cause: unknown) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
		});

		return () => {
			cancelled = true;
		};
	}, [bridge, ready]);

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle ? paths.filter(path => path.toLowerCase().includes(needle)) : paths;
	}, [paths, query]);

	const root = useMemo(() => buildTree(visible), [visible]);

	/*
	 * Absolute, and loud. The listing is repo-root-relative, which means nothing
	 * to the OS opener — every click here was a silent no-op, the same bug the
	 * diff panel had one file over.
	 */
	const open = useCallback(
		async (path: string) => {
			if (!repoRoot) return;
			try {
				await openPath(absolute(repoRoot, path));
			} catch (cause) {
				setError(`Could not open ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		},
		[repoRoot],
	);

	const menu = useCallback(
		(event: ReactMouseEvent, path: string, isDirectory: boolean) => {
			if (!repoRoot) return;
			const full = absolute(repoRoot, path);
			const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
			openMenu(
				event,
				fileMenuItems({
					relative: path,
					absolute: full,
					// A folder has nothing to open in an editor, and offering it would
					// promise something the click cannot deliver.
					open: isDirectory ? undefined : () => void open(path),
					reveal: () => void revealFile(full, isDirectory).catch(fail),
					copy: text => void writeClipboard(text).catch(fail),
				}),
			);
		},
		[openMenu, repoRoot, open],
	);

	const toggle = useCallback((path: string) => {
		setExpanded(current => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	}, []);

	// A filter should reveal matches, not leave them behind collapsed folders.
	const filtering = query.trim().length > 0;

	return (
		<div className="omp-tree">
			<input
				className="omp-filter"
				type="search"
				placeholder="Filter files…"
				value={query}
				onChange={event => setQuery(event.target.value)}
			/>

			{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}
			{notice ? <div className="omp-banner omp-banner--info">{notice}</div> : null}

			<div className="omp-tree__scroll">
				{paths.length === 0 && !error ? (
					<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
						No files.
					</div>
				) : null}
				<TreeLevel
					node={root}
					depth={0}
					expanded={expanded}
					forceOpen={filtering}
					onToggle={toggle}
					onOpen={open}
					onMenu={menu}
				/>
			</div>
		</div>
	);
}

const TreeLevel = memo(function TreeLevel({
	node,
	depth,
	expanded,
	forceOpen,
	onToggle,
	onOpen,
	onMenu,
}: {
	node: TreeNode;
	depth: number;
	expanded: Set<string>;
	forceOpen: boolean;
	onToggle(path: string): void;
	onOpen(path: string): void;
	onMenu(event: ReactMouseEvent, path: string, isDirectory: boolean): void;
}) {
	const children = [...node.children.values()].sort(directoriesFirst);

	return (
		<>
			{children.map(child => {
				const isDirectory = child.children.size > 0;
				const isOpen = forceOpen || expanded.has(child.path);

				return (
					<div key={child.path}>
						<button
							className="omp-tree__row"
							type="button"
							style={{ paddingLeft: 8 + depth * 12 }}
							title={child.path}
							onClick={() => (isDirectory ? onToggle(child.path) : onOpen(child.path))}
							onContextMenu={event => onMenu(event, child.path, isDirectory)}
						>
							<span className="omp-tree__twisty" aria-hidden="true">
								{isDirectory ? (isOpen ? "▾" : "▸") : ""}
							</span>
							<span className="omp-tree__name">{child.name}</span>
						</button>

						{isDirectory && isOpen ? (
							<TreeLevel
								node={child}
								depth={depth + 1}
								expanded={expanded}
								forceOpen={forceOpen}
								onToggle={onToggle}
								onOpen={onOpen}
								onMenu={onMenu}
							/>
						) : null}
					</div>
				);
			})}
		</>
	);
});

function directoriesFirst(a: TreeNode, b: TreeNode): number {
	const aDir = a.children.size > 0;
	const bDir = b.children.size > 0;
	if (aDir !== bDir) return aDir ? -1 : 1;
	return a.name.localeCompare(b.name);
}

export function buildTree(paths: readonly string[]): TreeNode {
	const root: TreeNode = { name: "", path: "", children: new Map() };

	for (const path of paths) {
		let node = root;
		const segments = path.split("/");
		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];
			const full = segments.slice(0, i + 1).join("/");
			let child = node.children.get(name);
			if (!child) {
				child = { name, path: full, children: new Map() };
				node.children.set(name, child);
			}
			node = child;
		}
	}

	return root;
}

/** Show a file in Finder, selected inside its folder rather than opened. */
async function revealFile(path: string, isDirectory: boolean): Promise<void> {
	// A folder is opened; a file is selected inside its parent. `revealItemInDir`
	// on a directory shows the directory's own parent, which is not what the row
	// you clicked was pointing at.
	if (isDirectory) return openPath(path);
	return revealItemInDir(path);
}
