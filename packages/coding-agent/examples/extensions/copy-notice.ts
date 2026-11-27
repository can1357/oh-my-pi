/**
 * Copy Notice - "copied N chars to clipboard" above the composer, like Claude Code
 *
 * The terminal does the copying (e.g. kitty's `copy_on_select`, Ctrl+Shift+C),
 * so omp never sees it. This watches the Wayland clipboard with
 * `wl-paste --watch` and shows the notice with `ctx.ui.setWidget()` only when
 * the focused Hyprland window is the terminal running this omp process, so
 * other omp instances stay quiet.
 *
 * Requires Wayland + Hyprland (`wl-paste`, `hyprctl`); elsewhere it does nothing.
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const WIDGET = "copy-notice";
const SHOW_MS = 2000;
/** wl-paste reports the current clipboard once at startup; that is not a copy. */
const STARTUP_GRACE_MS = 1000;

/** PIDs of this process and its ancestors (the terminal emulator is one of them). */
function ancestorPids(): Set<number> {
	const pids = new Set<number>();
	let pid = process.pid;
	while (pid > 1 && !pids.has(pid)) {
		pids.add(pid);
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			// Field 4 (ppid) follows the parenthesized command name, which may contain spaces.
			pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		} catch {
			break;
		}
	}
	return pids;
}

async function focusedWindowPid(): Promise<number | undefined> {
	try {
		const proc = Bun.spawn(["hyprctl", "activewindow", "-j"], { stdout: "pipe", stderr: "ignore" });
		const info = JSON.parse(await new Response(proc.stdout).text()) as { pid?: number };
		return info.pid;
	} catch {
		return undefined;
	}
}

/** One clipboard watcher per omp process. Subagent sessions run this factory again but share module state. */
let watcher: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
let hideTimer: Timer | undefined;

export default function copyNotice(pi: ExtensionAPI) {
	/** Whether this session started the watcher; only the owner stops it. */
	let owner = false;

	const stop = () => {
		if (!owner) return;
		owner = false;
		clearTimeout(hideTimer);
		watcher?.kill();
		watcher = undefined;
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Only the interactive main session has a composer; subagents and print mode skip.
		if (!ctx.ui.composer || watcher || !process.env.WAYLAND_DISPLAY) return;

		const ours = ancestorPids();
		const startedAt = Date.now();
		const proc = Bun.spawn(["wl-paste", "--type", "text", "--watch", "wc", "-m"], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, LC_ALL: "C.UTF-8" },
		});
		watcher = proc;
		owner = true;

		const show = (count: number) => {
			const text = `copied ${count} ${count === 1 ? "char" : "chars"} to clipboard`;
			ctx.ui.setWidget(
				WIDGET,
				(_ui: unknown, theme: { fg(token: string, text: string): string }) => ({
					render: (width: number) => [" ".repeat(Math.max(0, width - text.length - 1)) + theme.fg("accent", text)],
				}),
				{ placement: "aboveEditor" },
			);
			clearTimeout(hideTimer);
			hideTimer = setTimeout(() => ctx.ui.setWidget(WIDGET, undefined), SHOW_MS);
		};

		(async () => {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
				buffered += decoder.decode(chunk, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const count = Number(buffered.slice(0, newline).trim());
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
					if (!(count > 0) || Date.now() - startedAt < STARTUP_GRACE_MS) continue;
					const pid = await focusedWindowPid();
					if (pid !== undefined && ours.has(pid)) show(count);
				}
			}
		})().catch(() => {});
	});

	pi.on("session_shutdown", async () => stop());
}
