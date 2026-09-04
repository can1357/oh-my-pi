//! Director-shaped mode commands: each engages or exits one ADR 0015 Director
//! frame under `<meta><directors>` through the controller.

use omp_con::ConError;
use omp_core::Str;
use omp_tui::Icon;

use super::{CommandAction, GoalOp, LoopLimit, PaletteEntry, post, rest};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "vibe", icon: Icon::Sparkle },
	PaletteEntry { name: "goal", icon: Icon::Goal },
	PaletteEntry { name: "guided-goal", icon: Icon::Goal },
	PaletteEntry { name: "loop", icon: Icon::Loop },
	PaletteEntry { name: "force", icon: Icon::Bolt },
	PaletteEntry { name: "force:", icon: Icon::Bolt },
	PaletteEntry { name: "pause", icon: Icon::Pause },
];

/// Usage text for an invalid loop limit.
pub const LOOP_USAGE: &str =
	"Usage: /loop [count|duration]. Examples: /loop 10, /loop 10m, /loop 10min.";

/// Parses `/loop [count|duration] [prompt]`. Prose starts an unbounded loop; a
/// limit-shaped
/// token that cannot be parsed is a usage error.
pub fn loop_args(words: Option<Str>) -> Result<(Option<LoopLimit>, Option<Str>), ConError> {
	let Some(words) = words else {
		return Ok((None, None));
	};
	let text = words.as_str().trim();
	if text.is_empty() {
		return Ok((None, None));
	}
	let (first, remainder) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(first, remainder)| (first, remainder.trim()));
	let prompt = |rest: &str| (!rest.is_empty()).then(|| Str::new(rest));
	let token = first.to_ascii_lowercase();

	if !limit_shaped(&token) {
		return Ok((None, prompt(text)));
	}

	if token.bytes().all(|byte| byte.is_ascii_digit()) {
		let amount = positive(&token, "Loop count must be a positive integer.")?;
		if !remainder.is_empty() {
			let (unit, rest) = remainder
				.split_once(char::is_whitespace)
				.map_or((remainder, ""), |(unit, rest)| (unit, rest.trim()));
			if let Some(unit_ms) = time_unit_ms(unit) {
				let duration = amount
					.checked_mul(unit_ms)
					.ok_or_else(|| usage("Loop duration must be positive."))?;
				return Ok((Some(LoopLimit::DurationMs(duration)), prompt(rest)));
			}
		}
		let iterations =
			u32::try_from(amount).map_err(|_| usage("Loop count must be a positive integer."))?;
		return Ok((Some(LoopLimit::Iterations(iterations)), prompt(remainder)));
	}

	if token.bytes().all(|byte| byte.is_ascii_alphanumeric())
		&& token.bytes().any(|byte| byte.is_ascii_alphabetic())
	{
		return Ok((Some(LoopLimit::DurationMs(compound_duration_ms(&token)?)), prompt(remainder)));
	}

	Err(usage(LOOP_USAGE))
}

fn limit_shaped(token: &str) -> bool {
	let mut bytes = token.bytes();
	match bytes.next() {
		Some(b'+' | b'-') => bytes.next().is_some_and(|byte| byte.is_ascii_digit()),
		Some(byte) => byte.is_ascii_digit(),
		None => false,
	}
}

fn positive(text: &str, message: &'static str) -> Result<u64, ConError> {
	text
		.parse::<u64>()
		.ok()
		.filter(|value| *value > 0)
		.ok_or_else(|| usage(message))
}

fn time_unit_ms(unit: &str) -> Option<u64> {
	match unit.to_ascii_lowercase().as_str() {
		"s" | "sec" | "secs" | "second" | "seconds" => Some(1_000),
		"m" | "min" | "mins" | "minute" | "minutes" => Some(60_000),
		"h" | "hr" | "hrs" | "hour" | "hours" => Some(3_600_000),
		_ => None,
	}
}

fn compound_duration_ms(token: &str) -> Result<u64, ConError> {
	let bytes = token.as_bytes();
	let mut at = 0;
	let mut total = 0_u64;
	while at < bytes.len() {
		let amount_start = at;
		while at < bytes.len() && bytes[at].is_ascii_digit() {
			at += 1;
		}
		if amount_start == at {
			return Err(usage(LOOP_USAGE));
		}
		let unit_start = at;
		while at < bytes.len() && bytes[at].is_ascii_alphabetic() {
			at += 1;
		}
		if unit_start == at {
			return Err(usage(LOOP_USAGE));
		}
		let amount = positive(&token[amount_start..unit_start], "Loop duration must be positive.")?;
		let unit = &token[unit_start..at];
		let unit_ms = time_unit_ms(unit)
			.ok_or_else(|| usage("Loop duration unit must be seconds, minutes, or hours."))?;
		total = total
			.checked_add(
				amount
					.checked_mul(unit_ms)
					.ok_or_else(|| usage("Loop duration must be positive."))?,
			)
			.ok_or_else(|| usage("Loop duration must be positive."))?;
	}
	if total == 0 {
		return Err(usage("Loop duration must be positive."));
	}
	Ok(total)
}

