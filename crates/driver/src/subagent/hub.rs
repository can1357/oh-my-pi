//! Session-owned `hub@1` operations over live kernel mailboxes and the DOM.

use std::{
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_agent::{
	AutoreplyRequest, CallControl, EnvEvent, JobBoard, JobSettlement, Received, SessionAuthority,
	SessionEndpoint, SessionRole, SessionTool, SessionToolCx, SessionToolFuture, Up,
};
use omp_core::{EnvPath, Str, Ulid, sf};
use omp_dom::{Handle, KnownTag, Op, PropId, PropKey, Tag, Txn, Value};
use omp_env::{EnvClient, ProcessAttachmentEvent};
use omp_journal::data::{
	IrcDirection, IrcTraffic, LaunchDaemonCompletion, LaunchDaemonFault, LaunchDaemonFaultKind,
	LaunchDaemonStatus,
};
use omp_proto::{
	SCHEMA_REV,
	env::v1::{
		AttachOutput, EnvironmentDelta, ExecOutcome, ListProcesses, ProcessInfo, ProcessSpec,
		ProcessState, PtySpec, ReadyLog, ReadyProbe, ReadyTcp, RestartPolicy as WireRestartPolicy,
		RestartProcess, RestartSpec, Script, SendInput, SignalProcess, StartProcess, StopProcess,
		ready_probe, send_input,
	},
};
use omp_session::components::jobs::{self, JobSpec};
use omp_tool::{CallOutcome, ToolSpec};
use omp_tools::hub::{Fault, HubBackend, Op as HubOp, Params, Request, Response, RestartPolicy};
use tokio_util::sync::CancellationToken;

const PROCESS_WAIT_BUFFER_BYTES: usize = 64 * 1024;

/// Declaration-only backend; kernel session routing intercepts every call.
pub struct HubDeclarationBackend;

impl HubBackend for HubDeclarationBackend {
	async fn execute<'a>(
		&'a self,
		_caller_id: &'a str,
		_request: Request,
		_updates: &'a flume::Sender<Response>,
	) -> Result<Response, Fault> {
		Err(Fault { message: sf!("hub session dispatcher is unavailable") })
	}
}

/// Stateless host operations shared by the model-facing hub tool and native
/// embeddings.
pub struct SessionHub;

impl SessionHub {
	/// Sends one steering item through the target kernel mailbox.
	pub fn send(
		authority: &dyn SessionAuthority,
		from: &str,
		to: &str,
		message: Str,
		reply_to: Option<Str>,
	) -> Result<Response, omp_agent::SessionToolError> {
		send_to(authority, from, to, message, reply_to, false)
	}

	/// Sends one peer message whose recipient owes a threaded reply.
	pub fn send_expecting_reply(
		authority: &dyn SessionAuthority,
		from: &str,
		to: &str,
		message: Str,
		reply_to: Option<Str>,
	) -> Result<Response, omp_agent::SessionToolError> {
		send_to(authority, from, to, message, reply_to, true)
	}

	/// Reads or drains the caller's journal-backed steering inbox.
	pub fn inbox(
		session: &mut omp_session::Session,
		peek: bool,
	) -> Result<Response, omp_agent::SessionToolError> {
		inbox(session, peek)
	}
}

/// Session-authority hub implementation.
pub struct HubSessionTool {
	env:          EnvClient,
	project_root: PathBuf,
	caller_id:    Str,
	con:          Arc<omp_con::Ctx>,
	spec:         ToolSpec,
}

impl HubSessionTool {
	/// Creates the canonical session hub.
	#[must_use]
	pub fn new(
		env: EnvClient,
		project_root: PathBuf,
		caller_id: Str,
		con: Arc<omp_con::Ctx>,
	) -> Self {
		Self { env, project_root, caller_id, con, spec: omp_tools::hub::spec() }
	}

	fn message_timeout_ms(&self) -> u64 {
		crate::subagent::settings::SV_IRC_TIMEOUT
			.get(&self.con)
			.as_finite()
			.and_then(|duration| duration.to_std().ok())
			.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
	}
}

impl SessionTool for HubSessionTool {
	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'a>(
		&'a self,
		cx: SessionToolCx<'a>,
		args: Box<serde_json::value::RawValue>,
	) -> SessionToolFuture<'a> {
		Box::pin(async move {
			let mut value: serde_json::Value = serde_json::from_str(args.get())?;
			if let Some(object) = value.as_object_mut() {
				object.remove("i");
			}
			let params: Params = serde_json::from_value(value)?;
			let params = match omp_tools::hub::validate(params, self.caller_id.as_str()) {
				Ok(request) => request.params,
				Err(fault) => {
					let fault = serde_json::value::to_raw_value(&fault)?;
					return Ok(CallOutcome::Faulted(fault));
				},
			};
			cx.jobs.rebuild(cx.session);
			cx.jobs.poll(cx.session)?;
			let response = match params.op {
				HubOp::Send if params.name.is_some() => {
					process_send(&self.env, &params).await.map_err(fault_text)
				},
				HubOp::Send if params.await_reply => {
					match send(cx.authority, self.caller_id.as_str(), &params) {
						Ok(_) => wait_peer(
							cx.session,
							cx.control,
							params
								.timeout_ms
								.unwrap_or_else(|| self.message_timeout_ms()),
						)
						.await
						.map_err(fault_text),
						Err(error) => Err(fault_text(error)),
					}
				},
				HubOp::Send => send(cx.authority, self.caller_id.as_str(), &params).map_err(fault_text),
				HubOp::Inbox => inbox(cx.session, params.peek).map_err(fault_text),
				HubOp::Wait => {
					wait(cx.session, cx.jobs, cx.control, &self.env, &params, self.message_timeout_ms())
						.await
						.map_err(fault_text)
				},
				HubOp::List => list(cx.authority, params.limit).map_err(fault_text),
				HubOp::Jobs => roster(cx.jobs).map_err(fault_text),
				HubOp::Cancel => cancel(cx.session, cx.jobs, params.ids.as_deref().unwrap_or_default())
					.await
					.map_err(fault_text),
				HubOp::Start => process_start(
					cx.session,
					cx.jobs,
					&self.env,
					&self.project_root,
					self.caller_id.as_str(),
					&params,
				)
				.await
				.map_err(fault_text),
				HubOp::Ps => process_list(cx.session, cx.jobs, &self.env)
					.await
					.map_err(fault_text),
				HubOp::Logs => process_logs(&self.env, &params).await.map_err(fault_text),
				HubOp::Stop => process_stop(cx.session, cx.jobs, &self.env, &params)
					.await
					.map_err(fault_text),
				HubOp::Restart => {
					process_restart(cx.session, cx.jobs, &self.env, self.caller_id.as_str(), &params)
						.await
						.map_err(fault_text)
				},
				HubOp::Describe => process_describe(&self.env, &params)
					.await
					.map_err(fault_text),
			};
			match response {
				Ok(response) => {
					let payload = serde_json::value::to_raw_value(&response)?;
					Ok(CallOutcome::Ok(payload))
				},
				Err(fault) => {
					let fault = serde_json::value::to_raw_value(&fault)?;
					Ok(CallOutcome::Faulted(fault))
				},
			}
		})
	}
}

