//! Production posture resolution and phase dispatch.
//!
//! Agent and review phases run as restricted child kernels; code phases run
//! through the project Environment's exec authority, so the sandbox the
//! reported posture describes is the one that confines them. Both report a
//! [`PhaseResult`] the domain turns into a transition.
//!
//! A code phase runs a command the workspace's workflow declares, so it runs
//! only in a [`WorkspaceTrust::Trusted`] workspace: an untrusted one refuses
//! it ([`ProductionError::UntrustedWorkspace`]). Model phases' child kernels
//! run under the run's own decision.

use std::{
	fs, io,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use omp_adw::{
	ApprovalScope, NetworkScope, Phase, PhaseKind, Posture, Requirement, SelectedInput, WriteScope,
};
use omp_agent::delegated::{DenyAll, ExecutorId, TurnEnd};
use omp_contract::posture::{ApprovalMode, effective_approval_mode};
use omp_core::{Hash32, Str, StrMut, sf};
use omp_env::EnvClient;
use omp_envd::{
	admission::probe_sandbox,
	exec_settings::{ExecSandboxMode, NetworkConfinement, network_confinement},
	tool_settings::ToolSettings,
};
use omp_exec::{
	BackendId, Eligibility, EnvEntry, ExecutionBackend, ExecutionError, ExecutionEvent, ExecutionId,
	ExecutionRequest, ExecutionRun, Intent, NeedSet, OutputSpec, Platform, PlatformRequirement,
	ResourceRequirements, ToolchainId,
};
use omp_exec_local::{Config as LocalConfig, LocalBackend};
use omp_ext::workspace_trust::{TrustDecision, WorkspaceTrust};
use omp_session::{ComponentRegistry, Session, SessionError};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use super::{
	AdwHost, PhaseResult, PhaseSpec,
	remote::{AdwExecPolicy, AdwRemoteError, SV_EXEC_FALLBACK_LOCAL, SV_EXEC_POLICY, eligible},
};
use crate::{
	cfg::CfgFiles,
	cleanse::checkers::{BinaryResolver as _, FilesystemResolver},
	delegated_host::{DelegatedHostError, ExecutorRegistry, run_delegated_prompt},
	exec_composer::{REMOTE_POSTURE, RemoteError},
	headless::{HeadlessError, KernelOptions, compose_kernel, kernel::LaunchExtensionPolicy},
	verification::{
		CheckDisposition, CheckObservation, GateVerdict, NativeVerificationError,
		NativeVerificationSpec, VerificationPolicy, native_verification_posture,
		run_native_verification,
	},
	workspace_trust::WorkspaceTrustSource,
};

/// A phase that could not be executed.
#[derive(Debug, thiserror::Error)]
pub enum ProductionError {
	/// The project root could not be canonicalized, or a process failed.
	#[error("workflow host filesystem or process operation failed")]
	Io(#[from] io::Error),
	/// The project Environment that runs code phases could not start.
	#[error("workflow project environment could not start")]
	Environment(#[from] omp_envd::EnvdError),
	/// The unified local or remote execution backend failed.
	#[error("workflow execution backend failed")]
	Execution(#[source] ExecutionError),
	/// The Environment refused or lost a code phase's command.
	#[error("workflow project environment rejected a command")]
	Exec(#[from] omp_env::ClientError),
	/// A child kernel could not be composed.
	#[error("workflow child session composition failed")]
	Session(#[from] HeadlessError),
	/// A child turn failed.
	#[error("workflow child turn failed")]
	Turn(#[from] omp_agent::KernelError),
	/// A code phase named an executable `$PATH` does not hold.
	#[error("workflow phase executable `{binary}` was not found on PATH")]
	UnresolvedBinary {
		/// The unresolved executable name.
		binary: Str,
	},
	/// A code phase's working directory resolves outside the project, through
	/// a symbolic link the lexical definition check cannot see.
	#[error("workflow phase working directory `{cwd}` resolves outside the project")]
	CwdEscapes {
		/// The declared working directory.
		cwd: Str,
	},
	/// A path could not be expressed as an Environment location.
	#[error("workflow phase path is not a valid environment location")]
	Location(#[source] omp_core::LocationError),
	/// A code phase was dispatched in a workspace that is not trusted.
	#[error("workspace is not trusted; adw code phases are withheld")]
	UntrustedWorkspace,
	/// The remote-only backend or input capture failed.
	#[error("remote workflow code phase failed")]
	Remote(#[from] AdwRemoteError),
	/// A remote phase was interrupted and its best-effort cancel was requested.
	#[error("remote workflow code phase was cancelled")]
	Cancelled,
	/// A delegated executor could not run the phase's turn.
	#[error("delegated executor failed the workflow phase")]
	Delegated(#[from] DelegatedHostError),
	/// The journal of a delegated phase's turn could not be created.
	#[error("delegated phase journal could not be created")]
	DelegatedJournal(#[source] SessionError),
	/// A delegated turn ended without completing, so its answer is not a result.
	#[error("delegated executor did not complete the phase's turn")]
	DelegatedIncomplete,
	/// A phase that declares a posture requirement was routed to a delegated
	/// executor.
	#[error("a phase with a posture requirement cannot run on a delegated executor")]
	DelegatedRequirement,
	/// Native verification posture admission failed.
	#[error("native verification admission failed")]
	Verification(#[from] NativeVerificationError),
	/// A verification session journal could not be created.
	#[error("native verification journal could not be created")]
	VerificationJournal(#[source] SessionError),
	/// The exact phase requirements could not be encoded.
	#[error("native verification requirements could not be encoded")]
	VerificationRequirements(#[source] serde_json::Error),
}

impl From<RemoteError> for ProductionError {
	fn from(error: RemoteError) -> Self {
		Self::Remote(error.into())
	}
}

/// Production owner for one workflow run.
pub struct ProductionAdwHost {
	pub(super) root:      PathBuf,
	data_dir:             PathBuf,
	model:                Str,
	model_override:       bool,
	pub(super) ctx:       Arc<omp_con::Ctx>,
	resolver:             FilesystemResolver,
	/// The workspace trust decision the run executes under: code phases run
	/// only when it trusts, and model phases' child kernels inherit it.
	workspace_trust:      TrustDecision,
	/// The project Environment, started by the first code phase: a workflow
	/// of model phases alone never needs one of its own.
	environment:          OnceCell<omp_envd::ProjectEnvironment>,
	exec_policy_override: Option<AdwExecPolicy>,
	/// Verification observations collected from a prior verification phase,
	/// carried forward to subsequent phases for evidence-based judging.
	verification_observations: parking_lot::Mutex<Vec<CheckObservation>>,
}

impl ProductionAdwHost {
	/// Opens a host rooted at a canonical project directory, running under
	/// `workspace_trust`, the workspace's trust decision.
	///
	/// # Errors
	///
	/// Returns [`ProductionError`] when the project root cannot be resolved.
	pub fn open(
		root: PathBuf,
		data_dir: PathBuf,
		model: Str,
		model_override: bool,
		ctx: Arc<omp_con::Ctx>,
		workspace_trust: TrustDecision,
	) -> Result<Self, ProductionError> {
		Ok(Self {
			root: fs::canonicalize(root)?,
			data_dir,
			model,
			model_override,
			ctx,
			resolver: FilesystemResolver,
			workspace_trust,
			environment: OnceCell::new(),
			exec_policy_override: None,
			verification_observations: parking_lot::Mutex::new(Vec::new()),
		})
	}

	/// Overrides the operator's execution policy for this process only.
	pub fn with_exec_policy(mut self, policy: AdwExecPolicy) -> Self {
		self.exec_policy_override = Some(policy);
		self
	}

	/// The execution policy phases run under: the override, else
	/// `sv_exec_policy`.
	pub fn exec_policy(&self) -> AdwExecPolicy {
		self
			.exec_policy_override
			.unwrap_or_else(|| SV_EXEC_POLICY.get(&self.ctx))
	}

	/// Whether a remote-preferred phase falls back to local
	/// (`sv_exec_fallback_local`).
	pub fn exec_fallback_local(&self) -> bool {
		SV_EXEC_FALLBACK_LOCAL.get(&self.ctx)
	}

	/// Whether the workspace trust decision this host gates code phases on
	/// trusts the workspace.
	pub fn workspace_trusted(&self) -> bool {
		self.workspace_trust.trust() == WorkspaceTrust::Trusted
	}

	/// Opens the project Environment composition once and returns its owner.
	pub(super) async fn environment_owner(
		&self,
	) -> Result<&omp_envd::ProjectEnvironment, ProductionError> {
		self
			.environment
			.get_or_try_init(|| async {
				let state_dir = omp_env::project_state::directory(&self.data_dir, &self.root)?;
				fs::create_dir_all(&state_dir)?;
				omp_envd::ProjectEnvironment::attach(&self.root, &state_dir, omp_envd::AttachOptions {
					py_eval:            false,
					approval_mode:      None,
					trusted_extensions: Vec::new(),
					contributed_values: Vec::new(),
					con:                Arc::clone(&self.ctx),
					bridges:            omp_envd::RegistryBridges {
						content: omp_envd::ActiveContentInputs {
							workspace_trust: self.workspace_trust.trust(),
							..omp_envd::ActiveContentInputs::default()
						},
						..omp_envd::RegistryBridges::default()
					},
					spawn_idle_timeout: None,
					spawn_policy:       CfgFiles::new(Some(&self.root))
						.ok()
						.and_then(|files| files.daemon_policy(self.workspace_trust.trust()).ok()),
				})
				.await
				.map_err(ProductionError::from)
			})
			.await
	}

	/// The Environment client used by remote capture and other protocol calls.
	pub(super) async fn environment(&self) -> Result<&EnvClient, ProductionError> {
		Ok(self.environment_owner().await?.client())
	}

	async fn run_child(
		&self,
		prompt: Str,
		kind: PhaseKind,
		cancel: &CancellationToken,
	) -> Result<Str, ProductionError> {
		let (model, model_override) = self.model_phase_selector_for(kind);
		let _restore =
			(model_override && !self.model_override).then(|| RestoreModel::capture(&self.ctx));
		let (mut kernel, mut session, _) = compose_kernel(
			&self.data_dir,
			&self.root,
			model,
			Arc::clone(&self.ctx),
			child_kernel_options(&self.workspace_trust, model_override),
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

	/// Runs one model phase's turn on a delegated executor (ADR 0052 D6) and
	/// returns the agent's final text.
	///
	/// The turn is journaled under `<data dir>/adw/delegated` and kept.
	/// Permission prompts are denied: an ADW run has no approver (`DenyAll`),
	/// and the policy is the strictest one (see `run_delegated_prompt`). A turn
	/// that did not complete is an error, never a result.
	async fn run_delegated(
		&self,
		executor: &str,
		prompt: &Str,
		phase: &Phase,
		attempt: u32,
		cancel: &CancellationToken,
	) -> Result<Str, ProductionError> {
		let registry = ExecutorRegistry::from_ctx(&self.ctx);
		let journals = self.data_dir.join("adw").join("delegated");
		fs::create_dir_all(&journals)?;
		let stem: String = phase
			.name
			.as_str()
			.chars()
			.map(|c| {
				if c.is_ascii_alphanumeric() || c == '-' {
					c
				} else {
					'_'
				}
			})
			.collect();
		let stamp = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_millis());
		let path = journals.join(format!("{stem}-{attempt}-{stamp}.oms"));
		let mut session = Session::create(&path, ComponentRegistry::standard())
			.map_err(ProductionError::DelegatedJournal)?;
		let answer = run_delegated_prompt(
			&registry,
			&ExecutorId::new(executor),
			&self.root,
			prompt,
			DenyAll,
			cancel,
			&mut session,
		)
		.await?;
		if answer.report.end != TurnEnd::Completed {
			return Err(ProductionError::DelegatedIncomplete);
		}
		Ok(answer.text)
	}

	/// Chooses the selector and its explicitness for every model phase.
	///
	/// Resolution order: explicit `omp adw run --model`, inherited `ai_model`,
	/// then the `@smol` fallback selector.
	fn model_phase_selector(&self) -> (&str, bool) {
		(self.model.as_str(), self.model_override)
	}

	/// Chooses the selector for one phase of `kind`.
	///
	/// A `Review` phase judges another phase's output, so it runs on the
	/// `@judge` role rather than the producer's selector (ADR 0053 D2, D3). An
	/// explicit `--model` stays authoritative for every phase. The second value
	/// is whether the child kernel must apply the selector instead of the
	/// inherited `ai_model`.
	pub fn model_phase_selector_for(&self, kind: PhaseKind) -> (&str, bool) {
		if kind == PhaseKind::Review && !self.model_override {
			return ("@judge", true);
		}
		self.model_phase_selector()
	}

	async fn run_command(
		&self,
		phase: &Phase,
		binary: &str,
		args: &[Str],
		cwd: Option<&str>,
		cancel: &CancellationToken,
	) -> Result<PhaseResult, ProductionError> {
		let policy = self.exec_policy();
		// Remote-only: eligible phases must go remote; LocalRequired phases cannot.
		// Remote-preferred: eligible phases go remote first; on a fallback-eligible
		// pre-acceptance failure, retry local if sv_exec_fallback_local is on.
		// Local-preferred: local only (RemoteRequired dispatch is handled by the
		// adapter; at the driver level the binary is already resolved locally).
		// Local-only: always local.
		if matches!(policy, AdwExecPolicy::RemoteOnly | AdwExecPolicy::RemotePreferred)
			&& eligible(binary, args)
		{
			let result = self.run_remote(phase, args, cwd, cancel).await;
			match result {
				Ok(result) => return Ok(result),
				Err(ProductionError::Remote(AdwRemoteError::Remote(
					RemoteError::PreAcceptanceFailed(_),
				))) if policy == AdwExecPolicy::RemotePreferred
					&& SV_EXEC_FALLBACK_LOCAL.get(&self.ctx) =>
				{
					// Fall through to local execution.
				},
				Err(error) => return Err(error),
			}
		}
		let _directory = match cwd {
			Some(cwd) => {
				let directory = fs::canonicalize(self.root.join(cwd))?;
				if !directory.starts_with(&self.root) {
					return Err(ProductionError::CwdEscapes { cwd: Str::new(cwd) });
				}
				directory
			},
			None => self.root.clone(),
		};
		let resolved = self
			.resolver
			.resolve(&[binary])
			.ok_or_else(|| ProductionError::UnresolvedBinary { binary: Str::new(binary) })?;
		let environment = self.environment_owner().await?;
		let platform = local_platform();
		let backend = LocalBackend::new(LocalConfig {
			id: BackendId::new_static("local"),
			root: self.root.clone(),
			host: environment.exec_host(),
			platform,
			enforced: self.posture()?,
		});
		let mut argv = Vec::with_capacity(args.len() + 1);
		argv.push(Str::new(resolved.to_string_lossy()));
		argv.extend(args.iter().cloned());
		let request = ExecutionRequest {
			id:          ExecutionId::new(Str::from(omp_core::Ulid::generate().to_string())),
			intent:      Intent::Test,
			argv:        Arc::from(argv),
			cwd:         Str::new(cwd.unwrap_or("")),
			env:         Arc::<[EnvEntry]>::from([]),
			inputs:      None,
			outputs:     OutputSpec::Logs,
			toolchain:   ToolchainId::new_static("local"),
			caches:      Arc::from([]),
			platform:    PlatformRequirement {
				os:            platform.os,
				arch:          platform.arch,
				needs_network: false,
				needs:         NeedSet::new(),
			},
			requirement: phase.requires,
			resources:   ResourceRequirements::default(),
			eligibility: Eligibility::LocalPreferred,
			timeout:     Duration::from_secs(30 * 60),
		};
		let mut run = match backend.start(request).await {
			Ok(run) => run,
			Err(error) if matches!(&error, ExecutionError::Infrastructure { .. }) => {
				return Ok(PhaseResult {
					accepted: false,
					feedback: Str::new_static("command refused by the workspace sandbox"),
				});
			},
			Err(error) => return Err(ProductionError::Execution(error)),
		};
		let mut stdout = Vec::new();
		let mut stderr = Vec::new();
		loop {
			let event = tokio::select! {
				event = run.next_event() => event,
				() = cancel.cancelled() => {
					let _ = run.cancel().await;
					// Teardown is asynchronous; wait for the terminal event so no process
					// of the cancelled tree outlives the phase.
					let _ = tokio::time::timeout(CANCEL_TEARDOWN, async {
						while let Some(event) = run.next_event().await {
							if matches!(event, ExecutionEvent::Settled(_)) {
								break;
							}
						}
					})
					.await;
					return Ok(PhaseResult { accepted: false, feedback: sf!("cancelled") });
				},
			};
			match event {
				Some(ExecutionEvent::Output(frame)) => match frame.stream {
					omp_exec::Stream::Stdout | omp_exec::Stream::Combined => {
						stdout.extend_from_slice(&frame.bytes)
					},
					omp_exec::Stream::Stderr => stderr.extend_from_slice(&frame.bytes),
				},
				Some(ExecutionEvent::Settled(Ok(result))) if result.outcome.is_success() => {
					return Ok(PhaseResult { accepted: true, feedback: Str::empty() });
				},
				Some(ExecutionEvent::Settled(Ok(result))) => {
					let mut feedback =
						StrMut::new(format!("`{binary}` ended with {:?}\n", result.outcome));
					feedback.push_str(&String::from_utf8_lossy(&stdout));
					feedback.push_str(&String::from_utf8_lossy(&stderr));
					return Ok(PhaseResult { accepted: false, feedback: feedback.freeze() });
				},
				Some(ExecutionEvent::Settled(Err(error))) => {
					return Err(ProductionError::Execution(error));
				},
				Some(_) => {},
				None => {
					return Err(ProductionError::Execution(ExecutionError::Infrastructure {
						source: Arc::new(io::Error::other("local execution ended without a result")),
					}));
				},
			}
		}
	}
}

/// Puts the `ai_model` a child run replaced back when the run ends, whatever
/// the outcome, so a review phase's `@judge` never becomes the next producer's
/// model. The driver runs one phase at a time, so the shared value is not
/// contended.
struct RestoreModel<'a> {
	ctx:      &'a omp_con::Ctx,
	previous: Str,
}

impl<'a> RestoreModel<'a> {
	fn capture(ctx: &'a omp_con::Ctx) -> Self {
		Self { ctx, previous: omp_agent::AI_MODEL.get(ctx) }
	}
}

impl Drop for RestoreModel<'_> {
	fn drop(&mut self) {
		let _ = omp_agent::AI_MODEL.set(self.ctx, self.previous.clone());
	}
}

/// Options for one model phase's child kernel, which inherits the run's
/// workspace trust decision.
///
/// Workspace-owned native extensions (`.omp/extensions`) are excluded: the
/// workflow is project input already, and a project must not also choose
/// the code its phases' kernels load.
fn child_kernel_options(workspace_trust: &TrustDecision, model_override: bool) -> KernelOptions {
	KernelOptions {
		ephemeral: true,
		model_override,
		extensions: LaunchExtensionPolicy {
			include_workspace: false,
			..LaunchExtensionPolicy::default()
		},
		workspace_trust: WorkspaceTrustSource::Fixed(workspace_trust.clone()),
		..KernelOptions::default()
	}
}

/// Longest a cancelled command phase may take to report its process tree gone.
const CANCEL_TEARDOWN: Duration = Duration::from_secs(10);

fn local_platform() -> Platform {
	#[cfg(target_arch = "aarch64")]
	let arch = omp_exec::Arch::Aarch64;
	#[cfg(not(target_arch = "aarch64"))]
	let arch = omp_exec::Arch::X86_64;
	#[cfg(target_os = "macos")]
	let os = omp_exec::Os::Macos;
	#[cfg(not(target_os = "macos"))]
	let os = omp_exec::Os::Linux;
	Platform { os, arch }
}
impl AdwHost for ProductionAdwHost {
	type Error = ProductionError;

	fn project_root(&self) -> &Path {
		&self.root
	}

	fn phase_posture(&self, _phase: &Phase, spec: &PhaseSpec) -> Result<Posture, Self::Error> {
		if matches!(spec, PhaseSpec::Verification(_)) {
			return Ok(native_verification_posture(&self.root)?);
		}
		if let PhaseSpec::Command { binary, args, .. } = spec
			&& self.exec_policy() == AdwExecPolicy::RemoteOnly
			&& eligible(binary, args)
		{
			return Ok(REMOTE_POSTURE);
		}
		self.posture()
	}

	fn posture(&self) -> Result<Posture, Self::Error> {
		let sandbox = probe_sandbox(&self.ctx, &self.root);
		let mode = omp_envd::exec_settings::SV_SANDBOX_MODE.get(&self.ctx);
		// A requested sandbox that was not constructed confines nothing, so the
		// posture is the host's, not the convar's.
		let unconfined = mode != ExecSandboxMode::Off && !sandbox.confines();
		Ok(Posture {
			write:    match mode {
				_ if unconfined => WriteScope::Unconfined,
				ExecSandboxMode::ReadOnly => WriteScope::ReadOnly,
				ExecSandboxMode::WorkspaceWrite => WriteScope::WorkspaceWrite,
				ExecSandboxMode::Off => WriteScope::Unconfined,
			},
			// The confinement shell sessions are configured for: a defaulted
			// network mode does not sandbox an explicit `off`, and an unconstructed
			// sandbox confines nothing. A session whose broker could not start, and
			// eval cells and detached processes, run `disabled`.
			network:  match network_confinement(&self.ctx, sandbox) {
				NetworkConfinement::Unconfined => NetworkScope::Unrestricted,
				NetworkConfinement::Disabled => NetworkScope::Disabled,
				NetworkConfinement::Scoped => NetworkScope::Scoped,
			},
			// The session's posture, reported as the loosest scope: a defaulted
			// `yolo` kept by an active sandbox covers only the tools that sandbox
			// confines (`bash`, `hub`); every other tool follows `write` per call
			// (`omp_contract::posture::resolve_approval`).
			approval: match effective_approval_mode(
				ToolSettings::from_con(&self.ctx)
					.with_workspace_trust(self.workspace_trust.trust())
					.configured_approval(),
				sandbox,
			) {
				ApprovalMode::AlwaysAsk => ApprovalScope::AlwaysAsk,
				ApprovalMode::Write => ApprovalScope::Write,
				ApprovalMode::Yolo => ApprovalScope::Yolo,
			},
		})
	}

	fn admit(&self, phase: &Phase, spec: &PhaseSpec) -> Result<(), Self::Error> {
		let trusted = self.workspace_trust.trust() == WorkspaceTrust::Trusted;
		match spec {
			PhaseSpec::Command { .. } | PhaseSpec::Verification(_) if !trusted => {
				Err(ProductionError::UntrustedWorkspace)
			},
			PhaseSpec::Prompt { executor: Some(_), .. }
				if phase.requires != Requirement::default() =>
			{
				Err(ProductionError::DelegatedRequirement)
			},
			PhaseSpec::Prompt { executor: Some(_), .. } if !trusted => {
				Err(ProductionError::UntrustedWorkspace)
			},
			PhaseSpec::Command { .. } | PhaseSpec::Verification(_) | PhaseSpec::Prompt { .. } => {
				Ok(())
			},
		}
	}

	async fn dispatch(
		&self,
		phase: &Phase,
		spec: &PhaseSpec,
		attempt: u32,
		correction: Option<&Str>,
		inputs: &[SelectedInput],
		cancel: &CancellationToken,
	) -> Result<PhaseResult, Self::Error> {
		match spec {
			PhaseSpec::Verification(spec) => {
				if self.workspace_trust.trust() != WorkspaceTrust::Trusted {
					return Err(ProductionError::UntrustedWorkspace);
				}
				let requirements = verification_requirements(phase, spec, inputs)?;
				let state =
					omp_env::project_state::directory(&self.data_dir, &self.root)?.join("verification");
				let journals = state.join("sessions");
				fs::create_dir_all(&journals)?;
				let stem: String = phase
					.name
					.as_str()
					.chars()
					.map(|c| {
						if c.is_ascii_alphanumeric() || c == '-' {
							c
						} else {
							'_'
						}
					})
					.collect();
				let path =
					journals.join(format!("{stem}-{attempt}-{}.oms", omp_core::Ulid::generate()));
				let mut session = Session::create(&path, ComponentRegistry::standard())
					.map_err(ProductionError::VerificationJournal)?;
				match run_native_verification(
					self.environment().await?,
					&mut session,
					&self.root,
					&state.join("runtime"),
					spec,
					requirements,
					cancel,
				)
				.await
				{
					Ok(report) => {
						// Store verification observations for subsequent phases.
						*self.verification_observations.lock() = report.observations;
						Ok(PhaseResult {
							accepted: report.verdict == GateVerdict::Pass,
							feedback: sf!("{}\nVerification journal: {}", report.feedback, path.display()),
						})
					},
					Err(_) => Ok(PhaseResult {
						accepted: false,
						feedback: sf!(
							"INCONCLUSIVE: native verification did not complete; inspect the retained \
							 session.\nVerification journal: {}",
							path.display()
						),
					}),
				}
			},
			PhaseSpec::Command { binary, args, cwd } => {
				self
					.run_command(phase, binary.as_str(), args, cwd.as_deref(), cancel)
					.await
			},
			PhaseSpec::Prompt { text, executor, accept_on_claim, .. } => {
				let prompt = phase_prompt(phase, text, attempt, correction, inputs);
				let answer = match executor {
					Some(id) => {
						let answer = self
							.run_delegated(id.as_str(), &prompt, phase, attempt, cancel)
							.await?;
						return Ok(judge_with_verification(
							phase.kind,
							answer,
							*accept_on_claim,
							&*self.verification_observations.lock(),
							None,
						));
					},
					None => self.run_child(prompt, phase.kind, cancel).await?,
				};
				Ok(judge_with_verification(
					phase.kind,
					answer,
					*accept_on_claim,
					&*self.verification_observations.lock(),
					None,
				))
			},
		}
	}
}

fn verification_requirements(
	phase: &Phase,
	spec: &NativeVerificationSpec,
	inputs: &[SelectedInput],
) -> Result<Hash32, ProductionError> {
	let bytes =
		serde_json::to_vec(&("omp.native-verification.requirements.v1", phase, spec, inputs))
			.map_err(ProductionError::VerificationRequirements)?;
	Ok(Hash32::sum(&bytes))
}

/// Composes the brief one model phase receives.
///
/// The attempt ordinal, the rejection that caused the retry, and the producer
/// versions consumed are all facts the child cannot otherwise observe: the
/// engine does not require a retry to reuse the rejected attempt's session.
fn phase_prompt(
	phase: &Phase,
	instruction: &Str,
	attempt: u32,
	correction: Option<&Str>,
	inputs: &[SelectedInput],
) -> Str {
	let mut text = StrMut::new(format!("Workflow phase `{}`.\n", phase.name.as_str()));
	if attempt > 1 {
		text.push_str(&format!("This is attempt {attempt}; a prior attempt was rejected.\n"));
	}
	if !inputs.is_empty() {
		text.push_str("Consuming: ");
		for (index, input) in inputs.iter().enumerate() {
			if index > 0 {
				text.push_str(", ");
			}
			text.push_str(&format!("`{}` v{}", input.phase.as_str(), input.version));
		}
		text.push('\n');
	}
	text.push('\n');
	text.push_str(instruction.as_str());
	if let Some(correction) = correction {
		text.push_str("\n\nCorrect this rejection:\n");
		text.push_str(correction.as_str());
	}
	if phase.kind == PhaseKind::Review {
		text.push_str(
			"\n\nAnswer with ACCEPT on its own first line when the work meets the bar, or REJECT \
			 followed by exactly what must change.",
		);
	}
	text.freeze()
}

/// Reads a model phase's verdict.
///
/// A review phase judges, so its answer is the verdict and an unparseable
/// answer is a rejection — a reviewer that did not say ACCEPT has not
/// accepted. A producing phase reports completion, so any answer stands.
fn judge(kind: PhaseKind, answer: Str) -> PhaseResult {
	if kind != PhaseKind::Review {
		return PhaseResult { accepted: true, feedback: Str::empty() };
	}
	if answer
		.as_str()
		.split_whitespace()
		.next()
		.is_some_and(|word| word.eq_ignore_ascii_case("accept"))
	{
		PhaseResult { accepted: true, feedback: Str::empty() }
	} else {
		PhaseResult { accepted: false, feedback: answer }
	}
}

#[cfg(test)]
fn judge_delegated(kind: PhaseKind, answer: Str) -> PhaseResult {
	if kind != PhaseKind::Review && answer.trim().is_empty() {
		return PhaseResult {
			accepted: false,
			feedback: Str::new_static(
				"The delegated executor returned no text, so the phase has no result.",
			),
		};
	}
	judge(kind, answer)
}

/// Verdict decision after evaluating a phase's evidence and completion claim.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VerdictDecision {
	/// The phase passed all gates or was accepted on claim.
	Accept,
	/// The phase failed a required gate or was rejected by the judge.
	Reject,
	/// Human approval is required.
	NeedsHuman,
}

/// Structured verdict from evaluating a phase.
#[allow(dead_code)]
#[derive(Clone, Debug)]
struct Verdict {
	/// The decision.
	decision:    VerdictDecision,
	/// Feedback explaining the decision.
	feedback:    Str,
	/// Whether the judge route differs from the producer route (independent
	/// review).
	independent: bool,
}

/// Judge a phase using verification evidence and the unverified-by-default
/// rule.
///
/// For phases with verification evidence, evaluates through the verification
/// policy. For phases without verification evidence, applies the
/// unverified-by-default rule: reject unless `accept_on_claim` is declared (ADR
/// 0053 O1). For Review phases, preserves the first-word parse but also
/// consults verification evidence if present.
fn judge_with_verification(
	kind: PhaseKind,
	answer: Str,
	accept_on_claim: bool,
	observations: &[CheckObservation],
	policy: Option<&VerificationPolicy>,
) -> PhaseResult {
	// Review phases still use first-word parse.
	if kind == PhaseKind::Review {
		return judge(kind, answer);
	}

	// If verification policy and evidence are available, evaluate deterministically.
	if let Some(policy) = policy {
		if let Ok(assessment) = policy.evaluate(observations) {
			return match assessment.verdict {
				GateVerdict::Pass => PhaseResult { accepted: true, feedback: Str::empty() },
				GateVerdict::Fail => {
					let failed: Vec<&str> = assessment
						.checks
						.iter()
						.filter(|c| matches!(c.disposition, CheckDisposition::Failed { .. }))
						.map(|c| c.id.as_str())
						.collect();
					PhaseResult {
						accepted: false,
						feedback: sf!(
							"Verification failed. Failed checks: {}",
							failed.join(", ")
						),
					}
				},
				GateVerdict::Inconclusive => {
					let inconclusive: Vec<&str> = assessment
						.checks
						.iter()
						.filter(|c| matches!(c.disposition, CheckDisposition::Inconclusive(_)))
						.map(|c| c.id.as_str())
						.collect();
					PhaseResult {
						accepted: false,
						feedback: sf!(
							"Verification inconclusive. Checks: {}",
							inconclusive.join(", ")
						),
					}
				},
			};
		}
	}

	// For producing Agent phases, apply unverified-by-default rule.
	// If the phase declares accept_on_claim, accept on completion claim.
	// Otherwise, reject because there's no verification evidence.
	if accept_on_claim {
		// Accept on completion claim — the phase explicitly opted out of verification.
		return PhaseResult { accepted: true, feedback: Str::empty() };
	}

	// Unverified-by-default: reject phases without verification evidence.
	PhaseResult {
		accepted: false,
		feedback: Str::new_static(
			"Phase has no verification evidence and does not declare accept_on_claim. Unverified \
			 phases are rejected by default (ADR 0053 O1).",
		),
	}
}

#[cfg(test)]
mod tests {
	use std::{env, iter, os::unix::fs::PermissionsExt as _};

	use omp_adw::{PhaseName, PostureError};
	use omp_core::sf;
	use omp_envd::exec_settings::{SV_SANDBOX_MODE, SV_SANDBOX_NETWORK_MODE, SandboxNetworkMode};
	use omp_ext::trust::GrantDuration;

	use super::{super::definition, *};

	const TRUSTED: TrustDecision = TrustDecision::Trusted { duration: GrantDuration::Persistent };

	fn verification_spec() -> NativeVerificationSpec {
		serde_json::from_str(r#"{"packages":["omp-core"]}"#).expect("native specification")
	}

	#[test]
	fn native_verification_requires_trust_without_changing_prompt_admission() {
		let project = tempfile::tempdir().expect("project");
		let phase = Phase::new(PhaseName::new_static("verify"), PhaseKind::Code);
		let spec = PhaseSpec::Verification(verification_spec());
		for decision in [TrustDecision::Untrusted, TrustDecision::Denied] {
			let host = host_under(project.path(), omp_con::Ctx::new(), decision);
			assert!(matches!(host.admit(&phase, &spec), Err(ProductionError::UntrustedWorkspace)));
			assert!(
				host
					.admit(&phase, &PhaseSpec::Prompt {
						text:            sf!("legacy"),
						executor:        None,
						accept_on_claim: false,
					})
					.is_ok()
			);
		}
		assert!(
			host(project.path(), omp_con::Ctx::new())
				.admit(&phase, &spec)
				.is_ok()
		);
	}

	#[test]
	fn native_requirements_bind_phase_inventory_and_consumed_versions() {
		let phase = Phase::new(PhaseName::new_static("verify"), PhaseKind::Code);
		let spec = verification_spec();
		let inputs = [SelectedInput { phase: PhaseName::new_static("implement"), version: 1 }];
		let key = verification_requirements(&phase, &spec, &inputs).unwrap();
		assert_eq!(key, verification_requirements(&phase, &spec, &inputs).unwrap());
		let newer = [SelectedInput { phase: PhaseName::new_static("implement"), version: 2 }];
		assert_ne!(key, verification_requirements(&phase, &spec, &newer).unwrap());
		let mut changed_spec = spec.clone();
		changed_spec.minimum_tests += 1;
		assert_ne!(key, verification_requirements(&phase, &changed_spec, &inputs).unwrap());
		let renamed = Phase::new(PhaseName::new_static("other"), PhaseKind::Code);
		assert_ne!(key, verification_requirements(&renamed, &spec, &inputs).unwrap());
	}

	fn host(project: &Path, ctx: omp_con::Ctx) -> ProductionAdwHost {
		host_under(project, ctx, TRUSTED)
	}

	fn host_under(project: &Path, ctx: omp_con::Ctx, trust: TrustDecision) -> ProductionAdwHost {
		ProductionAdwHost::open(
			project.to_path_buf(),
			project.join("data"),
			sf!("unused-model"),
			false,
			Arc::new(ctx),
			trust,
		)
		.expect("workflow host")
	}

	/// A user workflow phase that declares `requires.network = "disabled"`.
	fn offline_phase(project: &Path) -> Arc<Phase> {
		let directory = project.join(".omp/workflows");
		fs::create_dir_all(&directory).expect("workflow directory");
		fs::write(
			directory.join("offline.toml"),
			r#"
[[phase]]
name = "offline"
kind = "code"
command = ["true"]
requires = { network = "disabled" }
"#,
		)
		.expect("workflow file");
		let definition = definition::load(project, "offline").expect("definition");
		let phase = Arc::clone(&definition.workflow().phases()[0]);
		assert_eq!(phase.requires.network, Some(NetworkScope::Disabled));
		phase
	}

	#[test]
	fn posture_reports_the_network_commands_actually_get_when_the_sandbox_is_off() {
		let project = tempfile::tempdir().expect("project");
		// The probe never compiles mode `off`, so these hold on every host.
		let off = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&off, ExecSandboxMode::Off)
			.expect("sandbox off");
		let posture = host(project.path(), off).posture().expect("posture");
		assert_eq!(posture.write, WriteScope::Unconfined);
		assert_eq!(
			posture.network,
			NetworkScope::Unrestricted,
			"the shipped scoped network does not sandbox an explicit off"
		);

		let off_disabled = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&off_disabled, ExecSandboxMode::Off)
			.expect("sandbox off");
		SV_SANDBOX_NETWORK_MODE
			.set(&off_disabled, SandboxNetworkMode::Disabled)
			.expect("network disabled");
		assert_eq!(
			host(project.path(), off_disabled)
				.posture()
				.expect("posture")
				.network,
			NetworkScope::Unrestricted,
			"nothing enforces a disabled network while the sandbox is off"
		);

		let off_scoped = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&off_scoped, ExecSandboxMode::Off)
			.expect("sandbox off");
		SV_SANDBOX_NETWORK_MODE
			.set(&off_scoped, SandboxNetworkMode::Scoped)
			.expect("network scoped");
		assert_eq!(
			host(project.path(), off_scoped)
				.posture()
				.expect("posture")
				.network,
			NetworkScope::Scoped,
			"an explicit scoped network keeps its network-only sandbox"
		);
	}

	#[test]
	fn a_phase_requiring_no_network_is_refused_under_the_default_posture() {
		let project = tempfile::tempdir().expect("project");
		let phase = offline_phase(project.path());

		// Scoped where the default sandbox is constructed, unrestricted where it
		// is not: looser than `disabled` on every host.
		let posture = host(project.path(), omp_con::Ctx::new())
			.posture()
			.expect("posture");
		assert_ne!(posture.network, NetworkScope::Disabled);
		assert!(matches!(
			phase.requires.check(&phase.name, &posture),
			Err(PostureError::Network { required: NetworkScope::Disabled, .. })
		));

		let off = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&off, ExecSandboxMode::Off)
			.expect("sandbox off");
		let posture = host(project.path(), off).posture().expect("posture");
		assert!(matches!(
			phase.requires.check(&phase.name, &posture),
			Err(PostureError::Network {
				required: NetworkScope::Disabled,
				resolved: NetworkScope::Unrestricted,
				..
			})
		));
	}

	#[test]
	fn a_reviewer_that_did_not_say_accept_has_not_accepted() {
		assert!(judge(PhaseKind::Review, sf!("ACCEPT")).accepted);
		assert!(judge(PhaseKind::Review, sf!("  accept\nlooks good")).accepted);
		let rejected = judge(PhaseKind::Review, sf!("REJECT the tests are missing"));
		assert!(!rejected.accepted);
		assert_eq!(rejected.feedback, sf!("REJECT the tests are missing"));
		// An empty or off-script answer is not an acceptance.
		assert!(!judge(PhaseKind::Review, Str::empty()).accepted);
		assert!(!judge(PhaseKind::Review, sf!("acceptable with changes")).accepted);
		// A producing phase reports completion rather than a verdict.
		assert!(judge(PhaseKind::Agent, sf!("done")).accepted);
	}

	#[test]
	fn judge_with_verification_accepts_on_claim() {
		// A phase with accept_on_claim is accepted on its completion claim.
		let result = judge_with_verification(PhaseKind::Agent, sf!("done"), true, &[], None);
		assert!(result.accepted);
		assert!(result.feedback.is_empty());
	}

	#[test]
	fn judge_with_verification_rejects_unverified_phase() {
		// A phase without accept_on_claim is rejected (unverified-by-default).
		let result = judge_with_verification(PhaseKind::Agent, sf!("done"), false, &[], None);
		assert!(!result.accepted);
		assert!(result.feedback.contains("accept_on_claim"));
	}

	#[test]
	fn judge_with_verification_review_phase_uses_first_word() {
		// Review phases still use first-word parse regardless of accept_on_claim.
		assert!(judge_with_verification(PhaseKind::Review, sf!("ACCEPT"), false, &[], None).accepted);
		assert!(!judge_with_verification(PhaseKind::Review, sf!("REJECT"), false, &[], None).accepted);
		assert!(!judge_with_verification(PhaseKind::Review, Str::empty(), false, &[], None).accepted);
	}

	#[test]
	fn judge_with_verification_uses_policy_when_evidence_available() {
		// When a verification policy and observations are available, the judge
		// evaluates deterministically rather than falling through to unverified-by-default.
		use crate::verification::{CheckObservation, CheckOutcome, CheckRequirement, VerificationPolicy, VerificationScope};
		let scope = VerificationScope {
			inputs: Hash32::sum(b"test inputs"),
			policy: Hash32::sum(b"test policy"),
		};
		let policy = VerificationPolicy::new(scope, vec![CheckRequirement {
			id: Str::new_static("check-1"),
			required: true,
		}]).unwrap();
		let observations = [CheckObservation {
			id: Str::new_static("check-1"),
			scope,
			evidence: Some(Hash32::sum(b"evidence")),
			outcome: CheckOutcome::Passed,
		}];
		// A passing gate accepts the phase even without accept_on_claim.
		let result = judge_with_verification(PhaseKind::Agent, sf!("done"), false, &observations, Some(&policy));
		assert!(result.accepted, "passing gate should accept");
		assert!(result.feedback.is_empty());

		// A failing gate rejects the phase even with accept_on_claim.
		let failed_observations = [CheckObservation {
			id: Str::new_static("check-1"),
			scope,
			evidence: Some(Hash32::sum(b"failed evidence")),
			outcome: CheckOutcome::Failed,
		}];
		let result = judge_with_verification(PhaseKind::Agent, sf!("done"), true, &failed_observations, Some(&policy));
		assert!(!result.accepted, "failing gate should reject");
		assert!(result.feedback.contains("check-1"));
	}

	#[test]
	fn a_retry_brief_carries_the_rejection_and_consumed_versions() {
		let phase = Phase::new(PhaseName::new("review"), PhaseKind::Review);
		let inputs = [SelectedInput { phase: PhaseName::new("build"), version: 2 }];
		let prompt = phase_prompt(&phase, &sf!("Judge it."), 3, Some(&sf!("tests missing")), &inputs);
		let text = prompt.as_str();
		assert!(text.contains("attempt 3"));
		assert!(text.contains("`build` v2"));
		assert!(text.contains("Judge it."));
		assert!(text.contains("tests missing"));
		assert!(text.contains("ACCEPT"));

		let first = phase_prompt(&phase, &sf!("Judge it."), 1, None, &[]);
		assert!(!first.as_str().contains("attempt"));
		assert!(!first.as_str().contains("Consuming"));
	}

	/// Loads the single code phase of a workflow declaring `command`.
	fn code_phase(project: &Path, command: &[&str]) -> (Arc<Phase>, PhaseSpec) {
		let directory = project.join(".omp/workflows");
		fs::create_dir_all(&directory).expect("workflow directory");
		let argv = command
			.iter()
			.map(|word| format!("{word:?}"))
			.collect::<Vec<_>>()
			.join(", ");
		fs::write(
			directory.join("code.toml"),
			format!("[[phase]]\nname = \"code\"\nkind = \"code\"\ncommand = [{argv}]\n"),
		)
		.expect("workflow file");
		let definition = definition::load(project, "code").expect("definition");
		let phase = Arc::clone(&definition.workflow().phases()[0]);
		let spec = definition.spec(&phase.name).expect("spec").clone();
		(phase, spec)
	}

	fn script(path: &Path, body: &str) {
		fs::write(path, format!("#!/bin/sh\n{body}\n")).expect("script");
		fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("mode");
	}

	async fn dispatch(host: &ProductionAdwHost, phase: &Phase, spec: &PhaseSpec) -> PhaseResult {
		match host
			.dispatch(phase, spec, 1, None, &[], &CancellationToken::new())
			.await
		{
			Ok(result) => result,
			Err(ProductionError::Execution(ExecutionError::Infrastructure { .. })) => PhaseResult {
				accepted: false,
				feedback: Str::new_static("command refused by the workspace sandbox"),
			},
			Err(error) => panic!("dispatch: {error:?}"),
		}
	}

	/// A repository that commits an executable named `cargo` at its root (or
	/// in a package-manager bin) cannot shadow the operator's `cargo`.
	#[tokio::test]
	async fn a_repo_root_executable_does_not_shadow_path() {
		let project = tempfile::tempdir().expect("project");
		let project_root = project.path().canonicalize().expect("canonical project");
		let tools = tempfile::tempdir().expect("tools");
		script(&project_root.join("cargo"), "echo repo > shadowed");
		fs::create_dir_all(project_root.join("node_modules/.bin")).expect("bin");
		script(&project_root.join("node_modules/.bin/cargo"), "echo repo > shadowed");
		script(&tools.path().join("cargo"), "echo \"$1\" > path-cargo");
		let path = env::join_paths(
			iter::once(tools.path().to_path_buf())
				.chain(env::split_paths(&env::var_os("PATH").unwrap_or_default())),
		)
		.expect("PATH");
		// SAFETY: nextest runs each test in its own process; nothing else reads
		// the variable concurrently.
		unsafe { env::set_var("PATH", path) };
		let off = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&off, ExecSandboxMode::Off)
			.expect("sandbox off");
		let host = host(&project_root, off);
		let (phase, spec) = code_phase(&project_root, &["cargo", "it's"]);

		let result = dispatch(&host, &phase, &spec).await;
		assert!(result.accepted, "{}", result.feedback);
		assert!(!project_root.join("shadowed").exists(), "the repository's cargo ran");
		assert_eq!(
			fs::read_to_string(project_root.join("path-cargo")).expect("PATH cargo ran"),
			"it's\n",
			"arguments reach the program verbatim"
		);
	}

	/// A phase that declares `write = "workspace-write"` runs under the
	/// sandbox that posture reports: a write outside the workspace is
	/// refused, one inside it lands.
	#[tokio::test]
	async fn a_workspace_write_phase_cannot_write_outside_the_workspace() {
		let project = tempfile::tempdir().expect("project");
		let project_root = project.path().canonicalize().expect("canonical project");
		let outside = tempfile::tempdir().expect("outside");
		let escaped = outside
			.path()
			.canonicalize()
			.expect("outside")
			.join("escaped");
		let ctx = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&ctx, ExecSandboxMode::WorkspaceWrite)
			.expect("workspace-write");
		// The scratch directory lives under the temporary directories the
		// default grant makes writable.
		ctx.exec(
			"sv_sandbox_exclude_tmpdir 1\nsv_sandbox_exclude_slash_tmp 1\n",
			omp_con::Source::Config(sf!("test")),
		)
		.expect("temporary directories excluded");
		if !probe_sandbox(&ctx, &project_root).confines() {
			// No native sandbox on this host: posture reports `unconfined`, and
			// the domain refuses the phase before dispatch.
			return;
		}
		let host = host(&project_root, ctx);
		assert_eq!(host.posture().expect("posture").write, WriteScope::WorkspaceWrite);

		let directory = project_root.join(".omp/workflows");
		fs::create_dir_all(&directory).expect("workflow directory");
		fs::write(
			directory.join("contained.toml"),
			format!(
				"[[phase]]\nname = \"outside\"\nkind = \"code\"\ncommand = [\"touch\", \
				 {:?}]\nrequires = {{ write = \"workspace-write\" }}\n",
				escaped.to_string_lossy()
			),
		)
		.expect("workflow file");
		let definition = definition::load(&project_root, "contained").expect("definition");
		let phase = Arc::clone(&definition.workflow().phases()[0]);
		assert_eq!(phase.requires.write, Some(WriteScope::WorkspaceWrite));
		let spec = definition.spec(&phase.name).expect("spec");
		let refused = dispatch(&host, &phase, spec).await;
		assert!(!refused.accepted, "the write outside the workspace was accepted");
		assert!(!escaped.exists(), "the phase wrote outside the workspace");

		let (inside, spec) = code_phase(&project_root, &["touch", "inside"]);
		let landed = dispatch(&host, &inside, &spec).await;
		assert!(landed.accepted, "{}", landed.feedback);
		assert!(project_root.join("inside").exists());
	}

	/// A code phase runs a command the workspace declares: an untrusted
	/// workspace (any decision but `Trusted`) refuses it before resolving or
	/// running anything, and a trusted one runs the same phase.
	#[tokio::test]
	async fn an_untrusted_workspace_refuses_code_phases() {
		let project = tempfile::tempdir().expect("project");
		let project_root = project.path().canonicalize().expect("canonical project");
		let (phase, spec) = code_phase(&project_root, &["touch", "ran"]);
		let off = || {
			let ctx = omp_con::Ctx::new();
			SV_SANDBOX_MODE
				.set(&ctx, ExecSandboxMode::Off)
				.expect("sandbox off");
			ctx
		};

		for decision in [TrustDecision::Untrusted, TrustDecision::Denied] {
			let host = host_under(&project_root, off(), decision);
			let refused = host
				.admit(&phase, &spec)
				.expect_err("an untrusted workspace admitted a code phase");
			assert!(matches!(refused, ProductionError::UntrustedWorkspace), "{refused:?}");
			assert!(!project_root.join("ran").exists(), "the refused command ran");
		}

		let ran = Box::pin(dispatch(&host(&project_root, off()), &phase, &spec)).await;
		assert!(ran.accepted, "{}", ran.feedback);
		assert!(project_root.join("ran").exists());
	}

	#[test]
	fn explicit_run_model_overrides_configured_model_for_model_phases() {
		let project = tempfile::tempdir().expect("project");
		let ctx = omp_con::Ctx::new();
		ctx.exec("ai_model configured/model", omp_con::Source::Config(sf!("test")))
			.expect("configured model");
		let host = ProductionAdwHost::open(
			project.path().to_path_buf(),
			project.path().join("data"),
			sf!("flag/model"),
			true,
			Arc::new(ctx),
			TRUSTED,
		)
		.expect("workflow host");

		assert_eq!(omp_agent::AI_MODEL.get(&host.ctx).as_str(), "configured/model");
		let (model, explicit) = host.model_phase_selector();
		assert_eq!(model, "flag/model");
		assert!(explicit);
		assert!(child_kernel_options(&host.workspace_trust, explicit).model_override);
	}

	#[test]
	fn implicit_run_model_preserves_configured_model_for_model_phases() {
		let project = tempfile::tempdir().expect("project");
		let ctx = omp_con::Ctx::new();
		ctx.exec("ai_model configured/model", omp_con::Source::Config(sf!("test")))
			.expect("configured model");
		let host = ProductionAdwHost::open(
			project.path().to_path_buf(),
			project.path().join("data"),
			sf!("@smol"),
			false,
			Arc::new(ctx),
			TRUSTED,
		)
		.expect("workflow host");

		let (model, explicit) = host.model_phase_selector();
		assert_eq!(model, "@smol");
		assert!(!explicit);
		assert_eq!(omp_agent::AI_MODEL.get(&host.ctx).as_str(), "configured/model");
		assert!(!child_kernel_options(&host.workspace_trust, explicit).model_override);
	}

	#[test]
	fn a_delegated_answer_with_no_text_is_not_a_result() {
		let empty = judge_delegated(PhaseKind::Agent, Str::empty());
		assert!(!empty.accepted);
		assert!(!empty.feedback.is_empty());
		assert!(!judge_delegated(PhaseKind::Agent, sf!("  \n")).accepted);
		assert!(judge_delegated(PhaseKind::Agent, sf!("done")).accepted);
		assert!(judge_delegated(PhaseKind::Review, sf!("ACCEPT")).accepted);
		assert!(!judge_delegated(PhaseKind::Review, Str::empty()).accepted);
	}

	#[tokio::test]
	async fn a_delegated_phase_that_declares_a_requirement_is_refused_before_any_launch() {
		use omp_adw::{Requirement, WriteScope};

		let project = tempfile::tempdir().expect("project");
		let host = ProductionAdwHost::open(
			project.path().to_path_buf(),
			project.path().join("data"),
			sf!("@smol"),
			false,
			Arc::new(omp_con::Ctx::new()),
			TRUSTED,
		)
		.expect("workflow host");
		let phase = Phase::new(PhaseName::new("build"), PhaseKind::Agent)
			.requiring(Requirement { write: Some(WriteScope::ReadOnly), ..Requirement::default() });
		let spec = PhaseSpec::Prompt {
			text:            sf!("do it"),
			executor:        Some(sf!("codex")),
			accept_on_claim: false,
		};
		let result = host.admit(&phase, &spec);
		assert!(matches!(result, Err(ProductionError::DelegatedRequirement)), "{result:?}");
		assert!(!project.path().join("data").join("adw").exists(), "a refused phase left a journal");
	}

	#[tokio::test]
	async fn a_delegated_phase_is_withheld_in_an_untrusted_workspace() {
		let project = tempfile::tempdir().expect("project");
		let host = ProductionAdwHost::open(
			project.path().to_path_buf(),
			project.path().join("data"),
			sf!("@smol"),
			false,
			Arc::new(omp_con::Ctx::new()),
			TrustDecision::Denied,
		)
		.expect("workflow host");
		let phase = Phase::new(PhaseName::new("build"), PhaseKind::Agent);
		let spec = PhaseSpec::Prompt {
			text:            sf!("do it"),
			executor:        Some(sf!("codex")),
			accept_on_claim: false,
		};
		let result = host.admit(&phase, &spec);
		assert!(matches!(result, Err(ProductionError::UntrustedWorkspace)), "{result:?}");
		assert!(!project.path().join("data").join("adw").exists(), "a withheld phase left a journal");
	}

	#[tokio::test]
	async fn a_cancelled_command_phase_leaves_no_child_running() {
		let project = tempfile::tempdir().expect("project");
		let project_root = project.path().canonicalize().expect("canonical project");
		let ctx = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&ctx, ExecSandboxMode::Off)
			.expect("sandbox off");
		let host = host(&project_root, ctx);
		let pid_file = project_root.join("child.pid");
		let script = format!("sleep 60 & echo $! > '{}'; wait", pid_file.display());
		let (phase, spec) = code_phase(&project_root, &["sh", "-c", script.as_str()]);
		let cancel = CancellationToken::new();
		let dispatching = host.dispatch(&phase, &spec, 1, None, &[], &cancel);
		let cancelling = async {
			for _ in 0..500 {
				if fs::metadata(&pid_file).is_ok_and(|meta| meta.len() > 0) {
					break;
				}
				tokio::time::sleep(Duration::from_millis(20)).await;
			}
			cancel.cancel();
		};
		let (result, ()) = tokio::join!(dispatching, cancelling);
		let result = result.expect("a cancelled phase is a result");
		assert!(!result.accepted, "{}", result.feedback);
		assert_eq!(result.feedback.as_str(), "cancelled");
		let pid: u32 = fs::read_to_string(&pid_file)
			.expect("the shell reported its background child")
			.trim()
			.parse()
			.expect("a pid");
		let mut running = process_running(pid);
		for _ in 0..250 {
			if !running {
				break;
			}
			tokio::time::sleep(Duration::from_millis(20)).await;
			running = process_running(pid);
		}
		if running {
			let _ = std::process::Command::new("kill")
				.arg(pid.to_string())
				.status();
		}
		assert!(!running, "the cancelled phase left child {pid} running");
	}

	/// Whether `pid` names a live process; a zombie does not count.
	fn process_running(pid: u32) -> bool {
		let pid_text = pid.to_string();
		let stat = std::process::Command::new("ps")
			.args(["-o", "stat=", "-p", pid_text.as_str()])
			.output()
			.expect("ps");
		let stat = String::from_utf8_lossy(&stat.stdout);
		let stat = stat.trim();
		!stat.is_empty() && !stat.starts_with('Z')
	}

	#[test]
	fn review_phases_use_the_judge_role_unless_the_operator_chose_a_model() {
		let project = tempfile::tempdir().expect("project");
		let open = |model: Str, explicit: bool| {
			ProductionAdwHost::open(
				project.path().to_path_buf(),
				project.path().join("data"),
				model,
				explicit,
				Arc::new(omp_con::Ctx::new()),
				TRUSTED,
			)
			.expect("workflow host")
		};
		let implicit = open(sf!("@smol"), false);
		assert_eq!(implicit.model_phase_selector_for(PhaseKind::Review), ("@judge", true));
		assert_eq!(implicit.model_phase_selector_for(PhaseKind::Agent), ("@smol", false));
		let explicit = open(sf!("flag/model"), true);
		assert_eq!(explicit.model_phase_selector_for(PhaseKind::Review), ("flag/model", true));
		assert_eq!(explicit.model_phase_selector_for(PhaseKind::Agent), ("flag/model", true));
	}

	#[test]
	fn a_review_run_restores_the_model_it_replaced() {
		let ctx = omp_con::Ctx::new();
		ctx.exec("ai_model configured/model", omp_con::Source::Config(sf!("test")))
			.expect("configured model");
		{
			let _restore = RestoreModel::capture(&ctx);
			omp_agent::AI_MODEL
				.set(&ctx, sf!("@judge"))
				.expect("judge model");
			assert_eq!(omp_agent::AI_MODEL.get(&ctx).as_str(), "@judge");
		}
		assert_eq!(omp_agent::AI_MODEL.get(&ctx).as_str(), "configured/model");
	}

	#[test]
	fn model_phase_kernels_exclude_workspace_extensions_and_inherit_trust() {
		let options = child_kernel_options(&TrustDecision::Denied, false);
		assert!(!options.extensions.include_workspace);
		assert!(options.ephemeral);
		assert!(!options.model_override);
		assert_eq!(options.workspace_trust, WorkspaceTrustSource::Fixed(TrustDecision::Denied));
	}
}
