//! Agent-initiated remote builds (ADR 0040, Part A.3).
//!
//! The `remote_build` session tool runs one remote-eligible Cargo/`just` recipe
//! on the operator's REAPI endpoint as a durable execution job. A composition
//! offers it only when the operator sets [`SV_EXEC_AGENT_RUNS`]. The
//! destination comes from operator settings alone and is fixed before the user
//! is asked. Every run asks once, through the network admission route, keyed by
//! the endpoint host. Nothing connects or uploads before an approved answer for
//! that host, and nothing falls back to a local run.

use std::{
	path::PathBuf,
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use omp_agent::{
	ApprovalBook, ApprovalRoute, ApprovalSource, ApprovalSpec, ApprovalTicket, AuthorizedExecution,
	BackgroundToolCancellation, CallControl, ExecutionStartError, ExecutionSubmission, Received,
	SessionTool, SessionToolCx, SessionToolError, SessionToolFuture,
};
use omp_con::Ctx;
use omp_core::{Str, Ulid, sf};
use omp_dom::{Handle, PropId, PropKey, Value};
use omp_env::EnvClient;
use omp_envd::fetch_host::NETWORK_APPROVAL_KIND;
use omp_exec::{BuildCommand, ExecutionBackend, ExecutionId, Intent, JUST, Platform, RepoPins};
use omp_session::Session;
use omp_tool::{CallOutcome, Claims, Precedence, Presentation, Registry, RegistryError, ToolSpec};
use omp_tools::remote_build::{Fault, NAME, Params, Payload};
use serde_json::value::RawValue;
use tokio_util::sync::CancellationToken;

use crate::exec_composer::{
	ComposedBackend, DestinationIdentity, EnvironmentInputs, ExecutionSettings, PreparedExecution,
	RemoteError,
};

omp_con::var! {
	/// Whether agents may run remote-eligible `just` recipes on the operator's
	/// remote executor through the `remote_build` tool. Off by default: a session
	/// composed while it is off has no such tool. Every run still asks the user
	/// to approve the endpoint host, and nothing runs locally instead.
	pub static SV_EXEC_AGENT_RUNS = sv_exec_agent_runs: bool {
		default: false,
		flags: archive,
	};
}

/// Proof that the operator enabled agent remote builds when one session was
/// composed. The registry declaration and the session tool both take it, so a
/// composition offers both or neither.
#[derive(Clone, Copy, Debug)]
pub struct Enabled(());

/// Reads [`SV_EXEC_AGENT_RUNS`] once for one composition.
#[must_use]
pub fn enabled(ctx: &Ctx) -> Option<Enabled> {
	SV_EXEC_AGENT_RUNS.get(ctx).then_some(Enabled(()))
}

impl Enabled {
	/// `registry` with the `remote_build` declaration added: the frozen registry
	/// the session's wire roster is lowered from.
	///
	/// # Errors
	///
	/// Returns the registry's refusal of the declaration.
	pub fn declare(self, registry: &Registry) -> Result<Registry, RegistryError> {
		let retained = registry
			.live_names()
			.into_iter()
			.filter(|name| name.as_str() != NAME)
			.collect::<Vec<_>>();
		let mut registry = registry.restrict(retained.iter().map(Str::as_str));
		registry.register(omp_tools::remote_build::declaration(), Presentation::Slot, Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp/core"),
			replaces:   None,
		})?;
		Ok(registry)
	}
}

/// The environment and network half of a remote build.
///
/// [`RemoteBuildTool`] plans and captures through it before the approval
/// prompt, and connects through it only after an approved answer.
pub trait RemoteBuildHost: Send + Sync + 'static {
	/// The backend one connection yields.
	type Backend: ExecutionBackend;

	/// Plans `command` and captures its inputs on this host. Nothing leaves it.
	fn prepare<'a>(
		&'a self,
		settings: &'a ExecutionSettings,
		command: &'a BuildCommand,
	) -> impl Future<Output = Result<PreparedExecution, RemoteError>> + Send + 'a;

	/// Resolves the operator credential and connects to the destination
	/// `settings` names.
	fn connect<'a>(
		&'a self,
		settings: &'a ExecutionSettings,
		pins: &'a RepoPins,
		cancel: &'a CancellationToken,
	) -> impl Future<Output = Result<Self::Backend, RemoteError>> + Send + 'a;
}

