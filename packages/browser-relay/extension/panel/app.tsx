/**
 * The side panel: owns which session is showing, turns composer output into prompts with the tab context block,
 * keeps each conversation's tabs grouped and their page overlays in step with the session, and hosts the sheets.
 */
import { OmpMark } from "@oh-my-pi/collab-web/src/components/shell/OmpMark";
import type { Notice } from "@oh-my-pi/collab-web/src/lib/client";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { ImagePlus, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
	GifFrame,
	PanelCollabHost,
	PanelEvent,
	RelayStatus,
	RpcSessionInfo,
	Shortcut,
	TabActivity,
	TabContext,
	TeachStep,
} from "../messages";
import { Composer, type ComposerCommand, type ComposerHandle, type Outgoing, type Strip } from "./composer";
import { type Attached, Header, hostTitle } from "./header";
import { imageSize } from "./images";
import type { PanelModel, PanelSession, PanelSnapshot } from "./session";
import { openCollabSession, openRpcSession } from "./sessions/index";
import { SettingsSheet } from "./sheets/settings";
import { type ShortcutDraft, ShortcutSheet } from "./sheets/shortcut";
import { TeachSheet, teachPromptText, teachShots } from "./sheets/teach";
import {
	applyTheme,
	DEFAULT_SUGGESTIONS,
	sanitizeShortcutName,
	useSettings,
	useShortcuts,
	useStored,
	useSuggestions,
} from "./storage";
import { composePrompt, drivableTab, hostOf, tabContextBlock, tabViewport } from "./tab-context";
import { buildCommitted, buildTimeline, lastUserPrompt, liveVerb, transcriptMarkdown } from "./timeline";
import { ActiveTabContext, latestRunShots, Transcript } from "./transcript";
import { Favicon, type MenuEntry, useEscapeFallback } from "./ui";
import type { WorkerClient } from "./worker-client";

/** Name the panel joins collab rooms under; the terminal shows it next to panel prompts. */
const GUEST_NAME = "chrome";
/** chrome.storage.local key (panel-owned): directories recent panel sessions started in, newest first. */
const RECENT_DIRS_KEY = "omp.recentDirs";
/** chrome.storage.session key (panel-owned): tabs and tab group of each conversation, by session id. */
const CONVERSATIONS_KEY = "omp.panel.conversations";
const TOAST_MS = 3000;
const ERROR_TOAST_MS = 6000;
const COMPACTION_NOTICE = /^(?:compacting context|context compacted|compaction (?:aborted|failed))/i;

/** The tabs a conversation works in and the tab group that holds them. */
interface Conversation {
	tabIds: number[];
	groupId?: number;
}

type SheetState =
	| { kind: "settings" }
	| { kind: "shortcut"; draft: ShortcutDraft; from: "settings" | null }
	| { kind: "teach" };

const EMPTY_SNAPSHOT: PanelSnapshot = {
	phase: "live",
	endedReason: null,
	header: null,
	entries: [],
	state: null,
	stream: null,
	streamDone: false,
	activeTools: new Map(),
	working: false,
	readOnly: false,
	uiRequest: null,
	notices: [],
	agents: [],
	progress: new Map(),
	lifecycle: new Map(),
};

function normalizeDirs(raw: unknown): string[] {
	return Array.isArray(raw) ? raw.filter((dir): dir is string => typeof dir === "string") : [];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** A session title from the first prompt: its first few words. */
function titleFrom(prompt: string): string {
	const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
	return words.length > 40 ? `${words.slice(0, 39)}…` : words || "New chat";
}

/** The most recently started omp the panel may control. */
function newestHost(hosts: readonly PanelCollabHost[]): PanelCollabHost | undefined {
	return hosts.filter(host => host.access === "control").sort((a, b) => b.startedAt - a.startedAt)[0];
}

function useSnapshot(session: PanelSession | null): PanelSnapshot | null {
	const subscribe = useCallback(
		(listener: () => void) => (session === null ? () => undefined : session.subscribe(listener)),
		[session],
	);
	const getSnapshot = useCallback(() => (session === null ? null : session.getSnapshot()), [session]);
	return useSyncExternalStore(subscribe, getSnapshot);
}

/** Resolves with the text of the reply to a prompt sent after entry `from`, once that turn has ended. */
function replyAfter(session: PanelSession, from: number): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let sawWork = false;
		const finish = (settle: () => void): void => {
			window.clearTimeout(timer);
			unsubscribe();
			settle();
		};
		const check = (): void => {
			const snapshot = session.getSnapshot();
			if (snapshot.phase === "ended")
				return finish(() => reject(new Error(snapshot.endedReason ?? "The session ended")));
			if (snapshot.working) {
				sawWork = true;
				return;
			}
			if (!sawWork) return;
			let text = "";
			for (const entry of snapshot.entries.slice(from)) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const message = entry.message;
				if (message.stopReason === "error" || message.stopReason === "aborted")
					return finish(() => reject(new Error(message.errorMessage ?? "The turn was stopped")));
				for (const block of message.content)
					if (block.type === "text" && block.text.trim() !== "") text = block.text;
			}
			// The turn's entries can land a beat after `working` clears; wait for them.
			if (text !== "") finish(() => resolve(text));
		};
		const timer = window.setTimeout(() => finish(() => reject(new Error("omp did not answer in time"))), 300_000);
		const unsubscribe = session.subscribe(check);
	});
}