fn fault_text(error: impl std::fmt::Display) -> Fault {
	Fault { message: Str::new(error.to_string()) }
}

fn send(
	authority: Option<&dyn SessionAuthority>,
	caller_id: &str,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let authority = authority.ok_or_else(|| omp_agent::SessionToolError::Rejected {
		message: Str::new_static("live session authority is not attached"),
	})?;
	let target = params
		.to
		.as_deref()
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new_static("hub send requires `to`"),
		})?;
	let message = params
		.message
		.clone()
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new_static("hub send requires `message`"),
		})?;
	send_to(authority, caller_id, target, message, params.reply_to.clone(), params.await_reply)
}

fn send_to(
	authority: &dyn SessionAuthority,
	caller_id: &str,
	target: &str,
	message: Str,
	reply_to: Option<Str>,
	expects_reply: bool,
) -> Result<Response, omp_agent::SessionToolError> {
	let from = authority
		.lookup(caller_id)
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new_static("calling session is not live"),
		})?;
	let delivered = if target == "all" {
		let endpoints = authority.list();
		let suppress_relay = endpoints
			.iter()
			.any(|endpoint| endpoint.topology.role == SessionRole::Main);
		endpoints
			.into_iter()
			.filter(|endpoint| {
				deliver_request(
					authority,
					endpoint,
					&from,
					message.clone(),
					reply_to.clone(),
					expects_reply,
					suppress_relay,
				)
			})
			.count()
	} else {
		usize::from(authority.lookup(target).is_some_and(|endpoint| {
			deliver_request(authority, &endpoint, &from, message, reply_to, expects_reply, false)
		}))
	};
	if delivered == 0 {
		return Err(omp_agent::SessionToolError::Rejected {
			message: Str::new_static("target session is not live"),
		});
	}
	Ok(Response {
		text:    Str::new(serde_json::json!({ "delivered": delivered }).to_string()),
		useless: false,
	})
}

fn deliver_request(
	authority: &dyn SessionAuthority,
	target: &SessionEndpoint,
	from: &SessionEndpoint,
	body: Str,
	reply_to: Option<Str>,
	expects_reply: bool,
	suppress_relay: bool,
) -> bool {
	let request = expects_reply.then(|| AutoreplyRequest {
		message_id: Str::new(Ulid::generate().to_string()),
		from_id:    from.id.clone(),
		from:       from.name.clone(),
		to_id:      target.id.clone(),
		to:         target.name.clone(),
		body:       body.clone(),
		reply_to:   reply_to.clone(),
	});
	if !deliver_authenticated_peer(
		authority,
		target,
		from,
		body,
		reply_to,
		unix_timestamp_ms(),
		suppress_relay,
	) {
		return false;
	}
	if let (Some(request), Some(producer)) = (request, target.autoreply.as_ref()) {
		let _ = producer.start(request);
	}
	true
}

pub(crate) fn deliver_authenticated_peer(
	authority: &dyn SessionAuthority,
	target: &SessionEndpoint,
	from: &SessionEndpoint,
	body: Str,
	reply_to: Option<Str>,
	timestamp_ms: u64,
	suppress_relay: bool,
) -> bool {
	let incoming = IrcTraffic {
		direction: IrcDirection::Incoming,
		from: Some(from.name.clone()),
		to: Some(target.name.clone()),
		body: body.clone(),
		reply_to: reply_to.clone(),
		pool: None,
		mode: None,
		timestamp_ms,
	};
	// The mailbox is FIFO per sender. The typed observation reaches the
	// recipient before the ordinary model input; the main relay below is
	// display-only and never receives `Up::Peer`.
	if target
		.up
		.send(Up::Env(EnvEvent::IrcTraffic { payload: Arc::new(incoming) }))
		.is_err()
		|| target.up.send(Up::Peer(body.clone())).is_err()
	{
		return false;
	}
	if !suppress_relay && let Some(main) = authority.relay_target(from, target) {
		let relay = IrcTraffic {
			direction: IrcDirection::Relay,
			from: Some(from.name.clone()),
			to: Some(target.name.clone()),
			body,
			reply_to,
			pool: None,
			mode: None,
			timestamp_ms,
		};
		// Observation failure is deliberately isolated from successful peer
		// delivery. A disconnected main never makes child traffic fail.
		let _ = main
			.up
			.send(Up::Env(EnvEvent::IrcTraffic { payload: Arc::new(relay) }));
	}
	true
}

fn unix_timestamp_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

fn list(
	authority: Option<&dyn SessionAuthority>,
	limit: Option<u16>,
) -> Result<Response, omp_agent::SessionToolError> {
	let authority = authority.ok_or_else(|| omp_agent::SessionToolError::Rejected {
		message: Str::new_static("live session authority is not attached"),
	})?;
	let limit = usize::from(limit.unwrap_or(omp_tools::hub::DEFAULT_LIST_LIMIT as u16))
		.min(omp_tools::hub::MAX_LIST_LIMIT);
	let rows = authority
		.list()
		.into_iter()
		.take(limit)
		.map(|endpoint| serde_json::json!({ "id": endpoint.id, "name": endpoint.name }))
		.collect::<Vec<_>>();
	let useless = rows.is_empty();
	Ok(Response { text: Str::new(serde_json::json!({ "sessions": rows }).to_string()), useless })
}

/// The `<queues><steering>` element.
fn steering_queue(session: &omp_session::Session) -> Result<Handle, omp_agent::SessionToolError> {
	session
		.dom()
		.children(session.dom().queues())
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Steering))
		})
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new_static("session steering queue is absent"),
		})
}

/// Queued peer messages (`hub=true`), oldest first. User steering shares the
/// queue but belongs to the kernel safe point, never to the hub inbox.
fn peer_messages(session: &omp_session::Session, steering: Handle) -> Vec<(Handle, Str)> {
	let hub = PropKey::Custom(Str::new_static("hub"));
	session
		.dom()
		.children(steering)
		.iter()
		.filter_map(|handle| {
			let node = session.dom().get(*handle)?;
			matches!(node.prop(&hub), Some(Value::Bool(true)))
				.then(|| node.content.clone())
				.flatten()
				.map(|text| (*handle, text))
		})
		.collect()
}

fn inbox(
	session: &mut omp_session::Session,
	peek: bool,
) -> Result<Response, omp_agent::SessionToolError> {
	let steering = steering_queue(session)?;
	let peers = peer_messages(session, steering);
	let messages = peers
		.iter()
		.map(|(_, text)| text.as_str())
		.collect::<Vec<_>>();
	let useless = messages.is_empty();
	let text = Str::new(serde_json::json!({ "messages": messages }).to_string());
	if !peek && !useless {
		let cause = session
			.head()
			.ok_or_else(|| omp_agent::SessionToolError::Rejected {
				message: Str::new_static("session has no journal head"),
			})?;
		let ops = peers.iter().map(|(handle, _)| Op::Rm(*handle)).collect();
		session
			.patch(Txn { cause, label: Some(Str::new_static("hub.inbox")), ops })
			.map_err(|_| omp_agent::SessionToolError::Rejected {
				message: Str::new_static("failed to journal inbox drain"),
			})?;
	}
	Ok(Response { text, useless })
}

