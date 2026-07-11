import { execSync } from "node:child_process";
import type { ClipboardImage } from "@pk-nerdsaver-ai/pi-natives";
import * as native from "@pk-nerdsaver-ai/pi-natives";
import { logger } from "@pk-nerdsaver-ai/pi-utils";

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function isWsl(): boolean {
	return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// AppleScript that returns the POSIX paths of every file URL currently on the
// macOS pasteboard, one path per line. `pbpaste(1)` only surfaces plain text,
// EPS, or RTF, so a Finder `Cmd+C` (which puts only a `public.file-url`
// representation on the pasteboard) makes `pbpaste` empty. AppleScript's
// `«class furl»` coercion reaches the file-URL representation directly and
// works for both single-file and multi-file selections. The `try` blocks
// suppress the `-1700` "can't make … into type" error AppleScript raises when
// the clipboard holds no file URLs, so the script's exit status only reflects
// `osascript` itself.
const MAC_FILE_URL_SCRIPT = [
	"on run",
	'\tset output to ""',
	"\ttry",
	"\t\tset theClip to the clipboard as «class furl»",
	"\t\tif class of theClip is list then",
	"\t\t\trepeat with anItem in theClip",
	"\t\t\t\ttry",
	"\t\t\t\t\tset output to output & POSIX path of anItem & linefeed",
	"\t\t\t\tend try",
	"\t\t\tend repeat",
	"\t\telse",
	"\t\t\ttry",
	"\t\t\t\tset output to POSIX path of theClip & linefeed",
	"\t\t\tend try",
	"\t\tend if",
	"\tend try",
	"\treturn output",
	"end run",
].join("\n");

/**
 * Read file paths from the macOS pasteboard's `public.file-url` representation.
 *
 * Used to reach the Finder `Cmd+C` pasteboard (which exposes only file URLs,
 * no plain text or raw image bytes) so an image-file clipboard can be attached
 * via {@link handleImagePathPaste} instead of falling through to "Clipboard is
 * empty". Returns an empty array on non-darwin platforms, when AppleScript is
 * unavailable, or when the pasteboard holds no file URLs.
 */
export async function readMacFileUrlsFromClipboard(): Promise<string[]> {
	if (process.platform !== "darwin") return [];
	try {
		const stdout = execSync("osascript -", {
			input: MAC_FILE_URL_SCRIPT,
			encoding: "utf8",
			timeout: 2000,
		}).toString();
		return stdout
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch (error) {
		logger.warn("clipboard: failed to read macOS file URLs", { error: String(error) });
		return [];
	}
}

/**
 * Copy text to the system clipboard.
 *
 * Emits OSC 52 first when running in a real terminal (works over SSH/mosh),
 * then attempts native clipboard copy as best-effort for local sessions.
 * On Termux, tries `termux-clipboard-set` before native.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
		const onError = (err: unknown) => {
			process.stdout.off("error", onError);
			// Prevent unhandled 'error' from crashing the process when stdout is a closed pipe.
			if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
				return;
			}
		};
		try {
			const encoded = Buffer.from(text).toString("base64");
			const osc52 = `\x1b]52;c;${encoded}\x07`;
			process.stdout.on("error", onError);
			process.stdout.write(osc52, err => {
				process.stdout.off("error", onError);
				// If stdout is closed (e.g. piped to a process that exits early),
				// ignore EPIPE and proceed with native clipboard best-effort.
				if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
					return;
				}
			});
		} catch (err) {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
				// Ignore all write failures (OSC 52 is best-effort).
			}
		}
	}

	// Also try native tools (best effort for local sessions)
	try {
		if (process.env.TERMUX_VERSION) {
			try {
				execSync("termux-clipboard-set", { input: text, timeout: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}

		await native.copyToClipboard(text);
	} catch {
		// Ignore — clipboard copy is best-effort
	}
}

// PowerShell one-liner that emits the Windows clipboard image as base64-encoded
// PNG on stdout, or nothing when the clipboard does not hold image data. Used
// for native Windows fallback and WSL interop because arboard can miss host
// clipboard image payloads in those terminal paths.
const POWERSHELL_IMAGE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
	$ms = New-Object System.IO.MemoryStream
	$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
	[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
}
`;

const POWERSHELL_TIMEOUT_MS = 8000;

/**
 * Read an image through the Windows host's PowerShell.
 *
 * Native Windows uses this as a fallback when arboard reports no image or
 * cannot access the clipboard. WSLg exposes a Wayland socket but no native
 * clipboard image transport, so arboard returns `ContentNotAvailable` there;
 * PowerShell, reached via WSL interop, can read the Windows clipboard directly
 * and round-trip the bitmap as PNG.
 *
 * Returns null when no image is on the clipboard, the host PowerShell is
 * missing, or the bridge times out.
 */
async function readImageViaPowerShell(): Promise<ClipboardImage | null> {
	try {
		const proc = Bun.spawn(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", POWERSHELL_IMAGE_SCRIPT],
			{
				stdout: "pipe",
				stderr: "ignore",
				stdin: "ignore",
			},
		);
		const timer = setTimeout(() => proc.kill(), POWERSHELL_TIMEOUT_MS);
		let stdout = "";
		try {
			stdout = await new Response(proc.stdout).text();
			await proc.exited;
		} catch (err) {
			// powershell.exe can be a Windows process reached either natively or
			// over WSL interop; if it doesn't reap cleanly, report no image instead
			// of surfacing an opaque bridge failure to the prompt.
			logger.warn("clipboard: powershell read failed", { error: String(err) });
			return null;
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode !== 0) return null;
		const b64 = stdout.trim();
		if (!b64) return null;
		const bytes = Buffer.from(b64, "base64");
		if (bytes.byteLength === 0) return null;
		return { data: bytes, mimeType: "image/png" };
	} catch {
		return null;
	}
}

// PowerShell one-liner that emits the clipboard text verbatim on stdout, or
// nothing when the clipboard holds no text. `[Console]::Out.Write` avoids the
// trailing newline Write-Output would add; output encoding is forced to UTF-8
// so non-ASCII text survives the interop boundary regardless of console
// codepage.
const POWERSHELL_TEXT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write([string](Get-Clipboard -Raw))
`;

/**
 * Read clipboard text through Windows PowerShell — native win32 or the WSL
 * host over interop.
 *
 * Same rationale as `readImageViaPowerShell`: under WSL, the WSLg Wayland
 * clipboard only works when `wl-clipboard` happens to be installed in the
 * distro, while `powershell.exe` is always reachable. Forcing UTF-8 output
 * encoding keeps non-ASCII text intact regardless of the console codepage
 * (the legacy win32 `Get-Clipboard` shell-out mangled it), and `Bun.spawn`
 * keeps a cold PowerShell start off the TUI event loop.
 *
 * Returns null when the bridge fails (WSL callers fall through to
 * wl-paste/xclip); an empty string is a successful "no text" read.
 */
async function readTextViaPowerShell(): Promise<string | null> {
	try {
		const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_TEXT_SCRIPT], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), POWERSHELL_TIMEOUT_MS);
		let stdout = "";
		try {
			stdout = await new Response(proc.stdout).text();
			await proc.exited;
		} catch (err) {
			logger.warn("clipboard: powershell text read failed", { error: String(err) });
			return null;
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode !== 0) return null;
		return stdout.replaceAll("\r\n", "\n");
	} catch {
		return null;
	}
}

/**
 * Read an image from the system clipboard.
 *
 * Returns null on Termux (no image clipboard support) or when no display
 * server is available (headless/SSH without forwarding). Under native Windows
 * and WSL, the Windows clipboard is also reached through `powershell.exe`
 * because terminal clipboard paths can leave image payloads invisible to the
 * native bridge.
 *
 * @returns PNG payload or null when no image is available.
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (isWsl()) {
		const image = await readImageViaPowerShell();
		if (image) return image;
		// Fall through: arboard may still succeed on a future WSLg release —
		// but only when we actually have a display server. Headless WSL has
		// no display, so arboard would reject anyway.
	}

	if (process.platform === "win32") {
		try {
			const image = await native.readImageFromClipboard();
			if (image) return image;
		} catch (err) {
			logger.warn("clipboard: native Windows image read failed", { error: String(err) });
		}
		return await readImageViaPowerShell();
	}

	if (!hasDisplay()) {
		return null;
	}

	return (await native.readImageFromClipboard()) ?? null;
}

/**
 * Read plain text from the system clipboard.
 */
export async function readTextFromClipboard(): Promise<string> {
	try {
		const p = process.platform;
		if (p === "darwin") {
			return execSync("pbpaste", { encoding: "utf8", timeout: 2000 }).toString();
		}
		if (p === "win32") {
			return (await readTextViaPowerShell()) ?? "";
		}
		if (process.env.TERMUX_VERSION) {
			return execSync("termux-clipboard-get", { encoding: "utf8", timeout: 2000 }).toString();
		}
		if (isWsl()) {
			const text = await readTextViaPowerShell();
			if (text !== null) return text;
			// Bridge failed — fall through to the wl-paste/xclip paths below.
		}
		const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
		const hasX11Display = Boolean(process.env.DISPLAY);
		if (hasWaylandDisplay) {
			try {
				return execSync("wl-paste --type text/plain --no-newline", { encoding: "utf8", timeout: 2000 }).toString();
			} catch {
				if (hasX11Display) {
					return execSync("xclip -selection clipboard -o", { encoding: "utf8", timeout: 2000 }).toString();
				}
			}
		} else if (hasX11Display) {
			return execSync("xclip -selection clipboard -o", { encoding: "utf8", timeout: 2000 }).toString();
		}
	} catch (error) {
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}
