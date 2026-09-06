import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { isEnoent, logger, pathIsWithin, prompt } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir, daemonRuntimeDir } from "../launch/paths";
import reviewCommentPrompt from "../prompts/integrations/editor-review-comment.md" with { type: "text" };
import * as git from "../utils/git";

const PROTOCOL_VERSION = 1;
const ATTACH_DIRECTORY = "session-attach";
const REQUEST_BODY_LIMIT = 64 * 1024;
const FETCH_TIMEOUT_MS = 1_000;
const STATUS_POLL_MS = 100;
const STABLE_IDLE_MS = 150;
const MAX_COMPLETED_REQUESTS = 128;

interface AttachSession {
	readonly isStreaming: boolean;
	readonly agent: { hasQueuedMessages(): boolean };
	readonly sessionManager: {
		getCwd(): string;
		getSessionId(): string;
		getSessionName(): string | undefined;
	};
	sendUserMessage(content: string): Promise<void>;
	registerSessionChangeCallback(callback: () => void): () => void;
}

const SessionDescriptorSchema = type({
	version: "1",
	endpointId: "string > 0",
	pid: "number.integer >= 1",
	port: "number.integer >= 1",
	token: "string > 0",
	projectDir: "string > 0",
	startedAt: "string > 0",
});
type SessionDescriptor = typeof SessionDescriptorSchema.infer;

const LiveAttachSessionInfoSchema = type({
	endpointId: "string > 0",
	sessionId: "string > 0",
	"title?": "string",
	cwd: "string > 0",
	startedAt: "string > 0",
	busy: "boolean",
});
export type LiveAttachSessionInfo = typeof LiveAttachSessionInfoSchema.infer;

const ReviewRequestSchema = type({
	sessionId: "string > 0",
	file: "string > 0",
	startLine: "number.integer >= 1",
	startColumn: "number.integer >= 1",
	endLine: "number.integer >= 1",
	"endColumn?": "number.integer >= 1",
	comment: "string > 0",
});
type ReviewRequestBody = typeof ReviewRequestSchema.infer;

const SubmittedReviewSchema = type({ requestId: "string > 0" });
const ReviewStatusSchema = type({
	requestId: "string > 0",
	status: "'pending' | 'complete' | 'error'",
	changed: "boolean",
	exists: "boolean",
	"error?": "string",
});
const ErrorResponseSchema = type({ error: "string > 0" });

export interface LiveReviewComment {
	endpointId: string;
	sessionId: string;
	cwd: string;
	file: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn?: number;
	comment: string;
}

export interface LiveReviewResult {
	requestId: string;
	status: "complete" | "error";
	changed: boolean;
	exists: boolean;
	error?: string;
}

interface FileFingerprint {
	exists: boolean;
	device?: string;
	inode?: string;
	size?: string;
	ctimeNs?: string;
	mtimeNs?: string;
}

interface TrackedReview {
	requestId: string;
	file: string;
	baseline: FileFingerprint;
	status: "pending" | "complete" | "error";
	dispatched: boolean;
	idleSince?: number;
	changed: boolean;
	exists: boolean;
	error?: string;
	completedAt?: number;
	finishing: boolean;
}

export interface LiveAttachServer {
	readonly endpointId: string;
	close(): Promise<void>;
}

function attachDirectory(projectDir: string): string {
	return path.join(daemonRuntimeDir(projectDir), ATTACH_DIRECTORY);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function canonicalAttachProjectDir(cwd: string): Promise<string> {
	const repositoryRoot = await git.repo.root(cwd);
	return canonicalProjectDir(repositoryRoot ?? cwd);
}

function parseReviewRequest(value: unknown): ReviewRequestBody {
	const request = ReviewRequestSchema.assert(value);
	request.comment = request.comment.trim();
	if (request.comment.length === 0) throw new Error("comment must be a non-empty string");
	if (request.endLine < request.startLine) throw new Error("endLine must not precede startLine");
	if (
		request.startLine === request.endLine &&
		request.endColumn !== undefined &&
		request.endColumn < request.startColumn
	) {
		throw new Error("endColumn must not precede startColumn on one line");
	}
	return request;
}

function parseDescriptor(value: unknown): SessionDescriptor | undefined {
	const descriptor = SessionDescriptorSchema(value);
	return descriptor instanceof OmpErrors ? undefined : descriptor;
}

function parseSessionInfo(value: unknown): LiveAttachSessionInfo | undefined {
	const info = LiveAttachSessionInfoSchema(value);
	return info instanceof OmpErrors ? undefined : info;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
	}
}

