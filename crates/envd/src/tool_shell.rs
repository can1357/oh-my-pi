use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	future::{self, Future},
	path::Path,
	pin::Pin,
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use flume::Receiver;
use omp_core::{CowBytes, Str, encoding::hex, sf};
use omp_proto::{
	env::{
		v1,
		v1::{
			EnvironmentDelta, ExecOutcome as EnvExecOutcome, ExecRequest, OpenSessionRequest,
			OutputChannel as EnvOutputChannel, ProcessSpec, PtySpec, RestartPolicy, RestartSpec,
			Script, ShellProfileInput, StartProcess,
		},
	},
	inference::v1::value,
};
use omp_tool::{BlobRef, JobOwner};
use omp_tools::{
	auto_background::DetachedJob,
	read::{
		resolver::{ResolverTable, Scheme},
		selector::parse_uri,
	},
	shell::{
		DetachRequest, ExecOutcome, ExecStatus, Fault, OutputChannel, RunEvent, RunRequest, Session,
		SessionOptions, ShellExec, ShellRun, Update,
	},
	shell_uri::QuoteContext,
};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	blobs::BlobHost,
	direnv::DirenvDelta,
	exec::{ExecError, ExecEvent, ExecHost, ExecRun},
	exec_settings::{
		DirenvMode, ExecSandboxMode, ReadMode, SandboxNetworkMode, SandboxSettings, ShellSettings,
	},
	tool_url::UrlResolver,
	tools,
};

/// Session-scoped ACP terminal execution selected ahead of local shell
/// placement when a capable editor peer is attached.
pub trait AcpExecBackend: Send + Sync {
	/// Starts a foreground command and exposes its ordinary shell event stream.
	fn run(
		&self,
		request: AcpExecRequest,
	) -> Pin<Box<dyn Future<Output = Result<AcpExecRun, Fault>> + Send + '_>>;
}

/// One ACP terminal request after shell session option resolution.
pub struct AcpExecRequest {
	/// Shell command line to execute.
	pub command:    Str,
	/// Resolved local working-directory path, when one was requested.
	pub cwd:        Option<Str>,
	/// Resolved environment additions for the command.
	pub env:        BTreeMap<Str, Str>,
	/// Optional command timeout in milliseconds.
	pub timeout_ms: Option<u64>,
}

/// ACP terminal event handle consumed through the ordinary shell resource
/// contract.
pub struct AcpExecRun {
	/// Ordered execution events produced by the editor-owned terminal.
	pub events: Receiver<Result<RunEvent, Fault>>,
	/// Cancellation handle for the editor-owned terminal.
	pub cancel: CancellationToken,
}

/// Late-bound ACP backend capability shared with one Environment registry.
#[derive(Clone, Default)]
pub(crate) struct AcpExecSlot {
	backend: Arc<parking_lot::RwLock<Option<Arc<dyn AcpExecBackend>>>>,
}

impl AcpExecSlot {
	/// Replaces the session capability currently available to shell calls.
	pub(crate) fn bind(&self, backend: Option<Arc<dyn AcpExecBackend>>) {
		*self.backend.write() = backend;
	}

	fn backend(&self) -> Option<Arc<dyn AcpExecBackend>> {
		tools::invocation_acp_exec().or_else(|| self.backend.read().clone())
	}
}

/// Shell resource adapter backed by the local execution authority.
#[derive(Clone)]
pub struct ShellExecHost {
	host:               ExecHost,
	blobs:              BlobHost,
	cwd_uri:            Str,
	resolvers:          Arc<ResolverTable<UrlResolver>>,
	settings:           ShellSettings,
	/// Sandbox posture compiled for external commands and in-process writes.
	pub(crate) sandbox: SandboxSettings,
	acp:                AcpExecSlot,
	acp_routing:        bool,
	acp_sessions:       Arc<Mutex<BTreeMap<Bytes, AcpSessionOptions>>>,
}
#[derive(Clone)]
struct AcpSessionOptions {
	cwd:   Option<Str>,
	env:   BTreeMap<Str, Str>,
	unset: Vec<String>,
}

impl ShellExecHost {
	/// Binds shell execution to the workspace root URI used for sessions and
	/// detached processes.
	pub(crate) fn new(
		host: ExecHost,
		blobs: BlobHost,
		cwd_uri: Str,
		resolvers: Arc<ResolverTable<UrlResolver>>,
		settings: ShellSettings,
		sandbox: SandboxSettings,
		acp: AcpExecSlot,
		acp_routing: bool,
	) -> Self {
		if let Ok(uri) = Url::parse(&cwd_uri)
			&& let Ok(root) = uri.to_file_path()
		{
			host.configure_sandbox(&sandbox, &root);
		}
		Self {
			host,
			blobs,
			cwd_uri,
			resolvers,
			settings,
			sandbox,
			acp,
			acp_routing,
			acp_sessions: Arc::new(Mutex::new(BTreeMap::new())),
		}
	}
}
impl ShellExecHost {
	/// The only shell profile is the embedded in-process interpreter (ADR 0028);
	/// the profile input carries just the configured command prefix.
	fn shell_profile(&self) -> ShellProfileInput {
		ShellProfileInput {
			profile:        String::from("brush"),
			executable:     String::new(),
			args:           Vec::new(),
			command_prefix: self
				.settings
				.command_prefix
				.as_deref()
				.unwrap_or_default()
				.to_owned(),
			env_delta:      None,
			login:          false,
			wire_revision:  omp_proto::SCHEMA_REV,
		}
	}

