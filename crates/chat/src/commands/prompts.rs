//! Prompt templates as slash commands: every discovered template is a dynamic
//! console command named after it, so `/review fix the tests` in the composer,
//! a bound key, and a cfg line all run the same statement. The handler expands
//! the template with the statement's words and posts the text as a
//! [`CommandAction::Prompt`], which the host submits exactly like a typed
//! prompt.
//!
//! Discovery and substitution live with the application (the driver's
//! `discovery::prompts`); this module owns only the console seam, reached
//! through the one typed [`PromptExpander`] the application installs.

use std::sync::Arc;

use omp_con::{Arg, ConError, ConResult, Ctx, DynamicCmdSpec, Severity};
use omp_core::Str;

use super::CommandAction;

/// The application's prompt-template table, as the console sees it.
pub trait PromptExpander: Send + Sync + 'static {
	/// `(name, description)` rows in registration order.
	fn templates(&self) -> Vec<(Str, Str)>;

	/// Expands template `name` with the statement's words (`$1`,
	/// `$ARGUMENTS`, …); `None` when no template carries that name.
	fn expand(&self, name: &str, args: &[Str]) -> Option<Str>;
}

/// Expands the discovered `/skill:<name>` command roster.
pub trait SkillExpander: Send + Sync + 'static {
	/// `(name, description)` rows without the `skill:` command prefix.
	fn skills(&self) -> Vec<(Str, Str)>;

	/// Builds the typed, exact model-facing invocation.
	fn expand_skill(&self, name: &str, args: &[Str]) -> Option<omp_journal::data::SkillPrompt>;
}

/// The installed template expander, stored on the console as host data.
struct Installed(Arc<dyn PromptExpander>);

/// The installed skill expander.
struct InstalledSkills(Arc<dyn SkillExpander>);

/// Registers every template as a dynamic console command and installs
/// `expander` as the table those commands expand from. Returns the names
/// that could not be registered because a built-in command already owns
/// them.
pub fn register(ctx: &Ctx, expander: Arc<dyn PromptExpander>) -> Vec<Str> {
	let mut reserved = Vec::new();
	for (name, desc) in expander.templates() {
		match ctx.register_dynamic_cmd(DynamicCmdSpec { name: name.clone(), desc, handler: run }) {
			Ok(()) => {},
			Err(ConError::Duplicate { .. }) => reserved.push(name),
			Err(error) => {
				ctx.reply(
					Severity::Warn,
					&format!("prompt template `{name}` was not registered: {error}"),
				);
			},
		}
	}
	ctx.insert_user(Installed(expander));
	reserved
}

/// Registers admitted skills as `/skill:<name>` commands.
pub fn register_skills(ctx: &Ctx, expander: Arc<dyn SkillExpander>) -> Vec<Str> {
	let mut reserved = Vec::new();
	for (name, desc) in expander.skills() {
		let command = Str::new(format!("skill:{name}"));
		match ctx.register_dynamic_cmd(DynamicCmdSpec {
			name: command.clone(),
			desc,
			handler: run_skill,
		}) {
			Ok(()) => {},
			Err(ConError::Duplicate { .. }) => reserved.push(command),
			Err(error) => {
				ctx.reply(
					Severity::Warn,
					&format!("skill command `{command}` was not registered: {error}"),
				);
			},
		}
	}
	ctx.insert_user(InstalledSkills(expander));
	reserved
}

/// Shared handler for every prompt-template command.
fn words(args: &[Arg]) -> Vec<Str> {
	args
		.iter()
		.map(|arg| match arg {
			Arg::Atom(word) => word.clone(),
			other => other.to_script(),
		})
		.collect()
}

fn run(ctx: &Ctx, name: &str, args: &[Arg]) -> ConResult<()> {
	let Some(installed) = ctx.user::<Installed>() else {
		ctx.reply(Severity::Warn, "prompt templates are not installed on this console");
		return Ok(());
	};
	let words = words(args);
	match installed.0.expand(name, &words) {
		Some(text) => super::post(ctx, CommandAction::Prompt { text }),
		None => {
			ctx.reply(Severity::Warn, &format!("unknown prompt template `{name}`"));
			Ok(())
		},
	}
}

