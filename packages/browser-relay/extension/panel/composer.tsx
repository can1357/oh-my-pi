/**
 * The composer card: error strip, attachment tray, tab chips, editor (or the agent's pending question), footer
 * with Actions, queued pill, model chip and Send/Stop, plus the slash menu that opens above it.
 */
import type { CollabUiRequest, ImageContent } from "@oh-my-pi/pi-wire";
import {
	AppWindow,
	ArrowUp,
	CalendarClock,
	ChevronDown,
	CircleDot,
	Crop,
	Download,
	FileText,
	Film,
	FolderOpen,
	ImagePlus,
	Layers,
	MousePointerClick,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Shrink,
	Sparkles,
	SquarePen,
	Unlink,
	X,
	Zap,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Shortcut, TabContext } from "../messages";
import { Editor, type EditorHandle } from "./editor";
import { NotAnImageError, prepareImage, prepareWireImage } from "./images";
import { Lightbox, type LightboxImage } from "./media";
import { ModelPicker, useModelList } from "./model-picker";
import { scheduleCaption } from "./schedule";
import type { PanelSession, PanelSnapshot, PanelWorker } from "./session";
import { sortShortcuts } from "./storage";
import { hostOf } from "./tab-context";
import { imageSrc } from "./timeline";
import { Favicon, IconButton, Menu, type MenuEntry, type MenuHandle } from "./ui";

/** A notice docked to the top of the composer card. */
export interface Strip {
	tone: "error" | "neutral";
	message: string;
	/** Underlined action after the message (Retry, Compact). */
	action?: { label: string; run(): void };
}

/** What the composer hands the app when the user sends. */
export interface Outgoing {
	/** The text as typed, with shortcut chips shown as `/name`; what ↑ recalls. */
	display: string;
	/** The text for the agent: chips expanded, element captions appended. */
	text: string;
	images: ImageContent[];
	tabs: TabContext[];
	shortcutIds: string[];
}

/** Things the slash menu and Actions menu ask the app to do. */
export type ComposerCommand =
	| { kind: "new" }
	| { kind: "compact" }
	| { kind: "export-markdown" }
	| { kind: "export-gif" }
	| { kind: "teach" }
	/** Open the shortcut editor with its schedule on, prefilled from the draft. */
	| { kind: "schedule"; draft: string }
	| { kind: "edit-shortcut"; shortcut: Shortcut }
	| { kind: "open-tab-group" };

/** The app's handle on the composer. */
export interface ComposerHandle {
	/** Put `text` in the editor without sending. */
	fill(text: string): void;
	focus(): void;
	capture(mode: "region" | "viewport" | "element"): void;
	addFiles(files: readonly File[]): void;
	/** Put a message that could not be sent back: its text and its images. */
	restore(outgoing: Outgoing): void;
}

interface Attachment {
	id: number;
	status: "uploading" | "ready" | "error";
	image?: ImageContent;
	/** Element descriptor of an element pick. */
	caption?: string;
	error?: string;
}

type TabMode = { kind: "follow" } | { kind: "pinned"; tab: TabContext } | { kind: "none" };

/** What the composer needs from the app. */
export interface ComposerProps {
	handle: Ref<ComposerHandle>;
	worker: PanelWorker;
	windowId: number;
	session: PanelSession | null;
	snapshot: PanelSnapshot | null;
	activeTab: TabContext | null;
	shortcuts: readonly Shortcut[];
	/** The conversation has a tab group to jump to. */
	hasTabGroup: boolean;
	/** The previous prompt, for ↑ in an empty editor. */
	lastPrompt: string | null;
	strip: Strip | null;
	onDismissStrip(): void;
	onSend(outgoing: Outgoing): void;
	onStop(): void;
	onCommand(command: ComposerCommand): void;
	onNotify(level: "info" | "error", message: string): void;
}

