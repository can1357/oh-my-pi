//! Session lifecycle slash commands: the journal is the tree, so every one of
//! these is a `Session` create/open/rewind or a `<meta>`/`<queues>` patch
//! performed by the controller, never presentation state.

use omp_agent::CompactionStrategy;
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
	PaletteEntry { name: "notices", icon: Icon::Bell },
	PaletteEntry { name: "todo", icon: Icon::Todo },
	PaletteEntry { name: "btw", icon: Icon::Question },
	PaletteEntry { name: "seance", icon: Icon::Ghost },
	PaletteEntry { name: "tan", icon: Icon::Rocket },
	PaletteEntry { name: "omfg", icon: Icon::Warning },
	PaletteEntry { name: "queue", icon: Icon::List },
	PaletteEntry { name: "compact", icon: Icon::Camera },
	PaletteEntry { name: "shake", icon: Icon::Scissors },
	PaletteEntry { name: "handoff", icon: Icon::Handoff },
];

/// The strategy a `/compact` mode word selects. `remote` (provider-side
/// compaction) has no OMP transport, so it runs the soft summary.
fn compact_mode(word: &str) -> Option<CompactionStrategy> {
	if word == "remote" {
		return Some(CompactionStrategy::Soft);
	}
	word.parse().ok()
}

/// Parses a journal entry id argument (`/fork 01J…`).
fn entry_id(text: &str) -> Result<EntryId, ConError> {
	text.parse::<EntryId>().map_err(|_| ConError::Usage {
		usage: Str::new(format!("`{text}` is not a journal entry id")),
	})
}

fn usage(message: &'static str) -> ConError {
	ConError::Usage { usage: Str::new_static(message) }
}

omp_con::var! {
	/// Offer `/seance`, a read-only consult of one finished session.
	pub static CL_SEANCE_ENABLED = cl_seance_enabled: bool {
		default: false,
		flags: archive,
	};
}

/// Usage line for `/seance` when no session selector was given.
pub const SEANCE_USAGE: &str = "Usage: /seance [session id|path] [--model selector]";

/// Parsed `/seance [selector] [--model selector]` words.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SeanceArgs {
	/// Session id or path. Absent input is `None`, which the host prints as
	/// usage.
	pub selector: Option<Str>,
	/// Model override from `--model` or `--model=`.
	pub model:    Option<Str>,
}

/// Parses `/seance` words. Empty input is a missing selector, not an error.
///
/// `--model` may appear once, before or after the selector, as a separate
/// token or as `--model=<selector>`. A second positional, an unknown flag, or
/// a missing model value is an error.
///
/// # Errors
///
/// Returns the user-facing usage or flag message. The caller maps it to
/// [`ConError::Usage`](omp_con::ConError::Usage).
pub fn parse_seance_args(raw: Option<&str>) -> Result<SeanceArgs, Str> {
	let Some(raw) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
		return Ok(SeanceArgs { selector: None, model: None });
	};
	let mut selector = None;
	let mut model = None;
	let mut tokens = raw.split_whitespace();
	while let Some(token) = tokens.next() {
		if let Some(value) = token.strip_prefix("--model=") {
			if value.is_empty() || model.is_some() {
				return Err(model_arg_error(value.is_empty()));
			}
			model = Some(Str::new(value));
		} else if token == "--model" {
			let Some(value) = tokens.next().filter(|value| !value.starts_with('-')) else {
				return Err(Str::new_static("--model needs a selector"));
			};
			if model.is_some() {
				return Err(Str::new_static("--model was given twice"));
			}
			model = Some(Str::new(value));
		} else if token.starts_with('-') {
			return Err(Str::new(format!("unknown /seance flag `{token}`")));
		} else if selector.is_some() {
			return Err(Str::new_static(SEANCE_USAGE));
		} else {
			selector = Some(Str::new(token));
		}
	}
	Ok(SeanceArgs { selector, model })
}

fn model_arg_error(empty: bool) -> Str {
	if empty {
		Str::new_static("--model needs a selector")
	} else {
		Str::new_static("--model was given twice")
	}
}

/// Splits `/compact [soft|remote|snapcompact] [focus]` into the pinned
/// strategy (`None` follows `ai_compaction_strategy`) and the focus.
pub fn compact_args(
	words: Option<Str>,
) -> Result<(Option<CompactionStrategy>, Option<Str>), ConError> {
	let Some(words) = words else {
		return Ok((None, None));
	};
	let text = words.as_str().trim();
	let (first, remainder) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(first, remainder)| (first, remainder.trim_start()));
	if let Some(strategy) = compact_mode(first) {
		if strategy == CompactionStrategy::Snapcompact && !remainder.is_empty() {
			return Err(usage(
				"/compact snapcompact does not take focus instructions (it archives history without \
				 an LLM summary).",
			));
		}
		return Ok((Some(strategy), (!remainder.is_empty()).then(|| Str::new(remainder))));
	}
	Ok((None, (!text.is_empty()).then(|| Str::new(text))))
}

