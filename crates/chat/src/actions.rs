//! Host actions: console commands the interactive actor executes locally.
//!
//! ADR 0014: keybindings are `bind <chord> "<command>"` lines over the one
//! command stream, never an action-id schema. Every configured keybinding
//! therefore maps to a `cl_*` console command declared here. A bound key,
//! a `/`-prefixed composer line, and a cfg script all run the same words;
//! the command posts a [`HostAction`] into the actor's one console mailbox
//! ([`HostMailbox`]), which the actor drains after each `exec`.
//!
//! Commands only *ask*; presentation state stays observer-local (ADR 0005)
//! and never enters the session DOM.

use std::{fmt, sync::Arc};

use flume::{Receiver, Sender};
use omp_con::{ConResult, Ctx, CtxBuilder, Severity};
use omp_core::Str;

use crate::{
	commands::CommandAction,
	extension_status::ExtensionStatus,
	overlays::{PanelCall, PanelOpener},
};

/// Which rung of the Escape ladder an [`EscapeHook`] answers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscapeRung {
	/// Rung 1 (`/mcp test`): every registered hook fires on one Esc and is
	/// removed, so the next Esc reaches the rungs below.
	Cancel,
	/// Rung 4 (vocalizer): persistent; consumes Esc only while it reports
	/// something to silence.
	Silence,
}

/// An observer-local Esc handler registered by a command (`/mcp test`
/// cancellation, vocalizer silence). Compared by identity.
#[derive(Clone)]
pub struct EscapeHook {
	/// Stable identity; re-registering an id replaces the prior hook.
	pub id:   Str,
	/// Ladder rung.
	pub rung: EscapeRung,
	hook:     Arc<dyn Fn() -> bool + Send + Sync>,
}

impl EscapeHook {
	/// Registers `hook`, which returns whether it consumed the Esc.
	pub fn new(
		id: impl Into<Str>,
		rung: EscapeRung,
		hook: impl Fn() -> bool + Send + Sync + 'static,
	) -> Self {
		Self { id: id.into(), rung, hook: Arc::new(hook) }
	}

	/// Fires the hook; returns whether it consumed the Esc.
	#[must_use]
	pub fn fire(&self) -> bool {
		(self.hook)()
	}
}

impl fmt::Debug for EscapeHook {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("EscapeHook")
			.field("id", &self.id)
			.field("rung", &self.rung)
			.finish_non_exhaustive()
	}
}

impl PartialEq for EscapeHook {
	fn eq(&self, other: &Self) -> bool {
		self.id == other.id && self.rung == other.rung && Arc::ptr_eq(&self.hook, &other.hook)
	}
}

impl Eq for EscapeHook {}

/// Stable failure class for local streaming speech recognition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SttFailureKind {
	/// Model catalog, cache, download, or runtime initialization failed.
	Setup,
	/// The microphone lease or native capture device failed.
	Microphone,
	/// Captured audio exceeded the bounded session duration.
	AudioLimit,
	/// The realtime audio producer outran the bounded recognition queue.
	Backpressure,
	/// The local recognizer failed while decoding speech.
	Recognition,
}

/// One typed observer update from the application-owned streaming recognizer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SttUiEvent {
	/// A first-use model download is in progress.
	SetupProgress {
		/// Stable selected model id.
		model:            Str,
		/// Verified or downloaded bytes so far.
		downloaded_bytes: u64,
		/// Total manifest bytes.
		total_bytes:      u64,
	},
	/// The microphone is open and audio is streaming.
	Recording,
	/// Capture ended and queued final segments are being decoded.
	Transcribing,
	/// Volatile text replacing the recognizer's prior preview at the caret.
	Partial(Str),
	/// One finalized segment to commit exactly once at the caret.
	Segment(Str),
	/// The stream ended normally after every finalized segment was delivered.
	Finished {
		/// Whether at least one non-empty segment was recognized.
		had_speech:    bool,
		/// Graphemes to remove from the committed suffix for a spoken submit
		/// trigger.
		trim_trailing: usize,
		/// Whether the resulting composer draft should be submitted.
		submit:        bool,
	},
	/// Capture and recognition were cancelled; volatile text must be discarded.
	Cancelled,
	/// Capture or recognition failed; volatile text must be discarded.
	Failed {
		/// Stable category suitable for presentation and telemetry.
		kind:    SttFailureKind,
		/// Secret-free diagnostic rendered at the actor boundary.
		message: Str,
	},
}

