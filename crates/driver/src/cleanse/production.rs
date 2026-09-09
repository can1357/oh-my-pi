//! Production checker execution and journal-first repair composition.

use std::{
	future::Future,
	path::{Path, PathBuf},
	pin::Pin,
	process::Stdio,
	sync::Arc,
};

use omp_core::{Str, sf};
use omp_dom::{NodeSpec, Op, Tag, Txn};
use omp_session::{ComponentRegistry, Session};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::{
	Assignment, BinaryResolver, Checker, CheckerRunner, CleanseHost, FilesystemResolver,
	ProcessOutput, RepairOutcome, Report, TargetChoice, assignment_prompt, discovery_schema,
	scan_project_files,
};

/// Boxed presentation failure retained as a typed UI boundary.
pub type PresentationError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// Presentation-owned target and free-form request collection.
pub trait CleansePresentation: Send + Sync + 'static {
	/// Selects one checker, all checkers, or a custom request.
	fn pick_target<'a>(
		&'a self,
		checkers: &'a [Checker],
		cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<TargetChoice, PresentationError>> + 'a>>;
	/// Collects a custom request.
	fn prompt_request<'a>(
		&'a self,
		cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<Option<Str>, PresentationError>> + 'a>>;
}

/// Production cleanse failure.
#[derive(Debug, thiserror::Error)]
pub enum ProductionError {
	/// Project path or process I/O failed.
	#[error("cleanse I/O failed")]
	Io(#[from] std::io::Error),
	/// Presentation failed.
	#[error("cleanse presentation failed")]
	Presentation(#[source] PresentationError),
	/// Kernel composition failed.
	#[error("cleanse child composition failed")]
	Headless(#[from] crate::headless::HeadlessError),
	/// Kernel turn failed.
	#[error("cleanse child turn failed")]
	Kernel(#[from] omp_agent::KernelError),
	/// Durable remainder projection failed.
	#[error("cleanse journal failed")]
	Session(#[from] omp_session::SessionError),
	/// JSON projection failed.
	#[error("cleanse JSON failed")]
	Json(#[from] serde_json::Error),
}

/// Production owner for one standalone cleanse run.
pub struct ProductionCleanseHost {
	root:         PathBuf,
	files:        Vec<PathBuf>,
	data_dir:     PathBuf,
	resolver:     FilesystemResolver,
	journal:      parking_lot::Mutex<Session>,
	presentation: Arc<dyn CleansePresentation>,
}

impl ProductionCleanseHost {
	/// Opens checker discovery and a journal-first parent session.
	pub fn open(
		root: PathBuf,
		data_dir: PathBuf,
		presentation: Arc<dyn CleansePresentation>,
	) -> Result<Self, ProductionError> {
		let root = std::fs::canonicalize(root)?;
		let files = scan_project_files(&root).map_err(|source| std::io::Error::other(source))?;
		let state = omp_env::project_state::directory(&data_dir, &root)?;
		let sessions = state.join("sessions");
		std::fs::create_dir_all(&sessions)?;
		let path = sessions.join(format!("cleanse-{}.oms", omp_core::Ulid::generate()));
		let journal = Session::create(path, ComponentRegistry::standard())?;
		Ok(Self {
			root,
			files,
			data_dir,
			resolver: FilesystemResolver,
			journal: parking_lot::Mutex::new(journal),
			presentation,
		})
	}

	async fn run_child(
		&self,
		model: &str,
		prompt: Str,
		cancel: &CancellationToken,
	) -> Result<Str, ProductionError> {
		let ctx = Arc::new(omp_con::Ctx::new());
		let (mut kernel, mut session, _) = crate::headless::compose_kernel(
			&self.data_dir,
			&self.root,
			model,
			ctx,
			crate::headless::KernelOptions { ephemeral: true, ..Default::default() },
		)
		.await?;
		let outcome = kernel
			.run_turn(
				&mut session,
				omp_agent::TurnInput { text: prompt, attachments: Vec::new() },
				omp_agent::RunControl::new(cancel.clone(), None),
			)
			.await?;
		Ok(outcome.assistant_text)
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
		async move {
			let mut child = Command::new(&checker.binary);
			child
				.args(checker.args.iter().map(Str::as_str))
				.current_dir(&checker.cwd)
				.kill_on_drop(true)
				.stdout(Stdio::piped())
				.stderr(Stdio::piped());
			let output = tokio::select! {
				result = child.output() => result?,
				() = cancel.cancelled() => return Ok(ProcessOutput { exit_code: None, stdout: sf!(""), stderr: sf!("cancelled") }),
			};
			let result = ProcessOutput {
				exit_code: output.status.code(),
				stdout:    Str::new(String::from_utf8_lossy(&output.stdout)),
				stderr:    Str::new(String::from_utf8_lossy(&output.stderr)),
			};
			if let Some(partials) = partials {
				let _ = partials.send(result.clone());
			}
			Ok(result)
		}
	}
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
			let prompt = Str::new(format!(
				"Discover exact checker argv for this project request: {request}. Return only JSON \
				 matching this schema: {}",
				discovery_schema()
			));
			self.run_child(model.as_str(), prompt, cancel).await
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
			let mut prompt = assignment_prompt(&assignment, worker, &peers).to_string();
			for batch in followups.try_iter() {
				prompt.push_str("\n");
				prompt.push_str(&format!("Additional diagnostics: {batch:?}"));
			}
			let output = self
				.run_child(model.as_str(), Str::new(prompt), cancel)
				.await?;
			Ok(RepairOutcome {
				name: Str::new(format!("CleanseA{worker}")),
				success: !output.is_empty(),
				output,
			})
		}
	}

	fn journal_remainder(&self, report: &Report) -> Result<(), Self::Error> {
		let mut session = self.journal.lock();
		let cause = session
			.head()
			.ok_or(omp_session::SessionError::NoActiveTurn)?;
		let data = serde_json::value::to_raw_value(&format!("{report:?}"))?;
		let parent = session.dom().meta();
		let after = session.dom().children(parent).last().copied();
		session.patch(Txn {
			cause,
			label: Some(Str::new_static("cleanse.remainder")),
			ops: vec![Op::Ins {
				parent,
				after,
				node: NodeSpec::new(Tag::Custom(Str::new_static("cleanse-remainder"))).with_prop(
					omp_dom::PropKey::Custom(Str::new_static("data")),
					omp_dom::Value::Json(data),
				),
			}],
		})?;
		Ok(())
	}
}
