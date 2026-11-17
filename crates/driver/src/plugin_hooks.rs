//! Claude-format plugin hooks on the generic hook surface.
//!
//! Installed plugins declare Claude Code hooks (`hooks/hooks.json`, manifest
//! `hooks`); [`omp_ext::claude_hooks`] parses them and maps each event onto
//! an omp lifecycle seam. [`PluginHookHost`] is one in-process
//! [`NativeHookHost`] attached to the session's [`HookGate`] exactly where
//! extension hosts subscribe; the agent loop has no plugin-specific branch.
//!
//! Each matching hook runs as one command in its own session of the
//! environment's in-process shell ([`EnvClient`]): process-group ownership,
//! TERM-then-KILL teardown on timeout, the project root as its working
//! directory, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and
//! `${CLAUDE_PROJECT_DIR}` expanded in the command and exported to it. The
//! Claude Code hook protocol then maps onto omp's typed verdicts:
//!
//! * the JSON event payload arrives on stdin (typed serde, never `json!`);
//! * exit 0 reads stdout as JSON output when it is one object, else as plain
//!   text (context for `UserPromptSubmit` and `SessionStart`);
//! * exit 2 blocks with stderr as the reason; any other exit is a non-blocking
//!   error unless it printed valid JSON output;
//! * a blocked `PreToolUse` denies the call with the reason the model reads, a
//!   blocked `Stop` continues the loop with the reason as context,
//!   `additionalContext` becomes model-visible hook context, `systemMessage`
//!   and failures become `<notice kind=hook>`, and `continue: false` stops.
//!
//! Observational events run beside the lifecycle and cannot hold it up:
//! `StopFailure` (a turn failed on a provider error, `agent_end`),
//! `PostCompact` (`compaction_done`), `PostModelSwitch` (`model_changed`:
//! its `systemMessage` shows), and `Notification` run in the background with
//! their output discarded, only failures surfacing. `Notification` raises
//! `permission_prompt` when an approval prompt is filed, `idle_prompt` once a
//! main session's run ended and no prompt followed within
//! [`SV_PLUGIN_HOOK_IDLE_PROMPT`], and `agent_completed` when a subagent's
//! run ends; [`NotificationType::seam`] names every type omp does not raise.
//! `SessionEnd` runs at the session's end (`session_shutdown`: quit, a finished
//! run, a switch to another session) within [`SESSION_SHUTDOWN_BUDGET`], its
//! output discarded. `SessionStart` runs on every session start
//! (`session_start`): launch (`startup`, or `resume` for a journal that already
//! holds a conversation), `/new` (`clear`), `/resume` and a hand-off
//! (`resume`), and a fork (`fork`). Every session switch moves the host onto
//! the next session's id and journal ([`NativeHookHost::session_switched`]),
//! whether or not the previous session's end ran (an ACP `session/close`
//! already ended it) and whatever events the host's hooks use. `SubagentStart`
//! runs on a subagent's first prompt, its `additionalContext` opening the
//! subagent's context.
//!
//! A hook runs only when the operator approved its command for its trigger
//! (event and matcher) at the plugin's version, as every other command a
//! plugin launches ([`omp_ext::plugin_command`]); an unapproved hook is
//! never registered.
//!
//! A failing hook is a typed [`PluginHookError`] rendered into a notice; it
//! never fails the turn.

