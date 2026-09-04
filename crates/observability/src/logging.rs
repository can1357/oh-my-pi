//! Process-wide tracing subscriber, rotating JSON file logs, and timing output.

use std::{
	collections::BTreeMap,
	env, fmt,
	fs::{self, File, OpenOptions},
	io::{self, IsTerminal as _, Write as _},
	path::{Path, PathBuf},
	process,
	sync::{
		Once, OnceLock,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime},
};

use jiff::{Timestamp, Zoned, civil::Date};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_sdk::logs::{SdkLogger, SdkLoggerProvider};
use parking_lot::Mutex;
use serde_json::{Map, Number, Value};
use tracing::{Event, Level, Metadata, Subscriber, field::Visit};
use tracing_subscriber::{
	EnvFilter,
	filter::LevelFilter,
	fmt::{
		FmtContext,
		format::{FmtSpan, FormatEvent, FormatFields, JsonFields, Writer},
		writer::MakeWriter,
	},
	layer::{Context, Filter, Layer, SubscriberExt as _},
	registry::LookupSpan,
	util::SubscriberInitExt as _,
};

use crate::export;

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const MAX_FILES_PER_PROCESS: usize = 5;
const RETAINED_STALE_LOG_DAYS: u64 = 5;
const RETAINED_STALE_LOGS_PER_PROCESS_DAY: usize = 1;

static INIT: Once = Once::new();
static TIMING_MODE: OnceLock<TimingMode> = OnceLock::new();
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static FILE_ACTIVE: AtomicBool = AtomicBool::new(false);
static OTEL_BRIDGE: OnceLock<OpenTelemetryTracingBridge<SdkLoggerProvider, SdkLogger>> =
	OnceLock::new();

/// Timing/profiling behavior parsed from `OMP_TIMING` during [`init`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TimingMode {
	/// Disables span timing output on stderr.
	#[default]
	Off,
	/// Writes completed span timings to stderr until the TUI mutes it.
	Stderr,
	/// Profiles interactive startup and exits before entering the TUI.
	Exit,
}

/// Returns the process timing mode, which is stable after [`init`].
#[must_use]
pub fn timing_mode() -> TimingMode {
	TIMING_MODE.get().copied().unwrap_or_default()
}

/// Installs the global tracing subscriber once, failing open when unavailable.
pub fn init() {
	INIT.call_once(init_once);
}

/// Returns the resolved log directory when this subscriber's file layer is
/// active.
#[must_use]
pub fn log_dir() -> Option<&'static Path> {
	FILE_ACTIVE
		.load(Ordering::Acquire)
		.then(|| LOG_DIR.get().map(PathBuf::as_path))
		.flatten()
}

pub(crate) fn attach_otel_bridge(provider: &SdkLoggerProvider) {
	let _ = OTEL_BRIDGE.set(OpenTelemetryTracingBridge::new(provider));
}

fn init_once() {
	let timing = parse_timing(
		env::var_os("OMP_TIMING")
			.as_deref()
			.map(|value| value.to_string_lossy()),
	);
	let _ = TIMING_MODE.set(timing);

	let (file_filter, file_notice, _) = filter_from_env("OMP_LOG");
	let (stderr_filter, stderr_notice, stderr_configured) = filter_from_env("OMP_LOG_STDERR");
	for (name, error) in [file_notice.as_ref(), stderr_notice.as_ref()]
		.into_iter()
		.flatten()
	{
		eprintln!("{name} invalid: {error}; using default filter");
	}

	let file_writer = omp_core::dirs::home_dir().and_then(|home| {
		let directory = omp_core::dirs::native_directories(&home).state.join("logs");
		if fs::create_dir_all(&directory).is_err() {
			return None;
		}
		let _ = prune_stale(&directory);
		let _ = LOG_DIR.set(directory.clone());
		Some(RotatingWriter::new(directory))
	});
	let file_active = file_writer.is_some();
	let file_layer = file_writer.map(|writer| {
		let mut layer = tracing_subscriber::fmt::layer()
			.fmt_fields(JsonFields::new())
			.event_format(JsonFormat)
			.with_writer(writer)
			.with_ansi(false);
		layer.set_span_events(FmtSpan::CLOSE);
		layer.with_filter(file_filter)
	});
	let stderr_layer = (timing != TimingMode::Off || stderr_configured).then(|| {
		let span_events = if timing == TimingMode::Off {
			FmtSpan::NONE
		} else {
			FmtSpan::CLOSE
		};
		let mut layer = tracing_subscriber::fmt::layer()
			.compact()
			.with_writer(io::stderr)
			.with_ansi(io::stderr().is_terminal());
		layer.set_span_events(span_events);
		layer.with_filter(StderrFilter(stderr_filter))
	});
	let otel_layer = LateOtelLayer.with_filter(OtelFilter);
	let installed = tracing_subscriber::registry()
		.with(file_layer)
		.with(stderr_layer)
		.with(otel_layer)
		.try_init()
		.is_ok();
	FILE_ACTIVE.store(installed && file_active, Ordering::Release);

	if installed {
		for (name, error) in [file_notice, stderr_notice].into_iter().flatten() {
			tracing::warn!(setting = name, %error, "invalid tracing filter; using default filter");
		}
	}
}

