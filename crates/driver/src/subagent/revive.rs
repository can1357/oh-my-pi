//! Reviving a settled `<subagent>` into a live kernel that waits for work.
//!
//! A parked agent comes back over its own session file and accepts prompts
//! again. The child's journal is reopened and its kernel composed exactly as
//! at spawn (ADR 0013 cfg
//! order, ADR 0007 isolation); one loop then drives it: while idle every
//! `Up::Steer`/`Up::Peer` becomes the next turn, `Up::Subscribe` is
//! answered from the child session, and after `sv_task_agent_idle_ttl`
//! without work the loop parks. The parent journal stays the only durable
//! record: `running` on revive, the ordinary settlement when the loop ends
//! (the same [`JobSettlement`] shape the first run produced).

use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_agent::{
	BackgroundToolCancellation, JobBoard, JobSettlement, RunControl, TurnInput, TurnStop, Up,
};
use omp_con::{CfgLoader, ConError, Ctx};
use omp_core::Str;
use omp_dom::{Handle, KnownTag, PropId, PropKey, Tag, Value};
use omp_env::EnvClient;
use omp_session::{Session, SessionError, components::jobs};
use omp_tools::task::ChildResult;
use parking_lot::RwLock;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::{
	settings::{SV_TASK_RECURSION_DEPTH, TaskSettings, child_ctx},
	spawn::{
		SpawnError, child_session_path, configure_child_route, create_isolation, discard_isolation,
		finish_isolation, idle_park_delay,
	},
};
use crate::{
	headless::kernel::{KernelOptions, compose_kernel},
	sessions::{KernelHandle, SessionId, SessionRegistry},
};

/// Why a settled agent could not be brought back.
#[derive(Debug, Error)]
pub enum ReviveError {
	/// No `<subagent>` with this id exists under `<meta><jobs>`.
	#[error("no agent `{id}` in this session")]
	Unknown {
		/// Requested agent id.
		id: Str,
	},
	/// The agent is still running; only settled agents are revived.
	#[error("agent `{id}` is {status} — only finished agents can be revived")]
	Live {
		/// Requested agent id.
		id:     Str,
		/// Current journaled status.
		status: Str,
	},
	/// The child's journal is gone.
	#[error("agent `{id}` has no journal at {}", path.display())]
	MissingJournal {
		/// Requested agent id.
		id:   Str,
		/// Expected journal path.
		path: PathBuf,
	},
	/// Child console configuration failed.
	#[error("child console configuration failed")]
	Con(#[from] ConError),
	/// The parent journal could not record the revival.
	#[error("parent job projection failed")]
	Session(#[from] SessionError),
	/// The parent journal path has no stable session identity.
	#[error("parent session has no stable journal identity")]
	ParentIdentity,
	/// Composition inputs were rejected.
	#[error(transparent)]
	Spawn(#[from] SpawnError),
}

/// Host-owned inputs for reviving one child.
pub struct ReviveRequest<'a> {
	/// Data root used by production composition.
	pub data_dir:     &'a Path,
	/// Parent project root; the child runs in an isolated view of it.
	pub project_root: &'a Path,
	/// Directory holding the child's `.oms`.
	pub sessions_dir: &'a Path,
	/// Shared live-session routing authority.
	pub sessions:     &'a Arc<SessionRegistry>,
	/// Parent's effective convar context.
	pub parent_ctx:   &'a Ctx,
	/// User/project cfg loader.
	pub cfg:          &'a dyn CfgLoader,
	/// Runtime index paired with the parent DOM.
	pub jobs:         &'a JobBoard,
	/// Environment authority for isolated workspace views.
	pub env:          &'a EnvClient,
	/// Model selector used unless the child cfg resolves another route.
	pub model:        &'a str,
	/// The `<subagent id>` to revive.
	pub id:           &'a str,
	/// First prompt to run, or `None` to wait idle for one.
	pub prompt:       Option<Str>,
}

/// Journals `<subagent status=running>` and attaches a live loop over the
/// child's journal to the parent's [`JobBoard`]. Returns once the loop is
/// attached; its settlement is committed by the board like a first run.
pub fn revive_child(parent: &mut Session, request: ReviveRequest<'_>) -> Result<(), ReviveError> {
	let id = Str::new(request.id);
	let (handle, agent, status) =
		subagent(parent, request.id).ok_or_else(|| ReviveError::Unknown { id: id.clone() })?;
	if matches!(status.as_str(), "running" | "starting") {
		return Err(ReviveError::Live { id, status });
	}
	let session_path = child_session_path(request.sessions_dir, &id);
	if !session_path.exists() {
		return Err(ReviveError::MissingJournal { id, path: session_path });
	}
	let depth = SV_TASK_RECURSION_DEPTH.get(request.parent_ctx);
	let ctx = Arc::new(child_ctx(request.parent_ctx, request.cfg, agent.as_str())?);
	SV_TASK_RECURSION_DEPTH.set(&ctx, depth.saturating_add(1))?;
	let settings = TaskSettings::from_con(&ctx);
	configure_child_route(&ctx, &settings, agent.as_str(), None)?;
	if omp_agent::AI_MODEL.get(&ctx).is_empty() {
		omp_agent::AI_MODEL.set(&ctx, Str::new(request.model))?;
	}
	let parent_id = parent
		.journal_path()
		.file_stem()
		.and_then(|value| value.to_str())
		.map(Str::new)
		.ok_or(ReviveError::ParentIdentity)?;
	let cause = parent.head().ok_or(SpawnError::MissingParentHead)?;
	let started = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX));
	parent.patch(jobs::restart(cause, handle, Str::new(started.to_string())))?;
	let child = Revived {
		data_dir: request.data_dir.to_path_buf(),
		sessions_dir: request.sessions_dir.to_path_buf(),
		sessions: Arc::clone(request.sessions),
		env: request.env.clone(),
		ctx,
		settings,
		parent: parent_id,
		id,
		agent,
		session_path,
	};
	let cancel = CancellationToken::new();
	let task = tokio::spawn(live_loop(child, request.prompt, cancel.clone()));
	if !request.jobs.attach_task(parent.dom(), handle, cancel, task) {
		return Err(SpawnError::MissingJobs.into());
	}
	Ok(())
}

