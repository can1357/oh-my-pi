//! Interactive terminal actor over a detached DOM snapshot and event streams.
//!
//! Presentation model (ADR 0034): every transcript block is a mutable slot.
//! Blocks stay on screen — in a top-anchored document that switches to its
//! tail once it outgrows the terminal — and retire into native scrollback
//! only under row pressure, oldest first, once the DOM marks them done.

use std::{
	env, future, io,
	ops::Range,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant},
};

use flume::{Receiver, Sender};
use jiff::Zoned;
use omp_agent::{AI_COMPACT_THRESHOLD, AI_FASTMODE, AI_MODEL, AI_THINKING, KernelEvent, Up};
use omp_con::{Ctx, Source};
use omp_core::{Str, sf};
use omp_dom::{Dom, Event, Handle, KnownTag, Op, PropId, PropKey, Snapshot, Tag, Value};
use omp_journal::EntryId;
use omp_tui::{
	Appearance, CursorStyle, DebugOp, Dim, Frame, InputEvent, Key, KeyEvent, Layer, MouseReport,
	OverlayAnchor, OverlayOptions, Progress, Renderer, Size, SpellingFeatures, Terminal,
	TerminalEvent, TerminalOptions, TtyOut, Ui, UiContext,
	anim::Intro,
	components::{ComposerStyle, Countdown},
	negotiate_async,
	paste::{
		Clipboard, ClipboardRead, ClipboardReadOutcome, ClipboardWriteOutcome, spawn_clipboard_read,
	},
	respond_debug_query,
	slots::{Mode, ResizePolicy},
};
use parking_lot::Mutex;
use thiserror::Error;
use tokio::sync::{Notify, oneshot};

use crate::{
	account_usage::AccountUsageCache,
	actions::{
		CL_DOUBLE_ESCAPE, CL_STT_HOLD, EscapeHook, EscapeRung, HostAction, HostMailbox, SttUiEvent,
	},
	autocomplete::{UrlCandidate, UrlCompleter, slash},
	cards::CardRegistry,
	chrome::{
		CL_SHOW_PROGRESS, CL_STARTUP_QUIET, CL_TITLE_STATE, ModelBadge, StatusFacts, TerminalTitle,
		TitleState, Welcome, display_path, tip_for,
	},
	commands::CompactionMethod,
	composer::{
		Composer, ComposerAction, ComposerEscape, ComposerSettings, DoubleEscapeTarget, PasteOptions,
		PasteOutcome, PrefixMode, SpaceHold, SpaceHoldEvent,
	},
	extension_status::{ExtensionStatus, ExtensionStatuses},
	gitwatch::{GitFacts, GitWatch},
	media::read_attachments,
	notices::{
		error::{aborted_tool_tail, error_banner, pinned_error, retry_hint_row},
		retry::{RetryLoader, RetryState, superseded_notice_keys},
		voice::{SpeechSynth, Vocalizer},
	},
	overlays::{
		HistoryPicker, ModelPicker, ModelRow, Overlay, Overlays, PanelAnchor, PanelCx, PanelEvent,
		PanelNote, PanelOpener, PickerEvent, QuickRoleRow, Services,
		paste_menu::{PasteChoice, PasteMenu, save_paste_file, wrap_in_attachment_block},
		services::ActiveUsageRequest,
	},
	project::{BlockKind, BlockView, RenderedBlock, project},
	settings::{
		CL_AUTOCOMPLETE_MAX_VISIBLE, CL_EMOJI_AUTOCOMPLETE, CL_GOAL_STATUS_IN_FOOTER,
		CL_IME_SAFE_CURSOR, CL_PASTE_LARGE_MENU_THRESHOLD, CL_SHOWTHINKING, CL_SPELLING_AUTOCOMPLETE,
		CL_SPELLING_AUTOCORRECT, CL_SPELLING_TYPO_DETECTION, CL_STATUS_COMPACT_THINKING,
		CL_STATUS_LINE_CONTEXT_LINE, CL_STATUS_LINE_LEFT_SEGMENTS, CL_STATUS_LINE_PRESET,
		CL_STATUS_LINE_RIGHT_SEGMENTS, CL_STATUS_LINE_SEGMENT_OPTIONS, CL_STATUS_LINE_SEPARATOR,
		CL_STATUS_LINE_SHOW_HOOK_STATUS, CL_STATUS_LINE_TIME_FORMAT,
		CL_STATUS_LINE_TIME_SHOW_SECONDS, CL_STATUS_LINE_TRANSPARENT, CL_THEME_DARK, CL_THEME_LIGHT,
	},
	status_band::{
		ActiveTime, CollabStatus, CollabStatusRole, ContextLine, GitStatus, ModeChip, PullRequest,
		Speculation, StatusAppearance, StatusPreset, StatusSegment, StatusSegmentOptions,
		StatusSeparator, WallClockOptions, WorktreeLabel, format_wall_clock, wall_clock_next_wake,
	},
	status_line::{StatusLine, advisor_badge, director_mode},
	transcript::Projection,
	welcome::{WelcomeFacts, tip_seeded, welcome_seed},
};

/// Rows requested per scheme for `scheme://` completion (
/// `MAX_URL_SUGGESTIONS`); the provider ranks and trims them.
const URL_COMPLETION_ROWS: usize = 25;

/// The objective-bearing `/goal` forms submitted as a prompt
/// after engaging the goal Director. Media remains positional against the
/// markers in this returned text.
fn goal_media_prompt(statement: &str) -> Option<Str> {
	let (command, words) = statement.trim().split_once(char::is_whitespace)?;
	if command != "goal" {
		return None;
	}
	let words = words.trim();
	let objective = match words.split_once(char::is_whitespace) {
		Some(("set", objective)) => objective.trim(),
		Some(("show" | "pause" | "resume" | "drop" | "budget", _)) => return None,
		_ if matches!(words, "show" | "pause" | "resume" | "drop" | "budget") => return None,
		_ => words,
	};
	(!objective.is_empty()).then(|| Str::new(objective))
}

/// Live `<meta><jobs>` agents (`id`, agent class) for `agent://`
/// completion; the presenter refreshes it as the replica changes.
type AgentRoster = Arc<Mutex<Vec<(Str, Option<Str>)>>>;

/// `InternalUrlRouter.complete`: the application's resolver table
/// answers the composer's `scheme://` completion. When the application
/// wires no table, the host answers from what it holds itself — the
/// session's `local://` artifacts and the live `agent://` roster; any other
/// scheme declines.
fn url_completer(services: &Arc<dyn Services>, agents: &AgentRoster) -> UrlCompleter {
	let services = Arc::clone(services);
	let agents = Arc::clone(agents);
	Arc::new(move |scheme: &str, query: &str| {
		match services.url_completions(&sf!("{scheme}://{query}"), URL_COMPLETION_ROWS) {
			Ok(rows) => {
				return Some(
					rows
						.into_iter()
						.map(|row| UrlCandidate {
							value:       row.value,
							label:       row.label,
							description: (!row.description.is_empty()).then_some(row.description),
						})
						.collect(),
				);
			},
			Err(crate::overlays::services::ServiceError::Unavailable(_)) => {},
			Err(crate::overlays::services::ServiceError::Failed(_)) => return None,
		}
		match scheme {
			"local" => Some(
				services
					.list_local("")
					.ok()?
					.into_iter()
					.filter_map(|value| {
						value.strip_prefix("local://").map(|value| UrlCandidate {
							value,
							label: None,
							description: None,
						})
					})
					.collect(),
			),
			"agent" => Some(
				agents
					.lock()
					.iter()
					.map(|(id, agent)| UrlCandidate {
						value:       id.clone(),
						label:       None,
						description: agent.clone(),
					})
					.collect(),
			),
			_ => None,
		}
	})
}

/// The `agent://` roster as the replica's `<meta><jobs>` names it.
fn agent_roster(replica: &Dom) -> Vec<(Str, Option<Str>)> {
	crate::overlays::hub::job_rows(replica)
		.into_iter()
		.filter(|row| !row.id.is_empty())
		.map(|row| (row.id, row.agent))
		.collect()
}

/// The editor's native spelling gates as the `cl_spelling_*` convars say.
fn spelling_features(con: &Ctx) -> SpellingFeatures {
	SpellingFeatures {
		typo_detection: CL_SPELLING_TYPO_DETECTION.get(con),
		autocomplete:   CL_SPELLING_AUTOCOMPLETE.get(con),
		autocorrect:    CL_SPELLING_AUTOCORRECT.get(con),
	}
}

/// The composer's dropdown, emoji, and large-paste knobs as their convars
/// say ( `autocompleteMaxVisible`, `emojiAutocomplete`,
/// `paste.largeMenuThreshold`).
fn composer_settings(con: &Ctx) -> ComposerSettings {
	ComposerSettings {
		autocomplete_max_visible: CL_AUTOCOMPLETE_MAX_VISIBLE.get(con),
		emoji_autocomplete:       CL_EMOJI_AUTOCOMPLETE.get(con),
		paste_large_menu_lines:   CL_PASTE_LARGE_MENU_THRESHOLD.get(con),
	}
}

/// Console command that engages the plan Director.
const PLAN_DIRECTOR: &str = "plan";
/// Director family engaged by `/loop` (rung 5 of the Esc ladder).
const LOOP_DIRECTOR: &str = "loop_mode";
/// Notice shown when a bound command wants a reasoning level the model lacks.
const NO_THINKING: &str = "Current model does not support thinking";
/// `LEFT_DOUBLE_TAP_MIN_GAP_MS`: taps closer than this are a terminal
/// burst, never a human double-tap.
const LEFT_DOUBLE_TAP_MIN_GAP: Duration = Duration::from_millis(40);
/// `LEFT_DOUBLE_TAP_MAX_GAP_MS`: a quiet gap this long starts a fresh
/// tap sequence.
const LEFT_DOUBLE_TAP_MAX_GAP: Duration = Duration::from_millis(500);
/// How long a background clipboard read may take before the paste is
/// abandoned.
const CLIPBOARD_READ_TIMEOUT: Duration = Duration::from_secs(8);
/// `process.exit(130)`: a second Ctrl+C while teardown hangs.
const HARD_ABORT_CODE: i32 = 130;

/// Which side-channel spawn a slash command asked for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpawnKind {
	/// `/btw`: a side question that never enters the main transcript.
	Btw,
	/// `/tan`: a fire-and-forget background task.
	Tan,
}

/// Observer-local composer gate shared with the application controller.
///
/// This is deliberately not session state: it answers only whether this
/// particular actor has unsent input that must win an idle continuation.
#[derive(Default)]
pub struct PendingInputGate {
	pending: AtomicBool,
	changed: Notify,
}

impl PendingInputGate {
	/// Returns whether this actor currently holds a submittable draft.
	#[must_use]
	pub fn pending(&self) -> bool {
		self.pending.load(Ordering::Acquire)
	}

	/// Waits until the actor changes whether it has pending input.
	pub async fn changed(&self) {
		self.changed.notified().await;
	}

	/// Updates the actor-local draft fact and wakes the idle controller when
	/// the boundary changes.
	pub fn set_pending(&self, pending: bool) {
		if self.pending.swap(pending, Ordering::AcqRel) != pending {
			self.changed.notify_one();
		}
	}
}

/// Commands emitted by the presentation actor to the application controller.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostCommand {
	/// Begin a fresh explicit turn.
	Submit(Str),
	/// Begin or steer with a discovered skill's typed prompt.
	SkillPrompt(omp_journal::data::SkillPrompt),
	/// Begin a turn with user media ( `pendingImages`): the controller
	/// content-addresses each input in the session's blob store and journals
	/// the prompt with the references, `[Image #N]` in `text` naming
	/// `attachments[N-1]`.
	SubmitWithAttachments {
		/// User-authored text carrying the wire markers.
		text:        Str,
		/// Media bytes plus MIME in marker order.
		attachments: Vec<omp_session::AttachmentInput>,
	},
	/// Queue steering text at the kernel's next safe point.
	Steer(Str),
	/// Interrupt the active turn without exiting the chat.
	Interrupt,
	/// Deliver a decision for one controller-owned approval prompt.
	Approve {
		/// Stable prompt identity.
		id:       Str,
		/// User-authored decision.
		decision: omp_agent::ApprovalDecision,
	},
	/// Notify the app of an observer-local overlay transition.
	Overlay {
		/// Stable local overlay identity.
		id:   Str,
		/// Whether the overlay opened (`true`) or closed (`false`).
		open: bool,
	},
	/// Engage or exit the plan Director ( `app.plan.toggle`).
	PlanMode {
		/// `true` engages plan mode; `false` exits it.
		engage: bool,
	},
	/// Atomically save the reviewed plan, exit plan mode, and start a fresh
	/// session. The application reports save failures without changing the
	/// current plan or session.
	PlanSave {
		/// Absolute destination selected in the observer-local editor.
		path:    PathBuf,
		/// Exact reviewed plan contents, including in-overlay edits.
		content: Str,
	},
	/// Switch to a stored session file (`/resume`, session picker).
	SessionOpen {
		/// Journal path.
		path: PathBuf,
	},
	/// Import a selected foreign transcript into a fresh native `.oms`
	/// journal. Completion returns through `Outcome::ForeignSessionImport`;
	/// the picker then emits a typed [`HostCommand::SessionOpen`].
	ForeignSessionImport {
		/// Foreign transcript dialect.
		source: crate::overlays::services::ForeignSessionSource,
		/// Selected source transcript.
		path:   PathBuf,
	},
	/// Start a brand-new session file (`/new`, `/fresh`).
	SessionNew {
		/// Optional model selector for the new session.
		model: Option<Str>,
	},
	/// Delete the current session file and restart (`/drop`).
	SessionDrop,
	/// Roll the live chain back to `target` (`/rewind`, rewind selector).
	Rewind {
		/// Entry the next append branches from.
		target: EntryId,
	},
	/// Branch a new session file from `target` (`/fork`).
	Fork {
		/// Entry to branch from; `None` is the current head.
		target: Option<EntryId>,
	},
	/// Run a manual compaction path (`/compact`, `/handoff`, `/shake`).
	Compact {
		/// Summary path.
		method: CompactionMethod,
		/// Focus instructions, handoff prompt, or shake mode.
		hint:   Option<Str>,
	},
	/// Append a prompt to `<queues><prompts>` (`/queue`, `cl_followup`,
	/// `->` shorthand); media rides beside it exactly as for
	/// [`HostCommand::SubmitWithAttachments`] and starts the popped turn.
	Queue {
		/// Prompt run after the active turn.
		prompt:      Str,
		/// Media bytes plus MIME in marker order.
		attachments: Vec<omp_session::AttachmentInput>,
	},
	/// Engage or exit a Director by id (`/advisor`, `/vibe`, `/goal`, `/loop`,
	/// `/force`).
	Director {
		/// Director family.
		id:     Str,
		/// `true` engages; `false` exits.
		engage: bool,
		/// Director arguments.
		args:   Vec<Str>,
	},
	/// Spawn a side-channel agent (`/btw`, `/tan`).
	Spawn {
		/// Which side channel.
		kind: SpawnKind,
		/// Prompt text.
		text: Str,
	},
	/// Rename the session (`/rename`).
	Rename {
		/// Human-readable session title.
		title: Str,
	},
	/// Edit the `<meta><todo>` checklist (`/todo`).
	Todo(crate::commands::TodoOp),
	/// Gate new turns and queued prompts (`/pause`).
	Pause {
		/// `true` pauses; `false` resumes.
		active: bool,
	},
	/// Mark queued prompts as dequeued: the host pulled their text back into
	/// the composer ( `app.message.dequeue`).
	Dequeue {
		/// `<prompt id>` values under `<queues><prompts>`.
		prompts: Vec<Str>,
	},
	/// Push-to-talk recording edge: the app owns the microphone lease and
	/// recognizer, then streams typed [`SttUiEvent`] values back through the
	/// console mailbox.
	PushToTalk {
		/// `true` starts recording; `false` stops it and transcribes.
		active: bool,
	},
	/// Duplex live-voice control ( `/live`, Ctrl+L): the app owns the
	/// microphone lease and the realtime transport.
	LiveVoice(crate::overlays::live::LiveControl),
	/// Forward one finalized live utterance into the controller. The
	/// application owns duplicate admission, journaling, and streamed reply
	/// correlation; the actor performs no local transcript mutation.
	LiveDelegation {
		/// Transport request identity.
		id:      Str,
		/// Final recognized user text.
		request: Str,
	},
	/// Drop the model context in place, keeping the session (`/clear`,
	/// `resetSessionContext`): journal a `compaction@1` at the head whose
	/// summary is empty, so the projection starts over after it.
	ContextReset,
	/// Relocate the session to another project directory (`/move`, `/wt`):
	/// the journal moves into that directory's session bucket and the
	/// process working directory follows ( `moveSession` + `setProjectDir`).
	Move {
		/// Target project directory.
		path:   PathBuf,
		/// Create the final directory before relocating. The interactive
		/// confirmation preflights its parent; the controller owns the write.
		create: bool,
	},
	/// Run one tool locally without a model turn (the `!` / `$` composer
	/// prefixes).
	RunLocal {
		/// What to run.
		input: crate::composer::LocalInput,
		/// The submitted line verbatim, handed back through
		/// [`HostAction::LocalRefused`] when the controller cannot run it.
		draft: Str,
	},
	/// Re-run the tool batch the last turn died on ( `viewSession.retry()`
	/// over `hasAbortedToolCallTail`): the controller rewinds to the
	/// tool-calling assistant's tail (`Session::tool_tail_retry_target`) and
	/// resumes the turn, re-dispatching the same calls without a model
	/// round-trip. Emitted only while idle and [`aborted_tool_tail`] holds —
	/// the exact predicate that shows the `<key> to Retry` status row.
	Retry,
	/// Answer (or dismiss, `None`) the `ask` dialog for the tool element
	/// with call id `id`; the reply becomes that call's result.
	AskAnswer {
		/// `<ask id>` of the waiting call.
		id:      Str,
		/// Selections in question order, or `None` when the user pressed Esc.
		answers: Option<Vec<omp_tools::ask::Selection>>,
	},
	/// Mutate the project checkout on behalf of the Git workbench (stage,
	/// unstage, apply a patch, discard, commit). The controller runs it and
	/// answers with `Outcome::Git` through the console mailbox (ADR 0005).
	Git(crate::overlays::git::GitOp),
	/// Request a refreshed project or all-projects session index. The
	/// controller answers with `Outcome::SessionIndex`.
	SessionIndex {
		/// Requested index scope.
		scope: crate::overlays::services::SessionScope,
	},
	/// Mutate application state on behalf of a dashboard (extension, agent,
	/// plugin, account, session index, usage reset). The controller runs it
	/// through the app's [`crate::overlays::services::Mutations`] owner and
	/// answers with `Outcome::Service`.
	Service(crate::overlays::services::Mutation),
	/// Start, join, leave, or inspect a collaboration room. Relay and
	/// journal authority stay in the controller.
	Collab(crate::overlays::services::CollabOp),
	/// Arm  one-shot `@smol` prewalk for the next edit/write action.
	Prewalk,
	/// Supervise one agent from the hub: revive a parked one, kill a live
	/// one, or deliver text to it. The controller answers with
	/// `Outcome::Agent`.
	Agent {
		/// Agent (job) id under `<meta><jobs>`.
		id: Str,
		/// Requested operation.
		op: crate::overlays::hub::AgentOp,
	},
	/// Stop the application-owned controller loop because the host received a
	/// process signal. Unlike [`HostCommand::Quit`], this is journaled as an
	/// interrupted exit with the exact signal identity.
	ProcessSignal(omp_session::ExitSignal),
	/// Stop the application-owned controller loop normally.
	Quit,
}

/// Public name for the actor's one upward event mailbox.
pub type UpEvent = HostCommand;

/// Result of applying `C-c` to the current chat activity state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CtrlCAction {
	/// Clear the draft (or consume the first press when it is already empty).
	Clear,
	/// Leave chat and restore the terminal.
	Quit,
}

/// Resolves pi-compatible `C-c` behavior: only a repeat within the host's
/// 500 ms window exits; active work does not turn the first press into an
/// interrupt.
#[must_use]
pub const fn ctrl_c_action(repeated: bool) -> CtrlCAction {
	if repeated {
		CtrlCAction::Quit
	} else {
		CtrlCAction::Clear
	}
}

/// Observer-local surface shown when the chat actor first paints.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InitialPanel {
	/// Open the all-session resume picker.
	Sessions,
}

/// Interactive actor construction options.
pub struct HostOptions {
	/// Initial detached controller snapshot.
	pub snapshot:      Snapshot,
	/// Ordered DOM event stream following `snapshot`.
	pub dom_events:    Receiver<Event>,
	/// Ephemeral kernel progress notifications.
	pub kernel_events: Receiver<KernelEvent>,
	/// Commands back to the application controller.
	pub commands:      Sender<HostCommand>,
	/// Kernel's one upward steering/cancellation mailbox.
	pub up:            Sender<Up>,
	/// Shared command-stream context. It carries policy, not session state.
	pub con:           Arc<Ctx>,
	/// Catalog roster for the model picker (`cl_model_select`).
	pub models:        Vec<ModelRow>,
	/// `(role, model key, thinking)` roster for `cl_model_cycle` and
	/// `@role` picker rows, in cycle order.
	pub cycle:         Vec<(Str, Str, Option<Str>)>,
	/// Transcript resize policy.
	pub resize_policy: ResizePolicy,
	/// Launch model facts for the banner and status band.
	pub model:         ModelBadge,
	/// Project directory. The host watches its git checkout for the band's
	/// branch/dirty facts: observer-local, never journaled.
	pub project:       PathBuf,
	/// Launch facts for the welcome box (recent sessions, language servers).
	pub welcome:       WelcomeFacts,
	/// Ambient renderer context.
	pub ui:            UiContext,
	/// Application-supplied data feeds for dashboards and account commands.
	pub services:      Arc<dyn Services>,
	/// Text-to-speech backend for the assistant vocalizer ( `speech.*`);
	/// `None` leaves every speech mode silent.
	pub speech:        Option<Arc<dyn SpeechSynth>>,
	/// Whether startup resumed, forked, or imported a session. This explicit
	/// launch fact suppresses the intro even when the resumed journal is empty.
	pub resuming:      bool,
	/// Surface requested by the CLI before the first paint.
	pub initial_panel: Option<InitialPanel>,
}

