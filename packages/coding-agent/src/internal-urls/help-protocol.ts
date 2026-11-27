import { ToolError } from "../tools/tool-errors";
import { getEnabledEvalPreludes } from "../eval/preludes";
import helpReferenceDoc from "../prompts/internal-urls/help-reference.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { parseHelpUrl } from "../tools/doc-topics";
import { getEvalDocTopics } from "../tools/eval-doc-topics";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

/**
 * Handler for `help://<tool>/<topic>`: the reference docs a tool description
 * links, served read-only.
 *
 * URL forms:
 * - help://<tool> - Lists that tool's doc topics
 * - help://<tool>/<topic> - Reads one topic
 */
export class HelpProtocolHandler implements ProtocolHandler {
	readonly scheme = "help";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		compactTranscript: true,
	};

	promptReference(): string {
		return helpReferenceDoc.trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const session = context?.session;
		if (!session) throw new ToolError("help:// requires a tool session.");
		const target = parseHelpUrl(url.href);
		if (!target) throw new ToolError(`Invalid help:// URL: ${url.href}. Use help://<tool-name>/<topic>.`);
		const { tool, topic } = target;
		if (!tool) throw new ToolError("help:// needs a tool and topic: use help://<tool>/<topic>.");
		const content = topic === null ? this.#listTopics(session, tool) : this.#topic(session, tool, topic);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	/** `help://<tool>`: one line per doc topic, each `help://<tool>/<topic>`. */
	#listTopics(session: ToolSession, name: string): string {
		const topics = this.#topics(session, name);
		const lines: string[] = [];
		for (const topic in topics) lines.push(`help://${name}/${topic}`);
		return lines.join("\n");
	}

	/** `help://<tool>/<topic>`: one named doc topic. */
	#topic(session: ToolSession, name: string, topic: string): string {
		const topics = this.#topics(session, name);
		const doc = topics[topic];
		if (doc === undefined) {
			const available: string[] = [];
			for (const key in topics) available.push(key);
			throw new ToolError(`Unknown topic '${topic}' for ${name}. Available: ${available.join(", ")}.`);
		}
		return doc;
	}

	/** A tool's doc topics; a session without eval still serves the eval docs its assignments link. */
	#topics(session: ToolSession, name: string): Readonly<Record<string, string>> {
		const tool = session.getToolByName?.(name);
		const topics =
			tool?.docTopics?.() ??
			(name === "eval" && !tool
				? getEvalDocTopics({ preludes: getEnabledEvalPreludes(session.getEvalPreludes?.() ?? []) })
				: undefined);
		if (!topics) {
			throw new ToolError(tool ? `Tool '${name}' has no doc topics.` : `No tool '${name}' in this session.`);
		}
		return topics;
	}
}
