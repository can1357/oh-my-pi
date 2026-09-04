//! Production debug operations behind the chat [`Services`] seam.

use std::{
	fs, io,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use omp_chat::overlays::services::{
	DebugAction, DebugOutput, DebugRequest, DebugSseFrame, ServiceError, ServiceResult,
};
use omp_core::{Str, sf};
use omp_journal::{
	blob::{BlobRef, BlobStore, GcPolicy},
	gc::{collect_blobs, journal_blob_roots},
};

use super::ServiceState;
use crate::{
	debug as facts,
	diagnostics::{self, BundleSpec, ProfilePayload, profile},
};

const SAMPLE_PNG: &[u8] = &[
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
	0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240, 31, 0, 5,
	0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

pub(super) fn run(state: &ServiceState, request: DebugRequest) -> ServiceResult<DebugOutput> {
	match request.action {
		DebugAction::OpenArtifacts => open_artifacts(state),
		DebugAction::Performance => report(state, ReportMode::Performance),
		DebugAction::Work => work_profile(state),
		DebugAction::Dump => report(state, ReportMode::Session),
		DebugAction::Memory => report(state, ReportMode::Memory),
		DebugAction::Logs => logs(),
		DebugAction::System => system(state),
		DebugAction::Terminal => terminal(&request),
		DebugAction::Protocols => protocols(state, &request),
		DebugAction::RawSse => raw_sse(state),
		DebugAction::Transcript => transcript(state, request.transcript.as_str()),
		DebugAction::ClearCache => clear_cache(state),
	}
}

pub(super) fn dump_raw_sse(state: &ServiceState) -> ServiceResult<PathBuf> {
	let session = session_id(state);
	let snapshot = omp_ai::transport::global_provider_capture().snapshot(session.as_deref());
	let mut text = String::new();
	for frame in snapshot.frames {
		use std::fmt::Write as _;
		let _ = writeln!(
			text,
			"event: {}\nid: {}\ndata: {}\n",
			frame.event, frame.sequence, frame.payload
		);
	}
	let path = reports_dir(state).join(format!("raw-sse-{}.txt", nonce()));
	write_private(&path, text.as_bytes()).map_err(ServiceError::failed)?;
	Ok(path)
}

fn open_artifacts(state: &ServiceState) -> ServiceResult<DebugOutput> {
	let sessions = state
		.live_journal
		.read()
		.parent()
		.map(PathBuf::from)
		.ok_or(ServiceError::Unavailable("session artifacts"))?;
	let path = sessions.join("blobs");
	fs::create_dir_all(&path).map_err(ServiceError::failed)?;
	omp_core::open::open_path(path.to_string_lossy().as_ref());
	Ok(report_output("Debug · artifacts", sf!("Opened `{}`", path.display())))
}

#[derive(Clone, Copy)]
enum ReportMode {
	Session,
	Performance,
	Memory,
}

fn report(state: &ServiceState, mode: ReportMode) -> ServiceResult<DebugOutput> {
	let output = reports_dir(state).join(format!("omp-report-{}.tar.gz", nonce()));
	let settings = serde_json::json!({ "con": state.con.dump() });
	let mut spec = BundleSpec::new(output, state.live_journal.read().clone(), settings);
	spec.artifacts = session_artifacts(state);
	spec.logs = log_files();
	let session = session_id(state);
	let raw = omp_ai::transport::global_provider_capture().snapshot(session.as_deref());
	if !raw.frames.is_empty() {
		let mut text = String::new();
		for frame in raw.frames {
			use std::fmt::Write as _;
			let _ = writeln!(
				text,
				"event: {}\nid: {}\ndata: {}\n",
				frame.event, frame.sequence, frame.payload
			);
		}
		spec.profiles.push(profile::raw_stream_dump(&text));
	}
	match mode {
		ReportMode::Session => {},
		ReportMode::Performance => {
			let samples = work_samples(state);
			spec.profiles.push(profile::folded(&samples));
			spec.profiles.push(profile::flamegraph_svg(&samples));
			let bytes = serde_json::to_vec_pretty(&profile::top_functions(&samples, 100))
				.map_err(ServiceError::failed)?;
			spec.profiles.push(ProfilePayload {
				path: "cpu-summary.json".to_owned(),
				format: "omp-native-scheduling-samples-v1".to_owned(),
				bytes,
			});
		},
		ReportMode::Memory => spec.profiles.push(memory_payload()),
	}
	let summary = diagnostics::create_bundle(spec).map_err(ServiceError::failed)?;
	let title = match mode {
		ReportMode::Session => "Debug · session report",
		ReportMode::Performance => "Debug · performance report",
		ReportMode::Memory => "Debug · memory report",
	};
	Ok(report_output(
		title,
		sf!(
			"Saved `{}`\n\n- Files: {}\n- Uncompressed bytes: {}\n- Omitted: {}",
			summary.output.display(),
			summary.files,
			summary.uncompressed_bytes,
			summary.omitted
		),
	))
}

fn work_profile(state: &ServiceState) -> ServiceResult<DebugOutput> {
	let payload = profile::flamegraph_svg(&work_samples(state));
	let path = reports_dir(state).join(format!("work-profile-{}.svg", nonce()));
	write_private(&path, &payload.bytes).map_err(ServiceError::failed)?;
	omp_core::open::open_path(path.to_string_lossy().as_ref());
	Ok(report_output("Debug · work profile", sf!("Opened `{}`", path.display())))
}

fn work_samples(state: &ServiceState) -> Vec<profile::WorkSample> {
	let events = state.trace.events();
	let cutoff = now_ms().saturating_sub(30_000);
	let mut selected = events
		.iter()
		.filter(|event| event.at_ms >= cutoff)
		.peekable();
	let mut samples = Vec::new();
	while let Some(event) = selected.next() {
		let end = selected.peek().map_or_else(now_ms, |next| next.at_ms);
		samples.push(profile::WorkSample {
			stack:     format!("omp;{}", event.label),
			weight_us: end.saturating_sub(event.at_ms).clamp(1, 5_000) * 1_000,
		});
	}
	if samples.is_empty() {
		samples.push(profile::WorkSample { stack: "omp;debug capture".to_owned(), weight_us: 1 });
	}
	samples
}

fn memory_payload() -> ProfilePayload {
	let usage = process_usage();
	ProfilePayload {
		path:   "memory.json".to_owned(),
		format: "process-rusage-json".to_owned(),
		bytes:  serde_json::to_vec_pretty(&usage).unwrap_or_else(|_| b"{}".to_vec()),
	}
}

fn process_usage() -> serde_json::Value {
	let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
	// SAFETY: `getrusage` initializes the supplied `rusage` on success.
	let ok = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0;
	if !ok {
		return serde_json::json!({ "available": false });
	}
	// SAFETY: guarded by the successful `getrusage` result above.
	let usage = unsafe { usage.assume_init() };
	#[cfg(target_os = "macos")]
	let peak_rss_bytes = u64::try_from(usage.ru_maxrss).unwrap_or_default();
	#[cfg(not(target_os = "macos"))]
	let peak_rss_bytes = u64::try_from(usage.ru_maxrss)
		.unwrap_or_default()
		.saturating_mul(1024);
	serde_json::json!({
		"available": true,
		"peak_rss_bytes": peak_rss_bytes,
		"minor_faults": usage.ru_minflt,
		"major_faults": usage.ru_majflt,
		"voluntary_context_switches": usage.ru_nvcsw,
		"involuntary_context_switches": usage.ru_nivcsw,
	})
}

fn logs() -> ServiceResult<DebugOutput> {
	let Some(directory) = omp_observability::logging::log_dir() else {
		return Ok(report_output("Debug · logs", Str::new_static("No file log is active.")));
	};
	let source = crate::debug_logs::LogSource::discover(directory, UNIX_EPOCH)
		.map_err(ServiceError::failed)?;
	let Some(cursor) = source.newest().map_err(ServiceError::failed)? else {
		return Ok(report_output("Debug · logs", Str::new_static("No log entries found.")));
	};
	let chunk = source
		.read_older(cursor, 256 * 1024)
		.map_err(ServiceError::failed)?;
	let lines = chunk.lines.into_iter().rev().take(50).collect::<Vec<_>>();
	let body = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
	Ok(report_output("Debug · logs", sf!("```text\n{body}\n```")))
}

fn system(state: &ServiceState) -> ServiceResult<DebugOutput> {
	let body = serde_json::to_string_pretty(&serde_json::json!({
		"system": facts::collect_system_facts(),
		"project": state.project,
		"journal": *state.live_journal.read(),
	}))
	.map_err(ServiceError::failed)?;
	Ok(report_output("Debug · system", sf!("```json\n{body}\n```")))
}

fn terminal(request: &DebugRequest) -> ServiceResult<DebugOutput> {
	let body = serde_json::to_string_pretty(&serde_json::json!({
		"viewport": { "columns": request.terminal.viewport.width, "rows": request.terminal.viewport.height },
		"charset": request.terminal.charset,
		"graphics": request.terminal.graphics,
		"appearance": request.terminal.appearance,
		"scrollback": "elastic slots with rebuild-on-resize",
	}))
	.map_err(ServiceError::failed)?;
	Ok(report_output("Debug · terminal", sf!("```json\n{body}\n```")))
}

fn protocols(state: &ServiceState, request: &DebugRequest) -> ServiceResult<DebugOutput> {
	let image = reports_dir(state).join(format!("protocol-sample-{}.png", nonce()));
	write_private(&image, SAMPLE_PNG).map_err(ServiceError::failed)?;
	let notification = omp_tui::Notification::builder()
		.title("omp")
		.body("Terminal protocol test")
		.build();
	omp_tui::notify_desktop(&notification);
	let summary = sf!(
		"viewport: {}×{}\ncharset: {}\ngraphics: {}\nappearance: {}",
		request.terminal.viewport.width,
		request.terminal.viewport.height,
		request.terminal.charset,
		request.terminal.graphics,
		request.terminal.appearance,
	);
	Ok(DebugOutput::ProtocolProbe { summary, image })
}

fn raw_sse(state: &ServiceState) -> ServiceResult<DebugOutput> {
	let session = session_id(state);
	let capture = omp_ai::transport::global_provider_capture();
	let initial = capture
		.snapshot(session.as_deref())
		.frames
		.into_iter()
		.map(map_frame)
		.collect();
	let source = capture.subscribe(session.as_deref());
	let (tx, events) = flume::bounded(64);
	state.runtime.spawn(async move {
		while let Ok(frame) = source.recv_async().await {
			if tx.send_async(map_frame(frame)).await.is_err() {
				break;
			}
		}
	});
	Ok(DebugOutput::RawSse { initial, events })
}

fn map_frame(frame: omp_ai::transport::CapturedFrame) -> DebugSseFrame {
	DebugSseFrame { sequence: frame.sequence, event: frame.event, payload: frame.payload }
}

fn transcript(state: &ServiceState, text: &str) -> ServiceResult<DebugOutput> {
	let path = facts::export_transcript(&reports_dir(state), text).map_err(ServiceError::failed)?;
	Ok(report_output("Debug · transcript", sf!("Saved `{}`", path.display())))
}

fn clear_cache(state: &ServiceState) -> ServiceResult<DebugOutput> {
	let sessions = state
		.live_journal
		.read()
		.parent()
		.map(PathBuf::from)
		.ok_or(ServiceError::Unavailable("session artifacts"))?;
	let journals = project_journals(&sessions).map_err(ServiceError::failed)?;
	let store = BlobStore::open(&sessions).map_err(ServiceError::failed)?;
	let report =
		collect_blobs(&store, &journals, GcPolicy::default()).map_err(ServiceError::failed)?;
	Ok(report_output(
		"Debug · artifact cache",
		sf!(
			"Removed {} expired unreferenced artifacts ({} bytes) and {} stale staging items.",
			report.storage.blobs_removed,
			report.storage.blob_bytes_reclaimed,
			report.storage.temporaries_removed
		),
	))
}

fn project_journals(sessions: &Path) -> io::Result<Vec<PathBuf>> {
	let entries = match fs::read_dir(sessions) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(error) => return Err(error),
	};
	let mut paths = Vec::new();
	for entry in entries {
		let entry = entry?;
		if entry.file_type()?.is_file()
			&& entry
				.path()
				.extension()
				.and_then(|extension| extension.to_str())
				== Some(omp_journal::FILE_EXTENSION)
		{
			paths.push(entry.path());
		}
	}
	paths.sort();
	Ok(paths)
}

fn session_artifacts(state: &ServiceState) -> Vec<(String, PathBuf)> {
	let journal = state.live_journal.read().clone();
	let Ok(store) = BlobStore::open(journal.parent().unwrap_or_else(|| Path::new("."))) else {
		return Vec::new();
	};
	let Ok(roots) = journal_blob_roots(std::slice::from_ref(&journal)) else {
		return Vec::new();
	};
	let mut artifacts = roots
		.into_iter()
		.filter_map(|hash| {
			let reference = BlobRef { hash, size: 0 };
			let path = store.path(&reference);
			path
				.is_file()
				.then(|| (hash.to_hex().as_str().to_owned(), path))
		})
		.collect::<Vec<_>>();
	artifacts.sort_by(|left, right| left.0.cmp(&right.0));
	artifacts
}

fn log_files() -> Vec<PathBuf> {
	let Some(directory) = omp_observability::logging::log_dir() else {
		return Vec::new();
	};
	let Ok(entries) = fs::read_dir(directory) else {
		return Vec::new();
	};
	entries
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.filter(|path| path.is_file() && path.extension().is_some_and(|extension| extension == "log"))
		.collect()
}

fn reports_dir(state: &ServiceState) -> PathBuf {
	state.data_dir.join("reports")
}

fn session_id(state: &ServiceState) -> Option<Str> {
	state
		.live_journal
		.read()
		.file_stem()
		.and_then(|stem| stem.to_str())
		.map(Str::new)
}

fn report_output(title: &'static str, body: Str) -> DebugOutput {
	DebugOutput::Report { title, body }
}

fn nonce() -> u128 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos()
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn project_journals_excludes_blob_and_local_storage() {
		let directory = tempfile::tempdir().expect("temp directory");
		let sessions = directory.path().join("sessions");
		fs::create_dir_all(sessions.join("blobs/aa/bb")).expect("blob tree");
		fs::create_dir_all(sessions.join("session/local")).expect("local tree");
		fs::write(sessions.join("live.oms"), b"journal").expect("journal");
		fs::write(sessions.join("blobs/aa/bb/not-a-journal.oms"), b"blob").expect("blob");

		assert_eq!(project_journals(&sessions).expect("journal inventory"), vec![
			sessions.join("live.oms")
		]);
	}

	#[test]
	fn deterministic_profile_and_protocol_artifacts_are_real_files() {
		let samples =
			vec![profile::WorkSample { stack: "omp;inference".to_owned(), weight_us: 42 }];
		let folded = profile::folded(&samples);
		let flamegraph = profile::flamegraph_svg(&samples);
		assert_eq!(folded.bytes, b"omp;inference 42\n");
		assert!(String::from_utf8_lossy(&flamegraph.bytes).contains("<svg"));
		let directory = tempfile::tempdir().expect("temp directory");
		let image = directory.path().join("probe.png");
		write_private(&image, SAMPLE_PNG).expect("protocol image");
		assert!(image.is_file());
		assert!(fs::metadata(image).expect("image metadata").len() > 0);
	}

	#[test]
	fn memory_snapshot_is_structured_runtime_evidence() {
		let payload = memory_payload();
		assert_eq!(payload.format, "process-rusage-json");
		let value: serde_json::Value = serde_json::from_slice(&payload.bytes).expect("memory JSON");
		assert!(value.get("available").is_some());
	}
}
