//! Fail-open OTLP bootstrap and the wire-compatible `pi.omp.*` log records.
//!
//! Export is deliberately opt-in: without an OTLP endpoint this module does
//! nothing. Collector construction, flushing, and shutdown errors are reported
//! as warnings and never escape into the agent's control flow.

use std::{
	env,
	iter::FusedIterator,
	sync::{
		Arc, LazyLock,
		atomic::{AtomicBool, AtomicU8, Ordering},
	},
	thread::{self, JoinHandle},
	time::{Duration, SystemTime},
};

use omp_core::{EnvPath, Str};
use opentelemetry::{
	Key, KeyValue, global,
	logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _, Severity},
};
use opentelemetry_otlp::{Protocol, WithExportConfig as _};
use opentelemetry_sdk::{
	Resource,
	logs::{SdkLogger, SdkLoggerProvider},
	metrics::SdkMeterProvider,
	trace::SdkTracerProvider,
};
use parking_lot::{Condvar, Mutex, RwLock};
use serde_json::Value as JsonValue;

use crate::{
	collector::{RunCoverage, RunSummary},
	redact::redact_sensitive_credentials,
	semconv::{CaptureMode, ExportProtocol, METER_NAME},
};

/// A declarative, Rust-owned destination for post-hoc telemetry events.
///
/// Targets never invoke Python for an event. Registration and consent happen
/// outside the turn; exporters own batching, retries, and flushing.
#[derive(Clone, Debug)]
pub enum ExportTarget {
	/// Direct OTLP egress under an explicit network capability.
	Otlp(OtlpTarget),
	/// Framed writes to an environment-managed named process.
	Process(ProcessTarget),
	/// Writes inside the declaring environment's filesystem namespace.
	File(FileTarget),
}

/// Declarative OTLP destination.
#[derive(Clone, Debug)]
pub struct OtlpTarget {
	/// Network endpoint approved by the durable destination grant.
	pub endpoint: Str,
	/// OTLP transport protocol.
	pub protocol: ExportProtocol,
	/// Static headers resolved from the extension's capability-scoped
	/// credentials.
	pub headers:  Vec<(Str, Str)>,
}

/// Declarative named-process destination.
#[derive(Clone, Debug)]
pub struct ProcessTarget {
	/// Environment-managed process name.
	pub process:   Str,
	/// Framing protocol for records written to the process.
	pub protocol:  ExportProtocol,
	/// Optional startup handshake frame owned by the exporter.
	pub handshake: Option<JsonValue>,
}

/// Declarative environment-local file destination.
#[derive(Clone, Debug)]
pub struct FileTarget {
	/// Environment-relative output path; never a client-local path.
	pub path: EnvPath,
}

/// Non-fatal exporter health counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ExportStats {
	/// Events queued for a target's exporter worker.
	pub queue_depth: u64,
	/// Events dropped by that target's bounded exporter queue.
	pub dropped:     u64,
	/// Current retry delay after a target failure.
	pub backoff_ms:  u64,
}

impl ExportTarget {
	/// Returns whether this target requires explicit network egress capability.
	pub const fn requires_network(&self) -> bool {
		matches!(self, Self::Otlp(_))
	}
}

/// Interval at which long-lived hosts force buffered telemetry out.
pub const FLUSH_INTERVAL_MS: u64 = 30_000;
const SERVICE_NAME: &str = "omp";

/// OTLP log filtering level parsed from `OTEL_LOG_LEVEL`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LogLevel {
	/// Disable OTLP log records.
	None,
	/// Export errors only.
	Error,
	/// Export warnings and errors.
	Warn,
	/// Export informational, warning, and error records.
	#[default]
	Info,
	/// Export all records including debug records.
	Debug,
}

impl LogLevel {
	const fn weight(self) -> u8 {
		match self {
			Self::None => 0,
			Self::Error => 1,
			Self::Warn => 2,
			Self::Info => 3,
			Self::Debug => 4,
		}
	}
}

