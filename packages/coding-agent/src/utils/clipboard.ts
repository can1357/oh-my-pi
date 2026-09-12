import {
	type ClipboardImage,
	copyToClipboard as nativeCopyToClipboard,
	readImageFromClipboard as nativeReadImageFromClipboard,
} from "@oh-my-pi/pi-natives/clipboard";
import { isWsl } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils/mime";
import MAC_FILE_URL_SCRIPT from "./mac-file-urls.applescript" with { type: "text" };

type SpawnCaptureOptions = { input?: string; timeoutMs?: number };

/**
 * Run a subprocess and capture its stdout without blocking the event loop.
 *
 * `readTextFromClipboard`, `readMacFileUrlsFromClipboard`, and the Termux copy
 * path all shell out to CLI clipboard tools. The synchronous `execSync` API
 * parks the render loop until the child exits or the timeout fires, so a hung
 * clipboard daemon freezes the TUI for the full 2000ms budget (#4235). This
 * helper mirrors the previous semantics — capture stdout, throw on non-zero
 * exit or timeout, forward optional stdin — but yields to the event loop while
 * the child runs.
 *
 * @throws Error when the child fails to spawn, is killed by the timeout, or
 *   exits with a non-zero status. Callers rely on this to use platform
 *   fallbacks or report an empty clipboard.
 */
async function spawnCapture(cmd: string[], options: SpawnCaptureOptions & { encoding: "bytes" }): Promise<Uint8Array>;
async function spawnCapture(cmd: string[], options?: SpawnCaptureOptions): Promise<string>;
async function spawnCapture(
	cmd: string[],
	options: SpawnCaptureOptions & { encoding?: "bytes" } = {},
): Promise<string | Uint8Array> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "ignore",
		stdin: options.input !== undefined ? Buffer.from(options.input) : "ignore",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const response = new Response(proc.stdout);
		const stdout =
			options.encoding === "bytes" ? new Uint8Array(await response.arrayBuffer()) : await response.text();
		await proc.exited;
		if (timedOut) {
			throw new Error(`${cmd[0]} timed out after ${timeoutMs}ms`);
		}
		if (proc.exitCode !== 0) {
			throw new Error(`${cmd[0]} exited with code ${proc.exitCode}`);
		}
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

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
		const stdout = await spawnCapture(["osascript", "-"], { input: MAC_FILE_URL_SCRIPT });
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
				await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}

		await nativeCopyToClipboard(text);
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

async function readTextFromX11Clipboard(): Promise<string> {
	try {
		return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
	} catch {
		return await spawnCapture(["xsel", "--clipboard", "--output"]);
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
 * @returns A supported image payload or null when no image is available.
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
			const image = await nativeReadImageFromClipboard();
			if (image) return image;
		} catch (err) {
			logger.warn("clipboard: native Windows image read failed", { error: String(err) });
		}
		return await readImageViaPowerShell();
	}

	if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
		try {
			const offeredMimeTypes = new Set((await spawnCapture(["wl-paste", "--list-types"])).split(/\r?\n/));
			for (const mimeType of SUPPORTED_IMAGE_MIME_TYPES) {
				if (!offeredMimeTypes.has(mimeType)) continue;
				const data = await spawnCapture(["wl-paste", "--type", mimeType], { encoding: "bytes" });
				if (data.byteLength > 0) return { data, mimeType };
			}
		} catch {
			// Fall through when wl-clipboard is absent or no advertised image payload can be read.
		}
	}

	if (!hasDisplay()) {
		return null;
	}

	try {
		return (await nativeReadImageFromClipboard()) ?? null;
	} catch (error) {
		// Some selection owners make the native image read throw instead of
		// reporting "no image" — e.g. an xclip-written text-only selection
		// (arboard: "Unknown error ... incorrect type received from clipboard").
		// Treat a failed image read as "no image" so the caller's smart-paste
		// text fallback still delivers the clipboard content.
		logger.warn("clipboard: failed to read clipboard image", { error: String(error) });
		return null;
	}
}

/**
 * Read plain text from the system clipboard.
 */
export async function readTextFromClipboard(): Promise<string> {
	try {
		const p = process.platform;
		if (p === "darwin") {
			return await spawnCapture(["pbpaste"]);
		}
		if (p === "win32") {
			return (await readTextViaPowerShell()) ?? "";
		}
		if (process.env.TERMUX_VERSION) {
			return await spawnCapture(["termux-clipboard-get"]);
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
				return await spawnCapture(["wl-paste", "--type", "text", "--no-newline"]);
			} catch {
				if (hasX11Display) {
					return await readTextFromX11Clipboard();
				}
			}
		} else if (hasX11Display) {
			return await readTextFromX11Clipboard();
		}
	} catch (error) {
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}
