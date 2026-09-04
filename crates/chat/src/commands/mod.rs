//! Slash-command registry: every `/command` is an `omp_con` `cmd!`
//! declaration (ADR 0014) whose handler posts one typed [`CommandAction`]
//! into the actor's console mailbox ([`HostMailbox`]). A `/name args`
//! composer line, a bound key, and a cfg script all run the same words.
//!
//! Registration is linking: each submodule's `cmd!` block lands in the
//! console registry at link time, and the slash palette
//! ([`crate::autocomplete::slash::roster`]) projects the registry, so a
//! command is visible to the popup the moment it is declared. Palette
//! decoration that the console does not carry (the type-indicator icon)
//! lives in each module's [`PALETTE`](session::PALETTE) table and is folded
//! by [`palette_icon`].
//!
//! Commands only *ask*: the handler parses arguments and posts; the host
//! ([`crate::host`]) applies the request against its replica, opens an
//! observer-local overlay, or forwards a [`crate::HostCommand`] to the
//! application controller, which owns the `Session` (ADR 0005).

use omp_con::{ConResult, Ctx, Severity};
use omp_core::Str;
use omp_journal::EntryId;
use omp_tui::Icon;

use crate::actions::{HostAction, HostMailbox};

/// Provider accounts (`/login`, `/logout`, `/setup`, `/providers`, `/pin`).
pub mod accounts;
/// Agent definitions and the live supervisor (`/agents`, `/hub`,
/// `transcript <id>`).
pub mod agents;
/// Model, lifecycle, and MCP commands (`/model`, `/switch`, `/fast`,
/// `/retry`, `/clear`, `/exit`, `/quit`, `/restart`, `/dump`, `/mcp`).
pub mod control;
/// Dashboards and reports (`/usage`, `/context`, `/hotkeys`, `/changelog`,
/// `/debug`, `/stats`, `/trace`).
pub mod dashboards;
/// Director-shaped modes (`/plan`, `/vibe`, `/goal`, `/loop`).
pub mod directors;
/// Git workbench and transcript copy (`/git`, `/copy`).
pub mod git;
/// Collaboration, lifecycle, and capability toggles (`/export`, `/share`,
/// `/cleanse`, `/security`, `/memory`, `/ssh`, `/browser`, …).
pub mod misc;
/// Plan mode and plan review (`/plan`, `/plan-review`).
pub mod plan;
/// Prompt templates as slash commands (`/<template> [args]`).
pub mod prompts;
/// Host-side application of posted actions.
mod run;
/// Session lifecycle (`/new`, `/resume`, `/rewind`, `/tree`, …).
pub mod session;
/// Settings selector (`/settings`).
pub mod settings;
/// Tools and extensions (`/tools`, `/extensions`, `/plugins`,
/// `/marketplace`, `/reload-plugins`).
pub mod tools;
/// Workspace roots and relocation (`/add-dir`, `/remove-dir`, `/dirs`,
/// `/move`, `/wt`).
pub mod workspace;

pub use run::{VIBE, director_active, director_frame, message_count, todo_markdown};

/// One palette decoration row: the console command name and its icon.
///
/// Description and usage come from the `cmd!` doc comment and argument
/// list; only the icon needs a side table.
#[derive(Clone, Copy, Debug)]
pub struct PaletteEntry {
	/// Console command name, exactly as declared in `cmd!`.
	pub name: &'static str,
	/// Type-indicator icon shown by the popup.
	pub icon: Icon,
}

/// Per-module palette tables, folded by [`palette_icon`]. A new command
/// module appends its own `PALETTE` slice here.
const PALETTES: &[&[PaletteEntry]] = &[
	session::PALETTE,
	plan::PALETTE,
	directors::PALETTE,
	misc::PALETTE,
	dashboards::PALETTE,
	accounts::PALETTE,
	tools::PALETTE,
	agents::PALETTE,
	git::PALETTE,
	control::PALETTE,
	workspace::PALETTE,
	settings::PALETTE,
];

/// Palette icon for a registered command, when one is declared.
#[must_use]
pub fn palette_icon(name: &str) -> Option<Icon> {
	PALETTES
		.iter()
		.flat_map(|entries| entries.iter())
		.find(|entry| entry.name == name)
		.map(|entry| entry.icon)
}

