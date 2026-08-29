/**
 * `omp render` — draw a session's entire thread through the production
 * transcript pipeline, headlessly.
 *
 * Replays the session into a real `InteractiveMode` + `TUI` wired to an
 * in-process byte-sink terminal, then prints the composed transcript lines.
 * `--timing` reports phase costs; `--repaint N` re-runs the clear-scrollback
 * full repaint that `/tree`, Esc-Esc navigation, `/resume`, and theme changes
 * issue — the frame whose cost users feel as a frozen UI on big sessions.
 *
 * The session file is copied to a temp dir before opening, so rendering never
 * takes the single-writer lock on (or appends breadcrumbs to) a live session.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Terminal, TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import type { RenderScheduler } from "@oh-my-pi/pi-tui/tui";
import { getProjectDir, isEnoent, logger, TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { Composer } from "../modes/composer";
import { InteractiveMode } from "../modes/interactive-mode";
import { initTheme } from "../modes/theme/theme";
import { AgentSession } from "../session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";

export interface RenderCommandArgs {
	/** Session file path or id prefix; default: most recent session for cwd. */
	session?: string;
	/** Terminal width in columns. Default: current terminal width, else 120. */
	width?: number;
	/** Terminal height in rows. Default: current terminal height, else 40. */
	height?: number;
	/** Print phase timings and byte counts to stderr. */
	timing?: boolean;
	/** Re-run the full clear-scrollback repaint N times and report each cost. */
	repaint?: number;
	/** Strip ANSI styling from the printed transcript. */
	plain?: boolean;
	/** Suppress the transcript output (timing/benchmark runs). */
	quiet?: boolean;
}

/** Byte-sink terminal: counts emitted output, never touches a real TTY. */
class SinkTerminal implements Terminal {
	bytes = 0;
	writes = 0;
	readonly #columns: number;
	readonly #rows: number;

	constructor(columns: number, rows: number) {
		this.#columns = columns;
		this.#rows = rows;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += Buffer.byteLength(data);
		this.writes++;
	}
	get columns(): number {
		return this.#columns;
	}
	get rows(): number {
		return this.#rows;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	refreshAppearance(_requestToken?: TerminalAppearanceRequestToken): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
}

/**
 * Deterministic render scheduler: queues callbacks instead of arming timers so
 * the command can drain every pending paint synchronously between phases.
 */
class DrainScheduler implements RenderScheduler {
	#time = 0;
	#immediate: (() => void)[] = [];
	#renders = new Map<number, () => void>();
	#nextId = 0;