	/// Detached processes run the same in-process interpreter; only the
	/// configured command prefix is applied to the script.
	fn detached_command(&self, command: &Str) -> String {
		match self.settings.command_prefix.as_deref() {
			Some(prefix) => format!("{prefix} {command}"),
			None => command.to_string(),
		}
	}

	async fn expand_internal_uris(&self, input: &str, shell_source: bool) -> Result<Str, Fault> {
		let mut paths = BTreeMap::new();
		for occurrence in omp_tools::shell_uri::scan(input) {
			if matches!(occurrence.quote, QuoteContext::Single | QuoteContext::Double)
				&& !occurrence.whole_quoted_token
			{
				continue;
			}
			if paths.contains_key(&occurrence.uri) {
				continue;
			}
			let parsed = parse_uri(occurrence.uri.as_str())
				.map_err(|_| Fault::Resource {
					operation: sf!("materialize"),
					message:   sf!("invalid internal resource URI: {}", occurrence.uri),
				})?
				.ok_or_else(|| Fault::Resource {
					operation: sf!("materialize"),
					message:   sf!("internal resource URI is missing a scheme"),
				})?;
			if parsed.scheme == Scheme::Unknown {
				continue;
			}
			let Some(resolved) = self.resolvers.path(parsed.scheme, parsed.resource).await else {
				continue;
			};
			let resolved = resolved.map_err(|_| Fault::Resource {
				operation: sf!("materialize"),
				message:   sf!("internal resource has no materializable path: {}", occurrence.uri),
			})?;
			let Some(path_uri) = resolved.canonical_path_uri else {
				continue;
			};
			let path = Url::parse(path_uri.as_str())
				.ok()
				.and_then(|uri| uri.to_file_path().ok())
				.ok_or_else(|| Fault::Resource {
					operation: sf!("materialize"),
					message:   sf!("internal resource path is not a local file URI"),
				})?;
			paths.insert(occurrence.uri, Str::from(path.to_string_lossy().as_ref()));
		}
		Ok(if shell_source {
			omp_tools::shell_uri::replace(input, &paths)
		} else {
			omp_tools::shell_uri::replace_plain(input, &paths)
		})
	}

	async fn expand_environment(
		&self,
		environment: BTreeMap<Str, Option<Str>>,
	) -> Result<BTreeMap<Str, Option<Str>>, Fault> {
		let mut expanded = BTreeMap::new();
		for (name, value) in environment {
			let value = match value {
				Some(value) => Some(self.expand_internal_uris(value.as_str(), false).await?),
				None => None,
			};
			expanded.insert(name, value);
		}
		Ok(expanded)
	}

	async fn resolve_cwd(&self, requested: Option<&str>) -> Result<Str, Fault> {
		let expanded;
		let requested = if let Some(value) = requested {
			expanded = self.expand_internal_uris(value, false).await?;
			Some(expanded.as_str())
		} else {
			None
		};
		let root = Url::parse(&self.cwd_uri)
			.map_err(|error| cwd_fault(format!("workspace root URI is invalid: {error}")))?;
		let root_path = root
			.to_file_path()
			.map_err(|()| cwd_fault("workspace root is not a local file URI"))?;
		let path = match requested {
			None => root_path,
			Some(value) if value.contains("://") => Url::parse(value)
				.map_err(|error| cwd_fault(format!("working-directory URI is invalid: {error}")))?
				.to_file_path()
				.map_err(|()| cwd_fault("working-directory URI is not a local file URI"))?,
			Some(value) => {
				let path = Path::new(value);
				if path.is_absolute() {
					path.into()
				} else {
					root_path.join(path)
				}
			},
		};
		if !path.is_dir() {
			return Err(cwd_fault(format!(
				"working directory is not an existing directory: {}",
				path.display()
			)));
		}
		let uri = Url::from_file_path(path)
			.map_err(|()| cwd_fault("working directory cannot be represented as a file URI"))?;
		Ok(Str::from(uri.to_string()))
	}

	fn acp_command_prefix(&self, unset: &[String]) -> Str {
		let profile = self.shell_profile();
		let mut prefix = String::new();
		#[cfg(not(windows))]
		{
			let names = unset
				.iter()
				.filter(|name| valid_env_name(name))
				.map(String::as_str)
				.collect::<Vec<_>>();
			if !names.is_empty() {
				prefix.push_str("unset -v ");
				prefix.push_str(&names.join(" "));
				prefix.push_str("; ");
			}
		}
		#[cfg(windows)]
		for name in unset.iter().filter(|name| valid_env_name(name)) {
			prefix.push_str("set \"");
			prefix.push_str(name);
			prefix.push_str("=\" && ");
		}
		if !profile.command_prefix.is_empty() {
			prefix.push_str(&profile.command_prefix);
			prefix.push(' ');
		}
		Str::from(prefix)
	}