use std::{
	collections::BTreeMap,
	fmt::Write as _,
	path::{Path, PathBuf},
	sync::{
		Arc, OnceLock, Weak,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
	time::Duration,
};

use bytes::Bytes;
use omp_agent::{
	BoxFut, EnvEvent, HookContext, HookGate, ModelChangeReason, NativeHookHost, NativeReply,
	NativeVerdict, SESSION_SHUTDOWN_BUDGET, SessionSwitched, ShutdownReason, SwitchReason, Up,
};
use omp_ai::ErrorKind;
use omp_core::{EnvPath, Str, sf};
use omp_env::{ClientError, EnvClient, ExecEvent};
use omp_ext::{
	claude_hooks::{ClaudeHookEvent, HookSeam, NotificationType, PluginHook, claude_tool_name},
	claude_plugin::{ClaudePlugins, expand_plugin_vars, plugin_data_dir},
};
use omp_proto::{
	env::v1::{
		CloseSessionRequest, EnvironmentDelta, ExecOutcome, ExecRequest, OpenSessionRequest,
		OutputChannel, Script,
	},
	toolhost::v1::HookEventId,
};
use omp_session::custom_message::{CustomMessage, CustomMessageKind};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use smallvec::SmallVec;
use strum::{IntoStaticStr, VariantArray};

omp_con::var! {
	/// How long a main session waits for the next prompt after a run ends
	/// before plugin `Notification` hooks see `idle_prompt`; `never` raises
	/// none.
	pub static SV_PLUGIN_HOOK_IDLE_PROMPT = sv_plugin_hook_idle_prompt: omp_con::Span {
		default: omp_con::Span::Finite(omp_core::Duration::new(
			60,
			omp_core::DurationUnit::Seconds,
		)),
		flags: archive,
	};
}

/// Captured bytes kept per output stream; the rest of a chatty hook's output
/// is dropped.
const OUTPUT_CAP: usize = 1 << 20;
/// Consecutive stop-hook continuations before the next block is overridden
/// (the spec's default cap).
const STOP_CONTINUATION_CAP: u32 = 8;

/// A plugin hook that could not produce a decision; rendered once into a
/// `<notice kind=hook>` and never fatal to the turn.
#[derive(Debug, thiserror::Error)]
pub enum PluginHookError {
	/// The environment could not open a shell session or start the command.
	#[error("plugin `{plugin}` {event} hook could not start")]
	Start {
		/// Plugin id.
		plugin: Str,
		/// Hook event.
		event:  ClaudeHookEvent,
		/// Environment failure.
		#[source]
		source: ClientError,
	},
	/// The command outlived its timeout; it was terminated and its output
	/// discarded.
	#[error("plugin `{plugin}` {event} hook timed out after {}ms; its output was discarded", timeout.as_millis())]
	TimedOut {
		/// Plugin id.
		plugin:  Str,
		/// Hook event.
		event:   ClaudeHookEvent,
		/// The timeout that fired.
		timeout: Duration,
	},
	/// The command ended without an exit code (killed by a signal, denied by
	/// the sandbox, or cancelled).
	#[error("plugin `{plugin}` {event} hook ended without an exit status ({outcome:?})")]
	NoExitStatus {
		/// Plugin id.
		plugin:  Str,
		/// Hook event.
		event:   ClaudeHookEvent,
		/// The environment's outcome.
		outcome: ExecOutcome,
	},
	/// A non-zero, non-2 exit without valid JSON output.
	#[error("plugin `{plugin}` {event} hook failed with non-blocking status code {code}: {stderr}")]
	NonBlocking {
		/// Plugin id.
		plugin: Str,
		/// Hook event.
		event:  ClaudeHookEvent,
		/// Exit code.
		code:   i32,
		/// First stderr line the hook printed.
		stderr: Str,
	},
	/// Stdout looked like a JSON object but is not valid hook output.
	#[error("plugin `{plugin}` {event} hook printed invalid JSON output")]
	MalformedOutput {
		/// Plugin id.
		plugin: Str,
		/// Hook event.
		event:  ClaudeHookEvent,
		/// Decoding failure.
		#[source]
		source: serde_json::Error,
	},
}

/// One loaded hook with its plugin's identity and directories.
#[derive(Clone)]
struct LoadedHook {
	plugin: Str,
	root:   PathBuf,
	data:   PathBuf,
	hook:   PluginHook,
}

/// Session facts every hook input carries.
#[derive(Clone, Debug)]
pub struct PluginHookSession {
	/// The session identifier (the journal's stem).
	pub session_id:   Str,
	/// The session journal (`transcript_path`).
	pub transcript:   PathBuf,
	/// Project root: the hook's working directory and `CLAUDE_PROJECT_DIR`.
	pub project_root: PathBuf,
	/// omp's data directory, holding each plugin's `${CLAUDE_PLUGIN_DATA}`.
	pub data_dir:     PathBuf,
	/// Whether this kernel runs a subagent: `SubagentStop` replaces `Stop`,
	/// `SubagentStart` runs on its first prompt, and prompt/session events
	/// stay with the main session.
	pub subagent:     bool,
	/// The agent class this kernel runs (`SubagentStart`'s `agent_type`);
	/// `None` is the default `task` class.
	pub agent:        Option<crate::subagent::AgentName>,
	/// How long a main session's run may be followed by no prompt before
	/// `Notification` raises `idle_prompt`; `None` never raises it
	/// ([`SV_PLUGIN_HOOK_IDLE_PROMPT`]).
	pub idle_prompt:  Option<Duration>,
}

/// The session a hook input names: the one the host serves now. A session
/// switch moves the host onto the next one.
#[derive(Clone, Debug)]
struct LiveSession {
	session_id: Str,
	transcript: PathBuf,
}

impl LiveSession {
	/// The session journaled at `transcript`, named by its stem.
	fn at(transcript: PathBuf) -> Self {
		let session_id = transcript
			.file_stem()
			.and_then(|stem| stem.to_str())
			.map_or_else(|| Str::new_static("session"), Str::new);
		Self { session_id, transcript }
	}
}

/// The in-process hook host running every enabled plugin's hooks.
pub struct PluginHookHost {
	this:               Weak<Self>,
	client:             EnvClient,
	session:            PluginHookSession,
	live:               RwLock<LiveSession>,
	hooks:              Box<[LoadedHook]>,
	mailbox:            OnceLock<flume::Sender<Up>>,
	stop_continuations: AtomicU32,
	session_context:    Mutex<Vec<HookContext>>,
	/// A subagent's first prompt has started (`SubagentStart` ran).
	started:            AtomicBool,
	/// Bumped by every run end, prompt start, switch, and session end: a
	/// pending `idle_prompt` raises only while its run end is the latest.
	idle:               AtomicU64,
}

impl PluginHookHost {
	/// Builds the host over every Claude-layout plugin's hooks; `None` when
	/// no enabled plugin declares a hook this session runs.
	///
	/// A hook whose command the operator has not approved
	/// ([`omp_ext::claude_plugin::ClaudePlugin::admit_launch`] over
	/// [`PluginHook::launch`]) is never registered, so it never runs; each
	/// refusal is logged here, and the launching host names it to the operator
	/// through [`crate::plugin_commands::blocked_launches`].
	#[must_use]
	pub fn new(
		client: EnvClient,
		session: PluginHookSession,
		plugins: &ClaudePlugins,
	) -> Option<Arc<Self>> {
		let data_dir = session.data_dir.as_path();
		let subagent = session.subagent;
		let hooks = plugins
			.plugins
			.iter()
			.flat_map(|plugin| {
				plugin.hook_launches().filter_map(move |(hook, launch)| {
					if !runs_in(hook.event, subagent) {
						return None;
					}
					if let Err(blocked) = plugin.admit_launch(launch) {
						tracing::warn!(
							error = &blocked as &(dyn std::error::Error + 'static),
							"installed plugin hook not registered"
						);
						return None;
					}
					Some(LoadedHook {
						plugin: plugin.id.clone().into(),
						root:   plugin.root.clone(),
						data:   plugin_data_dir(data_dir, &plugin.id),
						hook:   hook.clone(),
					})
				})
			})
			.collect::<Box<[_]>>();
		(!hooks.is_empty()).then(|| {
			Arc::new_cyclic(|this| Self {
				this: this.clone(),
				client,
				live: RwLock::new(LiveSession {
					session_id: session.session_id.clone(),
					transcript: session.transcript.clone(),
				}),
				session,
				hooks,
				mailbox: OnceLock::new(),
				stop_continuations: AtomicU32::new(0),
				session_context: Mutex::new(Vec::new()),
				started: AtomicBool::new(false),
				idle: AtomicU64::new(0),
			})
		})
	}

	/// Binds the kernel mailbox notices and tool-seam context travel on.
	pub fn bind_mailbox(&self, mailbox: flume::Sender<Up>) {
		let _ = self.mailbox.set(mailbox);
	}

	/// Attaches this host to `gate` for every seam its hooks use.
	pub fn attach(self: &Arc<Self>, gate: &HookGate) {
		gate.attach_native(Arc::clone(self) as Arc<dyn NativeHookHost>, &self.events());
	}

	/// The hook events this host answers.
	#[must_use]
	pub fn events(&self) -> SmallVec<HookEventId, 8> {
		let mut events = SmallVec::<HookEventId, 8>::new();
		let mut push = |event| {
			if !events.contains(&event) {
				events.push(event);
			}
		};
		for loaded in &*self.hooks {
			push(seam_event(loaded.hook.seam));
			// Stop's continuation cap resets, and SessionStart context is
			// delivered, when the next prompt starts.
			if matches!(loaded.hook.seam, HookSeam::AgentSettled | HookSeam::SessionStart) {
				push(HookEventId::HookEventBeforeAgentStart);
			}
			// Every point a hosted notification type is raised on; a
			// pending `idle_prompt` is withdrawn when a prompt starts or the
			// session ends.
			if loaded.hook.event == ClaudeHookEvent::Notification {
				for kind in NotificationType::VARIANTS {
					if let Some(seam) = kind.seam() {
						push(seam_event(seam));
					}
				}
				push(HookEventId::HookEventBeforeAgentStart);
				push(HookEventId::HookEventSessionShutdown);
			}
		}
		events
	}

	fn hooks_for<'a>(
		&'a self,
		event: ClaudeHookEvent,
		subject: Subject<'a>,
	) -> impl Iterator<Item = &'a LoadedHook> + 'a {
		self.hooks.iter().filter(move |loaded| {
			loaded.hook.event == event
				&& match subject {
					Subject::Tool(tool) => loaded.hook.matcher.matches_tool(tool),
					Subject::Value(value) => loaded.hook.matcher.matches(value),
					Subject::None => true,
				}
		})
	}

	/// Runs every matching hook concurrently for the live session; detached
	/// (`async`) hooks run in the background and contribute nothing.
	async fn run_all(
		&self,
		event: ClaudeHookEvent,
		subject: Subject<'_>,
		fields: EventFields<'_>,
	) -> Vec<HookEffect> {
		let session = self.live.read().clone();
		self.run_for(&session, event, subject, fields, None).await
	}

	/// Runs every matching hook for `session`. With a `cap`, every hook runs
	/// in the foreground and none past the cap: the caller's lifecycle point
	/// is bounded (`SessionEnd`).
	async fn run_for(
		&self,
		session: &LiveSession,
		event: ClaudeHookEvent,
		subject: Subject<'_>,
		fields: EventFields<'_>,
		cap: Option<Duration>,
	) -> Vec<HookEffect> {
		// The payload is serialized once, on the first matching hook.
		let mut input = None::<Bytes>;
		let mut foreground = Vec::new();
		for loaded in self.hooks_for(event, subject) {
			let bytes = if let Some(bytes) = &input {
				bytes.clone()
			} else {
				let payload = HookInput {
					session_id:      &session.session_id,
					transcript_path: &session.transcript,
					cwd:             &self.session.project_root,
					permission_mode: "default",
					hook_event_name: event.into(),
					fields:          &fields,
				};
				let Ok(bytes) = serde_json::to_vec(&payload).map(Bytes::from) else {
					return Vec::new();
				};
				input.insert(bytes).clone()
			};
			let declared = loaded.hook.command.timeout;
			if let Some(cap) = cap {
				foreground.push(self.effect_of(loaded, bytes, declared.min(cap)));
			} else if !loaded.hook.command.detached {
				foreground.push(self.effect_of(loaded, bytes, declared));
			} else if let Some(host) = self.this.upgrade() {
				let loaded = loaded.clone();
				tokio::spawn(async move {
					if let Err(error) = host.run(&loaded, bytes, declared).await {
						tracing::debug!(
							error = &error as &dyn std::error::Error,
							"background plugin hook failed"
						);
					}
				});
			}
		}
		futures::future::join_all(foreground).await
	}

	async fn effect_of(&self, loaded: &LoadedHook, input: Bytes, timeout: Duration) -> HookEffect {
		let event = loaded.hook.event;
		let mut effect = HookEffect::new(loaded.plugin.clone());
		match self.run(loaded, input, timeout).await {
			Ok(finished) => effect.interpret(event, finished),
			Err(error) => effect.notices.push(render(&error)),
		}
		effect
	}

	/// Runs one hook command in its own in-process shell session, terminated
	/// at `timeout`.
	async fn run(
		&self,
		loaded: &LoadedHook,
		input: Bytes,
		timeout: Duration,
	) -> Result<Finished, PluginHookError> {
		let event = loaded.hook.event;
		let start = |source| PluginHookError::Start { plugin: loaded.plugin.clone(), event, source };
		let _ = std::fs::create_dir_all(&loaded.data);
		let script = self.script(loaded);
		let cwd = EnvPath::new(Str::new(self.session.project_root.to_string_lossy()))
			.unwrap_or_else(|_| EnvPath::new(Str::new_static(".")).expect("non-empty literal"));
		let mut set = BTreeMap::new();
		for (name, value) in [
			("PWD", &self.session.project_root),
			("CLAUDE_PROJECT_DIR", &self.session.project_root),
			("CLAUDE_PLUGIN_ROOT", &loaded.root),
			("CLAUDE_PLUGIN_DATA", &loaded.data),
		] {
			set.insert(name.to_owned(), value.to_string_lossy().into_owned());
		}
		let opened = self
			.client
			.open_session(&cwd, OpenSessionRequest {
				env_delta: Some(EnvironmentDelta { set, unset: Vec::new(), props: None }),
				..OpenSessionRequest::default()
			})
			.await
			.map_err(start)?;
		let session = opened.session.clone();
		let outcome = match self
			.client
			.exec(ExecRequest {
				session: opened.session,
				source: Some(Script { text: script, ..Script::default() }),
				..ExecRequest::default()
			})
			.await
		{
			Ok(mut run) => {
				// Dropping the run on timeout tears the command's process
				// groups down TERM-then-KILL in the environment.
				match tokio::time::timeout(timeout, drive(&self.client, &mut run, input)).await {
					Ok(result) => result.map_err(start),
					Err(_) => {
						Err(PluginHookError::TimedOut { plugin: loaded.plugin.clone(), event, timeout })
					},
				}
			},
			Err(source) => Err(start(source)),
		};
		let _ = self
			.client
			.close_session(CloseSessionRequest { session, ..CloseSessionRequest::default() })
			.await;
		let finished = outcome?;
		if finished.code.is_none() {
			return Err(PluginHookError::NoExitStatus {
				plugin: loaded.plugin.clone(),
				event,
				outcome: finished.outcome,
			});
		}
		Ok(finished)
	}

	/// The script the in-process shell runs: the approved script
	/// ([`omp_ext::claude_hooks::HookCommand::script`]) with the plugin's
	/// data directory and the project root filled in.
	fn script(&self, loaded: &LoadedHook) -> String {
		loaded.hook.command.script(|value| {
			let expanded = expand_plugin_vars(value.clone(), &loaded.root, Some(&loaded.data));
			if expanded.contains("${CLAUDE_PROJECT_DIR}") {
				Str::new(expanded.replace(
					"${CLAUDE_PROJECT_DIR}",
					self.session.project_root.to_string_lossy().as_ref(),
				))
			} else {
				expanded
			}
		})
	}

	fn post(&self, message: Up) {
		if let Some(mailbox) = self.mailbox.get() {
			let _ = mailbox.send(message);
		} else {
			tracing::debug!("plugin hook notice before the kernel mailbox was bound");
		}
	}

	/// Journals user-visible notices (failures, `systemMessage`) and, for
	/// `continue: false`, the stop.
	fn publish(&self, effects: &[HookEffect]) {
		for effect in effects {
			for body in effect
				.notices
				.iter()
				.chain(&effect.messages)
				.chain(effect.halt.iter())
			{
				self.notice(&effect.plugin, body.clone());
			}
		}
	}

	/// Journals only the failures of hooks whose output the event discards.
	fn publish_failures(&self, effects: &[HookEffect]) {
		for effect in effects {
			for body in &effect.notices {
				self.notice(&effect.plugin, body.clone());
			}
		}
	}

	fn notice(&self, plugin: &Str, body: Str) {
		self.post(Up::Env(EnvEvent::Notice {
			kind: Str::new_static("hook"),
			name: Some(plugin.clone()),
			body,
		}));
	}

	fn halted(effects: &[HookEffect]) -> Option<Str> {
		effects.iter().find_map(|effect| effect.halt.clone())
	}

	async fn tool_call(&self, payload: &JsonValue) -> NativeReply {
		let Ok(call) = ToolCallView::deserialize(payload) else {
			return NativeReply::defer();
		};
		let tool = call.target.name.as_str();
		let input = ToolInput::of(tool, &call.args, &self.session.project_root);
		let effects = self
			.run_all(ClaudeHookEvent::PreToolUse, Subject::Tool(tool), EventFields::PreTool {
				tool_name:   claude_tool_name(tool),
				tool_input:  input,
				tool_use_id: &call.call_id,
			})
			.await;
		self.publish(&effects);
		// PreToolUse context lands next to the tool result: the mailbox is
		// drained into the turn before the next inference.
		for effect in &effects {
			for body in &effect.context {
				self.post(Up::Env(EnvEvent::CustomMessage(hook_message(&effect.plugin, body))));
			}
		}
		if let Some(reason) = Self::halted(&effects) {
			self.post(Up::Interrupt);
			return NativeReply { verdict: NativeVerdict::Deny(reason), context: Vec::new() };
		}
		match effects.into_iter().find_map(|effect| effect.block) {
			Some(reason) => NativeReply { verdict: NativeVerdict::Deny(reason), context: Vec::new() },
			None => NativeReply::defer(),
		}
	}

	async fn tool_result(&self, payload: &JsonValue) -> NativeReply {
		let Ok(mut result) = ToolResultView::deserialize(payload) else {
			return NativeReply::defer();
		};
		let tool = result.target.name.clone();
		let input = ToolInput::of(&tool, &result.target.args, &self.session.project_root);
		let (event, fields) = match result.outcome.as_str() {
			"ok" => (ClaudeHookEvent::PostToolUse, EventFields::PostTool {
				tool_name:     claude_tool_name(&tool),
				tool_input:    input,
				tool_use_id:   &result.call_id,
				tool_response: result.payload.as_ref().unwrap_or(&JsonValue::Null),
			}),
			"faulted" => (ClaudeHookEvent::PostToolUseFailure, EventFields::ToolFailure {
				tool_name:    claude_tool_name(&tool),
				tool_input:   input,
				tool_use_id:  &result.call_id,
				error:        fault_text(result.fault.as_ref()),
				is_interrupt: false,
			}),
			_ => return NativeReply::defer(),
		};
		let effects = self.run_all(event, Subject::Tool(&tool), fields).await;
		self.publish(&effects);
		if Self::halted(&effects).is_some() {
			self.post(Up::Interrupt);
		}
		let mut changed = false;
		for effect in effects {
			// The tool already ran: a block and any context annotate its
			// result where the model reads it.
			for text in effect.block.into_iter().chain(effect.context) {
				if let Ok(annotation) =
					serde_json::to_value(Annotation { kind: Str::new_static("hook"), text })
				{
					result.annotate.push(annotation);
					changed = true;
				}
			}
		}
		if !changed {
			return NativeReply::defer();
		}
		match serde_json::to_value(&result) {
			Ok(payload) => {
				NativeReply { verdict: NativeVerdict::Modify(payload), context: Vec::new() }
			},
			Err(_) => NativeReply::defer(),
		}
	}

	async fn before_agent_start(&self, payload: &JsonValue) -> NativeReply {
		self.idle.fetch_add(1, Ordering::Relaxed);
		self.stop_continuations.store(0, Ordering::Relaxed);
		let mut context = std::mem::take(&mut *self.session_context.lock());
		if self.session.subagent {
			if !self.started.swap(true, Ordering::Relaxed) {
				context.extend(self.subagent_start().await);
			}
			return NativeReply { verdict: NativeVerdict::Defer, context };
		}
		let Ok(prompt) = PromptView::deserialize(payload) else {
			return NativeReply { verdict: NativeVerdict::Defer, context };
		};
		let effects = self
			.run_all(ClaudeHookEvent::UserPromptSubmit, Subject::None, EventFields::Prompt {
				prompt: &prompt.text,
			})
			.await;
		self.publish(&effects);
		if let Some(reason) = Self::halted(&effects) {
			return NativeReply { verdict: NativeVerdict::Deny(reason), context: Vec::new() };
		}
		let mut block = None;
		for effect in effects {
			block = block.or(effect.block);
			context.extend(
				effect
					.context
					.into_iter()
					.map(|body| HookContext::new(effect.plugin.clone(), body)),
			);
		}
		match block {
			Some(reason) => NativeReply { verdict: NativeVerdict::Deny(reason), context: Vec::new() },
			None => NativeReply { verdict: NativeVerdict::Defer, context },
		}
	}

	async fn agent_settled(&self) -> NativeReply {
		let event = if self.session.subagent {
			ClaudeHookEvent::SubagentStop
		} else {
			ClaudeHookEvent::Stop
		};
		let used = self.stop_continuations.load(Ordering::Relaxed);
		if used >= STOP_CONTINUATION_CAP {
			self.stop_continuations.store(0, Ordering::Relaxed);
			return NativeReply::defer();
		}
		let effects = self
			.run_all(event, Subject::None, EventFields::Stop { stop_hook_active: used > 0 })
			.await;
		self.publish(&effects);
		if Self::halted(&effects).is_some() {
			self.stop_continuations.store(0, Ordering::Relaxed);
			return NativeReply::defer();
		}
		let context = effects
			.into_iter()
			.flat_map(|effect| {
				let plugin = effect.plugin;
				effect
					.block
					.into_iter()
					.chain(effect.context)
					.map(move |body| HookContext::new(plugin.clone(), body))
			})
			.collect::<Vec<_>>();
		if context.is_empty() {
			self.stop_continuations.store(0, Ordering::Relaxed);
			return NativeReply::defer();
		}
		self.stop_continuations.fetch_add(1, Ordering::Relaxed);
		NativeReply { verdict: NativeVerdict::Continue, context }
	}

	/// `SubagentStart`: the subagent's first prompt. It cannot block; its
	/// `additionalContext` opens the subagent's context.
	async fn subagent_start(&self) -> Vec<HookContext> {
		let agent_id = self.live.read().session_id.clone();
		let agent_type = self
			.session
			.agent
			.as_ref()
			.map_or("task", |agent| agent.as_str());
		let effects = self
			.run_all(
				ClaudeHookEvent::SubagentStart,
				Subject::Value(agent_type),
				EventFields::SubagentStart { agent_id: &agent_id, agent_type },
			)
			.await;
		self.publish(&effects);
		effects
			.into_iter()
			.flat_map(|effect| {
				let plugin = effect.plugin;
				effect
					.context
					.into_iter()
					.map(move |body| HookContext::new(plugin.clone(), body))
			})
			.collect()
	}

	/// `SessionEnd`: the live session ends. Every matching hook runs to
	/// completion or [`SESSION_SHUTDOWN_BUDGET`], whichever is first; its
	/// output is discarded. The session it names is the one the host serves;
	/// a switch then moves the host through
	/// [`NativeHookHost::session_switched`].
	async fn session_end(&self, payload: &JsonValue) -> NativeReply {
		self.idle.fetch_add(1, Ordering::Relaxed);
		let Ok(view) = SessionShutdownView::deserialize(payload) else {
			return NativeReply::defer();
		};
		let reason = end_reason(
			view.reason.parse().unwrap_or(ShutdownReason::UserExit),
			view.switch_reason.and_then(|reason| reason.parse().ok()),
		);
		let ending = self.live.read().clone();
		let reason: &'static str = reason.into();
		let effects = self
			.run_for(
				&ending,
				ClaudeHookEvent::SessionEnd,
				Subject::Value(reason),
				EventFields::SessionEnd { reason },
				Some(SESSION_SHUTDOWN_BUDGET),
			)
			.await;
		for effect in &effects {
			for notice in &effect.notices {
				tracing::warn!(plugin = %effect.plugin, "{notice}");
			}
		}
		NativeReply::defer()
	}

	/// Runs an observational event's hooks in the background: the lifecycle
	/// point never waits on them.
	fn observe_in_background(&self, event: HookEventId, payload: &JsonValue) {
		let claude: &[ClaudeHookEvent] = match event {
			HookEventId::HookEventAgentEnd => {
				&[ClaudeHookEvent::StopFailure, ClaudeHookEvent::Notification]
			},
			HookEventId::HookEventCompactionDone => &[ClaudeHookEvent::PostCompact],
			HookEventId::HookEventToolApprovalRequested => &[ClaudeHookEvent::Notification],
			HookEventId::HookEventModelChanged => &[ClaudeHookEvent::PostModelSwitch],
			_ => return,
		};
		// A run end starts the idle wait whether or not it raises anything
		// itself; the previous wait is over.
		let idle = (event == HookEventId::HookEventAgentEnd)
			.then(|| self.idle.fetch_add(1, Ordering::Relaxed) + 1);
		for &claude in claude {
			if !self.hooks.iter().any(|loaded| loaded.hook.event == claude) {
				continue;
			}
			let (Some(host), Ok(runtime)) =
				(self.this.upgrade(), tokio::runtime::Handle::try_current())
			else {
				return;
			};
			let payload = payload.clone();
			match (claude, event) {
				(ClaudeHookEvent::Notification, HookEventId::HookEventAgentEnd) => {
					runtime.spawn(async move { host.run_ended(&payload, idle).await });
				},
				_ => {
					runtime.spawn(async move { host.observed(claude, &payload).await });
				},
			}
		}
	}

	/// `Notification` on a run's end: a subagent's is `agent_completed`; a
	/// main session's is `idle_prompt` once the idle wait passed with no
	/// prompt, switch, or session end in between.
	async fn run_ended(&self, payload: &JsonValue, idle: Option<u64>) {
		if self.session.subagent {
			let Ok(view) = AgentEndView::deserialize(payload) else {
				return;
			};
			let agent_id = self.live.read().session_id.clone();
			let agent_type = self
				.session
				.agent
				.as_ref()
				.map_or("task", |agent| agent.as_str());
			let kind = NotificationType::AgentCompleted;
			let effects = self
				.run_all(
					ClaudeHookEvent::Notification,
					Subject::Value(kind.into()),
					EventFields::AgentNotification {
						notification_type: kind.into(),
						agent_type,
						agent_id: &agent_id,
						summary: view.assistant_text.as_deref().unwrap_or_default(),
					},
				)
				.await;
			self.publish_failures(&effects);
			return;
		}
		let (Some(wait), Some(idle)) = (self.session.idle_prompt, idle) else {
			return;
		};
		tokio::time::sleep(wait).await;
		if self.idle.load(Ordering::Relaxed) != idle {
			return;
		}
		let kind = NotificationType::IdlePrompt;
		let effects = self
			.run_all(
				ClaudeHookEvent::Notification,
				Subject::Value(kind.into()),
				EventFields::Notification {
					message:           Str::new_static("omp is waiting for your input"),
					title:             "Waiting for input",
					notification_type: kind.into(),
				},
			)
			.await;
		self.publish_failures(&effects);
	}

	async fn observed(&self, event: ClaudeHookEvent, payload: &JsonValue) {
		match event {
			ClaudeHookEvent::StopFailure => {
				let Ok(view) = AgentEndView::deserialize(payload) else {
					return;
				};
				let Some(kind) = view
					.error_kind
					.and_then(|kind| kind.parse::<ErrorKind>().ok())
				else {
					return;
				};
				let Some(error) = stop_failure_error(kind) else {
					return;
				};
				let error: &'static str = error.into();
				// StopFailure discards the hook's output and exit status.
				let effects = self
					.run_all(event, Subject::Value(error), EventFields::StopFailure {
						error,
						error_details: kind.into(),
					})
					.await;
				for effect in &effects {
					for notice in &effect.notices {
						tracing::debug!(plugin = %effect.plugin, "{notice}");
					}
				}
			},
			ClaudeHookEvent::PostCompact => {
				let Ok(view) = CompactionDoneView::deserialize(payload) else {
					return;
				};
				let trigger = if view.reason == "manual" {
					"manual"
				} else {
					"auto"
				};
				let effects = self
					.run_all(event, Subject::Value(trigger), EventFields::PostCompact {
						trigger,
						compact_summary: view.summary.as_deref().unwrap_or_default(),
					})
					.await;
				self.publish_failures(&effects);
			},
			ClaudeHookEvent::Notification => {
				let Ok(view) = ApprovalRequestedView::deserialize(payload) else {
					return;
				};
				let message = match view.reasons.first() {
					Some(reason) => sf!("omp needs your permission: {reason}"),
					None => Str::new_static("omp needs your permission"),
				};
				let kind = NotificationType::PermissionPrompt;
				let effects = self
					.run_all(event, Subject::Value(kind.into()), EventFields::Notification {
						message,
						title: "Permission needed",
						notification_type: kind.into(),
					})
					.await;
				self.publish_failures(&effects);
			},
			ClaudeHookEvent::PostModelSwitch => {
				let Ok(view) = ModelChangedView::deserialize(payload) else {
					return;
				};
				let source: &'static str = match view.reason.parse() {
					Ok(ModelChangeReason::User) => ModelSwitchSource::UserRequest,
					Ok(ModelChangeReason::Role | ModelChangeReason::Fallback) | Err(_) => {
						ModelSwitchSource::Automatic
					},
				}
				.into();
				let to_model = view.to_model.model.as_str();
				// A thinking-only change repeats the model: no switch.
				if view.from_model.as_ref() == Some(&view.to_model) {
					return;
				}
				let effects = self
					.run_all(event, Subject::Value(to_model), EventFields::ModelSwitch {
						from_model: view.from_model.as_ref().map(|model| model.model.as_str()),
						to_model,
						source,
						effort: view.thinking.as_deref().map(|level| EffortWire { level }),
					})
					.await;
				// PostModelSwitch honors `systemMessage`; nothing else.
				for effect in &effects {
					for body in effect.notices.iter().chain(&effect.messages) {
						self.notice(&effect.plugin, body.clone());
					}
				}
			},
			_ => {},
		}
	}

	async fn session_start(&self, payload: &JsonValue) -> NativeReply {
		let source = SessionStartView::deserialize(payload)
			.map_or(SessionStartSource::Startup, |view| view.source());
		let source: &'static str = source.into();
		let effects = self
			.run_all(
				ClaudeHookEvent::SessionStart,
				Subject::Value(source),
				EventFields::SessionStart { source },
			)
			.await;
		self.publish(&effects);
		let mut pending = self.session_context.lock();
		for effect in effects {
			// Exit 2 only shows stderr to the user here.
			if let Some(reason) = effect.block {
				self.post(Up::Env(EnvEvent::Notice {
					kind: Str::new_static("hook"),
					name: Some(effect.plugin.clone()),
					body: reason,
				}));
			}
			pending.extend(
				effect
					.context
					.into_iter()
					.map(|body| HookContext::new(effect.plugin.clone(), body)),
			);
		}
		NativeReply::defer()
	}

	async fn compaction(&self, payload: &JsonValue) -> NativeReply {
		let Ok(view) = CompactionView::deserialize(payload) else {
			return NativeReply::defer();
		};
		let trigger = if view.reason == "manual" {
			"manual"
		} else {
			"auto"
		};
		let effects = self
			.run_all(ClaudeHookEvent::PreCompact, Subject::Value(trigger), EventFields::PreCompact {
				trigger,
				custom_instructions: view.custom_instructions.as_deref(),
			})
			.await;
		// PreCompact discards `systemMessage` and `continue`.
		match effects.into_iter().find_map(|effect| effect.block) {
			Some(reason) => NativeReply { verdict: NativeVerdict::Deny(reason), context: Vec::new() },
			None => NativeReply::defer(),
		}
	}
}