/// Chat actor or terminal delivery failure.
#[derive(Debug, Error)]
pub enum HostError {
	/// Terminal lifecycle or geometry failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// Leaving terminal application modes failed.
	#[error("failed to restore the terminal: {source}")]
	TerminalRestore {
		/// Underlying terminal failure.
		#[source]
		source: io::Error,
	},
	/// A controller event could not be applied to the replica.
	#[error(transparent)]
	Dom(#[from] omp_dom::DomError),
	/// A bound console command failed.
	#[error(transparent)]
	Con(#[from] omp_con::ConError),
	/// A renderer delivery transaction failed.
	#[error(transparent)]
	Delivery(#[from] omp_tui::DeliveryError),
}

/// `#detectLeftDoubleTap`: two Left taps a human-plausible interval
/// apart, never a terminal-synthesized burst.
#[derive(Clone, Copy, Debug, Default)]
struct LeftTaps {
	last:  Option<Instant>,
	count: u8,
}

impl LeftTaps {
	/// Records a tap at `now`; returns whether it completed a double-tap.
	fn tap(&mut self, now: Instant) -> bool {
		let since = self.last.map(|last| now.duration_since(last));
		self.last = Some(now);
		match since {
			Some(gap) if gap < LEFT_DOUBLE_TAP_MAX_GAP => {
				self.count = self.count.saturating_add(1);
				if self.count == 2 && gap >= LEFT_DOUBLE_TAP_MIN_GAP {
					self.count = 0;
					self.last = None;
					return true;
				}
				false
			},
			_ => {
				self.count = 1;
				false
			},
		}
	}
}

/// Observer-local wall clock sampled only at its visible unit boundary or
/// when its status configuration changes. Paint reads `label` and performs no
/// time-zone lookup, formatting, or allocation.
#[derive(Default)]
struct WallClock {
	options:   Option<WallClockOptions>,
	label:     Option<Str>,
	next_wake: Option<Duration>,
}

impl WallClock {
	fn refresh(&mut self, now: Duration, appearance: &StatusAppearance, con: &Ctx) -> bool {
		let options = appearance.wall_clock_options(
			CL_STATUS_LINE_TIME_FORMAT.get(con),
			CL_STATUS_LINE_TIME_SHOW_SECONDS.get(con),
		);
		let due = self.next_wake.is_some_and(|deadline| now >= deadline);
		if options == self.options && !due {
			return false;
		}
		self.options = options;
		match options {
			Some(options) => {
				// `Zoned::now()` resolves the current system time zone afresh;
				// a zone change is therefore observed at the next visible unit.
				let local_now = Zoned::now();
				self.label = Some(format_wall_clock(&local_now, options));
				self.next_wake = Some(wall_clock_next_wake(now, &local_now, options));
			},
			None => {
				self.label = None;
				self.next_wake = None;
			},
		}
		true
	}

	const fn label(&self) -> Option<&Str> {
		self.label.as_ref()
	}

	const fn next_wake(&self) -> Option<Duration> {
		self.next_wake
	}
}

/// Presentation state shared by the terminal and native actors.
pub(crate) struct Presenter {
	pub(crate) replica: Dom,
	pub(crate) dom_events: Receiver<Event>,
	pub(crate) kernel_events: Receiver<KernelEvent>,
	pub(crate) commands: Sender<HostCommand>,
	pub(crate) up: Sender<Up>,
	pub(crate) con: Arc<Ctx>,
	pub(crate) cards: CardRegistry,
	pub(crate) ui: UiContext,
	pub(crate) model: ModelBadge,
	pub(crate) local: LocalFacts,
	/// Observer-local, sanitized extension status contributions.
	pub(crate) extension_status: ExtensionStatuses,
	pub(crate) composer: Composer,
	pub(crate) overlays: Overlays,
	pub(crate) turn_active: bool,
	/// Union of processing windows for the current session/branch.
	active_time: ActiveTime,
	/// Presentation-clock start of the in-flight turn (the band timer).
	pub(crate) turn_started: Option<Duration>,
	/// Cached local clock label and its visible-unit boundary.
	wall_clock: WallClock,
	/// Last `cl_clear` press, for  double-press exit window.
	pub(crate) last_clear: Option<Instant>,
	/// Double-Left gesture state ( `#detectLeftDoubleTap`).
	left_taps: LeftTaps,
	pub(crate) clock: Instant,
	/// Launch facts painted in the welcome box's right column.
	pub(crate) welcome: WelcomeFacts,
	/// Presentation-clock start of  3000ms brand intro; `None` once a
	/// rebuilt welcome should rest.
	intro: Option<Duration>,
	/// The one console mailbox: bound commands post actions here.
	pub(crate) mailbox: Arc<HostMailbox>,
	pub(crate) models: Vec<ModelRow>,
	pub(crate) cycle: Vec<(Str, Str, Option<Str>)>,
	/// Last prompt sent as a turn, for `cl_retry`.
	pub(crate) last_prompt: Option<Str>,
	/// Text the composer asked to copy; the terminal loop drains it into
	/// the clipboard (OSC 52 / native).
	pub(crate) clipboard: Option<Str>,
	/// Editor command resolved before terminal ownership is released.
	pending_editor: Option<Str>,
	/// Live git facts for the band; `None` outside a checkout. The watch is
	/// a drop guard: it runs for the presenter's lifetime.
	#[expect(dead_code, reason = "drop guard keeping the git watcher task alive")]
	pub(crate) git_watch: Option<GitWatch>,
	pub(crate) git_facts: Option<Receiver<GitFacts>>,
	/// Clipboard read the host asked for; the terminal loop starts it.
	pub(crate) clipboard_read: Option<ClipboardRead>,
	/// Application data feeds for panels.
	pub(crate) services: Arc<dyn Services>,
	/// `agent://` completion roster shared with the composer's URL provider.
	agents: AgentRoster,
	/// Registered Esc hooks (rungs 1 and 4 of the ladder).
	pub(crate) escape_hooks: Vec<EscapeHook>,
	/// Subagent whose session the view shows ( `focusedAgentId`).
	pub(crate) focused_agent: Option<Str>,
	/// This actor is a collaboration guest ( `collabGuest`).
	pub(crate) collab_guest: bool,
	/// Runtime-published collaboration role, real presence, and guest view of
	/// the authoritative host status.
	pub(crate) collab_status: Option<CollabStatus>,
	/// Space-hold push-to-talk detector.
	pub(crate) space_hold: SpaceHold,
	/// Whether push-to-talk is recording (space hold or `cl_stt_toggle`).
	pub(crate) stt_recording: bool,
	/// Whether a live-voice session is on ( `liveVoiceActive`).
	pub(crate) live_active: bool,
	/// Last archived dark/light palette names applied to `ui`.
	palette_names: [Str; 2],
	/// Observer-local palette before a settings submenu preview.
	preview_ui: Option<(Str, UiContext)>,
	/// Observer-local composer shape before a settings submenu preview.
	preview_shape: Option<(Str, ComposerStyle)>,
	/// Baseline and candidate status appearance during a settings preview.
	preview_status: Option<(Str, StatusAppearance, StatusAppearance)>,
	/// Presentation-clock instant the visible approval prompt appeared, for
	/// its countdown.
	approval_shown: Option<Duration>,
	/// Last presented terminal height, for panel viewports.
	viewport_height: u16,
	/// Terminal title run-state machine ( `title-generator.ts`); the
	/// terminal actor writes its output, the native actor never reads it.
	title: TerminalTitle,
	/// Whether native OSC 9;4 progress is currently shown (
	/// `#terminalProgressActive`).
	progress_shown: bool,
	/// `startup.quiet`: the welcome block is never projected.
	quiet: bool,
	/// Launch project directory: the title label's fallback until the
	/// kernel projects a cwd.
	project: PathBuf,
	/// Observer-local transcript facts: tool start instants, the thinking
	/// speed gauge, and the reset banner.
	pub(crate) transcript: crate::transcript::Local,
	/// Decides which desktop toasts a settled turn earns (
	/// `sendCompletionNotification` / `sendErrorNotification`).
	pub(crate) notifier: crate::notify::Notifier,
	/// Toasts decided since the last terminal delivery.
	pub(crate) notifications: Vec<omp_tui::Notification>,
	/// Periodic Codex quota refresh behind the reset fireworks.
	quota: crate::celebrate::QuotaWatch,
	/// Exact-account quota snapshot for the live provider/model route.
	account_usage: AccountUsageCache,
	/// Same-route provider retry the transport scheduled (
	/// `#retryPending`): pre-commit, so observer-local, cleared by the next
	/// inference start or turn end.
	pub(crate) retrying: Option<RetryState>,
	/// Elements of a failed attempt that a retry superseded (
	/// `#syntheticFailureCards`): their blocks leave the live projection so
	/// the re-streamed attempt never shows the same call twice.
	superseded: Vec<Handle>,
	/// Pinned error the user dismissed by sending the next message (
	/// `clearPinnedError`), so the banner drops before the DOM catches up.
	dismissed_error: Option<Handle>,
	/// Streaming assistant speech, when the app supplied a synthesizer.
	speech: Option<Arc<Mutex<Vocalizer>>>,
	/// `ask` call the notifier already toasted for.
	ask_notified: Option<Handle>,
	/// `ask` call the open dialog was projected from; cleared once it is
	/// answered so the dialog never reopens for the same call.
	ask_open: Option<Handle>,
}

/// Observer-local band facts that never enter the DOM.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalFacts {
	/// Checked-out git branch.
	pub branch:                Option<Str>,
	/// Exact staged, unstaged, and untracked counts.
	pub git_status:            Option<GitStatus>,
	/// Pull request associated with the checked-out branch.
	pub pull_request:          Option<PullRequest>,
	/// Linked-worktree identity.
	pub worktree:              Option<WorktreeLabel>,
	/// Platform temp directory, for  scratch-project labeling.
	pub tmp:                   Option<Str>,
	/// Live reasoning level when the model can reason.
	pub thinking:              Option<Str>,
	/// Live model route override (`ai_model`) when set.
	pub model:                 Option<Str>,
	/// Auto-compaction threshold as a whole percent (`ai_compact_threshold`).
	pub compact:               u8,
	/// Fast mode is on (`ai_fastmode`).
	pub fast:                  bool,
	/// Thinking level rides the model icon (`cl_status_compact_thinking`).
	pub compact_thinking:      bool,
	/// Background compaction summary in flight (`KernelEvent::
	/// CompactionSpeculating`), pulsing the gauge tick until it settles.
	pub speculation:           Speculation,
	/// Effective status-line appearance, including observer preview.
	pub status_appearance:     StatusAppearance,
	/// The active route's provider has a stored OAuth credential, so spend
	/// bills to a subscription ( `modelRegistry.isUsingOAuth`). Read from
	/// the account service at launch, on every model switch, and whenever a
	/// panel that may have signed in or out closes — never per frame.
	pub subscription:          bool,
	/// At least one journaled advisor serving identity was classified as
	/// OAuth-backed when its spend first appeared. Attribution is sticky for
	/// the session and is never queried while painting the status band.
	pub advisor_subscription:  bool,
	/// Advisor identities already classified for the current session.
	pub advisor_identities:    smallvec::SmallVec<crate::status_line::AdvisorIdentity, 2>,
	/// DOM session id whose advisor identities populate this cache.
	pub advisor_session:       Str,
	/// Last projected advisor spend, used to classify the receipt boundary
	/// even when a known identity accrues more cost.
	pub advisor_cost_nano_usd: u64,
}

impl Default for LocalFacts {
	fn default() -> Self {
		Self {
			branch:                None,
			git_status:            None,
			pull_request:          None,
			worktree:              None,
			tmp:                   None,
			thinking:              None,
			model:                 None,
			compact:               80,
			fast:                  false,
			compact_thinking:      true,
			speculation:           Speculation::None,
			status_appearance:     StatusAppearance::default(),
			subscription:          false,
			advisor_subscription:  false,
			advisor_identities:    smallvec::SmallVec::new(),
			advisor_session:       Str::default(),
			advisor_cost_nano_usd: 0,
		}
	}
}

impl LocalFacts {
	/// Facts fixed at launch: the git watch's launch probe and the platform
	/// temp directory.
	fn at_launch(git: Option<&GitFacts>) -> Self {
		let tmp = env::temp_dir();
		let tmp = tmp.to_str().map(|tmp| Str::new(tmp.trim_end_matches('/')));
		let mut facts = Self { tmp, ..Self::default() };
		if let Some(git) = git {
			facts.set_git(git);
		}
		facts
	}

	/// Applies one git watch delivery.
	fn set_git(&mut self, git: &GitFacts) {
		self.branch.clone_from(&git.branch);
		self.git_status.clone_from(&git.status);
		self.pull_request.clone_from(&git.pull_request);
		self.worktree.clone_from(&git.worktree);
	}

	/// Refreshes the convar-backed facts (`ai_thinking`, `ai_model`,
	/// `ai_compact_threshold`, `ai_fastmode`, `cl_status_compact_thinking`).
	fn sync_con(&mut self, con: &Ctx, badge: &ModelBadge) {
		self.thinking = badge.reasoning.then(|| AI_THINKING.get(con));
		self.model = Some(AI_MODEL.get(con)).filter(|model| !model.is_empty());
		self.compact = (AI_COMPACT_THRESHOLD.get(con) * 100.0)
			.round()
			.clamp(0.0, 100.0) as u8;
		self.fast = AI_FASTMODE.get(con);
		self.compact_thinking = CL_STATUS_COMPACT_THINKING.get(con);
		self.status_appearance = status_appearance(con, &self.status_appearance);
	}

	/// Re-reads whether the primary route is served by a stored OAuth
	/// credential ( `authStorage.hasOAuth(provider)`). An unavailable
	/// account service reads as metered.
	fn sync_primary_billing(&mut self, services: &dyn Services, badge: &ModelBadge) {
		self.subscription = services.accounts().is_ok_and(|accounts| {
			accounts
				.iter()
				.any(|account| account.provider == badge.provider && account.kind == "oauth")
		});
	}

	/// Classifies only newly projected advisor serving identities. Prior
	/// subscription attribution stays sticky even if an account later logs
	/// out; replacing the session resets and re-derives the cache once.
	fn sync_advisor_billing(&mut self, services: &dyn Services, dom: &Dom) {
		let session = dom
			.get(dom.meta())
			.and_then(|meta| meta.prop(&PropId::Id.into()))
			.and_then(Value::as_str)
			.map_or_else(Str::default, Str::new);
		let advisor = StatusLine::from_dom(dom).advisor;
		let (identities, latest, cost) = advisor.map_or_else(
			|| (smallvec::SmallVec::new(), None, 0),
			|advisor| (advisor.identities, Some(advisor.latest), advisor.cost_nano_usd),
		);
		let replaced = session != self.advisor_session;
		let rewound = self
			.advisor_identities
			.iter()
			.any(|identity| !identities.contains(identity))
			|| cost < self.advisor_cost_nano_usd;
		if replaced || rewound {
			self.advisor_session = session;
			self.advisor_identities.clear();
			self.advisor_subscription = false;
			self.advisor_cost_nano_usd = 0;
		}
		if identities == self.advisor_identities && cost == self.advisor_cost_nano_usd {
			return;
		}
		let cost_grew = cost > self.advisor_cost_nano_usd;
		if let Ok(accounts) = services.accounts() {
			let oauth = |provider: &Str| {
				accounts
					.iter()
					.any(|account| account.provider == *provider && account.kind == "oauth")
			};
			self.advisor_subscription |= identities
				.iter()
				.filter(|identity| !self.advisor_identities.contains(identity))
				.any(|identity| oauth(&identity.provider));
			if cost_grew && let Some(latest) = latest {
				self.advisor_subscription |= oauth(&latest.provider);
			}
		}
		self.advisor_identities = identities;
		self.advisor_cost_nano_usd = cost;
	}
}

/// What one routed input asked the host to do next. Ordered by strength so
/// several actions from one console line fold to the strongest.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum Routed {
	/// Nothing changed.
	Ignored,
	/// Presentation may have changed; repaint.
	Repaint,
	/// An observer-local projection toggle flipped; rebuild the projection.
	RebuildProjection,
	/// Re-probe the terminal and repaint everything from the retained
	/// document.
	DisplayReset,
	/// Leave the terminal, run the external editor over the draft, re-enter.
	ExternalEditor,
	/// Job-control suspend: leave the terminal, stop, re-enter on resume.
	Suspend,
	/// Leave the host.
	Quit,
}

/// Why the terminal actor released the tty.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Pause {
	/// The chat is over.
	Quit,
	/// Stop the process group until the shell resumes it.
	Suspend,
	/// Run the external editor over the draft.
	ExternalEditor,
	/// Re-probe capabilities and repaint from the retained document.
	DisplayReset,
}

fn finish_terminal_epoch(
	run: Result<Pause, HostError>,
	restore: io::Result<()>,
) -> Result<Pause, HostError> {
	restore.map_err(|source| HostError::TerminalRestore { source })?;
	run
}

/// `handleCtrlC` during shutdown: once the chat has quit and the tty is
/// restored, a further Ctrl+C (SIGINT) exits the process with 130 at once
/// instead of waiting for a hanging teardown (a wedged tool, a slow
/// `process_exit`). Defense in depth: the controller's own teardown still
/// runs first when it is quick.
fn arm_hard_abort() {
	tokio::spawn(async {
		if tokio::signal::ctrl_c().await.is_ok() {
			std::process::exit(HARD_ABORT_CODE);
		}
	});
}

/// Failure to suspend the foreground process group.
#[derive(Debug, Error)]
enum SuspendError {
	/// This platform has no POSIX job-control suspend.
	#[cfg(not(unix))]
	#[error("Suspend (Ctrl+Z) is not supported on this platform")]
	Unsupported,
	/// The operating system refused the uncatchable stop signal.
	#[cfg(unix)]
	#[error("Failed to suspend: {source}")]
	Signal {
		/// Underlying signal-delivery failure.
		#[source]
		source: nix::errno::Errno,
	},
}

/// `handleCtrlZ`: stop the whole foreground process group with `SIGSTOP`.
///
/// `SIGTSTP` is intentionally not used: any Tokio listener installed by a
/// child-process waiter replaces its default stop action process-wide.
/// `SIGSTOP` cannot be caught or ignored, so re-entry happens only after the
/// shell actually resumes the job.
fn suspend_process() -> Result<(), SuspendError> {
	#[cfg(unix)]
	{
		use nix::sys::signal;
		suspend_process_with(|pid, stop| signal::kill(pid, stop))
	}
	#[cfg(not(unix))]
	{
		Err(SuspendError::Unsupported)
	}
}

#[cfg(unix)]
fn suspend_process_with(
	send: impl FnOnce(nix::unistd::Pid, nix::sys::signal::Signal) -> Result<(), nix::errno::Errno>,
) -> Result<(), SuspendError> {
	send(nix::unistd::Pid::from_raw(0), nix::sys::signal::Signal::SIGSTOP)
		.map_err(|source| SuspendError::Signal { source })
}

impl Presenter {
	fn new(options: HostOptions, width: u16) -> Self {
		let resuming = options.resuming;
		let initial_panel = options.initial_panel;
		let mailbox = options.con.user::<HostMailbox>().unwrap_or_else(|| {
			HostMailbox::install(&options.con);
			options
				.con
				.user::<HostMailbox>()
				.expect("mailbox installed on the console")
		});
		let replica = Dom::from_snapshot(&options.snapshot);
		crate::commands::workspace::register_move_completer(&options.con, &options.services);
		let mut overlays = Overlays::default();
		overlays.sync_approval(&replica);
		let (git_watch, git_facts) = GitWatch::start(&options.project).unzip();
		let mut local = LocalFacts::at_launch(git_watch.as_ref().map(GitWatch::launch));
		local.sync_con(&options.con, &options.model);
		local.sync_primary_billing(options.services.as_ref(), &options.model);
		local.sync_advisor_billing(options.services.as_ref(), &replica);
		let turn_active = has_active_turn(&replica);
		let mut active_time = ActiveTime::default();
		active_time.set_running(Duration::ZERO, turn_active);
		let extension_status = ExtensionStatuses::default();
		let mut wall_clock = WallClock::default();
		let _ = wall_clock.refresh(Duration::ZERO, &local.status_appearance, &options.con);
		let facts = status_facts(
			&replica,
			&options.model,
			&local,
			wall_clock.label(),
			active_time.display_elapsed(Duration::ZERO),
			None,
			None,
			None,
			None,
			&options.con,
			&extension_status,
		);
		let agents: AgentRoster = Arc::new(Mutex::new(agent_roster(&replica)));
		let mut composer = Composer::new(
			width,
			options.ui.clone(),
			facts,
			slash::with_service_completions(
				slash::roster(&options.con),
				Arc::clone(&options.services),
			),
			url_completer(&options.services, &agents),
			project_root(&replica).as_deref(),
		);
		// `setHistoryStorage`: every editor starts from durable history.
		// Merge the live session's journal-derived prompts without writing
		// them back, so a migrated/empty database still recalls a resumed
		// session and transcript rebuilds never duplicate persistent rows.
		let mut prompt_history = options
			.services
			.history_recent(100)
			.unwrap_or_default()
			.into_iter()
			.map(|entry| entry.prompt)
			.collect::<Vec<_>>();
		if resuming {
			prompt_history.extend(crate::overlays::prompt_history(&replica));
		}
		composer.seed_history(prompt_history);
		composer.set_spelling_features(spelling_features(&options.con));
		// A resumed or already-running session starts active ( derives
		// `isStreaming` from the session, never from a local edge).
		// `suppressWelcomeIntro: resuming`: a session opened with history
		// (`--continue`, `--resume`, `--fork`, an import) rests at once; a
		// quiet startup (`cl_startup_quiet`) shows no welcome at all.
		let quiet = CL_STARTUP_QUIET.get(&options.con);
		let intro = (!quiet && !resuming).then_some(Duration::ZERO);
		// Toasts and the terminal title carry the live session name.
		let session_name = StatusLine::name(&replica);
		let mut title = TerminalTitle::new();
		title.set_enabled(CL_TITLE_STATE.get(&options.con));
		title.set_label(session_name.as_deref(), &options.project.to_string_lossy());
		// The vocalizer answers Esc rung 4 while it has audio to silence
		// and `cl_voice_silence` through the console slot.
		let mut escape_hooks = Vec::new();
		let speech = options.speech.map(|synth| {
			let vocalizer = Arc::new(Mutex::new(Vocalizer::new(synth, Arc::clone(&options.con))));
			crate::notices::voice::install(&options.con, Arc::clone(&vocalizer));
			let hook = Arc::clone(&vocalizer);
			escape_hooks.push(EscapeHook::new("voice", EscapeRung::Silence, move || {
				let mut vocalizer = hook.lock();
				if vocalizer.speaking() {
					vocalizer.silence();
					true
				} else {
					false
				}
			}));
			vocalizer
		});
		let palette_names = [CL_THEME_DARK.get(&options.con), CL_THEME_LIGHT.get(&options.con)];
		let mut presenter = Self {
			replica,
			dom_events: options.dom_events,
			kernel_events: options.kernel_events,
			commands: options.commands,
			up: options.up,
			con: options.con,
			cards: CardRegistry::standard(),
			ui: options.ui,
			model: options.model,
			local,
			extension_status,
			composer,
			overlays,
			turn_active,
			active_time,
			turn_started: None,
			wall_clock,
			last_clear: None,
			left_taps: LeftTaps::default(),
			clock: Instant::now(),
			intro,
			mailbox,
			models: options.models,
			cycle: options.cycle,
			last_prompt: None,
			clipboard: None,
			pending_editor: None,
			git_watch,
			git_facts,
			welcome: options.welcome,
			clipboard_read: None,
			services: options.services,
			agents,
			escape_hooks,
			focused_agent: None,
			collab_guest: false,
			collab_status: None,
			space_hold: SpaceHold::default(),
			stt_recording: false,
			live_active: false,
			palette_names,
			preview_ui: None,
			preview_shape: None,
			preview_status: None,
			approval_shown: None,
			viewport_height: 24,
			title,
			progress_shown: false,
			quiet,
			project: options.project,
			transcript: crate::transcript::Local::default(),
			quota: crate::celebrate::QuotaWatch::default(),
			account_usage: AccountUsageCache::default(),
			notifier: crate::notify::Notifier::new(session_name),
			notifications: Vec::new(),
			retrying: None,
			superseded: Vec::new(),
			dismissed_error: None,
			speech,
			ask_notified: None,
			ask_open: None,
		};
		let _ = presenter.poll_account_usage(Duration::ZERO);
		if initial_panel == Some(InitialPanel::Sessions) {
			let _ = presenter.run_console("resume");
		}
		presenter
	}

	/// Applies one ephemeral kernel notification. Retry facts drive the
	/// countdown loader and the superseded-card retraction; text deltas
	/// feed the vocalizer; the thinking speed gauge reads usage. Returns
	/// the strongest repaint the event asks for.
	pub(crate) fn apply_kernel_event(&mut self, event: &KernelEvent) -> Routed {
		let now = self.clock.elapsed();
		let mut routed = if self.transcript.on_kernel_event(event, now) {
			Routed::RebuildProjection
		} else {
			Routed::Ignored
		};
		match event {
			KernelEvent::InferenceRetry { attempt, max_attempts, delay, reason } => {
				self.retrying =
					Some(RetryState::new(*attempt, *max_attempts, *delay, reason.clone(), now));
				self.notifier.set_retry_pending(true);
				// `#handleAutoRetryStart`: the failed attempt's synthetic
				// cards leave the transcript before the retry streams.
				for handle in superseded_notice_keys(&self.replica) {
					if !self.superseded.contains(&handle) {
						self.superseded.push(handle);
					}
				}
				routed = Routed::RebuildProjection;
			},
			KernelEvent::InferenceStarted => {
				if self.retrying.take().is_some() {
					self.notifier.set_retry_pending(false);
					routed = routed.max(Routed::Repaint);
				}
			},
			KernelEvent::TurnEnded { stop } => {
				if self.retrying.take().is_some() {
					self.notifier.set_retry_pending(false);
					routed = routed.max(Routed::Repaint);
				}
				if matches!(stop, omp_agent::TurnStop::Completed | omp_agent::TurnStop::Steered)
					&& let Some(speech) = &self.speech
				{
					let mode = Vocalizer::mode(&self.con);
					let text = last_assistant_text(&self.replica);
					speech
						.lock()
						.turn_ended(mode, text.as_deref().unwrap_or_default());
				}
			},
			KernelEvent::TextDelta(delta) => {
				if let Some(speech) = &self.speech {
					let mode = Vocalizer::mode(&self.con);
					speech.lock().push_text(mode, delta);
				}
			},
			KernelEvent::ThinkingDelta(delta) => {
				if let Some(speech) = &self.speech {
					let mode = Vocalizer::mode(&self.con);
					speech.lock().push_thinking(mode, delta);
				}
			},
			// `compactionSpeculation`: the gauge tick pulses while the
			// summary is produced and rests once the boundary lands.
			KernelEvent::CompactionSpeculating { .. } => {
				self.local.speculation = Speculation::Running;
				self.sync_status();
				routed = routed.max(Routed::Repaint);
			},
			KernelEvent::CompactionSettled { .. } => {
				self.local.speculation = Speculation::None;
				self.sync_status();
				routed = routed.max(Routed::Repaint);
			},
			KernelEvent::Usage { .. }
			| KernelEvent::ToolReady { .. }
			| KernelEvent::ToolUpdate { .. }
			| KernelEvent::ToolSettled { .. } => {},
			// Delivered jobs, answered workflow actions, and filed approval
			// prompts land in the DOM (async-result follow-ups, tool results,
			// `<queues><prompts>`); the patch stream projects them (the
			// approval overlay opens from `sync_approval`), so the event
			// itself carries no host state.
			KernelEvent::JobsDelivered { .. }
			| KernelEvent::WorkflowActionAnswered { .. }
			| KernelEvent::ApprovalRequested(_) => {},
		}
		self.log_speech_failure();
		routed
	}

	fn log_speech_failure(&self) {
		if let Some(speech) = &self.speech
			&& let Some(error) = speech.lock().take_failure()
		{
			tracing::debug!(%error, "assistant vocalization degraded");
		}
	}

	/// Stops speech at once: a new user message or an interrupt (
	/// `vocalizer.clear`).
	fn silence_speech(&self) {
		if let Some(speech) = &self.speech {
			speech.lock().clear();
		}
	}

	/// Whether a DOM patch closed an assistant message (its `stop-reason`
	/// landed) with a reason other than cancellation — the vocalizer flushes
	/// the buffered partial then ( `message_end`).
	fn assistant_completed(event: &Event) -> bool {
		let Event::Patch(patch) = event else {
			return false;
		};
		patch.ops.iter().any(|op| {
			matches!(
				op,
				Op::Set { prop, value: Value::Str(reason), .. }
					if *prop == PropId::StopReason.into()
						&& !matches!(reason.as_str(), "cancelled" | "aborted")
			)
		})
	}