/// Environment-resolved OTLP configuration.
///
/// Both the common and per-signal values are retained so callers can inspect
/// exactly which standard OpenTelemetry knobs affected initialization.
#[derive(Clone, Debug)]
pub struct ExportConfig {
	/// The `OTEL_SDK_DISABLED` kill switch (`true`, case-insensitive, only).
	pub sdk_disabled:        bool,
	/// `OTEL_EXPORTER_OTLP_ENDPOINT`.
	pub endpoint:            Option<String>,
	/// Effective trace endpoint; the per-signal value takes precedence.
	pub traces_endpoint:     Option<String>,
	/// Effective log endpoint; the per-signal value takes precedence.
	pub logs_endpoint:       Option<String>,
	/// Effective metric endpoint; the per-signal value takes precedence.
	pub metrics_endpoint:    Option<String>,
	/// Raw `OTEL_TRACES_EXPORTER` selection.
	pub traces_exporter:     Option<String>,
	/// Raw `OTEL_LOGS_EXPORTER` selection.
	pub logs_exporter:       Option<String>,
	/// Raw `OTEL_METRICS_EXPORTER` selection.
	pub metrics_exporter:    Option<String>,
	/// `OTEL_EXPORTER_OTLP_PROTOCOL`.
	pub protocol:            Option<String>,
	/// Effective trace protocol; the per-signal value takes precedence.
	pub traces_protocol:     Option<String>,
	/// Effective log protocol; the per-signal value takes precedence.
	pub logs_protocol:       Option<String>,
	/// Effective metric protocol; the per-signal value takes precedence.
	pub metrics_protocol:    Option<String>,
	/// Effective service name, defaulting literally to `omp`.
	pub service_name:        String,
	/// Raw `OTEL_RESOURCE_ATTRIBUTES`; values are percent-decoded by the
	/// OpenTelemetry environment detector.
	pub resource_attributes: Option<String>,
	/// OTLP log threshold from `OTEL_LOG_LEVEL`.
	pub log_level:           LogLevel,
	/// Message-content capture policy.
	pub capture_mode:        CaptureMode,
	/// Whether trace export passes endpoint, exporter, and protocol gates.
	pub traces_enabled:      bool,
	/// Whether log export passes endpoint, exporter, and protocol gates.
	pub logs_enabled:        bool,
	/// Whether metric export passes endpoint, exporter, and protocol gates.
	pub metrics_enabled:     bool,
}

impl ExportConfig {
	/// Resolves all telemetry knobs from the process environment using
	/// per-signal-over-common precedence rules.
	pub fn from_env() -> Self {
		let endpoint = env_value("OTEL_EXPORTER_OTLP_ENDPOINT");
		let traces_endpoint =
			env_value("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").or_else(|| endpoint.clone());
		let logs_endpoint =
			env_value("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT").or_else(|| endpoint.clone());
		let metrics_endpoint =
			env_value("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT").or_else(|| endpoint.clone());
		let traces_exporter = env_value("OTEL_TRACES_EXPORTER");
		let logs_exporter = env_value("OTEL_LOGS_EXPORTER");
		let metrics_exporter = env_value("OTEL_METRICS_EXPORTER");
		let protocol = env_value("OTEL_EXPORTER_OTLP_PROTOCOL");
		let traces_protocol =
			env_value("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").or_else(|| protocol.clone());
		let logs_protocol =
			env_value("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL").or_else(|| protocol.clone());
		let metrics_protocol =
			env_value("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL").or_else(|| protocol.clone());
		let resource_attributes = env_value("OTEL_RESOURCE_ATTRIBUTES");
		let service_name = env_value("OTEL_SERVICE_NAME")
			.filter(|value| !value.is_empty())
			.or_else(|| resource_service_name(resource_attributes.as_deref()))
			.unwrap_or_else(|| SERVICE_NAME.to_owned());

		let traces_enabled = signal_enabled(
			"trace",
			traces_endpoint.as_deref(),
			traces_exporter.as_deref(),
			traces_protocol.as_deref(),
		);
		let logs_enabled = signal_enabled(
			"log",
			logs_endpoint.as_deref(),
			logs_exporter.as_deref(),
			logs_protocol.as_deref(),
		);
		let metrics_enabled = signal_enabled(
			"metric",
			metrics_endpoint.as_deref(),
			metrics_exporter.as_deref(),
			metrics_protocol.as_deref(),
		);

		Self {
			sdk_disabled: env_value("OTEL_SDK_DISABLED")
				.is_some_and(|value| value.trim().eq_ignore_ascii_case("true")),
			endpoint,
			traces_endpoint,
			logs_endpoint,
			metrics_endpoint,
			traces_exporter,
			logs_exporter,
			metrics_exporter,
			protocol,
			traces_protocol,
			logs_protocol,
			metrics_protocol,
			service_name,
			resource_attributes,
			log_level: parse_log_level(env_value("OTEL_LOG_LEVEL").as_deref()),
			capture_mode: parse_capture_mode(
				env_value("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT").as_deref(),
			),
			traces_enabled,
			logs_enabled,
			metrics_enabled,
		}
	}

