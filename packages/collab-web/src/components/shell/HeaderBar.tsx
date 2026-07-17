import { History, LogOut, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { ThemeToggle } from "./ThemeToggle";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onOpenSessions(): void;
	onLeave(): void;
}

export function HeaderBar({
	snapshot,
	subCount,
	railOpen,
	onToggleRail,
	onOpenSessions,
	onLeave,
}: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? "session";
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<button
					type="button"
					className={
						railOpen ? "sh-btn sh-btn-icon sh-btn-on sh-sidebar-toggle" : "sh-btn sh-btn-icon sh-sidebar-toggle"
					}
					onClick={onToggleRail}
					title={railOpen ? "hide session agents" : "show session agents"}
					aria-label={railOpen ? "Hide session agents" : "Show session agents"}
				>
					<PanelLeft size={14} />
					{subCount > 0 && !railOpen && <span className="sh-badge">{subCount}</span>}
				</button>
				<div className="sh-title-group">
					<span className="sh-title" title={title}>
						{title}
					</span>
					{state?.cwd && (
						<span className="sh-cwd" title={state.cwd}>
							{shortenPath(state.cwd)}
						</span>
					)}
				</div>
			</div>
			<div className="sh-header-right">
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`context · ${fmtPercent(pct)}`}
					>
						<span className="sh-gauge-track">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				{!readOnly && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onOpenSessions}
						title="browse host sessions"
						aria-label="Browse host sessions"
					>
						<History size={14} />
					</button>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phase} />
				<ThemeToggle />
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={onLeave}
					title="leave session"
					aria-label="Leave session"
				>
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
