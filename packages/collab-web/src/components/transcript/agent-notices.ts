/**
 * Parsers for host-injected agent traffic: background job completions
 * (`async-result`) and inter-agent IRC messages. The model-facing text is an
 * XML-ish envelope; guests show its structured parts instead of the raw tags.
 */
import type { CustomMessageEntry, ImageContent, SessionEntry } from "@oh-my-pi/pi-wire";

export type JobOutcome = "completed" | "failed" | "aborted";

export interface AsyncJobResult {
	id: string;
	/** Job kind reported by the host ("task", "bash", …). */
	type?: string;
	/** Bash command or task description. */
	label?: string;
	durationMs?: number;
	outcome: JobOutcome;
	/** Subagent type from the `<task-result agent="…">` envelope. */
	agent?: string;
	output: string;
	error?: string;
	abortReason?: string;
	/** Output-schema payload when the job used one. */
	data?: unknown;
}

/** Custom message types that are agent traffic, not host notices: they keep the agent's turn open. */
export const AGENT_TRAFFIC_TYPES: Record<string, true> = {
	"async-result": true,
	"irc:incoming": true,
	"irc:autoreply": true,
	"irc:relay": true,
	"irc:workpool": true,
};

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contentText(entry: CustomMessageEntry): string {
	if (typeof entry.content === "string") return entry.content;
	return entry.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

/** Text between `<tag …>` and `</tag>`, trimmed; undefined when absent. */
function tagBody(section: string, tag: string): string | undefined {
	const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`).exec(section);
	if (!open) return undefined;
	const start = open.index + open[0].length;
	const end = section.indexOf(`</${tag}>`, start);
	return (end < 0 ? section.slice(start) : section.slice(start, end)).trim();
}

function attributes(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of tag.matchAll(/(\w+)="([^"]*)"/g)) out[match[1]!] = match[2]!;
	return out;
}

/** Per-job text sections: batch deliveries separate jobs with `── Job <id> ──` lines. */
function jobSections(body: string): string[] {
	const inner = body
		.replace(/^\s*<system-notice>\s*/, "")
		.replace(/\s*<\/system-notice>\s*$/, "")
		// Drop the "Background job X has completed…" / "N background jobs…" lead-in.
		.replace(/^[^\n]*(?:has|have) completed\.[^\n]*\n?/, "");
	if (!/^── Job /m.test(inner)) return [inner];
	return inner.split(/^── Job [^\n]*──\s*$/m).filter(section => section.trim().length > 0);
}

function outcomeOf(status: string | undefined, section: string): JobOutcome {
	if (status === "aborted" || /<abort-reason>/.test(section)) return "aborted";
	if (status === "failed" || status === "error" || /<error>/.test(section)) return "failed";
	return "completed";
}

export function parseAsyncResult(entry: CustomMessageEntry): AsyncJobResult[] {
	const details = record(entry.details);
	const rawJobs = details && Array.isArray(details.jobs) ? details.jobs.map(record) : [];
	const jobs = rawJobs.length > 0 ? rawJobs : [details];
	const sections = jobSections(contentText(entry));
	return jobs.map((job, i) => {
		const section = sections[i] ?? "";
		const envelope = /<task-result\b[^>]*>/.exec(section);
		const attrs = envelope ? attributes(envelope[0]) : {};
		// Drop the model-facing "Structured output: … agent://…" trailer; the payload renders on its own.
		const plain = section.replace(/\n+Structured output:[\s\S]*$/, "").trim();
		const output = envelope ? (tagBody(section, "output") ?? tagBody(section, "preview") ?? "") : plain;
		const schema = record(job?.schema);
		return {
			id: text(job?.jobId) ?? attrs.id ?? "job",
			type: text(job?.type),
			label: text(job?.label),
			durationMs: typeof job?.durationMs === "number" ? job.durationMs : undefined,
			outcome: outcomeOf(attrs.status, section),
			agent: attrs.agent,
			output,
			error: tagBody(section, "error"),
			abortReason: tagBody(section, "abort-reason"),
			data: schema && Object.hasOwn(schema, "data") ? schema.data : undefined,
		};
	});
}

export interface IrcTraffic {
	from: string;
	/** Recipient; absent for incoming messages (the viewed session's agent). */
	to?: string;
	body: string;
	images?: readonly ImageContent[];
}

/** Normalize both custom IRC notices and the parent's persisted steering envelope. */
export function parseIrcTraffic(entry: SessionEntry): IrcTraffic | null {
	if (entry.type === "custom_message") {
		if (!entry.display || entry.customType === "async-result" || AGENT_TRAFFIC_TYPES[entry.customType] !== true) {
			return null;
		}
		const details = record(entry.details);
		const from = text(details?.from) ?? "agent";
		const to = text(details?.to);
		const body = text(details?.message) ?? text(details?.body) ?? contentText(entry);
		const images =
			typeof entry.content === "string" ? undefined : entry.content.filter(block => block.type === "image");
		return { from, to, body, images };
	}
	if (entry.type !== "message" || entry.message.role !== "user") return null;
	const content = entry.message.content;
	const source =
		typeof content === "string" ? content : content.map(block => (block.type === "text" ? block.text : "")).join("");
	// Only the complete parent-irc.md delivery format qualifies. Do not strip quoted,
	// fenced, incomplete, or embedded IRC examples from ordinary user messages.
	const envelope = /^\s*\[Wait interrupted by message\]\r?\n<irc\b([^>]*)>\r?\n([\s\S]*)\r?\n<\/irc>\s*$/.exec(source);
	if (!envelope) return null;
	const attrs = attributes(envelope[1]!);
	if (attrs.from !== "parent" || !attrs.agent?.trim()) return null;
	const images = typeof content === "string" ? undefined : content.filter(block => block.type === "image");
	return { from: attrs.agent, body: envelope[2]!, images };
}