/** A reply that is only a prompt, without the code fence models like to wrap it in. */
function unfence(text: string): string {
	const fenced = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(text);
	return (fenced === null ? text : fenced[1]).trim();
}

function Toasts({ notices, onDismiss }: { notices: readonly Notice[]; onDismiss(id: number): void }): ReactNode {
	const [, tick] = useState(0);
	const now = Date.now();
	const visible = notices
		.filter(notice => notice.at + (notice.level === "error" ? ERROR_TOAST_MS : TOAST_MS) > now)
		.slice(-3);
	useEffect(() => {
		if (visible.length === 0) return;
		const soonest = Math.min(
			...visible.map(notice => notice.at + (notice.level === "error" ? ERROR_TOAST_MS : TOAST_MS)),
		);
		const timer = window.setTimeout(() => tick(count => count + 1), Math.max(50, soonest - Date.now()));
		return () => window.clearTimeout(timer);
	});
	if (visible.length === 0) return null;
	return (
		<div className="sh-toasts pn-toasts">
			{visible.map(notice => (
				<div key={notice.id} className={`sh-toast sh-toast-${notice.level}`} role="status">
					<span className="sh-toast-msg">{notice.message}</span>
					<button
						type="button"
						className="sh-toast-close"
						aria-label="Dismiss"
						onClick={() => onDismiss(notice.id)}
					>
						<X size={12} />
					</button>
				</div>
			))}
		</div>
	);
}