	async fn environment(
		&self,
		cwd_uri: &str,
		user: BTreeMap<Str, Option<Str>>,
		pty: bool,
	) -> EnvironmentDelta {
		use super::direnv::load;
		let direnv = if self.settings.direnv == DirenvMode::Auto {
			Url::parse(cwd_uri)
				.ok()
				.and_then(|url| url.to_file_path().ok())
				.map(|cwd| async move {
					load(&cwd, Duration::from_millis(self.settings.direnv_load_timeout_ms)).await
				})
		} else {
			None
		};
		let direnv = match direnv {
			Some(load) => load.await,
			None => None,
		};
		hardened_environment(user, pty, direnv)
	}
}

fn hardened_environment(
	user: BTreeMap<Str, Option<Str>>,
	pty: bool,
	direnv: Option<DirenvDelta>,
) -> EnvironmentDelta {
	let mut set: BTreeMap<String, String> = [
		("PAGER", "cat"),
		("GIT_PAGER", "cat"),
		("MANPAGER", "cat"),
		("SYSTEMD_PAGER", "cat"),
		("BAT_PAGER", "cat"),
		("DELTA_PAGER", "cat"),
		("GH_PAGER", "cat"),
		("GLAB_PAGER", "cat"),
		("AWS_PAGER", ""),
		("PSQL_PAGER", "cat"),
		("MYSQL_PAGER", "cat"),
		("HOMEBREW_PAGER", "cat"),
		("LESS", "FRX"),
		("NO_COLOR", "1"),
		("PYTHONUNBUFFERED", "1"),
		("GIT_EDITOR", "true"),
		("VISUAL", "true"),
		("EDITOR", "true"),
		("GIT_TERMINAL_PROMPT", "0"),
		("SSH_ASKPASS", "false"),
		("CI", "true"),
		("AGENT", "1"),
		("npm_config_yes", "true"),
		("npm_config_update_notifier", "false"),
		("npm_config_fund", "false"),
		("npm_config_audit", "false"),
		("PNPM_DISABLE_SELF_UPDATE_CHECK", "true"),
		("YARN_ENABLE_TELEMETRY", "0"),
		("PNPM_UPDATE_NOTIFIER", "false"),
		("YARN_ENABLE_PROGRESS_BARS", "0"),
		("CARGO_TERM_PROGRESS_WHEN", "never"),
		("PIP_NO_INPUT", "1"),
		("PIP_DISABLE_PIP_VERSION_CHECK", "1"),
		("GH_PROMPT_DISABLED", "1"),
		("DEBIAN_FRONTEND", "noninteractive"),
		("TF_INPUT", "0"),
		("TF_IN_AUTOMATION", "1"),
		("COMPOSER_NO_INTERACTION", "1"),
		("CLOUDSDK_CORE_DISABLE_PROMPTS", "1"),
	]
	.into_iter()
	.map(|(key, value)| (String::from(key), String::from(value)))
	.collect();
	if let Some(direnv) = &direnv {
		set.extend(
			direnv
				.set
				.iter()
				.map(|(key, value)| (key.to_string(), value.to_string())),
		);
	}
	if !pty {
		set.insert(String::from("TERM"), String::from("dumb"));
	}
	if env::var_os("OMP_BASH_NO_CI").is_some_and(|value| {
		let value = value.to_string_lossy();
		!value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
	}) {
		set.remove("CI");
	}
	let mut unset = direnv
		.into_iter()
		.flat_map(|delta| delta.unset)
		.map(|key| key.to_string())
		.collect::<BTreeSet<_>>();
	for (key, value) in user {
		let key = key.to_string();
		match value {
			Some(value) => {
				unset.remove(&key);
				set.insert(key, value.to_string());
			},
			None => {
				set.remove(&key);
				unset.insert(key);
			},
		}
	}
	EnvironmentDelta { set, unset: unset.into_iter().collect(), props: None }
}

fn command_environment(environment: BTreeMap<Str, Option<Str>>) -> EnvironmentDelta {
	let mut set = BTreeMap::new();
	let mut unset = Vec::new();
	for (name, value) in environment {
		match value {
			Some(value) => {
				set.insert(name.to_string(), value.to_string());
			},
			None => unset.push(name.to_string()),
		}
	}
	EnvironmentDelta { set, unset, props: None }
}

fn valid_env_name(name: &str) -> bool {
	let mut bytes = name.bytes();
	bytes
		.next()
		.is_some_and(|byte| byte == b'_' || byte.is_ascii_alphabetic())
		&& bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
}

fn named_process(started: v1::ProcessStarted) -> DetachedJob {
	let id = sf!("{}#{}", started.name, started.generation);
	DetachedJob {
		id,
		owner: JobOwner::NamedProcess {
			name:       Str::from(started.name),
			generation: started.generation,
		},
	}
}

fn cwd_fault(message: impl Into<Str>) -> Fault {
	Fault::Resource { operation: sf!("cwd"), message: message.into() }
}
/// Foreground shell run retaining the concrete host's process-tree guard.
pub(crate) struct HostShellRun {
	host: ExecHost,
	run:  ExecRun,
}

impl HostShellRun {
	fn new(host: ExecHost, run: ExecRun) -> Self {
		Self { host, run }
	}
}

impl ShellRun for HostShellRun {
	async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
		self.run.next_event().await.map(map_event).transpose()
	}

	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		self.run.cancel();
		future::ready(Ok(()))
	}

	fn detach(&self, name: Str) -> impl Future<Output = Result<DetachedJob, Fault>> + Send + '_ {
		future::ready(
			self
				.host
				.detach_exec(self.run.id(), &name)
				.map(named_process)
				.map_err(|error| resource_fault("detach_running", error)),
		)
	}
}

