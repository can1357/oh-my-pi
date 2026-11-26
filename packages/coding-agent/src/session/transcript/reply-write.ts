import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../../internal-urls/router";
import { splitUrlScheme } from "../../internal-urls/url-scheme";

const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Whether a `toolName` call writes to a reply URL. `undefined` while streamed args cannot tell yet:
 * no path so far, or a path that could still grow into a reply URL (`ou`, `out:/`). Callers holding
 * final args treat `undefined` as `false`.
 */
export function isReplyWrite(toolName: string, args: unknown): boolean | undefined {
	if (toolName !== "write") return false;
	if (!isRecord(args)) return undefined;
	const target = typeof args.path === "string" ? args.path : args.file_path;
	if (typeof target !== "string") return undefined;
	const router = InternalUrlRouter.instance();
	const url = splitUrlScheme(target);
	if (url) return router.spec(url.scheme)?.write?.scope === "reply";
	const lower = target.toLowerCase();
	for (const [scheme, spec] of router.specs()) {
		if (spec.write?.scope === "reply" && `${scheme}://`.startsWith(lower)) return undefined;
	}
	return false;
}

/** Replies a tool result carries in `details.replies` (text its commands wrote to a reply URL), oldest first. */
export function toolResultReplies(details: unknown): readonly string[] {
	if (!isRecord(details) || !Array.isArray(details.replies)) return [];
	return details.replies.filter((reply): reply is string => typeof reply === "string");
}

/** Assistant message drawing reply text. No provider turn backs it, so its identity fields stay empty. */
export function replyDisplayMessage(text: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "",
		provider: "",
		model: "",
		usage: NO_USAGE,
		stopReason: errorMessage === undefined ? "stop" : "error",
		errorMessage,
		timestamp: 0,
	};
}