fn roster(jobs: &JobBoard) -> Result<Response, omp_agent::SessionToolError> {
	let rows = jobs
		.list()
		.into_iter()
		.map(|job| {
			serde_json::json!({
				"id": job.id,
				"kind": job.kind.to_string(),
				"status": job.status,
				"owner": job.owner,
				"started": job.started,
				"output": job.output,
				"error": job.error,
			})
		})
		.collect::<Vec<_>>();
	let useless = rows.is_empty();
	Ok(Response { text: Str::new(serde_json::json!({ "jobs": rows }).to_string()), useless })
}

async fn cancel(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	ids: &[Str],
) -> Result<Response, omp_agent::SessionToolError> {
	let handles = jobs
		.list()
		.into_iter()
		.filter(|job| ids.contains(&job.id))
		.map(|job| job.handle)
		.collect::<Vec<_>>();
	let mut cancelled = 0;
	for handle in handles {
		cancelled += usize::from(jobs.terminate(session, handle).await?);
	}
	Ok(Response {
		text:    Str::new(serde_json::json!({ "cancelled": cancelled }).to_string()),
		useless: false,
	})
}

async fn wait_peer(
	session: &mut omp_session::Session,
	control: Option<&CallControl>,
	timeout: u64,
) -> Result<Response, omp_agent::SessionToolError> {
	let deadline =
		(timeout != 0).then(|| tokio::time::Instant::now() + Duration::from_millis(timeout));
	loop {
		if let Some(message) = pop_inbox_message(session)? {
			return Ok(Response {
				text:    Str::new(serde_json::json!({ "messages": [message] }).to_string()),
				useless: false,
			});
		}
		let sleep = async {
			match deadline {
				Some(deadline) => tokio::time::sleep_until(deadline).await,
				None => std::future::pending().await,
			}
		};
		let Some(control) = control else {
			sleep.await;
			return Ok(Response { text: Str::new_static(r#"{"timeout":true}"#), useless: true });
		};
		tokio::select! {
			message = control.recv() => {
				if control.handle(session, message)? == Received::Cancelled {
					return Err(omp_agent::SessionToolError::Rejected {
						message: Str::new_static("hub wait was cancelled"),
					});
				}
			},
			() = sleep => {
				return Ok(Response { text: Str::new_static(r#"{"timeout":true}"#), useless: true });
			},
		}
	}
}

async fn wait(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	control: Option<&CallControl>,
	env: &EnvClient,
	params: &Params,
	message_timeout_ms: u64,
) -> Result<Response, omp_agent::SessionToolError> {
	if params.name.is_some() {
		return process_wait(session, control, env, params).await;
	}
	let selected = params
		.ids
		.clone()
		.filter(|ids| !ids.is_empty())
		.unwrap_or_else(|| {
			jobs
				.list()
				.into_iter()
				.filter(|job| matches!(job.status.as_str(), "starting" | "running"))
				.map(|job| job.id)
				.collect()
		});
	let timeout = params.timeout_ms.unwrap_or(if selected.is_empty() {
		message_timeout_ms
	} else {
		120_000
	});
	let deadline =
		(timeout != 0).then(|| tokio::time::Instant::now() + Duration::from_millis(timeout));
	loop {
		jobs.poll(session)?;
		if let Some(message) = pop_inbox_message(session)? {
			return Ok(Response {
				text:    Str::new(serde_json::json!({ "messages": [message] }).to_string()),
				useless: false,
			});
		}
		if !selected.is_empty()
			&& let Some(job) = selected_settled_job(jobs, Some(&selected))
		{
			return Ok(Response {
				text:    Str::new(
					serde_json::json!({
						"job": {
							"id": job.id,
							"kind": job.kind.to_string(),
							"status": job.status,
							"output": job.output,
							"error": job.error,
						}
					})
					.to_string(),
				),
				useless: false,
			});
		}
		let sleep = async {
			match deadline {
				Some(deadline) => {
					let tick = tokio::time::Instant::now() + Duration::from_millis(25);
					tokio::time::sleep_until(tick.min(deadline)).await;
				},
				None => tokio::time::sleep(Duration::from_millis(25)).await,
			}
		};
		if let Some(control) = control {
			tokio::select! {
				message = control.recv() => {
					let received = control.handle(session, message)?;
					if received == Received::Cancelled {
						return Err(omp_agent::SessionToolError::Rejected {
							message: Str::new_static("hub wait was cancelled"),
						});
					}
				},
				() = sleep => {},
			}
		} else {
			sleep.await;
		}
		if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
			return Ok(Response { text: Str::new_static(r#"{"timeout":true}"#), useless: true });
		}
	}
}

fn selected_settled_job(jobs: &JobBoard, ids: Option<&[Str]>) -> Option<omp_agent::JobRecord> {
	jobs.list().into_iter().find(|job| {
		ids.is_none_or(|ids| ids.is_empty() || ids.contains(&job.id))
			&& !matches!(job.status.as_str(), "running" | "starting")
	})
}

fn pop_inbox_message(
	session: &mut omp_session::Session,
) -> Result<Option<Str>, omp_agent::SessionToolError> {
	let steering = steering_queue(session)?;
	let Some((handle, message)) = peer_messages(session, steering).into_iter().next() else {
		return Ok(None);
	};
	let cause = session
		.head()
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new_static("session has no journal head"),
		})?;
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("hub.wait.message")),
		ops: vec![Op::Rm(handle)],
	})?;
	Ok(Some(message))
}

async fn process_start(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	env: &EnvClient,
	project_root: &Path,
	owner: &str,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let name = required_name(params)?;
	let application =
		params
			.application
			.as_deref()
			.ok_or_else(|| omp_agent::SessionToolError::Rejected {
				message: Str::new_static("hub start requires `application`"),
			})?;
	let cwd_path = params.cwd.as_deref().map(PathBuf::from).map_or_else(
		|| project_root.to_path_buf(),
		|path| {
			if path.is_absolute() {
				path
			} else {
				project_root.join(path)
			}
		},
	);
	let cwd_url = url::Url::from_file_path(&cwd_path).map_err(|()| {
		omp_agent::SessionToolError::Rejected { message: Str::new_static("process cwd is invalid") }
	})?;
	let cwd = EnvPath::new(Str::new(cwd_url.as_str())).map_err(|_| {
		omp_agent::SessionToolError::Rejected {
			message: Str::new_static("process cwd is not an environment path"),
		}
	})?;
	if let Some(handle) = job_handle(session, name) {
		let _ = jobs.terminate(session, handle).await?;
	}
	let start = process_start_request(name, application, params);
	let started = env.start_process(&cwd, start).await.map_err(|error| {
		omp_agent::SessionToolError::Rejected { message: Str::new(error.to_string()) }
	})?;
	let process = find_process(env, name).await?;
	if process.generation != started.generation {
		return Err(omp_agent::SessionToolError::Rejected {
			message: Str::new_static("started process generation was not observable"),
		});
	}
	attach_process_job(session, jobs, env, owner, name)?;
	Ok(Response {
		text:    Str::new(
			serde_json::json!({
				"name": process.name,
				"generation": process.generation,
				"pid": process.identity.as_ref().map(|identity| identity.pid),
				"endpoint": process.endpoint,
				"status": process.state().as_str_name().to_ascii_lowercase(),
			})
			.to_string(),
		),
		useless: false,
	})
}

fn process_start_request(name: &str, application: &str, params: &Params) -> StartProcess {
	let mut command = shell_quote(application);
	for argument in params.args.as_deref().unwrap_or_default() {
		command.push(' ');
		command.push_str(&shell_quote(argument));
	}
	let ready_timeout = params
		.ready
		.as_ref()
		.and_then(|ready| ready.timeout)
		.map_or(30_000, seconds_millis);
	let mut probes = Vec::new();
	if let Some(pattern) = params.ready.as_ref().and_then(|ready| ready.log.as_ref()) {
		probes.push(ReadyProbe {
			probe:      Some(ready_probe::Probe::Log(ReadyLog {
				pattern: pattern.to_string(),
				props:   None,
			})),
			timeout_ms: ready_timeout,
			props:      None,
		});
	}
	if let Some(port) = params.ready.as_ref().and_then(|ready| ready.port) {
		probes.push(ReadyProbe {
			probe:      Some(ready_probe::Probe::Tcp(ReadyTcp {
				host:  params
					.ready
					.as_ref()
					.and_then(|ready| ready.host.as_ref())
					.map_or_else(|| String::from("127.0.0.1"), ToString::to_string),
				port:  u32::from(port),
				props: None,
			})),
			timeout_ms: ready_timeout,
			props:      None,
		});
	}
	let detached = params.detached;
	StartProcess {
		name:  name.to_owned(),
		spec:  Some(ProcessSpec {
			source: Some(Script { text: command, props: None }),
			env_delta: Some(EnvironmentDelta {
				set:   params
					.env
					.clone()
					.unwrap_or_default()
					.into_iter()
					.map(|(name, value)| (name.to_string(), value.to_string()))
					.collect(),
				unset: Vec::new(),
				props: None,
			}),
			pty: (params.pty.unwrap_or(true) && !detached).then(|| PtySpec {
				rows:     24,
				columns:  120,
				terminal: String::from("xterm-256color"),
				props:    None,
			}),
			restart: Some(RestartSpec {
				policy: match params.restart.unwrap_or(RestartPolicy::No) {
					RestartPolicy::No => WireRestartPolicy::Never as i32,
					RestartPolicy::OnFailure => WireRestartPolicy::OnFailure as i32,
					RestartPolicy::Always => WireRestartPolicy::Always as i32,
				},
				..RestartSpec::default()
			}),
			detached,
			persist: params.persist || detached,
			timeout_ms: params
				.timeout
				.map(seconds_millis)
				.filter(|timeout| *timeout != 0),
			..ProcessSpec::default()
		}),
		ready: probes,
		props: None,
	}
}

fn attach_process_job(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	env: &EnvClient,
	owner: &str,
	name: &str,
) -> Result<(), omp_agent::SessionToolError> {
	let handle = job_handle(session, name);
	let handle = match handle {
		Some(handle) => {
			let cause = session
				.head()
				.ok_or_else(|| omp_agent::SessionToolError::Rejected {
					message: Str::new_static("session has no journal head"),
				})?;
			session.patch(jobs::set_status(cause, handle, "running"))?;
			handle
		},
		None => {
			let cause = session
				.head()
				.ok_or_else(|| omp_agent::SessionToolError::Rejected {
					message: Str::new_static("session has no journal head"),
				})?;
			let started = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map_err(|error| omp_agent::SessionToolError::Rejected {
					message: Str::new(error.to_string()),
				})?
				.as_millis()
				.to_string();
			session.patch(
				jobs::insert(session.dom(), cause, JobSpec {
					id:      Str::new(name),
					kind:    Str::new_static("process"),
					owner:   Str::new(owner),
					started: Str::new(started),
					agent:   None,
				})
				.ok_or_else(|| omp_agent::SessionToolError::Rejected {
					message: Str::new_static("session jobs component is absent"),
				})?,
			)?;
			job_handle(session, name).ok_or_else(|| omp_agent::SessionToolError::Rejected {
				message: Str::new_static("process job was not projected"),
			})?
		},
	};
	let env = env.clone();
	let name = name.to_owned();
	let first = Arc::new(AtomicBool::new(true));
	if !jobs.attach_restartable(session.dom(), handle, move |cancel| {
		let initial = first.swap(false, Ordering::AcqRel);
		spawn_process_task(env.clone(), name.clone(), initial, cancel)
	}) {
		return Err(omp_agent::SessionToolError::Rejected {
			message: Str::new_static("process job could not be attached"),
		});
	}
	Ok(())
}

fn spawn_process_task(
	env: EnvClient,
	name: String,
	initial: bool,
	cancel: CancellationToken,
) -> tokio::task::JoinHandle<JobSettlement> {
	tokio::spawn(async move {
		match monitor_process(&env, &name, initial, cancel).await {
			Ok(process) => process_settlement(process),
			Err(error) => {
				let message = Str::new(error.to_string());
				JobSettlement {
					status:     Str::new_static("failed"),
					output:     None,
					error:      Some(message.clone()),
					completion: Some(LaunchDaemonCompletion {
						name:        Str::new(name),
						status:      LaunchDaemonStatus::Failed,
						exit_code:   None,
						duration_ms: 0,
						fault:       Some(LaunchDaemonFault {
							kind:    LaunchDaemonFaultKind::Supervisor,
							message: Some(message),
							signal:  None,
						}),
					}),
				}
			},
		}
	})
}

async fn monitor_process(
	env: &EnvClient,
	name: &str,
	initial: bool,
	cancel: CancellationToken,
) -> Result<ProcessInfo, omp_agent::SessionToolError> {
	let mut process = find_process(env, name).await?;
	if !initial && terminal_process(&process) {
		let started = env
			.restart_process(RestartProcess {
				name:          name.to_owned(),
				generation:    process.generation,
				wire_revision: SCHEMA_REV,
				props:         None,
			})
			.await
			.map_err(env_error)?;
		process = find_process(env, name).await?;
		if process.generation != started.generation {
			return Err(omp_agent::SessionToolError::Rejected {
				message: Str::new_static("restarted process generation was not observable"),
			});
		}
	}
	if terminal_process(&process) {
		return Ok(process);
	}
	let mut attachment = env
		.attach_output(AttachOutput {
			name:             name.to_owned(),
			after_sequence:   process.log_end_offset,
			generation:       process.generation,
			max_bytes:        1,
			terminal_text:    false,
			terminal_columns: 1,
			terminal_rows:    1,
			props:            None,
		})
		.await
		.map_err(env_error)?;
	let mut stopping = false;
	loop {
		tokio::select! {
			() = cancel.cancelled(), if !stopping => {
				stopping = true;
				env.stop_process(StopProcess {
					name: name.to_owned(),
					grace_ms: 5_000,
					generation: process.generation,
					props: None,
				})
				.await
				.map_err(env_error)?;
			},
			event = attachment.next_event() => match event.map_err(env_error)? {
				Some(ProcessAttachmentEvent::State(state)) => {
					let Some(next) = state.process else { continue };
					if terminal_process(&next) {
						return Ok(next);
					}
				},
				Some(ProcessAttachmentEvent::Attached(_) | ProcessAttachmentEvent::Output(_)) => {},
				None => {
					let current = find_process(env, name).await?;
					return Ok(current);
				},
			}
		}
	}
}

fn process_settlement(process: ProcessInfo) -> JobSettlement {
	let execution = process.status.as_ref();
	let exit_code = execution.and_then(|status| status.exit_code);
	let outcome = execution
		.and_then(|status| ExecOutcome::try_from(status.outcome).ok())
		.unwrap_or(ExecOutcome::Unspecified);
	let completed = process.state() == ProcessState::Exited
		&& exit_code.is_none_or(|code| code == 0)
		&& matches!(outcome, ExecOutcome::Unspecified | ExecOutcome::Exited);
	let fault_kind = if completed {
		None
	} else {
		Some(match outcome {
			ExecOutcome::Timeout => LaunchDaemonFaultKind::Timeout,
			ExecOutcome::Cancelled => LaunchDaemonFaultKind::Cancelled,
			ExecOutcome::Denied => LaunchDaemonFaultKind::Denied,
			ExecOutcome::Failed | ExecOutcome::Exited => LaunchDaemonFaultKind::Failed,
			ExecOutcome::Unspecified if process.state() == ProcessState::Stopped => {
				LaunchDaemonFaultKind::Cancelled
			},
			ExecOutcome::Unspecified
				if process.state() == ProcessState::Failed
					|| exit_code.is_some_and(|code| code != 0) =>
			{
				LaunchDaemonFaultKind::Failed
			},
			ExecOutcome::Unspecified => LaunchDaemonFaultKind::Supervisor,
		})
	};
	let signal = execution
		.map(|status| status.signal.as_str())
		.filter(|signal| !signal.is_empty())
		.map(Str::new);
	let completion = LaunchDaemonCompletion {
		name: Str::new(process.name),
		status: if completed {
			LaunchDaemonStatus::Completed
		} else {
			LaunchDaemonStatus::Failed
		},
		exit_code,
		duration_ms: execution.map_or(0, |status| status.wall_clock_ms),
		fault: fault_kind.map(|kind| LaunchDaemonFault { kind, message: None, signal }),
	};
	JobSettlement {
		status:     Str::new_static(if completed { "completed" } else { "failed" }),
		output:     None,
		error:      None,
		completion: Some(completion),
	}
}

async fn process_list(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	env: &EnvClient,
) -> Result<Response, omp_agent::SessionToolError> {
	let processes = env
		.list_processes(ListProcesses::default())
		.await
		.map_err(env_error)?;
	sync_process_statuses(session, jobs, &processes.processes)?;
	let rows = processes
		.processes
		.iter()
		.map(process_json)
		.collect::<Vec<_>>();
	Ok(Response {
		useless: rows.is_empty(),
		text:    Str::new(serde_json::json!({ "processes": rows }).to_string()),
	})
}

async fn process_describe(
	env: &EnvClient,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let process = find_process(env, required_name(params)?).await?;
	Ok(Response { text: Str::new(process_json(&process).to_string()), useless: false })
}

async fn process_restart(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	env: &EnvClient,
	owner: &str,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let name = required_name(params)?;
	let process = find_process(env, name).await?;
	if let Some(handle) = job_handle(session, name) {
		let _ = jobs.terminate(session, handle).await?;
	}
	let started = env
		.restart_process(RestartProcess {
			name:          name.to_owned(),
			generation:    process.generation,
			wire_revision: SCHEMA_REV,
			props:         None,
		})
		.await
		.map_err(env_error)?;
	attach_process_job(session, jobs, env, owner, name)?;
	Ok(Response {
		text:    Str::new(
			serde_json::json!({
				"name": started.name,
				"generation": started.generation,
				"status": "restarted",
			})
			.to_string(),
		),
		useless: false,
	})
}

async fn process_stop(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	env: &EnvClient,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let name = required_name(params)?;
	let process = find_process(env, name).await?;
	let grace_ms = params.timeout.map_or(5_000, seconds_millis);
	let settled = if terminal_process(&process) {
		process
	} else {
		let mut attachment = env
			.attach_output(AttachOutput {
				name:             name.to_owned(),
				after_sequence:   process.log_end_offset,
				generation:       process.generation,
				max_bytes:        1,
				terminal_text:    false,
				terminal_columns: 1,
				terminal_rows:    1,
				props:            None,
			})
			.await
			.map_err(env_error)?;
		env.stop_process(StopProcess {
			name: name.to_owned(),
			grace_ms,
			generation: process.generation,
			props: None,
		})
		.await
		.map_err(env_error)?;
		let deadline =
			tokio::time::Instant::now() + Duration::from_millis(grace_ms) + Duration::from_secs(2);
		loop {
			let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
			if remaining.is_zero() {
				return Err(omp_agent::SessionToolError::Rejected {
					message: sf!(
						"process `{name}` generation {} did not stop after bounded cleanup",
						process.generation
					),
				});
			}
			let event = tokio::time::timeout(remaining, attachment.next_event())
				.await
				.map_err(|_| omp_agent::SessionToolError::Rejected {
					message: sf!(
						"process `{name}` generation {} did not stop after bounded cleanup",
						process.generation
					),
				})?
				.map_err(env_error)?;
			let Some(event) = event else {
				break find_process(env, name).await?;
			};
			if let ProcessAttachmentEvent::State(state) = event
				&& let Some(info) = state.process
				&& terminal_process(&info)
			{
				break info;
			}
		}
	};
	sync_process_statuses(session, jobs, std::slice::from_ref(&settled))?;
	Ok(Response {
		text:    Str::new(
			serde_json::json!({
				"name": name,
				"generation": settled.generation,
				"status": settled.state().as_str_name().to_ascii_lowercase(),
				"process": process_json(&settled),
			})
			.to_string(),
		),
		useless: false,
	})
}

async fn process_send(
	env: &EnvClient,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let name = required_name(params)?;
	let process = find_process(env, name).await?;
	if let Some(signal) = params.signal {
		env.signal_process(SignalProcess {
			name:       name.to_owned(),
			signal:     signal_name(signal).to_owned(),
			generation: process.generation,
			props:      None,
		})
		.await
		.map_err(env_error)?;
	} else {
		let mut text = params.text.as_deref().unwrap_or_default().to_owned();
		for key in params.keys.as_deref().unwrap_or_default() {
			text.push_str(control_key(key).ok_or_else(|| omp_agent::SessionToolError::Rejected {
				message: Str::new(format!("unsupported process key `{key}`")),
			})?);
		}
		if params.enter.unwrap_or(params.text.is_some()) {
			text.push('\n');
		}
		if text.is_empty() {
			return Err(omp_agent::SessionToolError::Rejected {
				message: Str::new_static("hub send requires process `text`, `keys`, or `signal`"),
			});
		}
		env.send_process_input(SendInput {
			name:       name.to_owned(),
			input:      Some(send_input::Input::Data(text.into_bytes().into())),
			generation: process.generation,
			props:      None,
		})
		.await
		.map_err(env_error)?;
	}
	Ok(Response {
		text:    Str::new(serde_json::json!({ "name": name, "accepted": true }).to_string()),
		useless: false,
	})
}

async fn process_logs(
	env: &EnvClient,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let name = required_name(params)?;
	let process = find_process(env, name).await?;
	let mut attachment = env
		.attach_output(AttachOutput {
			name:             name.to_owned(),
			after_sequence:   params.cursor.unwrap_or(0),
			generation:       process.generation,
			max_bytes:        1024 * 1024,
			terminal_text:    false,
			terminal_columns: 120,
			terminal_rows:    u32::from(params.lines.unwrap_or(100)),
			props:            None,
		})
		.await
		.map_err(env_error)?;
	let filter = params
		.grep
		.as_deref()
		.map(regex::Regex::new)
		.transpose()
		.map_err(|error| omp_agent::SessionToolError::Rejected {
			message: Str::new(error.to_string()),
		})?;
	let timeout = params
		.timeout
		.map_or(Duration::from_secs(30), Duration::from_secs_f64);
	let deadline = params.follow.then(|| tokio::time::Instant::now() + timeout);
	let mut bytes = Vec::new();
	let mut cursor = params.cursor.unwrap_or(0);
	let mut observed_output = false;
	let mut current_process = process.clone();
	loop {
		let now = tokio::time::Instant::now();
		if deadline.is_some_and(|deadline| now >= deadline) {
			break;
		}
		let quiet = if params.follow {
			let remaining = deadline
				.map(|deadline| deadline.saturating_duration_since(now))
				.unwrap_or(timeout);
			if observed_output {
				remaining.min(Duration::from_millis(50))
			} else {
				remaining
			}
		} else if bytes.is_empty() {
			Duration::from_secs(1)
		} else {
			Duration::from_millis(50)
		};
		let next = tokio::time::timeout(quiet, attachment.next_event()).await;
		let event = match next {
			Ok(Ok(Some(event))) => event,
			Ok(Ok(None)) | Err(_) => break,
			Ok(Err(error)) => return Err(env_error(error)),
		};
		match event {
			ProcessAttachmentEvent::Output(output) => {
				observed_output = true;
				cursor = cursor.max(output.sequence);
				if bytes.len() < 1024 * 1024 {
					let remaining = 1024 * 1024 - bytes.len();
					bytes.extend_from_slice(&output.data[..output.data.len().min(remaining)]);
				}
			},
			ProcessAttachmentEvent::State(state) => {
				if let Some(next) = state.process {
					let terminal = terminal_process(&next);
					current_process = next;
					if terminal {
						break;
					}
				}
			},
			ProcessAttachmentEvent::Attached(_) => {},
		}
		if !params.follow && !bytes.is_empty() {
			continue;
		}
	}
	let mut lines = String::from_utf8_lossy(&bytes)
		.lines()
		.filter(|line| filter.as_ref().is_none_or(|filter| filter.is_match(line)))
		.map(ToOwned::to_owned)
		.collect::<Vec<_>>();
	let limit = usize::from(params.lines.unwrap_or(100));
	if lines.len() > limit {
		if params.head {
			lines.truncate(limit);
		} else {
			lines.drain(..lines.len() - limit);
		}
	}
	Ok(Response {
		text:    Str::new(
			serde_json::json!({
				"name": name,
				"generation": current_process.generation,
				"state": current_process.state().as_str_name().to_ascii_lowercase(),
				"cursor": cursor,
				"timedOut": params.follow && !observed_output,
				"logs": lines,
			})
			.to_string(),
		),
		useless: lines.is_empty(),
	})
}

async fn process_wait(
	session: &mut omp_session::Session,
	control: Option<&CallControl>,
	env: &EnvClient,
	params: &Params,
) -> Result<Response, omp_agent::SessionToolError> {
	let name = required_name(params)?;
	let process = find_process(env, name).await?;
	let lifecycle = params.wait_for.as_deref().unwrap_or("exit");
	let pattern = params
		.pattern
		.as_deref()
		.map(regex::Regex::new)
		.transpose()
		.map_err(|error| omp_agent::SessionToolError::Rejected {
			message: Str::new(error.to_string()),
		})?;
	if pattern.is_none() && process_matches_wait(&process, lifecycle) {
		return Ok(Response {
			text:    Str::new(serde_json::json!({ "process": process_json(&process) }).to_string()),
			useless: false,
		});
	}
	if pattern.is_none() && lifecycle == "ready" && terminal_process(&process) {
		return Ok(Response {
			text:    Str::new(
				serde_json::json!({
					"timeout": true,
					"process": process_json(&process),
				})
				.to_string(),
			),
			useless: true,
		});
	}
	let mut attachment = env
		.attach_output(AttachOutput {
			name:             name.to_owned(),
			after_sequence:   if pattern.is_some() {
				process.log_start_offset
			} else {
				process.log_end_offset
			},
			generation:       process.generation,
			max_bytes:        1024 * 1024,
			terminal_text:    false,
			terminal_columns: 120,
			terminal_rows:    100,
			props:            None,
		})
		.await
		.map_err(env_error)?;
	let timeout = params.timeout.map_or(30.0, |seconds| seconds);
	let deadline =
		(timeout != 0.0).then(|| tokio::time::Instant::now() + Duration::from_secs_f64(timeout));
	let mut generation_checks = tokio::time::interval(Duration::from_millis(50));
	generation_checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
	let mut pattern_buffer = Vec::new();
	loop {
		let next = attachment.next_event();
		tokio::pin!(next);
		let sleep = async {
			match deadline {
				Some(deadline) => tokio::time::sleep_until(deadline).await,
				None => std::future::pending().await,
			}
		};
		let event = if let Some(control) = control {
			tokio::select! {
				event = &mut next => Some(event.map_err(env_error)?),
				message = control.recv() => {
					let received = control.handle(session, message)?;
					if received == Received::Cancelled {
						return Err(omp_agent::SessionToolError::Rejected {
							message: Str::new_static("hub wait was cancelled"),
						});
					}
					None
				},
				_ = generation_checks.tick(), if pattern.is_some() => None,
				() = sleep => {
					return Ok(Response {
						text: Str::new(
							serde_json::json!({
								"timeout": true,
								"process": process_json(&process),
							})
							.to_string(),
						),
						useless: true,
					});
				},
			}
		} else {
			tokio::select! {
				event = &mut next => Some(event.map_err(env_error)?),
				_ = generation_checks.tick(), if pattern.is_some() => None,
				() = sleep => {
					return Ok(Response {
						text: Str::new(
							serde_json::json!({
								"timeout": true,
								"process": process_json(&process),
							})
							.to_string(),
						),
						useless: true,
					});
				},
			}
		};
		let Some(event) = event.flatten() else {
			if pattern.is_some() {
				match find_process(env, name).await {
					Ok(current) if current.generation == process.generation => {},
					Ok(_) | Err(_) => return Err(replaced_process_wait(name, process.generation)),
				}
			}
			if let Some(message) = pop_inbox_message(session)? {
				return Ok(Response {
					text:    Str::new(serde_json::json!({ "messages": [message] }).to_string()),
					useless: false,
				});
			}
			continue;
		};
		match event {
			ProcessAttachmentEvent::Output(output) if pattern.is_some() => {
				pattern_buffer.extend_from_slice(&output.data);
				if pattern_buffer.len() > PROCESS_WAIT_BUFFER_BYTES {
					let discard = pattern_buffer.len() - PROCESS_WAIT_BUFFER_BYTES;
					pattern_buffer.drain(..discard);
				}
				let text = String::from_utf8_lossy(&pattern_buffer);
				let matched = pattern
					.as_ref()
					.and_then(|pattern| pattern.find(&text))
					.map(|matched| matched.as_str().chars().take(500).collect::<String>());
				if let Some(matched) = matched {
					return Ok(Response {
						text:    Str::new(
							serde_json::json!({
								"name": name,
								"generation": output.generation,
								"matched": matched,
								"cursor": output.sequence,
							})
							.to_string(),
						),
						useless: false,
					});
				}
			},
			ProcessAttachmentEvent::State(state) => {
				let Some(info) = state.process else { continue };
				if info.generation != process.generation || info.restart_count > process.restart_count {
					return Err(replaced_process_wait(name, process.generation));
				}
				if pattern.is_none() && process_matches_wait(&info, lifecycle) {
					return Ok(Response {
						text:    Str::new(
							serde_json::json!({ "process": process_json(&info) }).to_string(),
						),
						useless: false,
					});
				}
				if pattern.is_none() && lifecycle == "ready" && terminal_process(&info) {
					return Ok(Response {
						text:    Str::new(
							serde_json::json!({
								"timeout": true,
								"process": process_json(&info),
							})
							.to_string(),
						),
						useless: true,
					});
				}
			},
			ProcessAttachmentEvent::Attached(_) | ProcessAttachmentEvent::Output(_) => {},
		}
	}
}

async fn find_process(
	env: &EnvClient,
	name: &str,
) -> Result<ProcessInfo, omp_agent::SessionToolError> {
	env.list_processes(ListProcesses::default())
		.await
		.map_err(env_error)?
		.processes
		.into_iter()
		.find(|process| process.name == name)
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new(format!("unknown process `{name}`")),
		})
}

fn required_name(params: &Params) -> Result<&str, omp_agent::SessionToolError> {
	params
		.name
		.as_deref()
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new_static("process operation requires `name`"),
		})
}