fn run_skill(ctx: &Ctx, command: &str, args: &[Arg]) -> ConResult<()> {
	let Some(installed) = ctx.user::<InstalledSkills>() else {
		ctx.reply(Severity::Warn, "skills are not installed on this console");
		return Ok(());
	};
	let Some(name) = command.strip_prefix("skill:") else {
		return Ok(());
	};
	match installed.0.expand_skill(name, &words(args)) {
		Some(prompt) => super::post(ctx, CommandAction::SkillPrompt { prompt }),
		None => {
			ctx.reply(Severity::Warn, &format!("unknown skill `{name}`"));
			Ok(())
		},
	}
}

#[cfg(test)]
mod tests {
	use omp_con::Ctx;

	use super::*;
	use crate::actions::{HostAction, HostMailbox};

	struct Table;

	impl PromptExpander for Table {
		fn templates(&self) -> Vec<(Str, Str)> {
			vec![
				(Str::new_static("review"), Str::new_static("Review a file (project)")),
				(Str::new_static("help"), Str::new_static("collides with the console builtin")),
			]
		}

		fn expand(&self, name: &str, args: &[Str]) -> Option<Str> {
			(name == "review").then(|| {
				let mut text = String::from("Review ");
				text.push_str(args.first().map_or("", Str::as_str));
				text.push_str(" carefully: ");
				text.push_str(&args.join(" "));
				Str::new(text)
			})
		}
	}

	impl SkillExpander for Table {
		fn skills(&self) -> Vec<(Str, Str)> {
			vec![(Str::new_static("review"), Str::new_static("Review with a skill"))]
		}

		fn expand_skill(&self, name: &str, args: &[Str]) -> Option<omp_journal::data::SkillPrompt> {
			(name == "review").then(|| omp_journal::data::SkillPrompt {
				name:        Str::new_static("review"),
				args:        Some(Str::new(args.join(" "))),
				path:        Str::new_static("/skills/review/SKILL.md"),
				prompt_body: Str::new_static("exact expanded prompt"),
				line_count:  3,
			})
		}
	}

	#[test]
	fn template_command_expands_words_and_posts_a_prompt() {
		let ctx = HostMailbox::new().attach(Ctx::builder()).build();
		let reserved = register(&ctx, Arc::new(Table));
		assert_eq!(reserved, [Str::new_static("help")], "builtin names stay reserved");
		assert!(ctx.dynamic_cmds().any(|(name, _)| name == "review"));

		ctx.run("review src/lib.rs \"the tests\"").unwrap();
		let mailbox = ctx.user::<HostMailbox>().expect("attached mailbox");
		let posted = mailbox
			.drain()
			.find_map(|action| match action {
				HostAction::Command(CommandAction::Prompt { text }) => Some(text),
				_ => None,
			})
			.expect("a posted prompt");
		assert_eq!(posted, "Review src/lib.rs carefully: src/lib.rs the tests");
	}

	#[test]
	fn skill_command_posts_typed_source_and_exact_prompt() {
		let ctx = HostMailbox::new().attach(Ctx::builder()).build();
		assert!(register_skills(&ctx, Arc::new(Table)).is_empty());

		ctx.run("skill:review src/lib.rs").unwrap();
		let mailbox = ctx.user::<HostMailbox>().expect("attached mailbox");
		let prompt = mailbox
			.drain()
			.find_map(|action| match action {
				HostAction::Command(CommandAction::SkillPrompt { prompt }) => Some(prompt),
				_ => None,
			})
			.expect("a typed skill prompt");
		assert_eq!(prompt.name, "review");
		assert_eq!(prompt.path, "/skills/review/SKILL.md");
		assert_eq!(prompt.args.as_deref(), Some("src/lib.rs"));
		assert_eq!(prompt.prompt_body, "exact expanded prompt");
	}
}
