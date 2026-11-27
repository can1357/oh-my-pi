/**
 * `omp render` — draw a session's entire thread through the production
 * transcript pipeline, headlessly.
 *
 * Replays the session into a real `InteractiveMode` rendering on an in-memory
 * terminal, then prints the composed transcript rows. `--timing` reports phase
 * costs; `--repaint N` re-runs the full history replay that `/tree`, Esc-Esc
 * navigation, `/resume`, and theme changes issue — the frame whose cost users
 * feel as a frozen UI on big sessions.
 *
 * The session file is copied to a temp dir before opening, so rendering never
 * takes the single-writer lock on (or appends breadcrumbs to) a live session.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatBytes, getProjectDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AppFrame } from "../modes/interactive/frame";
import { InteractiveMode } from "../modes/interactive-mode";
import { AgentSession } from "../session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import { resolveSessionFileArg } from "./session-arg";
import { SessionManager } from "../session/session-manager";
import { defaultSessionStorage, FileSessionStorage } from "../session/session-storage";
import { initTheme } from "../ui/theme/service";

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

/** Paint the transcript's blocks as the terminal draws them, blank rows between them included. */
function transcriptRows(mode: InteractiveMode, width: number): string[] {
	const transcript = mode.shell.transcript;
	const env = staticEnvironment(currentTheme());
	const rows: string[] = [];
	let above: UiNode | undefined;
	for (const node of transcript.nodes()) {
		const block = renderBlock(node, width, { env }).rows;
		if (block.length === 0) continue;
		if (above) for (let gap = transcript.separator(above, node); gap > 0; gap--) rows.push("");
		rows.push(...block);
		above = node;
	}
	return rows;
}

function formatMs(ms: number): string {
	return `${ms.toFixed(0)} ms`;
}

/** Render the resolved session and report timings. Returns the exit code. */
export async function runRenderCommand(args: RenderCommandArgs): Promise<number> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	initTheme();

	const storage = defaultSessionStorage();
	const sourcePath = await resolveSessionFileArg(args.session, cwd);
	const sourceSize = storage.statSync(sourcePath).size;

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
		// The copy goes into the same storage the original came from, because
		// that is where `SessionManager.open` below reads it.
		if (storage instanceof FileSessionStorage) await fs.copyFile(sourcePath, workingCopy);
		else await storage.writeText(workingCopy, await storage.readText(sourcePath));
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
		const terminal = memoryTerminal({ columns: width, rows: height });
		const frame = new AppFrame({ version: VERSION, shape: "band", quiet: true });
		await frame.start({ resizeScrollback: "rebuild", native: false, driver: terminal.options });
		mode = new InteractiveMode(session, VERSION, undefined, undefined, undefined, undefined, frame);
		await mode.init({ suppressWelcomeIntro: true });

		// Replay: transcript context build + block construction (the phase
		// renderInitialMessages runs after /tree navigation and on resume).
		const replayStart = performance.now();
		const painted = mode.shell.nextFrame();
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		const replayMs = performance.now() - replayStart;

		// First full paint: every transcript row composed and written, what the
		// history replay after navigation writes to the terminal.
		const paintStart = performance.now();
		const bytesBeforePaint = terminal.bytes();
		const writesBeforePaint = terminal.output.length;
		await painted;
		const paintMs = performance.now() - paintStart;
		const paintBytes = terminal.bytes() - bytesBeforePaint;
		const paintWrites = terminal.output.length - writesBeforePaint;

		const entries = sessionManager.getEntries();
		let messageCount = 0;
		for (const entry of entries) if (entry.type === "message") messageCount++;

		const repaints: { ms: number; bytes: number }[] = [];
		for (let i = 0; i < (args.repaint ?? 0); i++) {
			const start = performance.now();
			const before = terminal.bytes();
			const repainted = mode.shell.nextFrame();
			mode.shell.host?.replayHistory();
			await repainted;
			repaints.push({ ms: performance.now() - start, bytes: terminal.bytes() - before });
		}

		const lines = transcriptRows(mode, width);
		if (!args.quiet) {
			const text = args.plain ? lines.map(line => Bun.stripANSI(line)).join("\n") : lines.join("\n");
			process.stdout.write(text);
			process.stdout.write("\n");
		}

		if (args.timing || args.repaint) {
			const rows = lines.length;
			const report = [
				`session  ${sourcePath}`,
				`         ${formatBytes(sourceSize)}, ${entries.length} entries, ${messageCount} messages, ${rows} transcript rows @ ${width}x${height}`,
				`open     ${formatMs(openMs)}`,
				`replay   ${formatMs(replayMs)}  (transcript build + component construction)`,
				`paint    ${formatMs(paintMs)}  (full frame compose + emit: ${formatBytes(paintBytes)}, ${paintWrites} writes)`,
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
			await mode?.shell.stop();
			await session?.dispose();
		} catch (err) {
			logger.debug("omp render teardown failed", { error: String(err) });
		}
		// Removing the directory reclaims a file copy; a copy the storage holds
		// as a row is removed from the storage. Only the row: the copy carries the
		// original's session id, so `deleteSessionWithArtifacts` would purge the
		// original's history.db rows (prompts, recap, title) by that id. Its tool
		// artifacts are local files under `tempDir`, removed below.
		if (!(storage instanceof FileSessionStorage)) {
			try {
				await storage.unlink(workingCopy);
			} catch (err) {
				logger.debug("omp render working copy cleanup failed", { error: String(err) });
			}
		}
		tempDir.removeSync();
	}
}