	/// Returns true when initialization is allowed and at least one signal is
	/// configured. The SDK kill switch always wins.
	pub const fn enabled(&self) -> bool {
		!self.sdk_disabled && (self.traces_enabled || self.logs_enabled || self.metrics_enabled)
	}
}

fn env_value(key: &str) -> Option<String> {
	env::var(key).ok()
}

fn exporter_is_none(selection: Option<&str>) -> bool {
	selection.is_some_and(|selection| {
		selection
			.split(',')
			.any(|entry| entry.trim().eq_ignore_ascii_case("none"))
	})
}

fn signal_enabled(
	signal: &str,
	endpoint: Option<&str>,
	exporter: Option<&str>,
	protocol: Option<&str>,
) -> bool {
	if exporter_is_none(exporter) || endpoint.is_none_or(str::is_empty) {
		return false;
	}
	let Some(protocol) = protocol
		.map(str::trim)
		.filter(|protocol| !protocol.is_empty())
	else {
		return true;
	};
	if protocol.eq_ignore_ascii_case("http/protobuf") {
		return true;
	}
	tracing::warn!(
		signal,
		protocol,
		supported = "http/protobuf",
		"OTEL export disabled: unsupported protocol"
	);
	false
}

fn parse_log_level(raw: Option<&str>) -> LogLevel {
	match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
		Some("none") => LogLevel::None,
		Some("error") => LogLevel::Error,
		Some("warn" | "warning") => LogLevel::Warn,
		Some("debug") => LogLevel::Debug,
		_ => LogLevel::Info,
	}
}

fn parse_capture_mode(raw: Option<&str>) -> CaptureMode {
	match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
		Some("true" | "1" | "yes") => CaptureMode::Full,
		Some("summary") => CaptureMode::Summary,
		_ => CaptureMode::None,
	}
}

#[derive(Default)]
struct ExportState {
	tracer:          Option<SdkTracerProvider>,
	logger_provider: Option<SdkLoggerProvider>,
	logger:          Option<SdkLogger>,
	meter:           Option<SdkMeterProvider>,
	timer:           Option<FlushTimer>,
}

static STATE: LazyLock<RwLock<ExportState>> = LazyLock::new(|| RwLock::new(ExportState::default()));
static LOG_LEVEL: AtomicU8 = AtomicU8::new(0);
static LOGGER_ENABLED: AtomicBool = AtomicBool::new(false);

struct FlushTimer {
	stop:   Arc<(Mutex<bool>, Condvar)>,
	thread: Option<JoinHandle<()>>,
}

impl FlushTimer {
	fn start() -> Self {
		let stop = Arc::new((Mutex::new(false), Condvar::new()));
		let worker_stop = Arc::clone(&stop);
		let thread = thread::Builder::new()
			.name("omp-otel-flush".to_owned())
			.spawn(move || {
				loop {
					let (lock, wake) = &*worker_stop;
					let mut stopped = lock.lock();
					wake.wait_for(&mut stopped, Duration::from_millis(FLUSH_INTERVAL_MS));
					if *stopped {
						break;
					}
					drop(stopped);
					flush_sync();
				}
			})
			.ok();
		Self { stop, thread }
	}

