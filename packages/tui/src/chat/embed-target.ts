/**
 * What an embed's `src` names. Models write sources loosely — a path with no
 * `file://`, `example.com/docs` or `localhost:3000` with no scheme, a `file:`
 * URL with the wrong number of slashes, quotes left around the value — so
 * {@link resolveEmbedSource} reads them the way a person would rather than
 * the way a URL parser does.
 *
 * @example
 * resolveEmbedSource("localhost:3000/app", cwd);  // { kind: "url", url: "http://localhost:3000/app" }
 * resolveEmbedSource("out/report.html#top", cwd); // { kind: "file", path: "<cwd>/out/report.html", suffix: "#top" }
 * resolveEmbedSource("javascript:alert(1)", cwd); // undefined
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where an embed loads from. */
export type EmbedTarget =
	/** A web address, normalized to an absolute http(s) URL. */
	| { readonly kind: "url"; readonly url: string }
	/** A local file by absolute path; `suffix` is the `?query#fragment` written after it (a page's, ignored for a picture). */
	| { readonly kind: "file"; readonly path: string; readonly suffix: string }
	/** An inline `data:` URI, as written. */
	| { readonly kind: "data"; readonly uri: string };

/** `localhost`, an IPv4 or bracketed IPv6 address, or a dotted name ending in a letters-only label; with an optional port. */
const HOST =
	/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(:\d+)?$/i;
/** A path no host can be: rooted, dot-relative, home-relative, or on a Windows drive. */
const EXPLICIT_PATH = /^(?:[/\\~]|\.{1,2}(?:[/\\]|$)|[a-z]:[/\\])/i;
/** Last labels that read as a file's extension rather than a domain's, when nothing else decides. */
const FILE_EXTENSION = /^(?:css|gif|html?|jpe?g|js|json|md|pdf|png|py|rs|sh|svg|ts|txt|webp|xhtml|xml)$/i;

/**
 * Read `src` as a web address, a local file or a `data:` URI:
 * - wrapping whitespace, quotes, backticks and `<…>` are dropped;
 * - `http(s):` with missing slashes is repaired, `//host/…` is https;
 * - `file:` in any spelling (`file:///abs`, `file:/abs`, `file://rel/x`, `file:rel`) is that path;
 * - with no scheme: `localhost`, an IP or `host:port` is http; a rooted,
 *   dot- or home-relative path is a file; anything else is the file at that
 *   path relative to `cwd` when one exists, else https when it reads as a
 *   domain (`example.com/docs`, `www.…`), else a file.
 *
 * Undefined for an empty source, any other scheme (`javascript:`, `about:`,
 * `ftp:`) and an address no URL parser accepts.
 */
export function resolveEmbedSource(src: string, cwd: string): EmbedTarget | undefined {
	const text = src
		.trim()
		.replace(/^(["'`<])(.*)(["'`>])$/s, "$2")
		.trim();
	if (!text) return undefined;
	if (/^data:/i.test(text)) return { kind: "data", uri: text };
	const web = /^(https?):\/*(.*)$/is.exec(text);
	if (web) return webTarget(`${web[1]!.toLowerCase()}://${web[2]}`);
	if (text.startsWith("//")) return webTarget(`https:${text}`);
	const file = /^file:(.*)$/is.exec(text);
	if (file) return fileTarget(fileUrlPath(file[1]!), cwd);
	if (EXPLICIT_PATH.test(text)) return fileTarget(text, cwd);
	const head = /^[^/?#]*/.exec(text)![0];
	const host = HOST.exec(head);
	if (!host) {
		// `name:rest` that is no host with a port is a scheme this cannot show.
		return /^[a-z][a-z0-9+.-]*:/i.test(text) ? undefined : fileTarget(text, cwd);
	}
	const dotted = host[1]!.includes(".") && !/^[\d.]+$/.test(host[1]!);
	if (!dotted || host[2]) return webTarget(`http://${text}`);
	const local = fileTarget(text, cwd);
	if (fs.existsSync(local.path)) return local;
	const bare = head.length === text.length;
	const extension = host[1]!.slice(host[1]!.lastIndexOf(".") + 1);
	return bare && FILE_EXTENSION.test(extension) && !/^www\./i.test(text) ? local : webTarget(`https://${text}`);
}

/** The address a page target opens: its URL, or the `file:` URL of its path with the written query and fragment. */
export function embedTargetUrl(target: EmbedTarget): string | undefined {
	if (target.kind === "url") return target.url;
	return target.kind === "file" ? Bun.pathToFileURL(target.path).href + target.suffix : undefined;
}

function webTarget(address: string): EmbedTarget | undefined {
	const url = URL.parse(address);
	return url?.hostname ? { kind: "url", url: url.href } : undefined;
}

/** The path of a `file:` URL's remainder, however many slashes it was written with. */
function fileUrlPath(rest: string): string {
	// `file://localhost/abs` and `file:///abs` are rooted; `file://dir/x` (a "host" on a path) is read as `dir/x`.
	const pathname = rest
		.replace(/^\/\/localhost(?=\/)/i, "")
		.replace(/^\/{2,}(?=[^/])/, match => (match.length > 2 ? "/" : ""));
	// `/C:/dir` is a Windows drive path.
	return /^\/[a-z]:[/\\]/i.test(pathname) ? pathname.slice(1) : pathname;
}

/** `text` as a file under `cwd`: its `?query#fragment` split off unless the file's own name holds it, `~` expanded, `%20` read as written when that is the file that exists. */
function fileTarget(text: string, cwd: string): EmbedTarget & { kind: "file" } {
	const resolve = (value: string): string =>
		value === "~" || /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(1)) : path.resolve(cwd, value);
	const whole = resolve(text);
	const cut = text.search(/[?#]/);
	if (cut < 0 || fs.existsSync(whole)) return { kind: "file", path: decoded(whole), suffix: "" };
	return { kind: "file", path: decoded(resolve(text.slice(0, cut))), suffix: text.slice(cut) };
}

/** `file`, or its percent-decoded spelling when only that one exists (`my%20chart.png`). */
function decoded(file: string): string {
	if (!file.includes("%") || fs.existsSync(file)) return file;
	try {
		const plain = decodeURIComponent(file);
		return fs.existsSync(plain) ? plain : file;
	} catch {
		return file;
	}
}