impl NativeHookHost for PluginHookHost {
	fn decide<'a>(&'a self, event: HookEventId, payload: &'a JsonValue) -> BoxFut<'a, NativeReply> {
		Box::pin(async move {
			match event {
				HookEventId::HookEventToolCall => self.tool_call(payload).await,
				HookEventId::HookEventToolResult => self.tool_result(payload).await,
				HookEventId::HookEventBeforeAgentStart => self.before_agent_start(payload).await,
				HookEventId::HookEventAgentSettled => self.agent_settled().await,
				HookEventId::HookEventSessionStart => self.session_start(payload).await,
				HookEventId::HookEventCompaction => self.compaction(payload).await,
				HookEventId::HookEventSessionShutdown => self.session_end(payload).await,
				_ => NativeReply::defer(),
			}
		})
	}

	fn observe(&self, event: HookEventId, payload: &JsonValue) {
		self.observe_in_background(event, payload);
	}

	fn session_switched(&self, next: &SessionSwitched) {
		self.idle.fetch_add(1, Ordering::Relaxed);
		*self.live.write() = LiveSession::at(next.transcript_path.clone());
	}
}

/// Whether `event`'s hooks run in a main (`subagent == false`) or subagent
/// kernel.
const fn runs_in(event: ClaudeHookEvent, subagent: bool) -> bool {
	match event {
		ClaudeHookEvent::Stop
		| ClaudeHookEvent::StopFailure
		| ClaudeHookEvent::UserPromptSubmit
		| ClaudeHookEvent::SessionStart
		| ClaudeHookEvent::SessionEnd => !subagent,
		ClaudeHookEvent::SubagentStop | ClaudeHookEvent::SubagentStart => subagent,
		_ => true,
	}
}