	fn stop(mut self) {
		let (lock, wake) = &*self.stop;
		*lock.lock() = true;
		wake.notify_one();
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

fn resource(config: &ExportConfig) -> Resource {
	let mut builder =
		Resource::builder_empty().with_attribute(KeyValue::new("service.name", SERVICE_NAME));
	if let Some(raw) = config.resource_attributes.as_deref() {
		builder = builder.with_attributes(
			resource_attribute_pairs(raw).map(|(key, value)| KeyValue::new(key, value)),
		);
	}
	// `OTEL_SERVICE_NAME` wins over `service.name` inside the resource attribute
	// list. `config.service_name` has already resolved that precedence.
	builder
		.with_attribute(KeyValue::new("service.name", config.service_name.clone()))
		.build()
}

fn resource_service_name(raw: Option<&str>) -> Option<String> {
	raw.and_then(|raw| {
		resource_attribute_pairs(raw)
			.filter(|(key, _)| key == "service.name")
			.map(|(_, value)| value)
			.next_back()
	})
}

fn resource_attribute_pairs(
	raw: &str,
) -> impl Clone + DoubleEndedIterator<Item = (String, String)> + FusedIterator + '_ {
	raw.split_terminator(',').filter_map(|entry| {
		let (key, value) = entry.split_once('=')?;
		Some((percent_decode(key.trim())?, percent_decode(value.trim())?))
	})
}

fn percent_decode(raw: &str) -> Option<String> {
	let bytes = raw.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let high = hex_value(*bytes.get(index + 1)?)?;
			let low = hex_value(*bytes.get(index + 2)?)?;
			decoded.push((high << 4) | low);
			index += 3;
		} else {
			decoded.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8(decoded).ok()
}

const fn hex_value(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

/// Initializes configured OTLP providers. Returns whether any provider became
/// active; malformed endpoints and collector failures are fail-open.
pub fn init() -> bool {
	init_sync()
}

fn init_sync() -> bool {
	if is_enabled() {
		return true;
	}
	if env_value("OTEL_SDK_DISABLED").is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
	{
		return false;
	}
	let config = ExportConfig::from_env();
	if !config.enabled() {
		return false;
	}
	let resource = resource(&config);
	let mut state = STATE.write();
	LOG_LEVEL.store(config.log_level.weight(), Ordering::Relaxed);

	if config.traces_enabled {
		match opentelemetry_otlp::SpanExporter::builder()
			.with_http()
			.with_protocol(Protocol::HttpBinary)
			.build()
		{
			Ok(exporter) => {
				let provider = SdkTracerProvider::builder()
					.with_batch_exporter(exporter)
					.with_resource(resource.clone())
					.build();
				global::set_tracer_provider(provider.clone());
				state.tracer = Some(provider);
			},
			Err(error) => tracing::warn!(%error, "OTLP trace exporter initialization failed"),
		}
	}
	if config.metrics_enabled {
		match opentelemetry_otlp::MetricExporter::builder()
			.with_http()
			.with_protocol(Protocol::HttpBinary)
			.build()
		{
			Ok(exporter) => {
				let provider = SdkMeterProvider::builder()
					.with_periodic_exporter(exporter)
					.with_resource(resource.clone())
					.build();
				global::set_meter_provider(provider.clone());
				state.meter = Some(provider);
			},
			Err(error) => tracing::warn!(%error, "OTLP metric exporter initialization failed"),
		}
	}
	if config.logs_enabled {
		match opentelemetry_otlp::LogExporter::builder()
			.with_http()
			.with_protocol(Protocol::HttpBinary)
			.build()
		{
			Ok(exporter) => {
				let provider = SdkLoggerProvider::builder()
					.with_batch_exporter(exporter)
					.with_resource(resource)
					.build();
				crate::logging::attach_otel_bridge(&provider);
				state.logger = Some(provider.logger(METER_NAME));
				state.logger_provider = Some(provider);
				LOGGER_ENABLED.store(true, Ordering::Release);
			},
			Err(error) => tracing::warn!(%error, "OTLP log exporter initialization failed"),
		}
	}

	let enabled = state.tracer.is_some() || state.logger_provider.is_some() || state.meter.is_some();
	if enabled {
		state.timer = Some(FlushTimer::start());
	}
	enabled
}

/// Returns whether at least one real OTLP provider is active.
pub fn is_enabled() -> bool {
	let state = STATE.read();
	state.tracer.is_some() || state.logger_provider.is_some() || state.meter.is_some()
}

/// Flushes buffered spans, log records, and metrics.
///
/// Errors only produce warnings: an unavailable collector must never break an
/// agent turn.
pub fn flush() {
	flush_sync();
}

fn flush_sync() {
	let (tracer, logger, meter) = {
		let state = STATE.read();
		(state.tracer.clone(), state.logger_provider.clone(), state.meter.clone())
	};
	if let Some(provider) = tracer
		&& let Err(error) = provider.force_flush()
	{
		tracing::warn!(%error, "OTLP trace flush failed");
	}
	if let Some(provider) = logger
		&& let Err(error) = provider.force_flush()
	{
		tracing::warn!(%error, "OTLP log flush failed");
	}
	if let Some(provider) = meter
		&& let Err(error) = provider.force_flush()
	{
		tracing::warn!(%error, "OTLP metric flush failed");
	}
}

/// Stops periodic flushing and shuts down every active provider. Shutdown is
/// idempotent and fail-open.
pub fn shutdown() {
	shutdown_sync();
}

fn shutdown_sync() {
	let (timer, tracer, logger, meter) = {
		let mut state = STATE.write();
		(state.timer.take(), state.tracer.take(), state.logger_provider.take(), state.meter.take())
	};
	LOGGER_ENABLED.store(false, Ordering::Release);
	if let Some(timer) = timer {
		timer.stop();
	}
	for result in [
		tracer.map(|provider| provider.shutdown()),
		logger.map(|provider| provider.shutdown()),
		meter.map(|provider| provider.shutdown()),
	]
	.into_iter()
	.flatten()
	{
		if let Err(error) = result {
			tracing::warn!(%error, "OTLP provider shutdown failed");
		}
	}
	let mut state = STATE.write();
	state.logger = None;
}

/// Severity accepted by the `omp.log` logger forwarder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ForwardedLogLevel {
	/// Debug (OpenTelemetry severity number 5).
	Debug,
	/// Informational (OpenTelemetry severity number 9).
	Info,
	/// Warning (OpenTelemetry severity number 13).
	Warn,
	/// Error (OpenTelemetry severity number 17).
	Error,
}

impl ForwardedLogLevel {
	const fn severity(self) -> Severity {
		match self {
			Self::Debug => Severity::Debug,
			Self::Info => Severity::Info,
			Self::Warn => Severity::Warn,
			Self::Error => Severity::Error,
		}
	}