	/// `notifyAsk`: the first `ask` call blocked on the user earns one
	/// toast with its first question.
	fn notify_ask(&mut self) {
		let Some(ask) = waiting_ask(&self.replica) else {
			return;
		};
		if self.ask_notified == Some(ask) {
			return;
		}
		self.ask_notified = Some(ask);
		let question = ask_questions(&self.replica, ask)
			.and_then(|questions| questions.into_iter().next())
			.map(|question| question.question)
			.unwrap_or_default();
		if let Some(toast) = self.notifier.ask_pending(&self.con, &question) {
			self.notifications.push(toast);
		}
	}

	/// Projects the `ask` dialog from the running `<ask>` element (
	/// `AskDialogComponent` over the tool's `askDialog` request): opened once
	/// per element, closed when the element settles or the turn moves on.
	/// An answered dialog stays closed while its call finishes.
	fn sync_ask(&mut self) {
		let waiting = waiting_ask(&self.replica);
		if waiting == self.ask_open {
			return;
		}
		if self.ask_open.take().is_some() {
			self.overlays.close_id(crate::overlays::ask::ID);
		}
		let Some(ask) = waiting else {
			return;
		};
		let Some(questions) = ask_questions(&self.replica, ask) else {
			return;
		};
		let id = self
			.replica
			.get(ask)
			.and_then(|node| node.prop(&PropId::Id.into()))
			.and_then(Value::as_str)
			.map(Str::new);
		let Some(id) = id else {
			return;
		};
		let timeout = crate::overlays::ask::timeout(&self.panel_cx(self.viewport()));
		let dialog = crate::overlays::ask::AskDialog::open(
			id,
			questions,
			timeout,
			self.clock.elapsed(),
			self.viewport(),
			&self.ui,
		);
		self.overlays.show(Overlay::Panel(Box::new(dialog)));
		self.ask_open = Some(ask);
		let _ = self.commands.send(HostCommand::Overlay {
			id:   Str::new_static(crate::overlays::ask::ID),
			open: true,
		});
	}

	/// Chord label of the `cl_retry` binding for the idle retry hint (
	/// `keybindings.getKeys("app.retry")[0] ?? "f5"`).
	fn retry_key_label(&self) -> Str {
		self
			.con
			.binds()
			.into_iter()
			.filter(|(_, script)| script.split(";").any(|line| line.trim() == "cl_retry"))
			.map(|(chord, _)| chord)
			.min_by(|left, right| left.len().cmp(&right.len()).then_with(|| left.cmp(right)))
			.unwrap_or_else(|| Str::new_static("f5"))
	}

	/// The pinned error banner above the editor: the error notice that ended
	/// the last turn, until the next message is sent ( `setErrorPinned` /
	/// `clearPinnedError`).
	fn banner_frame(&self, width: u16) -> Option<Frame> {
		let (handle, text) = pinned_error(&self.replica)?;
		if self.dismissed_error == Some(handle) || self.superseded.contains(&handle) {
			return None;
		}
		Some(
			Ui::from_root(error_banner(text), width, self.ui.clone())
				.frame()
				.clone(),
		)
	}

	///  status container row above the editor: the retry countdown
	/// loader while a retry is scheduled, else the transient notice, else
	/// the idle `<key> to Retry` hint after a turn died on a tool call.
	fn status_frame(&self, width: u16) -> Option<Frame> {
		if let Some(state) = &self.retrying {
			let mut ui = Ui::from_root(RetryLoader::new(state.clone()), width, self.ui.clone());
			ui.tick(self.clock.elapsed());
			return Some(ui.frame().clone());
		}
		if let Some(frame) = self.notice_frame(width) {
			return Some(frame);
		}
		if !self.turn_active && aborted_tool_tail(&self.replica) {
			let label = self.retry_key_label();
			return Some(
				Ui::from_root(retry_hint_row(&label), width, self.ui.clone())
					.frame()
					.clone(),
			);
		}
		None
	}

	/// Next repaint the retry loader needs: its spinner frame or the next
	/// whole second of the countdown.
	fn retry_wake(&self) -> Option<Duration> {
		let state = self.retrying.as_ref()?;
		let now = self.clock.elapsed();
		let spinner = self.ui.charset.spinner().next_change(now);
		Some(match state.next_wake(now) {
			Some(second) => spinner.min(second),
			None => spinner,
		})
	}

	/// The editor band: the pinned error banner stacked over the composer
	/// ( `errorBannerContainer` directly above `editorContainer`).
	fn chrome_frame(&self, width: u16) -> Frame {
		let composer = self.composer.frame();
		let Some(banner) = self.banner_frame(width) else {
			return composer.clone();
		};
		let rows = banner.size().height;
		let mut frame = Frame::new(Size::new(width, rows.saturating_add(composer.size().height)));
		frame.blit(&banner, 0, rows, 0, 0);
		frame.blit(composer, 0, composer.size().height, 0, rows);
		frame
	}

	/// Records a turn-activity edge; the band timer starts on the rising edge
	/// and clears on the falling one.
	fn set_turn_active(&mut self, active: bool) {
		self.active_time.set_running(self.clock.elapsed(), active);
		if active && !self.turn_active {
			self.turn_started = Some(self.clock.elapsed());
		} else if !active {
			self.turn_started = None;
		}
		self.turn_active = active;
	}

	fn show_thinking(&self) -> bool {
		CL_SHOWTHINKING.get(&self.con)
	}

	/// Retires the intro clock once  3000ms brand intro has played; the
	/// caller reconciles so the welcome block flips to finalized (and may
	/// retire under row pressure) without waiting for a DOM event.
	fn settle_intro(&mut self, now: Duration) -> bool {
		match self.intro {
			Some(start) if Intro::done(now.saturating_sub(start)) => {
				self.intro = None;
				true
			},
			_ => false,
		}
	}

	/// The welcome block. While  3000ms brand intro runs the block stays
	/// mutable and unfinalized so it cannot retire into scrollback
	/// (ADR 0034); the block mounts with the intro time already elapsed, since
	/// a mounted block's clock starts at its epoch. Once the intro settles
	/// `finalized` flips, the projection remounts the block once, and that
	/// remount paints the resting frame.
	fn welcome(&self) -> RenderedBlock {
		let status = StatusLine::from_dom(&self.replica);
		let now = self.clock.elapsed();
		let intro = self
			.intro
			.map(|start| now.saturating_sub(start))
			.filter(|elapsed| !Intro::done(*elapsed));
		let welcome = Welcome::new(
			Str::new_static(env!("CARGO_PKG_VERSION")),
			&self.model,
			tip_for(status.session.as_str(), self.ui.charset),
			self.welcome.clone(),
			intro,
		);
		RenderedBlock {
			view:      BlockView {
				key:       0,
				kind:      BlockKind::Welcome,
				text:      Str::new_static("welcome"),
				mode:      Mode::Mutable,
				finalized: intro.is_none(),
			},
			component: Box::new(welcome),
			stream:    None,
		}
	}