/// The production host: capture through the project environment, then the
/// REAPI connection.
pub struct EnvironmentHost {
	environment: EnvClient,
	root:        PathBuf,
}

impl EnvironmentHost {
	/// Captures through `environment`, whose workspace is `root`.
	#[must_use]
	pub const fn new(environment: EnvClient, root: PathBuf) -> Self {
		Self { environment, root }
	}
}

impl RemoteBuildHost for EnvironmentHost {
	type Backend = ComposedBackend;

	fn prepare<'a>(
		&'a self,
		settings: &'a ExecutionSettings,
		command: &'a BuildCommand,
	) -> impl Future<Output = Result<PreparedExecution, RemoteError>> + Send + 'a {
		settings.prepare(&self.environment, &self.root, command)
	}

	fn connect<'a>(
		&'a self,
		settings: &'a ExecutionSettings,
		pins: &'a RepoPins,
		cancel: &'a CancellationToken,
	) -> impl Future<Output = Result<Self::Backend, RemoteError>> + Send + 'a {
		async move {
			let credential = settings
				.credential(&self.environment, &self.root, cancel)
				.await?;
			settings
				.connect(self.environment.clone(), pins, credential)
				.await
		}
	}
}

/// The `remote_build` session tool.
pub struct RemoteBuildTool<H> {
	spec:      ToolSpec,
	ctx:       Arc<Ctx>,
	approvals: ApprovalRoute,
	host:      H,
	owner:     Str,
}

impl<H: RemoteBuildHost> RemoteBuildTool<H> {
	/// Runs the session's `remote_build` calls on `host` and journals their jobs
	/// as `owner`'s.
	///
	/// Each call reads the operator settings from `ctx` once and asks
	/// `approvals`, the session's approval route
	/// ([`crate::headless::kernel::bind_environment_approvals`]), before it
	/// connects.
	#[must_use]
	pub fn new(
		_enabled: Enabled,
		ctx: Arc<Ctx>,
		approvals: ApprovalRoute,
		host: H,
		owner: Str,
	) -> Self {
		Self { spec: omp_tools::remote_build::spec(), ctx, approvals, host, owner }
	}

	async fn run(
		&self,
		cx: SessionToolCx<'_>,
		params: Params,
	) -> Result<Result<Payload, Fault>, SessionToolError> {
		let SessionToolCx { session, call, jobs, cancel, control, .. } = cx;
		let argv = match argv(&params) {
			Ok(argv) => argv,
			Err(fault) => return Ok(Err(fault)),
		};
		let settings = match ExecutionSettings::generic(&self.ctx) {
			Ok(settings) => settings,
			Err(error) => {
				tracing::warn!(%error, "remote build is not configured");
				return Ok(Err(Fault::Unconfigured));
			},
		};
		// This one snapshot fixes the destination: the prompt names it, the job
		// records it, and the connection reaches it, whatever cfg says meanwhile.
		let host = Str::new(settings.endpoint_host());
		let destination = settings.destination_identity();
		let command = BuildCommand {
			id: ExecutionId::new(Str::from(Ulid::generate().to_string())),
			argv,
			cwd: None,
			intent: Intent::Other,
			requirement: omp_adw::Requirement::default(),
			target: Platform::LINUX_X86_64,
			host: crate::adw::remote::host_platform(),
		};
		let PreparedExecution { request, pins } = match self.host.prepare(&settings, &command).await {
			Ok(prepared) => prepared,
			Err(RemoteError::InputRefused { path, rule }) => {
				return Ok(Err(Fault::InputRefused { path, rule }));
			},
			Err(error) => {
				tracing::warn!(%error, "remote build inputs were not captured");
				return Ok(Err(Fault::Capture));
			},
		};
		let call_id = call_id(session, call).ok_or(SessionToolError::Rejected {
			message: Str::new_static("the remote build call has no id"),
		})?;
		let approved = ask(
			&self.approvals,
			session,
			control,
			&cancel,
			&call_id,
			requirement(&host, &destination, &params),
		)
		.await?;
		// Only this call's own answer authorizes it. An earlier approval journaled
		// for the same call id, such as a retried call's, never does.
		if !approved {
			return Ok(Err(Fault::NotApproved { host }));
		}
		let destination_text = Str::new(serde_json::to_string(&destination)?);
		let Some(authorized) = authorize(session, &call_id, &host, destination_text) else {
			return Ok(Err(Fault::NotApproved { host }));
		};
		let backend = match self.host.connect(&settings, &pins, &cancel.token()).await {
			Ok(backend) => backend,
			Err(error) => {
				tracing::warn!(%error, %host, "remote build could not connect");
				return Ok(Err(Fault::Connect { host }));
			},
		};
		let submission = ExecutionSubmission {
			owner: self.owner.clone(),
			identity: Str::new(serde_json::to_string(&params)?),
			request,
		};
		match jobs.start_execution(session, authorized, backend, submission) {
			Ok(record) => {
				Ok(Ok(Payload { job: record.id, destination: destination.endpoint }))
			},
			Err(ExecutionStartError::ApprovalSpent { ticket }) => {
				Ok(Err(Fault::ApprovalSpent { ticket }))
			},
			Err(ExecutionStartError::Session(error)) => Err(error.into()),
			Err(error) => {
				tracing::warn!(%error, "remote build job was not recorded");
				Ok(Err(Fault::Journal))
			},
		}
	}
}

