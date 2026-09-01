import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { $which, logger } from "@oh-my-pi/pi-utils";

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function getExistingWslLocalPath(urlOrPath: string): string | undefined {
	if (
		process.platform !== "linux" ||
		!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ||
		!$which("wslview")
	) {
		return undefined;
	}

	try {
		const localPath = urlOrPath.startsWith("file://")
			? url.fileURLToPath(urlOrPath)
			: URL_SCHEME_PATTERN.test(urlOrPath)
				? undefined
				: path.resolve(urlOrPath);
		if (!localPath || !fs.existsSync(localPath)) return undefined;

		const result = Bun.spawnSync(["wslpath", "-w", localPath], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return undefined;

		return result.stdout.toString().trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the Windows opener used to hand a URL/path to the user's registered
 * protocol handler. PowerShell's `Start-Process` goes through ShellExecute
 * like the previous `rundll32 url.dll,FileProtocolHandler`, with two
 * advantages that make the delayed-failure telemetry in {@link openPath}
 * actually observable on Windows:
 *
 * - `rundll32` exits 0 unconditionally, so no launch failure ever reaches the
 *   non-zero-exit logging below. `Start-Process` surfaces the failures
 *   ShellExecute itself reports — missing target file, no handler executable,
 *   access denied — as exit code 1 (verified live: a nonexistent file path
 *   exits 1; `$ErrorActionPreference='Stop'` additionally promotes any
 *   non-terminating error classes). Known limitation shared by every opener:
 *   an unregistered URL scheme exits 0 because Windows "handles" it by
 *   offering the app-picker.
 * - `-EncodedCommand` carries the target as a UTF-16LE/base64 payload, so no
 *   cmd/PowerShell metacharacter parsing ever sees it (OAuth authorize URLs
 *   carry `&`); inside the decoded script the target is a single-quoted
 *   literal (no `$` expansion) with embedded quotes doubled.
 *
 * PowerShell is anchored to `%SystemRoot%\System32` for the same reason the
 * previous revision anchored `rundll32`: machine PATHs that dropped
 * `System32` are a real-world occurrence, and bare names throw
 * `Executable not found in $PATH` from `Bun.spawn`. A bare-name fallback
 * remains for exotic SystemRoot layouts.
 */
function windowsOpenerCommand(target: string): string[] {
	const systemRoot = process.env.SystemRoot?.trim() || process.env.SYSTEMROOT?.trim() || "C:\\Windows";
	// `path.win32` (not the platform-adaptive `path.join`) keeps Windows path
	// separators when tests run under a POSIX host and matches Windows call
	// conventions on the real target.
	const absolute = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const powershell = fs.existsSync(absolute) ? absolute : "powershell.exe";
	const script = `$ErrorActionPreference='Stop';Start-Process '${target.replaceAll("'", "''")}'`;
	return [
		powershell,
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64"),
	];
}
/** Open a URL or file path in the default browser/application. Best-effort, never throws. */
export function openPath(urlOrPath: string): void {
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = ["open", urlOrPath];
			break;
		case "win32":
			cmd = windowsOpenerCommand(urlOrPath);
			break;
		default: {
			const wslPath = getExistingWslLocalPath(urlOrPath);
			cmd = wslPath ? ["wslview", wslPath] : ["xdg-open", urlOrPath];
			break;
		}
	}
	let child: Bun.Subprocess | undefined;
	try {
		child = Bun.spawn(cmd, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: process.platform === "win32",
		});
	} catch (error) {
		// Spawn threw synchronously (missing binary, denied exec, sandbox
		// restriction, …). Best-effort: log so the failure isn't invisible while
		// still letting the caller advertise a copy-URL fallback.
		logger.warn("Failed to open external URL/path", {
			command: cmd[0],
			target: urlOrPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	// Detect delayed failures (exec succeeded but the opener exited non-zero)
	// without blocking the caller. Recording them makes silent misconfigurations
	// (e.g. `xdg-open` present but no MIME handler for `https`) diagnosable from
	// `~/.omp/logs/omp.*.log`.
	child.exited.then(
		exitCode => {
			if (typeof exitCode === "number" && exitCode !== 0) {
				logger.warn("External opener exited with non-zero status", {
					command: cmd[0],
					target: urlOrPath,
					exitCode,
				});
			}
		},
		() => {
			// Ignore — awaiting the subprocess is best-effort telemetry.
		},
	);
}