/// Which selector `/branch` (`/rewind`) or `/tree` opens.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Selector {
	/// User turns on the live chain, newest last.
	Rewind,
	/// The whole journal branch DAG.
	Tree,
}

/// How `/compact` and `/handoff` summarize.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompactionMethod {
	/// `/compact`: summarize in place with the active model.
	Compact,
	/// `/handoff`: generate a handoff document and continue from it.
	Handoff,
	/// `/shake`: drop recoverable heavy content in place without an LLM
	/// call; the hint is a [`ShakeMode`] word.
	Shake,
}

/// `/goal` subcommands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GoalOp {
	/// Bare `/goal`: menu when a goal exists, else prompt for an objective.
	Menu,
	/// `set <objective>` (or a bare objective).
	Set(Str),
	/// `show`: objective, status, tokens.
	Show,
	/// `pause`.
	Pause,
	/// `resume`.
	Resume,
	/// `drop`.
	Drop,
	/// `budget <N|off>`.
	Budget(Option<u64>),
}

/// `/session` subcommands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionOp {
	/// `info` (default).
	Info,
	/// `delete`: drop the file and open the picker.
	Delete,
	/// `pin [account]`.
	Pin(Option<Str>),
}

/// `/todo` subcommands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TodoOp {
	/// Bare `/todo`: print the list.
	List,
	/// `append [phase] <task…>`.
	Append(Str),
	/// `start <task>`.
	Start(Str),
	/// `done [task|phase]`.
	Done(Option<Str>),
	/// `drop [task|phase]`.
	Drop(Option<Str>),
	/// `rm [task|phase]`.
	Remove(Option<Str>),
	/// `copy`: todos as Markdown to the clipboard.
	Copy,
	/// `export [path]`.
	Export(Option<Str>),
	/// `import [path]`.
	Import(Option<Str>),
}

/// `/loop` budget.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoopLimit {
	/// Stop after this many loop iterations.
	Iterations(u32),
	/// Stop after this wall-clock duration.
	DurationMs(u64),
}

/// `/shake` modes.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "lowercase")]
pub enum ShakeMode {
	/// Strip tool results and large blocks (default).
	Elide,
	/// Strip image blocks.
	Images,
	/// Drop thinking blocks.
	Thinking,
}