	now(): number {
		this.#time += 20;
		return this.#time;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediate.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const id = this.#nextId++;
		this.#renders.set(id, callback);
		return { cancel: () => void this.#renders.delete(id) };
	}

	/** Run queued callbacks until no render work remains. */
	drain(): void {
		for (let rounds = 0; this.#immediate.length > 0 || this.#renders.size > 0; rounds++) {
			if (rounds > 100) throw new Error("render scheduler did not settle after 100 drain rounds");
			const immediate = this.#immediate;
			this.#immediate = [];
			for (const callback of immediate) callback();
			if (this.#renders.size === 0) continue;
			const renders = [...this.#renders.values()];
			this.#renders.clear();
			for (const callback of renders) callback();
		}
	}
}

/** Resolve the target session file from a path, id prefix, or cwd default. */
async function resolveTargetSession(sessionArg: string | undefined, cwd: string): Promise<string> {
	if (sessionArg) {
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			const resolved = path.resolve(sessionArg);
			try {
				await fs.access(resolved);
				return resolved;
			} catch (err) {
				if (isEnoent(err)) throw new Error(`Session file not found: ${resolved}`);
				throw err;
			}
		}
		const match = await resolveResumableSession(sessionArg, cwd);
		if (!match) throw new Error(`Session "${sessionArg}" not found.`);
		return match.session.path;
	}
	const recent = await findMostRecentSession(SessionManager.getDefaultSessionDir(cwd));
	if (!recent) throw new Error(`No sessions found for ${cwd}. Pass a session file or id.`);
	return recent;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

function formatMs(ms: number): string {
	return `${ms.toFixed(0)} ms`;
}

/** Render the resolved session and report timings. Returns the exit code. */
export async function runRenderCommand(args: RenderCommandArgs): Promise<number> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	await initTheme();

	const sourcePath = await resolveTargetSession(args.session, cwd);
	const sourceSize = (await fs.stat(sourcePath)).size;

	// Copy before opening: SessionManager.open takes the single-writer lock and
	// session teardown appends a session_exit entry — neither may touch a live
	// session file the user has open in another omp.
	const tempDir = TempDir.createSync("@omp-render-");
	const workingCopy = path.join(tempDir.path(), path.basename(sourcePath));

	const width = args.width ?? (process.stdout.isTTY ? process.stdout.columns : undefined) ?? 120;
	const height = args.height ?? (process.stdout.isTTY ? process.stdout.rows : undefined) ?? 40;

	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	try {
		await fs.copyFile(sourcePath, workingCopy);
		const openStart = performance.now();
		const sessionManager = await SessionManager.open(workingCopy, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		const openMs = performance.now() - openStart;

		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.getAll()[0];
		if (!model) throw new Error("No models available in the bundled catalog");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry,
		});
		const terminal = new SinkTerminal(width, height);
		const scheduler = new DrainScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		mode = new InteractiveMode(session, VERSION, undefined, undefined, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		scheduler.drain();

		// Replay: transcript context build + component construction (the phase
		// renderInitialMessages runs after /tree navigation and on resume).
		const replayStart = performance.now();
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		const replayMs = performance.now() - replayStart;

		// First full paint: compose every transcript row and emit it, exactly
		// what the clear-scrollback repaint after navigation writes to the PTY.
		const paintStart = performance.now();
		const bytesBeforePaint = terminal.bytes;
		scheduler.drain();
		const paintMs = performance.now() - paintStart;
		const paintBytes = terminal.bytes - bytesBeforePaint;

		const entries = sessionManager.getEntries();
		let messageCount = 0;
		for (const entry of entries) if (entry.type === "message") messageCount++;

		const repaints: { ms: number; bytes: number }[] = [];
		for (let i = 0; i < (args.repaint ?? 0); i++) {
			const start = performance.now();
			const before = terminal.bytes;
			mode.ui.requestRender(true, { clearScrollback: true });
			scheduler.drain();
			repaints.push({ ms: performance.now() - start, bytes: terminal.bytes - before });
		}

		if (!args.quiet) {
			const lines = mode.chatContainer.render(width);
			const text = args.plain ? lines.map(line => Bun.stripANSI(line)).join("\n") : lines.join("\n");
			process.stdout.write(text);
			process.stdout.write("\n");
		}

		if (args.timing || args.repaint) {
			const rows = mode.chatContainer.render(width).length;
			const report = [
				`session  ${sourcePath}`,
				`         ${formatBytes(sourceSize)}, ${entries.length} entries, ${messageCount} messages, ${rows} transcript rows @ ${width}x${height}`,
				`open     ${formatMs(openMs)}`,
				`replay   ${formatMs(replayMs)}  (transcript build + component construction)`,
				`paint    ${formatMs(paintMs)}  (full frame compose + emit: ${formatBytes(paintBytes)}, ${terminal.writes} writes)`,
			];
			if (repaints.length > 0) {
				const times = repaints.map(r => r.ms);
				const avg = times.reduce((a, b) => a + b, 0) / times.length;
				const min = Math.min(...times);
				const max = Math.max(...times);
				const bytesPer = repaints[0]!.bytes;
				report.push(
					`repaint  ${formatMs(avg)} avg over ${repaints.length} (min ${formatMs(min)}, max ${formatMs(max)}), ${formatBytes(bytesPer)}/frame`,
				);
			}
			process.stderr.write(`${report.join("\n")}\n`);
		}
		return 0;
	} finally {
		try {
			mode?.stop();
			await session?.dispose();
		} catch (err) {
			logger.debug("omp render teardown failed", { error: String(err) });
		}
		tempDir.removeSync();
	}
}
