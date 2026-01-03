/**
 * Time Traveling Stream Rules (TTSR) Manager
 *
 * Manages rules that get injected mid-stream when their trigger pattern matches
 * the agent's output. When a match occurs, the stream is aborted, the rule is
 * injected as a system reminder, and the request is retried.
 */

import type { Rule } from "../capability/rule";
import { logger } from "./logger";
import type { TtsrSettings } from "./settings-manager";

interface TtsrEntry {
	rule: Rule;
	regex: RegExp;
}

/** Tracks when a rule was last injected (for repeat-after-gap mode) */
interface InjectionRecord {
	/** Message count when the rule was last injected */
	lastInjectedAt: number;
}

export interface TtsrManager {
	/** Add a TTSR rule to be monitored */
	addRule(rule: Rule): void;

	/** Check if any uninjected TTSR matches the stream buffer. Returns matching rules. */
	check(streamBuffer: string): Rule[];

	/** Mark rules as injected (won't trigger again until conditions allow) */
	markInjected(rules: Rule[]): void;

	/** Get names of all injected rules (for persistence) */
	getInjectedRuleNames(): string[];

	/** Restore injected state from a list of rule names */
	restoreInjected(ruleNames: string[]): void;

	/** Reset stream buffer (called on new turn) */
	resetBuffer(): void;

	/** Get current stream buffer */
	getBuffer(): string;

	/** Append to stream buffer */
	appendToBuffer(text: string): void;

	/** Check if any TTSRs are registered */
	hasRules(): boolean;

	/** Increment message counter (call after each turn) */
	incrementMessageCount(): void;

	/** Get current message count */
	getMessageCount(): number;

	/** Get settings */
	getSettings(): Required<TtsrSettings>;
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	contextMode: "discard",
	repeatMode: "once",
	repeatGap: 10,
};

export function createTtsrManager(settings?: TtsrSettings): TtsrManager {
	/** Resolved settings with defaults */
	const resolvedSettings: Required<TtsrSettings> = {
		...DEFAULT_SETTINGS,
		...settings,
	};

	/** Map of rule name -> { rule, compiled regex } */
	const rules = new Map<string, TtsrEntry>();

	/** Map of rule name -> injection record */
	const injectionRecords = new Map<string, InjectionRecord>();

	/** Current stream buffer for pattern matching */
	let buffer = "";

	/** Message counter for tracking gap between injections */
	let messageCount = 0;

	/** Check if a rule can be triggered based on repeat settings */
	function canTrigger(ruleName: string): boolean {
		const record = injectionRecords.get(ruleName);
		if (!record) {
			// Never injected, can trigger
			return true;
		}

		if (resolvedSettings.repeatMode === "once") {
			// Once mode: never trigger again after first injection
			return false;
		}

		// After-gap mode: check if enough messages have passed
		const gap = messageCount - record.lastInjectedAt;
		return gap >= resolvedSettings.repeatGap;
	}

	return {
		addRule(rule: Rule): void {
			// Only add rules that have a TTSR trigger pattern
			if (!rule.ttsrTrigger) {
				return;
			}

			// Skip if already registered
			if (rules.has(rule.name)) {
				return;
			}

			// Compile the regex pattern
			try {
				const regex = new RegExp(rule.ttsrTrigger);
				rules.set(rule.name, { rule, regex });
				logger.debug("TTSR rule registered", {
					ruleName: rule.name,
					pattern: rule.ttsrTrigger,
				});
			} catch (err) {
				logger.warn("TTSR rule has invalid regex pattern, skipping", {
					ruleName: rule.name,
					pattern: rule.ttsrTrigger,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		check(streamBuffer: string): Rule[] {
			const matches: Rule[] = [];

			for (const [name, entry] of rules) {
				// Skip rules that can't trigger yet
				if (!canTrigger(name)) {
					continue;
				}

				// Test the buffer against the rule's pattern
				if (entry.regex.test(streamBuffer)) {
					matches.push(entry.rule);
					logger.debug("TTSR pattern matched", {
						ruleName: name,
						pattern: entry.rule.ttsrTrigger,
					});
				}
			}

			return matches;
		},

		markInjected(rulesToMark: Rule[]): void {
			for (const rule of rulesToMark) {
				injectionRecords.set(rule.name, { lastInjectedAt: messageCount });
				logger.debug("TTSR rule marked as injected", {
					ruleName: rule.name,
					messageCount,
					repeatMode: resolvedSettings.repeatMode,
				});
			}
		},

		getInjectedRuleNames(): string[] {
			return Array.from(injectionRecords.keys());
		},

		restoreInjected(ruleNames: string[]): void {
			// When restoring, we don't know the original message count, so use 0
			// This means in "after-gap" mode, rules can trigger again after the gap
			for (const name of ruleNames) {
				injectionRecords.set(name, { lastInjectedAt: 0 });
			}
			if (ruleNames.length > 0) {
				logger.debug("TTSR injected state restored", { ruleNames });
			}
		},

		resetBuffer(): void {
			buffer = "";
		},

		getBuffer(): string {
			return buffer;
		},

		appendToBuffer(text: string): void {
			buffer += text;
		},

		hasRules(): boolean {
			return rules.size > 0;
		},

		incrementMessageCount(): void {
			messageCount++;
		},

		getMessageCount(): number {
			return messageCount;
		},

		getSettings(): Required<TtsrSettings> {
			return resolvedSettings;
		},
	};
}
