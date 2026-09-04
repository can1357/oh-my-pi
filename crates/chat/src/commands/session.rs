//! Session lifecycle slash commands: the journal is the tree, so every one of
//! these is a `Session` create/open/rewind or a `<meta>`/`<queues>` patch
//! performed by the controller, never presentation state.

use omp_con::ConError;
use omp_core::Str;
use omp_journal::EntryId;
use omp_tui::Icon;

use super::{
	CommandAction, CompactionMethod, PaletteEntry, Selector, SessionOp, ShakeMode, TodoOp, post,
	rest,
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "new", icon: Icon::New },
	PaletteEntry { name: "fresh", icon: Icon::Sparkle },
	PaletteEntry { name: "drop", icon: Icon::Trash },
	PaletteEntry { name: "resume", icon: Icon::Session },
	PaletteEntry { name: "branch", icon: Icon::Rewind },
	PaletteEntry { name: "rewind", icon: Icon::Rewind },
	PaletteEntry { name: "fork", icon: Icon::Fork },
	PaletteEntry { name: "tree", icon: Icon::Branch },
	PaletteEntry { name: "rename", icon: Icon::Tag },
	PaletteEntry { name: "session", icon: Icon::Session },
	PaletteEntry { name: "jobs", icon: Icon::Task },
	PaletteEntry { name: "todo", icon: Icon::Todo },
	PaletteEntry { name: "btw", icon: Icon::Question },
	PaletteEntry { name: "tan", icon: Icon::Rocket },
	PaletteEntry { name: "omfg", icon: Icon::Warning },
	PaletteEntry { name: "queue", icon: Icon::List },
	PaletteEntry { name: "compact", icon: Icon::Camera },
	PaletteEntry { name: "shake", icon: Icon::Scissors },
	PaletteEntry { name: "handoff", icon: Icon::Handoff },
];

/// The TS implementation has `/compact` mode words; OMP has one local summary
/// path, so a mode word is accepted and the remainder is the focus.
const COMPACT_MODES: [&str; 3] = ["soft", "remote", "snapcompact"];

/// Parses a journal entry id argument (`/fork 01J…`).
fn entry_id(text: &str) -> Result<EntryId, ConError> {
	text
		.parse::<EntryId>()
		.map_err(|_| ConError::Usage(Str::new(format!("`{text}` is not a journal entry id"))))
}

fn usage(message: &'static str) -> ConError {
	ConError::Usage(Str::new_static(message))
}

/// Splits `/compact [mode] [focus]` into its focus.
pub fn compact_focus(words: Option<Str>) -> Result<Option<Str>, ConError> {
	let Some(words) = words else {
		return Ok(None);
	};
	let text = words.as_str().trim();
	let (first, remainder) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(first, remainder)| (first, remainder.trim_start()));
	if COMPACT_MODES.contains(&first) {
		if first == "snapcompact" && !remainder.is_empty() {
			return Err(usage(
				"/compact snapcompact does not take focus instructions (it archives history without \
				 an LLM summary).",
			));
		}
		return Ok((!remainder.is_empty()).then(|| Str::new(remainder)));
	}
	Ok((!text.is_empty()).then(|| Str::new(text)))
}

/// Parses `/shake [mode]`; empty defaults to `elide`.
pub fn shake_mode(words: Option<Str>) -> Result<ShakeMode, ConError> {
	let Some(words) = words else {
		return Ok(ShakeMode::Elide);
	};
	let verb = words.as_str().trim().to_lowercase();
	verb.parse::<ShakeMode>().map_err(|_| {
		ConError::Usage(Str::new(format!(
			"Unknown /shake mode \"{verb}\". Use elide, images, or thinking."
		)))
	})
}

/// Parses `/session [info|delete|pin [account]]`.
pub fn session_op(words: Option<Str>) -> Result<SessionOp, ConError> {
	let Some(words) = words else {
		return Ok(SessionOp::Info);
	};
	let text = words.as_str().trim();
	let (verb, rest) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(verb, rest)| (verb, rest.trim()));
	match verb {
		"" | "info" => Ok(SessionOp::Info),
		"delete" => Ok(SessionOp::Delete),
		"pin" => Ok(SessionOp::Pin((!rest.is_empty()).then(|| Str::new(rest)))),
		_ => Err(usage("Usage: /session [info|delete|pin [account]]")),
	}
}

