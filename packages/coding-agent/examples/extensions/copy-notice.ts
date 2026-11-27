/**
 * Copy Notice - "copied N chars to clipboard" above the composer, like Claude Code
 *
 * The terminal does the copying (e.g. kitty's `copy_on_select`, Ctrl+Shift+C),
 * so omp never sees it. This watches the Wayland clipboard with
 * `wl-paste --watch` and shows the notice with `ctx.ui.setWidget()` while the
 * focused Hyprland window belongs to the terminal running this omp process.
 *
 * Requires Hyprland with `wl-paste` (wl-clipboard) and `hyprctl` on PATH;
 * without them it does nothing.
 *
 * Limitations of the focus check (the focused window's PID must be an
 * ancestor of this process):
 * - every omp in the same terminal process (tabs/splits of one kitty, wezterm,
 *   foot server, ...) shows the notice, not only the visible one;
 * - under tmux/zellij/screen the chain ends at the multiplexer server, not
 *   the terminal, so the notice never shows.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readLines } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const WIDGET = "copy-notice";
const SHOW_MS = 2000;

/** One clipboard watcher per omp process. Subagent sessions run this factory again but share module state. */
let watcher: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
let hideTimer: Timer | undefined;

/** PIDs of this process and its ancestors (the terminal emulator is one of them). */
async function ancestorPids(): Promise<Set<number>> {
	const pids = new Set<number>();
	let pid = process.pid;
	while (pid > 1 && !pids.has(pid)) {
		pids.add(pid);
		try {
			const stat = await Bun.file(`/proc/${pid}/stat`).text();
			// Field 4 (ppid) follows the parenthesized command name, which may contain spaces.
			pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		} catch {
			break;
		}
	}
	return pids;
}

async function focusedWindowPid(): Promise<number | undefined> {
	const result = await $`hyprctl activewindow -j`.quiet().nothrow();
	if (result.exitCode !== 0) return undefined;
	let info: unknown;
	try {
		info = result.json();
	} catch {
		return undefined;
	}
	return info && typeof info === "object" && "pid" in info && typeof info.pid === "number" ? info.pid : undefined;
}

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
		if (!ctx.ui.composer || watcher) return;
		if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || !Bun.which("wl-paste") || !Bun.which("hyprctl")) return;

		const ours = await ancestorPids();
		if (watcher) return; // another session started one while we walked the process tree
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
				(_ui, theme) => ({
					render: width => [" ".repeat(Math.max(0, width - text.length - 1)) + theme.fg("accent", text)],
				}),
				{ placement: "aboveEditor" },
			);
			clearTimeout(hideTimer);
			hideTimer = setTimeout(() => ctx.ui.setWidget(WIDGET, undefined), SHOW_MS);
		};

		(async () => {
			const decoder = new TextDecoder();
			// wl-paste reports the clipboard once at startup (even when empty); that record is not a copy.
			let initial = true;
			for await (const line of readLines(proc.stdout)) {
				if (initial) {
					initial = false;
					continue;
				}
				const count = Number(decoder.decode(line).trim());
				if (!(count > 0)) continue;
				const pid = await focusedWindowPid();
				if (pid !== undefined && ours.has(pid)) show(count);
			}
		})().catch(() => {});
	});

	pi.on("session_shutdown", async () => stop());
}