/// The omp hook event a seam runs on.
const fn seam_event(seam: HookSeam) -> HookEventId {
	match seam {
		HookSeam::ToolCall => HookEventId::HookEventToolCall,
		HookSeam::ToolResult => HookEventId::HookEventToolResult,
		HookSeam::BeforeAgentStart => HookEventId::HookEventBeforeAgentStart,
		HookSeam::AgentSettled => HookEventId::HookEventAgentSettled,
		HookSeam::SessionStart => HookEventId::HookEventSessionStart,
		HookSeam::SessionShutdown => HookEventId::HookEventSessionShutdown,
		HookSeam::AgentEnd => HookEventId::HookEventAgentEnd,
		HookSeam::Compaction => HookEventId::HookEventCompaction,
		HookSeam::CompactionDone => HookEventId::HookEventCompactionDone,
		HookSeam::ToolApprovalRequested => HookEventId::HookEventToolApprovalRequested,
		HookSeam::ModelChanged => HookEventId::HookEventModelChanged,
	}
}

/// `SessionStart`'s `source`, which its matcher filters on.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case")]
enum SessionStartSource {
	/// The process started on a fresh session.
	Startup,
	/// A session holding a conversation started: launched on a stored
	/// journal, `/resume`, or a hand-off to another project.
	Resume,
	/// `/new` (Claude Code's `/clear`).
	Clear,
	/// A fork of a stored session.
	Fork,
}