	/// Observer-local projection switches for this paint.
	fn project_options(&self) -> crate::project::Options<'_> {
		crate::project::Options {
			show_thinking: self.show_thinking(),
			show_tools:    crate::actions::CL_SHOWTOOLS.get(&self.con),
			expanded:      crate::actions::CL_TOOLS_EXPANDED.get(&self.con),
			smooth:        crate::transcript::CL_SMOOTH_STREAMING.get(&self.con),
			prose_only:    crate::transcript::CL_THINKING_PROSE_ONLY.get(&self.con),
			show_usage:    crate::settings::CL_DISPLAY_SHOW_TOKEN_USAGE.get(&self.con)
				|| crate::settings::CL_DISPLAY_SHOW_TURN_TIME.get(&self.con),
			local:         &self.transcript,
		}
	}

	fn blocks(&self) -> Vec<RenderedBlock> {
		// `startup.quiet` skips the welcome screen.
		let mut blocks = Vec::new();
		if !self.quiet {
			blocks.push(self.welcome());
		}
		let projected = project(&self.replica, &self.cards, &self.ui, &self.project_options());
		for block in projected {
			// Retry-superseded elements stay in the DOM but leave the view.
			if Handle::new(block.view.key / 8).is_some_and(|handle| self.superseded.contains(&handle))
			{
				continue;
			}
			blocks.push(block);
		}
		blocks
	}

	fn apply_dom_event(&mut self, event: &Event) -> Result<(), HostError> {
		if let Event::Reset { snapshot } = event {
			self.silence_speech();
			let next = Dom::from_snapshot(snapshot);
			self.transcript.on_reset(&self.replica, &next);
			// A replaced document drops every observer-local transcript fact
			// keyed to the old one ( `resetTranscript`).
			self.superseded.clear();
			self.dismissed_error = None;
			self.ask_notified = None;
			self.extension_status.apply(ExtensionStatus::reset());
			if self.ask_open.take().is_some() {
				self.overlays.close_id(crate::overlays::ask::ID);
			}
		}
		let completed = Self::assistant_completed(event);
		self.replica.apply_event(event)?;
		self
			.local
			.sync_advisor_billing(self.services.as_ref(), &self.replica);
		// Agents come and go through `ins`/`rm` under `<meta><jobs>`; a
		// stream or a bare `set` never changes the `agent://` roster.
		let structural = match event {
			Event::Reset { .. } => true,
			Event::Patch(patch) => patch
				.ops
				.iter()
				.any(|op| matches!(op, Op::Ins { .. } | Op::Rm(_) | Op::Mv { .. })),
			Event::Stream { .. } => false,
		};
		if structural {
			*self.agents.lock() = agent_roster(&self.replica);
		}
		if completed && let Some(speech) = &self.speech {
			let mode = Vocalizer::mode(&self.con);
			speech.lock().message_completed(mode);
			self.log_speech_failure();
		}
		self.transcript.observe(&self.replica, self.clock.elapsed());
		let panel_event = self
			.overlays
			.notify_panels(crate::overlays::PanelNote::Dom(&self.replica));
		if panel_event != PanelEvent::Ignored {
			let _ = self.apply_panel_event(panel_event)?;
		}
		self.notify_ask();
		self.sync_ask();
		let was_active = self.turn_active;
		let active = has_active_turn(&self.replica);
		if matches!(event, Event::Reset { .. }) {
			self.active_time.reset(self.clock.elapsed(), active);
		}
		self.set_turn_active(active);
		// A session rename, `/new`, or `/resume` retitles later toasts and
		// the tab.
		if Self::sets_session_title(event, self.replica.meta()) {
			self.sync_session_name();
		}
		if was_active
			&& !self.turn_active
			&& let Some(end) = crate::notify::Notifier::turn_end_from_dom(&self.replica)
			&& let Some(toast) = self.notifier.turn_ended(&self.con, end)
		{
			self.notifications.push(toast);
		}
		let before = self.overlays.approval().map(|approval| approval.id.clone());
		self.overlays.sync_approval(&self.replica);
		let after = self.overlays.approval().map(|approval| approval.id.clone());
		if before != after {
			self.approval_shown = after.is_some().then(|| self.clock.elapsed());
		}
		Ok(())
	}

	/// Whether `event` establishes an authoritative session title. A reset is
	/// a session switch; within one session only `<meta name>` is
	/// authoritative. Ordinary model, cwd, status, and run-state mutations
	/// must not clear an extension-owned title.
	fn sets_session_title(event: &Event, meta: Handle) -> bool {
		match event {
			Event::Reset { .. } => true,
			Event::Patch(patch) => patch.ops.iter().any(|op| {
				matches!(
					op,
					Op::Set {
						h,
						prop: PropKey::Known(PropId::Name),
						..
					} if *h == meta
				)
			}),
			Event::Stream { node: Some(node), prop: Some(PropKey::Known(PropId::Name)), .. } => {
				*node == meta
			},
			Event::Stream { .. } => false,
		}
	}

	/// Refreshes the session label on the notifier and the terminal title
	/// from `<meta name>` and the projected cwd.
	fn sync_session_name(&mut self) {
		let name = StatusLine::name(&self.replica);
		match StatusLine::cwd(&self.replica) {
			Some(cwd) => self.title.set_label(name.as_deref(), cwd.as_str()),
			None => self
				.title
				.set_label(name.as_deref(), &self.project.to_string_lossy()),
		}
		self.notifier.set_session_name(name);
	}

	/// Facts a panel reads while opening or running a call.
	fn panel_cx(&self, viewport: Size) -> PanelCx<'_> {
		PanelCx {
			dom: &self.replica,
			con: &self.con,
			ui: &self.ui,
			viewport,
			services: &self.services,
		}
	}

	/// Whether a Director of `family` is active on the live chain (frames
	/// nest under `<meta><directors>`, so the scan is recursive).
	fn director_engaged(&self, family: &str) -> bool {
		let dom = &self.replica;
		let Some(root) = dom.children(dom.meta()).iter().copied().find(|handle| {
			dom.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Directors))
		}) else {
			return false;
		};
		let family_key = omp_dom::PropKey::Custom(Str::new_static("family"));
		let status = omp_dom::PropKey::Custom(Str::new_static("status"));
		let mut pending = dom.children(root).to_vec();
		while let Some(handle) = pending.pop() {
			let Some(node) = dom.get(handle) else {
				continue;
			};
			if node.tag == Tag::Known(KnownTag::Director)
				&& node.prop(&family_key).and_then(Value::as_str) == Some(family)
				&& node.prop(&status).and_then(Value::as_str) == Some("active")
			{
				return true;
			}
			pending.extend(node.kids.iter().copied());
		}
		false
	}

	/// Pending queued prompts under `<queues><prompts>` (`/queue`), oldest
	/// first, as `(id, text)`.
	fn queued_prompts(&self) -> Vec<(Str, Str)> {
		let dom = &self.replica;
		let kind = PropId::Kind.into();
		let status = PropId::Status.into();
		let id = PropId::Id.into();
		dom.children(dom.queues())
			.iter()
			.filter_map(|handle| dom.get(*handle))
			.find(|node| node.tag == Tag::Known(KnownTag::Prompts))
			.into_iter()
			.flat_map(|prompts| prompts.kids.iter())
			.filter_map(|handle| dom.get(*handle))
			.filter(|node| {
				node.tag == Tag::Known(KnownTag::Prompt)
					&& node.prop(&kind).and_then(Value::as_str) == Some("queued")
					&& node.prop(&status).and_then(Value::as_str) == Some("pending")
			})
			.filter_map(|node| {
				let id = node.prop(&id).and_then(Value::as_str)?;
				Some((Str::new(id), node.content.clone().unwrap_or_default()))
			})
			.collect()
	}

	/// `model_changed`: when `ai_model` names a catalog row other than the
	/// badge's, the badge is rebuilt from that row so the welcome box, the
	/// context gauge, the thinking gate, and quota polling follow the switch
	/// (picker, role cycle, console write, or a Director bind alike). A
	/// route the picker does not list (custom provider, direct `provider/
	/// model` syntax) still replaces the badge, from the identifier alone,
	/// so nothing keeps reading the previous model's facts.
	fn adopt_live_model(&mut self) {
		let live = AI_MODEL.get(&self.con);
		if live.is_empty() || live == self.model.identifier {
			return;
		}
		self.model = match self.models.iter().find(|row| row.key == live) {
			Some(row) => ModelBadge::from_row(row),
			None => ModelBadge::from_identifier(&live),
		};
		self.account_usage.invalidate();
		self
			.local
			.sync_primary_billing(self.services.as_ref(), &self.model);
	}

	fn poll_account_usage(&mut self, now: Duration) -> bool {
		self.adopt_live_model();
		self.account_usage.poll(
			self.services.as_ref(),
			ActiveUsageRequest {
				provider: self.model.provider.clone(),
				model:    self.model.identifier.clone(),
			},
			now,
		)
	}

	fn sync_status_inputs(&mut self) {
		self.adopt_live_model();
		self.local.sync_con(&self.con, &self.model);
		if let Some((_, _, preview)) = &self.preview_status {
			self.local.status_appearance = preview.clone();
		}
	}

	/// Publishes one complete ambient context to every retained local surface.
	fn set_ui_context(&mut self, ui: UiContext) {
		self.ui = ui;
		self.composer.set_context(self.ui.clone());
		self.overlays.set_context(&self.ui);
	}

	/// Applies newly persisted dark/light names as one ambient-context swap.
	///
	/// A preview starts from a saved baseline, so committing the inactive
	/// appearance restores the palette appropriate to the terminal rather than
	/// leaving the preview palette active. Components continue to read only
	/// `UiContext`; palette names never thread through the tree.
	fn sync_palette_settings(&mut self) -> bool {
		let names = [CL_THEME_DARK.get(&self.con), CL_THEME_LIGHT.get(&self.con)];
		if names == self.palette_names {
			return false;
		}
		let dark = match self.services.theme(names[0].as_str()) {
			Ok(theme) => theme,
			Err(error) => {
				self.overlays.notify(error.to_string());
				return false;
			},
		};
		let light = match self.services.theme(names[1].as_str()) {
			Ok(theme) => theme,
			Err(error) => {
				self.overlays.notify(error.to_string());
				return false;
			},
		};
		let mut ui = self
			.preview_ui
			.as_ref()
			.map_or_else(|| self.ui.clone(), |(_, baseline)| baseline.clone());
		ui.set_appearance_palettes(dark, light);
		self.set_ui_context(ui);
		self.palette_names = names;
		true
	}

	/// Samples and formats the local wall clock only when its visible unit or
	/// effective settings changed. Callers run this before deciding to paint.
	fn refresh_wall_clock(&mut self, now: Duration) -> bool {
		self.sync_status_inputs();
		self
			.wall_clock
			.refresh(now, &self.local.status_appearance, &self.con)
	}

	fn sync_status(&mut self) -> bool {
		self.sync_status_inputs();
		let now = self.clock.elapsed();
		let facts = status_facts(
			&self.replica,
			&self.model,
			&self.local,
			self.wall_clock.label(),
			self.active_time.display_elapsed(now),
			self.turn_started.filter(|_| !self.live_active),
			self.focused_agent.as_deref(),
			self.collab_status.clone(),
			self.account_usage.usage(),
			&self.con,
			&self.extension_status,
		);
		// The composer wears the rail while the plan Director is engaged.
		// status row collapses the editor top gap (`EditorTopGap` /
		// `statusRowOccupied`); this host paints the notice *in* the gap row
		// instead (see `present`), so the gap stays and the band sits flush
		// under the notice exactly as in pi.
		let reshaped = if self.plan_engaged() {
			self.composer.set_shape(ComposerStyle::Rail)
		} else {
			let shape = self
				.con
				.get("cl_composer_shape")
				.and_then(|value| value.as_str().map(composer_style))
				.unwrap_or_default();
			self.composer.set_shape(shape)
		};
		let ime = self
			.composer
			.set_ime_safe_cursor(CL_IME_SAFE_CURSOR.get(&self.con));
		// `applySpellingSettings`: the `cl_spelling_*` convars reach the
		// live editor on every settings write (`/settings`, cfg, console).
		let spelling = self
			.composer
			.set_spelling_features(spelling_features(&self.con));
		// `setAutocompleteMaxVisible` / `emojiAutocomplete` /
		// `paste.largeMenuThreshold`: same live path as the spelling gates.
		let knobs = self.composer.set_settings(composer_settings(&self.con));
		self.composer.set_status(facts) || reshaped || ime || spelling || knobs
	}

	/// Routes one semantic key from native/debug input. Real terminals use
	/// [`Self::route_chord`] so a physical release and exact modifiers
	/// survive through the command stream.
	fn route_key(&mut self, key: Key) -> Result<Routed, HostError> {
		if self.overlays.approval().is_some() {
			return self.route_approval_key(key);
		}
		if key == Key::Ctrl('c') && self.ask_open.is_some() {
			return Ok(self.interrupt_turn());
		}
		if matches!(key, Key::Ctrl('c') | Key::Copy | Key::FollowUp)
			&& matches!(self.overlays.active(), Some(Overlay::History(_)))
		{
			return self.route_unbound_key(key);
		}
		if key == Key::Esc && self.ask_open.is_some() {
			return self.route_unbound_key(key);
		}
		if let Some(chord) = crate::input::chord(key)
			&& self.con.bound(chord.as_str()).is_some()
		{
			let pressed = self.run_bound_key(chord.as_str(), true)?;
			let released = self.run_bound_key(chord.as_str(), false)?;
			return Ok(pressed.max(released));
		}
		if key == Key::Ctrl('c') {
			return self.act(HostAction::Clear);
		}
		self.route_unbound_key(key)
	}

	/// Routes one exact physical edge through the live con bind table.
	fn route_chord(&mut self, event: KeyEvent) -> Result<Routed, HostError> {
		if self.overlays.approval().is_some() {
			return if event.pressed {
				event
					.key
					.map_or(Ok(Routed::Repaint), |key| self.route_approval_key(key))
			} else {
				Ok(Routed::Ignored)
			};
		}
		if event.pressed && event.key == Some(Key::Ctrl('c')) && self.ask_open.is_some() {
			return Ok(self.interrupt_turn());
		}
		if event.pressed
			&& matches!(self.overlays.active(), Some(Overlay::History(_)))
			&& let Some(key @ (Key::Ctrl('c') | Key::Copy | Key::FollowUp)) = event.key
		{
			return self.route_unbound_key(key);
		}
		if event.pressed && event.key == Some(Key::Esc) && self.ask_open.is_some() {
			return self.route_unbound_key(Key::Esc);
		}
		let chord = event.chord.label();
		if !event.pressed {
			// `Ctx` latches the press program. Always forward the matching
			// release, even if that program unbound or remapped its own chord.
			return self.run_bound_key(chord.as_str(), false);
		}
		if self.con.bound(chord.as_str()).is_some() {
			return self.run_bound_key(chord.as_str(), true);
		}
		event
			.key
			.map_or(Ok(Routed::Ignored), |key| self.route_unbound_key(key))
	}

	/// Swallows every key while policy is blocked on approval. Escape is an
	/// explicit denial, never a local-only overlay dismissal.
	fn route_approval_key(&mut self, key: Key) -> Result<Routed, HostError> {
		let Some(approval) = self.overlays.approval().cloned() else {
			return Ok(Routed::Ignored);
		};
		let choice = match key {
			Key::Esc => Some('n'),
			Key::Char(value) => Some(value.to_ascii_lowercase()),
			_ => None,
		};
		if let Some(decision) = choice.and_then(|choice| approval.decision(choice)) {
			let _ = self
				.commands
				.send(HostCommand::Approve { id: approval.id, decision });
			self.overlays.dismiss();
		}
		Ok(Routed::Repaint)
	}

	/// Routes a key after bind lookup. Bound editor commands re-enter here,
	/// allowing one command to drive composers, pickers, and panels.
	fn route_unbound_key(&mut self, key: Key) -> Result<Routed, HostError> {
		let had_notice = self.overlays.notice().is_some();
		self.overlays.clear_notice();
		if key == Key::Ctrl('c') && self.ask_open.is_some() {
			return Ok(self.interrupt_turn());
		}
		if self.overlays.modal() {
			let event = match self.overlays.active_mut() {
				Some(Overlay::Models(picker)) => Some(picker.key(key)),
				Some(Overlay::History(picker)) => Some(picker.key(key)),
				Some(Overlay::Approval(_)) => return self.route_approval_key(key),
				Some(Overlay::Panel(panel)) => {
					panel.touch(self.clock.elapsed());
					let event = panel.key(key);
					let event = match (event, key) {
						(PanelEvent::Ignored, Key::Esc) => PanelEvent::Close,
						(event, _) => event,
					};
					return self.apply_panel_event(event);
				},
				None => None,
			};
			if let Some(event) = event {
				return self.apply_picker_event(event);
			}
		}
		let side_reserved =
			matches!(key, Key::Char('c') | Key::Up | Key::Down | Key::PageUp | Key::PageDown);
		if side_reserved
			&& self.composer.text().is_empty()
			&& let Some(Overlay::Panel(panel)) = self.overlays.active_mut()
			&& panel.anchor() == PanelAnchor::Side
		{
			panel.touch(self.clock.elapsed());
			let event = panel.key(key);
			if event != PanelEvent::Ignored {
				return self.apply_panel_event(event);
			}
		}
		if let Some(routed) = self.gesture(key)? {
			return Ok(routed);
		}
		let routed = self.composer_key(key)?;
		Ok(if had_notice && routed == Routed::Ignored {
			Routed::Repaint
		} else {
			routed
		})
	}

	/// Routes a pointer report to the focused overlay in that overlay's own
	/// frame coordinates.
	fn route_mouse(&mut self, report: MouseReport) -> Result<Routed, HostError> {
		if self.overlays.approval().is_some() {
			return Ok(Routed::Repaint);
		}
		let Some(report) = self.localize_mouse(report) else {
			return Ok(Routed::Ignored);
		};
		match self.overlays.active_mut() {
			Some(Overlay::Models(picker)) => {
				let event = picker.mouse(report);
				self.apply_picker_event(event)
			},
			Some(Overlay::History(picker)) => {
				let event = picker.mouse(report);
				self.apply_picker_event(event)
			},
			Some(Overlay::Panel(panel)) => {
				panel.touch(self.clock.elapsed());
				let event = panel.mouse(report);
				self.apply_panel_event(event)
			},
			Some(Overlay::Approval(_)) => Ok(Routed::Repaint),
			None => Ok(Routed::Ignored),
		}
	}

	/// Translates a terminal-viewport pointer report into the topmost
	/// overlay's frame cells, resolving its band exactly as [`Host::present`]
	/// composites it (bottom pickers over the composer slot, centered
	/// dialogs, side panels above the live composer). `None` when no overlay
	/// is open or the gesture fell outside the band; a drag or release stays
	/// captured so a press inside always sees its release.
	fn localize_mouse(&mut self, report: MouseReport) -> Option<MouseReport> {
		let (band, width) = self.overlay_band(self.viewport())?;
		let captured = matches!(report.kind, omp_tui::Mouse::Drag | omp_tui::Mouse::Release);
		let inside = band.rows > 0
			&& report.col >= band.x
			&& report.col < band.x.saturating_add(width)
			&& report.row >= band.y
			&& report.row < band.y.saturating_add(band.rows);
		if !inside && !captured {
			return None;
		}
		Some(MouseReport {
			col: report.col.saturating_sub(band.x),
			row: report
				.row
				.saturating_sub(band.y)
				.saturating_add(band.src_top),
			..report
		})
	}

	/// Routes pasted text to the focused picker or panel before the composer.
	fn route_paste(&mut self, text: &str) -> Result<Routed, HostError> {
		self.route_paste_with_options(text, PasteOptions::default())
	}

	fn route_paste_with_options(
		&mut self,
		text: &str,
		options: PasteOptions,
	) -> Result<Routed, HostError> {
		if self.overlays.approval().is_some() {
			return Ok(Routed::Repaint);
		}
		match self.overlays.active_mut() {
			Some(Overlay::Models(picker)) => {
				let event = picker.paste(text);
				return self.apply_picker_event(event);
			},
			Some(Overlay::History(picker)) => {
				let event = picker.paste(text);
				return self.apply_picker_event(event);
			},
			Some(Overlay::Panel(panel)) => {
				panel.touch(self.clock.elapsed());
				let event = panel.paste(text);
				if event != PanelEvent::Ignored {
					return self.apply_panel_event(event);
				}
			},
			_ => {},
		}
		Ok(self.paste_into_composer_with_options(text, options))
	}

	/// Lands pasted text in the composer, or holds it behind the large-paste
	/// menu when it reaches `cl_paste_large_menu_threshold` lines (
	/// `handleLargePaste`).
	fn paste_into_composer(&mut self, text: &str) -> Routed {
		self.paste_into_composer_with_options(text, PasteOptions::default())
	}

	fn paste_into_composer_with_options(&mut self, text: &str, options: PasteOptions) -> Routed {
		if let PasteOutcome::Menu { lines } = self.composer.paste_with_options(text, options) {
			let _ = self.commands.send(HostCommand::Overlay {
				id:   Str::new_static(crate::overlays::paste_menu::ID),
				open: true,
			});
			self.overlays.show(Overlay::Panel(Box::new(PasteMenu::new(
				Str::new(text),
				lines,
				&self.ui,
			))));
		}
		self.sync_pending_input();
		Routed::Repaint
	}

	/// Applies a large-paste menu choice ( `presentLargePasteMenu`): a
	/// failed file save falls back to the chip so the paste is never lost.
	fn land_paste(&mut self, text: &Str, choice: PasteChoice) -> Routed {
		let routed = match choice {
			PasteChoice::Wrapped => {
				self
					.composer
					.paste_chip(text, Some(&wrap_in_attachment_block(text)));
				Routed::Repaint
			},
			PasteChoice::Inline => {
				self.composer.paste_chip(text, None);
				Routed::Repaint
			},
			PasteChoice::LocalFile => match save_paste_file(self.services.as_ref(), text) {
				Ok(url) => {
					self.composer.insert_text(&url);
					self.composer.insert_text(" ");
					self.notice(format!("Saved paste to {url}"))
				},
				Err(error) => {
					self.composer.paste_chip(text, None);
					self.notice(format!(
						"Failed to save paste to a file — attached as a text chip instead ({error})"
					))
				},
			},
		};
		self.sync_pending_input();
		routed
	}

	/// Composer-bound gestures that run before the editor sees the key:
	/// the space-hold push-to-talk cadence and the double-Left subagent
	/// unfocus. `None` hands the key on.
	fn gesture(&mut self, key: Key) -> Result<Option<Routed>, HostError> {
		let now = self.clock.elapsed();
		let enabled = CL_STT_HOLD.get(&self.con) && !self.composer.popup_open();
		match self.space_hold.observe(key, now, enabled) {
			SpaceHoldEvent::Pass => {},
			SpaceHoldEvent::Swallow => return Ok(Some(Routed::Ignored)),
			SpaceHoldEvent::Begin { track_back } => {
				self.composer.delete_before_caret(track_back);
				return Ok(Some(self.set_recording(true)));
			},
			SpaceHoldEvent::EndThenPass => {
				self.set_recording(false);
			},
		}
		if key == Key::Left
			&& self.focused_agent.is_some()
			&& self.composer.text().is_empty()
			&& self.left_taps.tap(Instant::now())
		{
			return Ok(Some(self.act(HostAction::FocusAgent(None))?));
		}
		Ok(None)
	}

	/// Starts or stops push-to-talk; the app owns the microphone.
	fn set_recording(&mut self, active: bool) -> Routed {
		if self.stt_recording == active {
			return Routed::Ignored;
		}
		self.stt_recording = active;
		if !active {
			self.space_hold.end();
		}
		let _ = self.commands.send(HostCommand::PushToTalk { active });
		self.notice(if active {
			"Listening… release space to transcribe"
		} else {
			"Transcribing…"
		})
	}

	fn stt_event(&mut self, event: SttUiEvent) -> Result<Routed, HostError> {
		Ok(match event {
			SttUiEvent::SetupProgress { model, downloaded_bytes, total_bytes } => {
				let percent = if total_bytes == 0 {
					0
				} else {
					(downloaded_bytes.saturating_mul(100) / total_bytes).min(100)
				};
				self.notice(format!("Preparing speech model {model}… {percent}%"))
			},
			SttUiEvent::Recording => {
				self.stt_recording = true;
				self.notice("Listening… release space to transcribe")
			},
			SttUiEvent::Transcribing => {
				self.stt_recording = false;
				self.space_hold.end();
				self.notice("Transcribing…")
			},
			SttUiEvent::Partial(text) => {
				self.composer.set_volatile_text(text.as_str());
				Routed::Repaint
			},
			SttUiEvent::Segment(text) => {
				self.composer.commit_volatile_text(text.as_str());
				Routed::Repaint
			},
			SttUiEvent::Finished { had_speech, trim_trailing, submit } => {
				self.composer.clear_volatile_text();
				if trim_trailing > 0 {
					self.composer.delete_before_caret(trim_trailing);
				}
				self.stt_recording = false;
				self.space_hold.end();
				if had_speech {
					self.overlays.clear_notice();
				} else {
					return Ok(self.notice("No speech detected"));
				}
				if submit {
					let action = self.composer.preview_submission();
					return self.preview_composer_action(action);
				}
				Routed::Repaint
			},
			SttUiEvent::Cancelled => {
				self.composer.clear_volatile_text();
				self.stt_recording = false;
				self.space_hold.end();
				self.overlays.clear_notice();
				Routed::Repaint
			},
			SttUiEvent::Failed { kind: _, message } => {
				self.composer.clear_volatile_text();
				self.stt_recording = false;
				self.space_hold.end();
				self.notice(format!("Speech recognition failed: {message}"))
			},
		})
	}

	fn composer_key(&mut self, key: Key) -> Result<Routed, HostError> {
		let action = self.composer.preview_key(key);
		let routed = self.preview_composer_action(action)?;
		self.sync_pending_input();
		Ok(routed)
	}

	fn sync_pending_input(&self) {
		let pending = self.composer.has_pending_submission();
		if let Some(gate) = self.con.user::<PendingInputGate>() {
			gate.set_pending(pending);
		} else {
			let gate = PendingInputGate::default();
			gate.set_pending(pending);
			self.con.insert_user(gate);
		}
	}

	/// Commits an accepted editor submission to local recall and the
	/// controller-owned durable prompt index in one host transition.
	fn commit_submission(&mut self) -> bool {
		let history = Str::new(self.composer.text());
		let committed = self.composer.commit_submission();
		if committed {
			let _ = self.services.history_add(history.as_str());
		}
		committed
	}

	fn composer_mouse(&mut self, report: MouseReport) -> Result<Routed, HostError> {
		let action = self.composer.mouse(report);
		let routed = self.preview_composer_action(action)?;
		self.sync_pending_input();
		Ok(routed)
	}

	/// Validates a submission while its exact editor buffer and attachment
	/// atoms remain staged, then commits only an accepted action.
	fn preview_composer_action(&mut self, action: ComposerAction) -> Result<Routed, HostError> {
		match action {
			ComposerAction::Submit(text) => {
				if text.trim().is_empty() {
					return Ok(Routed::Ignored);
				}
				if let Some(local) = crate::composer::parse_local_input(&text) {
					if self.focused_agent.is_some() {
						return Ok(
							self.notice("Commands run in the main session — press ←← to return first")
						);
					}
					if self.collab_guest {
						// Host-only local input from a guest is consumed rather
						// than leaving an executable command in its editor.
						let _ = self.commit_submission();
						return Ok(self.notice("Local execution is host-only during a collab session"));
					}
					if omp_agent::pause_state(&self.replica).active {
						return Ok(self.notice("Paused: resume before running local commands"));
					}
					if local_run_active(&self.replica, local.mode) {
						let reason = match local.mode {
							PrefixMode::Bash => {
								"A bash command is already running. Press Esc to cancel it first."
							},
							PrefixMode::Eval => {
								"A Python execution is already running. Press Esc to cancel it first."
							},
						};
						return Ok(self.notice(reason));
					}
				}
				let _ = self.commit_submission();
				Ok(self.submit(text))
			},
			ComposerAction::SubmitWithMedia { text, media } => {
				if text.trim().is_empty() {
					return Ok(Routed::Ignored);
				}
				if crate::composer::parse_local_input(&text).is_some() {
					return Ok(self.notice("Local commands do not accept media attachments"));
				}
				let attachments = match read_attachments(&media) {
					Ok(attachments) => attachments,
					Err(error) => return Ok(self.notice(error.to_string())),
				};
				let _ = self.commit_submission();
				Ok(self.submit_with_attachments(text, attachments))
			},
			ComposerAction::Command { statement, media } => {
				if !media.is_empty() {
					let attachments = match read_attachments(&media) {
						Ok(attachments) => attachments,
						Err(error) => return Ok(self.notice(error.to_string())),
					};
					let Some(prompt) = goal_media_prompt(statement.as_str()) else {
						return Ok(self.notice("Slash commands do not accept media attachments"));
					};
					if self.plan_engaged()
						|| crate::commands::director_active(&self.replica, crate::commands::VIBE)
					{
						// Let the ordinary command path report the exact
						// conflicting mode while the draft and chips remain staged.
						return self.run_console(statement.as_str());
					}
					let _ = self.commit_submission();
					let routed = self.run_console(statement.as_str())?;
					return Ok(routed.max(self.submit_with_attachments(prompt, attachments)));
				}
				let _ = self.commit_submission();
				self.run_console(statement.as_str())
			},
			ComposerAction::Queue { text, media } => {
				if text.trim().is_empty() {
					return Ok(Routed::Ignored);
				}
				let attachments = match read_attachments(&media) {
					Ok(attachments) => attachments,
					Err(error) => return Ok(self.notice(error.to_string())),
				};
				let _ = self.commit_submission();
				Ok(self.queue_with_attachments(text, attachments))
			},
			ComposerAction::Copy(text) => {
				self.clipboard = Some(text);
				Ok(Routed::Repaint)
			},
			ComposerAction::Changed => Ok(Routed::Repaint),
			ComposerAction::Ignored => Ok(Routed::Ignored),
		}
	}

	/// `onEscape`: autocomplete first, then the eleven global rungs.
	/// Every applicable rung consumes the key.
	fn escape(&mut self) -> Result<Routed, HostError> {
		// 0. The editor popup owns the first Esc; it must never leak through
		// into cancellation.
		if self.composer.dismiss_completion_on_escape() == ComposerEscape::DismissedCompletion {
			return Ok(Routed::Repaint);
		}
		// 1. `/mcp test` (and any one-shot cancel hook): fire all, forget all.
		let cancels = self
			.escape_hooks
			.iter()
			.filter(|hook| hook.rung == EscapeRung::Cancel)
			.cloned()
			.collect::<Vec<_>>();
		if !cancels.is_empty() {
			self
				.escape_hooks
				.retain(|hook| hook.rung != EscapeRung::Cancel);
			for hook in cancels {
				let _ = hook.fire();
			}
			return Ok(Routed::Repaint);
		}
		// 2. A side panel gets its specific Esc transition before the host
		// falls back to closing it.
		if self.overlays.side_panel() {
			let event = match self.overlays.active_mut() {
				Some(Overlay::Panel(panel)) => {
					panel.touch(self.clock.elapsed());
					match panel.key(Key::Esc) {
						PanelEvent::Ignored => PanelEvent::Close,
						event => event,
					}
				},
				_ => PanelEvent::Close,
			};
			return self.apply_panel_event(event);
		}
		// 3. Maintenance (compaction, handoff, retry backoff) runs inside the
		// main kernel turn. A focused child is never interrupted here.
		if self.focused_agent.is_none() && self.maintenance_active() {
			return Ok(self.interrupt_turn());
		}
		// 4. Silence actual speech before touching the turn.
		let silenced = self
			.escape_hooks
			.iter()
			.filter(|hook| hook.rung == EscapeRung::Silence)
			.any(EscapeHook::fire);
		if silenced {
			self.composer.reset_escape_sequence();
			return Ok(Routed::Repaint);
		}
		// 5. Loop mode: abort a streaming iteration; otherwise pause and
		// cancel any submission racing the pause boundary.
		if self.director_engaged(LOOP_DIRECTOR) {
			if self.turn_active {
				return Ok(self.interrupt_turn());
			}
			let routed = self.run_console("pause")?;
			let _ = self.commands.send(HostCommand::Interrupt);
			return Ok(routed.max(Routed::Repaint));
		}
		// 6. Focused child view: clear its local draft or return to main.
		// Neither path interrupts the child's turn.
		if self.focused_agent.is_some() {
			return match self.composer.escape_focused() {
				ComposerEscape::ClearedFocusedDraft => Ok(Routed::Repaint),
				ComposerEscape::UnfocusSession => self.act(HostAction::FocusAgent(None)),
				_ => Ok(Routed::Ignored),
			};
		}
		// 7. A collaboration guest always consumes Esc. Only a remote
		// streaming/loading edge emits an abort.
		if self.collab_guest {
			if self.turn_active {
				let _ = self.commands.send(HostCommand::Interrupt);
			}
			return Ok(Routed::Repaint);
		}
		// 8. A running local command uses the typed interrupt path. An idle
		// prefix draft is cleared only when it matches  real prefix
		// grammar (`$HOME` and `${x}` are prose).
		if active_local_run(&self.replica).is_some() {
			let _ = self.commands.send(HostCommand::Interrupt);
			return Ok(Routed::Ignored);
		}
		if self.composer.clear_prefix_on_escape() == ComposerEscape::ClearedPrefix {
			return Ok(Routed::Repaint);
		}
		// 9. Restore queued/steering input before aborting an active or
		// controller-pending turn.
		if self.turn_active {
			let restored = self.restore_queued(true);
			let routed = self.interrupt_turn();
			return Ok(routed.max(restored));
		}
		// 10/11. Preserve a draft, or complete the configured empty-composer
		// double-Esc gesture on the composer's own monotonic state.
		let target = match CL_DOUBLE_ESCAPE.get(&self.con).as_str() {
			"tree" => Some(DoubleEscapeTarget::Tree),
			"none" | "off" => None,
			_ => Some(DoubleEscapeTarget::Rewind),
		};
		match self.composer.escape_draft(self.clock.elapsed(), target) {
			ComposerEscape::Open(DoubleEscapeTarget::Tree) => {
				Ok(self.run_console("tree")?.max(Routed::Repaint))
			},
			ComposerEscape::Open(DoubleEscapeTarget::Rewind) => {
				Ok(self.run_console("branch")?.max(Routed::Repaint))
			},
			ComposerEscape::PreservedDraft | ComposerEscape::Armed | ComposerEscape::NotHandled => {
				Ok(Routed::Ignored)
			},
			_ => Ok(Routed::Repaint),
		}
	}

	/// Whether main-session maintenance (compaction, handoff, a scheduled
	/// provider retry) is in flight: the compaction Director is active while
	/// the kernel summarizes, or the transport is counting down a retry.
	fn maintenance_active(&self) -> bool {
		self.retrying.is_some() || (self.turn_active && self.director_engaged("compaction"))
	}

	fn interrupt_turn(&mut self) -> Routed {
		self.silence_speech();
		let _ = self.commands.send(HostCommand::Interrupt);
		Routed::Ignored
	}

	/// `restoreQueuedMessagesToEditor`: pulls queued prompts (and, while
	/// a turn runs, undelivered steering) back into the composer ahead of
	/// the current draft. `abort` is the Esc path; a plain dequeue keeps the
	/// stream running.
	fn restore_queued(&mut self, abort: bool) -> Routed {
		let mut texts = Vec::new();
		if self.turn_active {
			let (tx, rx) = flume::bounded(1);
			if self.up.send(Up::Unqueue(tx)).is_ok()
				&& let Ok(steering) = rx.recv_timeout(Duration::from_millis(200))
			{
				texts.extend(steering);
			}
		}
		let queued = self.queued_prompts();
		if !queued.is_empty() {
			let _ = self.commands.send(HostCommand::Dequeue {
				prompts: queued.iter().map(|(id, _)| id.clone()).collect(),
			});
			texts.extend(queued.into_iter().map(|(_, text)| text));
		}
		if texts.is_empty() {
			return if abort {
				Routed::Ignored
			} else {
				self.notice("No queued messages to restore")
			};
		}
		let restored = texts.len();
		let current = self.composer.text();
		let mut combined = String::new();
		for text in texts
			.iter()
			.chain(std::iter::once(&Str::new(current.as_str())))
		{
			if text.trim().is_empty() {
				continue;
			}
			if !combined.is_empty() {
				combined.push_str("\n\n");
			}
			combined.push_str(text);
		}
		self.composer.set_text(&combined);
		if abort {
			Routed::Repaint
		} else {
			self.notice(format!(
				"Restored {restored} queued message{} to editor",
				if restored > 1 { "s" } else { "" }
			))
		}
	}

	/// Executes the script currently bound to one physical key edge.
	///
	/// Default scripts list contextual fallbacks from narrowest to broadest
	/// (panel, editor, app). Once one posted action consumes the edge, later
	/// fallbacks from that same script are discarded.
	fn run_bound_key(&mut self, chord: &str, pressed: bool) -> Result<Routed, HostError> {
		let before = self.projection_inputs();
		let failure = self.con.key(chord, pressed).err();
		let mut routed = if before == self.projection_inputs() {
			if pressed {
				Routed::Repaint
			} else {
				Routed::Ignored
			}
		} else {
			Routed::RebuildProjection
		};
		let actions = self.mailbox.drain().collect::<Vec<_>>();
		for action in actions {
			let effect = self.act(action)?;
			routed = routed.max(effect);
			if effect != Routed::Ignored {
				break;
			}
		}
		if let Some(error) = failure {
			self.overlays.notify(error.to_string());
			routed = routed.max(Routed::Repaint);
		}
		if self.sync_palette_settings() {
			routed = routed.max(Routed::RebuildProjection);
		}
		if self.refresh_wall_clock(self.clock.elapsed()) {
			routed = routed.max(Routed::Repaint);
		}
		Ok(routed)
	}

	/// Executes one console line and applies every action it posted.
	///
	/// Console failures become a notice rather than ending the host: a
	/// mistyped `bind` in `config.cfg` must not kill the chat.
	pub(crate) fn run_console(&mut self, command: &str) -> Result<Routed, HostError> {
		let before = self.projection_inputs();
		let failure = self.con.exec(command, Source::Console).err();
		let mut routed = if before == self.projection_inputs() {
			Routed::Repaint
		} else {
			Routed::RebuildProjection
		};
		// An action may post more (a command-owned call replying through the
		// console sink), so drain until the line's mailbox traffic settles.
		loop {
			let actions = self.mailbox.drain().collect::<Vec<_>>();
			if actions.is_empty() {
				break;
			}
			for action in actions {
				routed = routed.max(self.act(action)?);
			}
		}
		if let Some(error) = failure {
			self.overlays.notify(error.to_string());
			routed = routed.max(Routed::Repaint);
		}
		if self.sync_palette_settings() {
			routed = routed.max(Routed::RebuildProjection);
		}
		if self.refresh_wall_clock(self.clock.elapsed()) {
			routed = routed.max(Routed::Repaint);
		}
		Ok(routed)
	}

	/// Applies a finished clipboard write without guessing from an absent
	/// result. The final backend outcome replaces the optimistic key-action
	/// notice.
	fn deliver_clipboard_write(&mut self, outcome: ClipboardWriteOutcome) -> Routed {
		self.notice(match outcome {
			ClipboardWriteOutcome::Success => "Copied to clipboard",
			ClipboardWriteOutcome::PermissionDenied => "Clipboard write access was denied",
			ClipboardWriteOutcome::Unavailable => "Clipboard is unavailable",
			ClipboardWriteOutcome::WriteFailure => "Failed to write clipboard",
		})
	}

	/// Applies a finished clipboard read: non-payload outcomes only surface a
	/// notice; an image persists to a temp file and stages as a chip through
	/// the drop path; text pastes sanitized or verbatim (`raw`, the
	/// Ctrl+Shift+V contract).
	fn deliver_clipboard(
		&mut self,
		outcome: ClipboardReadOutcome,
		raw: bool,
	) -> Result<Routed, HostError> {
		Ok(match outcome {
			ClipboardReadOutcome::Empty if raw => self.notice("No text in clipboard to paste raw"),
			ClipboardReadOutcome::Empty => self.notice("Clipboard is empty"),
			ClipboardReadOutcome::PermissionDenied => self.notice("Clipboard access was denied"),
			ClipboardReadOutcome::UnsupportedFormat => {
				self.notice("Clipboard format is not supported")
			},
			ClipboardReadOutcome::ReadFailure if raw => {
				self.notice("Failed to paste raw text from clipboard")
			},
			ClipboardReadOutcome::ReadFailure => self.notice("Failed to read clipboard"),
			ClipboardReadOutcome::Payload(Clipboard::Text(text))
				if self.overlays.active().is_some() =>
			{
				self.route_paste(text.as_str())?
			},
			ClipboardReadOutcome::Payload(Clipboard::Text(text)) => {
				if raw {
					self.composer.paste_raw(&text);
					Routed::Repaint
				} else {
					self.paste_into_composer(&text)
				}
			},
			ClipboardReadOutcome::Payload(Clipboard::Image(_) | Clipboard::Paths(_))
				if self.overlays.active().is_some() =>
			{
				self.notice("Close the current panel before pasting images or files")
			},
			ClipboardReadOutcome::Payload(Clipboard::Image(image)) => match image.persist() {
				Ok(path) => {
					self.composer.paste(&path.to_string_lossy());
					Routed::Repaint
				},
				Err(error) => self.notice(format!("Could not stage the pasted image: {error}")),
			},
			ClipboardReadOutcome::Payload(Clipboard::Paths(paths)) => {
				let mut joined = String::new();
				for path in &paths {
					if !joined.is_empty() {
						joined.push(' ');
					}
					joined.push('"');
					joined.push_str(path);
					joined.push('"');
				}
				self.composer.paste(&joined);
				Routed::Repaint
			},
		})
	}

	/// Drains actions posted outside a console line (app-side results such
	/// as a speech transcript).
	fn drain_mailbox(&mut self) -> Result<Routed, HostError> {
		let mut routed = Routed::Ignored;
		let actions = self.mailbox.drain().collect::<Vec<_>>();
		for action in actions {
			routed = routed.max(self.act(action)?);
		}
		Ok(routed)
	}

	/// Convars whose change forces a transcript rebuild.
	fn projection_inputs(&self) -> (bool, bool, bool, bool, bool) {
		(
			self.show_thinking(),
			crate::actions::CL_SHOWTOOLS.get(&self.con),
			crate::actions::CL_TOOLS_EXPANDED.get(&self.con),
			crate::transcript::CL_SMOOTH_STREAMING.get(&self.con),
			crate::transcript::CL_THINKING_PROSE_ONLY.get(&self.con),
		)
	}

	pub(crate) fn notice(&mut self, text: impl Into<Str>) -> Routed {
		self.overlays.notify(text);
		Routed::Repaint
	}

	fn finish_external_editor(
		&mut self,
		result: Result<Option<String>, crate::editor::EditorError>,
	) {
		match result {
			Ok(Some(edited)) => self.composer.replace_edited(&edited),
			Ok(None) => {},
			Err(error) => {
				self.notice(error.to_string());
			},
		}
		self.composer.restore_focus();
		self.sync_pending_input();
	}

	fn set_collab_status(&mut self, status: Option<CollabStatus>) -> Routed {
		let guest = status
			.as_ref()
			.is_some_and(|status| status.role == CollabStatusRole::Guest);
		let changed = self.collab_status != status;
		self.collab_guest = guest;
		self.collab_status = status;
		if changed && self.sync_status() {
			Routed::Repaint
		} else {
			Routed::Ignored
		}
	}

	/// A `!` / `$` line that cannot run right now goes back into the
	/// composer verbatim ( `editor.setText(text)`) with the reason shown.
	fn refuse_local(&mut self, draft: &str, reason: impl Into<Str>) -> Routed {
		self.composer.set_text(draft);
		self.sync_pending_input();
		self.notice(reason)
	}

	/// Sends the draft as a submission. The controller — which knows whether
	/// a turn is really running — starts a turn or steers the active one;
	/// the replica's view may lag the kernel, so the host never decides.
	pub(crate) fn submit(&mut self, text: Str) -> Routed {
		if text.trim().is_empty() {
			return Routed::Ignored;
		}
		// `handleSubmit`: `!cmd` / `$ code` run locally through the tool
		// and never reach the model. Local execution belongs to the main
		// session: while a subagent is focused the draft stays (
		// `#submitToFocusedSession`), a collaboration guest is refused
		// outright, and the same runner identity already in flight hands the
		// draft back ( keeps independent `isBashRunning` / `isEvalRunning`
		// gates).
		if let Some(local) = crate::composer::parse_local_input(&text) {
			if self.focused_agent.is_some() {
				return self
					.refuse_local(&text, "Commands run in the main session — press ←← to return first");
			}
			if self.collab_guest {
				return self.notice("Local execution is host-only during a collab session");
			}
			if local_run_active(&self.replica, local.mode) {
				return self.refuse_local(&text, match local.mode {
					PrefixMode::Bash => {
						"A bash command is already running. Press Esc to cancel it first."
					},
					PrefixMode::Eval => {
						"A Python execution is already running. Press Esc to cancel it first."
					},
				});
			}
			self.set_turn_active(true);
			self.dismissed_error = pinned_error(&self.replica).map(|(handle, _)| handle);
			let _ = self
				.commands
				.send(HostCommand::RunLocal { input: local, draft: text });
			return Routed::Repaint;
		}
		if !self.turn_active {
			self.set_turn_active(true);
			self.last_prompt = Some(text.clone());
		}
		// `clearPinnedError` + `vocalizer.clear()` on every send.
		self.dismissed_error = pinned_error(&self.replica).map(|(handle, _)| handle);
		self.silence_speech();
		let _ = self.commands.send(HostCommand::Submit(text));
		Routed::Repaint
	}

	pub(crate) fn submit_skill_prompt(&mut self, prompt: omp_journal::data::SkillPrompt) -> Routed {
		if !self.turn_active {
			self.set_turn_active(true);
			self.last_prompt = Some(prompt.prompt_body.clone());
		}
		self.dismissed_error = pinned_error(&self.replica).map(|(handle, _)| handle);
		self.silence_speech();
		let _ = self.commands.send(HostCommand::SkillPrompt(prompt));
		Routed::Repaint
	}

	fn submit_with_attachments(
		&mut self,
		text: Str,
		attachments: Vec<omp_session::AttachmentInput>,
	) -> Routed {
		if !self.turn_active {
			self.set_turn_active(true);
			self.last_prompt = Some(text.clone());
		}
		self.dismissed_error = pinned_error(&self.replica).map(|(handle, _)| handle);
		self.silence_speech();
		let _ = self
			.commands
			.send(HostCommand::SubmitWithAttachments { text, attachments });
		Routed::Repaint
	}

	fn queue_with_attachments(
		&mut self,
		text: Str,
		attachments: Vec<omp_session::AttachmentInput>,
	) -> Routed {
		if !self.turn_active && self.queued_prompts().is_empty() {
			let routed = if attachments.is_empty() {
				self.submit(text)
			} else {
				self.submit_with_attachments(text, attachments)
			};
			return routed.max(self.notice("Sent queued message"));
		}
		self.last_prompt = Some(text.clone());
		let _ = self
			.commands
			.send(HostCommand::Queue { prompt: text, attachments });
		self.notice("Queued message for when the agent yields")
	}

	/// Applies one posted host action.
	pub(crate) fn act(&mut self, action: HostAction) -> Result<Routed, HostError> {
		Ok(match action {
			HostAction::Interrupt => {
				if self.overlays.approval().is_some() {
					return self.route_approval_key(Key::Esc);
				}
				// A modal overlay owns Escape first: an ask dialog answers
				// `None` (unblocking the tool), an editing workbench cancels
				// its editor, a picker clears its query. Only an overlay that
				// ignores the key is dismissed.
				if self.overlays.modal() {
					return self.route_unbound_key(Key::Esc);
				}
				return self.escape();
			},
			HostAction::Clear => {
				if self.overlays.modal() {
					return Ok(Routed::Ignored);
				}
				let now = Instant::now();
				let repeated = self
					.last_clear
					.is_some_and(|prior| now.duration_since(prior) <= Duration::from_millis(500));
				self.last_clear = Some(now);
				match ctrl_c_action(repeated) {
					CtrlCAction::Quit => Routed::Quit,
					CtrlCAction::Clear if self.stt_recording => {
						self.set_recording(false);
						Routed::Repaint
					},
					CtrlCAction::Clear => {
						self.composer.clear();
						Routed::Repaint
					},
				}
			},
			HostAction::Exit => Routed::Quit,
			HostAction::Suspend => {
				#[cfg(unix)]
				{
					Routed::Suspend
				}
				#[cfg(not(unix))]
				{
					self.notice("Suspend (Ctrl+Z) is not supported on this platform")
				}
			},
			HostAction::DisplayReset => Routed::DisplayReset,
			HostAction::UpdateAvailable(update) => {
				if self.transcript.update_available(update) {
					Routed::RebuildProjection
				} else {
					Routed::Ignored
				}
			},
			HostAction::ExtensionStatus(event) => {
				if self.extension_status.apply(event) && self.sync_status() {
					Routed::Repaint
				} else {
					Routed::Ignored
				}
			},
			HostAction::ExtensionTitle(title) => {
				self.title.set_extension_title(title.as_str());
				Routed::Ignored
			},
			HostAction::ThinkingCycle => self.cycle_thinking(),
			HostAction::ModelCycle { backward } => self.cycle_model(backward),
			HostAction::ModelSelect { session_only } => {
				if self.models.is_empty() {
					return Ok(self.notice("No models are available to switch to"));
				}
				let current = self.current_model_index();
				let live = self.live_model();
				let quick_roles = self
					.cycle
					.iter()
					.filter_map(|(role, model, thinking)| {
						self
							.models
							.iter()
							.position(|row| row.key == *model)
							.map(|model| QuickRoleRow {
								role: role.clone(),
								model,
								thinking: thinking.clone(),
							})
					})
					.collect::<Vec<_>>();
				let current_role = quick_roles
					.iter()
					.position(|role| self.models[role.model].key == live);
				let picker = ModelPicker::open(
					self.models.clone(),
					current,
					current,
					quick_roles,
					current_role,
					session_only,
					self.composer.frame().size().width,
					&self.ui,
				);
				self.overlays.show(Overlay::Models(picker));
				let _ = self
					.commands
					.send(HostCommand::Overlay { id: Str::new_static("models"), open: true });
				Routed::Repaint
			},
			HostAction::ModelSet(selector) => {
				// `/model <id>`: exact key (`provider/model`), bare model id,
				// or display name; anything else is "Unknown model".
				let wanted = selector.as_str().trim();
				let found = self.models.iter().find(|row| {
					row.key == wanted
						|| row.key.rsplit_once('/').is_some_and(|(_, id)| id == wanted)
						|| row.name.as_str().eq_ignore_ascii_case(wanted)
				});
				match found.cloned() {
					Some(row) => self.select_model(&row, false, false),
					None => self.notice(format!(
						"Unknown model: {wanted}. Run /model without arguments to pick one."
					)),
				}
			},
			HostAction::FollowUp => {
				// `handleFollowUp`: same classification as Enter (`/`
				// commands still run, `!`/`$` still run locally), but a plain
				// prompt during a turn queues behind the stream instead of
				// steering it. Previewing first preserves the exact draft and
				// media atoms when attachment materialization is refused.
				match self.composer.preview_submission() {
					ComposerAction::Submit(text)
						if self.turn_active && crate::composer::parse_local_input(&text).is_none() =>
					{
						let _ = self.commit_submission();
						self.queue_with_attachments(text, Vec::new())
					},
					// Media chips queue with their text instead of steering
					// the stream ( `prompt(text, { streamingBehavior:
					// "followUp", images })`).
					ComposerAction::SubmitWithMedia { text, media }
						if self.turn_active && crate::composer::parse_local_input(&text).is_none() =>
					{
						match read_attachments(&media) {
							Ok(attachments) => {
								let _ = self.commit_submission();
								self.queue_with_attachments(text, attachments)
							},
							Err(error) => self.notice(error.to_string()),
						}
					},
					action => self.preview_composer_action(action)?,
				}
			},
			HostAction::Retry => {
				if self.turn_active {
					return Ok(self.notice("A turn is already running"));
				}
				// The hint row and the action share one predicate: a turn that
				// died on a tool call replays that batch through the controller.
				if aborted_tool_tail(&self.replica) {
					let _ = self.commands.send(HostCommand::Retry);
					return Ok(self.notice("Retrying the interrupted tool calls"));
				}
				match (self.last_turn_failed(), self.last_prompt.clone()) {
					(true, Some(text)) => self.submit(text),
					(true, None) => self.notice("Nothing to retry in this session"),
					(false, _) => self.notice("Last turn did not fail; nothing to retry"),
				}
			},
			HostAction::ToolsExpand => {
				let expanded = crate::actions::CL_TOOLS_EXPANDED.get(&self.con);
				crate::actions::CL_TOOLS_EXPANDED.set(&self.con, !expanded)?;
				Routed::RebuildProjection
			},
			HostAction::PlanToggle => {
				let engaged = self.plan_engaged();
				let _ = self
					.commands
					.send(HostCommand::PlanMode { engage: !engaged });
				self.notice(if engaged {
					"Plan mode off"
				} else {
					"Plan mode on: the next turn must write a plan and ask before acting"
				})
			},
			HostAction::HistorySearch => {
				let mut entries = self.services.history_recent(100).unwrap_or_default();
				for (index, prompt) in crate::overlays::prompt_history(&self.replica)
					.into_iter()
					.enumerate()
				{
					if entries.len() == 100 {
						break;
					}
					if entries.iter().any(|entry| entry.prompt == prompt) {
						continue;
					}
					entries.push(crate::history::HistoryEntry {
						id: i64::try_from(index)
							.ok()
							.and_then(|index| index.checked_add(1))
							.map_or(i64::MIN, |index| -index),
						prompt,
						created_at: 0,
						cwd: None,
						session_id: None,
					});
				}
				if entries.is_empty() {
					return Ok(self.notice("No prompt history yet"));
				}
				let picker = HistoryPicker::open(
					entries,
					Some(Arc::clone(&self.services)),
					self.composer.frame().size().width,
					&self.ui,
				);
				self.overlays.show(Overlay::History(picker));
				Routed::Repaint
			},
			HostAction::ExternalEditor => match crate::editor::configured_editor_command() {
				Ok(command) => {
					self.pending_editor = Some(command);
					Routed::ExternalEditor
				},
				Err(error) => self.notice(error.to_string()),
			},
			HostAction::Dequeue => self.restore_queued(false),
			HostAction::PasteImage => {
				self.clipboard_read = Some(ClipboardRead::Smart);
				Routed::Ignored
			},
			HostAction::PasteRaw => {
				self.clipboard_read = Some(ClipboardRead::Text);
				Routed::Ignored
			},
			HostAction::CopyLine => {
				let line = self.composer.current_line();
				if line.is_empty() {
					return Ok(self.notice("Nothing to copy on this line"));
				}
				self.clipboard = Some(line);
				self.notice("Copied line")
			},
			HostAction::CopyPrompt => {
				let text = self.composer.text();
				if text.is_empty() {
					return Ok(self.notice("Nothing to copy"));
				}
				self.clipboard = Some(Str::new(text));
				self.notice("Copied prompt")
			},
			HostAction::FocusAgent(agent) => {
				let changed = self.focused_agent != agent;
				let _ = self.commands.send(HostCommand::Overlay {
					id:   Str::new(format!(
						"agent:{}",
						agent
							.as_deref()
							.or(self.focused_agent.as_deref())
							.unwrap_or_default()
					)),
					open: agent.is_some(),
				});
				self.focused_agent = agent;
				self.left_taps = LeftTaps::default();
				self.composer.reset_escape_sequence();
				if !changed {
					return Ok(Routed::Ignored);
				}
				match self.focused_agent.as_deref() {
					Some(id) => self.notice(format!("Viewing subagent {id} · Esc returns to main")),
					None => self.notice("Back to main session"),
				}
			},
			HostAction::CollabGuest(guest) => {
				self.collab_guest = guest;
				Routed::Ignored
			},
			HostAction::CollabStatus(status) => self.set_collab_status(status),
			HostAction::SttToggle => {
				let active = !self.stt_recording;
				self.set_recording(active)
			},
			HostAction::PushToTalk { active } => self.set_recording(active),
			HostAction::LiveToggle => {
				if self.stt_recording {
					self.set_recording(false);
				}
				if self.live_active {
					self.apply_panel_event(PanelEvent::Live(crate::overlays::live::LiveControl::Stop))?
				} else {
					let voice = self
						.con
						.get("cl_live_voice")
						.map_or_else(|| Str::new_static("sol"), |value| Str::new(value.to_string()));
					// Claim the edge before the panel's first tick emits Start,
					// so two Ctrl+L presses cannot stack two live surfaces.
					self.live_active = true;
					return self.act(HostAction::Open(PanelOpener::new(move |cx| {
						Ok(Box::new(crate::overlays::live::LivePanel::open(voice.clone(), cx))
							as Box<dyn crate::overlays::Panel>)
					})));
				}
			},
			HostAction::LiveEvent(event) => {
				if matches!(event, crate::overlays::live::LiveUiEvent::Closed) {
					let was_live = std::mem::replace(&mut self.live_active, false);
					if was_live {
						let _ = self
							.commands
							.send(HostCommand::LiveVoice(crate::overlays::live::LiveControl::Stop));
					}
				}
				let now = self.clock.elapsed();
				let panel_event = self
					.overlays
					.notify_panels(crate::overlays::PanelNote::Live(&event, now));
				match panel_event {
					PanelEvent::Ignored => Routed::Repaint,
					event => self.apply_panel_event(event)?,
				}
			},
			HostAction::LiveDelegation { id, request } => {
				let _ = self
					.commands
					.send(HostCommand::LiveDelegation { id, request });
				Routed::Ignored
			},
			HostAction::SttEvent(event) => self.stt_event(event)?,
			HostAction::EscapeHook(hook) => {
				self.escape_hooks.retain(|prior| prior.id != hook.id);
				self.escape_hooks.push(hook);
				Routed::Ignored
			},
			HostAction::DropEscapeHook(id) => {
				self.escape_hooks.retain(|prior| prior.id != id);
				Routed::Ignored
			},
			HostAction::Open(opener) => {
				let viewport = self.viewport();
				let opened = opener.open(&self.panel_cx(viewport));
				match opened {
					Ok(panel) => {
						let _ = self
							.commands
							.send(HostCommand::Overlay { id: Str::new_static(panel.id()), open: true });
						self.overlays.show(Overlay::Panel(panel));
						Routed::Repaint
					},
					Err(error) => self.notice(error),
				}
			},
			HostAction::Call(call) => {
				let viewport = self.viewport();
				let event = call.call(&self.panel_cx(viewport));
				self.apply_panel_event(event)?
			},
			HostAction::Command(action) => self.run_command(action)?,
			HostAction::Outcome(outcome) => {
				if let crate::overlays::Outcome::Service(service) = &outcome
					&& service.result.is_ok()
					&& service.mutation.affects_active_account_usage()
				{
					self.account_usage.invalidate();
				}
				let event = self
					.overlays
					.notify_panels(crate::overlays::PanelNote::Outcome(&outcome));
				match event {
					PanelEvent::Ignored => match outcome {
						crate::overlays::Outcome::Service(outcome) => match outcome.result {
							Ok(line) => self.notice(line),
							Err(error) => self.notice(error.to_string()),
						},
						crate::overlays::Outcome::Git(outcome) => match outcome.result {
							Ok(line) => self.notice(line),
							Err(error) => self.notice(error.to_string()),
						},
						crate::overlays::Outcome::Agent(outcome) => match outcome.result {
							Ok(line) => self.notice(line),
							Err(error) => self.notice(error.to_string()),
						},
						crate::overlays::Outcome::Collab(outcome) => match outcome.result {
							Ok(state) => {
								let status = match state.role {
									Some(crate::overlays::services::CollabRole::Host) => {
										Some(CollabStatus::host(
											state.participants.len().try_into().unwrap_or(u32::MAX),
										))
									},
									Some(crate::overlays::services::CollabRole::Guest) => {
										let participants =
											state.participants.len().try_into().unwrap_or(u32::MAX);
										let host = self
											.collab_status
											.as_ref()
											.and_then(|status| status.host.as_deref())
											.cloned();
										Some(host.map_or_else(
											|| CollabStatus::guest_pending(participants),
											|host| CollabStatus::guest(participants, host),
										))
									},
									None => None,
								};
								self.set_collab_status(status).max(self.notice(state.line))
							},
							Err(error) => self.notice(error.to_string()),
						},
						crate::overlays::Outcome::SessionIndex(outcome) => match outcome.result {
							Ok(_) => Routed::Ignored,
							Err(error) => self.notice(error),
						},
						crate::overlays::Outcome::ForeignSessionImport(outcome) => match outcome.result {
							Ok(path)
								if path.extension().and_then(|extension| extension.to_str())
									== Some("oms") =>
							{
								let _ = self.commands.send(HostCommand::SessionOpen { path });
								Routed::Repaint
							},
							Ok(_) => self.notice(sf!("Failed to persist {} session", outcome.source)),
							Err(error) => self.notice(error.to_string()),
						},
					},
					event => self.apply_panel_event(event)?,
				}
			},
			HostAction::Editor(key) => self.route_unbound_key(key)?,
			HostAction::Panel(action) => {
				let event = match self.overlays.active_mut() {
					Some(Overlay::Panel(panel)) => panel.action(action),
					_ => PanelEvent::Ignored,
				};
				self.apply_panel_event(event)?
			},
			HostAction::LocalRefused { draft, reason } => {
				// The optimistic activity edge from `submit` never had a turn
				// behind it; roll it back with the draft.
				self.set_turn_active(false);
				self.refuse_local(&draft, reason)
			},
			HostAction::Reply { severity, text } => match severity {
				omp_con::Severity::Info if text.is_empty() => Routed::Ignored,
				_ => self.notice(text),
			},
		})
	}

	/// The terminal viewport panels size against: the composer width and
	/// the last presented height.
	fn viewport(&self) -> Size {
		Size::new(self.composer.frame().size().width, self.viewport_height)
	}

	/// Applies a settings submenu preview without touching the command
	/// context: cancel can therefore restore the exact observer state and
	/// rewind never sees preview-only values.
	fn preview_setting(&mut self, convar: Str, value: Str) -> Routed {
		match convar.as_str() {
			"cl_theme_dark" | "cl_theme_light" => {
				if self.preview_ui.is_none() {
					self.preview_ui = Some((convar, self.ui.clone()));
				}
				match self.services.theme(value.as_str()) {
					Ok(palette) => {
						let mut ui = self.ui.clone();
						ui.set_palette(palette);
						self.set_ui_context(ui);
						Routed::RebuildProjection
					},
					Err(error) => self.notice(error.to_string()),
				}
			},
			"cl_composer_shape" => {
				if self.preview_shape.is_none() {
					self.preview_shape = Some((convar, self.composer.shape()));
				}
				self.composer.set_shape(composer_style(value.as_str()));
				Routed::Repaint
			},
			"cl_status_line_preset" | "cl_status_line_separator" | "cl_status_line_context_line" => {
				let baseline = self
					.preview_status
					.as_ref()
					.filter(|(name, ..)| name == &convar)
					.map_or_else(
						|| self.local.status_appearance.clone(),
						|(_, baseline, _)| baseline.clone(),
					);
				let mut preview = self
					.preview_status
					.as_ref()
					.filter(|(name, ..)| name == &convar)
					.map_or_else(|| baseline.clone(), |(_, _, preview)| preview.clone());
				apply_status_preview(&mut preview, convar.as_str(), value.as_str());
				self.preview_status = Some((convar, baseline, preview.clone()));
				self.local.status_appearance = preview.clone();
				self.composer.set_status_appearance(preview);
				if self.refresh_wall_clock(self.clock.elapsed()) {
					self.sync_status();
				}
				Routed::Repaint
			},
			_ => Routed::Repaint,
		}
	}

	fn cancel_setting_preview(&mut self, convar: &str) -> Routed {
		if self
			.preview_ui
			.as_ref()
			.is_some_and(|(name, _)| name == convar)
			&& let Some((_, ui)) = self.preview_ui.take()
		{
			self.set_ui_context(ui);
		}
		if self
			.preview_shape
			.as_ref()
			.is_some_and(|(name, _)| name == convar)
			&& let Some((_, shape)) = self.preview_shape.take()
		{
			self.composer.set_shape(shape);
		}
		if self
			.preview_status
			.as_ref()
			.is_some_and(|(name, ..)| name == convar)
			&& let Some((_, baseline, _)) = self.preview_status.take()
		{
			self.local.status_appearance = baseline.clone();
			self.composer.set_status_appearance(baseline);
			if self.refresh_wall_clock(self.clock.elapsed()) {
				self.sync_status();
			}
		}
		Routed::RebuildProjection
	}

	fn commit_setting_preview(&mut self, convar: &str) {
		if self
			.preview_ui
			.as_ref()
			.is_some_and(|(name, _)| name == convar)
		{
			self.preview_ui = None;
		}
		if self
			.preview_shape
			.as_ref()
			.is_some_and(|(name, _)| name == convar)
		{
			self.preview_shape = None;
		}
		if self
			.preview_status
			.as_ref()
			.is_some_and(|(name, ..)| name == convar)
		{
			self.preview_status = None;
		}
	}

	/// Applies what a panel (or a command-owned call) asked for.
	fn apply_panel_event(&mut self, event: PanelEvent) -> Result<Routed, HostError> {
		Ok(match event {
			PanelEvent::Ignored => Routed::Ignored,
			PanelEvent::Consumed => Routed::Repaint,
			PanelEvent::Close => {
				self.close_overlay();
				Routed::Repaint
			},
			PanelEvent::Run(line) => self.run_console(line.as_str())?.max(Routed::Repaint),
			PanelEvent::PreviewSetting { convar, value } => self.preview_setting(convar, value),
			PanelEvent::CancelSettingPreview { convar } => self.cancel_setting_preview(&convar),
			PanelEvent::RunSetting { convar, line } => match self.run_console(line.as_str()) {
				Ok(routed) => {
					self.commit_setting_preview(&convar);
					let _ = self.overlays.notify_panels(PanelNote::SettingResult {
						convar: convar.as_str(),
						error:  None,
					});
					routed.max(Routed::RebuildProjection)
				},
				Err(error) => {
					let message = error.to_string();
					let event = self.overlays.notify_panels(PanelNote::SettingResult {
						convar: convar.as_str(),
						error:  Some(&message),
					});
					match event {
						PanelEvent::Ignored => self.notice(message),
						PanelEvent::Notice(message) => self.notice(message),
						_ => Routed::Repaint,
					}
				},
			},
			PanelEvent::Finish(line) => {
				self.close_overlay();
				self.run_console(line.as_str())?.max(Routed::Repaint)
			},
			PanelEvent::FinishCommand(command) => {
				self.close_overlay();
				let _ = self.commands.send(command);
				Routed::Repaint
			},
			PanelEvent::OpenPlanSave { content, title } => {
				self.close_overlay();
				let cwd = self
					.services
					.project_dir()
					.or_else(|_| std::env::current_dir())
					.unwrap_or_else(|_| PathBuf::from("."));
				self.act(HostAction::Open(PanelOpener::new(move |cx| {
					Ok(Box::new(crate::overlays::plan_save::PlanSavePanel::open(
						content.clone(),
						title.clone(),
						cwd.clone(),
						cx.viewport,
						cx.ui,
					)) as Box<_>)
				})))?
			},
			PanelEvent::CloseNotice(text) => {
				self.close_overlay();
				self.notice(text)
			},
			PanelEvent::Recall(text) => {
				self.close_overlay();
				self.composer.set_text(text.as_str());
				Routed::Repaint
			},
			PanelEvent::Paste { text, choice } => {
				self.close_overlay();
				self.land_paste(&text, choice)
			},
			PanelEvent::Notice(text) => self.notice(text),
			PanelEvent::Copy(text) => {
				self.clipboard = Some(text);
				Routed::Repaint
			},
			PanelEvent::Ask { id, answers } => {
				// The element stays `running` until the tool folds the reply;
				// forgetting the handle keeps the dialog from reopening
				// meanwhile.
				self.ask_open = None;
				if self.overlays.close_id(crate::overlays::ask::ID) {
					let _ = self.commands.send(HostCommand::Overlay {
						id:   Str::new_static(crate::overlays::ask::ID),
						open: false,
					});
				}
				let _ = self.commands.send(HostCommand::AskAnswer { id, answers });
				Routed::Repaint
			},
			PanelEvent::Command(command) => {
				let _ = self.commands.send(command);
				Routed::Repaint
			},
			PanelEvent::Live(control) => {
				let stop = control == crate::overlays::live::LiveControl::Stop;
				self.live_active = !stop;
				let _ = self.commands.send(HostCommand::LiveVoice(control));
				if stop {
					self.close_overlay();
				}
				Routed::Repaint
			},
		})
	}

	fn apply_picker_event(&mut self, event: PickerEvent) -> Result<Routed, HostError> {
		Ok(match event {
			PickerEvent::Consumed => Routed::Repaint,
			PickerEvent::Close => {
				self.close_overlay();
				Routed::Repaint
			},
			PickerEvent::Pick(index) | PickerEvent::PickTask(index) => {
				let Some(Overlay::Models(picker)) = self.overlays.active() else {
					return Ok(Routed::Repaint);
				};
				let session_only = picker.session_only();
				let Some(row) = picker.rows().get(index).cloned() else {
					return Ok(Routed::Repaint);
				};
				let task = matches!(event, PickerEvent::PickTask(_));
				self.close_overlay();
				self.select_model(&row, task, session_only)
			},
			PickerEvent::PickRole(index) => {
				let Some(Overlay::Models(picker)) = self.overlays.active() else {
					return Ok(Routed::Repaint);
				};
				let Some(role) = picker.quick_roles().get(index).cloned() else {
					return Ok(Routed::Repaint);
				};
				let Some(row) = picker.rows().get(role.model).cloned() else {
					return Ok(Routed::Repaint);
				};
				self.close_overlay();
				let routed = self.select_model(&row, false, true);
				if let Some(thinking) = role.thinking {
					AI_THINKING.set(&self.con, thinking)?;
					self.sync_status();
				}
				routed
			},
			PickerEvent::Recall(text) => {
				self.close_overlay();
				self.composer.set_text(text.as_str());
				Routed::Repaint
			},
			PickerEvent::SubmitHistory(text) => {
				self.close_overlay();
				self.composer.set_text(text.as_str());
				let action = self.composer.preview_submission();
				self.preview_composer_action(action)?
			},
			PickerEvent::CopyHistory(text) => {
				self.clipboard = Some(text);
				self.notice("Copied history prompt")
			},
		})
	}

	pub(crate) fn close_overlay(&mut self) {
		if let Some(overlay) = self.overlays.dismiss()
			&& matches!(overlay, Overlay::Models(_) | Overlay::Panel(_))
		{
			let id = overlay.id();
			let _ = self
				.commands
				.send(HostCommand::Overlay { id: Str::new_static(id), open: false });
			// Only account panels can change stored OAuth state. Refreshing
			// any other panel close would turn observer-local navigation into
			// account I/O.
			if matches!(id, "login" | "logout" | "setup" | "usage-reset") {
				self
					.local
					.sync_primary_billing(self.services.as_ref(), &self.model);
				self.account_usage.invalidate();
			}
		}
	}

	/// Writes the picked model to the control plane: `ai_model` for the
	/// session, `ai_task_model` for task subagents, archived to `config.cfg`
	/// unless the picker was opened session-only.
	fn select_model(&mut self, row: &ModelRow, task: bool, session_only: bool) -> Routed {
		let var = if task { "ai_task_model" } else { "ai_model" };
		let script = format!("{var} {}", omp_con::Value::Str(row.key.clone()));
		if let Err(error) = self.con.exec(&script, Source::Console) {
			return self.notice(error.to_string());
		}
		if !task {
			self.reset_thinking_for(row);
			self.sync_status();
		}
		if !session_only && let Err(error) = self.con.exec("writecfg", Source::Console) {
			return self.notice(format!("{} set for this session only: {error}", row.key));
		}
		let label = if row.name.is_empty() {
			row.key.clone()
		} else {
			row.name.clone()
		};
		self.notice(if task {
			format!("Task subagents now use {label}")
		} else if session_only {
			format!("Session model: {label}")
		} else {
			format!("Model: {label} (saved to config.cfg)")
		})
	}

	/// Clamps `ai_thinking` to what the newly selected model supports.
	fn reset_thinking_for(&self, row: &ModelRow) {
		let current = AI_THINKING.get(&self.con);
		let supported = current == "off" || row.efforts.iter().any(|effort| *effort == current);
		if !supported {
			let next = row
				.efforts
				.last()
				.cloned()
				.unwrap_or_else(|| Str::new_static("off"));
			let _ = AI_THINKING.set(&self.con, next);
		}
	}

	/// Index of the live model in the picker roster.
	fn current_model_index(&self) -> usize {
		let live = self.live_model();
		self
			.models
			.iter()
			.position(|row| row.key == live)
			.unwrap_or(0)
	}

	/// The model the next turn will use: `ai_model` when set, else the launch
	/// route.
	fn live_model(&self) -> Str {
		let model = AI_MODEL.get(&self.con);
		if model.is_empty() {
			self.model.identifier.clone()
		} else {
			model
		}
	}

	/// `cycleThinkingLevel`: off → each catalog effort → off.
	fn cycle_thinking(&mut self) -> Routed {
		let live = self.live_model();
		let efforts = self
			.models
			.iter()
			.find(|row| row.key == live)
			.map(|row| row.efforts.clone())
			.unwrap_or_default();
		if efforts.is_empty() {
			return self.notice(NO_THINKING);
		}
		let current = AI_THINKING.get(&self.con);
		let next = match efforts.iter().position(|effort| *effort == current) {
			Some(index) if index + 1 < efforts.len() => efforts[index + 1].clone(),
			Some(_) => Str::new_static("off"),
			None => efforts[0].clone(),
		};
		match AI_THINKING.set(&self.con, next.clone()) {
			Ok(()) => {
				self.sync_status();
				self.notice(format!("Thinking: {next}"))
			},
			Err(error) => self.notice(error.to_string()),
		}
	}

	/// `cycleRoleModels`: step `ai_model` through the role roster and
	/// show the role track with the active role bracketed.
	fn cycle_model(&mut self, backward: bool) -> Routed {
		let distinct = self
			.cycle
			.iter()
			.map(|(_, model, _)| model)
			.collect::<std::collections::BTreeSet<_>>();
		if distinct.len() < 2 {
			return self.notice("Only one role model available");
		}
		let live = self.live_model();
		let at = self.cycle.iter().position(|(_, model, _)| *model == live);
		let len = self.cycle.len();
		let next = match (at, backward) {
			(Some(index), false) => (index + 1) % len,
			(Some(index), true) => (index + len - 1) % len,
			(None, _) => 0,
		};
		let (role, model, thinking) = self.cycle[next].clone();
		let row = self.models.iter().find(|row| row.key == model).cloned();
		let script = format!("ai_model {}", omp_con::Value::Str(model.clone()));
		if let Err(error) = self.con.exec(&script, Source::Console) {
			return self.notice(error.to_string());
		}
		if let Some(row) = row.as_ref() {
			self.reset_thinking_for(row);
		}
		if let Some(thinking) = thinking {
			let _ = AI_THINKING.set(&self.con, thinking);
		}
		self.sync_status();
		let mut track = String::new();
		for (index, (name, ..)) in self.cycle.iter().enumerate() {
			if index > 0 {
				track.push_str("  ");
			}
			if index == next {
				track.push('[');
				track.push_str(name);
				track.push(']');
			} else {
				track.push_str(name);
			}
		}
		let label = row.map_or(model, |row| {
			if row.name.is_empty() {
				row.key
			} else {
				row.name
			}
		});
		self.notice(format!("{track}  ·  {role}: {label}"))
	}

	/// Whether the plan Director is engaged on the live chain: an active
	/// `<director family=plan>` anywhere under `<meta><directors>` (frames
	/// nest, so the scan is recursive).
	pub(crate) fn plan_engaged(&self) -> bool {
		self.director_engaged(PLAN_DIRECTOR)
	}

	/// Whether the newest turn closed with an error notice.
	fn last_turn_failed(&self) -> bool {
		let dom = &self.replica;
		let Some(turn) = dom.children(dom.body()).last() else {
			return false;
		};
		dom.children(*turn)
			.iter()
			.rev()
			.filter_map(|handle| dom.get(*handle))
			.find(|node| node.tag == Tag::Known(KnownTag::Notice))
			.is_some_and(|node| {
				node.prop(&PropId::Kind.into()).and_then(Value::as_str) == Some("error")
			})
	}

	fn approval_frame(&self, width: u16) -> Option<Frame> {
		let approval = self.overlays.approval()?;
		let countdown = approval.timeout.and_then(|timeout| {
			let shown = self.approval_shown?;
			let countdown = Countdown::new("auto-decides in", shown, timeout);
			Some(countdown.remaining(self.clock.elapsed()))
		});
		Some(approval_frame(approval, countdown, width, &self.ui))
	}

	/// Next whole-second wake while an approval countdown is showing.
	fn approval_wake(&self) -> Option<Duration> {
		let approval = self.overlays.approval()?;
		let timeout = approval.timeout?;
		let shown = self.approval_shown?;
		let now = self.clock.elapsed();
		if now.saturating_sub(shown) >= timeout {
			return None;
		}
		let elapsed = now.saturating_sub(shown);
		Some(shown + Duration::from_secs(elapsed.as_secs() + 1))
	}

	/// Frame and anchor of the topmost focused overlay (picker or panel),
	/// when one is open.
	fn overlay_frame(&mut self, size: Size) -> Option<(Frame, PanelAnchor)> {
		self.with_overlay_frame(size, |frame, anchor| (frame.clone(), anchor))
	}

	/// Viewport band the topmost focused overlay is composited into at
	/// `size`, with its frame width; `None` when no picker or panel is open.
	fn overlay_band(&mut self, size: Size) -> Option<(omp_tui::OverlayBand, u16)> {
		let composer = self.composer.height();
		self.with_overlay_frame(size, |frame, anchor| {
			let (options, _) = overlay_options(anchor, size.width, composer);
			let layer = Layer { frame, options: &options, active: false };
			(layer.band(size), frame.size().width)
		})
	}

	/// Reflows the topmost focused overlay for `size` and reads its frame
	/// and anchor in place; `None` when no picker or panel is open.
	fn with_overlay_frame<R>(
		&mut self,
		size: Size,
		read: impl FnOnce(&Frame, PanelAnchor) -> R,
	) -> Option<R> {
		let center = Size::new(size.width * 4 / 5, size.height.saturating_sub(2));
		match self.overlays.active_mut() {
			Some(Overlay::Models(picker)) => Some(read(picker.frame(size), PanelAnchor::Bottom)),
			Some(Overlay::History(picker)) => Some(read(picker.frame(size), PanelAnchor::Bottom)),
			Some(Overlay::Panel(panel)) => {
				let anchor = panel.anchor();
				let viewport = match anchor {
					PanelAnchor::Center => center,
					PanelAnchor::Bottom
					| PanelAnchor::BottomCenter
					| PanelAnchor::Full
					| PanelAnchor::Side => size,
				};
				Some(read(panel.frame(viewport), anchor))
			},
			Some(Overlay::Approval(_)) | None => None,
		}
	}

	/// Advances the topmost panel's animations, closing a panel that
	/// reports itself finished.
	fn tick_overlay(&mut self, now: Duration) -> Result<bool, HostError> {
		let (changed, finished, settled) = match self.overlays.active_mut() {
			Some(Overlay::Panel(panel)) => {
				let changed = panel.tick(now);
				let settled = if changed { panel.settled() } else { None };
				(changed, panel.finished(), settled)
			},
			_ => (false, false, None),
		};
		if finished {
			self.close_overlay();
			return Ok(true);
		}
		if let Some(event) = settled {
			self.apply_panel_event(event)?;
			return Ok(true);
		}
		Ok(changed)
	}

	/// Earliest wake among the overlay stack, the approval countdown, the
	/// space-hold release timer, and the quota refresh.
	fn next_wake(&self) -> Option<Duration> {
		let panel = match self.overlays.active() {
			Some(Overlay::Panel(panel)) => panel.next_wake(),
			_ => None,
		};
		let now = self.clock.elapsed();
		let quota = crate::celebrate::CL_CODEX_FIREWORKS
			.get(&self.con)
			.then(|| self.quota.next_wake(now, self.model.provider.as_str()))
			.flatten();
		[
			panel,
			self.approval_wake(),
			self.space_hold.next_wake(),
			quota,
			self.retry_wake(),
			self.account_usage.next_wake(now),
		]
		.into_iter()
		.flatten()
		.min()
	}

	/// Polls the Codex quota watch and opens the reset fireworks when
	/// consecutive reports show an unscheduled weekly reset (
	/// `#applyUsageRefreshReports` → `showCodexResetFireworks`).
	fn tick_quota(&mut self, now: Duration) -> Result<bool, HostError> {
		if !crate::celebrate::CL_CODEX_FIREWORKS.get(&self.con) {
			return Ok(false);
		}
		let Some(event) = self
			.quota
			.poll(self.services.as_ref(), self.model.provider.as_str(), now)
		else {
			return Ok(false);
		};
		let showing = matches!(
			self.overlays.active(),
			Some(Overlay::Panel(panel)) if panel.id() == "fireworks"
		);
		if showing {
			return Ok(false);
		}
		let opener = crate::overlays::PanelOpener::new(move |cx| {
			Ok(Box::new(crate::overlays::fireworks::Fireworks::open(event, cx))
				as Box<dyn crate::overlays::Panel>)
		});
		self.act(HostAction::Open(opener))?;
		Ok(true)
	}

	/// Ends a push-to-talk hold whose release gap elapsed.
	fn tick_space_hold(&mut self, now: Duration) -> bool {
		if self.space_hold.release_due(now) {
			self.set_recording(false);
			return true;
		}
		false
	}

	/// One-row notice frame above the composer, when a notice is showing.
	fn notice_frame(&self, width: u16) -> Option<Frame> {
		let text = Str::new(self.overlays.notice()?);
		let tree = omp_tui::dom! { <text fg=muted truncate>{" "}{text}</text> };
		Some(Ui::from_root(tree, width, self.ui.clone()).frame().clone())
	}
}

