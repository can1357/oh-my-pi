import { unlink } from "node:fs/promises";
import { platform } from "node:os";
import { nanoid } from "nanoid";

const PREFERRED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
	return base === "image/jpg" ? "image/jpeg" : base;
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of PREFERRED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

async function spawnWithTimeout(cmd: string[], input: string, timeoutMs: number): Promise<void> {
	const proc = Bun.spawn(cmd, { stdin: "pipe" });

	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("Clipboard operation timed out")), timeoutMs);
	});

	try {
		proc.stdin.write(input);
		proc.stdin.end();
		await Promise.race([proc.exited, timeoutPromise]);

		if (proc.exitCode !== 0) {
			throw new Error(`Command failed with exit code ${proc.exitCode}`);
		}
	} finally {
		proc.kill();
	}
}

async function spawnAndRead(cmd: string[], timeoutMs: number): Promise<Buffer | null> {
	let proc: ReturnType<typeof Bun.spawn> | null = null;

	try {
		proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Clipboard operation timed out")), timeoutMs);
		});

		const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
		const [exitCode, stdout] = await Promise.race([
			Promise.all([proc.exited, new Response(stdoutStream).arrayBuffer()]),
			timeoutPromise,
		]);

		if (exitCode !== 0) {
			return null;
		}

		return Buffer.from(stdout);
	} catch {
		return null;
	} finally {
		proc?.kill();
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	const p = platform();
	const timeout = 5000;

	try {
		if (p === "darwin") {
			await spawnWithTimeout(["pbcopy"], text, timeout);
		} else if (p === "win32") {
			await spawnWithTimeout(["clip"], text, timeout);
		} else {
			const wayland = isWaylandSession();
			if (wayland) {
				const wlCopyPath = Bun.which("wl-copy");
				if (wlCopyPath) {
					// Fire-and-forget: wl-copy may not exit promptly, so we unref to avoid blocking
					const proc = Bun.spawn([wlCopyPath], { stdin: "pipe" });
					proc.stdin.write(text);
					proc.stdin.end();
					proc.unref();
					return;
				}
			}

			// Linux - try xclip first, fall back to xsel
			try {
				await spawnWithTimeout(["xclip", "-selection", "clipboard"], text, timeout);
			} catch {
				await spawnWithTimeout(["xsel", "--clipboard", "--input"], text, timeout);
			}
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (p === "linux") {
			const tools = isWaylandSession() ? "wl-copy, xclip, or xsel" : "xclip or xsel";
			throw new Error(`Failed to copy to clipboard. Install ${tools}: ${msg}`);
		}
		throw new Error(`Failed to copy to clipboard: ${msg}`);
	}
}

export interface ClipboardImage {
	data: string; // base64 encoded
	mimeType: string;
}

/**
 * Read image from system clipboard if available.
 * Returns null if no image is in clipboard or clipboard access fails.
 *
 * Supported platforms:
 * - Linux: requires wl-paste (Wayland) or xclip (X11)
 * - macOS: uses osascript + pbpaste
 * - Windows: uses PowerShell
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	const p = platform();
	const timeout = 3000;

	try {
		if (p === "linux") {
			return await readImageLinux(timeout);
		} else if (p === "darwin") {
			return await readImageMacOS(timeout);
		} else if (p === "win32") {
			return await readImageWindows(timeout);
		}
	} catch {
		// Clipboard access failed silently
	}

	return null;
}

async function readImageLinux(timeout: number): Promise<ClipboardImage | null> {
	const wayland = isWaylandSession();
	if (wayland) {
		const image = await readImageWayland(timeout);
		if (image) return image;
	}

	return await readImageX11(timeout);
}

async function readImageWayland(timeout: number): Promise<ClipboardImage | null> {
	const types = await spawnAndRead(["wl-paste", "--list-types"], timeout);
	if (!types) return null;

	const typeList = types
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(typeList);
	if (!selectedType) return null;

	const imageData = await spawnAndRead(["wl-paste", "--type", selectedType, "--no-newline"], timeout);
	if (!imageData || imageData.length === 0) return null;

	return {
		data: imageData.toString("base64"),
		mimeType: baseMimeType(selectedType),
	};
}

async function readImageX11(timeout: number): Promise<ClipboardImage | null> {
	const targets = await spawnAndRead(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"], timeout);

	let candidateTypes: string[] = [];
	if (targets) {
		candidateTypes = targets
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...PREFERRED_IMAGE_MIME_TYPES] : [...PREFERRED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const imageData = await spawnAndRead(["xclip", "-selection", "clipboard", "-t", mimeType, "-o"], timeout);
		if (imageData && imageData.length > 0) {
			return {
				data: imageData.toString("base64"),
				mimeType: baseMimeType(mimeType),
			};
		}
	}

	return null;
}

async function readImageMacOS(timeout: number): Promise<ClipboardImage | null> {
	// Use osascript to check clipboard class and read PNG data
	// First check if clipboard has image data
	const checkScript = `
		try
			clipboard info for «class PNGf»
			return "png"
		on error
			try
				clipboard info for «class JPEG»
				return "jpeg"
			on error
				return "none"
			end try
		end try
	`;

	const checkProc = Bun.spawn(["osascript", "-e", checkScript], { stdout: "pipe", stderr: "pipe" });
	const checkResult = await Promise.race([
		new Response(checkProc.stdout).text(),
		new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
	]).catch(() => "none");

	await checkProc.exited;
	const imageType = checkResult.trim();

	if (imageType === "none") return null;

	// Read the actual image data using a temp file approach
	// osascript can't output binary directly, so we write to a temp file
	const tempFile = `/tmp/omp-clipboard-${nanoid()}.${imageType === "png" ? "png" : "jpg"}`;
	const clipboardClass = imageType === "png" ? "«class PNGf»" : "«class JPEG»";

	const readScript = `
		set imageData to the clipboard as ${clipboardClass}
		set filePath to POSIX file "${tempFile}"
		set fileRef to open for access filePath with write permission
		write imageData to fileRef
		close access fileRef
	`;

	const writeProc = Bun.spawn(["osascript", "-e", readScript], { stdout: "pipe", stderr: "pipe" });
	await Promise.race([
		writeProc.exited,
		new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
	]).catch(() => null);

	try {
		const file = Bun.file(tempFile);
		if (await file.exists()) {
			const buffer = await file.arrayBuffer();
			await Bun.write(tempFile, ""); // Clear file
			await unlink(tempFile).catch(() => {});

			if (buffer.byteLength > 0) {
				return {
					data: Buffer.from(buffer).toString("base64"),
					mimeType: imageType === "png" ? "image/png" : "image/jpeg",
				};
			}
		}
	} catch {
		// File read failed
	}

	return null;
}

async function readImageWindows(timeout: number): Promise<ClipboardImage | null> {
	// PowerShell script to read image from clipboard as base64
	const script = `
		Add-Type -AssemblyName System.Windows.Forms
		$clipboard = [System.Windows.Forms.Clipboard]::GetImage()
		if ($clipboard -ne $null) {
			$ms = New-Object System.IO.MemoryStream
			$clipboard.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
			[Convert]::ToBase64String($ms.ToArray())
		}
	`;

	const result = await spawnAndRead(["powershell", "-NoProfile", "-Command", script], timeout);
	if (result && result.length > 0) {
		const base64 = result.toString("utf-8").trim();
		if (base64.length > 0) {
			return {
				data: base64,
				mimeType: "image/png",
			};
		}
	}

	return null;
}