/// `PostModelSwitch`'s `source`.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case")]
enum ModelSwitchSource {
	/// A user or client selected the model.
	UserRequest,
	/// omp changed it: role routing or a fallback.
	Automatic,
}

/// `SessionEnd`'s `reason`, which its matcher filters on.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case")]
enum SessionEndReason {
	/// `/new` (Claude Code's `/clear`).
	Clear,
	/// Switching to a stored session.
	Resume,
	/// The user quit.
	PromptInputExit,
	/// A finished print-mode run, signals, failures, forks, hand-offs.
	Other,
}

const fn end_reason(reason: ShutdownReason, switch: Option<SwitchReason>) -> SessionEndReason {
	match (reason, switch) {
		(ShutdownReason::UserExit, _) => SessionEndReason::PromptInputExit,
		(ShutdownReason::Switch, Some(SwitchReason::New)) => SessionEndReason::Clear,
		(ShutdownReason::Switch, Some(SwitchReason::Resume)) => SessionEndReason::Resume,
		_ => SessionEndReason::Other,
	}
}

/// `StopFailure`'s `error`, which its matcher filters on.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case")]
enum StopFailureError {
	RateLimit,
	AuthenticationFailed,
	AccountOnHold,
	BillingError,
	InvalidRequest,
	ModelNotFound,
	ServerError,
	Unknown,
}

