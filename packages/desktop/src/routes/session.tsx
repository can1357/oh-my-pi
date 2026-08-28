import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import type { OpenTab, ShellContext } from "../app";
import { ApprovalDialog } from "../components/ApprovalDialog";
import { ApprovalModeBadge } from "../components/ApprovalModeBadge";
import { CompactDialog } from "../components/CompactDialog";
import { Composer } from "../components/Composer";
import { ComposerModal } from "../components/composer/ComposerModal";
import { useComposerDraft } from "../components/composer/useComposerDraft";
import { ModelPicker } from "../components/ModelPicker";
import { PlanModeBadge } from "../components/PlanModeBadge";
import { PlanStrip } from "../components/PlanStrip";
import { type PanelTab, RightPanel } from "../components/RightPanel";
import { StatusBar } from "../components/StatusBar";
import { Transcript } from "../components/Transcript";
import { compactionLabel, compactTokens } from "../rpc/compaction";
import { isTauri, onWindowDrop } from "../rpc/transport";
import { useBridge } from "../rpc/useBridge";
import { markViewed, setTabActivity } from "../shell/activity";
import { registerBridge } from "../shell/bridges";
import { notifyApprovalPending, notifyTurnComplete } from "../shell/notifications";

/**
 * Every open tab is rendered, not just the visible one.
 *
 * Hiding rather than unmounting is deliberate: a background tab's bridge has to
 * keep consuming its stream, or a turn started in one tab would stall the moment
 * you looked at another. The Rust pool bounds the cost — at most three sidecars
 * live at once, LRU-evicted — so "all tabs mounted" is not "all tabs resident".
 */
export function SessionRoute() {
	const { tabs, activeTabId, panelOpen, openPanel, adoptSession } = useOutletContext<ShellContext>();

	return (
		<>
			{tabs.map(tab => (
				<SessionView
					key={tab.tabId}
					tab={tab}
					visible={tab.tabId === activeTabId}
					panelOpen={panelOpen}
					openPanel={openPanel}
					adoptSession={adoptSession}
				/>
			))}
		</>
	);
}