	const fn text(self) -> &'static str {
		match self {
			Self::Debug => "DEBUG",
			Self::Info => "INFO",
			Self::Warn => "WARN",
			Self::Error => "ERROR",
		}
	}

	const fn threshold(self) -> LogLevel {
		match self {
			Self::Debug => LogLevel::Debug,
			Self::Info => LogLevel::Info,
			Self::Warn => LogLevel::Warn,
			Self::Error => LogLevel::Error,
		}
	}
}

/// Emits the completed-run record with the exact `omp.agent.*` shape used
/// by existing dashboards.
pub fn emit_run_summary_log(summary: &RunSummary, coverage: &RunCoverage) {
	if !should_emit(ForwardedLogLevel::Info) {
		return;
	}
	let attributes = vec![
		(Key::from_static_str("omp.agent.step_count"), integer(summary.step_count)),
		(Key::from_static_str("omp.agent.chats.total"), integer(summary.chats.total)),
		(
			Key::from_static_str("omp.agent.chats.total_latency_ms"),
			AnyValue::Double(summary.chats.total_latency_ms),
		),
		(Key::from_static_str("omp.agent.tools.total"), integer(summary.tools.total)),
		(Key::from_static_str("omp.agent.tools.ok"), integer(summary.tools.ok)),
		(Key::from_static_str("omp.agent.tools.error"), integer(summary.tools.error)),
		(Key::from_static_str("omp.agent.tools.skipped"), integer(summary.tools.skipped)),
		(Key::from_static_str("omp.agent.tools.blocked"), integer(summary.tools.blocked)),
		(Key::from_static_str("omp.agent.tools.timeout"), integer(summary.tools.timeout)),
		(Key::from_static_str("omp.agent.tools.aborted"), integer(summary.tools.aborted)),
		(
			Key::from_static_str("omp.agent.tools.total_latency_ms"),
			AnyValue::Double(summary.tools.total_latency_ms),
		),
		(Key::from_static_str("omp.agent.usage.input_tokens"), integer(summary.usage.input)),
		(Key::from_static_str("omp.agent.usage.output_tokens"), integer(summary.usage.output)),
		(
			Key::from_static_str("omp.agent.usage.cached_input_tokens"),
			integer(summary.usage.cached_input),
		),
		(
			Key::from_static_str("omp.agent.usage.cache_write_tokens"),
			integer(summary.usage.cache_write),
		),
		(
			Key::from_static_str("omp.agent.usage.reasoning_output_tokens"),
			integer(summary.usage.reasoning_output),
		),
		(Key::from_static_str("omp.agent.usage.total_tokens"), integer(summary.usage.total)),
		(
			Key::from_static_str("omp.agent.cost.estimated_usd"),
			AnyValue::Double(summary.cost.estimated_usd),
		),
		(
			Key::from_static_str("omp.agent.cost.unavailable_reasons"),
			AnyValue::from(join_strings(&summary.cost.unavailable_reasons)),
		),
		(Key::from_static_str("omp.agent.errors.total"), integer(summary.errors.total)),
		(
			Key::from_static_str("omp.agent.coverage.tools_available"),
			AnyValue::from(join_strings(&coverage.tools_available)),
		),
		(
			Key::from_static_str("omp.agent.coverage.tools_invoked"),
			AnyValue::from(join_strings(&coverage.tools_invoked)),
		),
		(
			Key::from_static_str("omp.agent.coverage.tools_unused"),
			AnyValue::from(join_strings(&coverage.tools_unused)),
		),
		(
			Key::from_static_str("omp.agent.coverage.models_used"),
			AnyValue::from(join_strings(&coverage.models_used)),
		),
		(
			Key::from_static_str("omp.agent.coverage.providers_used"),
			AnyValue::from(join_strings(&coverage.providers_used)),
		),
	];
	emit_record(
		ForwardedLogLevel::Info,
		"agent run completed",
		attributes,
		"omp.agent.run.completed",
		SystemTime::now(),
	);
}