/// The `StopFailure` error a provider failure category reports; `None` for
/// a cancellation, which is no API error.
const fn stop_failure_error(kind: ErrorKind) -> Option<StopFailureError> {
	Some(match kind {
		ErrorKind::Cancelled => return None,
		ErrorKind::RateLimited | ErrorKind::QuotaExhausted => StopFailureError::RateLimit,
		ErrorKind::Authentication | ErrorKind::Authorization => {
			StopFailureError::AuthenticationFailed
		},
		ErrorKind::AccountDisabled => StopFailureError::AccountOnHold,
		ErrorKind::PaymentRequired => StopFailureError::BillingError,
		ErrorKind::InvalidRequest
		| ErrorKind::ContextOverflow
		| ErrorKind::PayloadRejected
		| ErrorKind::NativeRequestRejected => StopFailureError::InvalidRequest,
		ErrorKind::TargetNotFound => StopFailureError::ModelNotFound,
		ErrorKind::Connectivity
		| ErrorKind::Dns
		| ErrorKind::Tls
		| ErrorKind::Protocol
		| ErrorKind::StreamCorruption
		| ErrorKind::RouteUnavailable
		| ErrorKind::ProviderContractMismatch => StopFailureError::ServerError,
		_ => StopFailureError::Unknown,
	})
}

fn hook_message(plugin: &Str, body: &Str) -> CustomMessage {
	let mut message = CustomMessage::new(plugin.clone(), body.clone());
	message.kind = CustomMessageKind::Hook;
	message.display = false;
	message
}

/// Renders a typed hook failure and its source chain once, for a notice.
fn render(error: &PluginHookError) -> Str {
	let mut text = String::new();
	let _ = write!(text, "{error}");
	let mut source = std::error::Error::source(error);
	while let Some(cause) = source {
		let _ = write!(text, ": {cause}");
		source = cause.source();
	}
	Str::new(text)
}