/// Finds `<meta><jobs><subagent id=ID>` and reads its class and status.
fn subagent(parent: &Session, id: &str) -> Option<(Handle, Str, Str)> {
	let dom = parent.dom();
	let jobs = jobs::jobs_handle(dom)?;
	dom.children(jobs).iter().find_map(|handle| {
		let node = dom.get(*handle)?;
		if node.tag != Tag::Known(KnownTag::Subagent)
			|| node
				.prop(&PropKey::from(PropId::Id))
				.and_then(Value::as_str)
				!= Some(id)
		{
			return None;
		}
		let agent = node
			.prop(&PropKey::Custom(Str::new_static("agent")))
			.and_then(Value::as_str)
			.map_or_else(|| Str::new_static("task"), Str::new);
		let status = node
			.prop(&PropKey::from(PropId::Status))
			.and_then(Value::as_str)
			.map_or_else(|| Str::new_static("running"), Str::new);
		Some((*handle, agent, status))
	})
}

#[derive(Clone)]
struct Revived {
	data_dir:     PathBuf,
	sessions_dir: PathBuf,
	sessions:     Arc<SessionRegistry>,
	env:          EnvClient,
	ctx:          Arc<Ctx>,
	settings:     TaskSettings,
	parent:       Str,
	id:           Str,
	agent:        Str,
	session_path: PathBuf,
}

struct LiveRun {
	stop:       TurnStop,
	text:       Str,
	tokens_in:  u64,
	tokens_out: u64,
	turns:      u32,
}

async fn live_loop(child: Revived, first: Option<Str>, cancel: CancellationToken) -> JobSettlement {
	let id = child.id.clone();
	let agent = child.agent.clone();
	let session_path = Str::new(child.session_path.to_string_lossy());
	match run_live(child, first, cancel).await {
		Ok((run, workspace)) => {
			let error =
				(run.stop == TurnStop::Cancelled).then(|| Str::new_static("subagent was cancelled"));
			let status = Str::new_static(if run.stop == TurnStop::Cancelled {
				"cancelled"
			} else {
				"completed"
			});
			let result = ChildResult {
				id,
				agent,
				text: run.text,
				description: None,
				assignment: None,
				stats: None,
				session_path,
				tokens_in: run.tokens_in,
				tokens_out: run.tokens_out,
				output: None,
				workspace,
				error: error.clone(),
			};
			JobSettlement {
				status,
				output: serde_json::value::to_raw_value(&result).ok(),
				error,
				completion: None,
			}
		},
		Err(source) => JobSettlement {
			status:     Str::new_static("failed"),
			output:     None,
			error:      Some(Str::new(source.to_string())),
			completion: None,
		},
	}
}