fn integer(value: u64) -> AnyValue {
	AnyValue::Int(i64::try_from(value).unwrap_or(i64::MAX))
}

fn join_strings(values: &[Str]) -> String {
	let capacity =
		values.iter().map(|value| value.len()).sum::<usize>() + values.len().saturating_sub(1);
	let mut joined = String::with_capacity(capacity);
	for (index, value) in values.iter().enumerate() {
		if index != 0 {
			joined.push(',');
		}
		joined.push_str(value.as_str());
	}
	joined
}

/// Forwards a host log as `pi.omp.log`, flattening its context into attributes.
pub fn emit_log(
	level: ForwardedLogLevel,
	message: &str,
	context: Option<&serde_json::Map<String, JsonValue>>,
) {
	emit_log_at(level, message, context, SystemTime::now());
}

/// Forwards a timestamped host log as `pi.omp.log`.
///
/// The source timestamp is preserved while the record's observed timestamp is
/// captured independently at emission.
pub fn emit_log_at(
	level: ForwardedLogLevel,
	message: &str,
	context: Option<&serde_json::Map<String, JsonValue>>,
	timestamp: SystemTime,
) {
	if !should_emit(level) {
		return;
	}
	let mut attributes = process_attributes();
	if let Some(context) = context {
		attributes.extend(context.iter().filter_map(|(key, value)| {
			log_attribute_value(value).map(|value| (Key::new(key.clone()), value))
		}));
	}
	emit_record(level, message, attributes, "pi.omp.log", timestamp);
}