/// What a hook matcher is tested against.
#[derive(Clone, Copy)]
enum Subject<'a> {
	/// An omp tool family (tool events).
	Tool(&'a str),
	/// A session source or compaction trigger.
	Value(&'a str),
	/// Events without matcher support.
	None,
}

/// One finished command.
struct Finished {
	code:    Option<i32>,
	outcome: ExecOutcome,
	stdout:  Vec<u8>,
	stderr:  Vec<u8>,
}

/// Reads the command's events to its exit while stdin is written out of
/// band: a hook that never reads stdin (or exits first) must not fail the
/// event stream, and a large payload must not stall output.
async fn drive(
	client: &EnvClient,
	run: &mut omp_env::ExecRun,
	input: Bytes,
) -> Result<Finished, ClientError> {
	let (started_tx, started_rx) = flume::bounded::<Bytes>(1);
	let writer = async {
		// The reader drops the sender without an id when the command never
		// started; there is then nothing to write to.
		if let Ok(exec) = started_rx.recv_async().await {
			let control = client.active_exec_control(exec);
			if control.stdin(input).await.is_ok() {
				let _ = control.eof().await;
			}
		}
	};
	let reader = read_events(run, started_tx);
	let ((), finished) = tokio::join!(writer, reader);
	finished
}

async fn read_events(
	run: &mut omp_env::ExecRun,
	started_tx: flume::Sender<Bytes>,
) -> Result<Finished, ClientError> {
	let mut stdout = Vec::new();
	let mut stderr = Vec::new();
	let mut started_tx = Some(started_tx);
	loop {
		match run.next_event().await? {
			Some(ExecEvent::Started(started)) => {
				if let Some(tx) = started_tx.take() {
					let _ = tx.send(started.exec);
				}
			},
			Some(ExecEvent::Output(frame)) => {
				let sink = if frame.channel == OutputChannel::Stderr as i32 {
					&mut stderr
				} else {
					&mut stdout
				};
				let room = OUTPUT_CAP.saturating_sub(sink.len());
				sink.extend_from_slice(&frame.data[..frame.data.len().min(room)]);
			},
			Some(ExecEvent::Exit(exit)) => {
				let status = exit.status.unwrap_or_default();
				let outcome = ExecOutcome::try_from(status.outcome).unwrap_or(ExecOutcome::Unspecified);
				// A non-zero exit is `Failed` with its code; a timeout,
				// cancellation, or sandbox denial has no code to read.
				let code = matches!(outcome, ExecOutcome::Exited | ExecOutcome::Failed)
					.then_some(status.exit_code)
					.flatten();
				return Ok(Finished { code, outcome, stdout, stderr });
			},
			None => {
				return Ok(Finished { code: None, outcome: ExecOutcome::Cancelled, stdout, stderr });
			},
		}
	}
}

/// What one hook's result asks for, before the seam composes it.
struct HookEffect {
	plugin:   Str,
	/// A blocking reason: exit 2's stderr, or a JSON block/deny reason.
	block:    Option<Str>,
	/// Model-visible context.
	context:  Vec<Str>,
	/// `continue: false` with its stop reason.
	halt:     Option<Str>,
	/// User-visible failures of the hook itself.
	notices:  Vec<Str>,
	/// User-visible `systemMessage`s.
	messages: Vec<Str>,
}

impl HookEffect {
	const fn new(plugin: Str) -> Self {
		Self {
			plugin,
			block: None,
			context: Vec::new(),
			halt: None,
			notices: Vec::new(),
			messages: Vec::new(),
		}
	}

	fn interpret(&mut self, event: ClaudeHookEvent, finished: Finished) {
		let Some(code) = finished.code else {
			return;
		};
		let stdout = String::from_utf8_lossy(&finished.stdout);
		let stderr = String::from_utf8_lossy(&finished.stderr);
		let trimmed = stdout.trim();
		let output = if trimmed.starts_with('{') && trimmed.ends_with('}') {
			match serde_json::from_str::<HookOutputWire>(trimmed) {
				Ok(output) => Some(output),
				Err(source) => {
					self.notices.push(render(&PluginHookError::MalformedOutput {
						plugin: self.plugin.clone(),
						event,
						source,
					}));
					None
				},
			}
		} else {
			if code == 0
				&& !trimmed.is_empty()
				&& matches!(event, ClaudeHookEvent::UserPromptSubmit | ClaudeHookEvent::SessionStart)
			{
				self.context.push(Str::new(trimmed));
			}
			None
		};
		if let Some(output) = &output {
			self.apply(output);
		}
		if code == 2 {
			if self.block.is_none() {
				let reason = stderr.trim();
				self.block = Some(if reason.is_empty() {
					sf!("blocked by plugin `{}` {event} hook", self.plugin)
				} else {
					Str::new(reason)
				});
			}
		} else if code != 0 && output.is_none() {
			self.notices.push(render(&PluginHookError::NonBlocking {
				plugin: self.plugin.clone(),
				event,
				code,
				stderr: Str::new(stderr.lines().next().unwrap_or_default()),
			}));
		}
	}

	fn apply(&mut self, output: &HookOutputWire) {
		if output.proceed == Some(false) {
			self.halt = Some(
				output
					.stop_reason
					.clone()
					.unwrap_or_else(|| sf!("stopped by plugin `{}` hook", self.plugin)),
			);
		}
		if let Some(message) = &output.system_message {
			self.messages.push(message.clone());
		}
		let specific = output.hook_specific_output.as_ref();
		let permission_deny = specific
			.and_then(|specific| specific.permission_decision)
			.is_some_and(|decision| decision == PermissionWire::Deny);
		let blocked = output.decision == Some(DecisionWire::Block) || permission_deny;
		if blocked {
			let reason = specific
				.filter(|_| permission_deny)
				.and_then(|specific| specific.permission_decision_reason.clone())
				.or_else(|| output.reason.clone())
				.unwrap_or_else(|| sf!("blocked by plugin `{}` hook", self.plugin));
			self.block = Some(reason);
		}
		if let Some(context) = specific.and_then(|specific| specific.additional_context.clone()) {
			self.context.push(context);
		}
	}
}

/// The JSON a hook may print (lenient: unknown fields ignored).
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookOutputWire {
	#[serde(default, rename = "continue")]
	proceed:              Option<bool>,
	#[serde(default)]
	stop_reason:          Option<Str>,
	#[serde(default)]
	system_message:       Option<Str>,
	#[serde(default)]
	decision:             Option<DecisionWire>,
	#[serde(default)]
	reason:               Option<Str>,
	#[serde(default)]
	hook_specific_output: Option<SpecificWire>,
}

/// Top-level `decision`; `PreToolUse`'s deprecated `approve`/`block` too.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum DecisionWire {
	Block,
	Approve,
	#[serde(other)]
	Other,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpecificWire {
	#[serde(default)]
	permission_decision:        Option<PermissionWire>,
	#[serde(default)]
	permission_decision_reason: Option<Str>,
	#[serde(default)]
	additional_context:         Option<Str>,
}

/// `permissionDecision`: `deny` blocks; `allow`, `ask`, and `defer` leave
/// the call to omp's own approval policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PermissionWire {
	Allow,
	Deny,
	Ask,
	Defer,
	#[serde(other)]
	Other,
}

