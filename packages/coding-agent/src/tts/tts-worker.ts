import { PhononTts } from "@oh-my-pi/pi-natives";
import { errorText, replayCachedReady, sendLog } from "../subprocess/worker-runtime";
import { ensureTtsCheckpoint } from "./checkpoint";
import {
	getTtsLocalModelSpec,
	resolveTtsSpeed,
	resolveTtsVoice,
	type TtsLocalModelKey,
	ttsDurationDelta,
} from "./models";
import { runFramedStdioWorker } from "../daemon/modules/speech-frames";
import type { TtsTransport, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";

const TTS_TASK = "text-to-speech";

/**
 * Text budget of one streaming synthesis call after the first. Segments already
 * queued are joined up to it so the model paces the sentences itself: spoken
 * one by one, short sentences come out slower and each trails ~0.6 s of
 * silence. ~400 chars is ~1 s of compute, short enough that playback of the
 * previous chunk never drains.
 */
const BATCH_CHARS = 400;
/** A segment that already ends its sentence (optionally inside closing quotes/brackets). */
const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/;

const models = new Map<TtsLocalModelKey, Promise<PhononTts>>();
let synthesizeQueue = Promise.resolve();

/** Per-request native options: a voice the model ships and the conditioner value for the rate. */
interface SpeechRequest {
	voice: string;
	durationDelta: number;
}

/**
 * In-flight streaming sessions keyed by request id. A session is created on
 * `stream-start` and torn down when its run loop finishes. Each `stream-push`
 * carries one complete speakable segment (the parent's `SpeakableStream` does
 * all splitting and normalization); segments queue here and the run loop
 * synthesizes them in arrival order, waking via `wake` when idle.
 */
interface StreamSession {
	modelKey: TtsLocalModelKey;
	voice: string | undefined;
	speed: number | undefined;
	/** Speakable segments awaiting synthesis, in arrival order. */
	queue: string[];
	/** Resolves the run loop's idle wait when a push/end/cancel arrives. */
	wake: (() => void) | null;
	ended: boolean;
	cancelled: boolean;
}
const streamSessions = new Map<string, StreamSession>();

function speechRequest(
	modelKey: TtsLocalModelKey,
	voice: string | undefined,
	speed: number | undefined,
): SpeechRequest {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown local TTS model: ${modelKey}`);
	return { voice: resolveTtsVoice(modelKey, voice), durationDelta: ttsDurationDelta(spec, resolveTtsSpeed(speed)) };
}

/**
 * Install the model's checkpoint (first use downloads it, streaming per-file
 * byte progress) and load it through the native binding; memoized per model.
 */
function loadModel(modelKey: TtsLocalModelKey, transport: TtsTransport, requestId: string): Promise<PhononTts> {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown local TTS model: ${modelKey}`);
	const cached = replayCachedReady(models, modelKey, transport, requestId, TTS_TASK, spec.label);
	if (cached) return cached;

	const startedAt = performance.now();
	const loaded = ensureTtsCheckpoint(spec, ({ target, loaded, size }) =>
		transport.send({
			type: "progress",
			id: requestId,
			event: {
				modelKey,
				status: loaded === 0 ? "download" : "progress",
				file: target,
				loaded,
				total: size,
				progress: (loaded / size) * 100,
			},
		}),
	)
		.then(dir => PhononTts.load(dir))
		.then(
			model => {
				sendLog(transport, "debug", "tts: local model loaded", {
					modelKey,
					voices: model.voices.length,
					elapsedMs: Math.round(performance.now() - startedAt),
				});
				transport.send({
					type: "progress",
					id: requestId,
					event: { modelKey, status: "ready", task: TTS_TASK, model: spec.label },
				});
				return model;
			},
			error => {
				models.delete(modelKey);
				throw error;
			},
		);
	models.set(modelKey, loaded);
	return loaded;
}

function enqueueRequest(
	transport: TtsTransport,
	request: Extract<TtsWorkerInbound, { type: "synthesize" | "download" }>,
): void {
	synthesizeQueue = synthesizeQueue.then(
		async () => {
			await handleQueuedRequest(transport, request);
		},
		async () => {
			await handleQueuedRequest(transport, request);
		},
	);
}