impl<H: RemoteBuildHost> SessionTool for RemoteBuildTool<H> {
	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn requires_admission_deny_check(&self) -> bool {
		true
	}

	fn call<'a>(&'a self, cx: SessionToolCx<'a>, args: Box<RawValue>) -> SessionToolFuture<'a> {
		Box::pin(async move {
			let params: Params = omp_tool::decode_params(args.get())?;
			Ok(match self.run(cx, params).await? {
				Ok(payload) => CallOutcome::Ok(serde_json::value::to_raw_value(&payload)?),
				Err(fault) => CallOutcome::Faulted(serde_json::value::to_raw_value(&fault)?),
			})
		})
	}
}

/// The command line for `params`: `just`, a remote-eligible recipe, and the
/// workspace package the recipe may take.
fn argv(params: &Params) -> Result<Arc<[Str]>, Fault> {
	if !crate::adw::remote::eligible(JUST, std::slice::from_ref(&params.recipe)) {
		return Err(Fault::Ineligible { recipe: params.recipe.clone() });
	}
	if matches!(params.recipe.as_str(), "test-pkg" | "check-pkg") != params.package.is_some() {
		return Err(Fault::InvalidArity { recipe: params.recipe.clone() });
	}
	if let Some(package) = params
		.package
		.as_ref()
		.filter(|package| !is_package(package))
	{
		return Err(Fault::InvalidPackage { package: package.clone() });
	}
	Ok([Str::new_static(JUST), params.recipe.clone()]
		.into_iter()
		.chain(params.package.clone())
		.collect())
}

/// Whether `package` names a workspace package: `omp-`, then lowercase ASCII
/// letters, digits and hyphens. No `just` recipe starts with `omp-`, so a
/// package never names a second recipe for `just` to run.
fn is_package(package: &str) -> bool {
	package.strip_prefix("omp-").is_some_and(|name| {
		!name.is_empty()
			&& name
				.bytes()
				.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
	})
}