/// Composes the child kernel over its journal and drives prompts until the
/// loop parks, is cancelled, or a turn fails.
async fn run_live(
	child: Revived,
	first: Option<Str>,
	cancel: CancellationToken,
) -> Result<(LiveRun, Option<omp_tools::task::WorkspaceOutcome>), SpawnError> {
	// Every composed child receives mutation-capable tools (ADR 0007).
	let isolation = create_isolation(&child.env, &child.id).await?;
	let run = drive(&child, &isolation.root, first, cancel).await;
	child.sessions.remove(&SessionId::new(child.id.clone()));
	let run = match run {
		Ok(run) => run,
		Err(source) => {
			let _ = discard_isolation(&child.env, isolation).await;
			return Err(source);
		},
	};
	let workspace = if run.stop == TurnStop::Cancelled || run.turns == 0 {
		discard_isolation(&child.env, isolation).await?
	} else {
		finish_isolation(&child.env, isolation, &child.settings).await?
	};
	Ok((run, Some(workspace)))
}

async fn drive(
	child: &Revived,
	run_root: &Path,
	mut prompt: Option<Str>,
	cancel: CancellationToken,
) -> Result<LiveRun, SpawnError> {
	let model = omp_agent::AI_MODEL.get(&child.ctx);
	let options = KernelOptions {
		session: Some(child.session_path.clone()),
		sessions_dir: Some(child.sessions_dir.clone()),
		sessions: Some(Arc::clone(&child.sessions)),
		session_name: Some(child.id.clone()),
		parent_session: Some(child.parent.clone()),
		model_override: true,
		..KernelOptions::default()
	};
	let (mut kernel, mut session, _) =
		compose_kernel(&child.data_dir, run_root, model.as_str(), Arc::clone(&child.ctx), options)
			.await?;
	// `compose_kernel` registered the kernel's own mailbox; between turns
	// nobody drains it, so the live entry points at this loop's inbox and
	// every message is forwarded into the kernel while a turn runs.
	let kernel_up = kernel.mailbox();
	let composed = child
		.sessions
		.lookup(SessionId::from_ref(child.id.as_str()))
		.ok_or_else(|| SpawnError::MissingLiveEndpoint { id: child.id.clone() })?;
	let autoreply = composed.autoreply.clone();
	let (inbox_tx, inbox_rx) = flume::unbounded::<Up>();
	let live = KernelHandle {
		id: SessionId::new(child.id.clone()),
		name: child.id.clone(),
		up: inbox_tx,
		snapshot: Arc::new(RwLock::new(session.dom().snapshot())),
		topology: composed.topology,
		relay: composed.relay,
		autoreply,
	};
	child.sessions.register(child.id.clone(), live.clone());
	let idle_ttl = idle_park_delay(child.settings.agent_idle_ttl_ms);
	let host_cancel = BackgroundToolCancellation::from_token_for_host(cancel.clone());
	let mut run = LiveRun {
		stop:       TurnStop::Completed,
		text:       Str::default(),
		tokens_in:  0,
		tokens_out: 0,
		turns:      0,
	};
	loop {
		let next = match prompt.take() {
			Some(text) => Idle::Prompt(text, Vec::new()),
			None => idle(&inbox_rx, &kernel_up, &mut session, &cancel, idle_ttl).await,
		};
		let (text, attachments, skill) = match next {
			Idle::Prompt(text, attachments) => (text, attachments, None),
			Idle::Skill(prompt) => (prompt.prompt_body.clone(), Vec::new(), Some(prompt)),
			Idle::Park => break,
			Idle::Cancelled => {
				run.stop = TurnStop::Cancelled;
				break;
			},
		};
		let deadline = (child.settings.max_runtime_ms != 0)
			.then(|| std::time::Instant::now() + Duration::from_millis(child.settings.max_runtime_ms));
		let control = RunControl::new(host_cancel.token(), deadline)
			.with_request_budget(child.settings.soft_request_budget)
			.with_request_budget_notice(child.settings.soft_request_budget_notice);
		let outcome = {
			let turn = match skill {
				Some(prompt) => {
					futures::future::Either::Left(kernel.run_skill_turn(&mut session, prompt, control))
				},
				None => futures::future::Either::Right(kernel.run_turn(
					&mut session,
					TurnInput { text, attachments },
					control,
				)),
			};
			tokio::pin!(turn);
			loop {
				tokio::select! {
					outcome = &mut turn => break outcome,
					message = inbox_rx.recv_async() => {
						if let Ok(message) = message {
							let _ = kernel_up.send(message);
						}
					},
				}
			}
		}?;
		live.refresh(&session);
		run.turns += 1;
		run.text = outcome.assistant_text;
		run.tokens_in += outcome.tokens_in;
		run.tokens_out += outcome.tokens_out;
		if outcome.stop == TurnStop::Cancelled {
			run.stop = TurnStop::Cancelled;
			break;
		}
	}
	Ok(run)
}