fn parse_timing(raw: Option<impl AsRef<str>>) -> TimingMode {
	let Some(raw) = raw else {
		return TimingMode::Off;
	};
	let raw = raw.as_ref().trim();
	if raw.is_empty() {
		TimingMode::Off
	} else if raw.eq_ignore_ascii_case("exit") || raw.eq_ignore_ascii_case("x") {
		TimingMode::Exit
	} else {
		TimingMode::Stderr
	}
}

fn filter_from_env(name: &'static str) -> (LogFilter, Option<(&'static str, String)>, bool) {
	let Some(raw) = env::var_os(name) else {
		return (LogFilter::Default, None, false);
	};
	let Ok(raw) = raw.into_string() else {
		return (LogFilter::Default, Some((name, "value is not valid UTF-8".to_owned())), true);
	};
	match EnvFilter::try_new(raw) {
		Ok(filter) => (LogFilter::Env(filter), None, true),
		Err(error) => (LogFilter::Default, Some((name, error.to_string())), true),
	}
}

#[derive(Debug)]
enum LogFilter {
	Default,
	Env(EnvFilter),
}

impl<S> Filter<S> for LogFilter
where
	S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
	fn enabled(&self, metadata: &Metadata<'_>, context: &Context<'_, S>) -> bool {
		match self {
			Self::Default => default_enabled(metadata.target(), *metadata.level()),
			Self::Env(filter) => Filter::enabled(filter, metadata, context),
		}
	}

	fn callsite_enabled(
		&self,
		metadata: &'static Metadata<'static>,
	) -> tracing::subscriber::Interest {
		match self {
			Self::Default => {
				if default_enabled(metadata.target(), *metadata.level()) {
					tracing::subscriber::Interest::always()
				} else {
					tracing::subscriber::Interest::never()
				}
			},
			Self::Env(filter) => Filter::<S>::callsite_enabled(filter, metadata),
		}
	}

	fn event_enabled(&self, event: &Event<'_>, context: &Context<'_, S>) -> bool {
		match self {
			Self::Default => true,
			Self::Env(filter) => Filter::event_enabled(filter, event, context),
		}
	}

	fn max_level_hint(&self) -> Option<LevelFilter> {
		match self {
			Self::Default => Some(LevelFilter::DEBUG),
			Self::Env(filter) => Filter::<S>::max_level_hint(filter),
		}
	}

	fn on_new_span(
		&self,
		attributes: &tracing::span::Attributes<'_>,
		id: &tracing::span::Id,
		context: Context<'_, S>,
	) {
		if let Self::Env(filter) = self {
			Filter::on_new_span(filter, attributes, id, context);
		}
	}

	fn on_record(
		&self,
		id: &tracing::span::Id,
		values: &tracing::span::Record<'_>,
		context: Context<'_, S>,
	) {
		if let Self::Env(filter) = self {
			Filter::on_record(filter, id, values, context);
		}
	}

	fn on_enter(&self, id: &tracing::span::Id, context: Context<'_, S>) {
		if let Self::Env(filter) = self {
			Filter::on_enter(filter, id, context);
		}
	}

	fn on_exit(&self, id: &tracing::span::Id, context: Context<'_, S>) {
		if let Self::Env(filter) = self {
			Filter::on_exit(filter, id, context);
		}
	}

	fn on_close(&self, id: tracing::span::Id, context: Context<'_, S>) {
		if let Self::Env(filter) = self {
			Filter::on_close(filter, id, context);
		}
	}
}

struct StderrFilter(LogFilter);