/// Parses `/shake [mode]`; empty defaults to `elide`.
pub fn shake_mode(words: Option<Str>) -> Result<ShakeMode, ConError> {
	let Some(words) = words else {
		return Ok(ShakeMode::Elide);
	};
	let verb = words.as_str().trim().to_lowercase();
	verb.parse::<ShakeMode>().map_err(|_| ConError::Usage {
		usage: Str::new(format!("Unknown /shake mode \"{verb}\". Use elide, images, or thinking.")),
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
			.ok_or_else(|| ConError::Usage {
				usage: Str::new(format!("Usage: /todo {verb} <{what}>")),
			})
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

	/// Resumes a stored session by id or path; `@claude`/`@codex`/`@v1` opens the
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

	/// Lists the status notices chat showed, including ones a burst stacked
	/// under the notice row (`+N more`).
	notices() = |ctx, _args| post(ctx, CommandAction::Notices);

	/// Edits the checklist: `append`, `start`, `done`, `drop`, `rm`, `copy`, `export`, `import`.
	todo(?op: Str, ?args: Str) = |ctx, args| {
		post(ctx, CommandAction::Todo(todo_op(rest(args, 0))?))
	};

	/// Asks a quick side question without touching the conversation.
	btw(question: Str) = |ctx, args| {
		let question = rest(args, 0).ok_or_else(|| usage("Usage: /btw <question>"))?;
		post(ctx, CommandAction::Btw { question })
	};

	/// Consults a finished session read-only, in the side panel.
	seance(?selector: Str) = |ctx, args| {
		if !CL_SEANCE_ENABLED.get(ctx) {
			return Err(usage("/seance is off; set cl_seance_enabled true"));
		}
		let parsed = parse_seance_args(rest(args, 0).as_deref())
			.map_err(|message| ConError::Usage { usage: message })?;
		post(ctx, CommandAction::Seance { selector: parsed.selector, model: parsed.model })
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
		let (strategy, focus) = compact_args(rest(args, 0))?;
		post(ctx, CommandAction::Compact { method: CompactionMethod::Compact(strategy), focus })
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
		assert_eq!(compact_args(None).unwrap(), (None, None));
		assert_eq!(
			compact_args(Some(Str::new_static("soft keep the API notes"))).unwrap(),
			(Some(CompactionStrategy::Soft), Some(Str::new_static("keep the API notes")))
		);
		assert_eq!(
			compact_args(Some(Str::new_static("remote"))).unwrap(),
			(Some(CompactionStrategy::Soft), None)
		);
		assert_eq!(
			compact_args(Some(Str::new_static("snapcompact"))).unwrap(),
			(Some(CompactionStrategy::Snapcompact), None)
		);
		assert_eq!(
			compact_args(Some(Str::new_static("keep the API notes"))).unwrap(),
			(None, Some(Str::new_static("keep the API notes")))
		);
		assert!(compact_args(Some(Str::new_static("snapcompact focus"))).is_err());
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

	#[test]
	fn seance_parse_table() {
		let parsed = |raw: Option<&str>| parse_seance_args(raw).expect("parse");
		assert_eq!(parsed(None), SeanceArgs { selector: None, model: None });
		assert_eq!(parsed(Some("  ")), SeanceArgs { selector: None, model: None });
		assert_eq!(parsed(Some("01JABCDEFGHJKMNPQRSTVWXYZ0")), SeanceArgs {
			selector: Some(Str::new_static("01JABCDEFGHJKMNPQRSTVWXYZ0")),
			model:    None,
		});
		assert_eq!(parsed(Some("01JABCDEFGHJKMNPQRSTVWXYZ0 --model opus")), SeanceArgs {
			selector: Some(Str::new_static("01JABCDEFGHJKMNPQRSTVWXYZ0")),
			model:    Some(Str::new_static("opus")),
		});
		assert_eq!(parsed(Some("--model=opus sessions/old.oms")), SeanceArgs {
			selector: Some(Str::new_static("sessions/old.oms")),
			model:    Some(Str::new_static("opus")),
		});
		assert_eq!(
			parse_seance_args(Some("--model"))
				.expect_err("missing")
				.as_str(),
			"--model needs a selector"
		);
		assert_eq!(
			parse_seance_args(Some("--model="))
				.expect_err("empty")
				.as_str(),
			"--model needs a selector"
		);
		assert_eq!(
			parse_seance_args(Some("--model opus --model haiku"))
				.expect_err("twice")
				.as_str(),
			"--model was given twice"
		);
		assert_eq!(
			parse_seance_args(Some("--model=opus --model=haiku"))
				.expect_err("twice equals")
				.as_str(),
			"--model was given twice"
		);
		assert_eq!(
			parse_seance_args(Some("one two"))
				.expect_err("extra")
				.as_str(),
			SEANCE_USAGE
		);
		assert_eq!(
			parse_seance_args(Some("--continue"))
				.expect_err("flag")
				.as_str(),
			"unknown /seance flag `--continue`"
		);
	}

	#[test]
	fn seance_is_offered_only_when_the_convar_is_on() {
		let con = std::sync::Arc::new(omp_con::CtxBuilder::default().build());
		let offered = || {
			crate::autocomplete::slash::roster(&con)
				.iter()
				.any(|command| command.name() == "seance")
		};
		assert!(!offered(), "seance is hidden while cl_seance_enabled is false");
		let off = con
			.exec("seance 01JABCDEFGHJKMNPQRSTVWXYZ0", omp_con::Source::Console)
			.expect_err("gated");
		assert_eq!(off.to_string(), "/seance is off; set cl_seance_enabled true");
		CL_SEANCE_ENABLED.set(&con, true).expect("enable");
		assert!(offered(), "seance is offered once cl_seance_enabled is true");
		assert_eq!(crate::commands::palette_icon("seance"), Some(Icon::Ghost));
		con.exec("seance", omp_con::Source::Console)
			.expect("a bare /seance posts usage instead of failing closed");
		let bad = con
			.exec("seance --nope", omp_con::Source::Console)
			.expect_err("flag");
		assert_eq!(bad.to_string(), "unknown /seance flag `--nope`");
	}
}