enum Idle {
	Prompt(Str, Vec<omp_journal::data::Attachment>),
	Skill(omp_journal::data::SkillPrompt),
	Park,
	Cancelled,
}

/// Waits for the next prompt while idle: steering and peer messages become
/// the prompt, subscriptions are answered from the child session, approvals
/// and environment events are handed to the kernel for its next turn, and
/// the idle TTL parks the loop.
async fn idle(
	inbox: &flume::Receiver<Up>,
	kernel_up: &flume::Sender<Up>,
	session: &mut Session,
	cancel: &CancellationToken,
	ttl: Option<Duration>,
) -> Idle {
	let park = tokio::time::sleep(ttl.unwrap_or(Duration::MAX));
	tokio::pin!(park);
	loop {
		tokio::select! {
			() = cancel.cancelled() => return Idle::Cancelled,
			() = &mut park, if !omp_agent::pause_state(session.dom()).active => return Idle::Park,
			message = inbox.recv_async() => match message {
				Ok(Up::Steer { text, attachments } | Up::Queue { text, attachments }) => {
					if omp_agent::pause_state(session.dom()).active {
						if let Err(error) = omp_agent::queue_prompt(session, text, &attachments) {
							tracing::warn!(%error, "paused subagent prompt could not be journaled");
						}
					} else {
						return Idle::Prompt(text, attachments);
					}
				},
				Ok(Up::SkillPrompt(prompt)) => {
					if omp_agent::pause_state(session.dom()).active {
						if let Err(error) = omp_agent::queue_prompt(
							session,
							prompt.prompt_body.clone(),
							&[],
						) {
							tracing::warn!(%error, "paused subagent skill prompt could not be queued");
						}
					} else {
						return Idle::Skill(prompt);
					}
				},
				Ok(Up::Peer(text)) => {
					if omp_agent::pause_state(session.dom()).active {
						if let Err(error) = omp_agent::queue_prompt(session, text, &[]) {
							tracing::warn!(%error, "paused subagent peer message could not be journaled");
						}
					} else {
						return Idle::Prompt(text, Vec::new());
					}
				},
				Ok(Up::Pause { active }) => {
					if let Err(error) = omp_agent::set_paused(session, active) {
						tracing::warn!(%error, "subagent pause transition could not be journaled");
					}
					if !active {
						if let Some(ttl) = ttl {
							park.as_mut().reset(tokio::time::Instant::now() + ttl);
						}
						if let Ok(Some((text, attachments))) = omp_agent::pop_queued_prompt(session) {
							return Idle::Prompt(text, attachments);
						}
					}
				},
				Ok(Up::SessionMutation(request)) => {
					request.apply(session);
				},
				Ok(Up::Subscribe(reply)) => {
					let _ = reply.send(session.subscribe());
				},
				Ok(Up::Unqueue(reply)) => {
					let _ = reply.send(Vec::new());
				},
				Ok(Up::Cancel) => return Idle::Cancelled,
				Ok(Up::Interrupt | Up::AbortTools(_)) => {},
				Ok(
					other @ (Up::SteerAuthored { .. }
					| Up::Approval(_)
					| Up::Approve { .. }
					| Up::Env(_)
					| Up::Autoreply { .. }),
				) => {
					let _ = kernel_up.send(other);
				},
				Err(_) => return Idle::Park,
			},
		}
	}
}
