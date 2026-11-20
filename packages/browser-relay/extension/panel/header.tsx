/** The 44px header: mark, session switcher, New chat and the More menu. */
import { OmpMark } from "@oh-my-pi/collab-web/src/components/shell/OmpMark";
import { Check, ChevronDown, Ellipsis, FolderPlus, Plus } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PanelCollabHost, RpcSessionInfo } from "../messages";
import { IconButton, Menu, type MenuEntry, useEscape, useOutsidePress } from "./ui";

/** Which session the panel is showing, in the switcher's terms. */
export type Attached = { kind: "collab"; instanceId: string } | { kind: "rpc"; sessionKey: string };

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** Display name of a running omp: its session name, else the folder it runs in. */
export function hostTitle(host: PanelCollabHost): string {
	return host.sessionName ?? basename(host.cwd);
}

type SwitcherRow =
	| { kind: "host"; id: string; host: PanelCollabHost }
	| { kind: "rpc"; id: string; info: RpcSessionInfo }
	| { kind: "new"; id: string }
	| { kind: "dir"; id: string; cwd: string };

function SessionSwitcher(props: {
	hosts: readonly PanelCollabHost[];
	rpcSessions: readonly RpcSessionInfo[];
	attached: Attached | null;
	recentDirs: readonly string[];
	defaultCwd: string;
	onAttach(host: PanelCollabHost): void;
	onOpenRpc(info: RpcSessionInfo): void;
	onNewIn(cwd: string): void;
	onClose(): void;
}): ReactNode {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [cwd, setCwd] = useState(props.defaultCwd);
	useEscape(true, props.onClose);
	useOutsidePress(rootRef, true, props.onClose);

	const rows = useMemo((): SwitcherRow[] => {
		const hosts = [...props.hosts].sort((a, b) => b.startedAt - a.startedAt);
		const sessions = props.rpcSessions
			.filter(info => info.exited === undefined)
			.sort((a, b) => b.startedAt - a.startedAt);
		return [
			...hosts.map(host => ({ kind: "host" as const, id: `host-${host.instanceId}`, host })),
			...sessions.map(info => ({ kind: "rpc" as const, id: `rpc-${info.sessionKey}`, info })),
			{ kind: "new" as const, id: "new" },
			...props.recentDirs
				.filter(dir => dir !== cwd)
				.slice(0, 4)
				.map(dir => ({ kind: "dir" as const, id: `dir-${dir}`, cwd: dir })),
		];
	}, [props.hosts, props.rpcSessions, props.recentDirs, cwd]);

	const isCurrent = (row: SwitcherRow): boolean =>
		(row.kind === "host" && props.attached?.kind === "collab" && props.attached.instanceId === row.host.instanceId) ||
		(row.kind === "rpc" && props.attached?.kind === "rpc" && props.attached.sessionKey === row.info.sessionKey);
	const [activeId, setActiveId] = useState<string>(() => rows.find(isCurrent)?.id ?? rows[0]?.id ?? "new");
	const activeIndex = Math.max(
		0,
		rows.findIndex(row => row.id === activeId),
	);

	useEffect(() => {
		rootRef.current?.focus();
	}, []);

	const pick = (row: SwitcherRow): void => {
		switch (row.kind) {
			case "host":
				props.onAttach(row.host);
				break;
			case "rpc":
				props.onOpenRpc(row.info);
				break;
			case "dir":
				props.onNewIn(row.cwd);
				break;
			case "new":
				if (document.activeElement === inputRef.current) props.onNewIn(cwd.trim() || props.defaultCwd);
				else {
					inputRef.current?.focus();
					inputRef.current?.select();
					return;
				}
				break;
		}
		props.onClose();
	};

	const hosts = rows.filter(row => row.kind === "host");
	const sessions = rows.filter(row => row.kind === "rpc");
	const dirs = rows.filter(row => row.kind === "dir");
	const rowProps = (row: SwitcherRow) => ({
		role: "option" as const,
		"aria-selected": isCurrent(row),
		"data-active": row.id === activeId || undefined,
		onPointerMove: () => setActiveId(row.id),
	});

	return (
		<div
			ref={rootRef}
			className="pn-switcher"
			role="listbox"
			aria-label="Sessions"
			tabIndex={-1}
			onKeyDown={event => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					const next =
						rows[Math.max(0, Math.min(rows.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)))];
					setActiveId(next.id);
					if (next.kind !== "new" && document.activeElement === inputRef.current) rootRef.current?.focus();
				} else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
					event.preventDefault();
					pick(rows[activeIndex]);
				}
			}}
		>
			<div className="pn-switcher-caption">Running omp</div>
			{hosts.length === 0 && (
				<div className="pn-switcher-empty">
					No omp is sharing a session. Run <code>/collab</code> in a terminal session to attach to it here.
				</div>
			)}
			{hosts.map(row => (
				<div key={row.id} className="pn-switcher-row" {...rowProps(row)} onClick={() => pick(row)}>
					<span
						className={`pn-session-dot${row.host.inputRequired ? " pn-session-dot--input" : row.host.busy ? " pn-session-dot--busy" : ""}`}
						title={row.host.inputRequired ? "needs input" : row.host.busy ? "working" : "idle"}
					/>
					<span className="pn-switcher-name">{hostTitle(row.host)}</span>
					<span className="pn-switcher-meta">{basename(row.host.cwd)}</span>
					{row.host.model !== null && <span className="pn-switcher-model">{row.host.model.id}</span>}
					{isCurrent(row) && <Check size={14} className="pn-switcher-check" />}
				</div>
			))}
			{sessions.length > 0 && (
				<>
					<div className="pn-menu-sep" />
					<div className="pn-switcher-caption">Panel sessions</div>
					{sessions.map(row => (
						<div key={row.id} className="pn-switcher-row" {...rowProps(row)} onClick={() => pick(row)}>
							<span className="pn-session-dot" />
							<span className="pn-switcher-name">{row.info.title}</span>
							<span className="pn-switcher-meta">{basename(row.info.cwd)}</span>
							{isCurrent(row) && <Check size={14} className="pn-switcher-check" />}
						</div>
					))}
				</>
			)}
			<div className="pn-menu-sep" />
			<div className="pn-switcher-caption">New session in…</div>
			<div
				className="pn-switcher-new"
				data-active={activeId === "new" || undefined}
				onPointerMove={() => setActiveId("new")}
			>
				<FolderPlus size={15} />
				<input
					ref={inputRef}
					className="pn-switcher-input"
					value={cwd}
					spellCheck={false}
					aria-label="Directory for a new session"
					placeholder={props.defaultCwd}
					onFocus={() => setActiveId("new")}
					onChange={event => setCwd(event.target.value)}
				/>
				<button
					type="button"
					className="sh-btn sh-btn-primary pn-btn pn-btn--small"
					onClick={() => {
						props.onNewIn(cwd.trim() || props.defaultCwd);
						props.onClose();
					}}
				>
					Start
				</button>
			</div>
			{dirs.map(row => (
				<div
					key={row.id}
					className="pn-switcher-row pn-switcher-row--dir"
					{...rowProps(row)}
					onClick={() => pick(row)}
				>
					<span className="pn-switcher-meta">{row.cwd}</span>
				</div>
			))}
		</div>
	);
}