/// Foreground run selected from the capability-advertised ACP backend or the
/// normal Environment host.
pub struct SelectedShellRun {
	kind: SelectedShellRunKind,
}

enum SelectedShellRunKind {
	Host(HostShellRun),
	Acp(AcpExecRun),
}

impl ShellRun for SelectedShellRun {
	async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
		match &mut self.kind {
			SelectedShellRunKind::Host(run) => run.next_event().await,
			SelectedShellRunKind::Acp(run) => match run.events.recv_async().await {
				Ok(event) => event.map(Some),
				Err(_) => Ok(None),
			},
		}
	}

	async fn cancel(&self) -> Result<(), Fault> {
		match &self.kind {
			SelectedShellRunKind::Host(run) => run.cancel().await,
			SelectedShellRunKind::Acp(run) => {
				run.cancel.cancel();
				Ok(())
			},
		}
	}

	async fn detach(&self, name: Str) -> Result<DetachedJob, Fault> {
		match &self.kind {
			SelectedShellRunKind::Host(run) => run
				.host
				.detach_exec(run.run.id(), &name)
				.map(named_process)
				.map_err(|error| resource_fault("detach_running", error)),
			SelectedShellRunKind::Acp(_) => Err(Fault::Resource {
				operation: sf!("detach_running"),
				message:   sf!("ACP terminal runs remain foreground-owned by the editor"),
			}),
		}
	}
}

impl ShellExec for ShellExecHost {
	type Run = SelectedShellRun;

	async fn open_session(&self, options: SessionOptions) -> Result<Session, Fault> {
		if options.pty && tools::pty_denied() {
			return Err(Fault::PtyDenied);
		}
		let cwd_uri = self.resolve_cwd(options.cwd.as_deref()).await?;
		let pty = options.pty;
		let environment = self
			.environment(&cwd_uri, self.expand_environment(options.env).await?, pty)
			.await;
		if sandbox_authority_is_inactive(&self.sandbox)
			&& self.acp_routing
			&& self.acp.backend().is_some()
			&& !pty
		{
			let cwd = Url::parse(&cwd_uri)
				.ok()
				.and_then(|uri| uri.to_file_path().ok())
				.map(|path| Str::from(path.to_string_lossy().as_ref()));
			let env = environment
				.set
				.iter()
				.map(|(name, value)| (Str::from(name.as_str()), Str::from(value.as_str())))
				.collect();
			let unset = environment.unset;
			let id = Bytes::from(format!("acp:{}", omp_core::Ulid::generate()));
			self
				.acp_sessions
				.lock()
				.insert(id.clone(), AcpSessionOptions { cwd, env, unset });
			return Ok(Session { id });
		}
		let request = OpenSessionRequest {
			cwd_uri: cwd_uri.to_string(),
			env_delta: Some(environment),
			pty: pty
				.then(|| PtySpec { terminal: String::from("xterm-256color"), ..Default::default() }),
			shell_profile: Some(self.shell_profile()),
			..Default::default()
		};
		let opened = self
			.host
			.open_session(request)
			.await
			.map_err(|error| resource_fault("open_session", error))?;
		Ok(Session { id: opened.session })
	}