fn process_json(process: &ProcessInfo) -> serde_json::Value {
	serde_json::json!({
		"name": process.name,
		"generation": process.generation,
		"state": process.state().as_str_name().to_ascii_lowercase(),
		"outcome": process.status.as_ref().map(|status| {
			ExecOutcome::try_from(status.outcome)
				.unwrap_or(ExecOutcome::Unspecified)
				.as_str_name()
				.strip_prefix("EXEC_OUTCOME_")
				.unwrap_or("UNSPECIFIED")
				.to_ascii_lowercase()
		}),
		"exitCode": process.status.as_ref().and_then(|status| status.exit_code),
		"signal": process.status.as_ref().map(|status| status.signal.as_str()),
		"durationMs": process.status.as_ref().map(|status| status.wall_clock_ms),
		"pid": process.identity.as_ref().map(|identity| identity.pid),
		"logStart": process.log_start_offset,
		"logEnd": process.log_end_offset,
		"readyMatch": process.ready_match,
		"readyPending": process.ready_pending,
		"restartCount": process.restart_count,
		"consecutiveFailures": process.consecutive_failures,
		"endpoint": process.endpoint,
		"spec": process.spec.as_ref().map(process_spec_json),
		"ready": process.ready.iter().map(ready_probe_json).collect::<Vec<_>>(),
	})
}

