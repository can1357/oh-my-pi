/**
 * Debug command handler with interactive menu.
 *
 * Provides tools for debugging, bug report generation, and system diagnostics.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as fs from "node:fs/promises";
import * as url from "node:url";
import { getWorkProfile } from "@oh-my-pi/pi-natives";
import {
	isNotificationSuppressed,
	Loader,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	Spacer,
	TERMINAL,
	type TerminalNotification,
	Text,
} from "@oh-my-pi/pi-tui";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { editorKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { DynamicBorder } from "@oh-my-pi/pi-tui/chrome/dynamic-border";
import { OverlayPanel } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { TranscriptBlock } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getSelectListTheme, getSymbolTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../modes/types";
import { formatBytes } from "@oh-my-pi/pi-tui/render/render-utils";
import { openPath } from "../utils/open";
import { copyToClipboard } from "../utils/clipboard";
import { DebugLogViewerComponent } from "@oh-my-pi/pi-tui/apps/debug/log-viewer";
import { collectMemoryStats, type ProfilerSession, startCpuProfile } from "./profiler";
import { buildSampleImage, ProtocolProbeComponent } from "@oh-my-pi/pi-tui/apps/debug/protocol-probe";
import { RawSseViewerComponent } from "@oh-my-pi/pi-tui/apps/debug/raw-sse";
import { resolveRawSseDebugBuffer } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";
import { getRemoteDebugger, type RemoteDebuggerInfo, startRemoteDebuggerServer } from "./remote-debugger";
import { clearArtifactCache, createDebugLogSource, createReportBundle, getArtifactCacheStats } from "./report-bundle";
import { collectSystemInfo, formatSystemInfo } from "./system-info";
import { collectTerminalState, formatTerminalState } from "@oh-my-pi/pi-tui/apps/debug/terminal-info";

/** Debug menu options */
const DEBUG_MENU_ITEMS: SelectItem[] = [
	{
		value: "open-artifacts",
		label: __ompTranslate("Open: artifact folder"),
		description: __ompTranslate("Open session artifacts in file manager"),
	},
	{
		value: "performance",
		label: __ompTranslate("Report: performance issue"),
		description: __ompTranslate("Profile CPU, reproduce, then bundle"),
	},
	{
		value: "work",
		label: __ompTranslate("Profile: work scheduling"),
		description: __ompTranslate("Open flamegraph of last 30s"),
	},
	{
		value: "dump",
		label: __ompTranslate("Report: dump session"),
		description: __ompTranslate("Create report bundle immediately"),
	},
	{
		value: "memory",
		label: __ompTranslate("Report: memory issue"),
		description: __ompTranslate("Memory statistics + bundle"),
	},
	{
		value: "logs",
		label: __ompTranslate("View: recent logs"),
		description: __ompTranslate("Show last 50 log entries"),
	},
	{
		value: "system",
		label: __ompTranslate("View: system info"),
		description: __ompTranslate("Show environment details"),
	},
	{
		value: "terminal",
		label: __ompTranslate("View: terminal state"),
		description: __ompTranslate("Subprotocols, geometry, scrollback strategy"),
	},
	{
		value: "protocols",
		label: __ompTranslate("Test: terminal protocols"),
		description: __ompTranslate("Styling, links, text sizing, graphics, notify"),
	},
	{
		value: "raw-sse",
		label: __ompTranslate("View: raw SSE stream"),
		description: __ompTranslate("Show live provider SSE frames"),
	},
	{
		value: "remote-debugger",
		label: __ompTranslate("Start: JS remote debugger"),
		description: __ompTranslate("Expose JavaScriptCore inspector socket (experimental)"),
	},
	{
		value: "transcript",
		label: __ompTranslate("Export: TUI transcript"),
		description: __ompTranslate("Write visible TUI conversation to a temp txt"),
	},
	{
		value: "clear-cache",
		label: __ompTranslate("Clear: artifact cache"),
		description: __ompTranslate("Remove old session artifacts"),
	},
];

const formatFileHyperlink = (path: string): string => {
	const fileUrl = url.pathToFileURL(path).href;
	return `\x1b]8;;${fileUrl}\x07${path}\x1b]8;;\x07`;
};

/**
 * Debug selector component.
 */