impl<S> Filter<S> for StderrFilter
where
	S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
	fn enabled(&self, metadata: &Metadata<'_>, context: &Context<'_, S>) -> bool {
		!omp_core::logging::stderr_muted() && Filter::enabled(&self.0, metadata, context)
	}

	fn callsite_enabled(
		&self,
		_metadata: &'static Metadata<'static>,
	) -> tracing::subscriber::Interest {
		tracing::subscriber::Interest::sometimes()
	}

	fn event_enabled(&self, event: &Event<'_>, context: &Context<'_, S>) -> bool {
		Filter::event_enabled(&self.0, event, context)
	}

	fn max_level_hint(&self) -> Option<LevelFilter> {
		Filter::<S>::max_level_hint(&self.0)
	}

	fn on_new_span(
		&self,
		attributes: &tracing::span::Attributes<'_>,
		id: &tracing::span::Id,
		context: Context<'_, S>,
	) {
		Filter::on_new_span(&self.0, attributes, id, context);
	}

	fn on_record(
		&self,
		id: &tracing::span::Id,
		values: &tracing::span::Record<'_>,
		context: Context<'_, S>,
	) {
		Filter::on_record(&self.0, id, values, context);
	}

	fn on_enter(&self, id: &tracing::span::Id, context: Context<'_, S>) {
		Filter::on_enter(&self.0, id, context);
	}

	fn on_exit(&self, id: &tracing::span::Id, context: Context<'_, S>) {
		Filter::on_exit(&self.0, id, context);
	}

	fn on_close(&self, id: tracing::span::Id, context: Context<'_, S>) {
		Filter::on_close(&self.0, id, context);
	}
}

fn default_enabled(target: &str, level: Level) -> bool {
	if target == "omp" || target.starts_with("omp_") {
		level <= Level::DEBUG
	} else {
		level <= Level::WARN
	}
}

#[derive(Clone, Copy, Debug)]
struct OtelFilter;

impl<S> Filter<S> for OtelFilter
where
	S: Subscriber,
{
	fn enabled(&self, metadata: &Metadata<'_>, _context: &Context<'_, S>) -> bool {
		export::tracing_log_enabled(*metadata.level())
	}

	fn callsite_enabled(
		&self,
		_metadata: &'static Metadata<'static>,
	) -> tracing::subscriber::Interest {
		tracing::subscriber::Interest::sometimes()
	}

	fn max_level_hint(&self) -> Option<LevelFilter> {
		Some(LevelFilter::DEBUG)
	}
}

#[derive(Clone, Copy, Debug)]
struct LateOtelLayer;

impl<S> Layer<S> for LateOtelLayer
where
	S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
	fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
		if let Some(bridge) = OTEL_BRIDGE.get() {
			bridge.on_event(event, context);
		}
	}
}

#[derive(Debug)]
struct WriterState {
	file:           File,
	date:           Date,
	bytes_written:  u64,
	rollover_index: usize,
}

#[derive(Debug)]
struct RotatingWriter {
	directory: PathBuf,
	max_bytes: u64,
	max_files: usize,
	state:     Mutex<Option<WriterState>>,
}

impl RotatingWriter {
	fn new(directory: PathBuf) -> Self {
		Self::with_limits(directory, MAX_BYTES, MAX_FILES_PER_PROCESS)
	}

	fn with_limits(directory: PathBuf, max_bytes: u64, max_files: usize) -> Self {
		Self {
			directory,
			max_bytes: max_bytes.max(1),
			max_files: max_files.max(1),
			state: Mutex::new(None),
		}
	}

	fn write_at(&self, date: Date, bytes: &[u8]) {
		let mut state = self.state.lock();
		let needs_date = state.as_ref().is_none_or(|state| state.date != date);
		if needs_date {
			*state = self.open_state(date).ok();
		}
		let should_roll = state.as_ref().is_some_and(|state| {
			state.bytes_written > 0
				&& state.bytes_written.saturating_add(bytes.len() as u64) > self.max_bytes
		});
		if should_roll {
			*state = self.rotate(date).ok();
		}
		let Some(writer) = state.as_mut() else {
			return;
		};
		if writer.file.write_all(bytes).is_ok() {
			writer.bytes_written = writer.bytes_written.saturating_add(bytes.len() as u64);
		} else {
			*state = None;
		}
	}

	fn open_state(&self, date: Date) -> io::Result<WriterState> {
		let path = self.base_path(date);
		let bytes_written = path.metadata().map_or(0, |metadata| metadata.len());
		let file = OpenOptions::new().create(true).append(true).open(path)?;
		Ok(WriterState { file, date, bytes_written, rollover_index: self.rollover_count(date) })
	}