fn process_spec_json(spec: &ProcessSpec) -> serde_json::Value {
	let restart = spec.restart.as_ref().map(|restart| {
		WireRestartPolicy::try_from(restart.policy)
			.unwrap_or(WireRestartPolicy::Unspecified)
			.as_str_name()
			.strip_prefix("RESTART_POLICY_")
			.unwrap_or("UNSPECIFIED")
			.to_ascii_lowercase()
			.replace('_', "-")
	});
	serde_json::json!({
		"command": spec.source.as_ref().map(|source| source.text.as_str()),
		"cwd": spec.cwd_uri,
		"envKeys": spec
			.env_delta
			.as_ref()
			.map(|delta| delta.set.keys().collect::<Vec<_>>()),
		"pty": spec.pty.is_some(),
		"restart": restart,
		"persist": spec.persist,
		"detached": spec.detached,
		"timeoutMs": spec.timeout_ms,
	})
}

fn ready_probe_json(probe: &ReadyProbe) -> serde_json::Value {
	match probe.probe.as_ref() {
		Some(ready_probe::Probe::Log(log)) => serde_json::json!({
			"log": log.pattern,
			"timeoutMs": probe.timeout_ms,
		}),
		Some(ready_probe::Probe::Tcp(tcp)) => serde_json::json!({
			"host": tcp.host,
			"port": tcp.port,
			"timeoutMs": probe.timeout_ms,
		}),
		Some(ready_probe::Probe::Ping(ping)) => serde_json::json!({
			"ping": ping.nonce,
			"timeoutMs": probe.timeout_ms,
		}),
		None => serde_json::json!({"timeoutMs": probe.timeout_ms}),
	}
}