async function fingerprint(file: string): Promise<FileFingerprint> {
	try {
		const stat = await fs.stat(file, { bigint: true });
		return {
			exists: true,
			device: stat.dev.toString(),
			inode: stat.ino.toString(),
			size: stat.size.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			mtimeNs: stat.mtimeNs.toString(),
		};
	} catch (error) {
		if (isEnoent(error)) return { exists: false };
		throw error;
	}
}

function responseJson(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
		},
	});
}

function responseError(error: unknown, status: number): Response {
	return responseJson({ error: errorMessage(error) }, status);
}

async function fetchDescriptor(
	descriptor: SessionDescriptor,
	pathname: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${descriptor.token}`);
	return fetch(`http://127.0.0.1:${descriptor.port}${pathname}`, {
		...init,
		headers,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
}

async function writeDescriptor(file: string, descriptor: SessionDescriptor): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.chmod(path.dirname(file), 0o700);
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temporary, `${JSON.stringify(descriptor)}\n`);
		await fs.chmod(temporary, 0o600);
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function readDescriptors(projectDir: string): Promise<Array<{ descriptor: SessionDescriptor; file: string }>> {
	const directory = attachDirectory(projectDir);
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return (
		await Promise.all(
			entries
				.filter(entry => entry.endsWith(".json"))
				.map(async entry => {
					const file = path.join(directory, entry);
					try {
						const descriptor = parseDescriptor(await Bun.file(file).json());
						if (!descriptor || descriptor.projectDir !== projectDir) {
							await fs.rm(file, { force: true });
							return undefined;
						}
						return { descriptor, file };
					} catch (error) {
						if (!isEnoent(error)) await fs.rm(file, { force: true }).catch(() => undefined);
						return undefined;
					}
				}),
		)
	).filter((item): item is { descriptor: SessionDescriptor; file: string } => item !== undefined);
}

async function resolveDescriptor(projectDir: string, endpointId: string): Promise<SessionDescriptor> {
	const descriptors = await readDescriptors(projectDir);
	const match = descriptors.find(item => item.descriptor.endpointId === endpointId);
	if (!match) throw new Error(`Attached OMP endpoint not found: ${endpointId}`);
	return match.descriptor;
}

export async function listLiveAttachSessions(cwd: string): Promise<LiveAttachSessionInfo[]> {
	const projectDir = await canonicalAttachProjectDir(cwd);
	const descriptors = await readDescriptors(projectDir);
	const sessions = await Promise.all(
		descriptors.map(async ({ descriptor, file }) => {
			try {
				const response = await fetchDescriptor(descriptor, "/v1/metadata");
				if (!response.ok) return undefined;
				const info = parseSessionInfo(await response.json());
				if (!info || info.endpointId !== descriptor.endpointId || info.cwd !== projectDir) return undefined;
				return info;
			} catch {
				if (!processIsAlive(descriptor.pid)) await fs.rm(file, { force: true }).catch(() => undefined);
				return undefined;
			}
		}),
	);
	return sessions
		.filter((session): session is LiveAttachSessionInfo => session !== undefined)
		.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function sendLiveReviewComment(input: LiveReviewComment): Promise<LiveReviewResult> {
	const projectDir = await canonicalAttachProjectDir(input.cwd);
	const descriptor = await resolveDescriptor(projectDir, input.endpointId);
	const response = await fetchDescriptor(descriptor, "/v1/reviews", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			sessionId: input.sessionId,
			file: path.resolve(input.file),
			startLine: input.startLine,
			startColumn: input.startColumn,
			endLine: input.endLine,
			endColumn: input.endColumn,
			comment: input.comment,
		}),
	});
	const submittedBody: unknown = await response.json();
	if (!response.ok) {
		const failure = ErrorResponseSchema(submittedBody);
		throw new Error(failure instanceof OmpErrors ? "Review was rejected" : failure.error);
	}
	const { requestId } = SubmittedReviewSchema.assert(submittedBody);
	for (;;) {
		await Bun.sleep(STATUS_POLL_MS);
		const statusResponse = await fetchDescriptor(descriptor, `/v1/reviews/${requestId}`);
		const statusBody: unknown = await statusResponse.json();
		if (!statusResponse.ok) {
			const failure = ErrorResponseSchema(statusBody);
			throw new Error(failure instanceof OmpErrors ? "Review status unavailable" : failure.error);
		}
		const status = ReviewStatusSchema.assert(statusBody);
		if (status.status === "pending") continue;
		return {
			requestId,
			status: status.status,
			changed: status.changed,
			exists: status.exists,
			error: status.error,
		};
	}
}