/// One observer-local request posted by a console command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostAction {
	/// `cl_interrupt` (Esc): dismiss the topmost local
	/// surface, else interrupt the active turn, else preserve the draft.
	Interrupt,
	/// `cl_clear` (Ctrl+C): the first press clears the draft
	/// (including an already-empty draft); a repeat within 500 ms exits.
	Clear,
	/// `cl_exit` (Ctrl+D): leave the chat.
	Exit,
	/// `cl_suspend` (Ctrl+Z): job-control suspend.
	Suspend,
	/// `cl_display_reset` (Alt+L): repaint from the
	/// retained document after re-probing the terminal.
	DisplayReset,
	/// `cl_thinking_cycle` (Shift+Tab): step
	/// `ai_thinking` through the current model's catalog efforts.
	ThinkingCycle,
	/// `cl_model_cycle [back]` (Ctrl+P / Ctrl+Shift+P): step `ai_model`
	/// through the role roster.
	ModelCycle {
		/// Step toward the previous role instead of the next.
		backward: bool,
	},
	/// `cl_model_select [session]` (Alt+M / Alt+P): open the model picker.
	ModelSelect {
		/// Only this session: skip archiving the choice to `config.cfg`.
		session_only: bool,
	},
	/// `/model <selector>`: set `ai_model`
	/// to the roster entry matching `selector` by key or display name and
	/// archive it, or notice `Unknown model`.
	ModelSet(Str),
	/// `cl_followup` (Ctrl+Q / Alt+Enter):
	/// queue the draft behind a running turn (it runs when the agent
	/// yields, never as mid-turn steering), else submit it as a turn.
	FollowUp,
	/// `cl_retry` (F5 / Alt+R): resend the last user prompt
	/// when its turn ended in an error notice.
	Retry,
	/// `cl_tools_expand` (Ctrl+O): toggle the
	/// transcript's default tool-card expansion after an active panel has
	/// had first refusal.
	ToolsExpand,
	/// `cl_plan_toggle` (Alt+Shift+P): flip the
	/// plan-mode Director engagement.
	PlanToggle,
	/// `cl_history_search` (Ctrl+R): open the
	/// prompt-history picker.
	HistorySearch,
	/// `cl_editor_external` (Ctrl+G): edit the
	/// draft in `$VISUAL`/`$EDITOR`.
	ExternalEditor,
	/// `cl_dequeue` (Alt+Up / Shift+Up): pull
	/// every queued message back into the composer.
	Dequeue,
	/// `cl_paste_image` (Ctrl+V / Cmd+V):
	/// read the system clipboard, preferring an image, and stage it as a
	/// composer chip.
	PasteImage,
	/// `cl_paste_raw` (Ctrl+Shift+V / Alt+Shift+V): paste clipboard text
	/// verbatim.
	PasteRaw,
	/// `cl_copy_line` (Alt+Shift+L): copy the
	/// current composer line.
	CopyLine,
	/// `cl_copy_prompt` (Alt+Shift+C): copy
	/// the whole draft.
	CopyPrompt,
	/// `cl_agent_focus [id]`: view a subagent (`None` returns to the main
	/// session).
	FocusAgent(Option<Str>),
	/// `cl_collab_guest on|off`: this actor is a collaboration guest, so
	/// Esc asks the remote host to interrupt instead of aborting locally.
	CollabGuest(bool),
	/// Authoritative collaboration role, presence, and guest footer snapshot
	/// published by the collaboration runtime.
	CollabStatus(Option<crate::status_band::CollabStatus>),
	/// `cl_stt_toggle`: start or stop push-to-talk
	/// recording without the space-hold gesture.
	SttToggle,
	/// `cl_live_toggle` (Ctrl+L): start or stop the
	/// duplex live-voice session; the app owns the microphone and transport.
	LiveToggle,
	/// Push-to-talk recording edge from the space-hold gesture.
	PushToTalk {
		/// `true` when recording begins, `false` when the bar is released.
		active: bool,
	},
	/// Observer-only state from the application-owned realtime voice session.
	LiveEvent(crate::overlays::live::LiveUiEvent),
	/// A finalized live user utterance admitted by the application-owned
	/// realtime transport. The actor forwards it to the controller without
	/// touching the composer or transcript; the controller owns journaling.
	LiveDelegation {
		/// Transport request identity used to correlate streamed replies.
		id:      Str,
		/// Final recognized user text.
		request: Str,
	},
	/// Ordered streaming speech-recognition state and editor updates.
	SttEvent(SttUiEvent),
	/// A validated newer official release for the archived update channel.
	/// Presentation-only: it never enters the journal or initiates install.
	UpdateAvailable(crate::notices::update::UpdateAvailable),
	/// Insert, replace, clear, or reset one observer-local extension/hook
	/// status contribution.
	ExtensionStatus(ExtensionStatus),
	/// Give an extension verbatim ownership of the terminal title until the
	/// next authoritative session title.
	ExtensionTitle(Str),
	/// Register (or replace) an observer-local Esc hook.
	EscapeHook(EscapeHook),
	/// Remove an Esc hook by id.
	DropEscapeHook(Str),
	/// Open a command-owned panel on the overlay stack.
	Open(PanelOpener),
	/// Run a command-owned host effect and apply its panel event.
	Call(PanelCall),
	/// A typed slash-command request (`crate::commands`).
	Command(CommandAction),
	/// The controller could not run a submitted `!` / `$` line (for example
	/// while paused): the draft returns to the composer and the optimistic
	/// activity edge rolls back.
	LocalRefused {
		/// The submitted line verbatim.
		draft:  Str,
		/// Why it did not run.
		reason: Str,
	},
	/// A controller-run mutation settled (posted by the application after a
	/// `HostCommand::Git` / `Service` / `Agent`); delivered to every open
	/// panel through `Panel::notify`.
	Outcome(crate::overlays::Outcome),
	/// An editor command (`ed_*`): the
	/// composer applies the named semantic key. Bound chords reach the
	/// composer only through these, so `bind`/`unbind` decide every editor
	/// key (ADR 0014).
	Editor(omp_tui::Key),
	/// A panel command (`panel_*`):
	/// lowered onto the topmost open panel.
	Panel(crate::overlays::PanelAction),
	/// A console reply line (the sink installed by [`HostMailbox::attach`]).
	Reply {
		/// Reply severity.
		severity: Severity,
		/// Reply text.
		text:     Str,
	},
}