fn replaced_process_wait(name: &str, generation: u64) -> omp_agent::SessionToolError {
	omp_agent::SessionToolError::Rejected {
		message: sf!(
			"process `{name}` generation {generation} ended before the wait completed; refusing to \
			 continue against a replacement generation"
		),
	}
}

fn terminal_process(process: &ProcessInfo) -> bool {
	matches!(process.state(), ProcessState::Exited | ProcessState::Stopped | ProcessState::Failed)
}

fn process_matches_wait(process: &ProcessInfo, lifecycle: &str) -> bool {
	match lifecycle {
		"ready" => matches!(process.state(), ProcessState::Ready | ProcessState::Running),
		"exit" => terminal_process(process),
		_ => false,
	}
}

fn sync_process_statuses(
	session: &mut omp_session::Session,
	jobs: &JobBoard,
	processes: &[ProcessInfo],
) -> Result<(), omp_agent::SessionToolError> {
	for process in processes {
		let status = match process.state() {
			ProcessState::Starting => "starting",
			ProcessState::Ready | ProcessState::Running => "running",
			ProcessState::Exited => "completed",
			ProcessState::Stopped => "cancelled",
			ProcessState::Failed => "failed",
			ProcessState::Unspecified => continue,
		};
		set_job_status(session, process.name.as_str(), status)?;
	}
	jobs.rebuild(session);
	Ok(())
}