async function handleQueuedRequest(
	transport: TtsTransport,
	request: Extract<TtsWorkerInbound, { type: "synthesize" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadModel(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		const options = speechRequest(request.modelKey, request.voice, request.speed);
		const model = await loadModel(request.modelKey, transport, request.id);
		const pcm = await model.synthesize(request.text, options);
		transport.send({ type: "audio", id: request.id, pcm, sampleRate: model.sampleRate });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

/**
 * Take the next synthesis input off `queue`: the first segment of a session
 * alone (fastest first audio), later ones joined with every queued segment that
 * fits {@link BATCH_CHARS}. A joined segment without sentence-final punctuation
 * (a list item or heading cut at a newline) gets a full stop, so the boundary
 * is still spoken as one.
 */
function takeBatch(queue: string[], first: string, spoke: boolean): string {
	let batch = first;
	while (spoke && queue.length > 0 && batch.length + queue[0]!.length < BATCH_CHARS) {
		batch = `${SENTENCE_END_RE.test(batch) ? batch : `${batch}.`} ${queue.shift()}`;
	}
	return batch;
}

/**
 * Drive one streaming session to completion: load the model, then synthesize
 * queued segments in arrival order (batched by {@link takeBatch}) — one
 * `audio-chunk` per synthesis call, followed by a single `stream-done`. Serialized through
 * {@link synthesizeQueue} so it never interleaves model access with a batch
 * synthesize/download.
 */
async function runStreamSession(transport: TtsTransport, id: string, session: StreamSession): Promise<void> {
	try {
		if (session.cancelled) return;
		const options = speechRequest(session.modelKey, session.voice, session.speed);
		const model = await loadModel(session.modelKey, transport, id);
		if (session.cancelled) return;
		let index = 0;
		while (!session.cancelled) {
			const segment = session.queue.shift();
			if (segment === undefined) {
				if (session.ended) break;
				const { promise, resolve } = Promise.withResolvers<void>();
				session.wake = resolve;
				// Re-check after arming: a push/end/cancel racing the empty shift.
				if (session.queue.length > 0 || session.ended || session.cancelled) {
					session.wake = null;
					resolve();
				}
				await promise;
				continue;
			}
			const text = takeBatch(session.queue, segment, index > 0);
			const pcm = await model.synthesize(text, options);
			if (session.cancelled) break;
			if (pcm.length === 0) continue;
			// Drain each chunk before the next segment so playback starts on the
			// first segment instead of after a burst at the end of the session.
			await transport.sendAndFlush({
				type: "audio-chunk",
				id,
				index: index++,
				text,
				pcm,
				sampleRate: model.sampleRate,
			});
		}
		if (!session.cancelled) transport.send({ type: "stream-done", id });
	} catch (error) {
		if (!session.cancelled) transport.send({ type: "error", id, error: errorText(error) });
	} finally {
		streamSessions.delete(id);
	}
}

function startStreamSession(
	transport: TtsTransport,
	message: Extract<TtsWorkerInbound, { type: "stream-start" }>,
): void {
	const session: StreamSession = {
		modelKey: message.modelKey,
		voice: message.voice,
		speed: message.speed,
		queue: [],
		wake: null,
		ended: false,
		cancelled: false,
	};
	streamSessions.set(message.id, session);
	synthesizeQueue = synthesizeQueue.then(
		() => runStreamSession(transport, message.id, session),
		() => runStreamSession(transport, message.id, session),
	);
}

/** Wake the session's run loop if it is parked on an empty queue. */
function wakeStreamSession(session: StreamSession): void {
	const wake = session.wake;
	session.wake = null;
	wake?.();
}

function pushToStreamSession(id: string, text: string): void {
	const session = streamSessions.get(id);
	if (!session || session.cancelled) return;
	session.queue.push(text);
	wakeStreamSession(session);
}

function endStreamSession(id: string): void {
	const session = streamSessions.get(id);
	if (!session || session.cancelled) return;
	session.ended = true;
	wakeStreamSession(session);
}

function cancelStreamSession(id: string): void {
	const session = streamSessions.get(id);
	if (!session) return;
	session.cancelled = true;
	session.queue.length = 0;
	wakeStreamSession(session);
	streamSessions.delete(id);
}

export function startTtsWorker(transport: TtsTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "stream-start":
				startStreamSession(transport, message);
				return;
			case "stream-push":
				pushToStreamSession(message.id, message.text);
				return;
			case "stream-end":
				endStreamSession(message.id);
				return;
			case "stream-cancel":
				cancelStreamSession(message.id);
				return;
			default:
				enqueueRequest(transport, message);
				return;
		}
	});
}

/** Process entry of `__omp_worker_tts`: serve the daemon `speech` module over stdio frames. */
export function runTtsWorker(): Promise<void> {
	return runFramedStdioWorker<TtsWorkerInbound, TtsWorkerOutbound>(startTtsWorker);
}
