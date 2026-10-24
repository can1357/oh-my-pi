import { formatDuration } from "@oh-my-pi/pi-tui/render/render-utils";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { formatBytes, logger, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../async";
import {
	agentStaleNote,
	cancelAgentRegistration,
	executeCancel,
	retuneJobProgress,
	runningAgentsOutsideJobs,
	snapshotJobs,
} from "../async/job-control";
import { watcherLabel } from "../launch/service-monitor";
import {
	findService,
	listServicesTolerant,
	modeService,
	monitorService,
	sendService,
	serviceLogPath,
	serviceLogsWithRows,
	serviceStatus,
	stopService,
} from "../launch/services";
import type { ProcReadDetails } from "@oh-my-pi/pi-tui/tools/proc-render";
import procPromptDoc from "../prompts/internal-urls/proc.md" with { type: "text" };
import type { ToolSession } from "../tools";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	LocateOptions,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

import { cfgLaunchEnabled } from "../tools/settings";

const ACTIONS = { "/mode": "mode", "/kill": "kill", "/progress": "progress" } as const;
type ProcAction = (typeof ACTIONS)[keyof typeof ACTIONS] | "stdin";

type ProcTarget =
	| { id: string; action: ProcAction }
	/** `proc://<id>/streams` lists a bash job's pipe streams; `/streams/<n>` reads one. */
	| { id: string; action: "streams"; stream?: number };

const STREAMS_PATH = /^\/streams(?:\/(\d+))?\/?$/;

function target(url: InternalUrl): ProcTarget {
	const path = url.rawPathname ?? url.pathname;
	const streams = STREAMS_PATH.exec(path);
	if (url.search || url.hash || (!streams && path !== "" && path !== "/" && !Object.hasOwn(ACTIONS, path)))
		throw new Error(
			`Invalid proc:// URL: ${url.rawHref ?? url.href}. Use proc://, proc://<id>, proc://<id>/streams[/<n>], proc://<id>/kill, proc://<id>/mode, or proc://<id>/progress.`,
		);
	const id = url.rawHost;
	if (id.includes("/") || id === "." || id === "..") throw new Error(`Invalid process id: ${id}`);
	if (streams) {
		if (!id) throw new Error("proc://<id>/streams needs a job id, e.g. proc://bg_3/streams");
		return { id, action: "streams", stream: streams[1] === undefined ? undefined : Number(streams[1]) };
	}
	return { id, action: Object.hasOwn(ACTIONS, path) ? ACTIONS[path as keyof typeof ACTIONS] : "stdin" };
}

/** `proc://<id>/kill`: cancels a job, agent, or service; needs no content and touches no files. */
function isKill(url: InternalUrl): boolean {
	return (url.rawPathname ?? url.pathname).endsWith("/kill");
}

/** The write call that cancels `id`, as error messages quote it. */
function killCall(id: string): string {
	return `call write with ${JSON.stringify({ path: `proc://${id}/kill` })} (no content needed)`;
}

/** Reading a write-only action never acts (reads may be speculative); the error names the write that does. */
function writeOnlyError(id: string, action: "kill" | "mode" | "progress"): string {
	if (action === "kill")
		return `proc://${id}/kill is write-only; reading it did not stop anything. To cancel ${id}, ${killCall(id)}; read proc://${id} for its status.`;
	if (action === "progress")
		return `proc://${id}/progress is write-only. To retune its progress, call write with ${JSON.stringify({ path: `proc://${id}/progress`, content: "ambient" })} (wake, ambient, or off); read proc://${id} for its current progress.`;
	return `proc://${id}/mode is write-only. To set a service's mode, call write with ${JSON.stringify({ path: `proc://${id}/mode`, content: "persist" })} (persist, session, or detached); read proc://${id} for its current mode.`;
}

function ownerJobs(session: ToolSession): AsyncJob[] {
	return session.asyncJobManager?.getAllJobs({ ownerId: session.getAgentId?.() ?? undefined }) ?? [];
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

/**
 * `proc://<id>/streams[/<n>]`: the bytes crossing a bash job's pipes, which a
 * later stage (`| tail`, `| grep`) may still be holding back from the job's own
 * output. A stream read is decoded, carriage-return progress becomes lines,
 * and control sequences are stripped, as for the job's output.
 */
function streamsResource(url: InternalUrl, session: ToolSession, id: string, stream?: number): InternalResource {
	const job = ownerJobs(session).find(item => item.id === id);
	if (!job) throw new Error(`Background job not found: ${id}`);
	const streams = job.process?.streams;
	if (!streams) throw new Error(`proc://${id} has no pipe streams: only bash jobs record them.`);
	if (stream === undefined) {
		const rows = streams.list().map(info => {
			// Stage source spans lines (`for …; do …; done`); a row shows each on one line.
			const [producer, consumer] = [info.producer, info.consumer].map(stage =>
				truncate(stage.replace(/\s+/g, " ").trim(), 80),
			);
			return `proc://${id}/streams/${info.id} ${info.open ? "open" : "closed"} ${formatBytes(info.total)} — ${producer} → ${consumer}`;
		});
		return textResource(url, rows.join("\n") || `${id} has not piped anything yet.`, undefined, true);
	}
	const chunk = streams.read(stream);
	if (!chunk)
		throw new Error(`Stream not found: proc://${id}/streams/${stream}. List them with proc://${id}/streams.`);
	const text = sanitizeText(new TextDecoder().decode(chunk.data).replace(/\r\n?/g, "\n"));
	return textResource(url, chunk.start > 0 ? `[first ${formatBytes(chunk.start)} no longer kept]\n${text}` : text);
}

/** Caller-visible background jobs and project services. Reads never acknowledge delivery. */
export class ProcProtocolHandler implements ProtocolHandler {
	readonly scheme = "proc";
	readonly spec: SchemeSpec = {
		backing: "device",
		selectors: "lines",
		immutable: true,
		write: {
			via: "handler",
			payload: "verbatim",
			scope: "workspace",
			tier: () => "exec",
			contentOptional: isKill,
			cancels: isKill,
		},
	};

	promptDoc(): string {
		return procPromptDoc.trim();
	}

	/**
	 * A project service's output log. Jobs and running agents have no log file,
	 * so their URLs (and the listing) locate to null. Never contacts the daemon broker.
	 */
	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const session = context?.session;
		if (!session) throw new Error("proc:// requires a tool session");
		const { id, action } = target(url);
		if (!id || action !== "stdin" || !cfgLaunchEnabled.get(session.settings)) return null;
		if (ownerJobs(session).some(job => job.id === id)) return null;
		if (runningAgentsOutsideJobs(session).some(agent => agent.id === id)) return null;
		const logPath = await serviceLogPath(session, id);
		return options?.create || (await Bun.file(logPath).exists()) ? logPath : null;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const session = context?.session;
		if (!session) throw new Error("proc:// requires a tool session");
		const procTarget = target(url);
		const { id } = procTarget;
		if (procTarget.action === "streams") return streamsResource(url, session, id, procTarget.stream);
		if (procTarget.action !== "stdin") throw new Error(writeOnlyError(id || "<id>", procTarget.action));
		const jobs = ownerJobs(session);
		// Jobs and agents are in-process; a hung broker must not hide them.
		const {
			services,
			monitors,
			error: servicesError,
		} = cfgLaunchEnabled.get(session.settings)
			? await listServicesTolerant(session, context?.signal)
			: { services: [], monitors: undefined, error: undefined };
		const sessionOwner = session.getSessionId?.() ?? session.getAgentId?.();
		const watchersOf = (name: string) => monitors?.filter(watcher => watcher.name === name) ?? [];
		if (!id) {
			const now = Date.now();
			const rows = [
				...jobs.map(job => {
					const duration =
						job.endTime === undefined
							? `up ${formatDuration(now - job.startTime)}`
							: `in ${formatDuration(job.endTime - job.startTime)}`;
					const progress = job.progressDelivery ? ` progress=${job.progressDelivery}` : "";
					return `${job.id} [${job.type}] ${job.status} ${duration}${progress} — ${job.label.replace(/\s+/g, " ")}`;
				}),
				...runningAgentsOutsideJobs(session).map(
					agent =>
						`${agent.id} [task] running up ${formatDuration(agent.ageMs)} — ${agent.activity ?? "agent"}${agentStaleNote(agent)}`,
				),
				...services.flatMap(service => {
					const watchers = watchersOf(service.name);
					return watchers.length === 0
						? [serviceStatus(service)]
						: [
								serviceStatus(service),
								`  watched by: ${watchers.map(watcher => watcherLabel(watcher, service, sessionOwner)).join("; ")}`,
							];
				}),
				...(servicesError ? [`Services unavailable (daemon broker): ${servicesError}`] : []),
			];
			return textResource(url, rows.join("\n") || "No background jobs or services.", undefined, true, {
				jobs: snapshotJobs(session, jobs, { includeResults: true }),
				agents: runningAgentsOutsideJobs(session),
				daemons: services,
				...(monitors ? { monitors } : {}),
			});
		}
		const job = jobs.find(item => item.id === id);
		const service = services.find(item => item.name === id);
		if (job && service) throw new Error(`proc://${id} is ambiguous: both job ${id} and service ${id} exist.`);
		if (service) {
			const watchers = monitors ? watchersOf(id) : undefined;
			const watcherLines =
				watchers === undefined
					? ""
					: watchers.length === 0
						? "\nwatchers: none"
						: `\nwatchers:\n${watchers.map(watcher => `- ${watcherLabel(watcher, service, sessionOwner)}`).join("\n")}`;
			const header = `${serviceStatus(service)}\nready=${service.readyAt !== undefined || service.state === "ready" || service.state === "running"} persist=${service.persist} detached=${service.detached}${service.exitCode === undefined ? "" : ` exit=${service.exitCode}`}${watcherLines}`;
			const sourcePath = await serviceLogPath(session, id);
			const logs = await serviceLogsWithRows(session, id, context?.signal);
			return textResource(
				url,
				`${header}${logs.text ? `\n${logs.text}` : ""}`,
				(await Bun.file(sourcePath).exists()) ? sourcePath : undefined,
				undefined,
				{
					daemon: service,
					log: logs.text,
					...(watchers ? { monitors: watchers } : {}),
					...("terminalRows" in logs ? { terminalRows: logs.terminalRows } : {}),
				},
			);
		}
		if (job) {
			const progress = job.progressDelivery ? ` — progress=${job.progressDelivery}` : "";
			const lines = [`${job.id} [${job.type}] — ${job.status}${progress} — ${job.label}`];
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
				`${agent.id} [task] — running — ${agent.activity ?? "agent"}${agentStaleNote(agent)}\nhistory://${agent.id}`,
				undefined,
				false,
				{ agents: [agent] },
			);
		if (servicesError)
			throw new Error(`Background job or service not found: ${id} (services unavailable: ${servicesError})`);
		throw new Error(`Background job or service not found: ${id}`);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const session = context?.session;
		if (!session) throw new Error("proc:// requires a tool session");
		const { id, action } = target(url);
		if (action === "streams") throw new Error(`proc://${id}/streams is read-only`);
		if (!id)
			throw new Error("Write requires proc://<id>, proc://<id>/kill, proc://<id>/mode, or proc://<id>/progress");
		const ownerId = session.getAgentId?.() ?? undefined;
		const job = ownerJobs(session).find(item => item.id === id);
		const agent = runningAgentsOutsideJobs(session).find(item => item.id === id);
		let service: DaemonSnapshot | undefined;
		if (cfgLaunchEnabled.get(session.settings)) {
			try {
				service = await findService(session, id, context?.signal);
			} catch (error) {
				// Killing an in-process job or agent needs no broker. Skipping the
				// lookup only loses the job/service collision check, which cannot be
				// answered while the broker is down anyway.
				if (context?.signal?.aborted || action !== "kill" || !(job || agent)) throw error;
				logger.warn("Daemon broker lookup failed; cancelling in-process target", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if ((job || agent) && service)
			throw new Error(`proc://${id} is ambiguous: both job ${id} and service ${id} exist.`);
		if (action === "mode") {
			if (!service) throw new Error(`Service not found: ${id}`);
			if (content !== "persist" && content !== "session" && content !== "detached")
				throw new Error("Service mode must be persist, session, or detached");
			const updated = await modeService(session, id, content, context?.signal);
			return {
				content: [{ type: "text", text: `${serviceStatus(updated)}; mode=${content}` }],
				details: { proc: { action: "mode", daemon: updated, mode: content } },
			};
		}
		if (action === "progress") {
			if (content !== "wake" && content !== "ambient" && content !== "off")
				throw new Error("Progress must be wake, ambient, or off");
			if (service) {
				const monitored = await monitorService(session, id, content, context?.signal);
				const text =
					content === "off"
						? `${monitored.detached ? "Stopped monitoring" : "No active monitor for"} ${serviceStatus(monitored.daemon)}`
						: `Monitoring ${serviceStatus(monitored.daemon)}; progress=${content}`;
				return {
					content: [{ type: "text", text }],
					details: {
						proc: {
							action: "progress",
							daemon: monitored.daemon,
							progress: content,
							...(monitored.detached !== undefined ? { detached: monitored.detached } : {}),
						},
					},
				};
			}
			if (job && session.asyncJobManager) {
				if (content === "off")
					throw new Error(
						`A background job's progress channel cannot be detached; write ambient to proc://${id}/progress, or cancel it with proc://${id}/kill.`,
					);
				const result = retuneJobProgress(session, session.asyncJobManager, ownerId, [id], content);
				return {
					content: result.content,
					details: { proc: result.details },
					...(result.isError ? { isError: true } : {}),
				};
			}
			throw new Error(`Background job or service not found: ${id}`);
		}
		if (action === "stdin") {
			if (!service) throw new Error(`stdin is only available for services. To cancel, ${killCall(id)}.`);
			const updated = await sendService(session, id, content, context?.signal);
			return {
				content: [{ type: "text", text: `Sent input to ${serviceStatus(updated)}` }],
				details: { proc: { action: "stdin", daemon: updated, input: content } },
			};
		}
		if (service) {
			const updated = await stopService(session, id, context?.signal);
			return {
				content: [{ type: "text", text: `Stopped ${serviceStatus(updated)}` }],
				details: { proc: { action: "stop", daemon: updated } },
			};
		}
		if ((job || agent) && session.asyncJobManager) {
			const result = await executeCancel(session, session.asyncJobManager, ownerId, [id]);
			return { content: result.content, details: { proc: result.details } };
		}
		if (agent) {
			const outcome = await cancelAgentRegistration(session, ownerId, id);
			return {
				content: [{ type: "text", text: outcome.message }],
				details: { proc: { op: "cancel", jobs: [], cancelled: [{ id, status: outcome.status }] } },
			};
		}
		throw new Error(`Background job or service not found: ${id}`);
	}
}