	fn rotate(&self, date: Date) -> io::Result<WriterState> {
		let base = self.base_path(date);
		if self.max_files == 1 {
			remove_if_exists(&base)?;
		} else {
			remove_if_exists(&self.rollover_path(date, self.max_files - 1))?;
			for index in (1..self.max_files - 1).rev() {
				let source = self.rollover_path(date, index);
				if source.exists() {
					fs::rename(source, self.rollover_path(date, index + 1))?;
				}
			}
			if base.exists() {
				fs::rename(&base, self.rollover_path(date, 1))?;
			}
		}
		let mut state = self.open_state(date)?;
		state.rollover_index = state
			.rollover_index
			.saturating_add(1)
			.min(self.max_files - 1);
		Ok(state)
	}

	fn rollover_count(&self, date: Date) -> usize {
		(1..self.max_files)
			.rev()
			.find(|index| self.rollover_path(date, *index).exists())
			.unwrap_or(0)
	}

	fn base_path(&self, date: Date) -> PathBuf {
		self
			.directory
			.join(format!("omp.{date}.{}.log", process::id()))
	}

	fn rollover_path(&self, date: Date, index: usize) -> PathBuf {
		self
			.directory
			.join(format!("omp.{date}.{}.log.{index}", process::id()))
	}
}

impl io::Write for &RotatingWriter {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		self.write_at(Zoned::now().date(), bytes);
		Ok(bytes.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		if let Some(state) = self.state.lock().as_mut() {
			let _ = state.file.flush();
		}
		Ok(())
	}
}

impl<'writer> MakeWriter<'writer> for RotatingWriter {
	type Writer = &'writer Self;

	fn make_writer(&'writer self) -> Self::Writer {
		self
	}
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
	match fs::remove_file(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error),
	}
}

#[derive(Clone, Copy, Debug)]
struct ParsedLogName {
	date: Date,
	pid:  u32,
}

#[derive(Debug)]
struct StaleLog {
	path:     PathBuf,
	modified: SystemTime,
	name:     ParsedLogName,
}

fn prune_stale(directory: &Path) -> io::Result<()> {
	prune_stale_at(directory, SystemTime::now())
}

fn prune_stale_at(directory: &Path, now: SystemTime) -> io::Result<()> {
	let mut files = Vec::new();
	for entry in fs::read_dir(directory)?.filter_map(Result::ok) {
		let path = entry.path();
		let Some(name) = parse_log_name(&path) else {
			continue;
		};
		let Ok(metadata) = entry.metadata() else {
			continue;
		};
		if metadata.is_file() {
			files.push(StaleLog {
				path,
				modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
				name,
			});
		}
	}

	let retention = Duration::from_secs(RETAINED_STALE_LOG_DAYS * 24 * 60 * 60);
	#[cfg(unix)]
	{
		let mut newest = BTreeMap::<(u32, Date), (SystemTime, PathBuf)>::new();
		for file in files {
			if process_is_live(file.name.pid) {
				continue;
			}
			if now.duration_since(file.modified).unwrap_or_default() > retention {
				let _ = remove_if_exists(&file.path);
				continue;
			}
			let key = (file.name.pid, file.name.date);
			if RETAINED_STALE_LOGS_PER_PROCESS_DAY == 0 {
				let _ = remove_if_exists(&file.path);
				continue;
			}
			match newest.entry(key) {
				std::collections::btree_map::Entry::Vacant(entry) => {
					entry.insert((file.modified, file.path));
				},
				std::collections::btree_map::Entry::Occupied(mut entry) => {
					let current = entry.get();
					if (&file.modified, &file.path) > (&current.0, &current.1) {
						let (_, previous) = entry.insert((file.modified, file.path));
						let _ = remove_if_exists(&previous);
					} else {
						let _ = remove_if_exists(&file.path);
					}
				},
			}
		}
	}
	#[cfg(not(unix))]
	for file in files {
		if now.duration_since(file.modified).unwrap_or_default() > retention {
			let _ = remove_if_exists(&file.path);
		}
	}
	Ok(())
}

fn parse_log_name(path: &Path) -> Option<ParsedLogName> {
	let name = path.file_name()?.to_str()?.strip_prefix("omp.")?;
	let (date, rest) = name.split_once('.')?;
	let (pid, suffix) = rest.split_once(".log")?;
	if !(suffix.is_empty()
		|| suffix
			.strip_prefix('.')
			.is_some_and(|suffix| !suffix.is_empty() && suffix.parse::<usize>().is_ok()))
	{
		return None;
	}
	Some(ParsedLogName { date: date.parse().ok()?, pid: pid.parse().ok()? })
}

