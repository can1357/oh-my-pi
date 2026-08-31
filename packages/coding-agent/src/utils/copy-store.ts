/** Self-contained OSC 8 copy targets for fenced code blocks. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const COPY_URL_SCHEME = "omp-copy";

// Linux caps one argv entry near 128 KiB. Leave headroom for desktop-launcher
// bookkeeping rather than emitting an OSC action that can only fail with E2BIG.
const MAX_COPY_URL_BYTES = 120 * 1024;

/** Whether this process can install a client-local custom URL handler. */
export function supportsCopyUrlHandler(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	xdgMime: string | null = Bun.which("xdg-mime"),
): boolean {
	return (
		platform === "linux" &&
		Boolean(xdgMime) &&
		!env.SSH_CLIENT &&
		!env.SSH_CONNECTION &&
		!env.SSH_TTY &&
		!env.MOSH_IP &&
		!env.WSL_DISTRO_NAME &&
		!env.WSL_INTEROP
	);
}

export function registerCopyBlock(code: string): string {
	const bytes = Buffer.from(code, "utf8");
	return `${COPY_URL_SCHEME}:${bytes.length}.${bytes.toString("base64url")}`;
}

/** Create a self-contained OSC 8 target after handler validation and within Linux's argv limit. */
export function copyUrlTarget(code: string, handlerReady: boolean): string | undefined {
	if (!handlerReady) return undefined;
	const target = registerCopyBlock(code);
	return Buffer.byteLength(target) <= MAX_COPY_URL_BYTES ? target : undefined;
}

export function resolveCopyBlock(arg: string): string | undefined {
	const raw = arg.startsWith(`${COPY_URL_SCHEME}:`) ? arg.slice(COPY_URL_SCHEME.length + 1) : arg;
	const payload = raw.replace(/\/+$/, "");
	const dot = payload.indexOf(".");
	if (dot <= 0) return undefined;
	const declaredLength = Number(payload.slice(0, dot));
	if (!Number.isInteger(declaredLength) || declaredLength <= 0) return undefined;
	const bytes = Buffer.from(payload.slice(dot + 1), "base64url");
	if (bytes.length !== declaredLength) return undefined;
	const decoded = bytes.toString("utf8");
	if (!Buffer.from(decoded, "utf8").equals(bytes)) return undefined;
	return decoded;
}

const COPY_DESKTOP_ENTRY = `${COPY_URL_SCHEME}.desktop`;
const COPY_SCHEME_MIME = `x-scheme-handler/${COPY_URL_SCHEME}`;

export function copyDesktopPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
	const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
	return path.join(dataHome, "applications", COPY_DESKTOP_ENTRY);
}

export interface CopyHandlerResult {
	ok: boolean;
	desktopPath: string;
	error?: string;
}

function resolveOmpBinary(): string | undefined {
	if (process.env.PI_COMPILED === "true") return process.execPath;
	return Bun.which("omp") ?? undefined;
}

function quoteDesktopExecArgument(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("`", "\\`")
		.replaceAll("$", "\\$")
		.replaceAll("%", "%%");
	return `"${escaped}"`;
}

export function createCopyDesktopEntry(binary: string): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=OMP Copy",
		`Exec=${quoteDesktopExecArgument(binary)} copy %u`,
		"NoDisplay=true",
		"Terminal=false",
		`MimeType=${COPY_SCHEME_MIME};`,
		"",
	].join("\n");
}

export async function isCopyUrlHandlerRegistered(): Promise<boolean> {
	if (!supportsCopyUrlHandler()) return false;
	try {
		const proc = Bun.spawn(["xdg-mime", "query", "default", COPY_SCHEME_MIME], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = (await new Response(proc.stdout).text()).trim();
		if ((await proc.exited) !== 0 || out !== COPY_DESKTOP_ENTRY) return false;
		const binary = resolveOmpBinary();
		if (binary === undefined) return false;
		const expectedEntry = createCopyDesktopEntry(binary);
		return (await Bun.file(copyDesktopPath()).text()) === expectedEntry;
	} catch {
		return false;
	}
}

export async function registerCopyUrlHandler(): Promise<CopyHandlerResult> {
	const desktopPath = copyDesktopPath();
	const appsDir = path.dirname(desktopPath);
	if (!supportsCopyUrlHandler()) return { ok: false, desktopPath, error: "only supported on Linux (xdg)" };
	const binary = resolveOmpBinary();
	if (binary === undefined) return { ok: false, desktopPath, error: "omp executable not found" };
	await fs.mkdir(appsDir, { recursive: true });
	const entry = createCopyDesktopEntry(binary);
	await Bun.write(desktopPath, entry);
	const xdg = Bun.spawn(["xdg-mime", "default", COPY_DESKTOP_ENTRY, COPY_SCHEME_MIME], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const code = await xdg.exited;
	if (code !== 0) {
		const error = (await new Response(xdg.stderr).text()).trim();
		return {
			ok: false,
			desktopPath,
			error: error || `xdg-mime exited ${code}`,
		};
	}
	if (!(await isCopyUrlHandlerRegistered())) {
		return { ok: false, desktopPath, error: "xdg-mime did not activate the omp-copy handler" };
	}
	return { ok: true, desktopPath };
}

export async function ensureCopyUrlHandler(): Promise<boolean> {
	try {
		if (!supportsCopyUrlHandler()) return false;
		if (await isCopyUrlHandlerRegistered()) return true;
		const result = await registerCopyUrlHandler();
		return result.ok;
	} catch {
		// Best effort; `omp copy --install-handler` remains available.
		return false;
	}
}
