/**
 * The session the `composer/status-line` and `composer/surface` captures'
 * status line read (their `inputs.session`).
 */
import * as os from "node:os";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import type { StatusFacts } from "../../../src/ui/status/facts";

// The corpus was captured in UTC (the `time` segment).
process.env.TZ = "UTC";

/** The session the capture's status line read (`inputs.session`). */
export function corpusStatusFacts(): StatusFacts {
	return {
		model: { id: "claude-opus-4-5", name: "Claude Opus", thinking: true, contextWindow: 200000 },
		thinkingLevel: "high",
		sessionName: "Port the status line 日本語",
		sessionId: "sid",
		usage: { input: 1234, output: 567, cacheRead: 89000, cacheWrite: 10, premiumRequests: 0, cost: 0.42 },
		usingSubscription: false,
		context: { tokens: 50000, window: 200000, percent: 25 },
		autoCompact: true,
		// The capture ran in the checkout's `packages/tui`; its host was `studio`.
		cwd: "/work/.tree/agents/pi-ui/packages/tui",
		home: os.homedir(),
		hostname: "studio",
		now: CORPUS_NOW,
		subagents: 0,
		jobs: 0,
		activeMs: 0,
		hooks: [],
	};
}
