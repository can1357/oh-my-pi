import type { Participant } from "@oh-my-pi/pi-wire";
import { LogOut, PanelRight, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";
import { shortenPath } from "../../lib/format";
import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
}

/** Names listed before collapsing the rest into "+N". */
const MAX_NAMES = 3;

/** Who's here, as a quiet text line matching the transcript bylines — no avatar badges. */
function Presence({ participants }: { participants: readonly Participant[] }): ReactNode {
	const shown = participants.slice(0, MAX_NAMES);
	const extra = participants.length - shown.length;
	const names = participants.map(p => `${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`).join("\n");
	return (
		<span className="sh-presence" title={names} aria-label={`${participants.length} in session: ${names}`}>
			<Users size={13} aria-hidden="true" />
			<span className="sh-presence-names">
				{shown.map(p => p.name).join(", ")}
				{extra > 0 && <span className="sh-presence-more"> +{extra}</span>}
			</span>
			<span className="sh-presence-count">{participants.length}</span>
		</span>
	);
}

export function HeaderBar({ snapshot, subCount, railOpen, onToggleRail, onLeave }: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? "session";

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<BrandMark size={18} />
				<div className="sh-heading">
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
				<span className={`sh-live sh-live-${phase}`} title={`connection · ${phase}`}>
					<span className="sh-live-dot" />
					<span className="sh-live-label">{PHASE_LABEL[phase]}</span>
				</span>
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state && state.participants.length > 0 && <Presence participants={state.participants} />}
				<span className="sh-sep" aria-hidden="true" />
				<button
					type="button"
					className={railOpen ? "sh-iconbtn sh-iconbtn-on" : "sh-iconbtn"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
					aria-pressed={railOpen}
				>
					<PanelRight size={15} />
					{subCount > 0 && <span className="sh-count">{subCount}</span>}
				</button>
				<ThemeToggle />
				<button type="button" className="sh-iconbtn" onClick={onLeave} title="leave session">
					<LogOut size={15} />
				</button>
			</div>
		</header>
	);
}
