//! Production checker, repair-session, picker, and journal composition.
use std::{
	error,
	future::Future,
	io,
	path::{Path, PathBuf},
	pin::Pin,
	process::Stdio,
	sync::Arc,
	time,
	time::Duration,
};

use omp_agent::{
	AgentRunSummary, EntryKindDecl, Journal, JournalAuthor, JournalOperation, JournalRequest,
	JournalRequestStamp, PendingCustomEntry, TurnId,
};
use omp_core::{ArtifactDigest, Principal, Provenance, Str, sf};
use omp_proto::thread::v1::{Item, Message, Part, Role, item, part};
use omp_storage::index::{self, SessionIndex, SessionKind};
use parking_lot::Mutex;
use serde_json::value::to_raw_value;
use tokio::{
	io::{AsyncRead, AsyncReadExt as _},
	process::Command,
};
use tokio_util::sync::CancellationToken;

use super::{
	Assignment, BinaryResolver, Checker, CheckerRunner, CleanseHost, FilesystemResolver,
	ProcessOutput, RepairOutcome, Report, TargetChoice, assignment_prompt, discovery_schema,
	scan_project_files,
};
#[cfg(test)]
use crate::cleanse::{CheckerEffect, parsers::ParserKind};
use crate::{
	chat,
	chat::ChatError,
	headless::{HeadlessSession, HeadlessSessionOptions},
};
/// Boxed presentation failure retained as a typed error source.
pub type PresentationError = Box<dyn error::Error + Send + Sync + 'static>;

/// Presentation-owned target and free-form request collection for cleanse.
pub trait CleansePresentation: Send + Sync + 'static {
	/// Selects a discovered checker or custom request path.
	fn pick_target<'a>(
		&'a self,
		checkers: &'a [Checker],
		cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<TargetChoice, PresentationError>> + 'a>>;

	/// Collects the free-form custom cleanse request.
	fn prompt_request<'a>(
		&'a self,
		cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<Option<Str>, PresentationError>> + 'a>>;
}

const JOURNAL_EXTENSION: &str = "so.omp.cleanse";
const JOURNAL_KIND: &str = "so.omp.cleanse.remainder";
const JOURNAL_REVISION: &str = "cleanse.1";