/// Typed request posted by a slash command. The host applies it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandAction {
	/// `/plan [prompt]`: toggle the plan Director; a prompt is submitted
	/// once plan mode is on.
	Plan {
		/// Prompt submitted after engaging.
		prompt: Option<Str>,
	},
	/// `/plan-review`: open the plan review overlay.
	PlanReview,
	/// Plan review verdict (posted by the overlay's `plan_approve` line).
	PlanApprove {
		/// Execution model role from the slider (`default`, `slow`, …).
		role:    Option<Str>,
		/// Compact the context before executing.
		compact: bool,
		/// Keep the full plan-mode context (skip the plan-exit summary).
		keep:    bool,
	},
	/// `/vibe [prompt]`: toggle the vibe Director.
	Vibe {
		/// Prompt submitted after engaging.
		prompt: Option<Str>,
	},
	/// `/goal …`: manage the goal Director.
	Goal(GoalOp),
	/// `/guided-goal [rough objective]`: run the interview prompt.
	GuidedGoal {
		/// Rough objective seeding the interview.
		initial: Option<Str>,
	},
	/// `/loop [count|duration] [prompt]`: toggle the loop Director.
	Loop {
		/// Iteration or wall-clock cap; `None` is unbounded.
		limit:  Option<LoopLimit>,
		/// Prompt re-sent each iteration; `None` records the next prompt.
		prompt: Option<Str>,
	},
	/// `/queue <prompt>`: append to `<queues><prompts>`.
	Queue {
		/// Prompt text run after the active turn.
		prompt: Str,
	},
	/// A prompt-template command (`/<template> args`): submit the expanded text
	/// exactly as a
	/// typed prompt — a turn when idle, steering while one runs.
	Prompt {
		/// The expanded template.
		text: Str,
	},
	/// A discovered `/skill:<name> [args]` invocation with its exact
	/// model-facing prompt and source identity.
	SkillPrompt {
		/// Typed skill invocation journaled by the controller.
		prompt: omp_journal::data::SkillPrompt,
	},
	/// `/force <tool> [prompt]`: push a `ForceTool` Director for the next
	/// inference and optionally submit a prompt.
	Force {
		/// Tool name to force.
		tool:   Str,
		/// Prompt submitted after forcing.
		prompt: Option<Str>,
	},
	/// `/pause`: hold every agent at its next step and show the screen.
	Pause,
	/// Pause screen dismissed after `held_ms` (posted by the screen).
	PauseResume {
		/// How long the hold lasted.
		held_ms: u64,
	},
	/// `/compact [focus]`, `/handoff [focus]`: manual summary paths.
	Compact {
		/// Which summary path to run.
		method: CompactionMethod,
		/// Focus instructions for the summary.
		focus:  Option<Str>,
	},
	/// `/new`: start a brand-new session file.
	New,
	/// `/fresh`: reset provider state without touching the transcript.
	Fresh,
	/// `/drop`: delete the current session file and restart.
	Drop,
	/// `/resume [id]`: switch to a stored session; no id opens the picker.
	Resume {
		/// Session id (journal stem) or path.
		id: Option<Str>,
	},
	/// `/branch`, `/rewind`, `/tree`: open a selector.
	Select(Selector),
	/// `/fork [id]`: branch from the current (or given) entry into a new
	/// session file.
	Fork {
		/// Fork point; `None` forks from the head.
		target: Option<EntryId>,
	},
	/// Rewind the live session to `target` (posted by the rewind selector).
	Rewind {
		/// Entry to make the new head.
		target: EntryId,
		/// Text placed in the composer afterwards from the rewound user message.
		recall: Option<Str>,
	},
	/// Session picker Ctrl+R: rename a stored session in the index.
	SessionRename {
		/// Session id (journal stem).
		id:    Str,
		/// New title.
		title: Str,
	},
	/// Session picker Ctrl+D: delete a stored session file.
	SessionDelete {
		/// Session id (journal stem).
		id: Str,
	},
	/// `/rename <title>`: set the session title.
	Rename {
		/// Human-readable session title.
		title: Str,
	},
	/// `/session [info|delete|pin]`: report or manage session metadata.
	Session(SessionOp),
	/// `/jobs`: list detached jobs and subagents.
	Jobs,
	/// `/todo [subcommand] [args]`: edit the session checklist.
	Todo(TodoOp),
	/// `/btw <question>`: side question answered by a child kernel.
	Btw {
		/// The side question.
		question: Str,
	},
	/// `/tan <task>`: fire-and-forget tangent task on a child kernel.
	Tan {
		/// The tangent task.
		task: Str,
	},
	/// `/omfg <rule>`: emergency steering rule for the active session.
	Omfg {
		/// The rule text.
		rule: Str,
	},
	/// `/clear`: drop the model context in place, keeping the session.
	Clear,
	/// `/move [path]`: open the directory editor or relocate directly.
	Move {
		/// Target directory as typed; `None` opens the autocomplete editor.
		path: Option<Str>,
	},
	/// `/wt [branch]`: fork the checkout into a worktree and move there.
	Worktree {
		/// Branch name; `None` picks `wt/<yyyymmdd-hhmmss>`.
		branch: Option<Str>,
	},
}

/// Posts `action` into the attached host mailbox, or warns on the console
/// when no interactive host is attached (a cfg script under `omp print`).
pub fn post(ctx: &Ctx, action: CommandAction) -> ConResult<()> {
	match ctx.user::<HostMailbox>() {
		Some(mailbox) => {
			mailbox.post(HostAction::Command(action));
			Ok(())
		},
		None => {
			ctx.reply(Severity::Warn, "no interactive host is attached to this console");
			Ok(())
		},
	}
}

/// Joins the declared arguments plus any surplus words back into the one
/// free-text argument commands take (`/queue fix the tests`).
#[must_use]
pub fn rest(args: &omp_con::Args<'_>, from: usize) -> Option<Str> {
	if args.len() <= from {
		return None;
	}
	let text = args.join(from);
	let text = text.as_str().trim();
	(!text.is_empty()).then(|| Str::new(text))
}