function TabChip(props: {
	tab: TabContext | null;
	state: "following" | "pinned" | "none" | "extra";
	onClick?(): void;
	onRemove?(): void;
}): ReactNode {
	const { tab, state } = props;
	const label = tab === null ? (state === "none" ? "No tab" : "No active tab") : hostOf(tab.url) || tab.title || "tab";
	const title =
		state === "following"
			? `Following the active tab${tab === null ? "" : `: ${tab.title}`}`
			: state === "pinned"
				? `Pinned: ${tab?.title ?? ""}`
				: state === "none"
					? "No tab attached"
					: (tab?.title ?? "");
	return (
		<span className={`pn-tab-chip pn-tab-chip--${state}`} title={title}>
			<button
				type="button"
				className="pn-tab-chip-main"
				onClick={props.onClick}
				disabled={props.onClick === undefined}
			>
				{state === "following" && <span className="pn-tab-chip-dot" />}
				{state === "pinned" && <Pin size={11} className="pn-tab-chip-pin" />}
				{tab !== null && state !== "none" && <Favicon src={tab.favIconUrl} size={14} />}
				<span className="pn-tab-chip-label">{label}</span>
			</button>
			{props.onRemove !== undefined && (
				<button
					type="button"
					className="pn-tab-chip-remove"
					aria-label={`Remove ${label}`}
					onClick={props.onRemove}
				>
					<X size={10} />
				</button>
			)}
		</span>
	);
}

function AskCard(props: { request: CollabUiRequest; onAnswer(value: string | undefined): void }): ReactNode {
	const { request } = props;
	const [draft, setDraft] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	return (
		<div className="pn-ask">
			<div className="sh-ask-title">{request.title}</div>
			{request.kind === "select" ? (
				<div className="sh-ask-options">
					{request.options.map((option, index) => {
						const label = typeof option === "string" ? option : option.label;
						const checked = request.checkedIndices?.includes(index) ?? false;
						return (
							<button
								key={`${index}-${label}`}
								type="button"
								className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
								onClick={() => props.onAnswer(label)}
							>
								<span className="sh-ask-option-marker">
									{request.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
								</span>
								<span className="sh-ask-option-copy">
									<span className="sh-ask-option-label">{label}</span>
									{typeof option !== "string" && option.description && (
										<span className="sh-ask-option-description">{option.description}</span>
									)}
								</span>
							</button>
						);
					})}
				</div>
			) : (
				<textarea
					className="pn-field pn-ask-editor"
					value={draft}
					rows={3}
					placeholder="Type your answer…"
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							props.onAnswer(draft);
						}
					}}
				/>
			)}
			<div className="pn-ask-actions">
				<button type="button" className="sh-btn" onClick={() => props.onAnswer(undefined)}>
					Cancel
				</button>
				{request.kind === "editor" && (
					<button type="button" className="sh-btn sh-btn-primary" onClick={() => props.onAnswer(draft)}>
						Answer
					</button>
				)}
			</div>
		</div>
	);
}