	fn close_session<'a>(
		&'a self,
		session: &'a Session,
	) -> impl Future<Output = Result<(), Fault>> + Send + 'a {
		async move {
			if self.acp_sessions.lock().remove(&session.id).is_some() {
				return Ok(());
			}
			self
				.host
				.close_session(&session.id)
				.map(|_| ())
				.map_err(|error| resource_fault("close_session", error))
		}
	}

	async fn run<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
	) -> Result<Self::Run, Fault> {
		let command = self
			.expand_internal_uris(request.command.as_str(), true)
			.await?;
		let environment = command_environment(self.expand_environment(request.environment).await?);
		let acp_options = self.acp_sessions.lock().get(&session.id).cloned();
		if sandbox_authority_is_inactive(&self.sandbox)
			&& let Some(options) = acp_options
		{
			let backend = self.acp.backend().ok_or_else(|| Fault::Resource {
				operation: sf!("run"),
				message:   sf!("ACP terminal backend disconnected"),
			})?;
			let mut env = options.env;
			env.extend(
				environment
					.set
					.iter()
					.map(|(name, value)| (Str::from(name.as_str()), Str::from(value.as_str()))),
			);
			let mut unset = options.unset;
			unset.retain(|name| !environment.set.contains_key(name));
			unset.extend(environment.unset.iter().cloned());
			let command_prefix = self.acp_command_prefix(&unset);
			return backend
				.run(AcpExecRequest {
					command: if command_prefix.is_empty() {
						command
					} else {
						sf!("{}{}", command_prefix, command)
					},
					cwd: options.cwd,
					env,
					timeout_ms: request.timeout_ms,
				})
				.await
				.map(|run| SelectedShellRun { kind: SelectedShellRunKind::Acp(run) });
		}
		let mut exec_request = ExecRequest {
			session: session.id.clone(),
			source: Some(Script { text: command.to_string(), ..Default::default() }),
			output_request: match tools::invocation_output_request() {
				omp_tool::OutputRequest::Bounded => v1::OutputRequest::Bounded as i32,
				omp_tool::OutputRequest::Complete => v1::OutputRequest::Complete as i32,
			},
			..Default::default()
		};
		super::exec::set_run_environment(&mut exec_request, environment);
		let (_, run) = self
			.host
			.exec(exec_request, request.timeout_ms.map(Duration::from_millis))
			.await
			.map_err(|error| resource_fault("run", error))?;
		Ok(SelectedShellRun {
			kind: SelectedShellRunKind::Host(HostShellRun::new(self.host.clone(), run)),
		})
	}

	async fn store_attachment(&self, bytes: Bytes, media_type: Str) -> Result<BlobRef, Fault> {
		let blobs = self.blobs.clone();
		let id = tokio::task::spawn_blocking(move || blobs.put(&bytes))
			.await
			.map_err(|error| Fault::Resource {
				operation: sf!("store_shell_attachment"),
				message:   Str::new(error.to_string()),
			})?
			.map_err(|error| Fault::Resource {
				operation: sf!("store_shell_attachment"),
				message:   Str::new(error.to_string()),
			})?;
		Ok(BlobRef {
			hash: Str::from(hex::encode(&id.hash).into_string()),
			media_type,
			byte_len: id.size,
		})
	}

	async fn detach(&self, request: DetachRequest) -> Result<DetachedJob, Fault> {
		if request.options.pty && tools::pty_denied() {
			return Err(Fault::PtyDenied);
		}
		let cwd_uri = self.resolve_cwd(request.options.cwd.as_deref()).await?;
		let pty = request.options.pty;
		let environment = self
			.environment(&cwd_uri, self.expand_environment(request.options.env).await?, pty)
			.await;
		let command = self
			.expand_internal_uris(request.command.as_str(), true)
			.await?;
		let start = StartProcess {
			name: request.name.to_string(),
			spec: Some(ProcessSpec {
				source: Some(Script { text: self.detached_command(&command), ..Default::default() }),
				cwd_uri: cwd_uri.to_string(),
				env_delta: Some(environment),
				pty: pty
					.then(|| PtySpec { terminal: String::from("xterm-256color"), ..Default::default() }),
				restart: Some(RestartSpec {
					policy: RestartPolicy::Never as i32,
					..Default::default()
				}),
				timeout_ms: request.timeout_ms.filter(|timeout| *timeout != 0),
				..Default::default()
			}),
			..Default::default()
		};
		let started = self
			.host
			.start_process(start)
			.await
			.map_err(|error| resource_fault("detach", error))?;
		Ok(named_process(started))
	}
}

pub(crate) fn map_event(event: ExecEvent) -> Result<RunEvent, Fault> {
	match event {
		ExecEvent::Started { exec_id } => Ok(RunEvent::Started { exec_id }),
		ExecEvent::Output(frame) => {
			let channel = match EnvOutputChannel::try_from(frame.channel) {
				Ok(EnvOutputChannel::Stdout) => OutputChannel::Stdout,
				Ok(EnvOutputChannel::Stderr) => OutputChannel::Stderr,
				Ok(EnvOutputChannel::Pty) => OutputChannel::Pty,
				Ok(EnvOutputChannel::Unspecified) | Err(_) => {
					return Err(protocol_fault(
						"next_event",
						sf!("invalid output channel {}", frame.channel),
					));
				},
			};
			Ok(RunEvent::Output(Update {
				channel,
				data: CowBytes::owned(frame.data),
				sequence: frame.sequence,
				exec_id: frame.exec,
				started: wire_bool(&frame.props, "acp/started").unwrap_or(false),
				terminal: wire_bool(&frame.props, "acp/terminal")
					.unwrap_or(channel == OutputChannel::Pty),
			}))
		},
		ExecEvent::Exit(event) => {
			let status = event
				.status
				.ok_or_else(|| protocol_fault("next_event", "terminal event omitted status"))?;
			let outcome = match EnvExecOutcome::try_from(status.outcome) {
				Ok(EnvExecOutcome::Exited) => ExecOutcome::Exited,
				Ok(EnvExecOutcome::Failed) => ExecOutcome::Failed,
				Ok(EnvExecOutcome::Timeout) => ExecOutcome::Timeout,
				Ok(EnvExecOutcome::Cancelled) => ExecOutcome::Cancelled,
				Ok(EnvExecOutcome::Denied) => ExecOutcome::Denied,
				Ok(EnvExecOutcome::Unspecified) | Err(_) => {
					return Err(protocol_fault(
						"next_event",
						sf!("invalid execution outcome {}", status.outcome),
					));
				},
			};
			let signal = (!status.signal.is_empty()).then(|| Str::from(status.signal));
			let spilled_output = status.spilled_output.map(|blob| BlobRef {
				hash:       Str::from(hex::encode(&blob.hash).into_string()),
				media_type: Str::from(blob.mime),
				byte_len:   blob.size,
			});
			Ok(RunEvent::Exit(ExecStatus {
				outcome,
				exit_code: status.exit_code,
				signal,
				wall_clock_ms: status.wall_clock_ms,
				spilled_output,
				aborted: status.aborted,
				effects_unknown: wire_bool(&status.props, "acp/effects-unknown").unwrap_or(false),
				diags: status
					.diags
					.into_iter()
					.map(tool_diag)
					.collect::<Result<Vec<_>, _>>()?,
				final_cwd_uri: (!event.final_cwd_uri.is_empty())
					.then(|| Str::from(event.final_cwd_uri)),
				final_cwd_revision: event.final_cwd_revision,
			}))
		},
	}
}