/// The stdin payload: common fields plus the event's own.
#[derive(Serialize)]
struct HookInput<'a> {
	session_id:      &'a str,
	transcript_path: &'a Path,
	cwd:             &'a Path,
	permission_mode: &'static str,
	hook_event_name: &'static str,
	#[serde(flatten)]
	fields:          &'a EventFields<'a>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum EventFields<'a> {
	PreTool {
		tool_name:   &'a str,
		tool_input:  ToolInput<'a>,
		tool_use_id: &'a str,
	},
	PostTool {
		tool_name:     &'a str,
		tool_input:    ToolInput<'a>,
		tool_use_id:   &'a str,
		tool_response: &'a JsonValue,
	},
	ToolFailure {
		tool_name:    &'a str,
		tool_input:   ToolInput<'a>,
		tool_use_id:  &'a str,
		error:        Str,
		is_interrupt: bool,
	},
	Prompt {
		prompt: &'a str,
	},
	Stop {
		stop_hook_active: bool,
	},
	SessionStart {
		source: &'static str,
	},
	PreCompact {
		trigger:             &'static str,
		custom_instructions: Option<&'a str>,
	},
	PostCompact {
		trigger:         &'static str,
		compact_summary: &'a str,
	},
	SessionEnd {
		reason: &'static str,
	},
	StopFailure {
		error:         &'static str,
		error_details: &'static str,
	},
	SubagentStart {
		agent_id:   &'a str,
		agent_type: &'a str,
	},
	Notification {
		message:           Str,
		title:             &'static str,
		notification_type: &'static str,
	},
	AgentNotification {
		notification_type: &'static str,
		agent_type:        &'a str,
		agent_id:          &'a str,
		summary:           &'a str,
	},
	ModelSwitch {
		from_model: Option<&'a str>,
		to_model:   &'a str,
		source:     &'static str,
		#[serde(skip_serializing_if = "Option::is_none")]
		effort:     Option<EffortWire<'a>>,
	},
}

/// `PostModelSwitch`'s `effort`.
#[derive(Serialize)]
struct EffortWire<'a> {
	level: &'a str,
}

/// `tool_input` in the Claude tool's shape where omp's arguments map onto it
/// faithfully, else omp's own arguments.
#[derive(Serialize)]
#[serde(untagged)]
enum ToolInput<'a> {
	Bash {
		command: Str,
		#[serde(skip_serializing_if = "Option::is_none")]
		timeout: Option<u64>,
	},
	File {
		file_path: Str,
		#[serde(skip_serializing_if = "Option::is_none")]
		content:   Option<Str>,
	},
	Search {
		pattern: Str,
		#[serde(skip_serializing_if = "Option::is_none")]
		path:    Option<Str>,
	},
	Native(&'a JsonValue),
}

#[derive(Deserialize)]
struct BashArgs {
	command: Str,
	#[serde(default)]
	timeout: Option<f64>,
}

#[derive(Deserialize)]
struct PathArgs {
	path:    Str,
	#[serde(default)]
	content: Option<Str>,
}

#[derive(Deserialize)]
struct GrepArgs {
	pattern: Str,
	#[serde(default)]
	path:    Option<Str>,
}

#[derive(Deserialize)]
struct GlobArgs {
	#[serde(default)]
	path: Option<Str>,
}

impl<'a> ToolInput<'a> {
	fn of(tool: &str, args: &'a JsonValue, root: &Path) -> Self {
		let absolute = |path: Str| {
			if path.contains("://") || Path::new(path.as_str()).is_absolute() {
				path
			} else {
				Str::new(root.join(path.as_str()).to_string_lossy())
			}
		};
		let typed = match tool {
			"bash" => BashArgs::deserialize(args).ok().map(|args| Self::Bash {
				command: args.command,
				timeout: args
					.timeout
					.filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
					.map(|seconds| (seconds * 1000.0) as u64),
			}),
			"read" | "write" => PathArgs::deserialize(args)
				.ok()
				.map(|args| Self::File { file_path: absolute(args.path), content: args.content }),
			"grep" => GrepArgs::deserialize(args)
				.ok()
				.map(|args| Self::Search { pattern: args.pattern, path: args.path }),
			"glob" => GlobArgs::deserialize(args).ok().map(|args| Self::Search {
				pattern: args.path.unwrap_or_else(|| Str::new_static("**/*")),
				path:    None,
			}),
			_ => None,
		};
		typed.unwrap_or(Self::Native(args))
	}
}

/// The `tool_call` admission payload fields hooks read.
#[derive(Deserialize)]
struct ToolCallView {
	call_id: Str,
	target:  TargetView,
	#[serde(default)]
	args:    JsonValue,
}

#[derive(Deserialize, Serialize)]
struct TargetView {
	name: Str,
	#[serde(default)]
	args: JsonValue,
	#[serde(flatten)]
	rest: serde_json::Map<String, JsonValue>,
}

/// The `tool_result` transform payload; unknown fields round-trip.
#[derive(Deserialize, Serialize)]
struct ToolResultView {
	call_id:  Str,
	target:   TargetView,
	outcome:  Str,
	#[serde(default)]
	payload:  Option<JsonValue>,
	#[serde(default)]
	fault:    Option<JsonValue>,
	#[serde(default)]
	annotate: Vec<JsonValue>,
	#[serde(flatten)]
	rest:     serde_json::Map<String, JsonValue>,
}

/// One `tool_result` annotation, rendered as a `<diag>` on the result.
#[derive(Serialize)]
struct Annotation {
	kind: Str,
	text: Str,
}

#[derive(Deserialize)]
struct PromptView {
	text: Str,
}

/// The `session_start` payload fields `SessionStart` reads.
#[derive(Deserialize)]
struct SessionStartView {
	#[serde(default)]
	resumed:       bool,
	#[serde(default)]
	switch_reason: Option<Str>,
}

impl SessionStartView {
	fn source(&self) -> SessionStartSource {
		match self
			.switch_reason
			.as_deref()
			.map(str::parse::<SwitchReason>)
		{
			Some(Ok(SwitchReason::New)) => SessionStartSource::Clear,
			Some(Ok(SwitchReason::Fork)) => SessionStartSource::Fork,
			Some(Ok(SwitchReason::Resume | SwitchReason::Handoff)) => SessionStartSource::Resume,
			Some(Err(_)) | None if self.resumed => SessionStartSource::Resume,
			Some(Err(_)) | None => SessionStartSource::Startup,
		}
	}
}

#[derive(Deserialize)]
struct CompactionView {
	reason:              Str,
	#[serde(default)]
	custom_instructions: Option<Str>,
}

/// The `session_shutdown` payload fields `SessionEnd` reads.
#[derive(Deserialize)]
struct SessionShutdownView {
	reason:        Str,
	#[serde(default)]
	switch_reason: Option<Str>,
}

/// The `agent_end` payload fields `StopFailure` and `agent_completed` read.
#[derive(Deserialize)]
struct AgentEndView {
	#[serde(default)]
	error_kind:     Option<Str>,
	#[serde(default)]
	assistant_text: Option<Str>,
}

/// The `model_changed` payload fields `PostModelSwitch` reads.
#[derive(Deserialize)]
struct ModelChangedView {
	#[serde(default)]
	from_model: Option<ModelRefView>,
	to_model:   ModelRefView,
	reason:     Str,
	#[serde(default)]
	thinking:   Option<Str>,
}

#[derive(Deserialize, PartialEq)]
struct ModelRefView {
	#[serde(default)]
	provider: Str,
	model:    Str,
}

/// The `compaction_done` payload fields `PostCompact` reads.
#[derive(Deserialize)]
struct CompactionDoneView {
	#[serde(default)]
	reason:  Str,
	#[serde(default)]
	summary: Option<Str>,
}

/// The `tool_approval_requested` payload field `Notification` reads.
#[derive(Deserialize)]
struct ApprovalRequestedView {
	#[serde(default)]
	reasons: Vec<Str>,
}

#[derive(Deserialize)]
struct FaultView {
	message: Str,
}

fn fault_text(fault: Option<&JsonValue>) -> Str {
	match fault {
		Some(fault) => FaultView::deserialize(fault)
			.map_or_else(|_| Str::new(fault.to_string()), |view| view.message),
		None => Str::default(),
	}
}
