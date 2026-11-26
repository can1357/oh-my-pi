/**
 * Hyperlink targets for local files: a plain `file:` URI, VS Code's
 * `vscode://file/<path>:<line>:<col>` form, or a remote handler configured with
 * `PI_LINK_SCHEME`/`PI_LINK_HOST` (a desktop app opening files on this host).
 */
import * as os from "node:os";
import * as url from "node:url";
import type { TerminalId } from "@oh-my-pi/pi-tui/driver/caps/identity";
import { logger } from "@oh-my-pi/pi-utils";

/** A remote file-link handler: links become `<scheme>://<host><path>?line=&col=`. */
export interface FileLinkConfig {
	scheme?: string;
	host?: string;
}

/** Position and purpose of a file link. */
export interface FileUriOptions {
	line?: number;
	col?: number;
	/** Native image open actions need a local file URL rather than a desktop handler. */
	local?: boolean;
}

/** URI scheme syntax (RFC 3986 §3.1), matched after lowercasing. */
const FILE_LINK_SCHEME = /^[a-z][a-z0-9+.-]*$/;
/** A bare host name with an optional port: no userinfo, path, query, or whitespace that would reshape the URI. */
const FILE_LINK_HOST = /^[A-Za-z0-9._-]+(?::\d{1,5})?$/;

let fileLinkTarget: { scheme: string; host: string } | undefined | null = null;

/**
 * Configure the remote file-link handler. Passing an explicit object lets SDK
 * hosts and tests configure links without changing the process environment;
 * an empty object restores ordinary file links. An invalid scheme or host logs
 * a warning and keeps ordinary links. Until called, the environment configures it.
 */
export function applyFileLinkSetting(
	config: FileLinkConfig = {
		scheme: Bun.env.PI_LINK_SCHEME,
		host: Bun.env.PI_LINK_HOST,
	},
): void {
	fileLinkTarget = undefined;
	if (!config.scheme) return;
	const scheme = config.scheme.toLowerCase();
	if (!FILE_LINK_SCHEME.test(scheme)) {
		logger.warn("Invalid PI_LINK_SCHEME; using ordinary file links", {
			scheme: config.scheme,
		});
		return;
	}
	const host = config.host || os.hostname();
	if (!FILE_LINK_HOST.test(host)) {
		logger.warn("Invalid PI_LINK_HOST; using ordinary file links", { host });
		return;
	}
	fileLinkTarget = { scheme, host };
}

function linkTarget(): { scheme: string; host: string } | undefined {
	if (fileLinkTarget === null) applyFileLinkSetting();
	return fileLinkTarget ?? undefined;
}

/**
 * A file-link target for `filePath`, or `undefined` when Node cannot encode it.
 *
 * Node rejects a malformed UNC target (a UNC path escaped twice by its author,
 * e.g. `\\\wsl.localhost\…`) with `ERR_INVALID_ARG_VALUE: Empty UNC servername`.
 * A stored session keeps whatever a tool call recorded, so a transcript must
 * render such a path without a link rather than throw while it rebuilds.
 */
export function tryFileUri(filePath: string, opts?: FileUriOptions): string | undefined {
	try {
		const fileUrl = url.pathToFileURL(filePath);
		const target = linkTarget();
		if (!target || opts?.local) return fileUrl.href;
		// Preserve UNC servers so the handler can reconstruct the network path.
		const targetPath = fileUrl.host ? `//${fileUrl.host}${fileUrl.pathname}` : fileUrl.pathname;
		const position = new URLSearchParams();
		if (opts?.line !== undefined) position.set("line", String(opts.line));
		if (opts?.col !== undefined) position.set("col", String(opts.col));
		const query = position.size ? `?${position}` : "";
		return `${target.scheme}://${target.host}${targetPath}${query}`;
	} catch {
		return undefined;
	}
}

/**
 * The OSC 8 target for a file path on `terminalId`.
 *
 * A `file:` URI handed to an editor has to be a plain path: JVM language
 * servers reject a query or fragment outright, and VS Code reads the query as
 * part of the resource identity (#12109). The VS Code family instead navigates
 * the documented `vscode://file/<path>:<line>:<col>` form; everywhere else the
 * plain `file:` URI is right, with the location left in the visible text. A
 * configured remote handler takes precedence and receives optional `line`/`col`
 * query parameters.
 *
 * Returns `undefined` when `filePath` cannot be encoded — a malformed UNC
 * target on the `file:` branch, or a lone surrogate on the `vscode://` branch.
 */
export function fileUriForTerminal(
	filePath: string,
	opts: { line?: number; col?: number } | undefined,
	terminalId: TerminalId,
): string | undefined {
	if (linkTarget() || terminalId !== "vscode") return tryFileUri(filePath, opts);
	// vscode:// takes a filesystem path with forward slashes. Encode each
	// segment independently so separators and a Windows drive colon stay
	// structural while reserved bytes in file names cannot become URI syntax.
	try {
		const asPath = filePath.replace(/\\/gu, "/");
		const encodedPath = asPath
			.split("/")
			.map((segment, index) => (index === 0 && /^[a-z]:$/iu.test(segment) ? segment : encodeURIComponent(segment)))
			.join("/");
		const position =
			opts?.line === undefined ? "" : opts.col === undefined ? `:${opts.line}` : `:${opts.line}:${opts.col}`;
		return `vscode://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}${position}`;
	} catch {
		// `encodeURIComponent` throws URIError on a lone surrogate, which a
		// model-authored path can carry; the row keeps its text and loses the link.
		return undefined;
	}
}
