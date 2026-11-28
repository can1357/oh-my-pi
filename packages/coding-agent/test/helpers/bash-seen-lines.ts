import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Forty lines `line N: value_N`, so every row's content names its own number.
export const SOURCE = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}: value_${i + 1}`).join("\n")}\n`;

// A bash footer line: `[path#TAG] line(s) <ranges>`.
export const FOOTER = /^\[([^\]#]+)#([0-9A-F]{4})\] lines? (.+)$/gm;

export function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

export function footers(text: string): { path: string; header: string; lines: string }[] {
	return [...text.matchAll(FOOTER)].map(match => ({
		path: match[1],
		header: `[${match[1]}#${match[2]}]`,
		lines: match[3],
	}));
}

export interface BashSeenLinesSessionOptions {
	/** Settings layered over the defaults: hashline edits, no async jobs, no auto-background, no interceptor. */
	settings?: Record<string, unknown>;
	asyncJobManager?: AsyncJobManager;
	clientBridge?: ClientBridge;
}

export function createSession(cwd: string, options: BashSeenLinesSessionOptions = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getClientBridge: () => options.clientBridge,
		asyncJobManager: options.asyncJobManager,
		settings: Settings.isolated({
			"edit.mode": "hashline",
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			...options.settings,
		}),
	} as unknown as ToolSession;
}
