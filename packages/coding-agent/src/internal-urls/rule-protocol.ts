/**
 * Protocol handler for rule:// URLs.
 *
 * URL forms:
 * - rule://<name> - Reads rule content
 */
import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getActiveRules, type Rule } from "../capability/rule";
import ruleDoc from "../prompts/internal-urls/rule.md" with { type: "text" };
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
} from "./types";

function findRule(url: InternalUrl, context?: ResolveContext): Rule {
	const rules = context?.rules ?? getActiveRules();

	const ruleName = url.rawHost || url.hostname;
	if (!ruleName) {
		throw new Error("rule:// URL requires a rule name: rule://<name>");
	}

	const rule = rules.find(r => r.name === ruleName);
	if (!rule) {
		const available = rules.map(r => r.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new Error(`Unknown rule: ${ruleName}\nAvailable: ${availableStr}`);
	}
	return rule;
}

export class RuleProtocolHandler implements ProtocolHandler {
	readonly scheme = "rule";
	/** Virtual: resolved content is the rule body with frontmatter stripped, not the rule file's bytes. */
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true, linkable: true };

	/** Advertised only when the rulebook has addressable rules. */
	promptDoc(host: SchemeHost): string | undefined {
		return host.ruleCount > 0 ? ruleDoc.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const rule = findRule(url, context);
		return {
			url: url.href,
			content: rule.content,
			contentType: "text/markdown",
			size: Buffer.byteLength(rule.content, "utf-8"),
			sourcePath: rule.path,
			notes: [],
		};
	}

	/** Rule source file (with frontmatter); null when the rule has no file on disk. */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		const rule = findRule(url, context);
		if (!rule.path) return null;
		try {
			await fs.stat(rule.path);
			return rule.path;
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		return (context?.rules ?? getActiveRules()).map(rule => ({
			value: rule.name,
			...(rule.description ? { description: rule.description } : {}),
		}));
	}
}