/// The actor's one inbound console mailbox: commands post actions, the
/// reply sink posts output lines, and the actor drains both after every
/// `exec`.
pub struct HostMailbox {
	tx: Sender<HostAction>,
	rx: Receiver<HostAction>,
}

impl Default for HostMailbox {
	fn default() -> Self {
		Self::new()
	}
}

impl HostMailbox {
	/// Creates an unbounded mailbox.
	#[must_use]
	pub fn new() -> Self {
		let (tx, rx) = flume::unbounded();
		Self { tx, rx }
	}

	/// Installs this mailbox as the builder's user object and routes the
	/// reply sink into it.
	#[must_use]
	pub fn attach(self, builder: CtxBuilder) -> CtxBuilder {
		let sink = self.tx.clone();
		builder
			.sink(move |severity, text| {
				let _ = sink.send(HostAction::Reply { severity, text: Str::new(text) });
			})
			.user(self)
	}

	/// Installs a fresh mailbox on an already-built context (no reply sink).
	pub fn install(ctx: &Ctx) {
		ctx.insert_user(Self::new());
	}

	/// Posts an action directly, bypassing the command stream.
	pub fn post(&self, action: HostAction) {
		let _ = self.tx.send(action);
	}

	/// Takes every queued action without blocking.
	pub fn drain(&self) -> impl Iterator<Item = HostAction> + '_ {
		self.rx.try_iter()
	}

	/// Waits for the next posted action (app-side results such as a
	/// speech transcript wake the actor through this).
	pub async fn next(&self) -> Option<HostAction> {
		self.rx.recv_async().await.ok()
	}
}

/// Posts `action` into the attached host mailbox, or warns on the console
/// when no interactive host is attached (a cfg script under `omp print`).
pub fn post(ctx: &Ctx, action: HostAction) -> ConResult<()> {
	match ctx.user::<HostMailbox>() {
		Some(mailbox) => {
			mailbox.post(action);
			Ok(())
		},
		None => {
			ctx.reply(Severity::Warn, "no interactive host is attached to this console");
			Ok(())
		},
	}
}

omp_con::var! {
	/// Expands tool cards in the transcript (Ctrl+O).
	pub static CL_TOOLS_EXPANDED = cl_tools_expanded: bool {
		default: false,
		flags: session,
	};
	/// Show model-initiated tool calls and results in the transcript.
	pub static CL_SHOWTOOLS = cl_showtools: bool {
		default: true,
		flags: archive | session,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "Show Tool Activity",
			"legacy.path": "display.hideToolActivity",
		},
	};
}