fn localize_composer_mouse(
	report: MouseReport,
	top: u16,
	width: u16,
	height: u16,
) -> Option<MouseReport> {
	if report.col >= width || report.row < top || report.row >= top.saturating_add(height) {
		return None;
	}
	Some(MouseReport { row: report.row - top, ..report })
}

/// Projection actor retaining only presentation state and a detached DOM
/// replica.
pub struct Host {
	presenter:       Presenter,
	resize_policy:   ResizePolicy,
	projection:      Option<Projection>,
	clipboard_write: Option<oneshot::Receiver<ClipboardWriteOutcome>>,
}

impl Host {
	/// Creates an actor. No controller or journal handle is retained.
	#[must_use]
	pub fn new(options: HostOptions) -> Self {
		let resize_policy = options.resize_policy;
		Self {
			presenter: Presenter::new(options, 80),
			resize_policy,
			projection: None,
			clipboard_write: None,
		}
	}

	/// Runs the real-terminal actor until `C-c`, debug quit, or terminal
	/// closure.
	pub async fn run(mut self) -> Result<(), HostError> {
		loop {
			// `Terminal::leave` restores the shell title and clears native
			// progress. These delivery caches belong to one ownership epoch.
			self.presenter.title.reset_delivery();
			self.presenter.progress_shown = false;
			let (caps, probe) = negotiate_async(Duration::from_millis(120)).await;
			let ui = self.presenter.ui.clone().with_terminal_caps(&caps);
			self.presenter.set_ui_context(ui);
			let mut terminal = Terminal::enter(
				TerminalOptions::new(caps)
					.probe_results(probe)
					.cursor_style(CursorStyle::BlinkingBar),
			)?;
			terminal.edit_keymap(|keymap| keymap.set_chord_events(true));
			let mut renderer = Renderer::new(TtyOut::new()?);
			renderer.apply_caps(&caps)?;
			let size = terminal.size()?;
			self.presenter.composer.restore_focus();
			self.presenter.composer.resize(size.width, size.height);
			// First entry creates the ledger; re-entry after a suspend, an
			// external editor, or a display reset keeps it — rows already in
			// native scrollback are never emitted again (ADR 0034).
			if let Some(projection) = self.projection.as_mut() {
				projection.resize(size);
			}
			self.reconcile_projection(size);
			let result = self.event_loop(&mut terminal, &mut renderer, size).await;
			let pause = finish_terminal_epoch(result, terminal.leave())?;
			// The terminal is fully restored here: the shell, a child editor,
			// or a fresh probe owns it until the loop re-enters.
			match pause {
				Pause::Quit => {
					arm_hard_abort();
					return Ok(());
				},
				Pause::Suspend => {
					if let Err(error) = suspend_process() {
						self.presenter.notice(error.to_string());
					}
				},
				Pause::ExternalEditor => {
					// `handleExternalEditor`: chips expand to their pasted text
					// before the draft reaches `$EDITOR`; the result lands verbatim.
					let draft = self.presenter.composer.text();
					let editor = self
						.presenter
						.pending_editor
						.take()
						.expect("external-editor route carries a resolved command");
					let result =
						crate::editor::edit_draft(&editor, &draft, crate::editor::EditorOptions {
							extension: "omp.md",
							..crate::editor::EditorOptions::default()
						});
					self.presenter.finish_external_editor(result);
				},
				Pause::DisplayReset => {},
			}
		}
	}

