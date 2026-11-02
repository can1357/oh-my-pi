/**
 * OpenTelemetry metrics for composer next-message predictions.
 *
 * Attributes are low-cardinality and content-free: the outcome and the
 * `provider/model` that served the request, never prompt or prediction text.
 * Every call is a no-op until OTLP metric export registers a global meter
 * provider (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`). Instruments bind lazily to
 * the current global provider because the metrics API has no proxy provider: a
 * meter taken before registration stays a no-op.
 */
import { type Attributes, type Counter, type Histogram, type MeterProvider, metrics } from "@opentelemetry/api";

/**
 * How a prediction request settled:
 * - `shown`: usable reply, displayed as ghost text in the composer
 * - `hidden`: usable reply, but the composer cannot display it now (a non-prefix or complete
 *   draft, the cursor inside the draft, or an open autocomplete)
 * - `skipped`: the model declined (`NO_PREDICTION`) or replied with nothing usable
 * - `stale`: the conversation moved on before the reply arrived
 * - `cancelled`: superseded or cancelled (new turn, newer request, setting off)
 * - `timeout`: no reply before the prediction deadline
 * - `error`: the side turn failed
 */
export type PredictionOutcome = "shown" | "hidden" | "skipped" | "stale" | "cancelled" | "timeout" | "error";
/** What became of a displayed prediction: inserted with Tab/Right, or retired without that. */
export type PredictionResolution = "accepted" | "ignored";

const METER_NAME = "@oh-my-pi/pi-coding-agent/composer-prediction";
const OUTCOME = "omp.composer.prediction.outcome";
const RESULT = "omp.composer.prediction.result";
const MODEL = "omp.composer.prediction.model";

class PredictionInstruments {
	readonly requests: Counter<Attributes>;
	readonly duration: Histogram<Attributes>;
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
		this.resolved = meter.createCounter("omp.composer.prediction.resolved", {
			description: "Displayed predictions, by whether the user inserted them.",
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

/** Count one settled prediction request and record how long it took, by outcome and serving `provider/model`. */
export function recordPredictionRequest(
	outcome: PredictionOutcome,
	model: string,
	durationMs: number,
	provider: MeterProvider = metrics.getMeterProvider(),
): void {
	const attributes = { [OUTCOME]: outcome, [MODEL]: model };
	const { requests, duration } = instruments(provider);
	requests.add(1, attributes);
	duration.record(durationMs, attributes);
}

/** Count one displayed prediction as accepted or ignored; an accepted one also records how long it was displayed. */
export function recordPredictionResolved(
	result: PredictionResolution,
	model: string,
	shownForMs: number,
	provider: MeterProvider = metrics.getMeterProvider(),
): void {
	const { resolved, acceptDelay } = instruments(provider);
	resolved.add(1, { [RESULT]: result, [MODEL]: model });
	if (result === "accepted") acceptDelay.record(shownForMs, { [MODEL]: model });
}
