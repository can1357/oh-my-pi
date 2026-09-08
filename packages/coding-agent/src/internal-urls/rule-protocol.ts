/**
 * Protocol handler for rule:// URLs.
 *
 * URL forms:
 * - rule://<name> - Reads rule content
 */
import { getActiveRules } from "../capability/rule";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

export class RuleProtocolHandler implements ProtocolHandler {
	readonly scheme = "rule";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
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

		return {
			url: url.href,
			content: rule.content,
			contentType: "text/markdown",
			size: Buffer.byteLength(rule.content, "utf-8"),
			sourcePath: rule.path,
			notes: [],
		};
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		return (context?.rules ?? getActiveRules()).map(rule => ({
			value: rule.name,
			...(rule.description ? { description: rule.description } : {}),
		}));
	}
}