/// Parses `/todo [subcommand] [args]`.
pub fn todo_op(words: Option<Str>) -> Result<TodoOp, ConError> {
	let Some(words) = words else {
		return Ok(TodoOp::List);
	};
	let text = words.as_str().trim();
	let (verb, rest) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(verb, rest)| (verb, rest.trim()));
	let optional = || (!rest.is_empty()).then(|| Str::new(rest));
	let required = |what: &'static str| {
		(!rest.is_empty())
			.then(|| Str::new(rest))
			.ok_or_else(|| ConError::Usage(Str::new(format!("Usage: /todo {verb} <{what}>"))))
	};
	Ok(match verb {
		"" => TodoOp::List,
		"append" | "add" => TodoOp::Append(required("task")?),
		"start" => TodoOp::Start(required("task")?),
		"done" => TodoOp::Done(optional()),
		"drop" => TodoOp::Drop(optional()),
		"rm" | "remove" => TodoOp::Remove(optional()),
		"copy" => TodoOp::Copy,
		"export" => TodoOp::Export(optional()),
		"import" => TodoOp::Import(optional()),
		_ => {
			return Err(usage("Usage: /todo [append|start|done|drop|rm|copy|export|import] [args]"));
		},
	})
}

omp_con::cmd! {
	/// Starts a new session.
	new() = |ctx, _args| post(ctx, CommandAction::New);

	/// Starts a fresh provider session without touching the transcript.
	fresh() = |ctx, _args| post(ctx, CommandAction::Fresh);

	/// Deletes the current session file from disk and starts a new one.
	drop() = |ctx, _args| post(ctx, CommandAction::Drop);

	/// Resumes a stored session by id or path; `@claude`/`@codex` opens the
	/// foreign import picker, and no argument opens the native picker.
	resume(?session: Str) = |ctx, args| {
		post(ctx, CommandAction::Resume { id: args.opt::<Str>(0)? })
	};

	/// Opens the rewind selector to roll the session back to an earlier turn.
	branch() = |ctx, _args| post(ctx, CommandAction::Select(Selector::Tree));

	/// Opens the rewind selector (alias of `branch`); `rewind <entry> [text]` rewinds directly.
	rewind(?entry: Str, ?text: Str) = |ctx, args| match args.opt::<Str>(0)? {
		Some(entry) => post(ctx, CommandAction::Rewind {
			target: entry_id(entry.as_str())?,
			recall: rest(args, 1),
		}),
		None => post(ctx, CommandAction::Select(Selector::Tree)),
	};

	/// Renames a stored session in the index (session picker Ctrl+R).
	session_rename(id: Str, title: Str) = |ctx, args| {
		let title = rest(args, 1).ok_or_else(|| usage("Usage: session_rename <id> <title>"))?;
		post(ctx, CommandAction::SessionRename { id: args.get::<Str>(0)?, title })
	};

	/// Deletes a stored session file (session picker Ctrl+D).
	session_delete(id: Str) = |ctx, args| {
		post(ctx, CommandAction::SessionDelete { id: args.get::<Str>(0)? })
	};

	/// Forks a new session file from the current head (or a given entry).
	fork(?entry: Str) = |ctx, args| {
		let target = match args.opt::<Str>(0)? {
			Some(entry) => Some(entry_id(entry.as_str())?),
			None => None,
		};
		post(ctx, CommandAction::Fork { target })
	};

	/// Opens the session branch tree explorer.
	tree() = |ctx, _args| post(ctx, CommandAction::Select(Selector::Tree));

	/// Renames the session: `/rename <title>`.
	rename(title: Str) = |ctx, args| {
		let title = rest(args, 0).ok_or_else(|| usage("Usage: /rename <title>"))?;
		post(ctx, CommandAction::Rename { title })
	};

	/// Shows session info, or `delete` / `pin [account]`.
	session(?op: Str, ?account: Str) = |ctx, args| {
		post(ctx, CommandAction::Session(session_op(rest(args, 0))?))
	};

	/// Lists running subagents and detached tool jobs.
	jobs() = |ctx, _args| post(ctx, CommandAction::Jobs);

	/// Edits the checklist: `append`, `start`, `done`, `drop`, `rm`, `copy`, `export`, `import`.
	todo(?op: Str, ?args: Str) = |ctx, args| {
		post(ctx, CommandAction::Todo(todo_op(rest(args, 0))?))
	};

	/// Asks a quick side question without touching the conversation.
	btw(question: Str) = |ctx, args| {
		let question = rest(args, 0).ok_or_else(|| usage("Usage: /btw <question>"))?;
		post(ctx, CommandAction::Btw { question })
	};

	/// Runs a tangential task on a background agent.
	tan(work: Str) = |ctx, args| {
		let task = rest(args, 0).ok_or_else(|| usage("Usage: /tan <work>"))?;
		post(ctx, CommandAction::Tan { task })
	};

	/// Turns a complaint about recurring behavior into an enforced rule.
	omfg(complaint: Str) = |ctx, args| {
		let rule = rest(args, 0).ok_or_else(|| usage("Usage: /omfg <complaint>"))?;
		post(ctx, CommandAction::Omfg { rule })
	};

	/// Queues a message to send when the agent yields.
	queue(message: Str) = |ctx, args| {
		let prompt = rest(args, 0)
			.ok_or_else(|| usage("Usage: /queue <message> (or start a prompt with -> / =>)"))?;
		post(ctx, CommandAction::Queue { prompt })
	};

	/// Compacts the context now: `/compact [soft|remote|snapcompact] [focus]`.
	compact(?mode: Str, ?focus: Str) = |ctx, args| {
		let focus = compact_focus(rest(args, 0))?;
		post(ctx, CommandAction::Compact { method: CompactionMethod::Compact, focus })
	};

	/// Drops recoverable heavy content in place: `/shake [elide|images|thinking]`.
	shake(?mode: Str) = |ctx, args| {
		let mode = shake_mode(rest(args, 0))?;
		post(ctx, CommandAction::Compact {
			method: CompactionMethod::Shake,
			focus:  Some(Str::new(mode.to_string())),
		})
	};

	/// Writes a handoff document and continues from it: `/handoff [focus]`.
	handoff(?focus: Str) = |ctx, args| {
		post(ctx, CommandAction::Compact { method: CompactionMethod::Handoff, focus: rest(args, 0) })
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn compact_words_split_a_known_mode_from_the_focus() {
		assert_eq!(compact_focus(None).unwrap(), None);
		assert_eq!(
			compact_focus(Some(Str::new_static("soft keep the API notes"))).unwrap(),
			Some(Str::new_static("keep the API notes"))
		);
		assert_eq!(compact_focus(Some(Str::new_static("remote"))).unwrap(), None);
		assert_eq!(
			compact_focus(Some(Str::new_static("keep the API notes"))).unwrap(),
			Some(Str::new_static("keep the API notes"))
		);
		assert!(compact_focus(Some(Str::new_static("snapcompact focus"))).is_err());
	}

	#[test]
	fn shake_defaults_to_elide_and_rejects_unknown_modes() {
		assert_eq!(shake_mode(None).unwrap(), ShakeMode::Elide);
		assert_eq!(shake_mode(Some(Str::new_static("Images"))).unwrap(), ShakeMode::Images);
		assert_eq!(
			shake_mode(Some(Str::new_static("bogus")))
				.unwrap_err()
				.to_string(),
			"Unknown /shake mode \"bogus\". Use elide, images, or thinking."
		);
	}

	#[test]
	fn todo_words_dispatch_and_require_task_text_where_pi_does() {
		assert_eq!(todo_op(None).unwrap(), TodoOp::List);
		assert_eq!(
			todo_op(Some(Str::new_static("append write tests"))).unwrap(),
			TodoOp::Append(Str::new_static("write tests"))
		);
		assert_eq!(todo_op(Some(Str::new_static("done"))).unwrap(), TodoOp::Done(None));
		assert!(todo_op(Some(Str::new_static("append"))).is_err());
		assert!(todo_op(Some(Str::new_static("bogus"))).is_err());
	}

	#[test]
	fn session_words_dispatch() {
		assert_eq!(session_op(None).unwrap(), SessionOp::Info);
		assert_eq!(session_op(Some(Str::new_static("delete"))).unwrap(), SessionOp::Delete);
		assert_eq!(
			session_op(Some(Str::new_static("pin work"))).unwrap(),
			SessionOp::Pin(Some(Str::new_static("work")))
		);
		assert!(session_op(Some(Str::new_static("bogus"))).is_err());
	}
}
