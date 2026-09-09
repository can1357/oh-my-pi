//! Journal-backed iteration and wall-time loop Director.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::Str;
use omp_dom::{Dom, Node};
use strum::{EnumString, IntoStaticStr};

use crate::director::{
	BindValue, Director, DirectorCx, DirectorEffect, Slot, TurnView, Verdict, state_int, state_str,
};

const CLAIMS: &[Slot] = &[Slot::Loop];

#[derive(Clone, Copy, Debug, Default, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case")]
enum LimitKind {
	#[default]
	Unbounded,
	Iterations,
	DurationMs,
}

/// Replays a prompt at yield until an optional iteration or wall-time limit.
pub struct LoopMode {
	prompt:      Str,
	limit_kind:  LimitKind,
	limit:       u64,
	used:        u32,
	deadline_ms: Option<u64>,
}

impl LoopMode {
	/// Creates an unbounded or fixed-iteration engagement.
	#[must_use]
	pub fn new(prompt: impl Into<Str>, count: Option<u32>) -> Self {
		match count {
			Some(count) => Self::iterations(prompt, count),
			None => Self::unbounded(prompt),
		}
	}

	/// Creates an unbounded engagement.
	#[must_use]
	pub fn unbounded(prompt: impl Into<Str>) -> Self {
		Self {
			prompt:      prompt.into(),
			limit_kind:  LimitKind::Unbounded,
			limit:       0,
			used:        0,
			deadline_ms: None,
		}
	}

	/// Creates a fixed-iteration engagement.
	#[must_use]
	pub fn iterations(prompt: impl Into<Str>, count: u32) -> Self {
		Self {
			prompt:      prompt.into(),
			limit_kind:  LimitKind::Iterations,
			limit:       u64::from(count),
			used:        0,
			deadline_ms: None,
		}
	}

	/// Creates a wall-time-bounded engagement.
	#[must_use]
	pub fn duration(prompt: impl Into<Str>, duration_ms: u64) -> Self {
		Self {
			prompt:      prompt.into(),
			limit_kind:  LimitKind::DurationMs,
			limit:       duration_ms,
			used:        0,
			deadline_ms: Some(epoch_millis().saturating_add(duration_ms)),
		}
	}

	/// Reconstructs loop state from its DOM element.
	#[must_use]
	pub fn from_node(node: &Node) -> Self {
		let limit_kind = state_str(node, "limit_kind")
			.and_then(|value| value.parse().ok())
			.unwrap_or_default();
		Self {
			prompt: state_str(node, "prompt").unwrap_or_default(),
			limit_kind,
			limit: state_int(node, "limit")
				.and_then(|value| u64::try_from(value).ok())
				.unwrap_or_default(),
			used: state_int(node, "used")
				.and_then(|value| u32::try_from(value).ok())
				.unwrap_or(0),
			deadline_ms: state_int(node, "deadline_ms").and_then(|value| u64::try_from(value).ok()),
		}
	}
}

impl Director for LoopMode {
	fn id(&self) -> &'static str {
		"loop_mode"
	}

	fn claims(&self) -> &'static [Slot] {
		CLAIMS
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![
			(Str::new_static("prompt"), BindValue::Str(self.prompt.clone())),
			(Str::new_static("limit_kind"), BindValue::Str(Str::new_static(self.limit_kind.into()))),
			(Str::new_static("limit"), BindValue::Int(i64::try_from(self.limit).unwrap_or(i64::MAX))),
			(Str::new_static("used"), BindValue::Int(i64::from(self.used))),
			(
				Str::new_static("deadline_ms"),
				BindValue::Int(
					self
						.deadline_ms
						.and_then(|value| i64::try_from(value).ok())
						.unwrap_or(-1),
				),
			),
			(
				Str::new_static("remaining_ms"),
				BindValue::Int(
					self
						.deadline_ms
						.map(|deadline| deadline.saturating_sub(epoch_millis()))
						.and_then(|value| i64::try_from(value).ok())
						.unwrap_or(-1),
				),
			),
		]
	}

	fn evaluate(&self, _dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> DirectorEffect {
		let now = epoch_millis();
		let exhausted = match self.limit_kind {
			LimitKind::Unbounded => false,
			LimitKind::Iterations => u64::from(self.used) >= self.limit,
			LimitKind::DurationMs => self.deadline_ms.is_none_or(|deadline| now >= deadline),
		};
		if exhausted {
			return DirectorEffect::new(Verdict::Done);
		}
		let mut effect =
			DirectorEffect::new(Verdict::Continue { reminder: Some(self.prompt.clone()) })
				.with_update("used", BindValue::Int(i64::from(self.used.saturating_add(1))));
		if let Some(deadline) = self.deadline_ms {
			effect = effect.with_update(
				"remaining_ms",
				BindValue::Int(i64::try_from(deadline.saturating_sub(now)).unwrap_or(i64::MAX)),
			);
		}
		effect
	}
}

fn epoch_millis() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}