/// The once-only network requirement for uploading to `host`, in the network
/// admission route's template: it defaults to deny, asks a human, and denies
/// when no one can answer.
fn requirement(host: &Str, destination: &DestinationIdentity, params: &Params) -> ApprovalSpec {
	let command = match &params.package {
		Some(package) => sf!("just {} {}", params.recipe, package),
		None => sf!("just {}", params.recipe),
	};
	let endpoint = &destination.endpoint;
	ApprovalSpec {
		title:         sf!("Allow a remote build on {host}"),
		body:          sf!(
			"remote_build uploads the working tree to {endpoint} and runs `{command}` there."
		),
		subject:       host.clone(),
		kind:          Str::new_static(NETWORK_APPROVAL_KIND),
		scopes:        vec![Str::new_static("once")],
		default:       Some(false),
		route:         Str::new_static("user"),
		approver:      None,
		timeout_ms:    0,
		unreachable:   Str::new_static("deny"),
		require_human: true,
		pattern:       None,
		evidence:      vec![sf!(
			"`remote_build` uploads to the operator endpoint host {host}, which every run asks for"
		)],
	}
}

/// Files `requirement` for the call `call_id` on the session's approval route,
/// waits for the answer, and returns whether it approved.
///
/// The call holds the session while it waits, so it serves the kernel mailbox
/// itself: that is where the prompt is journaled and answered. Interrupting the
/// call, its turn or the session withdraws the wait.
async fn ask(
	approvals: &ApprovalRoute,
	session: &mut Session,
	control: Option<&CallControl>,
	cancel: &BackgroundToolCancellation,
	call_id: &Str,
	requirement: ApprovalSpec,
) -> Result<bool, SessionToolError> {
	let answer = approvals.request_cancellable(
		Some(call_id.clone()),
		vec![requirement],
		epoch_millis(),
		cancel.token(),
	);
	let Some(control) = control else {
		return Ok(approves(&answer.await));
	};
	tokio::pin!(answer);
	loop {
		tokio::select! {
			biased;
			ticket = &mut answer => return Ok(approves(&ticket)),
			message = control.recv() => match control.handle(session, message)? {
				Received::Cancelled => cancel.cancel_tool(),
				Received::ToolScopedAbort(reason) if reason.contains(call_id) => cancel.cancel_tool(),
				_ => {},
			},
		}
	}
}

/// Whether the route's answer `ticket` approves the call.
fn approves(ticket: &ApprovalTicket) -> bool {
	ticket.decision.as_ref().is_some_and(|decision| {
		decision.approved
			&& matches!(decision.source, ApprovalSource::User | ApprovalSource::External)
	})
}

/// Mints the run's approval proof from the prompt the session journaled for
/// `call_id`: a route answers with its own ticket id, not the journaled one.
fn authorize(
	session: &Session,
	call_id: &str,
	host: &str,
	destination: Str,
) -> Option<AuthorizedExecution> {
	let ticket = ApprovalBook::new().decided_for(session, call_id)?;
	AuthorizedExecution::from_session(
		session,
		&ticket.ticket_id,
		NETWORK_APPROVAL_KIND,
		host,
		destination,
	)
	.inspect_err(|error| tracing::debug!(%error, "the remote build was not approved"))
	.ok()
}

/// The provider id of the call element `call`: the invocation its prompt names.
fn call_id(session: &Session, call: Handle) -> Option<Str> {
	session
		.dom()
		.get(call)?
		.prop(&PropKey::from(PropId::Id))
		.and_then(Value::as_str)
		.map(Str::new)
}

fn epoch_millis() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
	use super::*;

	const JUSTFILE: &str = include_str!("../../../justfile");

	#[test]
	fn packages_are_workspace_package_names() {
		for package in ["omp-driver", "omp-exec-reapi", "omp-e2e"] {
			assert!(is_package(package), "{package}");
		}
		for package in ["fmt", "omp-", "omp-Driver", "omp-driver fmt", "-p", "omp_driver", ""] {
			assert!(!is_package(package), "{package}");
		}
	}

	#[test]
	fn no_justfile_recipe_reads_as_a_package() {
		let recipes = JUSTFILE
			.lines()
			.filter(|line| line.starts_with(|first: char| first.is_ascii_lowercase()))
			.filter_map(|line| line.split([' ', ':']).next())
			.collect::<Vec<_>>();
		assert!(recipes.contains(&"test-pkg"), "{recipes:?}");
		assert!(!recipes.iter().any(|recipe| is_package(recipe)), "{recipes:?}");
	}
}