omp_con::cmd! {
	/// Dismisses the topmost overlay, else interrupts the active turn.
	cl_interrupt() = |ctx, _args| post(ctx, HostAction::Interrupt);

	/// Clears the draft; a repeat within 500 ms exits.
	cl_clear() = |ctx, _args| post(ctx, HostAction::Clear);

	/// Leaves the chat.
	cl_exit() = |ctx, _args| post(ctx, HostAction::Exit);

	/// Suspends the chat to the shell (job control).
	cl_suspend() = |ctx, _args| post(ctx, HostAction::Suspend);

	/// Repaints the terminal from the retained transcript.
	cl_display_reset() = |ctx, _args| post(ctx, HostAction::DisplayReset);

	/// Cycles `ai_thinking` through the current model's reasoning efforts.
	cl_thinking_cycle() = |ctx, _args| post(ctx, HostAction::ThinkingCycle);

	/// Cycles `ai_model` through the role roster; `back` steps backward.
	cl_model_cycle(?direction: Str) = |ctx, args| {
		let backward = args
			.opt::<Str>(0)?
			.is_some_and(|direction| matches!(direction.as_str(), "back" | "backward" | "prev"));
		post(ctx, HostAction::ModelCycle { backward })
	};

	/// Opens the model picker; `session` keeps the choice out of config.cfg.
	cl_model_select(?scope: Str) = |ctx, args| {
		let session_only = args
			.opt::<Str>(0)?
			.is_some_and(|scope| matches!(scope.as_str(), "session" | "temporary" | "temp"));
		post(ctx, HostAction::ModelSelect { session_only })
	};

	/// Queues the draft behind a running turn, else sends it as a new turn.
	cl_followup() = |ctx, _args| post(ctx, HostAction::FollowUp);

	/// Resends the last prompt after a failed turn.
	cl_retry() = |ctx, _args| post(ctx, HostAction::Retry);

	/// Toggles the default expansion of transcript tool cards.
	cl_tools_expand() = |ctx, _args| post(ctx, HostAction::ToolsExpand);

	/// Toggles plan mode.
	cl_plan_toggle() = |ctx, _args| post(ctx, HostAction::PlanToggle);

	/// Searches prompt history.
	cl_history_search() = |ctx, _args| post(ctx, HostAction::HistorySearch);

	/// Edits the draft in the external editor.
	cl_editor_external() = |ctx, _args| post(ctx, HostAction::ExternalEditor);

	/// Restores every queued message to the composer.
	cl_dequeue() = |ctx, _args| post(ctx, HostAction::Dequeue);

	/// Pastes the clipboard, attaching an image as a chip.
	cl_paste_image() = |ctx, _args| post(ctx, HostAction::PasteImage);

	/// Pastes clipboard text verbatim.
	cl_paste_raw() = |ctx, _args| post(ctx, HostAction::PasteRaw);

	/// Copies the current composer line to the clipboard.
	cl_copy_line() = |ctx, _args| post(ctx, HostAction::CopyLine);

	/// Copies the whole draft to the clipboard.
	cl_copy_prompt() = |ctx, _args| post(ctx, HostAction::CopyPrompt);

	/// Views a subagent's session; no id returns to the main session.
	cl_agent_focus(?id: Str) = |ctx, args| {
		let id = args.opt::<Str>(0)?.filter(|id| !id.is_empty());
		post(ctx, HostAction::FocusAgent(id))
	};

	/// Marks this actor as a collaboration guest (`on`) or host (`off`).
	cl_collab_guest(state: Str) = |ctx, args| {
		let state = args.get::<Str>(0)?;
		post(ctx, HostAction::CollabGuest(matches!(state.as_str(), "on" | "1" | "true")))
	};

	/// Starts or stops push-to-talk recording.
	cl_stt_toggle() = |ctx, _args| post(ctx, HostAction::SttToggle);

	/// Starts or stops the duplex live-voice session.
	cl_live_toggle() = |ctx, _args| post(ctx, HostAction::LiveToggle);

	/// Removes an observer-local Esc hook by id.
	cl_escape_unhook(id: Str) = |ctx, args| {
		let id = args.get::<Str>(0)?;
		post(ctx, HostAction::DropEscapeHook(id))
	};
}

