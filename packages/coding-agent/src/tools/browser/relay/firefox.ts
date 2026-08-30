import { ToolError } from "../../tool-errors";

export const DEFAULT_FIREFOX_BIDI_URL = "ws://127.0.0.1:9222/session";

export function validateFirefoxWebSocketUrl(rawUrl: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new ToolError(`Invalid Firefox WebDriver BiDi endpoint: ${rawUrl}`);
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new ToolError(`Firefox WebDriver BiDi endpoint must use ws:// or wss:// (got ${url.protocol})`);
	}
	if (
		url.hostname !== "127.0.0.1" &&
		url.hostname !== "localhost" &&
		url.hostname !== "[::1]" &&
		url.hostname !== "::1"
	) {
		throw new ToolError(`Refusing non-loopback Firefox WebDriver BiDi endpoint: ${url.hostname}`);
	}
	return url.href.replace(/\/$/, "");
}
