import { LogOut, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { useCollabI18n } from "../../lib/i18n";
import { ThemeToggle } from "./ThemeToggle";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
}

export function HeaderBar({ snapshot, subCount, railOpen, onToggleRail, onLeave }: HeaderBarProps): ReactNode {
	const { i18n } = useCollabI18n();
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? i18n.t("collab.shell.session");
	const phaseLabel =
		phase === "connecting"
			? i18n.t("collab.phase.connecting")
			: phase === "waiting"
				? i18n.t("collab.phase.waiting")
				: phase === "live"
					? i18n.t("collab.phase.live")
					: phase === "reconnecting"
						? i18n.t("collab.phase.reconnecting")
						: i18n.t("collab.phase.ended");
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
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				{readOnly && (
					<span className="sh-chip" title={i18n.t("collab.shell.readOnlyTitle")}>
						{i18n.t("collab.shell.readOnly")}
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={i18n.t("collab.shell.context", { percent: fmtPercent(pct) })}
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
								title={`${p.name} · ${p.role}${p.readOnly ? ` · ${i18n.t("collab.shell.viewOnly")}` : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phaseLabel} />
				<ThemeToggle />
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? i18n.t("collab.shell.hideAgents") : i18n.t("collab.shell.showAgents")}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={onLeave}
					title={i18n.t("collab.shell.leaveSession")}
				>
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