	async fn event_loop(
		&mut self,
		terminal: &mut Terminal,
		renderer: &mut Renderer<TtyOut>,
		mut size: Size,
	) -> Result<Pause, HostError> {
		self.sync_terminal_state(terminal)?;
		self.present(renderer, size)?;
		// One background clipboard read at a time (Ctrl+V / Ctrl+Shift+V);
		// a stale result is dropped with its receiver.
		let mut clipboard: Option<(oneshot::Receiver<ClipboardReadOutcome>, bool, Instant)> = None;
		let mailbox = Arc::clone(&self.presenter.mailbox);
		loop {
			terminal
				.set_mouse(self.presenter.overlays.pointer() || self.presenter.composer.popup_open())?;
			self.sync_terminal_state(terminal)?;
			let deadline = self.next_deadline();
			if let Some(scope) = self.presenter.clipboard_read.take() {
				clipboard =
					Some((spawn_clipboard_read(scope), scope == ClipboardRead::Text, Instant::now()));
			}
			let clipboard_pending = clipboard.is_some();
			let clipboard_write_pending = self.clipboard_write.is_some();
			tokio::select! {
				biased;
				terminal_event = terminal.next() => {
					match terminal_event? {
						TerminalEvent::Resize => {
							if let Some(next) = terminal.take_resize()? {
								size = next;
								self.presenter.composer.resize(next.width, next.height);
								self.projection_mut().resize(next);
								self.present(renderer, size)?;
							}
						},
						TerminalEvent::Input(event) => {
							if let Some(pause) =
								self.terminal_input(terminal, renderer, size, event, false)?
							{
								return Ok(pause);
							}
						},
						TerminalEvent::InputWithMeta { event, submit_after_paste } => {
							if let Some(pause) = self.terminal_input(
								terminal,
								renderer,
								size,
								event,
								submit_after_paste,
							)? {
								return Ok(pause);
							}
						},
						TerminalEvent::Debug(query) => {
							let value = self.debug_response(query.op, size);
							respond_debug_query(query.id, value);
						},
						TerminalEvent::Effect(_) => {},
						TerminalEvent::Closed => break,
					}
				},
				() = frame_deadline(self.presenter.clock, deadline) => {
					self.sync_terminal_state(terminal)?;
					let ticked = self.tick();
					let settled = self
						.presenter
						.settle_intro(self.presenter.clock.elapsed());
					if settled {
						self.reconcile_projection(size);
					}
					if ticked || settled {
						self.present(renderer, size)?;
					}
				},
				action = mailbox.next() => {
					if let Some(action) = action {
						let routed = self.presenter.act(action)?.max(self.presenter.drain_mailbox()?);
						if let Some(text) = self.presenter.clipboard.take() {
							self.clipboard_write = Some(terminal.copy_to_clipboard(&text)?);
						}
						if let Some(pause) = self.apply_routed(routed, renderer, size)? {
							return Ok(pause);
						}
					}
				},
				read = async {
					match clipboard.as_mut() {
						Some((rx, _, started)) => {
							let elapsed = started.elapsed();
							match tokio::time::timeout(CLIPBOARD_READ_TIMEOUT.saturating_sub(elapsed), rx).await {
								Ok(Ok(outcome)) => outcome,
								Ok(Err(_)) | Err(_) => ClipboardReadOutcome::ReadFailure,
							}
						},
						None => future::pending().await,
					}
				}, if clipboard_pending => {
					let raw = clipboard.take().is_some_and(|(_, raw, _)| raw);
					let routed = self.presenter.deliver_clipboard(read, raw)?;
					if let Some(pause) = self.apply_routed(routed, renderer, size)? {
						return Ok(pause);
					}
				},
				written = async {
					match self.clipboard_write.as_mut() {
						Some(receiver) => receiver.await.unwrap_or(ClipboardWriteOutcome::WriteFailure),
						None => future::pending().await,
					}
				}, if clipboard_write_pending => {
					self.clipboard_write = None;
					let routed = self.presenter.deliver_clipboard_write(written);
					if let Some(pause) = self.apply_routed(routed, renderer, size)? {
						return Ok(pause);
					}
				},
				dom_event = self.presenter.dom_events.recv_async() => {
					let Ok(event) = dom_event else { break };
					let reset = matches!(event, Event::Reset { .. });
					self.presenter.apply_dom_event(&event)?;
					if reset {
						self.reset_projection(size);
					} else {
						self.reconcile_projection(size);
					}
					self.present(renderer, size)?;
					// Toasts the settled turn earned go out after its paint (OSC
					// 99/9/777, then BEL by capability).
					for toast in self.presenter.notifications.drain(..) {
						if let Err(error) = terminal.notify(&toast) {
							tracing::debug!(%error, "notification delivery failed");
						}
					}
				},
				kernel_event = self.presenter.kernel_events.recv_async() => {
					let Ok(event) = kernel_event else {
						break;
					};
					match self.presenter.apply_kernel_event(&event) {
						Routed::RebuildProjection => {
							self.reconcile_projection(size);
							self.present(renderer, size)?;
						},
						Routed::Repaint => self.present(renderer, size)?,
						_ => {},
					}
				},
				git = recv_git(self.presenter.git_facts.as_ref()) => {
					self.presenter.local.set_git(&git);
					if self.presenter.sync_status() {
						self.present(renderer, size)?;
					}
				},
			}
		}
		Ok(Pause::Quit)
	}

	fn terminal_input(
		&mut self,
		terminal: &mut Terminal,
		renderer: &mut Renderer<TtyOut>,
		size: Size,
		event: InputEvent,
		submit_after_paste: bool,
	) -> Result<Option<Pause>, HostError> {
		if terminal.handle_input_event(&event, renderer)? {
			// A completed OSC 5522 offer carries an image or text paste out
			// of band ( enhanced paste).
			if let Some(pasted) = terminal.take_paste() {
				let clipboard = match pasted {
					omp_tui::Pasted::Text(text) => Clipboard::Text(text.to_string()),
					omp_tui::Pasted::Image(image) => Clipboard::Image(image),
				};
				let routed = self
					.presenter
					.deliver_clipboard(ClipboardReadOutcome::Payload(clipboard), false)?;
				if let Some(pause) = self.apply_routed(routed, renderer, size)? {
					return Ok(Some(pause));
				}
			}
			if let Some(appearance) = terminal.appearance() {
				let mut ui = self.presenter.ui.clone();
				if ui.apply_appearance(appearance) {
					self.presenter.set_ui_context(ui);
					self.reconcile_projection(size);
					self.present(renderer, size)?;
				}
			}
			self.sync_terminal_state(terminal)?;
			return Ok(None);
		}
		let routed = self.input(event, submit_after_paste, size)?;
		if let Some(text) = self.presenter.clipboard.take() {
			self.clipboard_write = Some(terminal.copy_to_clipboard(&text)?);
		}
		self.apply_routed(routed, renderer, size)
	}

	/// Applies a routing outcome to the terminal; `Some` releases the tty.
	fn apply_routed(
		&mut self,
		routed: Routed,
		renderer: &mut Renderer<TtyOut>,
		size: Size,
	) -> Result<Option<Pause>, HostError> {
		match routed {
			Routed::Quit => Ok(Some(Pause::Quit)),
			Routed::Suspend => Ok(Some(Pause::Suspend)),
			Routed::ExternalEditor => Ok(Some(Pause::ExternalEditor)),
			Routed::DisplayReset => Ok(Some(Pause::DisplayReset)),
			Routed::Ignored => Ok(None),
			Routed::Repaint => {
				self.present(renderer, size)?;
				Ok(None)
			},
			// A projection switch re-derives the blocks; the slot ledger is
			// reconciled, never replaced, so rows already retired into native
			// scrollback are not staged a second time (ADR 0034).
			Routed::RebuildProjection => {
				self.reconcile_projection(size);
				self.present(renderer, size)?;
				Ok(None)
			},
		}
	}

	/// Earliest animation wake across the composer, mounted blocks, the
	/// overlay stack, and the gesture timers, in host-clock time.
	fn next_deadline(&self) -> Option<Duration> {
		let composer = self.presenter.composer.next_wake();
		let blocks = self
			.projection
			.as_ref()
			.and_then(|projection| projection.next_wake());
		let intro = self
			.presenter
			.intro
			.map(|start| start.saturating_add(Intro::DURATION));
		let now = self.presenter.clock.elapsed();
		let title = self
			.presenter
			.title
			.next_wake(self.presenter.ui.charset, now);
		let active_time = self.presenter.active_time.next_wake(now);
		[
			composer,
			blocks,
			self.presenter.next_wake(),
			intro,
			title,
			active_time,
			self.presenter.wall_clock.next_wake(),
		]
		.into_iter()
		.flatten()
		.min()
	}