fn tool_diag(diag: v1::ToolDiag) -> Result<omp_tool::Diag, Fault> {
	let severity = match v1::ToolDiagSeverity::try_from(diag.severity) {
		Ok(v1::ToolDiagSeverity::Info) => omp_tool::Severity::Info,
		Ok(v1::ToolDiagSeverity::Warn) => omp_tool::Severity::Warn,
		Ok(v1::ToolDiagSeverity::Error) => omp_tool::Severity::Error,
		Ok(v1::ToolDiagSeverity::Unspecified) | Err(_) => {
			return Err(protocol_fault(
				"next_event",
				sf!("invalid tool diagnostic severity {}", diag.severity),
			));
		},
	};
	let omitted = diag
		.omitted
		.map(|omitted| {
			let unit = match v1::ToolDiagUnit::try_from(omitted.unit) {
				Ok(v1::ToolDiagUnit::Lines) => omp_tool::Unit::Lines,
				Ok(v1::ToolDiagUnit::Rows) => omp_tool::Unit::Rows,
				Ok(v1::ToolDiagUnit::Entries) => omp_tool::Unit::Entries,
				Ok(v1::ToolDiagUnit::Files) => omp_tool::Unit::Files,
				Ok(v1::ToolDiagUnit::Bytes) => omp_tool::Unit::Bytes,
				Ok(v1::ToolDiagUnit::Chars) => omp_tool::Unit::Chars,
				Ok(v1::ToolDiagUnit::Items) => omp_tool::Unit::Items,
				Ok(v1::ToolDiagUnit::Unspecified) | Err(_) => {
					return Err(protocol_fault(
						"next_event",
						sf!("invalid tool diagnostic unit {}", omitted.unit),
					));
				},
			};
			Ok(omp_tool::Omitted { count: omitted.count, unit })
		})
		.transpose()?;
	Ok(omp_tool::Diag {
		severity,
		kind: Str::from(diag.kind),
		text: Str::from(diag.text),
		continuation: diag.continuation.map(Str::from),
		artifact: diag.artifact.map(Str::from),
		omitted,
	})
}

fn sandbox_authority_is_inactive(sandbox: &SandboxSettings) -> bool {
	sandbox.mode == ExecSandboxMode::Off
		&& sandbox.environment_policy_is_default()
		&& sandbox.read_mode == ReadMode::Host
		&& sandbox.readable_roots.is_empty()
		&& sandbox.read_deny.is_empty()
		&& sandbox.read_deny_globs.is_empty()
		&& sandbox.network_mode == SandboxNetworkMode::Disabled
		&& sandbox.allow_domains.is_empty()
		&& sandbox.deny_domains.is_empty()
		&& sandbox.allow_ports == [80, 443]
		&& !sandbox.allow_localhost
		&& sandbox.allow_unix_sockets.is_empty()
}

fn wire_bool(props: &Option<omp_proto::inference::v1::ValueMap>, key: &str) -> Option<bool> {
	match props.as_ref()?.fields.get(key)?.kind.as_ref()? {
		value::Kind::Bool(value) => Some(*value),
		_ => None,
	}
}

fn resource_fault(operation: &'static str, error: ExecError) -> Fault {
	protocol_fault(operation, sf!("{error}"))
}