/// Parses `/goal …` words into one [`GoalOp`].
pub fn goal_op(words: Option<Str>) -> Result<GoalOp, ConError> {
	let Some(words) = words else {
		return Ok(GoalOp::Menu);
	};
	let text = words.as_str().trim();
	let (verb, rest) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(verb, rest)| (verb, rest.trim()));
	Ok(match verb {
		"set" => {
			if rest.is_empty() {
				GoalOp::Menu
			} else {
				GoalOp::Set(Str::new(rest))
			}
		},
		"show" => GoalOp::Show,
		"pause" => GoalOp::Pause,
		"resume" => GoalOp::Resume,
		"drop" => GoalOp::Drop,
		"budget" => match rest {
			"" | "off" => GoalOp::Budget(None),
			number => GoalOp::Budget(Some(
				number
					.parse::<u64>()
					.ok()
					.filter(|value| *value > 0)
					.ok_or_else(|| usage("Goal budget must be a positive integer or `off`."))?,
			)),
		},
		_ => GoalOp::Set(Str::new(text)),
	})
}

fn usage(message: &'static str) -> ConError {
	ConError::Usage(Str::new_static(message))
}

omp_con::cmd! {
	/// Toggles vibe mode: you direct worker sessions; a prompt is submitted once on.
	vibe(?prompt: Str) = |ctx, args| post(ctx, CommandAction::Vibe { prompt: rest(args, 0) });

	/// Manages the goal: `set <objective>`, `show`, `pause`, `resume`, `drop`, `budget <N|off>`.
	goal(?op: Str, ?args: Str) = |ctx, args| {
		post(ctx, CommandAction::Goal(goal_op(rest(args, 0))?))
	};

	/// Interviews you step by step, then creates the goal.
	"guided-goal"(?objective: Str) = |ctx, args| {
		post(ctx, CommandAction::GuidedGoal { initial: rest(args, 0) })
	};

	/// Repeats the prompt after each turn: `/loop [count|duration] [prompt]`; again to disable.
	"loop"(?limit: Str, ?prompt: Str) = |ctx, args| {
		let (limit, prompt) = loop_args(rest(args, 0))?;
		post(ctx, CommandAction::Loop { limit, prompt })
	};

	/// Forces the next turn to call the named tool: `/force <tool> [prompt]`.
	force(tool @ "sv::tool": Str, ?prompt: Str) = |ctx, args| {
		post(ctx, CommandAction::Force { tool: args.get::<Str>(0)?, prompt: rest(args, 1) })
	};

	/// Alias of `/force`, preserving the terse `/force:<tool>` palette path.
	"force:"(tool @ "sv::tool": Str, ?prompt: Str) = |ctx, args| {
		post(ctx, CommandAction::Force { tool: args.get::<Str>(0)?, prompt: rest(args, 1) })
	};

	/// Pauses every agent at its next step until you resume.
	pause() = |ctx, _args| post(ctx, CommandAction::Pause);

	/// Releases the pause gate (posted by the pause screen with the hold length).
	pause_resume(?held_ms: i64) = |ctx, args| {
		let held_ms = args.opt::<i64>(0)?.unwrap_or(0).max(0).unsigned_abs();
		post(ctx, CommandAction::PauseResume { held_ms })
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn loop_arguments_split_a_leading_count_from_the_prompt() {
		assert_eq!(loop_args(None).unwrap(), (None, None));
		assert_eq!(
			loop_args(Some(Str::new_static("5"))).unwrap(),
			(Some(LoopLimit::Iterations(5)), None)
		);
		assert_eq!(
			loop_args(Some(Str::new_static("5 run the tests"))).unwrap(),
			(Some(LoopLimit::Iterations(5)), Some(Str::new_static("run the tests")))
		);
		assert_eq!(
			loop_args(Some(Str::new_static("run the tests"))).unwrap(),
			(None, Some(Str::new_static("run the tests")))
		);
		assert!(loop_args(Some(Str::new_static("0"))).is_err());
		assert_eq!(
			loop_args(Some(Str::new_static("10m fix"))).unwrap(),
			(Some(LoopLimit::DurationMs(600_000)), Some(Str::new_static("fix")))
		);
		assert_eq!(
			loop_args(Some(Str::new_static("1h30m keep going"))).unwrap(),
			(Some(LoopLimit::DurationMs(5_400_000)), Some(Str::new_static("keep going")))
		);
		assert_eq!(
			loop_args(Some(Str::new_static("10 minutes fix"))).unwrap(),
			(Some(LoopLimit::DurationMs(600_000)), Some(Str::new_static("fix")))
		);
		assert!(loop_args(Some(Str::new_static("10fortnights"))).is_err());
	}

	#[test]
	fn goal_words_dispatch_to_subcommands_with_a_bare_objective_fallback() {
		assert_eq!(goal_op(None).unwrap(), GoalOp::Menu);
		assert_eq!(goal_op(Some(Str::new_static("show"))).unwrap(), GoalOp::Show);
		assert_eq!(
			goal_op(Some(Str::new_static("set ship it"))).unwrap(),
			GoalOp::Set(Str::new_static("ship it"))
		);
		assert_eq!(
			goal_op(Some(Str::new_static("ship it"))).unwrap(),
			GoalOp::Set(Str::new_static("ship it"))
		);
		assert_eq!(goal_op(Some(Str::new_static("budget off"))).unwrap(), GoalOp::Budget(None));
		assert_eq!(
			goal_op(Some(Str::new_static("budget 5000"))).unwrap(),
			GoalOp::Budget(Some(5000))
		);
		assert!(goal_op(Some(Str::new_static("budget -1"))).is_err());
	}
}