function EmptyState(props: {
	tab: TabContext | null;
	suggestions: Record<string, string[]>;
	onPick(prompt: string): void;
}): ReactNode {
	const { tab } = props;
	const prompts = (tab === null ? undefined : props.suggestions[hostOf(tab.url)]) ?? DEFAULT_SUGGESTIONS;
	return (
		<div className="pn-empty">
			<div className="pn-empty-tile">
				{tab === null ? <OmpMark size={20} /> : <Favicon src={tab.favIconUrl} size={20} />}
			</div>
			<div className="pn-empty-title">{tab === null ? "No tab attached" : tab.title || hostOf(tab.url)}</div>
			<div className="pn-empty-pills">
				{prompts.slice(0, 3).map(prompt => (
					<button key={prompt} type="button" className="pn-pill" onClick={() => props.onPick(prompt)}>
						<span>{prompt}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function SecondaryTab(props: { session: RpcSessionInfo; onOpen(): void }): ReactNode {
	return (
		<div className="pn-secondary">
			<div className="pn-secondary-card">
				<div className="pn-empty-tile">
					<OmpMark size={22} />
				</div>
				<div className="pn-secondary-title">omp is working in another tab</div>
				<div className="pn-secondary-name">{props.session.title}</div>
				<button type="button" className="sh-btn sh-btn-primary pn-btn pn-btn--open" onClick={props.onOpen}>
					Open chat
				</button>
			</div>
		</div>
	);
}

/** The panel application. */
export function App({ worker, windowId }: { worker: WorkerClient; windowId: number }): ReactNode {
	const settings = useSettings();
	const shortcuts = useShortcuts();
	const suggestions = useSuggestions();
	const recentDirs = useStored(RECENT_DIRS_KEY, normalizeDirs);

	const [relay, setRelay] = useState<RelayStatus | null>(null);
	const [activeTab, setActiveTab] = useState<TabContext | null>(null);
	const [hosts, setHosts] = useState<PanelCollabHost[]>([]);
	const [rpcSessions, setRpcSessions] = useState<RpcSessionInfo[]>([]);
	const [session, setSession] = useState<PanelSession | null>(null);
	const [attached, setAttached] = useState<Attached | null>(null);
	const [booted, setBooted] = useState(false);
	const [sheet, setSheet] = useState<SheetState | null>(null);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [strip, setStrip] = useState<Strip | null>(null);
	const [dismissedStrip, setDismissedStrip] = useState<string | null>(null);
	const [toasts, setToasts] = useState<Notice[]>([]);
	const [dismissedToasts, setDismissedToasts] = useState<ReadonlySet<number>>(new Set());
	const [compacting, setCompacting] = useState(false);
	const [followSignal, setFollowSignal] = useState(0);
	const [lastPrompt, setLastPrompt] = useState<string | null>(null);
	const [drop, setDrop] = useState<"idle" | "ok" | "bad">("idle");
	const [conversations, setConversations] = useState<Record<string, Conversation>>({});

	const composerRef = useRef<ComposerHandle | null>(null);
	const toastSeq = useRef(0);
	const sessionRef = useRef<PanelSession | null>(null);
	sessionRef.current = session;
	const conversationsRef = useRef(conversations);
	conversationsRef.current = conversations;
	const rpcSessionsRef = useRef(rpcSessions);
	rpcSessionsRef.current = rpcSessions;
	/** Last activity sent per tab, so the worker only hears changes. */
	const sentActivity = useRef(new Map<number, string>());

	const snapshot = useSnapshot(session);
	const view = snapshot ?? EMPTY_SNAPSHOT;
	const working = view.working;
	const title =
		session === null ? "New chat" : (view.state?.sessionName ?? view.header?.title ?? session.title) || "omp";
	const conversation = session === null ? undefined : conversations[session.id];

	const notify = useCallback((level: Notice["level"], message: string): void => {
		// Negative ids keep panel toasts apart from the session's own notices.
		setToasts(list => [...list.slice(-20), { id: --toastSeq.current, level, message, at: Date.now() }]);
	}, []);

	// Not before the stored settings arrive: the default would overwrite the theme mirrored for the next boot.
	useEffect(() => {
		if (settings.ready) applyTheme(settings.value.theme);
	}, [settings.ready, settings.value.theme]);

	// ---- conversations (tabs + group per session) ----
	useEffect(() => {
		void chrome.storage.session.get(CONVERSATIONS_KEY).then(stored => {
			const raw: unknown = stored[CONVERSATIONS_KEY];
			if (!isRecord(raw)) return;
			const restored: Record<string, Conversation> = {};
			for (const id in raw) {
				const value = raw[id];
				if (!isRecord(value) || !Array.isArray(value.tabIds)) continue;
				restored[id] = {
					tabIds: value.tabIds.filter((tabId): tabId is number => typeof tabId === "number"),
					groupId: typeof value.groupId === "number" ? value.groupId : undefined,
				};
			}
			setConversations(current => ({ ...restored, ...current }));
		});
	}, []);
	const updateConversation = useCallback((id: string, next: Conversation): void => {
		const all = { ...conversationsRef.current, [id]: next };
		conversationsRef.current = all;
		setConversations(all);
		void chrome.storage.session.set({ [CONVERSATIONS_KEY]: all });
	}, []);

	// ---- sessions ----
	const idleTabs = useCallback(
		(tabIds: readonly number[]): void => {
			for (const tabId of tabIds) {
				if (!sentActivity.current.delete(tabId)) continue;
				void worker.request("setActivity", { tabId, activity: { state: "idle" } }).catch(() => undefined);
			}
		},
		[worker],
	);

	const show = useCallback(
		(next: PanelSession | null, as: Attached | null): void => {
			const previous = sessionRef.current;
			if (previous !== null && previous !== next) {
				// Nobody watches that session from here anymore, so nothing would ever clear its tags.
				idleTabs(conversationsRef.current[previous.id]?.tabIds ?? []);
				previous.detach();
			}
			sessionRef.current = next;
			setSession(next);
			setAttached(as);
			setCompacting(false);
			setLastPrompt(null);
			setStrip(null);
			setFollowSignal(count => count + 1);
		},
		[idleTabs],
	);

	const attachHost = useCallback(
		async (host: PanelCollabHost): Promise<void> => {
			try {
				const { url } = await worker.request("collabLink", { instanceId: host.instanceId });
				show(openCollabSession(url, GUEST_NAME), { kind: "collab", instanceId: host.instanceId });
			} catch (error) {
				setStrip({
					tone: "error",
					message: `Couldn’t attach to ${hostTitle(host)}: ${errorText(error)}`,
					action: { label: "Retry", run: () => void attachHost(host) },
				});
			}
		},
		[worker, show],
	);

	const openRpc = useCallback(
		(info: RpcSessionInfo): PanelSession => {
			const next = openRpcSession(worker, info);
			if (conversationsRef.current[next.id] === undefined && info.tabIds.length > 0)
				updateConversation(next.id, { tabIds: info.tabIds });
			show(next, { kind: "rpc", sessionKey: info.sessionKey });
			return next;
		},
		[worker, show, updateConversation],
	);

	const startRpc = useCallback(
		async (cwd: string, sessionTitle: string, tabIds: number[]): Promise<PanelSession> => {
			const info = await worker.request("rpcOpen", { cwd, title: sessionTitle, tabIds });
			recentDirs.set(list => [cwd, ...list.filter(dir => dir !== cwd)].slice(0, 8));
			return openRpc(info);
		},
		[worker, openRpc, recentDirs.set],
	);

	const newChat = useCallback((): void => {
		// Already on the newest omp: a new chat is then a blank panel chat, never a hop to some other terminal.
		const host = settings.value.newChat === "attach" ? newestHost(hosts) : undefined;
		if (host !== undefined && !(attached?.kind === "collab" && attached.instanceId === host.instanceId))
			void attachHost(host);
		else show(null, null);
		composerRef.current?.focus();
	}, [attached, settings.value.newChat, hosts, attachHost, show]);

	const refreshHosts = useCallback((): Promise<PanelCollabHost[]> => {
		return worker.request("collabHosts", {}).then(
			list => {
				setHosts(list);
				return list;
			},
			// No relay, no running omp to list; the banner already says the relay is down.
			() => {
				setHosts([]);
				return [];
			},
		);
	}, [worker]);

	// ---- worker state ----
	const refresh = useCallback(async (): Promise<{
		tab: TabContext | null;
		sessions: RpcSessionInfo[];
		hostList: PanelCollabHost[];
	}> => {
		const [status, tab, sessions, hostList] = await Promise.all([
			worker.request("relayStatus", {}).catch(() => null),
			worker.request("activeTab", { windowId }).catch(() => null),
			worker.request("rpcSessions", {}).catch((): RpcSessionInfo[] => []),
			refreshHosts(),
		]);
		setRelay(status);
		setActiveTab(drivableTab(tab));
		setRpcSessions(sessions);
		return { tab, sessions, hostList };
	}, [worker, windowId, refreshHosts]);

	// Boot: land on the conversation this tab already belongs to, else the configured default.
	useEffect(() => {
		if (booted || !settings.ready) return;
		let alive = true;
		void refresh().then(({ tab, sessions, hostList }) => {
			if (!alive) return;
			setBooted(true);
			const mine =
				tab === null ? undefined : sessions.find(info => info.exited === undefined && info.tabIds[0] === tab.tabId);
			if (mine !== undefined) {
				openRpc(mine);
				return;
			}
			const owned =
				tab !== null && sessions.some(info => info.exited === undefined && info.tabIds.includes(tab.tabId));
			const host = settings.value.newChat === "attach" && !owned ? newestHost(hostList) : undefined;
			if (host !== undefined) void attachHost(host);
		});
		return () => {
			alive = false;
		};
	}, [booted, settings.ready, settings.value.newChat, refresh, openRpc, attachHost]);

	const stop = useCallback((): void => {
		const target = sessionRef.current;
		if (target === null) return;
		target.abort().catch(error => {
			setStrip({
				tone: "error",
				message: `Stop didn’t reach omp: ${errorText(error)}`,
				action: { label: "Retry", run: stop },
			});
		});
	}, []);

	useEffect(() => {
		const onEvent = (event: PanelEvent): void => {
			switch (event.event) {
				case "relay":
					setRelay(event.status);
					if (event.status.connected) void refreshHosts();
					break;
				case "activeTab":
					if (event.windowId === windowId) setActiveTab(drivableTab(event.tab));
					break;
				case "rpcSessions":
					setRpcSessions(event.sessions);
					break;
				case "overlay": {
					const current = sessionRef.current;
					const mine =
						current !== null && (conversationsRef.current[current.id]?.tabIds.includes(event.tabId) ?? false);
					if (event.action === "stop") {
						if (mine) stop();
					} else if (!mine) {
						const owner = rpcSessionsRef.current.find(
							info => info.exited === undefined && info.tabIds.includes(event.tabId),
						);
						if (owner !== undefined) openRpc(owner);
					}
					break;
				}
				case "scheduledRun":
					// Only when the panel is showing nothing: a schedule must never pull the user out of a chat.
					if (sessionRef.current === null) openRpc(event.session);
					break;
				default:
					break;
			}
		};
		const offEvent = worker.onEvent(onEvent);
		// A restarted worker has no memory of this panel; re-read everything it pushes.
		const offConnection = worker.onConnection(connected => {
			if (connected) void refresh();
		});
		return () => {
			offEvent();
			offConnection();
		};
	}, [worker, windowId, refresh, refreshHosts, openRpc, stop]);
	// The switcher shows live state: poll the registry while it is open.
	useEffect(() => {
		if (!switcherOpen) return;
		void refreshHosts();
		const timer = window.setInterval(() => void refreshHosts(), 4000);
		return () => window.clearInterval(timer);
	}, [switcherOpen, refreshHosts]);

	// ---- page overlay activity ----
	const verb = working ? liveVerb(view) : "";
	const waiting = view.uiRequest !== null;
	const readOnly = view.readOnly;
	useEffect(() => {
		if (session === null) return;
		const activity: TabActivity = waiting
			? { state: "waiting", session: title }
			: working
				? { state: "working", session: title, label: verb, canStop: !readOnly }
				: { state: "idle" };
		const key = JSON.stringify(activity);
		for (const tabId of conversation?.tabIds ?? []) {
			if (sentActivity.current.get(tabId) === key || (activity.state === "idle" && !sentActivity.current.has(tabId)))
				continue;
			if (activity.state === "idle") sentActivity.current.delete(tabId);
			else sentActivity.current.set(tabId, key);
			void worker.request("setActivity", { tabId, activity }).catch(() => undefined);
		}
	}, [worker, session, conversation, working, waiting, verb, readOnly, title]);

	// ---- sending ----
	const send = useCallback(
		async (outgoing: Outgoing): Promise<void> => {
			setLastPrompt(outgoing.display);
			setFollowSignal(count => count + 1);
			try {
				const known = sessionRef.current === null ? undefined : conversationsRef.current[sessionRef.current.id];
				// Tabs dragged into the conversation's group since the last prompt join this one's context.
				const grouped =
					known?.groupId === undefined
						? []
						: (await chrome.tabs.query({ groupId: known.groupId })).flatMap(tab =>
								tab.id === undefined ? [] : [tab.id],
							);
				const promptTabIds = [...new Set([...outgoing.tabs.map(tab => tab.tabId), ...grouped])];
				const contexts = await Promise.all(
					promptTabIds.map(tabId =>
						worker
							.request("tabContext", { tabId })
							.catch(() => outgoing.tabs.find(tab => tab.tabId === tabId) ?? null),
					),
				);
				const blocks = await Promise.all(
					contexts.flatMap(tab =>
						tab === null ? [] : [tabViewport(tab).then(viewport => tabContextBlock(tab, viewport))],
					),
				);
				const target =
					sessionRef.current ??
					(await startRpc(settings.value.defaultCwd, titleFrom(outgoing.display), promptTabIds));
				target.prompt(composePrompt(blocks, outgoing.text), outgoing.images);

				if (outgoing.shortcutIds.length > 0)
					shortcuts.set(list =>
						list.map(shortcut =>
							outgoing.shortcutIds.includes(shortcut.id) ? { ...shortcut, uses: shortcut.uses + 1 } : shortcut,
						),
					);

				const before = conversationsRef.current[target.id];
				const tabIds = [...new Set([...(before?.tabIds ?? []), ...promptTabIds])];
				updateConversation(target.id, { tabIds, groupId: before?.groupId });
				if (tabIds.length > 0) {
					const groupTitle = `omp · ${target.getSnapshot().state?.sessionName ?? target.title}`;
					worker.request("groupTabs", { tabIds, title: groupTitle, groupId: before?.groupId }).then(
						({ groupId }) => updateConversation(target.id, { tabIds, groupId }),
						error => notify("warning", `Couldn’t group the conversation’s tabs: ${errorText(error)}`),
					);
				}
			} catch (error) {
				composerRef.current?.restore(outgoing);
				setStrip({ tone: "error", message: `Couldn’t send: ${errorText(error)}` });
			}
		},
		[worker, startRpc, settings.value.defaultCwd, shortcuts.set, updateConversation, notify],
	);

	// ---- commands ----
	const timeline = useCallback(() => {
		const current = sessionRef.current?.getSnapshot() ?? EMPTY_SNAPSHOT;
		return buildTimeline(buildCommitted(current), current);
	}, []);

	const copyMarkdown = useCallback((): void => {
		void navigator.clipboard.writeText(transcriptMarkdown(timeline())).then(
			() => notify("info", "Transcript copied as Markdown"),
			error => notify("error", `Couldn’t copy: ${errorText(error)}`),
		);
	}, [timeline, notify]);

	const exportGif = useCallback(async (): Promise<void> => {
		const shots = latestRunShots(timeline());
		if (shots.length === 0) {
			notify("warning", "This run has no screenshots to export");
			return;
		}
		notify("info", `Rendering a GIF of ${shots.length} ${shots.length === 1 ? "frame" : "frames"}…`);
		try {
			const frames = await Promise.all(
				shots.map(async ({ image, step }): Promise<GifFrame> => {
					// Step coordinates are in screenshot pixels, so the screenshot's own size is the frame's viewport.
					const viewport = await imageSize(image);
					const { description } = step;
					const label = description.done;
					let action: GifFrame["action"];
					if (description.drag !== undefined) action = { kind: "drag", ...description.drag, label };
					else if (description.point !== undefined) action = { kind: "click", ...description.point, label };
					else if (description.motion === "scroll")
						action = { kind: "scroll", x: viewport.width / 2, y: viewport.height / 2, label };
					else action = { kind: "type", label };
					return { image, viewport, action };
				}),
			);
			const { filename } = await worker.request("exportGif", { frames });
			notify("info", `Saved ${filename}`);
		} catch (error) {
			notify("error", `GIF export failed: ${errorText(error)}`);
		}
	}, [timeline, worker, notify]);

	const compact = useCallback((): void => {
		const target = sessionRef.current;
		if (target?.compact === undefined) return;
		setCompacting(true);
		target
			.compact()
			.catch(error => notify("error", `Compaction failed: ${errorText(error)}`))
			.finally(() => setCompacting(false));
	}, [notify]);

	const editShortcut = useCallback((seed: Partial<ShortcutDraft>, from: "settings" | null = null): void => {
		setSheet({
			kind: "shortcut",
			from,
			draft: { existing: null, name: "", prompt: "", startUrl: "", scheduled: false, ...seed },
		});
	}, []);
	const openShortcut = useCallback(
		(shortcut: Shortcut, from: "settings" | null = null): void => {
			editShortcut(
				{
					existing: shortcut,
					name: shortcut.name,
					prompt: shortcut.prompt,
					startUrl: shortcut.startUrl ?? "",
					scheduled: shortcut.schedule !== undefined,
				},
				from,
			);
		},
		[editShortcut],
	);
	const saveAsShortcut = useCallback(
		(prompt: string): void => {
			const name = sanitizeShortcutName(prompt.trim().split(/\s+/).slice(0, 3).join("-")).slice(0, 24);
			editShortcut({ name, prompt });
		},
		[editShortcut],
	);

	const onCommand = useCallback(
		(command: ComposerCommand): void => {
			switch (command.kind) {
				case "new":
					newChat();
					break;
				case "compact":
					compact();
					break;
				case "export-markdown":
					copyMarkdown();
					break;
				case "export-gif":
					void exportGif();
					break;
				case "teach":
					setSheet({ kind: "teach" });
					break;
				case "schedule":
					editShortcut({ prompt: command.draft, startUrl: activeTab?.url ?? "", scheduled: true });
					break;
				case "edit-shortcut":
					openShortcut(command.shortcut);
					break;
				case "open-tab-group": {
					const first = conversation?.tabIds[0];
					if (first !== undefined)
						worker.request("focusTab", { tabId: first }).catch(error => notify("error", errorText(error)));
					break;
				}
			}
		},
		[newChat, compact, copyMarkdown, exportGif, editShortcut, openShortcut, activeTab, conversation, worker, notify],
	);

	const generateShortcut = useCallback(
		async (steps: TeachStep[]): Promise<string> => {
			const { images, shotSteps } = await teachShots(steps);
			const target =
				sessionRef.current ??
				(await startRpc(settings.value.defaultCwd, `Teach: ${hostOf(steps[0]?.url ?? "")}`, []));
			const from = target.getSnapshot().entries.length;
			const reply = replyAfter(target, from);
			target.prompt(teachPromptText(steps, shotSteps), images);
			setFollowSignal(count => count + 1);
			return unfence(await reply);
		},
		[startRpc, settings.value.defaultCwd],
	);

	// The shortcut editor offers the models the current session can run.
	const [models, setModels] = useState<PanelModel[]>([]);
	const editingShortcut = sheet?.kind === "shortcut";
	useEffect(() => {
		if (!editingShortcut || session?.listModels === undefined) return;
		let alive = true;
		void session.listModels().then(
			list => {
				if (alive) setModels(list);
			},
			() => undefined,
		);
		return () => {
			alive = false;
		};
	}, [editingShortcut, session]);

	// ---- keyboard ----
	useEscapeFallback(working && !readOnly ? stop : null);
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const key = event.key.toLowerCase();
			if (event.shiftKey && key === "s") composerRef.current?.capture("region");
			else if (event.shiftKey && key === "x") composerRef.current?.capture("element");
			else if (!event.shiftKey && key === "k") setSwitcherOpen(open => !open);
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// ---- drop overlay ----
	useEffect(() => {
		let depth = 0;
		let settle: number | undefined;
		const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;
		const onEnter = (event: DragEvent): void => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			depth++;
			window.clearTimeout(settle);
			const items = [...(event.dataTransfer?.items ?? [])].filter(item => item.kind === "file");
			setDrop(items.length > 0 && items.every(item => item.type.startsWith("image/")) ? "ok" : "bad");
		};
		const onOver = (event: DragEvent): void => {
			if (carriesFiles(event)) event.preventDefault();
		};
		const onLeave = (event: DragEvent): void => {
			if (!carriesFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDrop("idle");
		};
		const onDrop = (event: DragEvent): void => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			depth = 0;
			const files = [...(event.dataTransfer?.files ?? [])];
			const images = files.filter(file => file.type.startsWith("image/"));
			if (images.length > 0) composerRef.current?.addFiles(images);
			setDrop(images.length === files.length && images.length > 0 ? "ok" : "bad");
			settle = window.setTimeout(() => setDrop("idle"), 300);
		};
		window.addEventListener("dragenter", onEnter);
		window.addEventListener("dragover", onOver);
		window.addEventListener("dragleave", onLeave);
		window.addEventListener("drop", onDrop);
		return () => {
			window.clearTimeout(settle);
			window.removeEventListener("dragenter", onEnter);
			window.removeEventListener("dragover", onOver);
			window.removeEventListener("dragleave", onLeave);
			window.removeEventListener("drop", onDrop);
		};
	}, []);

	// ---- derived chrome ----
	const exited =
		attached?.kind === "rpc" ? rpcSessions.find(info => info.sessionKey === attached.sessionKey)?.exited : undefined;
	const contextPercent = view.state?.contextUsage?.percent ?? null;
	const derivedStrip = useMemo((): (Strip & { key: string }) | null => {
		if (session === null) return null;
		if (exited !== undefined) {
			const detail = exited.stderr.trim().split("\n").pop() ?? "";
			return {
				key: `exit-${session.id}`,
				tone: "error",
				message: `omp exited${exited.code === null ? "" : ` (code ${exited.code})`}${detail === "" ? "." : `: ${detail}`}`,
				action: { label: "New chat", run: () => show(null, null) },
			};
		}
		if (view.phase === "ended")
			return {
				key: `ended-${session.id}`,
				tone: "error",
				message: `Session ended${view.endedReason ? `: ${view.endedReason}` : "."}`,
				action: { label: "New chat", run: () => show(null, null) },
			};
		if (contextPercent !== null && contextPercent >= 85 && !compacting)
			return {
				key: `context-${session.id}`,
				tone: "neutral",
				message: `Context window ${Math.round(contextPercent)}% full.`,
				action: session.compact === undefined ? undefined : { label: "Compact", run: compact },
			};
		return null;
	}, [session, exited, view.phase, view.endedReason, contextPercent, compacting, compact, show]);
	const shownStrip = strip ?? (derivedStrip !== null && derivedStrip.key !== dismissedStrip ? derivedStrip : null);

	const banner =
		session !== null && (view.phase === "connecting" || view.phase === "waiting")
			? "Joining session…"
			: session !== null && view.phase === "reconnecting"
				? "Reconnecting…"
				: relay !== null && !relay.connected
					? "Relay disconnected"
					: null;

	const allToasts = useMemo(
		() =>
			[...view.notices.filter(notice => !COMPACTION_NOTICE.test(notice.message)), ...toasts]
				.filter(notice => !dismissedToasts.has(notice.id))
				.sort((a, b) => a.at - b.at),
		[view.notices, toasts, dismissedToasts],
	);

	// A fresh chat on a tab another conversation already works in points there instead.
	const pristine = session === null || (view.entries.length === 0 && !working && view.stream === null);
	const owner =
		pristine && activeTab !== null
			? rpcSessions.find(
					info =>
						info.exited === undefined &&
						info.tabIds.includes(activeTab.tabId) &&
						!(attached?.kind === "rpc" && attached.sessionKey === info.sessionKey),
				)
			: undefined;

	const sessionId = view.header?.id;
	const moreEntries: MenuEntry[] = [
		{ kind: "item", id: "settings", label: "Settings", onSelect: () => setSheet({ kind: "settings" }) },
		{
			kind: "item",
			id: "markdown",
			label: "Copy transcript as Markdown",
			disabled: view.entries.length === 0,
			onSelect: copyMarkdown,
		},
		{
			kind: "item",
			id: "gif",
			label: "Export GIF of this run",
			disabled: view.entries.length === 0,
			onSelect: () => void exportGif(),
		},
		{
			kind: "item",
			id: "terminal",
			label: "Open in terminal",
			meta: "copy command",
			disabled: sessionId === undefined,
			onSelect: () => {
				const command = `omp --resume ${sessionId}`;
				void navigator.clipboard.writeText(command).then(
					() => notify("info", `Copied “${command}”. Paste it in a terminal.`),
					error => notify("error", `Couldn’t copy: ${errorText(error)}`),
				);
			},
		},
		{
			kind: "item",
			id: "theme",
			label: "Theme",
			submenu: (["system", "light", "dark"] as const).map(theme => ({
				kind: "item" as const,
				id: `theme-${theme}`,
				label: theme === "system" ? "System" : theme === "light" ? "Light" : "Dark",
				checked: settings.value.theme === theme,
				onSelect: () => settings.set({ ...settings.value, theme }),
			})),
		},
	];
	if (session?.kind === "rpc")
		moreEntries.push(
			{ kind: "separator", id: "sep-end" },
			{
				kind: "item",
				id: "end",
				label: "End session",
				danger: true,
				onSelect: () => {
					const ending = session;
					idleTabs(conversationsRef.current[ending.id]?.tabIds ?? []);
					show(null, null);
					ending.close();
				},
			},
		);

	const closeSheet = (): void =>
		setSheet(current => (current?.kind === "shortcut" && current.from === "settings" ? { kind: "settings" } : null));

	return (
		<div className="pn-app">
			<Header
				title={title}
				working={working}
				hosts={hosts}
				rpcSessions={rpcSessions}
				attached={attached}
				recentDirs={recentDirs.value}
				defaultCwd={settings.value.defaultCwd}
				switcherOpen={switcherOpen}
				onSwitcher={setSwitcherOpen}
				onAttach={host => void attachHost(host)}
				onOpenRpc={openRpc}
				onNewIn={cwd => {
					startRpc(cwd, basename(cwd), activeTab === null ? [] : [activeTab.tabId]).catch(error =>
						setStrip({ tone: "error", message: `Couldn’t start omp in ${cwd}: ${errorText(error)}` }),
					);
				}}
				onNewChat={newChat}
				more={moreEntries}
			/>
			<main className="pn-body">
				{owner !== undefined ? (
					<SecondaryTab
						session={owner}
						onOpen={() => {
							openRpc(owner);
							const main = owner.tabIds[0];
							if (main !== undefined)
								worker.request("focusTab", { tabId: main }).catch(error => notify("error", errorText(error)));
						}}
					/>
				) : (
					<ActiveTabContext value={activeTab}>
						<Transcript
							key={session?.id ?? "new"}
							snapshot={view}
							compacting={compacting}
							followSignal={followSignal}
							empty={
								<EmptyState
									tab={activeTab}
									suggestions={suggestions.value}
									onPick={prompt => composerRef.current?.fill(prompt)}
								/>
							}
							onSaveShortcut={saveAsShortcut}
						/>
					</ActiveTabContext>
				)}
				{banner !== null && (
					<div className="sh-banner pn-banner" role="status">
						<span className="sh-banner-dot" />
						{banner}
					</div>
				)}
				<Toasts notices={allToasts} onDismiss={id => setDismissedToasts(seen => new Set(seen).add(id))} />
			</main>
			{owner === undefined && (
				<Composer
					handle={composerRef}
					worker={worker}
					windowId={windowId}
					session={session}
					snapshot={snapshot}
					activeTab={activeTab}
					shortcuts={shortcuts.value}
					hasTabGroup={conversation?.groupId !== undefined}
					lastPrompt={lastPrompt ?? lastUserPrompt(view.entries)}
					strip={shownStrip}
					onDismissStrip={() => {
						if (strip !== null) setStrip(null);
						else if (derivedStrip !== null) setDismissedStrip(derivedStrip.key);
					}}
					onSend={outgoing => void send(outgoing)}
					onStop={stop}
					onCommand={onCommand}
					onNotify={notify}
				/>
			)}
			{sheet?.kind === "settings" && (
				<SettingsSheet
					worker={worker}
					settings={settings}
					suggestions={suggestions}
					shortcuts={shortcuts.value}
					relay={relay}
					activeTab={activeTab}
					onEditShortcut={shortcut =>
						shortcut === null ? editShortcut({}, "settings") : openShortcut(shortcut, "settings")
					}
					onRunShortcut={shortcut => {
						worker.request("runShortcut", { shortcutId: shortcut.id }).then(
							() => notify("info", `Started /${shortcut.name}`),
							error => notify("error", `Couldn’t run /${shortcut.name}: ${errorText(error)}`),
						);
					}}
					onClose={() => setSheet(null)}
				/>
			)}
			{sheet?.kind === "shortcut" && (
				<ShortcutSheet
					draft={sheet.draft}
					taken={shortcuts.value
						.filter(shortcut => shortcut.id !== sheet.draft.existing?.id)
						.map(shortcut => shortcut.name)}
					models={models}
					defaultCwd={settings.value.defaultCwd}
					onSave={saved => {
						shortcuts.set(list =>
							list.some(shortcut => shortcut.id === saved.id)
								? list.map(shortcut => (shortcut.id === saved.id ? saved : shortcut))
								: [...list, saved],
						);
						notify("info", `Saved /${saved.name}`);
						closeSheet();
					}}
					onDelete={removed => {
						shortcuts.set(list => list.filter(shortcut => shortcut.id !== removed.id));
						notify("info", `Deleted /${removed.name}`);
						closeSheet();
					}}
					onClose={closeSheet}
				/>
			)}
			{sheet?.kind === "teach" && (
				<TeachSheet
					worker={worker}
					tab={activeTab}
					onGenerate={generateShortcut}
					onDone={({ prompt, steps }) => {
						const first = steps[0];
						const host = first === undefined ? "" : hostOf(first.url);
						editShortcut({
							name: sanitizeShortcutName(host.split(".")[0] ?? "").slice(0, 24),
							prompt,
							startUrl: first?.url ?? "",
						});
					}}
					onClose={() => setSheet(null)}
					onNotify={notify}
				/>
			)}
			{drop !== "idle" && (
				<div className={`pn-drop${drop === "bad" ? " pn-drop--bad" : ""}`}>
					<ImagePlus size={48} strokeWidth={1.25} />
					<span>{drop === "bad" ? "Not an image" : "Drop to attach"}</span>
				</div>
			)}
		</div>
	);
}