/// Emits `pi.omp.telemetry.warning` with `process.pid`, `code`, and `error`.
pub fn emit_telemetry_warning(message: &str, code: &str, error: Option<&str>) {
	if !should_emit(ForwardedLogLevel::Warn) {
		return;
	}
	let mut attributes = process_attributes();
	attributes.push((Key::from_static_str("code"), AnyValue::from(code.to_owned())));
	if let Some(error) = error {
		attributes.push((Key::from_static_str("error"), AnyValue::from(error.to_owned())));
	}
	emit_record(
		ForwardedLogLevel::Warn,
		message,
		attributes,
		"pi.omp.telemetry.warning",
		SystemTime::now(),
	);
}

fn process_attributes() -> Vec<(Key, AnyValue)> {
	vec![(Key::from_static_str("process.pid"), AnyValue::Int(i64::from(std::process::id())))]
}

fn should_emit(level: ForwardedLogLevel) -> bool {
	LOGGER_ENABLED.load(Ordering::Acquire)
		&& level.threshold().weight() <= LOG_LEVEL.load(Ordering::Relaxed)
}

pub(crate) fn tracing_log_enabled(level: tracing::Level) -> bool {
	let weight = if level == tracing::Level::ERROR {
		1
	} else if level == tracing::Level::WARN {
		2
	} else if level == tracing::Level::INFO {
		3
	} else if level == tracing::Level::DEBUG {
		4
	} else {
		5
	};
	LOGGER_ENABLED.load(Ordering::Acquire) && weight <= LOG_LEVEL.load(Ordering::Relaxed)
}

fn log_attribute_value(value: &JsonValue) -> Option<AnyValue> {
	match value {
		JsonValue::Null => None,
		JsonValue::Bool(value) => Some(AnyValue::Boolean(*value)),
		JsonValue::Number(value) => value
			.as_i64()
			.map(AnyValue::Int)
			.or_else(|| value.as_f64().map(AnyValue::Double)),
		JsonValue::String(value) => Some(AnyValue::from(value.clone())),
		JsonValue::Array(_) | JsonValue::Object(_) => {
			serde_json::to_string(value).ok().map(AnyValue::from)
		},
	}
}

fn emit_record(
	level: ForwardedLogLevel,
	body: &str,
	attributes: Vec<(Key, AnyValue)>,
	event_name: &'static str,
	timestamp: SystemTime,
) {
	let logger = {
		let state = STATE.read();
		if !should_emit(level) {
			return;
		}
		let Some(logger) = state.logger.as_ref() else {
			return;
		};
		logger.clone()
	};
	let mut record = logger.create_log_record();
	record.set_event_name(event_name);
	record.set_timestamp(timestamp);
	record.set_observed_timestamp(SystemTime::now());
	record.set_severity_number(level.severity());
	record.set_severity_text(level.text());
	record.set_body(redact_any_value(AnyValue::from(body.to_owned())));
	record.add_attributes(attributes.into_iter().map(|(key, value)| {
		(Key::new(redact_sensitive_credentials(key.as_str())), redact_any_value(value))
	}));
	logger.emit(record);
}

fn redact_any_value(value: AnyValue) -> AnyValue {
	match value {
		AnyValue::String(value) => AnyValue::from(redact_sensitive_credentials(value.as_str())),
		AnyValue::ListAny(values) => {
			AnyValue::ListAny(Box::new(values.into_iter().map(redact_any_value).collect()))
		},
		AnyValue::Map(values) => AnyValue::Map(Box::new(
			values
				.into_iter()
				.map(|(key, value)| {
					(Key::new(redact_sensitive_credentials(key.as_str())), redact_any_value(value))
				})
				.collect(),
		)),
		value => value,
	}
}