	/// Synchronizes title and OSC progress from the same retained run state
	/// used by the status band.
	fn sync_terminal_state(&mut self, terminal: &mut Terminal) -> Result<(), HostError> {
		let attention =
			self.presenter.overlays.approval().is_some() || self.presenter.ask_open.is_some();
		let working = !self.presenter.live_active
			&& (self.presenter.turn_active
				|| self.presenter.maintenance_active()
				|| self.presenter.local.speculation == Speculation::Running);
		let state = if attention {
			TitleState::Attention
		} else if working {
			TitleState::Working
		} else {
			TitleState::Idle
		};
		self
			.presenter
			.title
			.set_enabled(CL_TITLE_STATE.get(&self.presenter.con));
		self.presenter.title.set_state(state);
		if let Some(title) = self
			.presenter
			.title
			.emit(self.presenter.ui.charset, self.presenter.clock.elapsed())
		{
			terminal.set_title(title)?;
		}
		let show_progress = CL_SHOW_PROGRESS.get(&self.presenter.con) && working;
		if show_progress && !self.presenter.progress_shown {
			terminal.set_progress(Progress::Indeterminate)?;
			self.presenter.progress_shown = true;
		} else if !show_progress && self.presenter.progress_shown {
			terminal.set_progress(Progress::Clear)?;
			self.presenter.progress_shown = false;
		}
		Ok(())
	}

	fn tick(&mut self) -> bool {
		let now = self.presenter.clock.elapsed();
		let account_usage = self.presenter.poll_account_usage(now);
		let wall_clock = self.presenter.refresh_wall_clock(now);
		// ActiveTime schedules only visible label boundaries. Synchronizing
		// the retained status here makes that deadline paint exactly once,
		// even when no working spinner is mounted.
		let status = self.presenter.sync_status();
		let composer = self.presenter.composer.tick(now);
		let blocks = self
			.projection
			.as_mut()
			.is_some_and(|projection| projection.tick(now));
		let overlay = self.presenter.tick_overlay(now).unwrap_or_else(|error| {
			self.presenter.notice(error.to_string());
			true
		});
		let countdown = self.presenter.approval_wake().is_some() || self.presenter.retrying.is_some();
		let hold = self.presenter.tick_space_hold(now);
		let quota = self.presenter.tick_quota(now).unwrap_or_else(|error| {
			self.presenter.notice(error.to_string());
			true
		});
		account_usage
			|| wall_clock
			|| status
			|| composer
			|| blocks
			|| overlay
			|| countdown
			|| hold
			|| quota
	}

	fn debug_response(&self, op: DebugOp, size: Size) -> serde_json::Value {
		let presenter = &self.presenter;
		match op {
			DebugOp::Frame => {
				let mut lines =
					crate::project::block_views(&presenter.replica, presenter.show_thinking())
						.into_iter()
						.flat_map(|block| {
							block
								.text
								.as_str()
								.lines()
								.map(str::to_owned)
								.collect::<Vec<_>>()
						})
						.collect::<Vec<_>>();
				lines.push(StatusLine::from_dom(&presenter.replica).text().to_string());
				lines.push(presenter.composer.text());
				if let Some(notice) = presenter.overlays.notice() {
					lines.push(notice.to_owned());
				}
				if let Some(approval) = presenter.overlays.approval() {
					lines.push(approval.title.to_string());
					lines.push(approval.reason.to_string());
					lines.push("y approve  a approve for session  n deny".to_owned());
				}
				serde_json::json!({"ok": true, "lines": lines})
			},
			DebugOp::Tree => {
				let children =
					crate::project::block_views(&presenter.replica, presenter.show_thinking())
						.into_iter()
						.map(|block| {
							serde_json::json!({
								"kind": "TranscriptBlock",
								"id": block.key.to_string(),
								"rect": [0, 0, size.width, 0],
								"children": [],
							})
						})
						.collect::<Vec<_>>();
				let overlays = presenter
					.overlays
					.approval()
					.map(|approval| {
						vec![serde_json::json!({
							"kind": "Approval",
							"id": approval.id,
							"rect": [0, 0, size.width, size.height],
							"visible": true,
							"focus": true,
						})]
					})
					.unwrap_or_default();
				serde_json::json!({
					"ok": true,
					"tree": {
						"root": {
							"kind": "Chat",
							"id": "chat",
							"rect": [0, 0, size.width, size.height],
							"children": children,
						},
						"overlays": overlays,
					},
				})
			},
			DebugOp::Values => serde_json::json!({
				"ok": true,
				"values": {
					"composer": presenter.composer.text(),
					"overlay_open": presenter.overlays.modal(),
					"overlay": presenter.overlays.active().map(Overlay::id).unwrap_or_default(),
					"overlay_depth": presenter.overlays.depth(),
					"notice": presenter.overlays.notice().unwrap_or_default(),
					"model": presenter.live_model(),
					"thinking": AI_THINKING.get(&presenter.con),
					"turn_active": presenter.turn_active,
					"focused_agent": presenter.focused_agent.as_deref().unwrap_or_default(),
					"collab_guest": presenter.collab_guest,
					"recording": presenter.stt_recording,
					"prefix_mode": presenter.composer.prefix_mode().map(|mode| format!("{mode:?}").to_lowercase()).unwrap_or_default(),
					"escape_hooks": presenter.escape_hooks.iter().map(|hook| hook.id.as_str()).collect::<Vec<_>>(),
					"cursor": presenter.composer.frame().cursor().map(|(column, row)| vec![row, column]),
				},
			}),
			_ => serde_json::json!({"ok": false}),
		}
	}

	fn input(
		&mut self,
		event: InputEvent,
		submit_after_paste: bool,
		size: Size,
	) -> Result<Routed, HostError> {
		match event {
			InputEvent::Key(key) => self.presenter.route_key(key),
			InputEvent::Chord(event) => self.presenter.route_chord(event),
			InputEvent::Paste(text) => {
				// An empty bracketed paste is how some terminals announce an
				// image-only pasteboard (macOS Cmd+V): read the clipboard.
				if text.is_empty() {
					self.presenter.clipboard_read = Some(ClipboardRead::Smart);
					return Ok(Routed::Ignored);
				}
				self
					.presenter
					.route_paste_with_options(text.as_str(), PasteOptions { submit_after_paste })
			},
			InputEvent::Mouse(report) => self.route_mouse(report, size),
			InputEvent::Focus(_) | InputEvent::Response(_) => Ok(Routed::Ignored),
		}
	}

	fn route_mouse(&mut self, report: MouseReport, size: Size) -> Result<Routed, HostError> {
		if self.presenter.overlays.active().is_some() || self.presenter.overlays.approval().is_some()
		{
			return self.presenter.route_mouse(report);
		}
		let composer_rows = self.presenter.composer.height().min(size.height);
		if composer_rows == 0 {
			return Ok(Routed::Ignored);
		}
		let chrome = self.presenter.chrome_frame(size.width);
		let banner_rows = chrome.size().height.saturating_sub(composer_rows);
		let top = self
			.projection
			.as_ref()
			.expect("projection initialized before event loop")
			.composer_top(chrome.size().height, size)
			.saturating_add(banner_rows);
		let Some(report) = localize_composer_mouse(report, top, size.width, composer_rows) else {
			if report.kind == omp_tui::Mouse::Move && self.presenter.composer.popup_open() {
				return self.presenter.composer_mouse(MouseReport {
					col: u16::MAX,
					row: u16::MAX,
					..report
				});
			}
			return Ok(Routed::Ignored);
		};
		self.presenter.composer_mouse(report)
	}

	const fn projection_mut(&mut self) -> &mut Projection {
		self
			.projection
			.as_mut()
			.expect("projection initialized before event loop")
	}

	fn rebuild_projection(&mut self, size: Size) {
		let now = self.presenter.clock.elapsed();
		let blocks = self.presenter.blocks();
		let mirror = self.presenter.blocks();
		self.projection =
			Some(Projection::new(size, self.resize_policy, &self.presenter.ui, blocks, mirror, now));
	}

	/// Admits the current blocks into the retained ledger. Only the first
	/// paint ([`Self::rebuild_projection`]) ever creates a ledger: after
	/// that every change — new tails, reorders, projection toggles — is
	/// reconciled so retired rows are emitted exactly once.
	fn reconcile_projection(&mut self, size: Size) {
		let now = self.presenter.clock.elapsed();
		let blocks = self.presenter.blocks();
		let mirror = self.presenter.blocks();
		match self.projection.as_mut() {
			Some(projection) => {
				projection.set_context(&self.presenter.ui);
				projection.reconcile(blocks, mirror, now);
			},
			None => self.rebuild_projection(size),
		}
	}

	/// A session reset (`/new`, `/drop`, rewind, resume): the live document is
	/// replaced in place while rows already in native scrollback stay put
	/// (ADR 0034).
	fn reset_projection(&mut self, size: Size) {
		let now = self.presenter.clock.elapsed();
		let blocks = self.presenter.blocks();
		let mirror = self.presenter.blocks();
		match self.projection.as_mut() {
			Some(projection) => projection.reset_in_place(blocks, mirror, now),
			None => self.rebuild_projection(size),
		}
	}

	fn present(&mut self, renderer: &mut Renderer<TtyOut>, size: Size) -> Result<(), HostError> {
		self.presenter.sync_status();
		self.presenter.viewport_height = size.height;
		let approval = self.presenter.approval_frame(size.width);
		let overlay = self.presenter.overlay_frame(size);
		let notice = self.presenter.status_frame(size.width);
		// The editor band: the pinned error banner (when any) over the
		// composer, retired against and anchored as one chrome block.
		let chrome = self.presenter.chrome_frame(size.width);
		let chrome_rows = chrome.size().height;
		let composer = &self.presenter.composer;
		let projection = self
			.projection
			.as_mut()
			.expect("projection initialized before presentation");
		projection.retire_under_pressure(chrome_rows, size.height);
		let document = projection.document(&chrome, size);
		//  status row sits directly above the editor and collapses the
		// editor top gap (`EditorTopGap`): here the retry loader / notice /
		// retry hint paints over the composer's gap row itself, wherever the
		// composer lands — under the live content while it fits, else at the
		// tail — and below the banner when one is pinned.
		let above_composer = size
			.height
			.saturating_sub(projection.composer_top(chrome_rows, size))
			.saturating_sub(chrome_rows)
			.saturating_add(composer.height())
			.saturating_sub(1);
		let document_options = OverlayOptions::default()
			.width(Dim::Cells(size.width))
			.anchor(OverlayAnchor::TopLeft)
			.non_modal()
			.z(10);
		let approval_options = OverlayOptions::default()
			.width(Dim::Pct(80))
			.anchor(OverlayAnchor::Center)
			.z(30);
		let (picker_options, picker_modal) = overlay_options(
			overlay
				.as_ref()
				.map_or(PanelAnchor::Bottom, |(_, anchor)| *anchor),
			size.width,
			composer.height(),
		);
		let picker = overlay.map(|(frame, _)| frame);
		let notice_options = OverlayOptions::default()
			.width(Dim::Cells(size.width))
			.anchor(OverlayAnchor::BottomLeft)
			.margin(omp_tui::OverlayMargin { bottom: above_composer, ..Default::default() })
			.non_modal()
			// Clipboard/type refusals must remain visible while a modal owns
			// focus; approvals still sit above notices at z=30.
			.z(25);
		let modal = approval.is_some() || (picker.is_some() && picker_modal);
		let mut layers =
			vec![Layer { frame: &document, options: &document_options, active: !modal }];
		if let Some(frame) = notice.as_ref() {
			layers.push(Layer { frame, options: &notice_options, active: false });
		}
		if let Some(frame) = picker.as_ref() {
			layers.push(Layer {
				frame,
				options: &picker_options,
				active: approval.is_none() && picker_modal,
			});
		}
		if let Some(frame) = approval.as_ref() {
			layers.push(Layer { frame, options: &approval_options, active: true });
		}
		let plan = projection.slots.plan();
		match renderer.present_plan(&plan, &layers) {
			Ok(delivered) => {
				projection.slots.commit(plan, delivered);
				Ok(())
			},
			Err(error) => {
				let delivered = error.delivered();
				projection.slots.commit(plan, delivered);
				Err(error.into())
			},
		}
	}
}

impl Drop for Host {
	fn drop(&mut self) {
		// One teardown owner covers clean quit, terminal/read failure, and a
		// cancelled `run` future. Suspend and external-editor pauses retain
		// the host and therefore do not tear the controller down.
		let _ = self.presenter.up.send(Up::Cancel);
		let _ = self.presenter.commands.send(HostCommand::Quit);
	}
}

/// Effect requested by the detached native-window actor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEffect {
	/// No controller or paint state changed.
	Ignored,
	/// The event changed presentation state.
	Consumed,
	/// Close the native window.
	Quit,
}

/// One owned native overlay projection. The window adapter borrows these
/// fields into a [`Layer`] for the duration of one paint.
pub struct NativeOverlay {
	/// Retained overlay cells produced by the shared terminal/native actor.
	pub frame:   Frame,
	/// Viewport placement and z-order shared with terminal presentation.
	pub options: OverlayOptions,
	/// Whether this overlay owns input and the retained caret.
	pub active:  bool,
}

/// Native-window actor over the same detached snapshot and patch stream as
/// [`Host`].
///
/// Window creation and GPU delivery stay in `omp-gui`; this type owns only the
/// projection, composer, overlays, and command mailbox.
pub struct NativeHost {
	presenter:           Presenter,
	frame:               Frame,
	approval_frame:      Option<Frame>,
	overlay:             Option<NativeOverlay>,
	size:                Size,
	/// Presentation-clock instant the composited status row (retry
	/// countdown loader) next changes, so [`NativeHost::poll`] repaints it
	/// without a controller event.
	status_deadline:     Option<Duration>,
	/// Presentation-clock instant a held-space cadence becomes a release.
	///
	/// Native actors do not run the terminal host's deadline loop, so
	/// [`NativeHost::poll`] must advance this observer-local timer itself.
	space_hold_deadline: Option<Duration>,
}

impl NativeHost {
	/// Creates a native actor without retaining a controller or journal handle.
	#[must_use]
	pub fn new(options: HostOptions, size: Size) -> Self {
		let mut host = Self {
			presenter: Presenter::new(options, size.width),
			frame: Frame::new(size),
			approval_frame: None,
			overlay: None,
			size,
			status_deadline: None,
			space_hold_deadline: None,
		};
		host.refresh();
		host
	}

	/// Applies queued controller events, returning whether a repaint is needed.
	pub fn poll(&mut self) -> Result<NativeEffect, HostError> {
		let mut changed = false;
		while let Ok(event) = self.presenter.dom_events.try_recv() {
			self.presenter.apply_dom_event(&event)?;
			changed = true;
		}
		while let Ok(event) = self.presenter.kernel_events.try_recv() {
			changed |= self.presenter.apply_kernel_event(&event) != Routed::Ignored;
		}
		match self.presenter.drain_mailbox()? {
			Routed::Quit => return Ok(NativeEffect::Quit),
			Routed::Ignored => {},
			routed @ (Routed::ExternalEditor | Routed::Suspend) => {
				return Ok(self.finish_native_input(routed));
			},
			Routed::Repaint | Routed::RebuildProjection | Routed::DisplayReset => changed = true,
		}
		while let Some(git) = self
			.presenter
			.git_facts
			.as_ref()
			.and_then(|facts| facts.try_recv().ok())
		{
			self.presenter.local.set_git(&git);
			changed |= self.presenter.sync_status();
		}
		let now = self.presenter.clock.elapsed();
		changed |= self.presenter.composer.tick(now);
		// Retry animation and the retained wall-clock label advance only at
		// their shared earliest deadline.
		let status_due = self.status_deadline.is_some_and(|due| now >= due);
		if status_due {
			let _ = self.presenter.refresh_wall_clock(now);
			changed = true;
		}
		if self.space_hold_deadline.is_some_and(|due| now >= due) {
			changed |= self.presenter.tick_space_hold(now);
		}
		if changed {
			self.refresh();
			Ok(NativeEffect::Consumed)
		} else {
			Ok(NativeEffect::Ignored)
		}
	}

	/// Reflows the native projection for a new cell viewport.
	pub fn resize(&mut self, size: Size) {
		self.size = size;
		self.presenter.composer.resize(size.width, size.height);
		self.presenter.composer.restore_focus();
		self.refresh();
	}

	/// Shows or replaces native input-method marked text at the composer
	/// caret. The byte-indexed selection is kept inside the volatile span;
	/// marked text never enters history, submission, or the session DOM.
	pub fn ime_preedit(&mut self, text: &str, selection: Option<Range<usize>>) -> NativeEffect {
		if self.presenter.overlays.active().is_some() {
			self.presenter.composer.clear_volatile_text();
			return NativeEffect::Ignored;
		}
		if text.is_empty() {
			self.presenter.composer.clear_volatile_text();
		} else {
			self
				.presenter
				.composer
				.set_volatile_text_selection(text, selection);
		}
		self.refresh();
		NativeEffect::Consumed
	}

	/// Commits one native input-method segment exactly once. A composer
	/// commit is one undo unit; an active overlay receives the same character
	/// key sequence as physical input instead.
	pub fn ime_commit(&mut self, text: &str) -> Result<NativeEffect, HostError> {
		if self.presenter.overlays.active().is_none() {
			self.presenter.composer.commit_volatile_text(text);
			self.refresh();
			return Ok(NativeEffect::Consumed);
		}
		let mut effect = NativeEffect::Ignored;
		for character in text.chars() {
			let next = self.key(Key::Char(character))?;
			if next == NativeEffect::Quit {
				return Ok(next);
			}
			if next == NativeEffect::Consumed {
				effect = next;
			}
		}
		Ok(effect)
	}

	/// Applies native focus lifecycle without touching controller state.
	/// Losing focus clears marked text and gesture state; gaining it restores
	/// the retained composer's logical focus.
	pub fn focus(&mut self, focused: bool) -> NativeEffect {
		self.presenter.composer.clear_volatile_text();
		self.presenter.composer.reset_escape_sequence();
		if focused {
			self.presenter.composer.restore_focus();
		}
		self.refresh();
		NativeEffect::Consumed
	}

	/// Applies the OS light/dark appearance through the same ambient
	/// [`UiContext`] the terminal actor uses.
	pub fn appearance(&mut self, appearance: Appearance) -> NativeEffect {
		let mut ui = self.presenter.ui.clone();
		if !ui.apply_appearance(appearance) {
			return NativeEffect::Ignored;
		}
		self.presenter.set_ui_context(ui);
		self.refresh();
		NativeEffect::Consumed
	}

	/// Routes one real native key through the chat input path.
	pub fn key(&mut self, key: Key) -> Result<NativeEffect, HostError> {
		let routed = self.presenter.route_key(key)?;
		Ok(self.finish_native_input(routed))
	}

	/// Routes an exact native chord edge, including key release.
	pub fn chord(&mut self, event: KeyEvent) -> Result<NativeEffect, HostError> {
		let routed = self.presenter.route_chord(event)?;
		Ok(self.finish_native_input(routed))
	}

	/// Routes a native pointer report through the active overlay hit map.
	pub fn mouse(&mut self, report: MouseReport) -> Result<NativeEffect, HostError> {
		let routed = if self.presenter.overlays.active().is_some()
			|| self.presenter.overlays.approval().is_some()
		{
			self.presenter.route_mouse(report)?
		} else {
			let composer_rows = self.presenter.composer.height();
			let top = self.frame.size().height.saturating_sub(composer_rows);
			match localize_composer_mouse(report, top, self.size.width, composer_rows) {
				Some(report) => self.presenter.composer_mouse(report)?,
				None if report.kind == omp_tui::Mouse::Move && self.presenter.composer.popup_open() => {
					self.presenter.composer_mouse(MouseReport {
						col: u16::MAX,
						row: u16::MAX,
						..report
					})?
				},
				None => Routed::Ignored,
			}
		};
		Ok(self.finish_native_input(routed))
	}

	fn finish_native_input(&mut self, routed: Routed) -> NativeEffect {
		match routed {
			Routed::Quit => NativeEffect::Quit,
			Routed::Ignored => NativeEffect::Ignored,
			// A window has no tty to release: the external editor runs in
			// place, suspend and display reset degrade to a repaint.
			Routed::ExternalEditor => {
				let draft = self.presenter.composer.text();
				let editor = self
					.presenter
					.pending_editor
					.take()
					.expect("external-editor route carries a resolved command");
				let result = crate::editor::edit_draft(&editor, &draft, crate::editor::EditorOptions {
					extension: "omp.md",
					..crate::editor::EditorOptions::default()
				});
				self.presenter.finish_external_editor(result);
				self.refresh();
				NativeEffect::Consumed
			},
			Routed::Suspend => {
				self
					.presenter
					.notice("Suspend is only available in terminal chat");
				self.presenter.composer.restore_focus();
				self.refresh();
				NativeEffect::Consumed
			},
			Routed::Repaint | Routed::RebuildProjection | Routed::DisplayReset => {
				self.refresh();
				NativeEffect::Consumed
			},
		}
	}

	/// Executes a console line exactly as a bound key would, applying every
	/// host action it posts.
	pub fn console(&mut self, command: &str) -> Result<NativeEffect, HostError> {
		Ok(match self.presenter.run_console(command)? {
			Routed::Quit => NativeEffect::Quit,
			Routed::Ignored => NativeEffect::Ignored,
			_ => {
				self.refresh();
				NativeEffect::Consumed
			},
		})
	}

	/// Catalog badge currently projected into the welcome/status surfaces.
	#[must_use]
	pub const fn model_badge(&self) -> &ModelBadge {
		&self.presenter.model
	}

	/// Text of the visible transient notice, when one is showing.
	#[must_use]
	pub fn notice(&self) -> Option<&str> {
		self.presenter.overlays.notice()
	}

	/// The scheduled provider retry the countdown loader shows, when any.
	#[must_use]
	pub const fn retrying(&self) -> Option<&RetryState> {
		self.presenter.retrying.as_ref()
	}

	/// The status row above the editor: retry loader, transient notice, or
	/// idle retry hint.
	#[must_use]
	pub fn status_frame(&self) -> Option<Frame> {
		self.presenter.status_frame(self.size.width)
	}

	/// The pinned error banner above the editor, when one is showing.
	#[must_use]
	pub fn banner_frame(&self) -> Option<Frame> {
		self.presenter.banner_frame(self.size.width)
	}

	/// Descriptors of the blocks the view shows, welcome first, including
	/// observer-local blocks and excluding retry-superseded elements.
	#[must_use]
	pub fn blocks(&self) -> Vec<BlockView> {
		self
			.presenter
			.blocks()
			.into_iter()
			.map(|block| block.view)
			.collect()
	}

	/// Desktop toasts decided since the last drain.
	pub fn take_notifications(&mut self) -> Vec<omp_tui::Notification> {
		std::mem::take(&mut self.presenter.notifications)
	}

	/// Whether a key-consuming overlay (picker or approval) is open.
	#[must_use]
	pub fn overlay_open(&self) -> bool {
		self.presenter.overlays.modal()
	}

	/// Whether the terminal is asked to report mouse input: any stacked
	/// overlay or composer completion popup takes pointer reports.
	#[must_use]
	pub fn mouse_tracking(&self) -> bool {
		self.presenter.overlays.pointer() || self.presenter.composer.popup_open()
	}

	/// Owned projection of the open picker or panel, when one is showing.
	///
	/// Terminal and native actors resolve the same anchor, composer margin,
	/// width, z-order, and keyboard ownership through one placement path.
	pub const fn picker_overlay(&self) -> Option<&NativeOverlay> {
		self.overlay.as_ref()
	}

	/// Frame of the open picker or panel, when one is showing.
	pub fn picker_frame(&self) -> Option<Frame> {
		self.overlay.as_ref().map(|overlay| overlay.frame.clone())
	}

	/// Viewport band the open picker or panel is composited into — the
	/// cells whose pointer reports [`NativeHost::mouse`] routes to it.
	pub fn picker_band(&mut self) -> Option<omp_tui::OverlayBand> {
		self.presenter.overlay_band(self.size).map(|(band, _)| band)
	}