fn protocol_fault(operation: &'static str, message: impl Into<Str>) -> Fault {
	Fault::Resource { operation: sf!(operation), message: message.into() }
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn exec_diagnostics_preserve_typed_recovery_fields_across_the_wire() {
		let expected =
			omp_tool::Diag::warn(omp_tool::DiagKind::Pagination, "More output is available.")
				.continuation(":16")
				.artifact("artifact://sha256/abcd")
				.omitted(45, omp_tool::Unit::Lines);
		let actual = tool_diag(crate::exec::wire_diag(&expected)).expect("valid diagnostic");
		assert_eq!(actual, expected);
	}

	#[test]
	fn acp_requires_all_sandbox_authority_to_be_inactive() {
		assert!(sandbox_authority_is_inactive(&SandboxSettings::default()));
		for sandbox in [
			SandboxSettings { network_mode: SandboxNetworkMode::Open, ..SandboxSettings::default() },
			SandboxSettings { network_mode: SandboxNetworkMode::Scoped, ..SandboxSettings::default() },
			SandboxSettings {
				allow_domains: vec![sf!("api.example.test")],
				..SandboxSettings::default()
			},
			SandboxSettings {
				allow_unix_sockets: vec![sf!("/tmp/service.sock")],
				..SandboxSettings::default()
			},
		] {
			assert!(!sandbox_authority_is_inactive(&sandbox));
		}
	}

	fn test_host(root: &Path) -> ShellExecHost {
		let root_uri = Url::from_directory_path(root)
			.expect("workspace URI")
			.to_string();
		ShellExecHost::new(
			ExecHost::new(),
			BlobHost::open(root.join(".omp-test-blobs")).expect("blob host"),
			Str::from(root_uri),
			Arc::new(ResolverTable::default()),
			ShellSettings::default(),
			SandboxSettings::default(),
			AcpExecSlot::default(),
			false,
		)
	}

	#[cfg(target_os = "macos")]
	async fn approval_gated_sandbox_run(
		root: &Path,
	) -> (ShellExecHost, Session, SelectedShellRun, omp_agent::ApprovalInbox) {
		std::fs::create_dir(root.join(".git")).expect("git carve-out");
		let exec = ExecHost::new();
		let book = Arc::new(omp_agent::ApprovalBook::new());
		let (route, inbox) = omp_agent::ApprovalRoute::new(book, None);
		exec.bind_sandbox_approval_route(Some(route));
		let root_uri = Url::from_directory_path(root)
			.expect("workspace URI")
			.to_string();
		let host = ShellExecHost::new(
			exec,
			BlobHost::open(root.join(".omp-test-blobs")).expect("blob host"),
			Str::from(root_uri),
			Arc::new(ResolverTable::default()),
			ShellSettings::default(),
			SandboxSettings { mode: ExecSandboxMode::WorkspaceWrite, ..SandboxSettings::default() },
			AcpExecSlot::default(),
			false,
		);
		let session = host
			.open_session(SessionOptions::default())
			.await
			.expect("sandbox session");
		let run = host
			.run(&session, RunRequest {
				command:     sf!("echo approved > .git/approved.txt"),
				environment: BTreeMap::new(),
				timeout_ms:  Some(5_000),
			})
			.await
			.expect("sandboxed command starts");
		(host, session, run, inbox)
	}

	#[cfg(target_os = "macos")]
	async fn pending_sandbox_approval(
		run: &mut SelectedShellRun,
		inbox: &omp_agent::ApprovalInbox,
	) -> omp_agent::ApprovalRequest {
		loop {
			let pending = run.next_event();
			tokio::pin!(pending);
			tokio::select! {
				request = inbox.recv() => return request.expect("sandbox approval ticket"),
				event = &mut pending => match event.expect("sandboxed command event") {
					Some(RunEvent::Started { .. } | RunEvent::Output(_)) => {},
					Some(RunEvent::Exit(status)) => {
						panic!("sandboxed command exited before approval: {status:?}")
					},
					None => panic!("sandboxed command stream closed before approval"),
				},
			}
		}
	}

	#[cfg(target_os = "macos")]
	fn approve_sandbox_amendment(request: omp_agent::ApprovalRequest) {
		request
			.respond(omp_agent::ApprovalDecision {
				approved:   true,
				scope:      omp_agent::ApprovalScope::Once,
				source:     omp_agent::ApprovalSource::User,
				decided_by: Some(sf!("test approver")),
				reason:     None,
				audited:    false,
			})
			.expect("approve sandbox amendment");
	}

	#[cfg(target_os = "macos")]
	async fn assert_cancelled_without_sandbox_amendment(run: &mut SelectedShellRun, root: &Path) {
		let status = loop {
			let event = run
				.next_event()
				.await
				.expect("cancelled sandbox event")
				.expect("cancelled terminal event");
			match event {
				RunEvent::Started { .. } | RunEvent::Output(_) => {},
				RunEvent::Exit(status) => break status,
			}
		};
		assert_eq!(status.outcome, ExecOutcome::Cancelled);
		assert!(status.aborted);
		assert!(
			run.next_event()
				.await
				.expect("closed cancelled stream")
				.is_none(),
			"cancellation must not emit a second execution start"
		);
		assert!(
			!root.join(".git/approved.txt").exists(),
			"cancellation must not permit the approved scoped write"
		);
	}

	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn cancelling_before_sandbox_approval_never_reruns() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		let (host, session, mut run, inbox) = approval_gated_sandbox_run(root.path()).await;
		let request = pending_sandbox_approval(&mut run, &inbox).await;

		run.cancel().await.expect("cancel sandboxed command");

		assert_cancelled_without_sandbox_amendment(&mut run, root.path()).await;
		drop(request);
		host.close_session(&session).await.expect("close session");
	}

	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn cancelling_concurrent_with_sandbox_approval_never_reruns() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		let (host, session, mut run, inbox) = approval_gated_sandbox_run(root.path()).await;
		let request = pending_sandbox_approval(&mut run, &inbox).await;

		let approval = async move { approve_sandbox_amendment(request) };
		let cancellation = run.cancel();
		let (_, result) = tokio::join!(approval, cancellation);
		result.expect("cancel sandboxed command");

		assert_cancelled_without_sandbox_amendment(&mut run, root.path()).await;
		host.close_session(&session).await.expect("close session");
	}

	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn cancelling_after_dropping_pending_sandbox_event_blocks_late_approval() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		let (host, session, mut run, inbox) = approval_gated_sandbox_run(root.path()).await;
		let request = pending_sandbox_approval(&mut run, &inbox).await;

		run.cancel().await.expect("cancel sandboxed command");
		approve_sandbox_amendment(request);

		assert_cancelled_without_sandbox_amendment(&mut run, root.path()).await;
		host.close_session(&session).await.expect("close session");
	}

	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn approved_sandbox_denial_reruns_once_with_scoped_policy() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		std::fs::create_dir(root.path().join(".git")).expect("git carve-out");
		let exec = ExecHost::new();
		let book = Arc::new(omp_agent::ApprovalBook::new());
		let (route, inbox) = omp_agent::ApprovalRoute::new(Arc::clone(&book), None);
		exec.bind_sandbox_approval_route(Some(route));
		let root_uri = Url::from_directory_path(root.path())
			.expect("workspace URI")
			.to_string();
		let host = ShellExecHost::new(
			exec,
			BlobHost::open(root.path().join(".omp-test-blobs")).expect("blob host"),
			Str::from(root_uri),
			Arc::new(ResolverTable::default()),
			ShellSettings::default(),
			SandboxSettings { mode: ExecSandboxMode::WorkspaceWrite, ..SandboxSettings::default() },
			AcpExecSlot::default(),
			false,
		);
		let approver = tokio::spawn(async move {
			let request = inbox.recv().await.expect("sandbox approval ticket");
			let reason = request
				.ticket
				.reasons
				.first()
				.expect("sandbox approval reason");
			assert_eq!(reason.kind, "sandbox_amendment");
			assert!(
				reason
					.pattern
					.as_deref()
					.is_some_and(|command| command == "echo approved > .git/approved.txt")
			);
			assert!(reason.subject.ends_with(".git"));
			assert!(
				reason
					.evidence
					.iter()
					.any(|fact| fact.ends_with(".git/approved.txt"))
			);
			request
				.respond(omp_agent::ApprovalDecision {
					approved:   true,
					scope:      omp_agent::ApprovalScope::Once,
					source:     omp_agent::ApprovalSource::User,
					decided_by: Some(sf!("test approver")),
					reason:     None,
					audited:    false,
				})
				.expect("approve sandbox amendment");
		});

		let session = host
			.open_session(SessionOptions::default())
			.await
			.expect("sandbox session");
		let mut run = host
			.run(&session, RunRequest {
				command:     sf!("echo approved > .git/approved.txt"),
				environment: BTreeMap::new(),
				timeout_ms:  Some(5_000),
			})
			.await
			.expect("sandboxed command starts");
		let mut output = Vec::new();
		let mut starts = 0;
		let status = loop {
			match run.next_event().await.expect("shell event") {
				Some(RunEvent::Started { .. }) => starts += 1,
				Some(RunEvent::Output(update)) => output.extend_from_slice(update.data.as_ref()),
				Some(RunEvent::Exit(status)) => break status,
				None => panic!("shell event stream closed before exit"),
			}
		};
		approver.await.expect("approver task");
		assert_eq!(starts, 2);
		assert_eq!(
			status.outcome,
			ExecOutcome::Exited,
			"output={}",
			String::from_utf8_lossy(&output)
		);
		assert_eq!(status.exit_code, Some(0));
		let output = String::from_utf8_lossy(&output);
		assert!(output.contains("sandbox denied write"));
		assert!(!output.contains("rerun with approved scope"));
		assert!(
			status
				.diags
				.iter()
				.any(|diag| diag.text.contains("sandbox: rerun with approved scope"))
		);
		let mut restored = host
			.run(&session, RunRequest {
				command:     sf!("echo blocked > .git/blocked-again.txt"),
				environment: BTreeMap::new(),
				timeout_ms:  Some(5_000),
			})
			.await
			.expect("restored sandboxed command starts");
		let restored = loop {
			match restored.next_event().await.expect("restored sandbox event") {
				Some(RunEvent::Exit(status)) => break status,
				Some(_) => {},
				None => panic!("restored sandbox event stream closed before exit"),
			}
		};
		assert_eq!(restored.outcome, ExecOutcome::Denied);
		assert!(!root.path().join(".git/blocked-again.txt").exists());
		host.close_session(&session).await.expect("close session");
	}

	#[tokio::test]
	async fn authenticated_pty_denial_is_invocation_local_and_plain_exec_still_runs() {
		use super::super::tools::with_invocation_scope;
		let root = tempfile::tempdir().expect("workspace");
		let host = test_host(root.path());
		let denied_host = host.clone();
		let allowed_host = host.clone();
		let denied = tokio::spawn(with_invocation_scope(true, async move {
			denied_host
				.open_session(SessionOptions { pty: true, ..SessionOptions::default() })
				.await
		}));
		let allowed = tokio::spawn(with_invocation_scope(false, async move {
			allowed_host
				.open_session(SessionOptions { pty: true, ..SessionOptions::default() })
				.await
		}));
		assert_eq!(denied.await.expect("denied scope task"), Err(Fault::PtyDenied));
		let allowed_session = allowed
			.await
			.expect("allowed scope task")
			.expect("unrestricted scope allocates a PTY");
		host
			.close_session(&allowed_session)
			.await
			.expect("close PTY session");

		let plain_session = with_invocation_scope(true, host.open_session(SessionOptions::default()))
			.await
			.expect("denied scope permits non-PTY session");
		let mut run = host
			.run(&plain_session, RunRequest {
				command:     sf!("printf scope-ok"),
				environment: BTreeMap::new(),
				timeout_ms:  Some(5_000),
			})
			.await
			.expect("plain execution starts");
		let mut exited = false;
		while let Some(event) = run.next_event().await.expect("plain execution event") {
			if let RunEvent::Exit(status) = event {
				assert_eq!(status.outcome, ExecOutcome::Exited);
				exited = true;
				break;
			}
		}
		assert!(exited, "plain execution must report terminal status");
		host
			.close_session(&plain_session)
			.await
			.expect("close plain session");
	}
}