/** The docked composer. */
export function Composer(props: ComposerProps): ReactNode {
	const { worker, session, snapshot, activeTab } = props;
	const editorRef = useRef<EditorHandle | null>(null);
	const slashMenuRef = useRef<MenuHandle | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const nextId = useRef(0);

	const [empty, setEmpty] = useState(true);
	const [slashQuery, setSlashQuery] = useState<string | null>(null);
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [preview, setPreview] = useState<LightboxImage | null>(null);
	const [tabMode, setTabMode] = useState<TabMode>({ kind: "follow" });
	const [extraTabs, setExtraTabs] = useState<TabContext[]>([]);
	const [menu, setMenu] = useState<"actions" | "tab" | "model" | null>(null);
	const [windowTabs, setWindowTabs] = useState<chrome.tabs.Tab[]>([]);
	const models = useModelList(session, menu === "model");

	const working = snapshot?.working ?? false;
	const readOnly = snapshot?.readOnly ?? false;
	const live = session === null || snapshot?.phase === "live";
	const canPrompt = live && !readOnly;
	const uiRequest = canPrompt ? (snapshot?.uiRequest ?? null) : null;
	const queued = snapshot?.state?.queuedMessageCount ?? 0;
	const currentModel = snapshot?.state?.model ?? null;
	// The picker hangs off the model chip, so switching needs a current model to show.
	const canSwitchModel = session?.listModels !== undefined && session.setModel !== undefined && currentModel !== null;
	const primaryTab = tabMode.kind === "follow" ? activeTab : tabMode.kind === "pinned" ? tabMode.tab : null;
	const captureTab = primaryTab ?? activeTab;
	const uploading = attachments.some(attachment => attachment.status === "uploading");
	const hasReady = attachments.some(attachment => attachment.status === "ready");
	const canSend = canPrompt && !uploading && (!empty || hasReady);

	// A pinned tab keeps its chip current as the page navigates or is retitled.
	useEffect(() => {
		if (tabMode.kind !== "pinned" || activeTab === null || activeTab.tabId !== tabMode.tab.tabId) return;
		if (activeTab.url !== tabMode.tab.url || activeTab.title !== tabMode.tab.title)
			setTabMode({ kind: "pinned", tab: activeTab });
	}, [activeTab, tabMode]);

	useEffect(() => {
		if (menu !== "tab") return;
		let alive = true;
		void chrome.tabs.query({ windowId: props.windowId }).then(tabs => {
			if (alive) setWindowTabs(tabs);
		});
		return () => {
			alive = false;
		};
	}, [menu, props.windowId]);

	// ---- attachments ----
	const patch = useCallback((id: number, next: Partial<Attachment> | null): void => {
		setAttachments(list =>
			next === null
				? list.filter(item => item.id !== id)
				: list.map(item => (item.id === id ? { ...item, ...next } : item)),
		);
	}, []);

	const addFiles = useCallback(
		(files: readonly File[]): void => {
			for (const file of files) {
				const id = ++nextId.current;
				setAttachments(list => [...list, { id, status: "uploading" }]);
				prepareImage(file).then(
					prepared => patch(id, { status: "ready", image: prepared.image }),
					error =>
						patch(id, { status: "error", error: error instanceof NotAnImageError ? "Not an image" : "Failed" }),
				);
			}
		},
		[patch],
	);

	const capture = useCallback(
		(mode: "region" | "viewport" | "element"): void => {
			if (captureTab === null) {
				props.onNotify("error", "There is no tab to capture");
				return;
			}
			const id = ++nextId.current;
			setAttachments(list => [...list, { id, status: "uploading" }]);
			const tabId = captureTab.tabId;
			// The picker runs in the page, which only hears Esc once it has focus; Esc in the panel cancels it too.
			const cancelOnEscape = (event: globalThis.KeyboardEvent): void => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				void worker.request("cancelCapture", { tabId });
			};
			if (mode !== "viewport") window.addEventListener("keydown", cancelOnEscape, true);
			worker
				.request("capture", { tabId, mode })
				.finally(() => window.removeEventListener("keydown", cancelOnEscape, true))
				.then(async result => {
					// Null: the user pressed Esc in the picker.
					if (result === null) return patch(id, null);
					const prepared = await prepareWireImage(result.image);
					patch(id, { status: "ready", image: prepared.image, caption: result.caption });
				})
				.catch(error => {
					patch(id, null);
					props.onNotify("error", `Capture failed: ${error instanceof Error ? error.message : String(error)}`);
				});
		},
		[captureTab, patch, props.onNotify, worker],
	);

	useImperativeHandle(props.handle, () => ({
		fill(text) {
			editorRef.current?.setText(text);
		},
		focus() {
			editorRef.current?.focus();
		},
		capture,
		addFiles,
		restore(outgoing) {
			editorRef.current?.setText(outgoing.display);
			setAttachments(outgoing.images.map(image => ({ id: ++nextId.current, status: "ready", image })));
		},
	}));

	// ---- tabs ----
	const addExtraTab = async (tabId: number): Promise<void> => {
		try {
			const tab = await worker.request("tabContext", { tabId });
			setExtraTabs(list =>
				list.some(item => item.tabId === tabId) || primaryTab?.tabId === tabId ? list : [...list, tab],
			);
		} catch (error) {
			props.onNotify("error", error instanceof Error ? error.message : String(error));
		}
	};
	const pinTab = async (tabId: number): Promise<void> => {
		try {
			const tab = await worker.request("tabContext", { tabId });
			setTabMode({ kind: "pinned", tab });
			setExtraTabs(list => list.filter(item => item.tabId !== tabId));
		} catch (error) {
			props.onNotify("error", error instanceof Error ? error.message : String(error));
		}
	};

	const tabMenu = useMemo((): MenuEntry[] => {
		const rows = (action: (tabId: number) => void, skip: (tabId: number) => boolean): MenuEntry[] =>
			windowTabs
				.filter(tab => tab.id !== undefined && !skip(tab.id))
				.map(tab => ({
					kind: "item" as const,
					id: `tab-${tab.id}`,
					label: tab.title || tab.url || "Untitled",
					meta: tab.url === undefined ? undefined : hostOf(tab.url),
					icon: <Favicon src={tab.favIconUrl} size={14} />,
					onSelect: () => {
						if (tab.id !== undefined) action(tab.id);
					},
				}));
		const entries: MenuEntry[] = [];
		if (tabMode.kind === "follow") {
			if (activeTab !== null)
				entries.push({
					kind: "item",
					id: "pin",
					label: "Pin this tab",
					icon: <Pin size={14} />,
					onSelect: () => setTabMode({ kind: "pinned", tab: activeTab }),
				});
		} else {
			entries.push({
				kind: "item",
				id: "follow",
				label: "Follow the active tab",
				icon: tabMode.kind === "pinned" ? <PinOff size={14} /> : <CircleDot size={14} />,
				onSelect: () => setTabMode({ kind: "follow" }),
			});
		}
		entries.push(
			{
				kind: "item",
				id: "pick",
				label: "Pick another tab",
				icon: <AppWindow size={14} />,
				submenu: rows(
					tabId => void pinTab(tabId),
					tabId => primaryTab?.tabId === tabId,
				),
			},
			{
				kind: "item",
				id: "add",
				label: "Add another tab",
				icon: <Plus size={14} />,
				submenu: rows(
					tabId => void addExtraTab(tabId),
					tabId => primaryTab?.tabId === tabId || extraTabs.some(tab => tab.tabId === tabId),
				),
			},
		);
		if (tabMode.kind !== "none")
			entries.push({
				kind: "item",
				id: "none",
				label: "Don’t attach a tab",
				icon: <Unlink size={14} />,
				onSelect: () => setTabMode({ kind: "none" }),
			});
		if (props.hasTabGroup)
			entries.push(
				{ kind: "separator", id: "sep-group" },
				{
					kind: "item",
					id: "group",
					label: "Open the conversation’s tab group",
					icon: <Layers size={14} />,
					onSelect: () => props.onCommand({ kind: "open-tab-group" }),
				},
			);
		return entries;
		// pinTab/addExtraTab close over the same state listed here.
	}, [windowTabs, tabMode, activeTab, primaryTab, extraTabs, props.hasTabGroup, props.onCommand]);

	// ---- sending ----
	const send = (): void => {
		const editor = editorRef.current;
		if (editor === null || !canSend) return;
		const byId = new Map(props.shortcuts.map(shortcut => [shortcut.id, shortcut]));
		const content = editor.read(id => byId.get(id)?.prompt);
		const ready = attachments.filter(attachment => attachment.status === "ready" && attachment.image !== undefined);
		const captions = ready
			.map((attachment, index) =>
				attachment.caption === undefined
					? null
					: `Image ${index + 1} is the element ${attachment.caption} I picked on the page.`,
			)
			.filter(line => line !== null);
		const text = [content.expanded, ...captions].filter(part => part !== "").join("\n\n");
		if (text === "" && ready.length === 0) return;
		const tabs =
			primaryTab === null ? extraTabs : [primaryTab, ...extraTabs.filter(tab => tab.tabId !== primaryTab.tabId)];
		props.onSend({
			display: content.display,
			text,
			images: ready.flatMap(attachment => (attachment.image === undefined ? [] : [attachment.image])),
			tabs,
			shortcutIds: content.shortcutIds,
		});
		editor.clear();
		setAttachments([]);
		setExtraTabs([]);
	};

	// ---- slash menu ----
	const draft = (): string => editorRef.current?.read(() => undefined).display ?? "";
	const slashEntries = useMemo((): MenuEntry[] => {
		if (slashQuery === null) return [];
		const query = slashQuery.toLowerCase();
		const matches = (...words: string[]): boolean =>
			query === "" || words.some(word => word.toLowerCase().includes(query));
		const run = (command: ComposerCommand) => () => {
			editorRef.current?.resolveSlash(null);
			props.onCommand(command);
		};
		const commands: MenuEntry[] = [];
		if (matches("new", "chat"))
			commands.push({
				kind: "item",
				id: "cmd-new",
				label: "New chat",
				meta: "/new",
				icon: <SquarePen size={16} />,
				onSelect: run({ kind: "new" }),
			});
		if (session?.compact !== undefined && matches("compact"))
			commands.push({
				kind: "item",
				id: "cmd-compact",
				label: "Compact the conversation",
				meta: "/compact",
				icon: <Shrink size={16} />,
				onSelect: run({ kind: "compact" }),
			});
		if (canSwitchModel && matches("model", "switch"))
			commands.push({
				kind: "item",
				id: "cmd-model",
				label: "Switch model",
				meta: "/model",
				icon: <Sparkles size={16} />,
				onSelect: () => {
					editorRef.current?.resolveSlash(null);
					// Opens after the slash menu's own close has run.
					window.setTimeout(() => setMenu("model"), 0);
				},
			});
		if (matches("export", "markdown", "gif"))
			commands.push({
				kind: "item",
				id: "cmd-export",
				label: "Export",
				meta: "/export",
				icon: <Download size={16} />,
				submenu: [
					{
						kind: "item",
						id: "export-md",
						label: "Copy transcript as Markdown",
						icon: <FileText size={14} />,
						onSelect: run({ kind: "export-markdown" }),
					},
					{
						kind: "item",
						id: "export-gif",
						label: "Export GIF of this run",
						icon: <Film size={14} />,
						onSelect: run({ kind: "export-gif" }),
					},
				],
			});
		const shortcuts: MenuEntry[] = sortShortcuts(props.shortcuts)
			.filter(shortcut => matches(shortcut.name))
			.map(shortcut => ({
				kind: "item" as const,
				id: `shortcut-${shortcut.id}`,
				label: `/${shortcut.name}`,
				description: shortcut.prompt.replace(/\s+/g, " ").slice(0, 80),
				meta: shortcut.schedule === undefined ? undefined : scheduleCaption(shortcut.schedule),
				icon: <Zap size={16} />,
				trailing: {
					label: `Edit /${shortcut.name}`,
					icon: <Pencil size={13} />,
					onClick: run({ kind: "edit-shortcut", shortcut }),
				},
				onSelect: () => editorRef.current?.resolveSlash({ id: shortcut.id, name: shortcut.name }),
			}));
		const actions: MenuEntry[] = [];
		if (matches("record", "workflow", "teach"))
			actions.push({
				kind: "item",
				id: "act-teach",
				label: "Record workflow",
				icon: <CircleDot size={16} />,
				onSelect: run({ kind: "teach" }),
			});
		if (matches("schedule"))
			actions.push({
				kind: "item",
				id: "act-schedule",
				label: "Schedule…",
				icon: <CalendarClock size={16} />,
				onSelect: () => {
					editorRef.current?.resolveSlash(null);
					props.onCommand({ kind: "schedule", draft: draft() });
				},
			});
		if (matches("capture", "region", "screenshot"))
			actions.push({
				kind: "item",
				id: "act-region",
				label: "Capture region",
				meta: "⌘⇧S",
				icon: <Crop size={16} />,
				onSelect: () => {
					editorRef.current?.resolveSlash(null);
					capture("region");
				},
			});
		if (matches("pick", "element"))
			actions.push({
				kind: "item",
				id: "act-element",
				label: "Pick element",
				meta: "⌘⇧X",
				icon: <MousePointerClick size={16} />,
				onSelect: () => {
					editorRef.current?.resolveSlash(null);
					capture("element");
				},
			});
		const groups = [commands, shortcuts, actions].filter(group => group.length > 0);
		return groups.flatMap((group, index) =>
			index === 0 ? group : [{ kind: "separator" as const, id: `sep-${index}` }, ...group],
		);
	}, [slashQuery, props.shortcuts, props.onCommand, session, canSwitchModel, capture]);

	const slashOpen = slashQuery !== null && !slashDismissed && slashEntries.length > 0;
	const onEditorKey = (event: KeyboardEvent<HTMLDivElement>): boolean =>
		slashOpen && (slashMenuRef.current?.handleKey(event) ?? false);

	const actionEntries: MenuEntry[] = [
		{
			kind: "item",
			id: "region",
			label: "Capture region",
			meta: "⌘⇧S",
			icon: <Crop size={14} />,
			onSelect: () => capture("region"),
		},
		{
			kind: "item",
			id: "viewport",
			label: "Capture visible tab",
			icon: <AppWindow size={14} />,
			onSelect: () => capture("viewport"),
		},
		{
			kind: "item",
			id: "element",
			label: "Pick element",
			meta: "⌘⇧X",
			icon: <MousePointerClick size={14} />,
			onSelect: () => capture("element"),
		},
		{
			kind: "item",
			id: "image",
			label: "Add image",
			icon: <ImagePlus size={14} />,
			onSelect: () => fileInputRef.current?.click(),
		},
		{
			kind: "item",
			id: "tab",
			label: "Add tab",
			icon: <FolderOpen size={14} />,
			// Opens after this menu's own close has run.
			onSelect: () => window.setTimeout(() => setMenu("tab"), 0),
		},
	];

	const strip = props.strip;
	const placeholder = readOnly ? "Read-only session — watching only" : !live ? "Waiting for the session…" : undefined;

	return (
		<div className="pn-composer">
			{slashOpen && (
				<div className="pn-slash">
					<Menu
						entries={slashEntries}
						handle={slashMenuRef}
						className="pn-slash-menu"
						onClose={() => setSlashDismissed(true)}
					/>
				</div>
			)}
			<div className={`pn-composer-card${strip !== null ? " pn-composer-card--strip" : ""}`}>
				{strip !== null && (
					<div className={`pn-strip pn-strip--${strip.tone}`} role={strip.tone === "error" ? "alert" : "status"}>
						<span className="pn-strip-msg">
							{strip.message}
							{strip.action !== undefined && (
								<>
									{" "}
									<button type="button" className="pn-strip-action" onClick={strip.action.run}>
										{strip.action.label}
									</button>
								</>
							)}
						</span>
						<button type="button" className="pn-strip-close" aria-label="Dismiss" onClick={props.onDismissStrip}>
							<X size={12} />
						</button>
					</div>
				)}
				<div className="pn-collapse pn-tray-collapse" data-open={attachments.length > 0 || undefined}>
					<div className="pn-collapse-inner">
						<div className="pn-tray">
							{attachments.map(attachment => (
								<div key={attachment.id} className={`pn-tile pn-tile--${attachment.status}`}>
									{attachment.image !== undefined && (
										<button
											type="button"
											className="pn-tile-image"
											aria-label="Preview attachment"
											onClick={() => {
												if (attachment.image !== undefined)
													setPreview({
														src: imageSrc(attachment.image),
														alt: attachment.caption ?? "attachment",
													});
											}}
										>
											<img src={imageSrc(attachment.image)} alt="" draggable={false} />
										</button>
									)}
									{attachment.status === "error" && <span className="pn-tile-error">{attachment.error}</span>}
									{attachment.caption !== undefined && (
										<span className="pn-tile-caption">{attachment.caption}</span>
									)}
									<button
										type="button"
										className="pn-tile-remove"
										aria-label="Remove attachment"
										onClick={() => patch(attachment.id, null)}
									>
										<X size={10} />
									</button>
								</div>
							))}
						</div>
					</div>
				</div>
				{uiRequest !== null && session !== null ? (
					<AskCard
						key={uiRequest.reqId}
						request={uiRequest}
						onAnswer={value => session.answer(uiRequest.reqId, value)}
					/>
				) : (
					<>
						<div className="pn-tab-row">
							<span className="pn-pop-anchor">
								<TabChip
									tab={primaryTab}
									state={tabMode.kind === "follow" ? "following" : tabMode.kind}
									onClick={() => setMenu(open => (open === "tab" ? null : "tab"))}
								/>
								{menu === "tab" && (
									<Menu
										entries={tabMenu}
										className="pn-pop pn-pop--above-left"
										width={248}
										dense
										autoFocus
										onClose={() => setMenu(null)}
									/>
								)}
							</span>
							{extraTabs.map(tab => (
								<TabChip
									key={tab.tabId}
									tab={tab}
									state="extra"
									onRemove={() => setExtraTabs(list => list.filter(item => item.tabId !== tab.tabId))}
								/>
							))}
						</div>
						<Editor
							handle={editorRef}
							disabled={!canPrompt}
							placeholder={placeholder}
							onEmptyChange={setEmpty}
							onSlash={query => {
								setSlashQuery(query);
								if (query === null) setSlashDismissed(false);
							}}
							onKey={onEditorKey}
							onSubmit={send}
							onRecall={() => {
								if (props.lastPrompt !== null) editorRef.current?.setText(props.lastPrompt);
							}}
							onPasteFiles={addFiles}
						/>
					</>
				)}
				<div className="pn-footer">
					<span className="pn-pop-anchor">
						<IconButton
							label="Actions"
							tip={menu === "actions" ? "none" : "above"}
							active={menu === "actions"}
							disabled={!canPrompt}
							onClick={() => setMenu(open => (open === "actions" ? null : "actions"))}
						>
							<Plus size={16} />
						</IconButton>
						{menu === "actions" && (
							<Menu
								entries={actionEntries}
								className="pn-pop pn-pop--above-left"
								width={224}
								dense
								autoFocus
								onClose={() => setMenu(null)}
							/>
						)}
					</span>
					{queued > 0 && <span className="sh-queued pn-queued">queued ×{queued}</span>}
					<span className="pn-footer-spacer" />
					{canSwitchModel && (
						<span className="pn-pop-anchor">
							<button
								type="button"
								className="pn-model-chip"
								aria-haspopup="menu"
								aria-expanded={menu === "model"}
								onClick={() => setMenu(open => (open === "model" ? null : "model"))}
							>
								<span className="pn-model-name">{currentModel.name || currentModel.id}</span>
								<ChevronDown size={11} />
							</button>
							{menu === "model" && (
								<ModelPicker
									list={models}
									current={currentModel}
									onPick={model => {
										session?.setModel?.(model).catch(error => {
											props.onNotify(
												"error",
												`Couldn’t switch model: ${error instanceof Error ? error.message : String(error)}`,
											);
										});
									}}
									onClose={() => setMenu(null)}
								/>
							)}
						</span>
					)}
					{working && !readOnly && (
						<button
							type="button"
							className="pn-stop"
							aria-label="Stop omp"
							data-tip="Stop"
							data-tip-side="above"
							onClick={props.onStop}
						>
							<span className="pn-stop-glyph" />
						</button>
					)}
					{(!working || canSend) && (
						<button
							type="button"
							className="pn-send"
							aria-label={working ? "Queue message" : "Send"}
							disabled={!canSend}
							onClick={send}
						>
							{uploading ? <span className="pn-send-wait" /> : <ArrowUp size={16} strokeWidth={2.2} />}
						</button>
					)}
				</div>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					hidden
					onChange={event => {
						addFiles([...(event.target.files ?? [])]);
						event.target.value = "";
					}}
				/>
			</div>
			{preview !== null && <Lightbox image={preview} onClose={() => setPreview(null)} />}
		</div>
	);
}