/** What the header needs from the app. */
export interface HeaderProps {
	title: string;
	working: boolean;
	hosts: readonly PanelCollabHost[];
	rpcSessions: readonly RpcSessionInfo[];
	attached: Attached | null;
	recentDirs: readonly string[];
	defaultCwd: string;
	switcherOpen: boolean;
	onSwitcher(open: boolean): void;
	onAttach(host: PanelCollabHost): void;
	onOpenRpc(info: RpcSessionInfo): void;
	onNewIn(cwd: string): void;
	onNewChat(): void;
	/** Rows of the More menu. */
	more: readonly MenuEntry[];
}

/** The header bar. */
export function Header(props: HeaderProps): ReactNode {
	const [more, setMore] = useState(false);
	return (
		<header className="pn-header">
			<OmpMark size={18} />
			<span className="pn-pop-anchor pn-header-switch">
				<button
					type="button"
					className="pn-session-btn"
					aria-haspopup="listbox"
					aria-expanded={props.switcherOpen}
					onClick={() => props.onSwitcher(!props.switcherOpen)}
				>
					{props.working && <span className="pn-busy-dot" title="working" />}
					<span className="pn-session-name">{props.title}</span>
					<ChevronDown size={10} strokeWidth={2.5} className="pn-session-caret" />
				</button>
				{props.switcherOpen && (
					<SessionSwitcher
						hosts={props.hosts}
						rpcSessions={props.rpcSessions}
						attached={props.attached}
						recentDirs={props.recentDirs}
						defaultCwd={props.defaultCwd}
						onAttach={props.onAttach}
						onOpenRpc={props.onOpenRpc}
						onNewIn={props.onNewIn}
						onClose={() => props.onSwitcher(false)}
					/>
				)}
			</span>
			<span className="pn-header-actions">
				<IconButton label="New chat" onClick={props.onNewChat}>
					<Plus size={16} />
				</IconButton>
				<span className="pn-pop-anchor">
					<IconButton
						label="More"
						tip={more ? "none" : "below"}
						active={more}
						onClick={() => setMore(open => !open)}
					>
						<Ellipsis size={16} />
					</IconButton>
					{more && (
						<Menu
							entries={props.more}
							className="pn-pop pn-pop--below-right"
							width={240}
							dense
							autoFocus
							onClose={() => setMore(false)}
						/>
					)}
				</span>
			</span>
		</header>
	);
}