#[cfg(unix)]
fn process_is_live(pid: u32) -> bool {
	let Ok(pid) = libc::pid_t::try_from(pid) else {
		return false;
	};
	if pid <= 0 {
		return false;
	}
	// SAFETY: signal 0 performs only the documented liveness/permission check.
	let result = unsafe { libc::kill(pid, 0) };
	result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[derive(Clone, Copy, Debug)]
struct JsonFormat;

impl<S, N> FormatEvent<S, N> for JsonFormat
where
	S: Subscriber + for<'lookup> LookupSpan<'lookup>,
	N: for<'writer> FormatFields<'writer> + 'static,
{
	fn format_event(
		&self,
		context: &FmtContext<'_, S, N>,
		mut writer: Writer<'_>,
		event: &Event<'_>,
	) -> fmt::Result {
		let mut visitor = JsonVisitor::default();
		event.record(&mut visitor);
		let metadata = event.metadata();
		let now = Timestamp::now();
		let mut fields = visitor.fields;
		let message = fields
			.remove("message")
			.and_then(|value| value.as_str().map(str::to_owned))
			.unwrap_or_else(|| metadata.name().to_owned());
		for reserved in ["timestamp", "timestamp_ms", "pid", "level", "target", "span"] {
			fields.remove(reserved);
		}

		let mut record = Map::new();
		record.insert("timestamp".to_owned(), Value::String(now.to_string()));
		record.insert(
			"timestamp_ms".to_owned(),
			Value::Number(Number::from(now.as_millisecond().max(0) as u64)),
		);
		record.insert("pid".to_owned(), Value::Number(Number::from(process::id())));
		record
			.insert("level".to_owned(), Value::String(metadata.level().as_str().to_ascii_lowercase()));
		record.insert("target".to_owned(), Value::String(metadata.target().to_owned()));
		let mut scope = String::new();
		if let Some(spans) = context.event_scope() {
			for span in spans.from_root() {
				if !scope.is_empty() {
					scope.push(':');
				}
				scope.push_str(span.metadata().name());
			}
		}
		if !scope.is_empty() {
			record.insert("span".to_owned(), Value::String(scope));
		}
		record.insert("message".to_owned(), Value::String(message));
		record.extend(fields);

		let line = serde_json::to_string(&record).map_err(|_| fmt::Error)?;
		writer.write_str(&line)?;
		writer.write_char('\n')
	}
}

#[derive(Default)]
struct JsonVisitor {
	fields: Map<String, Value>,
}

impl Visit for JsonVisitor {
	fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
		let value =
			Number::from_f64(value).map_or_else(|| Value::String(value.to_string()), Value::Number);
		self.fields.insert(field.name().to_owned(), value);
	}

	fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
		self
			.fields
			.insert(field.name().to_owned(), Value::Number(Number::from(value)));
	}

	fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
		self
			.fields
			.insert(field.name().to_owned(), Value::Number(Number::from(value)));
	}

	fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
		self
			.fields
			.insert(field.name().to_owned(), Value::Bool(value));
	}

	fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
		self
			.fields
			.insert(field.name().to_owned(), Value::String(value.to_owned()));
	}

	fn record_error(
		&mut self,
		field: &tracing::field::Field,
		value: &(dyn std::error::Error + 'static),
	) {
		self
			.fields
			.insert(field.name().to_owned(), Value::String(value.to_string()));
	}

	fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
		self
			.fields
			.insert(field.name().to_owned(), Value::String(format!("{value:?}")));
	}
}

#[cfg(test)]
mod tests {
	use std::{fs::FileTimes, thread};

	use tempfile::tempdir;

	use super::*;

	fn date(year: i16, month: i8, day: i8) -> Date {
		Date::new(year, month, day).expect("valid test date")
	}

	fn log_files(directory: &Path) -> Vec<PathBuf> {
		let mut files = fs::read_dir(directory)
			.expect("read log directory")
			.filter_map(Result::ok)
			.map(|entry| entry.path())
			.filter(|path| path.is_file())
			.collect::<Vec<_>>();
		files.sort_unstable();
		files
	}

