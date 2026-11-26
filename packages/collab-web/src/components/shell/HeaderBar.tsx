import type { SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { LogOut, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { OmpMark } from "./OmpMark";
import { ThemeToggle } from "./ThemeToggle";

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

export interface HeaderBarProps {
	header: SessionHeader | null;
	state: SessionState | null;
	phase: ConnectionPhase;
	readOnly: boolean;
	subCount: number;
	railOpen: boolean;
	railControlsId?: string;
	onToggleRail(): void;
	onLeave(): void;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const HeaderBar = memo(function HeaderBar({
	header,
	state,
	phase,
	readOnly,
	subCount,
	railOpen,
	railControlsId = "agents-rail",
	onToggleRail,
	onLeave,
}: HeaderBarProps): ReactNode {
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
				<span className="sh-brand" aria-label="omp collab">
					<OmpMark />
					<span className="sh-brand-slash" aria-hidden="true">
						/
					</span>
				</span>
				<h1 className="sh-title" title={title}>
					{title}
				</h1>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<nav className="sh-header-right" aria-label="Session controls">
				<span
					className={`sh-status sh-status-${phase}`}
					role="status"
					aria-live="polite"
					aria-label={`Connection status: ${PHASE_LABEL[phase]}`}
					title={`connection: ${phase}`}
				>
					<span className={`sh-dot sh-dot-${phase}`} aria-hidden="true" />
					<span className="sh-status-text">{PHASE_LABEL[phase]}</span>
				</span>
				{readOnly && (
					<span className="sh-chip sh-chip-readonly" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`context · ${fmtPercent(pct)}`}
						aria-label={`Context usage ${fmtPercent(pct)}`}
					>
						<span className="sh-gauge-track" aria-hidden="true">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars" aria-label={`${state.participants.length} participants`}>
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
				<ThemeToggle />
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					aria-expanded={railOpen}
					aria-controls={railControlsId}
					aria-label={railOpen ? "Hide agents panel" : "Show agents panel"}
					title={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={16} aria-hidden="true" />
					{subCount > 0 && (
						<span className="sh-badge" aria-label={`${subCount} subagents`}>
							{subCount}
						</span>
					)}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={onLeave}
					aria-label="Leave session"
					title="leave session"
				>
					<LogOut size={16} aria-hidden="true" />
				</button>
			</nav>
		</header>
	);
});
