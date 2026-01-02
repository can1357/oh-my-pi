import { platform } from "os";

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

export async function copyToClipboard(text: string): Promise<void> {
	const p = platform();
	const timeout = 5000;

	try {
		if (p === "darwin") {
			await spawnWithTimeout(["pbcopy"], text, timeout);
		} else if (p === "win32") {
			await spawnWithTimeout(["clip"], text, timeout);
		} else {
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
			throw new Error(`Failed to copy to clipboard. Install xclip or xsel: ${msg}`);
		}
		throw new Error(`Failed to copy to clipboard: ${msg}`);
	}
}