	/// Identity of the topmost overlay, when one is open.
	#[must_use]
	pub fn overlay_id(&self) -> Option<&'static str> {
		self.presenter.overlays.active().map(Overlay::id)
	}

	/// Number of stacked overlays.
	#[must_use]
	pub fn overlay_depth(&self) -> usize {
		self.presenter.overlays.depth()
	}

	/// Current unsent draft.
	#[must_use]
	pub fn composer_text(&self) -> String {
		self.presenter.composer.text()
	}

	/// Caret position inside the retained composer frame.
	#[must_use]
	pub fn composer_cursor(&mut self) -> Option<(u16, u16)> {
		self.presenter.composer.frame().cursor()
	}

	/// Native spelling gates the composer's editor currently applies
	/// (`cl_spelling_*`).
	#[must_use]
	pub const fn spelling_features(&self) -> SpellingFeatures {
		self.presenter.composer.spelling_features()
	}

	/// Subagent the view is focused on, when any.
	#[must_use]
	pub fn focused_agent(&self) -> Option<&str> {
		self.presenter.focused_agent.as_deref()
	}

	/// Whether push-to-talk is recording.
	#[must_use]
	pub const fn recording(&self) -> bool {
		self.presenter.stt_recording
	}

	/// Whether the view believes a turn (or local run) is in flight.
	#[must_use]
	pub const fn turn_active(&self) -> bool {
		self.presenter.turn_active
	}

	/// Ids of the registered Esc hooks.
	#[must_use]
	pub fn escape_hooks(&self) -> Vec<Str> {
		self
			.presenter
			.escape_hooks
			.iter()
			.map(|hook| hook.id.clone())
			.collect()
	}

	/// Text the last key asked to copy, if any (drained).
	pub fn take_clipboard(&mut self) -> Option<Str> {
		self.presenter.clipboard.take()
	}

	/// Clipboard read the last key asked for, if any (drained).
	pub fn take_clipboard_read(&mut self) -> Option<ClipboardRead> {
		self.presenter.clipboard_read.take()
	}

	/// Delivers a finished clipboard read exactly as the terminal loop would.
	pub fn deliver_clipboard(&mut self, outcome: ClipboardReadOutcome, raw: bool) -> NativeEffect {
		let routed = match self.presenter.deliver_clipboard(outcome, raw) {
			Ok(routed) => routed,
			Err(error) => self.presenter.notice(error.to_string()),
		};
		self.native_effect(routed)
	}

	/// Delivers a finished clipboard write exactly as the terminal loop would.
	pub fn deliver_clipboard_write(&mut self, outcome: ClipboardWriteOutcome) -> NativeEffect {
		let routed = self.presenter.deliver_clipboard_write(outcome);
		self.native_effect(routed)
	}

	/// Applies one host action directly (what a posted mailbox action does).
	pub fn act(&mut self, action: HostAction) -> Result<NativeEffect, HostError> {
		let routed = self.presenter.act(action)?;
		Ok(self.native_effect(routed))
	}

	/// Advances the presentation clock to `now` (gesture and countdown
	/// timers); returns whether anything repainted.
	pub fn tick(&mut self, now: Duration) -> bool {
		let changed = self.presenter.poll_account_usage(now)
			| self.presenter.refresh_wall_clock(now)
			| self.presenter.sync_status()
			| self.presenter.composer.tick(now)
			| self.presenter.tick_overlay(now).unwrap_or(true)
			| self.presenter.tick_space_hold(now);
		if changed {
			self.refresh();
		}
		changed
	}

	/// Presentation-clock epoch, for driving [`NativeHost::tick`].
	#[must_use]
	pub const fn clock(&self) -> Instant {
		self.presenter.clock
	}

	fn native_effect(&mut self, routed: Routed) -> NativeEffect {
		match routed {
			Routed::Quit => NativeEffect::Quit,
			Routed::Ignored => NativeEffect::Ignored,
			_ => {
				self.refresh();
				NativeEffect::Consumed
			},
		}
	}

	/// Routes clipboard text through the active picker/panel before the
	/// composer, matching bracketed-paste ordering in the terminal host.
	pub fn paste(&mut self, text: &str) -> NativeEffect {
		let routed = match self.presenter.route_paste(text) {
			Ok(routed) => routed,
			Err(error) => self.presenter.notice(error.to_string()),
		};
		self.native_effect(routed)
	}

	/// Returns the current document frame.
	#[must_use]
	pub const fn frame(&self) -> &Frame {
		&self.frame
	}

	/// Returns the current approval layer, when controller policy is blocked.
	#[must_use]
	pub const fn approval_frame(&self) -> Option<&Frame> {
		self.approval_frame.as_ref()
	}

	/// Returns the number of document-tail rows owned by the composer.
	#[must_use]
	pub const fn editor_rows(&self) -> u16 {
		self.presenter.composer.height()
	}

	fn refresh(&mut self) {
		self.presenter.sync_status();
		self.presenter.viewport_height = self.size.height;
		let components = self
			.presenter
			.blocks()
			.into_iter()
			.map(|block| block.component)
			.collect::<Vec<_>>();
		let tree = omp_tui::dom! { <col gap=1>{components}</col> };
		let transcript = Ui::from_root(tree, self.size.width, self.presenter.ui.clone());
		let rows = transcript.frame().size().height;
		//  status container sits between the transcript and the editor
		// band in every actor: the retry countdown loader, the transient
		// notice, or the idle `<key> to Retry` hint after an aborted tool tail.
		let status = self.presenter.status_frame(self.size.width);
		let status_rows = status.as_ref().map_or(0, |frame| frame.size().height);
		let chrome = self.presenter.chrome_frame(self.size.width);
		let height = rows
			.saturating_add(status_rows)
			.saturating_add(chrome.size().height);
		let mut frame = Frame::new(Size::new(self.size.width, height));
		frame.blit(transcript.frame(), 0, rows, 0, 0);
		if let Some(status) = &status {
			frame.blit(status, 0, status_rows, 0, rows);
		}
		frame.blit(&chrome, 0, chrome.size().height, 0, rows.saturating_add(status_rows));
		self.frame = frame;
		self.approval_frame = self.presenter.approval_frame(self.size.width);
		let composer_rows = self.presenter.composer.height();
		let size = self.size;
		self.overlay = self.presenter.overlay_frame(size).map(|(frame, anchor)| {
			let (options, active) = overlay_options(anchor, size.width, composer_rows);
			NativeOverlay { frame, options, active }
		});
		self.status_deadline = [self.presenter.retry_wake(), self.presenter.wall_clock.next_wake()]
			.into_iter()
			.flatten()
			.min();
		self.space_hold_deadline = self.presenter.space_hold.next_wake();
	}
}

impl Drop for NativeHost {
	fn drop(&mut self) {
		let _ = self.presenter.up.send(Up::Cancel);
		let _ = self.presenter.commands.send(HostCommand::Quit);
	}
}

/// Sleeps until `deadline` on the presentation clock whose epoch is `clock`.
async fn frame_deadline(clock: Instant, deadline: Option<Duration>) {
	match deadline {
		Some(deadline) => tokio::time::sleep_until((clock + deadline).into()).await,
		None => future::pending().await,
	}
}

/// Next git watch delivery; pends forever outside a checkout or once the
/// watcher has stopped.
async fn recv_git(facts: Option<&Receiver<GitFacts>>) -> GitFacts {
	match facts {
		Some(facts) => match facts.recv_async().await {
			Ok(facts) => facts,
			Err(_) => future::pending().await,
		},
		None => future::pending().await,
	}
}

/// The `<ask status=running>` element of the last turn, when the tool is
/// blocked on the user.
fn waiting_ask(dom: &Dom) -> Option<Handle> {
	let turn = crate::notices::retry::last_turn(dom)?;
	dom.children(turn).iter().rev().copied().find(|handle| {
		dom.get(*handle).is_some_and(|node| {
			node.tag == Tag::Custom(Str::new_static("ask"))
				&& node.prop(&PropId::Status.into()).and_then(Value::as_str) == Some("running")
		})
	})
}

/// The questions journaled in an `<ask>` element's `<input>`.
fn ask_questions(dom: &Dom, ask: Handle) -> Option<Vec<omp_tools::ask::Question>> {
	let args = dom
		.children(ask)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.find(|node| node.tag == Tag::Known(KnownTag::Input))
		.and_then(|input| input.content.as_deref())?;
	omp_tool::decode_params::<omp_tools::ask::Params>(args)
		.ok()
		.map(|params| params.questions)
		.filter(|questions| !questions.is_empty())
}

/// Visible text of the newest assistant message in the last turn, for the
/// `yield` speech mode's one-shot utterance.
fn last_assistant_text(dom: &Dom) -> Option<Str> {
	let turn = crate::notices::retry::last_turn(dom)?;
	let (handle, node) = dom.children(turn).iter().rev().find_map(|handle| {
		let node = dom.get(*handle)?;
		(node.tag == Tag::Known(KnownTag::Assistant)).then_some((*handle, node))
	})?;
	let mut text = omp_core::StrMut::new("");
	for part in crate::project::assistant_parts(dom, handle, node) {
		if let crate::project::AssistantPart::Text { text: part, .. } = part {
			text.push_str(&part);
		}
	}
	(!text.is_empty()).then(|| text.freeze())
}

/// Project root for `@` file completion: the session cwd projected into
/// the prompt facts, when the kernel has published one.
fn project_root(dom: &Dom) -> Option<PathBuf> {
	let session = StatusLine::from_dom(dom).session;
	(!session.is_empty()).then(|| PathBuf::from(session.as_str()))
}

/// Derives the composer status facts from the replica, the launch badge, and
/// the observer-local facts. `active_time` is the union of processing windows;
/// `working` is the in-flight turn's start on the presentation clock;
/// `focused` is the subagent the view shows.
fn status_facts(
	dom: &Dom,
	badge: &ModelBadge,
	local: &LocalFacts,
	wall_time: Option<&Str>,
	active_time: Duration,
	working: Option<Duration>,
	focused: Option<&str>,
	collab: Option<CollabStatus>,
	account_usage: Option<&crate::status_band::AccountUsage>,
	con: &Ctx,
	statuses: &ExtensionStatuses,
) -> StatusFacts {
	let status = StatusLine::from_dom(dom);
	// A live `ai_model` pick shows before its first turn journals it.
	let route = local.model.as_deref().unwrap_or(status.model.as_str());
	let model = if route.is_empty() || route == badge.identifier {
		badge.short_name()
	} else {
		ModelBadge::from_identifier(route).short_name()
	};
	let home = (!status.home.is_empty()).then_some(status.home.as_str());
	let path = display_path(status.session.as_str(), home, local.tmp.as_deref());
	let jobs = crate::overlays::hub::job_rows(dom);
	let subagents = jobs
		.iter()
		.filter(|job| job.status == "running" && job.kind == "subagent")
		.count()
		.try_into()
		.unwrap_or(u32::MAX);
	let background_jobs = jobs
		.iter()
		.filter(|job| job.status == "running" && job.kind != "subagent")
		.count()
		.try_into()
		.unwrap_or(u32::MAX);
	let session_id = dom
		.get(dom.meta())
		.and_then(|meta| meta.prop(&PropId::Id.into()))
		.and_then(Value::as_str)
		.filter(|id| !id.is_empty())
		.map(Str::new);
	let hostname = env::var("HOSTNAME")
		.ok()
		.filter(|name| !name.is_empty())
		.map(Str::new);
	// Both chips project the `<meta><directors>` subtree, so a headless
	// render and the first frame show the same band as the live loop.
	let mode = director_mode(dom).and_then(|mode| {
		(!matches!(mode, ModeChip::Goal(_)) || CL_GOAL_STATUS_IN_FOOTER.get(con)).then_some(mode)
	});
	let mut facts = StatusFacts {
		model,
		mode,
		thinking: local.thinking.clone(),
		compact_thinking: local.compact_thinking,
		fast: local.fast,
		advisor: advisor_badge(dom),
		cwd: path.text,
		raw_cwd: (!status.session.is_empty()).then(|| status.session.clone()),
		home: (!status.home.is_empty()).then(|| status.home.clone()),
		scratch: path.scratch,
		path_url: (!status.session.is_empty())
			.then(|| crate::cards::file_link(status.session.as_str())),
		branch: local.branch.clone(),
		git_status: local.git_status,
		pull_request: local.pull_request.clone(),
		worktree: local.worktree.clone(),
		collab: None,
		hook_status: statuses
			.visible(CL_STATUS_LINE_SHOW_HOOK_STATUS.get(con))
			.to_vec(),
		subagents,
		background_jobs,
		session_id,
		hostname,
		wall_time: wall_time.cloned(),
		session_name: status.name,
		appearance: local.status_appearance.clone(),
		tokens: status.context,
		context_window: badge.context_window,
		compact_percent: local.compact,
		speculation: local.speculation,
		speculation_percent: None,
		tokens_in: status.tokens_in,
		tokens_out: status.tokens_out,
		cache_read: status.cache_read,
		cache_write: status.cache_write,
		tokens_per_second: status.tokens_per_second,
		cost_nano_usd: status.cost_nano_usd,
		subscription: local.subscription,
		advisor_cost_nano_usd: status
			.advisor
			.as_ref()
			.map_or(0, |advisor| advisor.cost_nano_usd),
		advisor_subscription: local.advisor_subscription,
		account_usage: account_usage.cloned(),
		active_time,
		premium_requests_millionths: status.premium_requests_millionths,
		working,
		focused_agent: focused.map(Str::new),
	};
	facts.apply_collab(collab);
	facts
}

fn status_appearance(con: &Ctx, previous: &StatusAppearance) -> StatusAppearance {
	let preset = match CL_STATUS_LINE_PRESET.get(con).as_str() {
		"minimal" => StatusPreset::Minimal,
		"compact" => StatusPreset::Compact,
		"full" => StatusPreset::Full,
		"nerd" => StatusPreset::Nerd,
		"ascii" => StatusPreset::Ascii,
		"custom" => StatusPreset::Custom,
		_ => StatusPreset::Default,
	};
	let left = CL_STATUS_LINE_LEFT_SEGMENTS.get(con);
	let left_segments = status_segments(&left, &previous.left_segments);
	let right = CL_STATUS_LINE_RIGHT_SEGMENTS.get(con);
	let right_segments = status_segments(&right, &previous.right_segments);
	let segment_options = StatusSegmentOptions::from_kv(&CL_STATUS_LINE_SEGMENT_OPTIONS.get(con))
		.unwrap_or(previous.segment_options);

	StatusAppearance {
		preset,
		separator: match CL_STATUS_LINE_SEPARATOR.get(con).as_str() {
			"powerline" => StatusSeparator::Powerline,
			"slash" => StatusSeparator::Slash,
			"pipe" => StatusSeparator::Pipe,
			"block" => StatusSeparator::Block,
			"none" => StatusSeparator::None,
			"ascii" => StatusSeparator::Ascii,
			_ => StatusSeparator::PowerlineThin,
		},
		context_line: match CL_STATUS_LINE_CONTEXT_LINE.get(con).as_str() {
			"off" => ContextLine::Off,
			"percentage" => ContextLine::Percentage,
			"annotated" => ContextLine::Annotated,
			_ => ContextLine::Embedded,
		},
		transparent: CL_STATUS_LINE_TRANSPARENT.get(con),
		left_segments,
		right_segments,
		segment_options,
	}
}

/// Parses one custom group without replacing its shared allocation when a
/// live convar refresh resolves to the same ordered segment sequence.
fn status_segments(values: &[Str], previous: &Arc<[StatusSegment]>) -> Arc<[StatusSegment]> {
	if values
		.iter()
		.filter_map(|segment| segment.parse::<StatusSegment>().ok())
		.eq(previous.iter().copied())
	{
		return Arc::clone(previous);
	}
	values
		.iter()
		.filter_map(|segment| segment.parse::<StatusSegment>().ok())
		.collect::<Vec<_>>()
		.into()
}

fn apply_status_preview(appearance: &mut StatusAppearance, convar: &str, value: &str) {
	match convar {
		"cl_status_line_preset" => {
			appearance.preset = match value {
				"minimal" => StatusPreset::Minimal,
				"compact" => StatusPreset::Compact,
				"full" => StatusPreset::Full,
				"nerd" => StatusPreset::Nerd,
				"ascii" => StatusPreset::Ascii,
				"custom" => StatusPreset::Custom,
				_ => StatusPreset::Default,
			};
		},
		"cl_status_line_separator" => {
			appearance.separator = match value {
				"powerline" => StatusSeparator::Powerline,
				"slash" => StatusSeparator::Slash,
				"pipe" => StatusSeparator::Pipe,
				"block" => StatusSeparator::Block,
				"none" => StatusSeparator::None,
				"ascii" => StatusSeparator::Ascii,
				_ => StatusSeparator::PowerlineThin,
			};
		},
		"cl_status_line_context_line" => {
			appearance.context_line = match value {
				"off" => ContextLine::Off,
				"percentage" => ContextLine::Percentage,
				"annotated" => ContextLine::Annotated,
				_ => ContextLine::Embedded,
			};
		},
		_ => {},
	}
}

fn composer_style(value: &str) -> ComposerStyle {
	match value {
		"box" => ComposerStyle::Box,
		"claude" => ComposerStyle::Claude,
		"pi" => ComposerStyle::Pi,
		"rule" => ComposerStyle::Rule,
		"field" => ComposerStyle::Field,
		"rail" => ComposerStyle::Rail,
		"band" | "borderless" => ComposerStyle::Borderless,
		_ => ComposerStyle::default(),
	}
}

/// Whether the kernel is still working on the last turn, decided by the
/// newest lifecycle element in it. Only terminal error/interrupt notices
/// close the turn; informational notices are transparent. An open assistant or
/// a running tool keeps it active; a settled tool defers to its assistant,
/// whose `tool_calls` stop means another inference follows; `<usage>` is
/// per-inference accounting and closes nothing; a turn with only the user's
/// message is awaiting its first inference; a local run (a turn holding
/// only its tool element) is over once that element settles.
fn has_active_turn(dom: &Dom) -> bool {
	let Some(turn) = dom.children(dom.body()).last() else {
		return false;
	};
	for child in dom.children(*turn).iter().rev() {
		let Some(node) = dom.get(*child) else {
			continue;
		};
		match node.tag {
			Tag::Known(KnownTag::Notice) => {
				let kind = node.prop(&PropId::Kind.into()).and_then(Value::as_str);
				let interrupted = matches!(kind, Some("warn" | "warning"))
					&& node.content.as_deref().is_some_and(|text| {
						text.starts_with("Turn interrupted") || text.starts_with("Interrupted")
					});
				if matches!(kind, Some("error" | "interrupt" | "interrupted")) || interrupted {
					return false;
				}
			},
			Tag::Known(KnownTag::User) => return true,
			Tag::Known(KnownTag::Assistant) => {
				return node
					.prop(&PropId::StopReason.into())
					.and_then(Value::as_str)
					.is_none_or(|reason| reason == "tool_calls");
			},
			Tag::Custom(_) => {
				if !tool_settled(node) {
					return true;
				}
			},
			_ => {},
		}
	}
	false
}

fn tool_settled(node: &omp_dom::Node) -> bool {
	node
		.prop(&PropId::Status.into())
		.and_then(Value::as_str)
		.is_some_and(|status| matches!(status, "ok" | "error" | "cancelled" | "aborted"))
}

/// Identity of the newest active host-run `!`/`$` command. These are
/// two independent runners (`session.isBashRunning` / `isEvalRunning`), so a
/// busy shell rejects only another shell line and a busy evaluator rejects
/// only another evaluator line.
fn active_local_run(dom: &Dom) -> Option<PrefixMode> {
	let turn = dom.children(dom.body()).last()?;
	let mut children = dom
		.children(*turn)
		.iter()
		.filter_map(|handle| dom.get(*handle));
	let first = children.next()?;
	if !matches!(first.tag, Tag::Custom(_))
		|| first
			.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_PRESENTATION_PROP)))
			.and_then(Value::as_str)
			!= Some(omp_agent::LOCAL_PRESENTATION_VALUE)
		|| tool_settled(first)
	{
		return None;
	}
	match first
		.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_KIND_PROP)))
		.and_then(Value::as_str)
	{
		Some("bash") => Some(PrefixMode::Bash),
		Some("eval") => Some(PrefixMode::Eval),
		_ => None,
	}
}

fn local_run_active(dom: &Dom, mode: PrefixMode) -> bool {
	active_local_run(dom) == Some(mode)
}

fn approval_frame(
	approval: &crate::overlays::ApprovalOverlay,
	countdown: Option<u64>,
	width: u16,
	ui: &UiContext,
) -> Frame {
	let title = approval.title.clone();
	let reason = approval.reason.clone();
	let scope = Str::new(approval.scope.as_str());
	// `CountdownTimer`: the modal shows `(Ns remaining)` ticking once a
	// second until the kernel answers with the prompt's default.
	let remaining =
		countdown.map_or_else(Str::default, |seconds| Str::new(format!("  ({seconds}s remaining)")));
	let tree = omp_tui::dom! {
		<box border=round bc=warning pad="1 2">
			<col gap=1>
				<row>
					<text fg=warning attr=bold>{title}</text>
					<text fg=muted>{remaining}</text>
				</row>
				<md>{reason}</md>
				<text fg=muted>{"Scope: "}{scope}</text>
				<row gap=1>
					<text fg=accent attr=bold>{"y"}</text>
					<text>{"approve"}</text>
					<text fg=accent attr=bold>{"a"}</text>
					<text>{"approve for session"}</text>
					<text fg=error attr=bold>{"n"}</text>
					<text>{"deny"}</text>
				</row>
			</col>
		</box>
	};
	Ui::from_root(tree, width, ui.clone()).frame().clone()
}

/// Renders the interactive surface headlessly at `size`: the document a
/// terminal host would paint from `snapshot` before any input (the chrome
/// golden test's entry point).
#[must_use]
pub fn render_surface(
	snapshot: &Snapshot,
	model: &ModelBadge,
	local: &LocalFacts,
	size: Size,
	ui: &UiContext,
) -> Frame {
	let replica = Dom::from_snapshot(snapshot);
	let working = has_active_turn(&replica).then_some(Duration::ZERO);
	let con = Ctx::new();
	let statuses = ExtensionStatuses::default();
	let facts = status_facts(
		&replica,
		model,
		local,
		None,
		Duration::ZERO,
		working,
		None,
		None,
		None,
		&con,
		&statuses,
	);
	let plan = facts.mode == Some(ModeChip::Plan);
	let mut composer = Composer::new(
		size.width,
		ui.clone(),
		facts,
		Vec::new(),
		Arc::new(|_: &str, _: &str| None),
		None,
	);
	let _ = composer.set_plan_mode(plan);
	let status = StatusLine::from_dom(&replica);
	let welcome = || RenderedBlock {
		view:      BlockView {
			key:       0,
			kind:      BlockKind::Welcome,
			text:      Str::new_static("welcome"),
			mode:      Mode::Mutable,
			finalized: true,
		},
		component: Box::new(Welcome::new(
			Str::new_static(env!("CARGO_PKG_VERSION")),
			model,
			tip_seeded(welcome_seed(status.session.as_str()), ui.charset),
			WelcomeFacts::default(),
			None,
		)),
		stream:    None,
	};
	let cards = CardRegistry::standard();
	let transcript = crate::transcript::Local::default();
	let options = crate::project::Options::new(&transcript);
	let mut blocks = vec![welcome()];
	blocks.extend(project(&replica, &cards, ui, &options));
	let mut mirror = vec![welcome()];
	mirror.extend(project(&replica, &cards, ui, &options));
	let projection =
		Projection::new(size, ResizePolicy::Rebuild, ui, blocks, mirror, Duration::ZERO);
	projection.document(composer.frame(), size)
}

/// Compositing options of the focused overlay layer and whether it takes
/// the keyboard: pickers replace the composer band and swap the editor
/// slot; dialogs center at 80% width; dashboards cover the viewport; side
/// panels sit above the still-live composer of `composer_rows`. One
/// resolver feeds both presentation and pointer translation so a click
/// lands on the row it was painted on.
fn overlay_options(anchor: PanelAnchor, width: u16, composer_rows: u16) -> (OverlayOptions, bool) {
	match anchor {
		PanelAnchor::Center => (
			OverlayOptions::default()
				.width(Dim::Pct(80))
				.anchor(OverlayAnchor::Center)
				.z(20),
			true,
		),
		PanelAnchor::Full => (
			OverlayOptions::default()
				.width(Dim::Cells(width))
				.anchor(OverlayAnchor::TopLeft)
				.z(20),
			true,
		),
		PanelAnchor::BottomCenter => (
			OverlayOptions::default()
				.width(Dim::Cells(width))
				.max_height(Dim::Pct(100))
				.anchor(OverlayAnchor::Bottom)
				.z(20),
			true,
		),
		PanelAnchor::Side => (
			OverlayOptions::default()
				.width(Dim::Cells(width))
				.anchor(OverlayAnchor::BottomLeft)
				.margin(omp_tui::OverlayMargin { bottom: composer_rows, ..Default::default() })
				.non_modal()
				.z(20),
			false,
		),
		PanelAnchor::Bottom => (
			OverlayOptions::default()
				.width(Dim::Cells(width))
				.anchor(OverlayAnchor::BottomLeft)
				.z(20),
			true,
		),
	}
}

#[cfg(test)]
mod terminal_title_tests {
	use super::*;

	fn meta_set(meta: Handle, prop: PropId) -> Event {
		Event::Patch(omp_dom::Patch {
			cause: EntryId::default(),
			prior: None,
			label: None,
			ops:   vec![Op::Set {
				h:     meta,
				prop:  prop.into(),
				value: Value::Str(Str::new_static("changed")),
			}],
		})
	}

	#[test]
	fn terminal_restore_failure_is_typed_even_after_an_event_loop_failure() {
		let run = Err(HostError::Io(io::Error::other("input failed")));
		let restore = Err(io::Error::other("restore failed"));
		let error = finish_terminal_epoch(run, restore).expect_err("restore must win");
		assert!(matches!(error, HostError::TerminalRestore { .. }));
		assert!(error.to_string().contains("restore failed"));
	}

	#[cfg(unix)]
	#[test]
	fn suspend_targets_the_foreground_group_with_uncatchable_sigstop() {
		let mut delivered = None;
		suspend_process_with(|pid, signal| {
			delivered = Some((pid.as_raw(), signal));
			Ok(())
		})
		.expect("signal accepted");
		assert_eq!(delivered, Some((0, nix::sys::signal::Signal::SIGSTOP)));

		let error = suspend_process_with(|_, _| Err(nix::errno::Errno::EPERM))
			.expect_err("signal refusal remains typed");
		assert!(matches!(error, SuspendError::Signal { source: nix::errno::Errno::EPERM }));
	}

	#[test]
	fn only_session_identity_events_clear_an_extension_title() {
		let dom = Dom::new();
		let meta = dom.meta();
		assert!(
			!Presenter::sets_session_title(&meta_set(meta, PropId::Model), meta),
			"ordinary model/status facts are not authoritative terminal titles",
		);
		assert!(
			Presenter::sets_session_title(&meta_set(meta, PropId::Name), meta),
			"a session rename is authoritative",
		);
		assert!(
			Presenter::sets_session_title(&Event::Reset { snapshot: dom.snapshot() }, meta),
			"a session switch is authoritative",
		);
	}
}