	fn create_log(
		directory: &Path,
		date: Date,
		pid: u32,
		suffix: Option<usize>,
		modified: SystemTime,
	) -> PathBuf {
		let suffix = suffix.map_or_else(String::new, |suffix| format!(".{suffix}"));
		let path = directory.join(format!("omp.{date}.{pid}.log{suffix}"));
		let file = File::create(&path).expect("create log");
		file
			.set_times(FileTimes::new().set_modified(modified))
			.expect("set log mtime");
		path
	}

	#[test]
	fn size_rollover_caps_process_files() {
		let directory = tempdir().expect("tempdir");
		let writer = RotatingWriter::with_limits(directory.path().to_path_buf(), 8, 5);
		let date = date(2026, 8, 10);
		for _ in 0..7 {
			writer.write_at(date, b"12345678\n");
		}
		let files = log_files(directory.path());
		assert_eq!(files.len(), 5);
		assert!(writer.rollover_path(date, 4).exists());
		assert!(!writer.rollover_path(date, 5).exists());
	}

	#[test]
	fn date_rollover_opens_a_new_base_file() {
		let directory = tempdir().expect("tempdir");
		let writer = RotatingWriter::with_limits(directory.path().to_path_buf(), 64, 5);
		let first = date(2026, 8, 10);
		let second = date(2026, 8, 11);
		writer.write_at(first, b"first\n");
		writer.write_at(second, b"second\n");
		assert!(writer.base_path(first).exists());
		assert!(writer.base_path(second).exists());
	}

	#[test]
	fn prune_removes_old_dead_logs_and_keeps_live_processes() {
		let directory = tempdir().expect("tempdir");
		let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
		let old = now - Duration::from_hours(144);
		let recent = now - Duration::from_secs(60);
		let dead_pid = i32::MAX as u32;
		let old_dead = create_log(directory.path(), date(2026, 8, 1), dead_pid, None, old);
		let live = create_log(directory.path(), date(2026, 8, 1), process::id(), None, old);
		let older = create_log(
			directory.path(),
			date(2026, 8, 2),
			dead_pid,
			None,
			recent - Duration::from_secs(1),
		);
		let newest = create_log(directory.path(), date(2026, 8, 2), dead_pid, Some(1), recent);

		prune_stale_at(directory.path(), now).expect("prune logs");

		assert!(!old_dead.exists());
		assert!(live.exists());
		assert!(!older.exists());
		assert!(newest.exists());
	}

	#[test]
	fn default_filter_calibrates_omp_and_external_targets() {
		assert!(default_enabled("omp_envd", Level::DEBUG));
		assert!(!default_enabled("hyper", Level::DEBUG));
		assert!(default_enabled("hyper", Level::WARN));
	}

	#[test]
	fn timing_mode_parses_exit_and_stderr_values() {
		assert_eq!(parse_timing(None::<&str>), TimingMode::Off);
		assert_eq!(parse_timing(Some("")), TimingMode::Off);
		assert_eq!(parse_timing(Some("1")), TimingMode::Stderr);
		assert_eq!(parse_timing(Some("true")), TimingMode::Stderr);
		assert_eq!(parse_timing(Some("full")), TimingMode::Stderr);
		assert_eq!(parse_timing(Some("x")), TimingMode::Exit);
		assert_eq!(parse_timing(Some("EXIT")), TimingMode::Exit);
	}

	#[test]
	fn json_formatter_writes_viewer_fields() {
		let directory = tempdir().expect("tempdir");
		let writer = RotatingWriter::with_limits(directory.path().to_path_buf(), 1024, 5);
		let subscriber = tracing_subscriber::registry().with(
			tracing_subscriber::fmt::layer()
				.fmt_fields(JsonFields::new())
				.event_format(JsonFormat)
				.with_writer(writer)
				.with_ansi(false),
		);
		let guard = tracing::subscriber::set_default(subscriber);
		tracing::warn!(target: "omp_test", answer = 42_u64, "recorded message");
		drop(guard);
		thread::yield_now();

		let path = log_files(directory.path()).pop().expect("log file");
		let text = fs::read_to_string(path).expect("read log");
		let record: Value = serde_json::from_str(text.trim()).expect("valid JSON line");
		assert_eq!(record["pid"], process::id());
		assert!(record["timestamp_ms"].as_u64().is_some());
		assert_eq!(record["level"], "warn");
		assert_eq!(record["message"], "recorded message");
		assert_eq!(record["answer"], 42);
	}

	#[test]
	fn otel_filter_is_disabled_without_a_logger() {
		assert!(!export::tracing_log_enabled(Level::ERROR));
	}
}