function SessionView({
	tab,
	visible,
	panelOpen,
	openPanel,
	adoptSession,
}: {
	tab: OpenTab;
	visible: boolean;
	panelOpen: boolean;
	openPanel(): void;
	adoptSession: ShellContext["adoptSession"];
}) {
	// A session boots the first time it is looked at and stays running after
	// that, so switching away does not tear it down mid-turn.
	const started = useRef(false);
	if (visible) started.current = true;

	const { bridge, snapshot, restart } = useBridge(tab.tabId, {
		autoStart: started.current,
		sessionPath: tab.sessionPath,
		cwd: tab.cwd,
		onOpenUrl: async url => {
			await openUrl(url);
		},
	});

	const streaming = snapshot.state?.isStreaming === true;
	const failed = snapshot.status === "exited" || snapshot.status === "error";
	/*
	 * Coming up, with nothing to read yet. Previously the transcript's "Ask the
	 * agent something to get started." rendered right below the "Starting the
	 * agent…" banner: one told you to wait, the other to type, and the composer
	 * honoured the second — `agent_send` rejects with "no live session", the
	 * draft is cleared before the send, and the message is gone with no trace.
	 *
	 * Entries already on screen keep the transcript: content never disappears
	 * behind a spinner.
	 */
	const booting = snapshot.status === "starting" && snapshot.transcript.length === 0;
	const [cost, setCost] = useState<number | undefined>(undefined);
	const [confirmCompact, setConfirmCompact] = useState(false);
	const [panelTab, setPanelTab] = useState<PanelTab>("changes");

	// One draft per session, owned here so the inline row and the expanded modal
	// edit the same text rather than each keeping a copy.
	const composer = useComposerDraft({ bridge, commands: snapshot.commands, streaming });
	// One condition, read by both the row and the overlay, so they can never
	// disagree about whether the expanded editor exists.
	const modalOpen = visible && composer.expanded && !snapshot.pendingUi;

	/*
	 * Tell the shell which session this tab turned out to be.
	 *
	 * A chat started here is `new:N:/path` and has no identity anything else can
	 * recognise: clicking its own row in the sidebar used to append a second tab
	 * and a second sidecar on the same jsonl, and its status dot — looked up by
	 * session id — never lit. The state frame carries both fields; this is the
	 * first moment they exist.
	 */
	const reportedSessionId = snapshot.state?.sessionId;
	useEffect(() => {
		if (reportedSessionId) adoptSession(tab.tabId, reportedSessionId);
	}, [adoptSession, tab.tabId, reportedSessionId]);

	/*
	 * Stable, because `Transcript` is `memo`d and so are the cards beneath it. An
	 * inline arrow is a new prop on every render, which defeats all three: one
	 * keystroke in the composer re-rendered every message and every tool card.
	 */
	const reportToBanner = useCallback((cause: unknown) => bridge.reportError(cause), [bridge]);

	// Publish the bridge itself, so the sidebar's context menu can act on a live
	// session through the process that already owns it.
	useEffect(() => registerBridge(tab.tabId, bridge), [tab.tabId, bridge]);

	// Publish what this session is doing: the sidebar is the only place it shows,
	// and the close guard reads the same store.
	useEffect(() => {
		setTabActivity(tab.tabId, { streaming, attention: Boolean(snapshot.pendingUi) });
		/*
		 * `done` latches on the falling edge and only `markViewed` clears it, and
		 * that runs when a tab is ACTIVATED. The tab you are already on is never
		 * activated again, so its sidebar dot sat on "finished" while you were
		 * reading the very answer it was announcing — and returning to the window
		 * did not clear it either. Seeing it is what viewing means.
		 */
		if (visible && !streaming) markViewed(tab.tabId);
	}, [tab.tabId, streaming, snapshot.pendingUi, visible]);

	// Deliberately no cleanup: a session stays in the store while it is open, and
	// nothing closes sessions any more.

	// Notify only on the falling edge: entering idle is the moment worth
	// interrupting someone, not every render where streaming happens to be false.
	// The same edge refreshes the cost, which lives in `get_session_stats` rather
	// than the session state and is not worth polling for mid-turn.
	const wasStreaming = useRef(false);
	useEffect(() => {
		/*
		 * Only a live process finishes a turn. A crash, a kill or an eviction now
		 * lowers `isStreaming` as well, and that falling edge is a death rather
		 * than a completion: unguarded, a sidecar that dies in the background
		 * announces "the agent finished working" to the OS notification centre.
		 * A positive test on `ready` rather than a list of terminal statuses, so
		 * a status added later cannot silently rejoin this branch.
		 */
		if (wasStreaming.current && !streaming && snapshot.status === "ready") {
			notifyTurnComplete(snapshot.state?.model?.id, tab.tabId);
			void bridge
				.getSessionStats()
				.then(stats => setCost(typeof stats?.cost === "number" ? stats.cost : undefined))
				.catch(() => {});
		}
		wasStreaming.current = streaming;
	}, [streaming, snapshot.status, snapshot.state?.model?.id, bridge]);

	const pendingUiId = snapshot.pendingUi?.id;
	useEffect(() => {
		if (pendingUiId) notifyApprovalPending("The agent is waiting for your approval.", tab.tabId);
	}, [pendingUiId]);

	// The pool reclaims background processes by design. Resume on the way back in,
	// rather than leaving a session that silently accepts nothing.
	useEffect(() => {
		if (visible && snapshot.status === "suspended") void restart().catch(() => {});
	}, [visible, snapshot.status, restart]);

	/*
	 * Window drops belong to Tauri, not to the webview.
	 *
	 * `dragDropEnabled` defaults to true, which switches the webview's own HTML5
	 * drag-and-drop off — so the composer's `onDrop` never fired in the packaged
	 * app, and dragging a file onto the window did nothing at all. Tauri reports
	 * paths instead, at window scope, so this listener belongs to whichever
	 * session is on screen rather than to any one element.
	 */
	useEffect(() => {
		if (!visible || !isTauri()) return;
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void onWindowDrop({
			over: () => composer.setDropping(true),
			leave: () => composer.setDropping(false),
			drop: paths => {
				composer.setDropping(false);
				void composer.addDroppedPaths(paths);
			},
		}).then(stop => {
			if (cancelled) stop();
			else unlisten = stop;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [visible, composer.setDropping, composer.addDroppedPaths]);

	// Esc aborts the turn — but only in the tab you are looking at, and not while
	// a dialog owns the key.
	useEffect(() => {
		if (!visible) return;
		const onKey = (event: KeyboardEvent) => {
			// `defaultPrevented` is how an overlay claims the key. React's
			// `stopPropagation` cannot help here: React dispatches at its root
			// container and the native event still reaches `window`. Without this,
			// closing the ⌘K palette or the model menu mid-turn also killed the turn.
			if (event.key !== "Escape" || !streaming || snapshot.pendingUi || event.defaultPrevented) return;
			event.preventDefault();
			void bridge.abort().catch(() => {});
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [bridge, streaming, snapshot.pendingUi, visible]);

	return (
		<>
			<main className="omp-main" hidden={!visible}>
				{/*
				 * One wrapper, so `.omp-main` always has exactly three children. The
				 * grid is `auto 1fr auto`; with four independent conditionals the row a
				 * child landed in depended on how many banners happened to be up, and
				 * the first one took the flexible row and stretched to fill the pane.
				 */}
				<div className="omp-main__banners">
					{snapshot.status === "exited" ? (
						<div className="omp-banner omp-banner--error">
							<span>
								The agent process exited
								{snapshot.exit?.code !== null && snapshot.exit !== null ? ` (code ${snapshot.exit.code})` : ""}.
								Its transcript is safe on disk.
							</span>
							<button
								type="button"
								data-component="button"
								data-variant="primary"
								data-size="normal"
								onClick={() => void restart()}
							>
								Restart
							</button>
						</div>
					) : null}

					{snapshot.status === "suspended" && visible ? (
						<div className="omp-banner omp-banner--info">Resuming this session…</div>
					) : null}

					{/*
					 * Not gated on `status === "error"`. A failed `switch_session` or a
					 * history that would not load record an error while the status is
					 * already `ready` — `#settle` promotes on any correlated reply,
					 * including a failure one. Gated, those messages were written to a
					 * channel nothing read, and the tab went on showing the wrong
					 * session in silence.
					 */}
					{/*
					 * Inside this wrapper, never beside it: `.omp-main` is
					 * `grid-template-rows: auto 1fr auto` and a fourth child would take
					 * the flexible row from the transcript.
					 *
					 * A manual compaction pushes no frames while it runs, so there is
					 * nothing to turn into a percentage. The honest signal is that it
					 * is alive, what it is doing, and a way out.
					 */}
					{snapshot.compaction ? (
						<div className="omp-banner omp-banner--info">
							<span className="omp-working" aria-hidden="true">
								<span />
								<span />
								<span />
							</span>
							<span>
								{compactionLabel(snapshot.compaction)}
								{snapshot.compaction.tokensBefore !== undefined
									? ` · ${compactTokens(snapshot.compaction.tokensBefore)} now`
									: ""}
							</span>
							{snapshot.compaction.note ? (
								<span className="omp-banner__note">{snapshot.compaction.note}</span>
							) : null}
							{/*
							 * Only the manual pass can be stopped, and only because it is
							 * dispatched through `/compact`: the `compact` command would
							 * hold the queue this abort has to travel through.
							 */}
							{snapshot.compaction.origin === "manual" ? (
								<button
									type="button"
									data-component="button"
									data-variant="ghost"
									data-size="normal"
									onClick={() => void bridge.cancelCompaction()}
								>
									Cancel
								</button>
							) : null}
						</div>
					) : null}

					{/*
					 * Amber, not red. The engine says this when a compaction method
					 * reclaimed something but not enough and it is moving to the next
					 * one — the terminal shows the same text as a warning.
					 */}
					{snapshot.warning ? (
						<div className="omp-banner omp-banner--warn">
							<span>{snapshot.warning}</span>
							<button
								type="button"
								className="omp-banner__dismiss"
								aria-label="Dismiss"
								onClick={() => bridge.clearWarning()}
							>
								×
							</button>
						</div>
					) : null}

					{snapshot.error ? (
						<div className="omp-banner omp-banner--error">
							<span>{snapshot.error}</span>
							{/* `#error` used to survive until the app restarted. */}
							<button
								type="button"
								className="omp-banner__dismiss"
								aria-label="Dismiss"
								onClick={() => bridge.clearError()}
							>
								×
							</button>
						</div>
					) : null}

					{/*
					 * The reason it died, next to the fact that it died. This is captured
					 * on every session but used to be rendered only by the probe route,
					 * which runs its own separate sidecar — so it never showed the output
					 * of the session that actually failed.
					 */}
					{failed && snapshot.stderr.length > 0 ? (
						<pre className="omp-stall__log">{snapshot.stderr.join("\n")}</pre>
					) : null}
				</div>

				{booting ? (
					<div className="omp-transcript">
						<div className="omp-empty">
							{snapshot.stalled ? (
								<div className="omp-stall">
									<span>
										The agent has not answered yet. It may still be coming up, or it may have failed to start.
									</span>
									{snapshot.stderr.length > 0 ? (
										<pre className="omp-stall__log">{snapshot.stderr.join("\n")}</pre>
									) : null}
									<button
										type="button"
										data-component="button"
										data-variant="primary"
										data-size="normal"
										onClick={() => void restart()}
									>
										Restart
									</button>
								</div>
							) : (
								"Starting the agent… first launch takes a few seconds."
							)}
						</div>
					</div>
				) : (
					<Transcript entries={snapshot.transcript} streaming={streaming} onError={reportToBanner} />
				)}

				<div>
					<PlanStrip
						phases={snapshot.todoPhases}
						onOpen={() => {
							setPanelTab("todos");
							openPanel();
						}}
					/>
					<Composer bridge={bridge} composer={composer} modalOpen={modalOpen} disabled={booting} />
					<div className="omp-statusbar__wrap">
						<StatusBar snapshot={snapshot} cwd={tab.cwd} cost={cost} onCompact={() => setConfirmCompact(true)}>
							<ModelPicker bridge={bridge} state={snapshot.state} />
							<PlanModeBadge bridge={bridge} state={snapshot.state} />
							<ApprovalModeBadge />
						</StatusBar>
					</div>
				</div>
			</main>

			{/*
			 * `visible` for the same reason the expanded composer carries it: this
			 * renders beside `<main>`, outside the `hidden` that keeps background
			 * sessions off screen. Open the dialog, switch tabs, and without this
			 * it would sit over whichever session you switched to.
			 */}
			{confirmCompact && visible ? (
				<CompactDialog
					tokens={snapshot.state?.contextUsage?.tokens}
					contextWindow={snapshot.state?.contextUsage?.contextWindow}
					streaming={streaming}
					onCancel={() => setConfirmCompact(false)}
					onConfirm={() => {
						setConfirmCompact(false);
						void bridge.startCompaction().catch(() => {
							/* the bridge records it; the banner shows it */
						});
					}}
				/>
			) : null}

			{visible && panelOpen ? (
				<RightPanel
					bridge={bridge}
					ready={snapshot.status === "ready" && snapshot.booted}
					streaming={streaming}
					todoPhases={snapshot.todoPhases}
					tab={panelTab}
					onTab={setPanelTab}
					subagentCount={snapshot.subagents.length}
				/>
			) : null}

			{/*
			 * Sibling of `<main>`, never a portal — a portal would escape the
			 * `hidden` that keeps background sessions off screen, and every one of
			 * them would paint its modal over this one. `!pendingUi` keeps it from
			 * fighting the approval dialog for Escape; the draft survives either way
			 * because it lives in the hook, not in the modal.
			 */}
			{modalOpen ? <ComposerModal composer={composer} /> : null}

			{visible && snapshot.pendingUi ? <ApprovalDialog request={snapshot.pendingUi} bridge={bridge} /> : null}
		</>
	);
}