/// Failure from the production cleanse authorities.
#[derive(Debug, thiserror::Error)]
pub enum ProductionError {
	/// Project traversal failed.
	#[error("failed to snapshot cleanse project files under {root:?}")]
	Scan {
		/// Canonical project root.
		root:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A checker process could not be started or observed.
	#[error("failed to run cleanse checker {binary:?}")]
	Checker {
		/// Resolved checker executable.
		binary: PathBuf,
		/// Process failure.
		#[source]
		source: io::Error,
	},
	/// Standalone target selection failed.
	#[error(transparent)]
	Presentation(PresentationError),
	/// Production agent composition failed.
	#[error("cleanse child session failed")]
	Session,
	/// The configured data directory or project state could not be opened.
	#[error("cleanse transcript authority could not be opened")]
	JournalOpen(#[source] ChatError),
	/// The session index could not be opened.
	#[error("failed to open cleanse session index")]
	SessionIndex(#[from] index::Error),
	/// A cleanse journal declaration or append failed.
	#[error("cleanse journal operation failed")]
	Journal(#[from] omp_agent::JournalError),
	/// A static journal revision was invalid.
	#[error("invalid cleanse journal revision")]
	Revision(#[from] omp_tool::RevParseError),
	/// A journal payload could not be encoded.
	#[error("failed to encode cleanse journal payload")]
	Json(#[from] serde_json::Error),
	/// The command has no configured model.
	#[error("cleanse requires a configured model")]
	MissingModel,
}

/// Production owner for one standalone cleanse run.
pub struct ProductionCleanseHost {
	root:         PathBuf,
	files:        Vec<PathBuf>,
	data_dir:     PathBuf,
	resolver:     FilesystemResolver,
	journal:      Mutex<Journal>,
	presentation: Arc<dyn CleansePresentation>,
}

impl ProductionCleanseHost {
	/// Opens checker discovery and a durable parent transcript for one run.
	pub fn open(
		root: PathBuf,
		data_dir: PathBuf,
		presentation: Arc<dyn CleansePresentation>,
	) -> Result<Self, ProductionError> {
		let root = chat::canonical_project(&root).map_err(ProductionError::JournalOpen)?;
		let files = scan_project_files(&root)
			.map_err(|source| ProductionError::Scan { root: root.clone(), source })?;
		let state_dir = omp_env::project_state::directory(&data_dir, &root)
			.map_err(|_| ProductionError::Session)?;
		chat::ensure_state_directory(&state_dir).map_err(ProductionError::JournalOpen)?;
		let sessions_dir = state_dir.join("sessions");
		chat::ensure_state_directory(&sessions_dir).map_err(ProductionError::JournalOpen)?;
		let index = Arc::new(SessionIndex::open(state_dir.join("sessions.sqlite3"))?);
		let id = Str::from(omp_core::Ulid::generate().to_string());
		let mut journal = chat::create_indexed_journal(
			&sessions_dir.join(format!("{}.jsonl", id.as_str())),
			&root,
			&id,
			index,
			SessionKind::Interactive,
			None,
		)
		.map_err(ProductionError::JournalOpen)?;
		journal.declare_entry_kinds(JOURNAL_EXTENSION, [EntryKindDecl::parse(
			JOURNAL_KIND,
			JOURNAL_REVISION,
			false,
			false,
			None,
		)?])?;
		Ok(Self {
			root,
			files,
			data_dir,
			resolver: FilesystemResolver,
			journal: Mutex::new(journal),
			presentation,
		})
	}

	async fn child_session(
		&self,
		name: &str,
		model: &str,
		schema_name: &'static str,
		schema: serde_json::Value,
		prompt: Str,
		cancel: &CancellationToken,
	) -> Result<RepairOutcome, ProductionError> {
		let mut session = HeadlessSession::open(self.data_dir.clone(), HeadlessSessionOptions {
			project:               self.root.clone(),
			settings_overlays:     Box::new([]),
			additional_roots:      Box::new([]),
			model:                 Str::new(model),
			initial_regime:        None,
			initial_prompt_slot:   None,
			plan_handoff:          None,
			resume:                None,
			fork:                  None,
			py_eval:               false,
			approval_mode:         None,
			spawn_idle_timeout:    None,
			pty_denied:            false,
			credential_provider:   None,
			api_key:               None,
			prompt_cache_affinity: None,
			account_pins:          None,
			session_generation:    1,
		})
		.await
		.map_err(|_| ProductionError::Session)?;
		session.set_response_schema(schema_name, schema)?;
		session
			.set_title(Str::new(name))
			.await
			.map_err(|_| ProductionError::Session)?;
		let interrupt = session.interrupt_handle();
		let submitted = tokio::select! {
			result = session.submit(
				[message(Role::System, "You are a bounded cleanse worker. Obey the assignment exactly and return only the required JSON."), message(Role::User, prompt.as_str())],
				TurnId::new(format!("cleanse-{}", omp_core::Ulid::generate())),
			) => Some(result),
			() = cancel.cancelled() => {
				interrupt.interrupt();
				None
			},
		};
		let outcome = match submitted {
			Some(Ok(summary)) => RepairOutcome {
				name:    Str::new(name),
				success: !summary.interrupted && summary.final_assistant().is_some(),
				output:  summary.final_assistant().map_or_else(|| sf!(""), Str::new),
			},
			Some(Err(_)) => {
				session.dispose().await;
				return Err(ProductionError::Session);
			},
			None => {
				RepairOutcome { name: Str::new(name), success: false, output: sf!("cancelled") }
			},
		};
		session.dispose().await;
		Ok(outcome)
	}

	async fn repair_session(
		&self,
		name: &str,
		model: &str,
		prompt: Str,
		followups: flume::Receiver<Vec<super::Diagnostic>>,
		cancel: &CancellationToken,
	) -> Result<RepairOutcome, ProductionError> {
		let mut session = HeadlessSession::open(self.data_dir.clone(), HeadlessSessionOptions {
			project:               self.root.clone(),
			settings_overlays:     Box::new([]),
			additional_roots:      Box::new([]),
			model:                 Str::new(model),
			initial_regime:        None,
			initial_prompt_slot:   None,
			plan_handoff:          None,
			resume:                None,
			fork:                  None,
			py_eval:               false,
			approval_mode:         None,
			spawn_idle_timeout:    None,
			pty_denied:            false,
			credential_provider:   None,
			api_key:               None,
			prompt_cache_affinity: None,
			account_pins:          None,
			session_generation:    1,
		})
		.await
		.map_err(|_| ProductionError::Session)?;
		session.set_response_schema("cleanse_repair", repair_schema())?;
		session
			.set_title(Str::new(name))
			.await
			.map_err(|_| ProductionError::Session)?;
		let mut items = vec![
			message(
				Role::System,
				"You are a bounded cleanse worker. Obey the assignment exactly and return only the \
				 required JSON.",
			),
			message(Role::User, prompt.as_str()),
		];
		let mut final_output = sf!("");
		let mut success = true;
		loop {
			let Some((summary, mut pending)) =
				submit_repair_turn(&mut session, items, &followups, cancel).await?
			else {
				success = false;
				final_output = sf!("cancelled");
				break;
			};
			success &= !summary.interrupted && summary.final_assistant().is_some();
			if let Some(output) = summary.final_assistant() {
				final_output = Str::new(output);
			}
			pending.extend(followups.try_iter().flatten());
			if pending.is_empty() {
				break;
			}
			items = vec![message(Role::User, followup_prompt(&pending).as_str())];
		}
		drop(followups);
		session.dispose().await;
		Ok(RepairOutcome { name: Str::new(name), success, output: final_output })
	}
}

async fn submit_repair_turn(
	session: &mut HeadlessSession,
	items: Vec<Item>,
	followups: &flume::Receiver<Vec<super::Diagnostic>>,
	cancel: &CancellationToken,
) -> Result<Option<(AgentRunSummary, Vec<super::Diagnostic>)>, ProductionError> {
	let interrupt = session.interrupt_handle();
	let submitted =
		session.submit(items, TurnId::new(format!("cleanse-{}", omp_core::Ulid::generate())));
	tokio::pin!(submitted);
	let mut pending = Vec::new();
	let mut receiver_open = true;
	let summary = loop {
		tokio::select! {
			result = &mut submitted => break Some(result),
			batch = followups.recv_async(), if receiver_open => {
				match batch {
					Ok(batch) => pending.extend(batch),
					Err(_) => receiver_open = false,
				}
			},
			() = cancel.cancelled() => {
				interrupt.interrupt();
				break None;
			},
		}
	};
	match summary {
		Some(Ok(summary)) => Ok(Some((summary, pending))),
		Some(Err(_)) => Err(ProductionError::Session),
		None => Ok(None),
	}
}

impl BinaryResolver for ProductionCleanseHost {
	fn resolve(&self, project_root: &Path, manifest_root: &Path, names: &[&str]) -> Option<PathBuf> {
		self.resolver.resolve(project_root, manifest_root, names)
	}
}

impl CheckerRunner for ProductionCleanseHost {
	type Error = ProductionError;

	fn run_checker(
		&self,
		checker: &Checker,
		cancel: &CancellationToken,
		partials: Option<flume::Sender<ProcessOutput>>,
	) -> impl Future<Output = Result<ProcessOutput, Self::Error>> + Send {
		let checker = checker.clone();
		let cancel = cancel.clone();
		async move { run_checker_process(&checker, &cancel, partials).await }
	}
}

async fn run_checker_process(
	checker: &Checker,
	cancel: &CancellationToken,
	partials: Option<flume::Sender<ProcessOutput>>,
) -> Result<ProcessOutput, ProductionError> {
	let mut command = Command::new(&checker.binary);
	command.args(checker.args.iter().map(Str::as_str));
	command
		.current_dir(&checker.cwd)
		.kill_on_drop(true)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	let mut child = command
		.spawn()
		.map_err(|source| ProductionError::Checker { binary: checker.binary.clone(), source })?;
	let stdout = child.stdout.take().expect("piped checker stdout");
	let stderr = child.stderr.take().expect("piped checker stderr");
	let (stream_tx, stream_rx) = flume::unbounded();
	let stdout_task = tokio::spawn(pump_checker_stream(stdout, true, stream_tx.clone()));
	let stderr_task = tokio::spawn(pump_checker_stream(stderr, false, stream_tx));
	let mut stdout = Vec::new();
	let mut stderr = Vec::new();
	let mut streams = 2_u8;
	let mut status = None;
	let mut interval = tokio::time::interval(Duration::from_secs(5));
	interval.tick().await;
	while status.is_none() || streams > 0 {
		tokio::select! {
			() = cancel.cancelled(), if status.is_none() => {
				let _ = child.kill().await;
				status = Some(None);
			},
			result = child.wait(), if status.is_none() => {
				status = Some(
					result
						.map_err(|source| ProductionError::Checker {
							binary: checker.binary.clone(),
							source,
						})?
						.code(),
				);
			},
			event = stream_rx.recv_async(), if streams > 0 => {
				match event {
					Ok(CheckerStream::Stdout(bytes)) => stdout.extend(bytes),
					Ok(CheckerStream::Stderr(bytes)) => stderr.extend(bytes),
					Ok(CheckerStream::Done) => streams = streams.saturating_sub(1),
					Ok(CheckerStream::Error(source)) => {
						return Err(ProductionError::Checker {
							binary: checker.binary.clone(),
							source,
						});
					},
					Err(_) => streams = 0,
				}
			},
			_ = interval.tick(), if partials.is_some() && status.is_none() => {
				if let Some(sender) = partials.as_ref() {
					let _ = sender.send(ProcessOutput {
						exit_code: None,
						stdout: complete_lines(&stdout),
						stderr: complete_lines(&stderr),
					});
				}
			},
		}
	}
	let _ = stdout_task.await;
	let _ = stderr_task.await;
	if cancel.is_cancelled() {
		return Ok(ProcessOutput {
			exit_code: None,
			stdout:    sf!(""),
			stderr:    sf!("cancelled"),
		});
	}
	Ok(ProcessOutput {
		exit_code: status.flatten(),
		stdout:    Str::from(String::from_utf8_lossy(&stdout).as_ref()),
		stderr:    Str::from(String::from_utf8_lossy(&stderr).as_ref()),
	})
}

enum CheckerStream {
	Stdout(Vec<u8>),
	Stderr(Vec<u8>),
	Error(io::Error),
	Done,
}

async fn pump_checker_stream(
	mut stream: impl AsyncRead + Unpin + Send + 'static,
	stdout: bool,
	sender: flume::Sender<CheckerStream>,
) {
	let mut buffer = [0_u8; 8_192];
	loop {
		match stream.read(&mut buffer).await {
			Ok(0) => break,
			Err(error) => {
				let _ = sender.send_async(CheckerStream::Error(error)).await;
				return;
			},
			Ok(read) => {
				let bytes = buffer[..read].to_vec();
				let event = if stdout {
					CheckerStream::Stdout(bytes)
				} else {
					CheckerStream::Stderr(bytes)
				};
				if sender.send_async(event).await.is_err() {
					return;
				}
			},
		}
	}
	let _ = sender.send_async(CheckerStream::Done).await;
}

fn complete_lines(bytes: &[u8]) -> Str {
	let Some(cut) = bytes.iter().rposition(|byte| *byte == b'\n') else {
		return sf!("");
	};
	Str::from(String::from_utf8_lossy(&bytes[..=cut]).as_ref())
}

impl CleanseHost for ProductionCleanseHost {
	fn project_root(&self) -> &Path {
		&self.root
	}

	fn project_files(&self) -> &[PathBuf] {
		&self.files
	}

	fn pick_target(
		&self,
		checkers: &[Checker],
		cancel: &CancellationToken,
	) -> impl Future<Output = Result<TargetChoice, Self::Error>> {
		let presentation = Arc::clone(&self.presentation);
		let checkers = checkers.to_vec();
		let cancel = cancel.clone();
		async move {
			presentation
				.pick_target(&checkers, &cancel)
				.await
				.map_err(ProductionError::Presentation)
		}
	}

	fn prompt_request(
		&self,
		cancel: &CancellationToken,
	) -> impl Future<Output = Result<Option<Str>, Self::Error>> {
		let presentation = Arc::clone(&self.presentation);
		let cancel = cancel.clone();
		async move {
			presentation
				.prompt_request(&cancel)
				.await
				.map_err(ProductionError::Presentation)
		}
	}

	fn discover_custom(
		&self,
		request: &str,
		model: &str,
		cancel: &CancellationToken,
	) -> impl Future<Output = Result<Str, Self::Error>> + Send {
		let request = Str::new(request);
		let model = Str::new(model);
		async move {
			let prompt = Str::from(format!(
				"Read project manifests and configs, determine exact argv commands that detect: \
				 {request}. Run each candidate once without editing. Return only the \
				 schema-constrained checker array; argv must never use a shell wrapper."
			));
			let outcome = self
				.child_session(
					"CleanseDiscovery",
					model.as_str(),
					"cleanse_discovery",
					discovery_schema(),
					prompt,
					cancel,
				)
				.await?;
			Ok(outcome.output)
		}
	}

	fn repair_worker(
		&self,
		assignment: Assignment,
		worker: usize,
		peers: Vec<Assignment>,
		model: &str,
		followups: flume::Receiver<Vec<super::Diagnostic>>,
		cancel: &CancellationToken,
	) -> impl Future<Output = Result<RepairOutcome, Self::Error>> + Send {
		let model = Str::new(model);
		async move {
			let name = format!("CleanseA{worker}");
			let prompt = assignment_prompt(&assignment, worker, &peers);
			self
				.repair_session(&name, model.as_str(), prompt, followups, cancel)
				.await
		}
	}

	fn journal_remainder(&self, report: &Report) -> Result<(), Self::Error> {
		let data = to_raw_value(&serde_json::json!({
			"checks": report.checks.len(),
			"diagnostics": report.diagnostics,
			"skipped": report.skipped.iter().map(|item| serde_json::json!({
				"label": item.label,
				"language": item.language,
				"reason": item.reason,
			})).collect::<Vec<_>>(),
		}))?;
		let request_id = sf!("cleanse-remainder-{}", omp_core::Ulid::generate());
		let mut journal = self.journal.lock();
		journal.handle_request(JournalRequest {
			ts:        now_ms(),
			stamp:     JournalRequestStamp {
				request_id:         request_id.clone(),
				idempotency_key:    request_id,
				host_generation:    0,
				session_generation: 0,
			},
			author:    JournalAuthor {
				principal:  Principal::new(sf!("omp.core"), sf!("OMP Core")),
				provenance: Provenance::new(
					sf!("omp"),
					sf!(JOURNAL_EXTENSION),
					sf!(env!("CARGO_PKG_VERSION")),
					ArtifactDigest::new([0; 32]),
					sf!("core"),
					sf!("builtin"),
					0,
				),
			},
			operation: JournalOperation::Append(PendingCustomEntry {
				kind:    sf!(JOURNAL_KIND),
				rev:     sf!(JOURNAL_REVISION),
				data:    Some(data),
				context: None,
				display: Some(false),
			}),
		})?;
		Ok(())
	}
}

fn followup_prompt(diagnostics: &[super::Diagnostic]) -> Str {
	let mut text = String::from(
		"Additional diagnostics were reported for files you own. Fix these too before finishing:\n",
	);
	for diagnostic in diagnostics {
		use std::fmt::Write as _;
		let _ = writeln!(
			text,
			"- {}:{}:{} {:?}: {}",
			diagnostic.file.as_deref().unwrap_or("<project>"),
			diagnostic.line.unwrap_or(0),
			diagnostic.column.unwrap_or(0),
			diagnostic.severity,
			diagnostic.message,
		);
	}
	Str::from(text)
}

fn repair_schema() -> serde_json::Value {
	serde_json::json!({
		"type": "object",
		"additionalProperties": false,
		"required": ["success", "summary"],
		"properties": {
			"success": {"type": "boolean"},
			"summary": {"type": "string"}
		}
	})
}

fn message(role: Role, text: &str) -> Item {
	Item {
		kind: Some(item::Kind::Message(Message {
			role: role as i32,
			parts: vec![Part { kind: Some(part::Kind::Text(text.to_owned())), ..Part::default() }],
			..Message::default()
		})),
		..Item::default()
	}
}

fn now_ms() -> u64 {
	time::SystemTime::now()
		.duration_since(time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}
#[cfg(test)]
mod tests {
	use std::env;

	use super::*;

	#[tokio::test]
	async fn production_process_owner_executes_exact_argv() {
		fn assert_host<H: CleanseHost>() {}
		assert_host::<ProductionCleanseHost>();
		let checker = Checker {
			id:       sf!("self-list"),
			label:    sf!("test harness list"),
			language: sf!("Rust"),
			cwd:      env::current_dir().expect("test cwd"),
			binary:   env::current_exe().expect("test executable"),
			args:     vec![sf!("--list")],
			parser:   ParserKind::Generic,
			effect:   CheckerEffect::ReadOnly,
			test:     false,
		};
		let output = run_checker_process(&checker, &CancellationToken::new(), None)
			.await
			.expect("checker process");
		assert_eq!(output.exit_code, Some(0));
		assert!(
			output
				.stdout
				.contains("production_process_owner_executes_exact_argv")
		);
	}
}
