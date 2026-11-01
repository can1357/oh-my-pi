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
 * - `shown`: usable reply, offered as ghost text over the current draft
 * - `hidden`: usable reply, but the draft typed meanwhile is not a prefix of it
 * - `skipped`: the model declined (`NO_PREDICTION`) or replied with nothing usable
 * - `stale`: the conversation moved on before the reply arrived
 * - `cancelled`: superseded or cancelled (new turn, newer request, setting off)
 * - `timeout`: no reply before the prediction deadline
 * - `error`: the side turn failed
 */
export type PredictionOutcome = "shown" | "hidden" | "skipped" | "stale" | "cancelled" | "timeout" | "error";
/** What became of an offered prediction: inserted with Tab/Right, or retired without that. */
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
			description: "Offered predictions, by whether the user inserted them.",
			unit: "{prediction}",
		});
		this.acceptDelay = meter.createHistogram("omp.composer.prediction.accept.delay", {
			description: "Time from a prediction being offered to the user inserting it.",
			unit: "ms",
			advice: { explicitBucketBoundaries: [500, 1000, 2000, 5000, 10000, 30000, 60000, 300000, 1800000] },
		});
	}
}

let bound: { provider: MeterProvider; instruments: PredictionInstruments } | undefined;

function instruments(): PredictionInstruments {
	const provider = metrics.getMeterProvider();
	if (bound?.provider !== provider) bound = { provider, instruments: new PredictionInstruments(provider) };
	return bound.instruments;
}

export function recordPredictionRequest(outcome: PredictionOutcome, model: string, durationMs: number): void {
	const attributes = { [OUTCOME]: outcome, [MODEL]: model };
	const { requests, duration } = instruments();
	requests.add(1, attributes);
	duration.record(durationMs, attributes);
}

export function recordPredictionResolved(result: PredictionResolution, model: string, offeredForMs: number): void {
	const { resolved, acceptDelay } = instruments();
	resolved.add(1, { [RESULT]: result, [MODEL]: model });
	if (result === "accepted") acceptDelay.record(offeredForMs, { [MODEL]: model });
}
