import type { RemoteSessionScope, RemoteSessionSnapshot } from "@pk-nerdsaver-ai/pi-wire";
import { RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { GuestClient, RemoteSessionList } from "../../lib/client";
import { relTime, shortenPath } from "../../lib/format";
import "./sessions.css";

type ListState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; list: RemoteSessionList };

const SCOPES: readonly RemoteSessionScope[] = ["project", "all"];

export function SessionDrawer(props: { client: GuestClient; onClose(): void }): ReactNode {
	const { client, onClose } = props;
	const [scope, setScope] = useState<RemoteSessionScope>("project");
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [loadingPath, setLoadingPath] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const refresh = useCallback(
		async (nextScope: RemoteSessionScope): Promise<void> => {
			setState({ kind: "loading" });
			const result = await client.listSessions(nextScope);
			if (!result.ok) {
				setState({ kind: "error", message: result.error });
				return;
			}
			setState({ kind: "loaded", list: result.list });
		},
		[client],
	);

	useEffect(() => {
		void refresh(scope);
	}, [refresh, scope]);

	const load = async (session: RemoteSessionSnapshot): Promise<void> => {
		if (loadingPath !== null) return;
		setLoadError(null);
		setLoadingPath(session.path);
		const result = await client.loadSession(session.path);
		if (result.ok) {
			// The host resumes the session and resyncs every guest with a fresh welcome.
			onClose();
			return;
		}
		setLoadingPath(null);
		setLoadError(result.error);
	};

	return (
		<aside className="ss-drawer" role="dialog" aria-label="Host sessions">
			<header className="ss-drawer-head">
				<div className="ss-drawer-title">
					<span className="ss-drawer-name">host sessions</span>
					<span className="ss-scope" role="group" aria-label="session scope">
						{SCOPES.map(value => (
							<button
								key={value}
								type="button"
								className={scope === value ? "ss-scope-btn ss-scope-btn--active" : "ss-scope-btn"}
								onClick={() => setScope(value)}
							>
								{value}
							</button>
						))}
					</span>
				</div>
				<div className="ss-drawer-actions">
					<button
						type="button"
						className="ss-iconbtn"
						aria-label="refresh sessions"
						title="refresh"
						onClick={() => void refresh(scope)}
					>
						<RefreshCw size={14} aria-hidden />
					</button>
					<button type="button" className="ss-iconbtn" aria-label="close sessions" title="close" onClick={onClose}>
						<X size={15} aria-hidden />
					</button>
				</div>
			</header>
			<div className="ss-drawer-body">
				{state.kind === "loading" && <div className="ss-empty">loading sessions…</div>}
				{state.kind === "error" && (
					<div className="ss-empty">
						<div>{state.message}</div>
						<button type="button" className="ss-btn" onClick={() => void refresh(scope)}>
							retry
						</button>
					</div>
				)}
				{state.kind === "loaded" && state.list.sessions.length === 0 && (
					<div className="ss-empty">no sessions found</div>
				)}
				{state.kind === "loaded" &&
					state.list.sessions.map(session => {
						const isCurrent = state.list.currentPath === session.path;
						const isLoading = loadingPath === session.path;
						return (
							<button
								key={session.path}
								type="button"
								className="ss-row"
								disabled={loadingPath !== null}
								onClick={() => void load(session)}
							>
								<span className="ss-row-head">
									<span className="ss-row-name">
										{session.title?.trim() || session.firstMessage.trim() || session.id}
									</span>
									{isCurrent ? (
										<span className="ss-chip ss-chip--current">current</span>
									) : (
										session.status && <span className="ss-chip">{session.status}</span>
									)}
								</span>
								<span className="ss-row-cwd" title={session.cwd}>
									{shortenPath(session.cwd)}
								</span>
								<span className="ss-row-meta">
									<span>{session.messageCount} msgs</span>
									<span className="ss-row-meta-when">
										{isLoading ? "loading…" : relTime(Date.parse(session.modified))}
									</span>
								</span>
							</button>
						);
					})}
			</div>
			{loadError && <div className="ss-error">{loadError}</div>}
		</aside>
	);
}
