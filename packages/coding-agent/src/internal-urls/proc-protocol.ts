import { formatDuration } from "@oh-my-pi/pi-tui/render/render-utils";
import type { AsyncJob } from "../async";
import { cancelAgentRegistration, executeCancel, runningAgentsOutsideJobs, snapshotJobs } from "../async/job-control";
import {
	findService,
	listServices,
	modeService,
	sendService,
	serviceLogPath,
	serviceLogsWithRows,
	serviceStatus,
	stopService,
} from "../launch/services";
import type { ProcReadDetails } from "@oh-my-pi/pi-tui/tools/proc-render";
import type { ToolSession } from "../tools";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
} from "./types";

function target(url: InternalUrl): { id: string; mode: boolean } {
	const path = url.rawPathname ?? url.pathname;
	if (url.search || url.hash || (path !== "" && path !== "/" && path !== "/mode"))
		throw new Error(
			`Invalid proc:// URL: ${url.rawHref ?? url.href}. Use proc://, proc://<id>, or proc://<id>/mode.`,
		);
	const id = url.rawHost;
	if (id.includes("/") || id === "." || id === "..") throw new Error(`Invalid process id: ${id}`);
	return { id, mode: path === "/mode" };
}

function ownerJobs(session: ToolSession): AsyncJob[] {
	const ownerId = session.getAgentId?.() ?? undefined;
	return session.asyncJobManager?.getAllJobs(ownerId ? { ownerId } : undefined) ?? [];
}

function textResource(
	url: InternalUrl,
	content: string,
	sourcePath?: string,
	isDirectory = false,
	details?: ProcReadDetails,
): InternalResource {
	return {
		url: url.rawHref ?? url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content),
		...(details ? { details: { proc: details } } : {}),
		...(sourcePath ? { sourcePath } : {}),
		...(isDirectory ? { isDirectory } : {}),
	};
}

/** Caller-visible background jobs and project services. Reads never acknowledge delivery. */
export class ProcProtocolHandler implements ProtocolHandler {
	readonly scheme = "proc";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const session = context?.session;
		if (!session) throw new Error("proc:// requires a tool session");
		const { id, mode } = target(url);
		if (mode) throw new Error("proc://<id>/mode is writable only");
		const jobs = ownerJobs(session);
		const services = session.settings.get("launch.enabled") ? await listServices(session, context?.signal) : [];
		if (!id) {
			const now = Date.now();
			const rows = [
				...jobs.map(job => {
					const duration =
						job.endTime === undefined
							? `up ${formatDuration(now - job.startTime)}`
							: `in ${formatDuration(job.endTime - job.startTime)}`;
					return `${job.id} [${job.type}] ${job.status} ${duration} — ${job.label.replace(/\s+/g, " ")}`;
				}),
				...runningAgentsOutsideJobs(session).map(
					agent => `${agent.id} [task] running up ${formatDuration(agent.ageMs)} — ${agent.activity ?? "agent"}`,
				),
				...services.map(service => serviceStatus(service)),
			];
			return textResource(url, rows.join("\n") || "No background jobs or services.", undefined, true, {
				jobs: snapshotJobs(session, jobs, { includeResults: true }),
				agents: runningAgentsOutsideJobs(session),
				daemons: services,
			});
		}
		const job = jobs.find(item => item.id === id);
		const service = services.find(item => item.name === id);
		if (job && service) throw new Error(`proc://${id} is ambiguous: both job ${id} and service ${id} exist.`);
		if (service) {
			const header = `${serviceStatus(service)}\nready=${service.readyAt !== undefined || service.state === "ready" || service.state === "running"} persist=${service.persist} detached=${service.detached}${service.exitCode === undefined ? "" : ` exit=${service.exitCode}`}`;
			const sourcePath = await serviceLogPath(session, id);
			const logs = context?.pathOnly ? { text: "" } : await serviceLogsWithRows(session, id, context?.signal);
			return textResource(
				url,
				`${header}${logs.text ? `\n${logs.text}` : ""}`,
				(await Bun.file(sourcePath).exists()) ? sourcePath : undefined,
				undefined,
				{ daemon: service, log: logs.text, ...("terminalRows" in logs ? { terminalRows: logs.terminalRows } : {}) },
			);
		}
		if (job) {
			const lines = [`${job.id} [${job.type}] — ${job.status} — ${job.label}`];
			if (job.resultText) lines.push(job.resultText);
			if (job.errorText) lines.push(`Error: ${job.errorText}`);
			if (job.status === "running") {
				const details = job.latestDetails;
				if (typeof details?.output === "string") lines.push(details.output);
				if (job.type === "task") lines.push(`agent://${job.agentId ?? job.id}`);
				const artifact = details?.meta?.truncation?.artifactId;
				if (artifact) lines.push(`artifact://${artifact}`);
			}
			return textResource(url, lines.join("\n"), undefined, false, {
				job: snapshotJobs(session, [job], { includeResults: true })[0],
				log: lines.slice(1).join("\n"),
			});
		}
		const agent = runningAgentsOutsideJobs(session).find(item => item.id === id);
		if (agent)
			return textResource(
				url,
				`${agent.id} [task] — running — ${agent.activity ?? "agent"}\nhistory://${agent.id}`,
				undefined,
				false,
				{ agents: [agent] },
			);
		throw new Error(`Background job or service not found: ${id}`);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const session = context?.session;
		if (!session) throw new Error("proc:// requires a tool session");
		const { id, mode } = target(url);
		if (!id) throw new Error("Write requires proc://<id> or proc://<id>/mode");
		const ownerId = session.getAgentId?.() ?? undefined;
		const job = ownerJobs(session).find(item => item.id === id);
		const agent = runningAgentsOutsideJobs(session).find(item => item.id === id);
		const service = session.settings.get("launch.enabled")
			? await findService(session, id, context?.signal)
			: undefined;
		if ((job || agent) && service)
			throw new Error(`proc://${id} is ambiguous: both job ${id} and service ${id} exist.`);
		if (mode) {
			if (!service) throw new Error(`Service not found: ${id}`);
			if (content !== "persist" && content !== "session" && content !== "detached")
				throw new Error("Service mode must be persist, session, or detached");
			const updated = await modeService(session, id, content, context?.signal);
			return {
				text: `${serviceStatus(updated)}; mode=${content}`,
				details: { proc: { action: "mode", daemon: updated, mode: content } },
			};
		}
		if (service) {
			const updated =
				content === ""
					? await stopService(session, id, context?.signal)
					: await sendService(session, id, content, context?.signal);
			return {
				text: `${content === "" ? "Stopped" : "Sent input to"} ${serviceStatus(updated)}`,
				details: {
					proc:
						content === ""
							? { action: "stop", daemon: updated }
							: { action: "stdin", daemon: updated, input: content },
				},
			};
		}
		if (content !== "") throw new Error("stdin is only available for services");
		if ((job || agent) && session.asyncJobManager) {
			const result = await executeCancel(session, session.asyncJobManager, ownerId, [id]);
			return {
				text: result.content
					.filter(item => item.type === "text")
					.map(item => item.text)
					.join("\n"),
				details: { proc: result.details },
			};
		}
		if (agent) {
			const outcome = await cancelAgentRegistration(session, ownerId, id);
			return {
				text: outcome.message,
				details: { proc: { op: "cancel", jobs: [], cancelled: [{ id, status: outcome.status }] } },
			};
		}
		throw new Error(`Background job or service not found: ${id}`);
	}
}