export async function startLiveAttachServer(session: AttachSession): Promise<LiveAttachServer> {
	const endpointId = crypto.randomUUID();
	const token = crypto.randomUUID().replaceAll("-", "");
	const startedAt = new Date().toISOString();
	const reviews = new Map<string, TrackedReview>();
	let closed = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let descriptorPath: string | undefined;
	let publishedCwd: string | undefined;
	let publishInFlight: Promise<void> | undefined;
	let lastPublishError: string | undefined;

	const sessionInfo = async (): Promise<LiveAttachSessionInfo> => ({
		endpointId,
		sessionId: session.sessionManager.getSessionId(),
		title: session.sessionManager.getSessionName(),
		cwd: await canonicalAttachProjectDir(session.sessionManager.getCwd()),
		startedAt,
		busy: session.isStreaming,
	});

	const finishReview = async (review: TrackedReview): Promise<void> => {
		if (review.status !== "pending" || review.finishing) return;
		review.finishing = true;
		try {
			const final = await fingerprint(review.file);
			review.changed =
				review.baseline.exists !== final.exists ||
				review.baseline.device !== final.device ||
				review.baseline.inode !== final.inode ||
				review.baseline.size !== final.size ||
				review.baseline.ctimeNs !== final.ctimeNs ||
				review.baseline.mtimeNs !== final.mtimeNs;
			review.exists = final.exists;
			review.status = "complete";
			review.completedAt = Date.now();
		} catch (error) {
			review.status = "error";
			review.error = errorMessage(error);
			review.completedAt = Date.now();
		} finally {
			review.finishing = false;
		}
	};

	const trimCompletedReviews = (): void => {
		const completed = [...reviews.values()]
			.filter(review => review.status !== "pending")
			.sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
		for (let index = 0; index < completed.length - MAX_COMPLETED_REQUESTS; index++) {
			reviews.delete(completed[index]!.requestId);
		}
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: REQUEST_BODY_LIMIT,
		async fetch(request): Promise<Response> {
			if (request.headers.get("origin")) return responseError("Forbidden", 403);
			if (request.headers.get("authorization") !== `Bearer ${token}`) return responseError("Unauthorized", 401);
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/v1/metadata") return responseJson(await sessionInfo());
			if (request.method === "POST" && url.pathname === "/v1/reviews") {
				try {
					const body = parseReviewRequest(await request.json());
					if (body.sessionId !== session.sessionManager.getSessionId()) {
						return responseError("The OMP process switched sessions; attach again", 409);
					}
					const cwd = await canonicalAttachProjectDir(session.sessionManager.getCwd());
					const requestedFile = path.resolve(body.file);
					if (!pathIsWithin(cwd, requestedFile)) {
						return responseError("Review file is outside the attached session cwd", 400);
					}
					const file = await fs.realpath(requestedFile);
					if (!pathIsWithin(cwd, file)) {
						return responseError("Review file resolves outside the attached session cwd", 400);
					}
					const baseline = await fingerprint(file);
					const requestId = crypto.randomUUID();
					const review: TrackedReview = {
						requestId,
						file,
						baseline,
						status: "pending",
						dispatched: false,
						changed: false,
						exists: true,
						finishing: false,
					};
					reviews.set(requestId, review);
					trimCompletedReviews();
					const relativeFile = path.relative(cwd, file) || path.basename(file);
					const location = `${body.startLine}:${body.startColumn}-${body.endLine}:${body.endColumn ?? "end"}`;
					const message = prompt.render(reviewCommentPrompt, {
						file: relativeFile,
						location,
						comment: body.comment,
					});
					void session
						.sendUserMessage(message)
						.then(() => {
							review.dispatched = true;
						})
						.catch(error => {
							review.status = "error";
							review.error = errorMessage(error);
							review.completedAt = Date.now();
						});
					return responseJson({ requestId }, 202);
				} catch (error) {
					return responseError(error, 400);
				}
			}
			if (request.method === "GET" && url.pathname.startsWith("/v1/reviews/")) {
				const requestId = url.pathname.slice("/v1/reviews/".length);
				const review = reviews.get(requestId);
				if (!review) return responseError("Review request not found", 404);
				return responseJson({
					requestId,
					status: review.status,
					changed: review.changed,
					exists: review.exists,
					error: review.error,
				});
			}
			return responseError("Not found", 404);
		},
	});
	const serverPort = server.port;
	if (serverPort === undefined) {
		await server.stop(true);
		throw new Error("Live attach server did not bind a TCP port");
	}

	const publish = (): Promise<void> => {
		if (publishInFlight) return publishInFlight;
		const operation = (async () => {
			if (closed) return;
			const cwd = session.sessionManager.getCwd();
			const projectDir = await canonicalAttachProjectDir(cwd);
			if (closed) return;
			const nextPath = path.join(attachDirectory(projectDir), `${endpointId}.json`);
			if (nextPath === descriptorPath) {
				publishedCwd = cwd;
				lastPublishError = undefined;
				return;
			}
			await writeDescriptor(nextPath, {
				version: PROTOCOL_VERSION,
				endpointId,
				pid: process.pid,
				port: serverPort,
				token,
				projectDir,
				startedAt,
			});
			const previousPath = descriptorPath;
			descriptorPath = nextPath;
			publishedCwd = cwd;
			if (previousPath) await fs.rm(previousPath, { force: true });
			lastPublishError = undefined;
		})();
		publishInFlight = operation;
		const clear = () => {
			if (publishInFlight === operation) publishInFlight = undefined;
		};
		operation.then(clear, clear);
		return operation;
	};

	const schedulePublish = (): void => {
		void publish().catch(error => {
			const message = errorMessage(error);
			if (message === lastPublishError) return;
			lastPublishError = message;
			logger.warn("Live attach descriptor update failed", { error: message });
		});
	};

	const unregisterSessionChange = session.registerSessionChangeCallback(schedulePublish);

	idleTimer = setInterval(() => {
		if (session.sessionManager.getCwd() !== publishedCwd) schedulePublish();
		const busy = session.isStreaming || session.agent.hasQueuedMessages();
		const now = Date.now();
		for (const review of reviews.values()) {
			if (review.status !== "pending" || !review.dispatched) continue;
			if (busy) {
				review.idleSince = undefined;
				continue;
			}
			review.idleSince ??= now;
			if (now - review.idleSince >= STABLE_IDLE_MS) void finishReview(review);
		}
		trimCompletedReviews();
	}, STATUS_POLL_MS);
	idleTimer.unref();

	try {
		await publish();
	} catch (error) {
		unregisterSessionChange();
		clearInterval(idleTimer);
		await server.stop(true);
		throw error;
	}

	return {
		endpointId,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			unregisterSessionChange();
			if (idleTimer) clearInterval(idleTimer);
			await publishInFlight?.catch(() => undefined);
			if (descriptorPath) await fs.rm(descriptorPath, { force: true }).catch(() => undefined);
			await server.stop(true);
		},
	};
}