fn set_job_status(
	session: &mut omp_session::Session,
	id: &str,
	status: &str,
) -> Result<(), omp_agent::SessionToolError> {
	let Some(handle) = job_handle(session, id) else {
		return Ok(());
	};
	let current = session
		.dom()
		.get(handle)
		.and_then(|node| node.prop(&PropKey::from(PropId::Status)))
		.and_then(Value::as_str);
	if current == Some(status) {
		return Ok(());
	}
	let cause = session
		.head()
		.ok_or_else(|| omp_agent::SessionToolError::Rejected {
			message: Str::new_static("session has no journal head"),
		})?;
	session.patch(jobs::set_status(cause, handle, status))?;
	Ok(())
}

fn job_handle(session: &omp_session::Session, id: &str) -> Option<Handle> {
	let root = jobs::jobs_handle(session.dom())?;
	session.dom().children(root).iter().copied().find(|handle| {
		session
			.dom()
			.get(*handle)
			.and_then(|node| node.prop(&PropKey::from(PropId::Id)))
			.and_then(Value::as_str)
			== Some(id)
	})
}

fn env_error(error: omp_env::ClientError) -> omp_agent::SessionToolError {
	omp_agent::SessionToolError::Rejected { message: Str::new(error.to_string()) }
}

fn seconds_millis(seconds: f64) -> u64 {
	if !seconds.is_finite() || seconds <= 0.0 {
		0
	} else {
		Duration::from_secs_f64(seconds)
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX)
	}
}

fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

fn signal_name(signal: omp_tools::hub::Signal) -> &'static str {
	match signal {
		omp_tools::hub::Signal::Sigint => "SIGINT",
		omp_tools::hub::Signal::Sigterm => "SIGTERM",
		omp_tools::hub::Signal::Sighup => "SIGHUP",
		omp_tools::hub::Signal::Sigquit => "SIGQUIT",
		omp_tools::hub::Signal::Sigkill => "SIGKILL",
	}
}

fn control_key(key: &str) -> Option<&'static str> {
	match key {
		"ENTER" => Some("\r"),
		"TAB" => Some("\t"),
		"ESCAPE" => Some("\u{1b}"),
		"CTRL_C" => Some("\u{3}"),
		"CTRL_D" => Some("\u{4}"),
		"UP" => Some("\u{1b}[A"),
		"DOWN" => Some("\u{1b}[B"),
		"LEFT" => Some("\u{1b}[D"),
		"RIGHT" => Some("\u{1b}[C"),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn params(value: serde_json::Value) -> Params {
		let params: Params = serde_json::from_value(value).expect("hub params");
		omp_tools::hub::validate(params, "Main")
			.expect("valid hub params")
			.params
	}

	#[test]
	fn start_request_preserves_both_readiness_probes_and_detached_policy() {
		let params = params(serde_json::json!({
			"op": "start",
			"name": "worker",
			"application": "printf",
			"args": ["hello world"],
			"ready": {"log": "hello", "port": 4321, "timeout": 2.5},
			"restart": "on-failure",
			"detached": true
		}));
		let start = process_start_request("worker", "printf", &params);
		assert_eq!(start.ready.len(), 2);
		assert!(start.ready.iter().all(|probe| probe.timeout_ms == 2_500));
		let rendered = process_json(&ProcessInfo {
			name: String::from("worker"),
			spec: start.spec.clone(),
			ready: start.ready.clone(),
			..ProcessInfo::default()
		});
		assert_eq!(rendered["spec"]["detached"], true);
		assert_eq!(rendered["spec"]["persist"], true);
		assert_eq!(rendered["spec"]["restart"], "on-failure");
		assert_eq!(rendered["ready"].as_array().map(Vec::len), Some(2));
		let spec = start.spec.expect("process spec");
		assert!(spec.pty.is_none());
		assert!(spec.persist);
		assert!(spec.detached);
		assert_eq!(spec.restart.expect("restart").policy, WireRestartPolicy::OnFailure as i32);
		assert_eq!(spec.source.expect("source").text, "'printf' 'hello world'");
	}

	#[test]
	fn process_wait_classifies_ready_and_every_terminal_state() {
		let process = |state| ProcessInfo { state: state as i32, ..ProcessInfo::default() };
		assert!(process_matches_wait(&process(ProcessState::Ready), "ready"));
		assert!(
			process_matches_wait(&process(ProcessState::Running), "ready"),
			"a process without explicit probes is ready once it is running"
		);
		for state in [ProcessState::Exited, ProcessState::Stopped, ProcessState::Failed] {
			assert!(process_matches_wait(&process(state), "exit"));
		}
		assert!(!process_matches_wait(&process(ProcessState::Running), "exit"));
	}

	#[test]
	fn process_settlement_preserves_terminal_status_exit_duration_and_fault() {
		let process = |state, outcome, exit_code, signal: &str| ProcessInfo {
			name: Str::new_static("web").to_string(),
			state: state as i32,
			status: Some(omp_proto::env::v1::ExecStatusMsg {
				outcome: outcome as i32,
				exit_code,
				signal: signal.to_owned(),
				wall_clock_ms: 1_234,
				..Default::default()
			}),
			..ProcessInfo::default()
		};

		let success =
			process_settlement(process(ProcessState::Exited, ExecOutcome::Exited, Some(0), ""))
				.completion
				.expect("completion");
		assert_eq!(success.status, LaunchDaemonStatus::Completed);
		assert_eq!(success.exit_code, Some(0));
		assert_eq!(success.duration_ms, 1_234);
		assert!(success.fault.is_none());

		let nonzero =
			process_settlement(process(ProcessState::Exited, ExecOutcome::Exited, Some(17), ""))
				.completion
				.expect("completion");
		assert_eq!(nonzero.status, LaunchDaemonStatus::Failed);
		assert_eq!(nonzero.fault.expect("nonzero fault").kind, LaunchDaemonFaultKind::Failed);

		let timeout =
			process_settlement(process(ProcessState::Failed, ExecOutcome::Timeout, None, "SIGKILL"))
				.completion
				.expect("completion");
		let fault = timeout.fault.expect("timeout fault");
		assert_eq!(fault.kind, LaunchDaemonFaultKind::Timeout);
		assert_eq!(fault.signal.as_deref(), Some("SIGKILL"));

		let stopped = process_settlement(process(
			ProcessState::Stopped,
			ExecOutcome::Unspecified,
			None,
			"SIGTERM",
		))
		.completion
		.expect("completion");
		assert_eq!(stopped.fault.expect("stopped fault").kind, LaunchDaemonFaultKind::Cancelled);
	}

	#[test]
	fn process_input_keys_map_to_pty_control_sequences() {
		assert_eq!(control_key("CTRL_C"), Some("\u{3}"));
		assert_eq!(control_key("UP"), Some("\u{1b}[A"));
		assert_eq!(control_key("not-a-key"), None);
	}

	#[test]
	fn shell_arguments_are_single_quote_safe() {
		assert_eq!(shell_quote("a'b"), "'a'\\''b'");
	}
}
