/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/debug`: the debug tools menu (profiling, report bundles, log and raw SSE
 * viewers, system/terminal state, the terminal protocol probe, the JS remote
 * debugger, cache maintenance).
 *
 * Everything runs against a {@link DebugHost}: the interactive session's
 * shell (overlays, driver), composer, status HUD and transcript, shaped after
 * the interactive mode context so the context passes as the host.
 */
import * as fs from "node:fs/promises";
import * as url from "node:url";
import { getWorkProfile } from "@oh-my-pi/pi-natives";
import { type JSXNode, nativeRendering, signal } from "@oh-my-pi/pi-tui";
import { isNotificationSuppressed, type TerminalNotification } from "@oh-my-pi/pi-tui/driver/notify";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatBytes, getSessionsDir } from "@oh-my-pi/pi-utils";
import { getKeybindings } from "../config/keybindings/keybindings";
import type { Settings } from "../config/settings";
import { buildSampleImage } from "../modes/view-model/apps/debug/protocol-probe";
import { collectTerminalState, formatTerminalState } from "../modes/view-model/apps/debug/terminal-info";
import { cfgTuiHyperlinks, cfgTuiTextSizing } from "../modes/settings";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { type FullscreenShell, presentFullscreen } from "../ui/apps/fullscreen";
import { LogViewer, LogViewerModel } from "../ui/apps/log-viewer";
import { ProtocolProbe } from "../ui/apps/protocol-probe";
import { RawSseMain, RawSseViewer, RawSseViewerModel } from "../ui/apps/raw-sse";
import type { Composer } from "../ui/composer";
import type { StatusHudModel } from "../ui/dock/status";
import { actionKey } from "../ui/keys/hints";
import { SelectCard } from "../ui/overlays/panels/select-card";
import { SelectSheet } from "../ui/overlays/pickers/select-sheet";
import { copyToClipboard } from "../utils/clipboard";
import { openPath } from "../utils/open";
import { collectMemoryStats, type ProfilerSession, startCpuProfile } from "./profiler";
import { resolveRawSseDebugBuffer } from "./raw-sse-buffer";
import { getRemoteDebugger, type RemoteDebuggerInfo, startRemoteDebuggerServer } from "./remote-debugger";
import {
	clearArtifactCache,
	createDebugLogSource,
	createReportBundle,
	type DebugLogSource,
	getArtifactCacheStats,
} from "./report-bundle";
import { collectSystemInfo, formatSystemInfo } from "./system-info";

/**
 * What the debug tools use from the interactive session (the C2 interactive
 * mode context satisfies it).
 */
export interface DebugHost {
	readonly shell: FullscreenShell;
	readonly composer: Pick<Composer, "addKeyHandler">;
	readonly hud: { readonly status: Pick<StatusHudModel, "row"> };
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly planModeEnabled: boolean;
	readonly toolOutputExpanded: boolean;
	readonly hideThinkingBlock: boolean;
	/** Append a block to the transcript. */
	present(factory: () => JSXNode): unknown;
	showStatus(message: string, options?: { dim?: boolean }): void;
	showWarning(message: string): void;
	showError(message: string): void;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	handleDebugTranscriptCommand(): Promise<void>;
	/** Reopen the debug menu (a viewer closed). */
	showDebugSelector(): Promise<void>;
}

/** Debug menu options. */
const DEBUG_MENU_ITEMS = [
	{ id: "open-artifacts", label: "Open: artifact folder", detail: "Open session artifacts in file manager" },
	{ id: "performance", label: "Report: performance issue", detail: "Profile CPU, reproduce, then bundle" },
	{ id: "work", label: "Profile: work scheduling", detail: "Open flamegraph of last 30s" },
	{ id: "dump", label: "Report: dump session", detail: "Create report bundle immediately" },
	{ id: "memory", label: "Report: memory issue", detail: "Memory statistics + bundle" },
	{ id: "logs", label: "View: recent logs", detail: "Show last 50 log entries" },
	{ id: "system", label: "View: system info", detail: "Show environment details" },
	{ id: "terminal", label: "View: terminal state", detail: "Subprotocols, geometry, scrollback strategy" },
	{ id: "protocols", label: "Test: terminal protocols", detail: "Styling, links, text sizing, graphics, notify" },
	{ id: "raw-sse", label: "View: raw SSE stream", detail: "Show live provider SSE frames" },
	{
		id: "remote-debugger",
		label: "Start: JS remote debugger",
		detail: "Expose JavaScriptCore inspector socket (experimental)",
	},
	{ id: "transcript", label: "Export: TUI transcript", detail: "Write visible TUI conversation to a temp txt" },
	{ id: "clear-cache", label: "Clear: artifact cache", detail: "Remove old session artifacts" },
] as const;

type DebugAction = (typeof DEBUG_MENU_ITEMS)[number]["id"];

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A transcript block of styled lines. */
function Lines(props: { readonly lines: readonly (readonly TspSpan[])[] }): JSXNode {
	return (
		<col>
			{props.lines.map((spans, index) => (
				<text key={String(index)} spans={[...spans]} />
			))}
		</col>
	);
}

/**
 * A transcript block of plain text between two border rules. Tern draws its
 * own chrome, so there the rules describe nothing and the text is one
 * wrapped block.
 */
function Framed(props: { readonly text: string }): JSXNode {
	return (
		<col>
			{() =>
				nativeRendering()
					? [
							<col key="top" hidden />,
							<text key="text" wrap="word" spans={[{ t: props.text }]} />,
							<col key="bottom" hidden />,
						]
					: [
							<rule key="top" />,
							...props.text
								.split("\n")
								.map((line, index) => <text key={String(index)} spans={[{ t: line || " " }]} />),
							<rule key="bottom" />,
						]
			}
		</col>
	);
}

/** `+ <title>`, the bundle path (a file link) and its file count. */
function reportLines(title: string, result: { path: string; files: readonly string[] }): TspSpan[][] {
	return [
		[{ s: "success", t: `+ ${title}` }],
		[{ s: "dim", t: result.path, href: url.pathToFileURL(result.path).href }],
		[{ s: "dim", t: `Files: ${result.files.length}` }],
	];
}

/** The debug tools against one host. */
export class DebugTools {
	readonly #host: DebugHost;

	constructor(host: DebugHost) {
		this.#host = host;
	}

	/** Run the menu entry `action`. */
	async run(action: DebugAction): Promise<void> {
		switch (action) {
			case "open-artifacts":
				return this.#openArtifacts();
			case "performance":
				return this.#performanceReport();
			case "work":
				return this.#workReport();
			case "dump":
				return this.#dumpReport();
			case "memory":
				return this.#memoryReport();
			case "logs":
				return this.#viewLogs();
			case "raw-sse":
				return this.#viewRawSse();
			case "remote-debugger":
				return this.#startRemoteDebugger();
			case "system":
				return this.#viewSystemInfo();
			case "terminal":
				return this.#viewTerminalState();
			case "protocols":
				return this.#viewProtocols();
			case "transcript":
				return this.#host.handleDebugTranscriptCommand();
			case "clear-cache":
				return this.#clearCache();
		}
	}

	/** Show a working row with `label` while `work` runs; `setLabel` relabels it. */
	async #working<T>(label: string, work: (setLabel: (label: string) => void) => Promise<T>): Promise<T> {
		const text = signal(label);
		const row = this.#host.hud.status.row;
		row.set({ kind: "working", spec: { label: () => text(), startedAt: Date.now() } });
		try {
			return await work(next => text.set(next));
		} finally {
			row.set(undefined);
		}
	}

	#present(lines: readonly (readonly TspSpan[])[]): void {
		this.#host.present(() => <Lines lines={lines} />);
	}

	/** Resolves on the next submit or escape in the composer (the key is consumed). */
	#awaitSubmit(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const keybindings = getKeybindings();
		const remove = this.#host.composer.addKeyHandler(key => {
			if (key.kind === "release") return false;
			if (!keybindings.matches(key, "tui.input.submit") && key.id !== "escape") return false;
			remove();
			resolve();
			return true;
		});
		return promise;
	}

	async #performanceReport(): Promise<void> {
		let session: ProfilerSession;
		try {
			session = await startCpuProfile();
		} catch (err) {
			this.#host.showError(`Failed to start profiler: ${errorText(err)}`);
			return;
		}
		this.#host.present(() => (
			<col>
				<text spans={[{ s: "accent", t: "ⓘ CPU profiling started" }]} />
				<spacer />
				<text
					spans={[
						{
							s: "muted",
							t: `Reproduce the performance issue, then press ${actionKey("tui.input.submit")} to stop profiling.`,
						},
					]}
				/>
			</col>
		));
		await this.#awaitSubmit();
		try {
			const result = await this.#working("Generating report…", async () => {
				const cpuProfile = await session.stop();
				return createReportBundle({
					sessionFile: this.#host.sessionManager.getSessionFile(),
					settings: this.#resolvedSettings(),
					rawSseText: this.#rawSseText(),
					cpuProfile,
					workProfile: getWorkProfile(30),
				});
			});
			this.#present(reportLines("Performance report saved", result));
		} catch (err) {
			this.#host.showError(`Failed to create report: ${errorText(err)}`);
		}
	}

	async #workReport(): Promise<void> {
		try {
			const workProfile = getWorkProfile(30);
			if (!workProfile.svg) {
				this.#host.showWarning(`No work profile data (${workProfile.sampleCount} samples)`);
				return;
			}
			const tmpPath = `/tmp/work-profile-${Date.now()}.svg`;
			await Bun.write(tmpPath, workProfile.svg);
			openPath(tmpPath);
			this.#present([[{ s: "dim", t: `Opened flamegraph (${workProfile.sampleCount} samples)` }]]);
		} catch (err) {
			this.#host.showError(`Failed to open profile: ${errorText(err)}`);
		}
	}

	async #dumpReport(): Promise<void> {
		try {
			const result = await this.#working("Creating report bundle…", () =>
				createReportBundle({
					sessionFile: this.#host.sessionManager.getSessionFile(),
					settings: this.#resolvedSettings(),
					rawSseText: this.#rawSseText(),
				}),
			);
			this.#present(reportLines("Report bundle saved", result));
		} catch (err) {
			this.#host.showError(`Failed to create report: ${errorText(err)}`);
		}
	}

	async #memoryReport(): Promise<void> {
		try {
			const result = await this.#working("Collecting memory statistics…", setLabel => {
				const memoryStats = collectMemoryStats();
				setLabel("Creating report bundle…");
				return createReportBundle({
					sessionFile: this.#host.sessionManager.getSessionFile(),
					settings: this.#resolvedSettings(),
					rawSseText: this.#rawSseText(),
					memoryStats,
				});
			});
			this.#present([
				...reportLines("Memory report saved", result),
				[
					{
						s: "warning",
						t: "Review before sharing: session data, artifacts, logs and settings may contain secrets.",
					},
				],
			]);
		} catch (err) {
			this.#host.showError(`Failed to create report: ${errorText(err)}`);
		}
	}

	async #viewLogs(): Promise<void> {
		let logs: string;
		let logSource: DebugLogSource;
		try {
			logSource = await createDebugLogSource();
			logs = await logSource.getInitialText();
		} catch (err) {
			this.#host.showError(`Failed to read logs: ${errorText(err)}`);
			return;
		}
		if (!logs && !logSource.hasOlderLogs()) {
			this.#host.showWarning("No log entries found for today.");
			return;
		}
		await presentFullscreen(this.#host.shell, screen => {
			const done = Promise.withResolvers<void>();
			const model = new LogViewerModel({
				logs,
				terminalRows: screen.rows,
				onExit: () => done.resolve(),
				onStatus: message => this.#host.showStatus(message, { dim: true }),
				onError: message => this.#host.showError(message),
				deps: {
					copyToClipboard,
					hasOlderLogs: () => logSource.hasOlderLogs(),
					loadOlderLogs: () => logSource.loadOlderLogs(),
				},
			});
			return { view: () => <LogViewer model={model} />, done: done.promise };
		});
		await this.#host.showDebugSelector();
	}

	async #viewRawSse(): Promise<void> {
		const shell = this.#host.shell;
		await presentFullscreen(shell, screen => {
			const done = Promise.withResolvers<void>();
			const model = new RawSseViewerModel({
				buffer: resolveRawSseDebugBuffer(this.#host.session),
				terminalRows: screen.rows,
				copyToClipboard,
				onExit: () => done.resolve(),
				onStatus: message => this.#host.showStatus(message, { dim: true }),
			});
			// Natively the stream is a page of its own (the counters over the wire text) with the bar docked
			// under it; the terminal draws the whole viewer in the bar.
			return {
				view: () =>
					shell.native() ? (
						[<RawSseMain model={model} />, <RawSseViewer model={model} />]
					) : (
						<RawSseViewer model={model} />
					),
				page: { role: "omp.debug", dock: 1 },
				focus: root => root.children().at(-1) ?? root,
				done: done.promise,
				dispose: () => model.dispose(),
			};
		});
		await this.#host.showDebugSelector();
	}

	async #startRemoteDebugger(): Promise<void> {
		const existing = getRemoteDebugger();
		let info: RemoteDebuggerInfo;
		try {
			info = existing ?? (await startRemoteDebuggerServer());
		} catch (err) {
			this.#host.showError(`Failed to start remote debugger: ${errorText(err)}`);
			return;
		}
		this.#present([
			[{ s: "success", t: `✓ JavaScriptCore remote inspector ${existing ? "already running" : "started"}` }],
			[{ s: "dim", t: `Listening on ${info.host}:${info.port}` }],
			[
				{
					s: "muted",
					t: "Experimental WebKit RemoteInspectorServer socket (Bun marks it untested on macOS). One-way for this process — there is no stop. Attach a compatible WebKit/Safari Web Inspector client.",
				},
			],
		]);
	}

	async #viewSystemInfo(): Promise<void> {
		try {
			const formatted = formatSystemInfo(await collectSystemInfo());
			this.#host.present(() => <Framed text={formatted} />);
		} catch (err) {
			this.#host.showError(`Failed to collect system info: ${errorText(err)}`);
		}
	}

	#viewTerminalState(): void {
		const driver = this.#host.shell.host?.driver;
		if (!driver) {
			this.#host.showWarning("No terminal attached.");
			return;
		}
		const formatted = formatTerminalState(collectTerminalState(driver));
		this.#host.present(() => <Framed text={formatted} />);
	}

	#viewProtocols(): void {
		// Fire the desktop notification as a real side effect, then show a panel
		// sampling every other special protocol and the notification outcome.
		const driver = this.#host.shell.host?.driver;
		const suppressed = isNotificationSuppressed(Bun.env);
		if (!suppressed && driver) {
			const notification: TerminalNotification = {
				title: this.#host.sessionManager.getSessionName() || "omp",
				body: "Terminal protocol test",
				type: "test",
				actions: "focus",
			};
			driver.notify(notification);
		}
		const caps = driver?.capabilities;
		const identity = driver?.identity;
		const notify = identity?.notify;
		const linkImage = cfgTuiHyperlinks.get(this.#host.settings) !== "off";
		// A terminal separates blocks by a blank row; Tern gets the panel's own spacer.
		this.#host.present(() => [
			() => (nativeRendering() ? <spacer size="sm" /> : null),
			<ProtocolProbe
				image={buildSampleImage()}
				capabilities={{
					hyperlinks: caps?.hyperlinks ?? false,
					textSizing: cfgTuiTextSizing.get(this.#host.settings) && identity?.id === "kitty",
					trueColor: caps?.truecolor ?? false,
					images: caps?.images === "iterm" ? "iterm2" : (caps?.images ?? null),
					...(notify ? { notify: notify === "bell" ? "bel" : notify } : {}),
				}}
				notificationSuppressed={suppressed}
				linkImage={linkImage}
			/>,
		]);
	}

	async #openArtifacts(): Promise<void> {
		const sessionFile = this.#host.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.#host.showWarning("No active session file.");
			return;
		}
		const artifactsDir = sessionFile.slice(0, -6);
		try {
			const stat = await fs.stat(artifactsDir);
			if (!stat.isDirectory()) {
				this.#host.showWarning("Artifact folder does not exist yet.");
				return;
			}
		} catch {
			this.#host.showWarning("Artifact folder does not exist yet.");
			return;
		}
		openPath(artifactsDir);
		this.#host.showStatus(`Opened: ${artifactsDir}`);
	}

	async #clearCache(): Promise<void> {
		const sessionsDir = getSessionsDir();
		const stats = await getArtifactCacheStats(sessionsDir);
		if (stats.count === 0) {
			this.#host.showStatus("Artifact cache is empty.");
			return;
		}
		const sizeStr = formatBytes(stats.totalSize);
		const oldestStr = stats.oldestDate ? stats.oldestDate.toLocaleDateString() : "unknown";
		const confirmed = await this.#host.showHookConfirm(
			"Clear Artifact Cache",
			`Found ${stats.count} artifact files (${sizeStr})\nOldest: ${oldestStr}\n\nRemove artifacts older than 30 days?`,
		);
		if (!confirmed) {
			this.#host.showStatus("Cache clear cancelled.");
			return;
		}
		try {
			const result = await this.#working("Clearing artifact cache…", () => clearArtifactCache(sessionsDir, 30));
			const line: TspSpan[] = [{ s: "success", t: `- Cleared ${result.removed} artifact directories` }];
			// A terminal separates blocks by a blank row; Tern gets the line's own spacer over a wrapped text.
			this.#host.present(
				() => () =>
					nativeRendering() ? [<spacer size="sm" />, <text wrap="word" spans={line} />] : <Lines lines={[line]} />,
			);
		} catch (err) {
			this.#host.showError(`Failed to clear cache: ${errorText(err)}`);
		}
	}

	#rawSseText(): string | undefined {
		const rawSseText = resolveRawSseDebugBuffer(this.#host.session).toRawText();
		return rawSseText.trim().length > 0 ? rawSseText : undefined;
	}

	#resolvedSettings(): Record<string, unknown> {
		return {
			model: this.#host.session.model?.id,
			thinkingLevel: this.#host.session.thinkingLevel,
			planModeEnabled: this.#host.planModeEnabled,
			toolOutputExpanded: this.#host.toolOutputExpanded,
			hideThinkingBlock: this.#host.hideThinkingBlock,
		};
	}
}

/** Props of {@link DebugSelector}. */
export interface DebugSelectorProps {
	readonly host: DebugHost;
	/** The menu closed (a pick or a cancel); the picked tool runs after. */
	onDone(): void;
}

/**
 * The debug tools menu: in a Tern terminal a card in the composer's place (focus its `list`), on
 * terminal rows a select sheet (focus its `picker` child).
 */
export function DebugSelector(props: DebugSelectorProps): JSXNode {
	const tools = new DebugTools(props.host);
	if (props.host.shell.native()) {
		return (
			<SelectCard
				title="Debug Tools"
				items={DEBUG_MENU_ITEMS.map(item => ({ value: item.id, label: item.label, description: item.detail }))}
				maxVisible={7}
				onPick={id => {
					props.onDone();
					void tools.run(id as DebugAction);
				}}
				onCancel={() => props.onDone()}
			/>
		);
	}
	return (
		<SelectSheet
			title="Debug Tools"
			icon="bug"
			noun="tools"
			items={DEBUG_MENU_ITEMS.map(item => ({ id: item.id, label: item.label, detail: item.detail }))}
			term={{ maxRows: 7 }}
			onPick={id => {
				props.onDone();
				void tools.run(id as DebugAction);
			}}
			onCancel={() => props.onDone()}
		/>
	);
}
