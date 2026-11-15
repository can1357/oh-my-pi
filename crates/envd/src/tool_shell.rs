use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	future::{self, Future},
	path::Path,
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use omp_core::{CowBytes, Str, encoding::hex, sf};
use omp_exec::{ExecError, ExecEvent};
use omp_proto::env::{
	v1,
	v1::{
		EnvironmentDelta, ExecOutcome as EnvExecOutcome, ExecRequest, OpenSessionRequest,
		OutputChannel as EnvOutputChannel, ProcessSpec, PtySpec, RestartPolicy, RestartSpec, Script,
		ShellProfileInput, StartProcess,
	},
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
use url::Url;

use super::{
	blobs::BlobHost,
	direnv::DirenvDelta,
	exec::{ExecHost, ExecRun},
	exec_settings::{DirenvMode, SandboxSettings, ShellSettings},
	tool_url::UrlResolver,
	tools,
};

/// Shell resource adapter backed by the local execution authority.
#[derive(Clone)]
pub struct ShellExecHost {
	host:      ExecHost,
	blobs:     BlobHost,
	cwd_uri:   Str,
	resolvers: Arc<ResolverTable<UrlResolver>>,
	settings:  ShellSettings,
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
		sandbox: &SandboxSettings,
	) -> Self {
		if let Ok(uri) = Url::parse(&cwd_uri)
			&& let Ok(root) = uri.to_file_path()
		{
			host.configure_sandbox(sandbox, &root);
		}
		Self { host, blobs, cwd_uri, resolvers, settings }
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
			.map_err(|error| cwd_fault_from("workspace root URI is invalid", error))?;
		let root_path = root
			.to_file_path()
			.map_err(|()| cwd_fault("workspace root is not a local file URI"))?;
		let path = match requested {
			None => root_path,
			Some(value) if value.contains("://") => Url::parse(value)
				.map_err(|error| cwd_fault_from("working-directory URI is invalid", error))?
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
/// Creates a working-directory fault, rendering the cause once at this
/// model-facing fault boundary.
fn cwd_fault_from(context: &'static str, cause: impl std::fmt::Display) -> Fault {
	cwd_fault(sf!("{context}: {cause}"))
}
/// Foreground shell run retaining the concrete host's process-tree guard.
pub struct HostShellRun {
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

impl ShellExec for ShellExecHost {
	type Run = HostShellRun;

	async fn open_session(&self, options: SessionOptions) -> Result<Session, Fault> {
		if options.pty && tools::pty_denied() {
			return Err(Fault::PtyDenied);
		}
		let cwd_uri = self.resolve_cwd(options.cwd.as_deref()).await?;
		let pty = options.pty;
		let environment = self
			.environment(&cwd_uri, self.expand_environment(options.env).await?, pty)
			.await;
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
		// A command bash runs for a connection's invocation answers to that
		// invocation: a nested `dyn` call carries its owner, its prompts reach
		// that connection, and its `dyn reflect` synthesizes on that
		// connection's session; an in-process call has no relay and uses the
		// host's own.
		let (_, run) = self
			.host
			.exec_relayed(
				exec_request,
				request.timeout_ms.map(Duration::from_millis),
				request.owner,
				tools::invocation_approvals(),
				tools::invocation_reflection(),
			)
			.await
			.map_err(|error| resource_fault("run", error))?;
		Ok(HostShellRun::new(self.host.clone(), run))
	}

	async fn store_attachment(&self, bytes: Bytes, media_type: Str) -> Result<BlobRef, Fault> {
		let blobs = self.blobs.clone();
		let id = tokio::task::spawn_blocking(move || blobs.put(&bytes))
			.await
			.map_err(attachment_fault)?
			.map_err(attachment_fault)?;
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
				started: false,
				terminal: channel == OutputChannel::Pty,
			}))
		},
		ExecEvent::Exit(event) => {
			let event = *event;
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
				model_text: status
					.projection
					.and_then(|projection| projection.model_text)
					.map(Str::from),
				aborted: status.aborted,
				effects_unknown: false,
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

fn resource_fault(operation: &'static str, error: ExecError) -> Fault {
	protocol_fault(operation, sf!("{error}"))
}

/// Creates an attachment-store fault, rendering the cause once at this
/// model-facing fault boundary.
fn attachment_fault(cause: impl std::fmt::Display) -> Fault {
	Fault::Resource { operation: sf!("store_shell_attachment"), message: sf!("{cause}") }
}

fn protocol_fault(operation: &'static str, message: impl Into<Str>) -> Fault {
	Fault::Resource { operation: sf!(operation), message: message.into() }
}

#[cfg(test)]
mod tests {
	use std::pin::Pin;

	#[cfg(target_os = "macos")]
	use flume::Receiver;
	#[cfg(target_os = "macos")]
	use tokio::task::JoinHandle;

	use super::*;
	use crate::exec_settings::ExecSandboxMode;
	#[cfg(target_os = "macos")]
	use crate::loopback_upstream::{BODY, LoopbackUpstream};

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
			&SandboxSettings::default(),
		)
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn cargo_projection_minimizes_with_retrievable_original_and_other_commands_pass_through() {
		use std::os::unix::fs::PermissionsExt as _;

		use futures::StreamExt as _;
		use omp_tool::{
			CapsBase, Ev, IncomingParams, ModelClass, Part, PromptCaps, Tool as _, ToolTerminal,
		};

		let root = tempfile::tempdir().expect("workspace");
		let output = format!(
			"{}    Finished \x60dev\x60 profile in 0.10s\n",
			"   Compiling example v0.1.0\n".repeat(80)
		);
		let output_path = root.path().join("output");
		std::fs::write(&output_path, output.as_bytes()).expect("write cargo output fixture");
		let cargo = root.path().join("cargo");
		std::fs::write(&cargo, format!("#!/bin/sh\n/bin/cat '{}'\n", output_path.display()))
			.expect("write cargo fixture");
		std::fs::set_permissions(&cargo, std::fs::Permissions::from_mode(0o755))
			.expect("make cargo fixture executable");

		let blobs = BlobHost::open(root.path().join("blobs")).expect("blob host");
		let exec = ExecHost::new().with_output_store(blobs.store().clone());
		let host = ShellExecHost::new(
			exec,
			blobs.clone(),
			Str::from(
				Url::from_directory_path(root.path())
					.expect("workspace URI")
					.to_string(),
			),
			Arc::new(ResolverTable::default()),
			ShellSettings::default(),
			&SandboxSettings { mode: ExecSandboxMode::Off, ..SandboxSettings::default() },
		);
		let tool = omp_tools::shell::shell(host);
		let caps = PromptCaps::for_tool(
			CapsBase {
				maximum_parts:      1,
				maximum_text_bytes: 32 * 1024,
				media:              false,
				model_class:        ModelClass::Standard,
			},
			&tool.spec().rev,
		);
		let path = format!("{}:/usr/bin:/bin", root.path().display());

		for command in [
			"cargo build".to_owned(),
			format!("cat '{}'", output_path.display()),
			"cargo build | cat".to_owned(),
			"cargo build && true".to_owned(),
		] {
			let (feed, params) = IncomingParams::channel();
			feed
				.args_committed(Str::from(
					serde_json::json!({ "command": &command, "env": { "PATH": &path } }).to_string(),
				))
				.expect("commit command arguments");
			let events = tool.call(params);
			futures::pin_mut!(events);
			let payload = loop {
				match events.next().await {
					Some(Ev::Done(ToolTerminal::Done { result, .. })) => {
						break result.expect("command succeeds");
					},
					Some(_) => {},
					None => panic!("shell command ended without a result"),
				}
			};
			let streamed = payload
				.transcript
				.iter()
				.flat_map(|frame| frame.data.as_ref().iter().copied())
				.collect::<Vec<_>>();
			assert_eq!(streamed, output.as_bytes());
			let parts = tool.prompt(Ok(&payload), &caps);
			let [Part::Text { text }] = parts.as_slice() else {
				panic!("expected one text part")
			};
			let visible = text.split_once('\n').expect("status line").1;
			if command == "cargo build" {
				let model_text = payload
					.status
					.model_text
					.as_ref()
					.expect("cargo build projection carries minimized model_text");
				assert!(!model_text.contains("Compiling example"));
				assert!(!visible.contains("Compiling example"));
				assert!(
					visible.len() * 4 < output.len(),
					"model-visible text, artifact line included, must stay well under the raw capture: \
					 {visible:?}"
				);
				let artifact = payload
					.status
					.spilled_output
					.as_ref()
					.expect("original output artifact");
				assert!(visible.contains(&format!("artifact://sha256/{}", artifact.hash)));
				let hash = omp_core::Hash32::sum(output.as_bytes());
				assert_eq!(artifact.hash.as_str(), hash.to_hex().as_str());
				let original = blobs
					.store()
					.get(&omp_journal::blob::BlobRef { hash, size: artifact.byte_len })
					.expect("original output remains retrievable");
				assert_eq!(original.as_ref(), output.as_bytes());
			} else {
				assert_eq!(visible.as_bytes(), output.as_bytes());
				assert!(payload.status.spilled_output.is_none());
				assert!(payload.status.model_text.is_none());
			}
		}
	}

	#[cfg(target_os = "macos")]
	async fn approval_gated_sandbox_run(
		root: &Path,
	) -> (ShellExecHost, Session, HostShellRun, omp_contract::ApprovalInbox) {
		std::fs::create_dir(root.join(".git")).expect("git carve-out");
		let exec = ExecHost::new();
		let book = Arc::new(omp_contract::ApprovalBook::new());
		let (route, inbox) = omp_contract::ApprovalRoute::new(book, None);
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
			&SandboxSettings { mode: ExecSandboxMode::WorkspaceWrite, ..SandboxSettings::default() },
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
				owner:       None,
			})
			.await
			.expect("sandboxed command starts");
		(host, session, run, inbox)
	}

	#[cfg(target_os = "macos")]
	async fn pending_sandbox_approval(
		run: &mut HostShellRun,
		inbox: &omp_contract::ApprovalInbox,
	) -> omp_contract::ApprovalRequest {
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
	fn approve_sandbox_amendment(request: omp_contract::ApprovalRequest) {
		request
			.respond(omp_contract::ApprovalDecision {
				approved:   true,
				scope:      omp_contract::ApprovalScope::Once,
				source:     omp_contract::ApprovalSource::User,
				decided_by: Some(sf!("test approver")),
				reason:     None,
				audited:    false,
			})
			.expect("approve sandbox amendment");
	}

	#[cfg(target_os = "macos")]
	async fn assert_cancelled_without_sandbox_amendment(run: &mut HostShellRun, root: &Path) {
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
		let book = Arc::new(omp_contract::ApprovalBook::new());
		let (route, inbox) = omp_contract::ApprovalRoute::new(Arc::clone(&book), None);
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
			&SandboxSettings { mode: ExecSandboxMode::WorkspaceWrite, ..SandboxSettings::default() },
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
				.respond(omp_contract::ApprovalDecision {
					approved:   true,
					scope:      omp_contract::ApprovalScope::Once,
					source:     omp_contract::ApprovalSource::User,
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
				owner:       None,
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
				owner:       None,
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

	/// What one command run to its exit produced.
	#[cfg(target_os = "macos")]
	struct Settled {
		starts: usize,
		status: ExecStatus,
		output: String,
	}

	#[cfg(target_os = "macos")]
	async fn run_to_exit(host: &ShellExecHost, session: &Session, command: &str) -> Settled {
		let mut run = host
			.run(session, RunRequest {
				command:     Str::from(command),
				environment: BTreeMap::new(),
				timeout_ms:  Some(30_000),
				owner:       None,
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
		Settled { starts, status, output: String::from_utf8_lossy(&output).into_owned() }
	}

	/// A host whose bound route answers every sandbox amendment.
	#[cfg(target_os = "macos")]
	struct AmendingHost {
		host:     ShellExecHost,
		/// Each prompt's subject and offered scopes, in order.
		prompts:  Receiver<(Str, Vec<Str>)>,
		approver: JoinHandle<()>,
	}

	/// A host whose bound route answers every sandbox amendment with `scope`,
	/// under a workspace-write sandbox whose scoped broker may reach loopback
	/// and refuses the hosts in `deny`.
	#[cfg(target_os = "macos")]
	fn network_amendment_host(
		root: &Path,
		scope: omp_contract::ApprovalScope,
		deny: &[&'static str],
	) -> AmendingHost {
		let exec = ExecHost::new();
		let (route, inbox) =
			omp_contract::ApprovalRoute::new(Arc::new(omp_contract::ApprovalBook::new()), None);
		exec.bind_sandbox_approval_route(Some(route));
		let (asked, prompts) = flume::unbounded();
		let approver = tokio::spawn(async move {
			while let Ok(request) = inbox.recv().await {
				let reason = request.ticket.reasons.first().expect("amendment reason");
				assert_eq!(reason.kind, "sandbox_amendment");
				let _ = asked.send((reason.subject.clone(), reason.scopes.clone()));
				request
					.respond(omp_contract::ApprovalDecision {
						approved:   true,
						scope:      scope.clone(),
						source:     omp_contract::ApprovalSource::User,
						decided_by: Some(sf!("test approver")),
						reason:     None,
						audited:    false,
					})
					.expect("answer the amendment");
			}
		});
		let root_uri = Url::from_directory_path(root)
			.expect("workspace URI")
			.to_string();
		let host = ShellExecHost::new(
			exec,
			BlobHost::open(root.join(".omp-test-blobs")).expect("blob host"),
			Str::from(root_uri),
			Arc::new(ResolverTable::default()),
			ShellSettings::default(),
			&SandboxSettings {
				mode: ExecSandboxMode::WorkspaceWrite,
				allow_localhost: true,
				deny_domains: deny.iter().copied().map(Str::new_static).collect(),
				..SandboxSettings::default()
			},
		);
		AmendingHost { host, prompts, approver }
	}

	/// The pip pattern under Seatbelt: one command needs host A and then host
	/// B, neither allowlisted. Approving each for the session finishes it in
	/// one call, two prompts and three runs, and later commands, in this shell
	/// or another of the same host, reach both without a prompt.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn session_network_grants_chain_reruns_and_outlive_the_command() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		let (first, second) = (LoopbackUpstream::serve(), LoopbackUpstream::serve());
		let command = format!("{} && {}", first.fetch(), second.fetch());
		let AmendingHost { host, prompts, approver } =
			network_amendment_host(root.path(), omp_contract::ApprovalScope::Session, &[]);
		let session = host
			.open_session(SessionOptions::default())
			.await
			.expect("sandbox session");

		let pip = run_to_exit(&host, &session, &command).await;
		let asked = prompts.drain().collect::<Vec<_>>();
		let session_scopes = vec![sf!("once"), sf!("session")];
		assert_eq!(
			asked,
			[
				(sf!("network localhost:{}", first.port()), session_scopes.clone()),
				(sf!("network localhost:{}", second.port()), session_scopes),
			],
			"one prompt per new host, in order: {}",
			pip.output
		);
		assert_eq!(pip.starts, 3, "one call, three runs: {}", pip.output);
		assert_eq!(pip.status.outcome, ExecOutcome::Exited, "{}", pip.output);
		assert_eq!(pip.status.exit_code, Some(0));
		// The second run printed host A's answer before host B was refused, so
		// a rerun repeats what ran before the refusal.
		assert_eq!(pip.output, BODY.repeat(3), "{}", pip.output);
		let approved = pip
			.status
			.diags
			.iter()
			.filter(|diag| diag.text.contains("approved for this session"))
			.map(|diag| diag.text.as_str())
			.collect::<Vec<_>>();
		assert_eq!(approved.len(), 2, "{approved:?}");
		assert!(approved[1].contains("rerun 2 of at most 4"), "{approved:?}");

		let again = run_to_exit(&host, &session, &command).await;
		assert_eq!(again.starts, 1, "{}", again.output);
		assert_eq!(again.status.exit_code, Some(0), "{}", again.output);
		let other = host
			.open_session(SessionOptions::default())
			.await
			.expect("second sandbox session");
		let elsewhere = run_to_exit(&host, &other, &command).await;
		assert_eq!(elsewhere.starts, 1, "{}", elsewhere.output);
		assert_eq!(elsewhere.status.exit_code, Some(0), "{}", elsewhere.output);
		assert!(
			prompts.is_empty(),
			"a granted endpoint prompted again: {:?}",
			prompts.drain().collect::<Vec<_>>()
		);

		host.close_session(&other).await.expect("close session");
		host.close_session(&session).await.expect("close session");
		approver.abort();
	}

	/// The same command with each prompt answered `once`: the approved rerun
	/// reaches host A, but its refusal of host B is final, as a once approval
	/// ends the chain.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn once_network_grants_still_end_the_chain_after_one_rerun() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		let (first, second) = (LoopbackUpstream::serve(), LoopbackUpstream::serve());
		let command = format!("{} && {}", first.fetch(), second.fetch());
		let AmendingHost { host, prompts, approver } =
			network_amendment_host(root.path(), omp_contract::ApprovalScope::Once, &[]);
		let session = host
			.open_session(SessionOptions::default())
			.await
			.expect("sandbox session");

		let once = run_to_exit(&host, &session, &command).await;
		let asked = prompts
			.drain()
			.map(|(subject, _)| subject)
			.collect::<Vec<_>>();
		assert_eq!(asked, [sf!("network localhost:{}", first.port())], "{}", once.output);
		assert_eq!(once.starts, 2, "{}", once.output);
		assert_eq!(once.status.outcome, ExecOutcome::Denied, "{}", once.output);
		let refused = sf!("localhost:{}", second.port());
		assert!(
			once
				.status
				.diags
				.iter()
				.any(|diag| diag.text.contains(refused.as_str())),
			"the final denial names host B: {:?}",
			once.status.diags
		);
		assert!(
			!once
				.status
				.diags
				.iter()
				.any(|diag| diag.text.contains("approved for this session")),
			"{:?}",
			once.status.diags
		);
		host.close_session(&session).await.expect("close session");
		approver.abort();
	}

	/// An explicit `sv_sandbox_deny_domains` entry beats every approval: the
	/// refused host is never offered for approval, even to a binding that
	/// approves everything for the session, and the network diag names the deny
	/// list as the cause.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn deny_listed_hosts_are_never_offered_for_approval() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		let upstream = LoopbackUpstream::serve();
		let AmendingHost { host, prompts, approver } =
			network_amendment_host(root.path(), omp_contract::ApprovalScope::Session, &["localhost"]);
		let session = host
			.open_session(SessionOptions::default())
			.await
			.expect("sandbox session");

		let denied = run_to_exit(&host, &session, &upstream.fetch()).await;
		assert!(
			prompts.is_empty(),
			"a deny-listed host was offered: {:?}",
			prompts.drain().collect::<Vec<_>>()
		);
		assert_eq!(denied.starts, 1, "{}", denied.output);
		// curl fails on the broker's 403; no amendable fact makes it a denial.
		assert_eq!(denied.status.outcome, ExecOutcome::Failed, "{}", denied.output);
		let endpoint = sf!("localhost:{}", upstream.port());
		assert!(
			denied.status.diags.iter().any(|diag| {
				diag.text.contains(endpoint.as_str())
					&& diag.text.contains("sv_sandbox_deny_domains")
					&& diag.text.contains("no prompt is offered")
			}),
			"{:?}",
			denied.status.diags
		);
		host.close_session(&session).await.expect("close session");
		approver.abort();
	}

	/// Editor peer that fails the test if the shell ever reaches it.
	struct UntouchedEditor(std::sync::atomic::AtomicUsize);

	impl crate::docs::AcpDocumentBackend for UntouchedEditor {
		fn deadline(&self) -> std::time::Duration {
			std::time::Duration::from_secs(5)
		}

		fn read_text(
			&self,
			_absolute_path: Str,
		) -> Pin<Box<dyn Future<Output = Result<Str, crate::docs::EditorIoError>> + Send + '_>> {
			self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
			Box::pin(future::ready(Ok(Str::from(""))))
		}

		fn capabilities(&self) -> crate::docs::EditorCapabilities {
			crate::docs::EditorCapabilities { read: true, write: true }
		}

		fn write_back(
			&self,
			_write_back: crate::docs::WriteBack,
		) -> Pin<
			Box<
				dyn Future<Output = Result<crate::docs::WriteBackOutcome, crate::docs::EditorIoError>>
					+ Send
					+ '_,
			>,
		> {
			self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
			Box::pin(future::ready(Ok(crate::docs::WriteBackOutcome::Superseded)))
		}
	}

	#[tokio::test]
	async fn shell_commands_run_in_process_under_an_acp_editor_scope() {
		use super::super::tools::{InvocationAcpBackends, with_acp_scope};
		let root = tempfile::tempdir().expect("workspace");
		let host = test_host(root.path());
		let editor = Arc::new(UntouchedEditor(std::sync::atomic::AtomicUsize::new(0)));
		let scope = InvocationAcpBackends::new(Some(crate::editor_base::EditorRoute::new(
			Arc::clone(&editor) as Arc<dyn crate::docs::AcpDocumentBackend>,
			Arc::new(crate::editor_base::EditorSession::new(
				std::time::Duration::from_secs(5),
				crate::docs::EditorCapabilities { read: true, write: true },
			)),
		)));
		let (events, outcome) = with_acp_scope(scope, async {
			let session = host
				.open_session(SessionOptions::default())
				.await
				.expect("session opens in the local host");
			assert!(
				!session.id.starts_with(b"acp:"),
				"ACP scopes must not mint editor-owned shell sessions"
			);
			let mut run = host
				.run(&session, RunRequest {
					command:     sf!("printf acp-shell-ok"),
					environment: BTreeMap::new(),
					timeout_ms:  Some(5_000),
					owner:       None,
				})
				.await
				.expect("command starts in the in-process shell");
			let mut output = Vec::new();
			let mut started = 0;
			let status = loop {
				match run.next_event().await.expect("shell event") {
					Some(RunEvent::Started { .. }) => started += 1,
					Some(RunEvent::Output(update)) => output.extend_from_slice(update.data.as_ref()),
					Some(RunEvent::Exit(status)) => break status,
					None => panic!("shell event stream closed before exit"),
				}
			};
			host.close_session(&session).await.expect("close session");
			((started, output), status)
		})
		.await;
		assert_eq!(events.0, 1);
		assert_eq!(String::from_utf8_lossy(&events.1), "acp-shell-ok");
		assert_eq!(outcome.outcome, ExecOutcome::Exited);
		assert_eq!(outcome.exit_code, Some(0));
		assert_eq!(
			editor.0.load(std::sync::atomic::Ordering::SeqCst),
			0,
			"shell execution must never reach the editor peer"
		);
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
				owner:       None,
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
