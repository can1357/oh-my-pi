/**
 * OpenTelemetry metrics for composer next-message predictions.
 *
 * Attributes are low-cardinality and content-free: the outcome, the
 * `provider/model` that served the request, how many alternatives were offered
 * (1-4), and which one the user kept, never prompt or prediction text.
 * Every call is a no-op until OTLP metric export registers a global meter
 * provider (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`). Instruments bind lazily to
 * the current global provider because the metrics API has no proxy provider: a
 * meter taken before registration stays a no-op.
 *
 * Requests and display are separate series: a request settles on what the model
 * returned, and an offered prediction counts as shown once the composer first
 * paints it. Every shown prediction later resolves exactly once, so
 * `resolved{accepted}` over `shown` is the acceptance rate.
 */
import { type Attributes, type Counter, type Histogram, type MeterProvider, metrics } from "@opentelemetry/api";

/**
 * How a prediction request settled:
 * - `offered`: usable reply, offered to the composer (shown once a frame paints it)
 * - `skipped`: the model declined (`NO_PREDICTION`) or replied with nothing usable
 * - `stale`: the conversation moved on before the reply arrived
 * - `cancelled`: superseded or cancelled (new turn, newer request, setting off)
 * - `timeout`: no reply before the prediction deadline
 * - `error`: the side turn failed
 */
export type PredictionOutcome = "offered" | "skipped" | "stale" | "cancelled" | "timeout" | "error";
/** What became of a shown prediction: one of its alternatives inserted with Tab/Right, or retired without that. */
export type PredictionResolution = { result: "accepted"; rank: number } | { result: "ignored" };

const METER_NAME = "@oh-my-pi/pi-coding-agent/composer-prediction";
const OUTCOME = "omp.composer.prediction.outcome";
const RESULT = "omp.composer.prediction.result";
const MODEL = "omp.composer.prediction.model";
const CHOICES = "omp.composer.prediction.choices";
const RANK = "omp.composer.prediction.rank";

class PredictionInstruments {
	readonly requests: Counter<Attributes>;
	readonly duration: Histogram<Attributes>;
	readonly shown: Counter<Attributes>;
	readonly resolved: Counter<Attributes>;
	readonly acceptDelay: Histogram<Attributes>;

	constructor(provider: MeterProvider) {
		const meter = provider.getMeter(METER_NAME);
		this.requests = meter.createCounter("omp.composer.prediction.requests", {
			description: "Composer prediction requests, by how they settled.",
			unit: "{request}",
		});
		this.duration = meter.createHistogram("omp.composer.prediction.duration", {
			description: "Time from a prediction request to its settlement.",
			unit: "ms",
			advice: { explicitBucketBoundaries: [250, 500, 1000, 2000, 3000, 5000, 8000, 12000, 15000, 20000] },
		});
		this.shown = meter.createCounter("omp.composer.prediction.shown", {
			description: "Offered predictions the composer painted, counted on first display.",
			unit: "{prediction}",
		});
		this.resolved = meter.createCounter("omp.composer.prediction.resolved", {
			description: "Shown predictions, by whether the user inserted them.",
			unit: "{prediction}",
		});
		this.acceptDelay = meter.createHistogram("omp.composer.prediction.accept.delay", {
			description: "Time from a prediction first being displayed to the user inserting it.",
			unit: "ms",
			advice: { explicitBucketBoundaries: [500, 1000, 2000, 5000, 10000, 30000, 60000, 300000, 1800000] },
		});
	}
}

const bound = new WeakMap<MeterProvider, PredictionInstruments>();

function instruments(provider: MeterProvider): PredictionInstruments {
	let instruments = bound.get(provider);
	if (!instruments) {
		instruments = new PredictionInstruments(provider);
		bound.set(provider, instruments);
	}
	return instruments;
}

/**
 * Count one settled prediction request and record how long it took, by outcome and serving `provider/model`;
 * an offered request also carries how many alternatives it offered.
 */
export function recordPredictionRequest(
	outcome: PredictionOutcome,
	model: string,
	durationMs: number,
	choices: number | undefined,
	provider: MeterProvider = metrics.getMeterProvider(),
): void {
	const attributes: Attributes = { [OUTCOME]: outcome, [MODEL]: model };
	if (choices !== undefined) attributes[CHOICES] = choices;
	const { requests, duration } = instruments(provider);
	requests.add(1, attributes);
	duration.record(durationMs, attributes);
}

/** Count one offered prediction, with how many alternatives it carries, on its first painted frame. */
export function recordPredictionShown(
	model: string,
	choices: number,
	provider: MeterProvider = metrics.getMeterProvider(),
): void {
	instruments(provider).shown.add(1, { [MODEL]: model, [CHOICES]: choices });
}

/**
 * Count one shown prediction as accepted or ignored. An accepted one carries the rank (0 is most likely) of
 * the alternative the user inserted last, and records how long the prediction was displayed before the
 * first insert.
 */
export function recordPredictionResolved(
	resolution: PredictionResolution,
	model: string,
	choices: number,
	shownForMs: number,
	provider: MeterProvider = metrics.getMeterProvider(),
): void {
	const { resolved, acceptDelay } = instruments(provider);
	const attributes: Attributes = { [RESULT]: resolution.result, [MODEL]: model, [CHOICES]: choices };
	if (resolution.result === "accepted") {
		attributes[RANK] = resolution.rank;
		acceptDelay.record(shownForMs, { [MODEL]: model, [CHOICES]: choices });
	}
	resolved.add(1, attributes);
}
