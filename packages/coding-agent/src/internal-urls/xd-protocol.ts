import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { REPORT_ISSUE_DEVICE_NAME } from "@oh-my-pi/pi-tui/tools/report-tool-issue";
import { isResolutionDeviceName } from "@oh-my-pi/pi-tui/tools/resolve";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { parseXdTopicUrl, parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import type { ToolSession } from "../tools";
import { resolveToolTier } from "../tools/approval";
import { dispatchReportIssueDevice, reportIssueDeviceUsage } from "../tools/report-tool-issue";
import { dispatchResolutionDevice, resolutionDeviceUsage } from "../tools/resolve";
import { dispatchXdevTool, resolveXdevTool, xdevDocs, xdevListing } from "../tools/xdev";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

const NOT_MOUNTED = "xd:// is not mounted in this session.";

/**
 * Approval tier for `write xd://<device>`: the mounted tool's own
 * (argument-dependent) approval for the decoded JSON payload. The resolution
 * devices finalize a staged, already-previewed action, so they stay at read
 * tier. Unresolved devices, malformed or non-object payloads, and approval
 * functions that throw fail closed to `exec`.
 */
function deviceWriteTier(
	url: InternalUrl,
	content: string | undefined,
	session: ToolSession | undefined,
): ToolApprovalDecision {
	try {
		const target = parseXdUrl(url.rawHref ?? url.href);
		const name = target?.name;
		if (name === REPORT_ISSUE_DEVICE_NAME) return "write";
		if (name && isResolutionDeviceName(name)) return "read";
		const inst = name && session?.xdev ? resolveXdevTool(session.xdev, name) : undefined;
		if (!name || !inst) return "exec";
		if (typeof content !== "string") return "exec";
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed)) return "exec";
		// The policyKey makes the outer gate consult `tools.approval.<device>` for
		// this dispatch before falling back to `tools.approval.write`, so users can
		// scope allow/deny/prompt to a single device (issue #7923).
		return { tier: resolveToolTier(inst, parsed), policyKey: name };
	} catch {
		return "exec";
	}
}

/** Routes session-bound virtual tool devices through `xd://` URLs. */
export class XdProtocolHandler implements ProtocolHandler {
	readonly scheme = "xd";
	readonly spec: SchemeSpec = {
		backing: "device",
		selectors: "none",
		immutable: true,
		compactTranscript: true,
		write: { via: "handler", payload: "text", scope: "device", tier: deviceWriteTier },
	};

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const session = context?.session;
		if (!session) throw new ToolError(NOT_MOUNTED);
		const topic = parseXdTopicUrl(url.href);
		const device = topic ? null : parseXdUrl(url.href);
		let content: string;
		if (topic) content = this.#topic(session, topic.name, topic.topic);
		else if (device) content = this.#usage(session, device.name);
		else throw new ToolError(`Invalid xd:// URL: ${url.href}. Use xd://, xd://<tool>, or xd://<tool>/<topic>.`);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const target = parseXdUrl(url.href);
		if (!target) throw new ToolError(`Invalid xd:// URL: ${url.href}. Use xd://<tool>.`);
		const session = context?.session;
		if (!session) throw new ToolError(NOT_MOUNTED);
		const { name } = target;
		if (name === REPORT_ISSUE_DEVICE_NAME) {
			const { result, xdev } = await dispatchReportIssueDevice(session, content);
			return { content: result.content, details: { xdev }, isError: result.isError, useless: result.useless };
		}
		if (name && isResolutionDeviceName(name)) {
			const { result, xdev } = await dispatchResolutionDevice(session, name, content);
			return { content: result.content, details: { xdev }, isError: result.isError, useless: result.useless };
		}
		const xdev = session.xdev;
		if (!xdev) throw new ToolError(NOT_MOUNTED);
		if (!name) throw new ToolError(`Cannot write to xd:// itself — pick a device:\n${xdevListing(xdev)}`);
		const toolCall = context.toolCall;
		if (!toolCall) throw new ToolError(`xd://${name} can only be written by the write tool.`);
		const { result, xdev: dispatch } = await dispatchXdevTool(
			xdev,
			name,
			content,
			toolCall.id,
			context.signal,
			toolCall.onUpdate,
			// The write tool's gate already resolved approval at this device's tier
			// (see `deviceWriteTier`) — mark it so a wrapped inner tool does not
			// prompt a second time.
			toolCall.context ? { ...toolCall.context, xdevApproved: true } : undefined,
		);
		return {
			content: result.content,
			details: { xdev: dispatch },
			isError: result.isError,
			useless: result.useless,
		};
	}

	/** `read xd://` listing, or one device's usage/docs. */
	#usage(session: ToolSession, name: string | null): string {
		if (name === REPORT_ISSUE_DEVICE_NAME) return reportIssueDeviceUsage();
		if (name && isResolutionDeviceName(name)) return resolutionDeviceUsage(name);
		const xdev = session.xdev;
		if (!xdev) throw new ToolError(NOT_MOUNTED);
		return name === null ? xdevListing(xdev) : xdevDocs(xdev, name);
	}

	/** `read xd://<tool>/<topic>`: one named doc topic of a tool. */
	#topic(session: ToolSession, name: string, topic: string): string {
		const topics = session.getToolByName?.(name)?.docTopics?.();
		if (!topics) throw new ToolError(`Tool '${name}' has no doc topics.`);
		const doc = topics[topic];
		if (doc === undefined) {
			throw new ToolError(`Unknown topic '${topic}' for ${name}. Available: ${Object.keys(topics).join(", ")}.`);
		}
		return doc;
	}
}