omp_con::cmd! {
	/// Moves the focused editor or selector one row up.
	ed_up() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Up));
	/// Moves the focused editor or selector one row down.
	ed_down() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Down));
	/// Moves the editor caret one grapheme left.
	ed_left() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Left));
	/// Moves the editor caret one grapheme right.
	ed_right() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Right));
	/// Moves the editor caret one word left.
	ed_word_left() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::WordLeft));
	/// Moves the editor caret one word right.
	ed_word_right() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::WordRight));
	/// Moves the editor caret to the line start.
	ed_home() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Home));
	/// Moves the editor caret to the line end.
	ed_end() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::End));
	/// Starts a forward character jump.
	ed_jump_forward() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Ctrl(']')));
	/// Starts a backward character jump.
	ed_jump_backward() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::CtrlAlt(']')));
	/// Scrolls the focused editor or selector one page up.
	ed_page_up() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::PageUp));
	/// Scrolls the focused editor or selector one page down.
	ed_page_down() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::PageDown));
	/// Deletes one grapheme before the editor caret.
	ed_backspace() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Backspace));
	/// Deletes one grapheme under the editor caret.
	ed_delete() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Delete));
	/// Deletes one word before the editor caret.
	ed_delete_word_backward() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Ctrl('w')));
	/// Deletes one word after the editor caret.
	ed_delete_word_forward() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::WordDelete));
	/// Deletes from the editor caret to the line start.
	ed_delete_to_start() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Ctrl('u')));
	/// Deletes from the editor caret to the line end.
	ed_delete_to_end() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Ctrl('k')));
	/// Yanks the latest editor kill.
	ed_yank() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Ctrl('y')));
	/// Rotates the editor yank ring.
	ed_yank_pop() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Alt('y')));
	/// Undoes the latest editor change.
	ed_undo() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Ctrl('-')));
	/// Opens spelling suggestions at the editor caret.
	ed_spelling() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Ctrl('.')));
	/// Inserts a newline into the editor.
	ed_newline() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::ShiftEnter));
	/// Activates the focused control or submits the editor.
	ed_enter() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Enter));
	/// Advances autocomplete or focus.
	ed_tab() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Tab));
	/// Copies the editor selection.
	ed_copy() = |ctx, _args| post(ctx, HostAction::Editor(omp_tui::Key::Copy));

	/// Toggles full versus relative paths in the session picker.
	panel_toggle_path() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::TogglePath));
	/// Toggles modified versus created sorting in the session picker.
	panel_toggle_sort() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::ToggleSort));
	/// Starts renaming the selected session.
	panel_rename() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::Rename));
	/// Deletes the selected session after confirmation.
	panel_delete() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::Delete));
	/// Deletes the selected session without an invasive prompt.
	panel_delete_fast() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::DeleteFast));
	/// Folds the selected tree node or moves to its parent.
	panel_fold_up() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::FoldUp));
	/// Unfolds the selected tree node or moves to its first child.
	panel_unfold_down() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::UnfoldDown));
	/// Expands the selected panel entry.
	panel_expand() = |ctx, _args| post(ctx, HostAction::Panel(crate::overlays::PanelAction::Expand));
}

omp_con::var! {
	/// What pressing Escape twice with an empty editor does.
	pub static CL_DOUBLE_ESCAPE = cl_double_escape: Str {
		default: Str::new_static("branch"),
		suggest: ["branch", "tree", "none"],
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Double-Escape Action",
			"ui.option.branch": "Rewind",
			"ui.option.branch.desc": "Open the transcript rewind selector",
			"ui.option.tree": "Tree",
			"ui.option.tree.desc": "Open the session tree",
			"ui.option.none": "None",
			"ui.option.none.desc": "Do nothing",
			"legacy.path": "doubleEscapeAction",
		},
	};
	/// Whether holding the space bar starts push-to-talk.
	pub static CL_STT_HOLD = cl_stt_hold: bool {
		default: true,
		flags: archive,
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bound_command_posts_into_the_installed_mailbox() {
		let ctx = HostMailbox::new().attach(Ctx::builder()).build();
		ctx.run("cl_model_select session; cl_model_cycle back; echo hi")
			.expect("commands run");
		let mailbox = ctx.user::<HostMailbox>().expect("mailbox installed");
		let actions = mailbox.drain().collect::<Vec<_>>();
		assert_eq!(actions, [
			HostAction::ModelSelect { session_only: true },
			HostAction::ModelCycle { backward: true },
			HostAction::Reply { severity: Severity::Info, text: Str::new_static("hi") },
		]);
	}

	#[test]
	fn editor_and_lifecycle_commands_post_typed_host_actions_in_order() {
		let ctx = HostMailbox::new().attach(Ctx::builder()).build();
		ctx.run("ed_newline; ed_enter; cl_clear; cl_exit")
			.expect("commands run");
		let mailbox = ctx.user::<HostMailbox>().expect("mailbox installed");
		assert_eq!(mailbox.drain().collect::<Vec<_>>(), [
			HostAction::Editor(omp_tui::Key::ShiftEnter),
			HostAction::Editor(omp_tui::Key::Enter),
			HostAction::Clear,
			HostAction::Exit,
		]);
	}

	#[test]
	fn host_commands_without_a_mailbox_warn_instead_of_failing() {
		let ctx = Ctx::new();
		ctx.run("cl_interrupt")
			.expect("command degrades to a warning");
	}
}