export class DebugSelectorComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		private ctx: InteractiveModeContext,
		onDone: () => void,
	) {
		super(__ompTranslate("Debug Tools"));

		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(DEBUG_MENU_ITEMS, 7, getSelectListTheme());

		this.#selectList.onSelect = item => {
			onDone();
			void this.#handleSelection(item.value);
		};

		this.#selectList.onCancel = () => {
			onDone();
		};

		this.addChild(this.#selectList);
	}

	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	async #handleSelection(value: string): Promise<void> {
		switch (value) {
			case "open-artifacts":
				await this.#handleOpenArtifacts();
				break;
			case "performance":
				await this.#handlePerformanceReport();
				break;
			case "work":
				await this.#handleWorkReport();
				break;
			case "dump":
				await this.#handleDumpReport();
				break;
			case "memory":
				await this.#handleMemoryReport();
				break;
			case "logs":
				await this.#handleViewLogs();
				break;
			case "raw-sse":
				await this.#handleViewRawSse();
				break;
			case "remote-debugger":
				await this.#handleStartRemoteDebugger();
				break;
			case "system":
				await this.#handleViewSystemInfo();
				break;
			case "terminal":
				await this.#handleViewTerminalState();
				break;
			case "protocols":
				await this.#handleViewProtocols();
				break;
			case "transcript":
				await this.#handleTranscriptExport();
				break;
			case "clear-cache":
				await this.#handleClearCache();
				break;
		}
	}

	async #handlePerformanceReport(): Promise<void> {
		// Start profiling
		let session: ProfilerSession;
		try {
			session = await startCpuProfile();
		} catch (err) {
			this.ctx.showError(
				__ompTranslate("Failed to start profiler: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
			return;
		}

		// Show message and wait for keypress
		const block = new TranscriptBlock();
		block.addChild(new Text(theme.fg("accent", `${theme.status.info} CPU profiling started`), 1, 0));
		block.addChild(new Spacer(1));
		block.addChild(
			new Text(
				theme.fg(
					"muted",
					__ompTranslate(
						"Reproduce the performance issue, then press {0} to stop profiling.",
						`${editorKey("tui.input.submit")}`,
					),
				),
				1,
				0,
			),
		);
		this.ctx.present(block);

		// Wait for Enter keypress
		const { promise, resolve } = Promise.withResolvers<void>();
		const originalOnEscape = this.ctx.editor.onEscape;
		const originalOnSubmit = this.ctx.editor.onSubmit;

		this.ctx.editor.onSubmit = () => {
			this.ctx.editor.onEscape = originalOnEscape;
			this.ctx.editor.onSubmit = originalOnSubmit;
			resolve();
		};

		this.ctx.editor.onEscape = () => {
			this.ctx.editor.onEscape = originalOnEscape;
			this.ctx.editor.onSubmit = originalOnSubmit;
			resolve();
		};

		await promise;

		// Stop profiling and create report
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			__ompTranslate("Generating report..."),
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const cpuProfile = await session.stop();
			const workProfile = getWorkProfile(30);
			const result = await createReportBundle({
				sessionFile: this.ctx.sessionManager.getSessionFile(),
				settings: this.#getResolvedSettings(),
				rawSseText: this.#getRawSseText(),
				cpuProfile,
				workProfile,
			});

			loader.stop();
			this.ctx.statusContainer.clear();

			const block = new TranscriptBlock();
			block.addChild(new Text(theme.fg("success", __ompTranslate("+ Performance report saved")), 1, 0));
			block.addChild(new Text(theme.fg("dim", formatFileHyperlink(result.path)), 1, 0));
			block.addChild(new Text(theme.fg("dim", __ompTranslate("Files: {0}", `${result.files.length}`)), 1, 0));
			this.ctx.present(block);
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(
				__ompTranslate("Failed to create report: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	async #handleWorkReport(): Promise<void> {
		try {
			const workProfile = getWorkProfile(30);

			if (!workProfile.svg) {
				this.ctx.showWarning(__ompTranslate("No work profile data ({0} samples)", `${workProfile.sampleCount}`));
				return;
			}

			// Write SVG to temp file and open in browser
			const tmpPath = `/tmp/work-profile-${Date.now()}.svg`;
			await Bun.write(tmpPath, workProfile.svg);

			openPath(tmpPath);

			this.ctx.present([
				new Spacer(1),
				new Text(
					theme.fg("dim", __ompTranslate("Opened flamegraph ({0} samples)", `${workProfile.sampleCount}`)),
					1,
					0,
				),
			]);
		} catch (err) {
			this.ctx.showError(
				__ompTranslate("Failed to open profile: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	async #handleDumpReport(): Promise<void> {
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			__ompTranslate("Creating report bundle..."),
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const result = await createReportBundle({
				sessionFile: this.ctx.sessionManager.getSessionFile(),
				settings: this.#getResolvedSettings(),
				rawSseText: this.#getRawSseText(),
			});

			loader.stop();
			this.ctx.statusContainer.clear();

			const block = new TranscriptBlock();
			block.addChild(new Text(theme.fg("success", __ompTranslate("+ Report bundle saved")), 1, 0));
			block.addChild(new Text(theme.fg("dim", formatFileHyperlink(result.path)), 1, 0));
			block.addChild(new Text(theme.fg("dim", __ompTranslate("Files: {0}", `${result.files.length}`)), 1, 0));
			this.ctx.present(block);
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(
				__ompTranslate("Failed to create report: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	async #handleMemoryReport(): Promise<void> {
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			__ompTranslate("Collecting memory statistics..."),
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const memoryStats = collectMemoryStats();
			loader.setText(__ompTranslate("Creating report bundle..."));

			const result = await createReportBundle({
				sessionFile: this.ctx.sessionManager.getSessionFile(),
				settings: this.#getResolvedSettings(),
				rawSseText: this.#getRawSseText(),
				memoryStats,
			});

			loader.stop();
			this.ctx.statusContainer.clear();

			const block = new TranscriptBlock();
			block.addChild(new Text(theme.fg("success", __ompTranslate("+ Memory report saved")), 1, 0));
			block.addChild(new Text(theme.fg("dim", formatFileHyperlink(result.path)), 1, 0));
			block.addChild(new Text(theme.fg("dim", __ompTranslate("Files: {0}", `${result.files.length}`)), 1, 0));
			block.addChild(
				new Text(
					theme.fg(
						"warning",
						__ompTranslate(
							"Review before sharing: session data, artifacts, logs and settings may contain secrets.",
						),
					),
					1,
					0,
				),
			);
			this.ctx.present(block);
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(
				__ompTranslate("Failed to create report: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	async #handleViewLogs(): Promise<void> {
		try {
			const logSource = await createDebugLogSource();
			const logs = await logSource.getInitialText();
			if (!logs && !logSource.hasOlderLogs()) {
				this.ctx.showWarning(__ompTranslate("No log entries found for today."));
				return;
			}

			let overlay: OverlayHandle | undefined;
			const close = (): void => {
				overlay?.hide();
				overlay = undefined;
				void this.ctx.showDebugSelector();
			};
			const viewer = new DebugLogViewerComponent({
				logs,
				terminalRows: this.ctx.ui.terminal.rows,
				onExit: close,
				onStatus: message => this.ctx.showStatus(message, { dim: true }),
				onError: message => this.ctx.showError(message),
				onUpdate: () => this.ctx.ui.requestRender(),
				deps: {
					copyToClipboard,
					hasOlderLogs: () => logSource.hasOlderLogs(),
					loadOlderLogs: limitDays => logSource.loadOlderLogs(limitDays),
				},
			});

			overlay = this.ctx.ui.showOverlay(viewer, {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(viewer);
		} catch (err) {
			this.ctx.showError(
				__ompTranslate("Failed to read logs: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
		}

		this.ctx.ui.requestRender();
	}

	async #handleViewRawSse(): Promise<void> {
		let overlay: OverlayHandle | undefined;
		const close = (): void => {
			viewer?.dispose();
			overlay?.hide();
			overlay = undefined;
			void this.ctx.showDebugSelector();
		};
		const viewer = new RawSseViewerComponent({
			deps: { copyToClipboard },
			buffer: resolveRawSseDebugBuffer(this.ctx.session),
			terminalRows: this.ctx.ui.terminal.rows,
			onExit: close,
			onStatus: message => this.ctx.showStatus(message, { dim: true }),
			onUpdate: () => this.ctx.ui.requestRender(),
		});

		overlay = this.ctx.ui.showOverlay(viewer, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(viewer);
		this.ctx.ui.requestRender();
	}

	async #handleStartRemoteDebugger(): Promise<void> {
		const existing = getRemoteDebugger();
		let info: RemoteDebuggerInfo;
		try {
			info = existing ?? (await startRemoteDebuggerServer());
		} catch (err) {
			this.ctx.showError(
				__ompTranslate(
					"Failed to start remote debugger: {0}",
					`${err instanceof Error ? err.message : String(err)}`,
				),
			);
			return;
		}

		const block = new TranscriptBlock();
		block.addChild(
			new Text(
				theme.fg(
					"success",
					__ompTranslate(
						"{0} JavaScriptCore remote inspector {1}",
						`${theme.status.success}`,
						`${existing ? __ompTranslate("already running") : __ompTranslate("started")}`,
					),
				),
				1,
				0,
			),
		);
		block.addChild(
			new Text(theme.fg("dim", __ompTranslate("Listening on {0}:{1}", `${info.host}`, `${info.port}`)), 1, 0),
		);
		block.addChild(
			new Text(
				theme.fg(
					"muted",
					__ompTranslate(
						"Experimental WebKit RemoteInspectorServer socket (Bun marks it untested on macOS). One-way for this process — there is no stop. Attach a compatible WebKit/Safari Web Inspector client.",
					),
				),
				1,
				0,
			),
		);
		this.ctx.present(block);
	}

	async #handleViewSystemInfo(): Promise<void> {
		try {
			const info = await collectSystemInfo();
			const formatted = formatSystemInfo(info);

			const block = new TranscriptBlock();
			block.addChild(new DynamicBorder());
			block.addChild(new Text(formatted, 1, 0));
			block.addChild(new DynamicBorder());
			this.ctx.present(block);
		} catch (err) {
			this.ctx.showError(
				__ompTranslate("Failed to collect system info: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	async #handleViewTerminalState(): Promise<void> {
		const info = collectTerminalState({
			columns: this.ctx.ui.terminal.columns,
			rows: this.ctx.ui.terminal.rows,
			synchronizedOutput: this.ctx.ui.synchronizedOutput,
		});
		const formatted = formatTerminalState(info);

		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder());
		block.addChild(new Text(formatted, 1, 0));
		block.addChild(new DynamicBorder());
		this.ctx.present(block);
	}

	async #handleViewProtocols(): Promise<void> {
		// Fire the desktop notification as a real side effect, then render a
		// panel that samples every other special protocol and reports the
		// notification outcome.
		const suppressed = isNotificationSuppressed();
		if (!suppressed) {
			const sessionName = this.ctx.sessionManager.getSessionName();
			const notification: TerminalNotification = {
				title: sessionName || "omp",
				body: __ompTranslate("Terminal protocol test"),
				type: "test",
				actions: "focus",
			};
			TERMINAL.sendNotification(notification);
		}

		this.ctx.present([
			new Spacer(1),
			new ProtocolProbeComponent({
				image: buildSampleImage(),
				imageBudget: this.ctx.ui.imageBudget,
				notificationSuppressed: suppressed,
			}),
		]);
	}

	async #handleTranscriptExport(): Promise<void> {
		await this.ctx.handleDebugTranscriptCommand();
	}
	async #handleOpenArtifacts(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showWarning(__ompTranslate("No active session file."));
			return;
		}

		const artifactsDir = sessionFile.slice(0, -6);

		try {
			const stat = await fs.stat(artifactsDir);
			if (!stat.isDirectory()) {
				this.ctx.showWarning("Artifact folder does not exist yet.");
				return;
			}
		} catch {
			this.ctx.showWarning("Artifact folder does not exist yet.");
			return;
		}

		openPath(artifactsDir);
		this.ctx.showStatus(__ompTranslate("Opened: {0}", `${artifactsDir}`));
	}

	async #handleClearCache(): Promise<void> {
		const sessionsDir = getSessionsDir();

		// Get stats first
		const stats = await getArtifactCacheStats(sessionsDir);

		if (stats.count === 0) {
			this.ctx.showStatus(__ompTranslate("Artifact cache is empty."));
			return;
		}

		const sizeStr = formatBytes(stats.totalSize);
		const oldestStr = stats.oldestDate ? stats.oldestDate.toLocaleDateString() : __ompTranslate("unknown");

		// Show confirmation
		const confirmed = await this.ctx.showHookConfirm(
			__ompTranslate("Clear Artifact Cache"),
			__ompTranslate(
				"Found {0} artifact files ({1})\nOldest: {2}\n\nRemove artifacts older than 30 days?",
				`${stats.count}`,
				`${sizeStr}`,
				`${oldestStr}`,
			),
		);

		if (!confirmed) {
			this.ctx.showStatus(__ompTranslate("Cache clear cancelled."));
			return;
		}

		// Clear cache
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			__ompTranslate("Clearing artifact cache..."),
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const result = await clearArtifactCache(sessionsDir, 30);

			loader.stop();
			this.ctx.statusContainer.clear();

			this.ctx.present([
				new Spacer(1),
				new Text(
					theme.fg("success", __ompTranslate("- Cleared {0} artifact directories", `${result.removed}`)),
					1,
					0,
				),
			]);
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(
				__ompTranslate("Failed to clear cache: {0}", `${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	#getRawSseText(): string | undefined {
		const rawSseText = resolveRawSseDebugBuffer(this.ctx.session).toRawText();
		return rawSseText.trim().length > 0 ? rawSseText : undefined;
	}

	#getResolvedSettings(): Record<string, unknown> {
		// Extract key settings for the report
		return {
			model: this.ctx.session.model?.id,
			thinkingLevel: this.ctx.session.thinkingLevel,
			planModeEnabled: this.ctx.planModeEnabled,
			toolOutputExpanded: this.ctx.toolOutputExpanded,
			hideThinkingBlock: this.ctx.hideThinkingBlock,
		};
	}
}

/**
 * Show the debug selector.
 */
export function showDebugSelector(ctx: InteractiveModeContext, done: () => void): DebugSelectorComponent {
	const selector = new DebugSelectorComponent(ctx, done);
	return selector;
}
