//! Status-line values derived only from the actor's DOM replica.

use std::time::Duration;

use omp_core::Str;
use omp_dom::{Dom, KnownTag, PropId, PropKey, Tag, Value};
use smallvec::SmallVec;

use crate::status_band::{AdvisorBadge, AdvisorHealth, GoalState, LoopLimit, ModeChip};

/// One credential-free serving identity from an advisor receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvisorIdentity {
	/// Concrete serving provider.
	pub provider: Str,
	/// Concrete serving model.
	pub model:    Str,
}

/// Cumulative auxiliary-advisor spend and every serving identity represented
/// by it. Keeping the small identity roster lets a resumed host classify
/// historical subscription spend once without probing accounts during paint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvisorSpend {
	/// Distinct identities which accrued spend, in first-use order.
	pub identities:    SmallVec<AdvisorIdentity, 2>,
	/// Identity which produced the newest advisor receipt.
	pub latest:        AdvisorIdentity,
	/// Advisor-only cumulative spend in nano-US dollars.
	pub cost_nano_usd: u64,
}

/// Observer-visible status values.
#[derive(Clone, Debug, PartialEq)]
pub struct StatusLine {
	/// Last assistant model or model prompt fact.
	pub model: Str,
	/// Session location projected from prompt facts.
	pub session: Str,
	/// Home directory projected from prompt facts, for `~` shortening.
	pub home: Str,
	/// User-facing session title from the `<meta>` `name` prop, when the
	/// session has been named.
	pub name: Option<Str>,
	/// Prompt size of the most recent receipt — uncached input plus the
	/// cache read/write tokens — the live context size (
	/// `calculatePromptTokens`).
	pub context: u64,
	/// Total input tokens across visible turns.
	pub tokens_in: u64,
	/// Total output tokens across visible turns.
	pub tokens_out: u64,
	/// Total prompt-cache tokens read across visible turns.
	pub cache_read: u64,
	/// Total prompt-cache tokens written across visible turns.
	pub cache_write: u64,
	/// Total primary-model spend across visible turns in nano-US dollars.
	pub cost_nano_usd: u64,
	/// Advisor-only spend and serving identity from journaled advisor
	/// receipts.
	pub advisor: Option<AdvisorSpend>,
	/// Total premium-request units billed across visible primary turns at
	/// millionth precision (GitHub Copilot `premium_interactions`;
	/// `usage.premiumRequests`).
	pub premium_requests_millionths: u64,
	/// Output throughput of the most recent receipt (`tokens_out` over
	/// `duration-ms`), when the receipt journals a duration.
	pub tokens_per_second: Option<f32>,
	/// Number of explicit turn elements.
	pub turns: usize,
}

impl StatusLine {
	/// The user-facing session title from the `<meta>` `name` prop alone —
	/// no body scan — for observers that only follow renames (toast titles,
	/// the terminal title).
	#[must_use]
	pub fn name(dom: &Dom) -> Option<Str> {
		dom.get(dom.meta())
			.and_then(|meta| meta.prop(&PropId::Name.into()))
			.and_then(Value::as_str)
			.filter(|title| !title.is_empty())
			.map(Str::new)
	}

	/// The session working directory projected into the prompt facts, when
	/// the kernel has published one — no body scan.
	#[must_use]
	pub fn cwd(dom: &Dom) -> Option<Str> {
		prompt_fact(dom, "cwd", "")
	}

	/// Derives a status line from one materialized tree.
	#[must_use]
	pub fn from_dom(dom: &Dom) -> Self {
		let mut model = prompt_fact(dom, "model", "identifier").unwrap_or_default();
		let session = prompt_fact(dom, "cwd", "").unwrap_or_else(|| Str::new_static("session"));
		let home = prompt_fact(dom, "home", "").unwrap_or_default();
		let name = Self::name(dom);
		let mut context = 0_u64;
		let mut tokens_in = 0_u64;
		let mut tokens_out = 0_u64;
		let mut cache_read = 0_u64;
		let mut cache_write = 0_u64;
		let mut cost_nano_usd = 0_u64;
		let mut advisor: Option<AdvisorSpend> = None;
		let mut premium_requests_millionths = 0_u64;
		let mut tokens_per_second = None;
		let mut turns = 0;
		for turn in dom.children(dom.body()) {
			let Some(node) = dom.get(*turn) else {
				continue;
			};
			if node.tag != Tag::Known(KnownTag::Turn) {
				continue;
			}
			turns += 1;
			for child in dom
				.children(*turn)
				.iter()
				.filter_map(|handle| dom.get(*handle))
			{
				match child.tag {
					Tag::Known(KnownTag::Assistant) => {
						if let Some(value) = child.prop(&PropId::Model.into()).and_then(Value::as_str) {
							model = Str::new(value);
						}
					},
					Tag::Known(KnownTag::Usage) => {
						if child.prop(&PropId::Kind.into()).and_then(Value::as_str) == Some("advisor") {
							let Some(provider) =
								child.prop(&PropId::Provider.into()).and_then(Value::as_str)
							else {
								continue;
							};
							let Some(model) = child.prop(&PropId::Model.into()).and_then(Value::as_str)
							else {
								continue;
							};
							let identity =
								AdvisorIdentity { provider: Str::new(provider), model: Str::new(model) };
							let spend = advisor.get_or_insert_with(|| AdvisorSpend {
								identities:    SmallVec::new(),
								latest:        identity.clone(),
								cost_nano_usd: 0,
							});
							let cost = prop_u64(child, PropId::CostNanoUsd);
							if cost > 0 && !spend.identities.contains(&identity) {
								spend.identities.push(identity.clone());
							}
							spend.latest = identity;
							spend.cost_nano_usd = spend.cost_nano_usd.saturating_add(cost);
							continue;
						}
						let input = prop_u64(child, PropId::TokensIn);
						let read = prop_u64(child, PropId::CacheRead);
						let write = prop_u64(child, PropId::CacheWrite);
						let out = prop_u64(child, PropId::TokensOut);
						context = input.saturating_add(read).saturating_add(write);
						tokens_in = tokens_in.saturating_add(input);
						tokens_out = tokens_out.saturating_add(out);
						cache_read = cache_read.saturating_add(read);
						cache_write = cache_write.saturating_add(write);
						cost_nano_usd =
							cost_nano_usd.saturating_add(prop_u64(child, PropId::CostNanoUsd));
						premium_requests_millionths = premium_requests_millionths
							.saturating_add(prop_u64(child, PropId::PremiumRequests));
						tokens_per_second = throughput(out, prop_u64(child, PropId::DurationMs));
					},
					_ => {},
				}
			}
		}
		Self {
			model,
			session,
			home,
			name,
			context,
			tokens_in,
			tokens_out,
			cache_read,
			cache_write,
			cost_nano_usd,
			advisor,
			premium_requests_millionths,
			tokens_per_second,
			turns,
		}
	}

	/// Builds the compact one-row presentation string on state change.
	#[must_use]
	pub fn text(&self) -> Str {
		Str::new(format!(
			"{} · {} · turn {} · {} in / {} out",
			if self.model.is_empty() {
				"model"
			} else {
				self.model.as_str()
			},
			self.session,
			self.turns,
			self.tokens_in,
			self.tokens_out
		))
	}
}

/// Highest-precedence active workflow in `<meta><directors>`, projected as
/// the semantic status-band chip. Paused frames remain visible; queued and
/// exited frames do not. Precedence follows the `mode` segment.
#[must_use]
pub fn director_mode(dom: &Dom) -> Option<ModeChip> {
	let root = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Directors))
	})?;
	let mut chosen: Option<(u8, &omp_dom::Node, bool)> = None;
	for handle in dom.handles() {
		let Some(node) = dom.get(handle) else {
			continue;
		};
		if node.tag != Tag::Known(KnownTag::Director) || !under(dom, handle, root) {
			continue;
		}
		let status = custom_str(node, "status");
		let paused = status == Some("paused");
		if status != Some("active") && !paused {
			continue;
		}
		let rank = match custom_str(node, "family") {
			Some("plan") => 0,
			Some("prewalk") => 1,
			Some("goal") => 2,
			Some("vibe") => 3,
			Some("loop" | "loop_mode") => 4,
			_ => continue,
		};
		if chosen.is_none_or(|(current, ..)| rank < current) {
			chosen = Some((rank, node, paused));
		}
	}
	let (rank, node, paused) = chosen?;
	Some(match rank {
		0 if paused => ModeChip::PlanPaused,
		0 => ModeChip::Plan,
		1 => ModeChip::Prewalk,
		2 => {
			let state = if custom_bool(node, "state/dropped") {
				GoalState::Dropped
			} else if custom_bool(node, "state/done") {
				GoalState::Complete
			} else if paused {
				GoalState::Paused
			} else {
				match (custom_int(node, "state/token_budget"), custom_int(node, "state/tokens_used")) {
					(Some(budget), Some(used)) if budget >= 0 && used >= budget => {
						GoalState::BudgetLimited
					},
					_ => GoalState::Active,
				}
			};
			ModeChip::Goal(state)
		},
		3 => ModeChip::Vibe,
		4 => {
			let limit = match custom_str(node, "state/limit_kind") {
				Some("iterations") => custom_int(node, "state/limit")
					.and_then(|limit| u64::try_from(limit).ok())
					.map(|initial| {
						let used = custom_int(node, "state/used")
							.and_then(|used| u64::try_from(used).ok())
							.unwrap_or(0);
						LoopLimit::Iterations { remaining: initial.saturating_sub(used), initial }
					}),
				Some("duration_ms") => custom_int(node, "state/remaining_ms")
					.and_then(|remaining| u64::try_from(remaining).ok())
					.map(|remaining| LoopLimit::Duration(Duration::from_millis(remaining))),
				_ => None,
			};
			if paused {
				ModeChip::LoopPaused { limit }
			} else if custom_str(node, "state/prompt")
				.unwrap_or_default()
				.is_empty()
			{
				ModeChip::LoopWaiting { limit }
			} else {
				ModeChip::Loop { limit }
			}
		},
		_ => unreachable!("director ranks are closed above"),
	})
}

/// The advisor roster badge: the engaged
/// `advisor` Director's journaled health and whether it finished reviewing
/// the yielded turn. `None` when no advisor is configured, so the model chip
/// carries no badge.
#[must_use]
pub fn advisor_badge(dom: &Dom) -> Option<AdvisorBadge> {
	let root = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Directors))
	})?;
	let node = dom.handles().find_map(|handle| {
		let node = dom.get(handle)?;
		(node.tag == Tag::Known(KnownTag::Director)
			&& under(dom, handle, root)
			&& custom_str(node, "family") == Some("advisor")
			&& matches!(custom_str(node, "status"), Some("active" | "paused")))
		.then_some(node)
	})?;
	let health = match custom_str(node, "state/status") {
		Some("quota_exhausted") => AdvisorHealth::QuotaExhausted,
		Some("error") => AdvisorHealth::Error,
		Some("paused" | "no_model") => AdvisorHealth::Paused,
		_ => AdvisorHealth::Running,
	};
	Some(AdvisorBadge { health, yielded: custom_bool(node, "state/yielded") })
}

fn under(dom: &Dom, mut handle: omp_dom::Handle, root: omp_dom::Handle) -> bool {
	while let Some(parent) = dom.parent(handle) {
		if parent == root {
			return true;
		}
		handle = parent;
	}
	false
}

fn custom_str<'a>(node: &'a omp_dom::Node, key: &'static str) -> Option<&'a str> {
	node
		.prop(&PropKey::Custom(Str::new_static(key)))
		.and_then(Value::as_str)
}

fn custom_bool(node: &omp_dom::Node, key: &'static str) -> bool {
	matches!(node.prop(&PropKey::Custom(Str::new_static(key))), Some(Value::Bool(true)))
}

fn custom_int(node: &omp_dom::Node, key: &'static str) -> Option<i64> {
	match node.prop(&PropKey::Custom(Str::new_static(key))) {
		Some(Value::Int(value)) => Some(*value),
		_ => None,
	}
}

fn prompt_fact(dom: &Dom, outer: &str, inner: &str) -> Option<Str> {
	let value = dom
		.get(dom.meta())?
		.prop(&omp_dom::PropKey::Custom(Str::new_static("prompt-facts")))?;
	let Value::Json(raw) = value else {
		return None;
	};
	let value: serde_json::Value = serde_json::from_str(raw.get()).ok()?;
	let selected = value.get(outer)?;
	let text = if inner.is_empty() {
		selected.as_str()?
	} else {
		selected.get(inner)?.as_str()?
	};
	Some(Str::new(text))
}

/// Output tokens per second of one receipt; `None` without a journaled
/// duration.
fn throughput(tokens_out: u64, duration_ms: u64) -> Option<f32> {
	(duration_ms > 0).then(|| (tokens_out as f64 * 1_000.0 / duration_ms as f64) as f32)
}

fn prop_u64(node: &omp_dom::Node, prop: PropId) -> u64 {
	match node.prop(&prop.into()) {
		Some(Value::Int(value)) => u64::try_from(*value).unwrap_or_default(),
		_ => 0,
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::{Handle, NodeSpec, Op, Txn};
	use omp_journal::data::{ReceiptIdentity, ReceiptRole, TurnReceipt};
	use omp_session::{ComponentRegistry, Session};

	use super::*;

	fn session() -> Session {
		let directory = tempfile::tempdir().expect("temp directory");
		Session::create(directory.keep().join("status.oms"), ComponentRegistry::standard())
			.expect("session")
	}

	fn set(session: &mut Session, handle: Handle, prop: PropId, value: Value) {
		let cause = session.head().expect("head");
		session
			.patch(Txn {
				cause,
				label: None,
				ops: vec![Op::Set { h: handle, prop: prop.into(), value }],
			})
			.expect("patch");
	}

	fn mode(family: &str, status: &str, state: &[(&str, Value)]) -> Option<ModeChip> {
		director_mode(with_director(family, status, state).dom())
	}

	fn with_director(family: &str, status: &str, state: &[(&str, Value)]) -> omp_session::Session {
		let mut session = session();
		let meta = session.dom().meta();
		let directors = session
			.dom()
			.children(meta)
			.iter()
			.copied()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Directors))
			})
			.expect("standard registry materializes directors");
		let mut node = NodeSpec::new(KnownTag::Director)
			.with_prop(PropKey::Custom(Str::new_static("family")), Value::Str(Str::new(family)))
			.with_prop(PropKey::Custom(Str::new_static("status")), Value::Str(Str::new(status)));
		for (key, value) in state {
			node = node.with_prop(PropKey::Custom(Str::new(*key)), value.clone());
		}
		let cause = session.head().expect("head");
		session
			.patch(Txn {
				cause,
				label: None,
				ops: vec![Op::Ins {
					parent: directors,
					after: session.dom().children(directors).last().copied(),
					node,
				}],
			})
			.expect("director");
		session
	}

	#[test]
	fn advisor_badge_projects_the_directors_journaled_health_and_eye() {
		assert_eq!(advisor_badge(session().dom()), None, "no advisor, no badge");
		let badge = |status: &str, state: &[(&str, Value)]| {
			advisor_badge(with_director("advisor", status, state).dom())
		};
		assert_eq!(
			badge("active", &[
				("state/status", Value::Str(Str::new_static("running"))),
				("state/yielded", Value::Bool(false)),
			]),
			Some(AdvisorBadge { health: AdvisorHealth::Running, yielded: false })
		);
		assert_eq!(
			badge("active", &[
				("state/status", Value::Str(Str::new_static("running"))),
				("state/yielded", Value::Bool(true)),
			]),
			Some(AdvisorBadge { health: AdvisorHealth::Running, yielded: true })
		);
		assert_eq!(
			badge("active", &[("state/status", Value::Str(Str::new_static("quota_exhausted")))]),
			Some(AdvisorBadge { health: AdvisorHealth::QuotaExhausted, yielded: false })
		);
		assert_eq!(
			badge("active", &[("state/status", Value::Str(Str::new_static("error")))]),
			Some(AdvisorBadge { health: AdvisorHealth::Error, yielded: false })
		);
		assert_eq!(
			badge("active", &[("state/status", Value::Str(Str::new_static("no_model")))]),
			Some(AdvisorBadge { health: AdvisorHealth::Paused, yielded: false })
		);
		assert_eq!(badge("queued", &[]), None, "a queued frame is not configured yet");
	}

	#[test]
	fn director_mode_projects_every_active_and_paused_status_shape() {
		assert_eq!(mode("plan", "active", &[]), Some(ModeChip::Plan));
		assert_eq!(mode("plan", "paused", &[]), Some(ModeChip::PlanPaused));
		assert_eq!(mode("prewalk", "active", &[]), Some(ModeChip::Prewalk));
		assert_eq!(mode("goal", "active", &[]), Some(ModeChip::Goal(GoalState::Active)));
		assert_eq!(mode("goal", "paused", &[]), Some(ModeChip::Goal(GoalState::Paused)));
		assert_eq!(
			mode("goal", "active", &[("state/done", Value::Bool(true))]),
			Some(ModeChip::Goal(GoalState::Complete))
		);
		assert_eq!(
			mode("goal", "active", &[("state/dropped", Value::Bool(true))]),
			Some(ModeChip::Goal(GoalState::Dropped))
		);
		assert_eq!(
			mode("goal", "active", &[
				("state/token_budget", Value::Int(100)),
				("state/tokens_used", Value::Int(100)),
			]),
			Some(ModeChip::Goal(GoalState::BudgetLimited))
		);
		assert_eq!(mode("vibe", "active", &[]), Some(ModeChip::Vibe));
		assert_eq!(
			mode("loop", "active", &[
				("state/limit_kind", Value::Str(Str::new_static("iterations"))),
				("state/limit", Value::Int(5)),
				("state/used", Value::Int(2)),
			],),
			Some(ModeChip::LoopWaiting {
				limit: Some(LoopLimit::Iterations { remaining: 3, initial: 5 }),
			})
		);
		assert_eq!(mode("loop", "paused", &[]), Some(ModeChip::LoopPaused { limit: None }));
		assert_eq!(mode("goal", "queued", &[]), None, "queued frames stay hidden");
	}

	#[test]
	fn from_dom_sums_receipts_and_reads_the_last_throughput() {
		let mut session = session();
		session.begin_turn().expect("turn");
		session.user("one", Vec::new()).expect("user");
		session
			.receipt(TurnReceipt {
				tokens_in:                   1_000,
				tokens_out:                  200,
				cost_nano_usd:               120_000_000,
				cache_read:                  900,
				cache_write:                 50,
				ttft_ms:                     None,
				duration_ms:                 Some(4_000),
				premium_requests_millionths: 330_000,
				identity:                    None,
				recoveries:                  Vec::new(),
			})
			.expect("receipt");

		session.begin_turn().expect("turn");
		session.user("two", Vec::new()).expect("user");
		session
			.receipt(TurnReceipt {
				tokens_in:                   3_000,
				tokens_out:                  400,
				cost_nano_usd:               5_000_000,
				cache_read:                  2_500,
				cache_write:                 0,
				ttft_ms:                     None,
				duration_ms:                 Some(2_000),
				premium_requests_millionths: 1_000_000,
				identity:                    None,
				recoveries:                  Vec::new(),
			})
			.expect("receipt");
		session
			.receipt(TurnReceipt {
				tokens_in: 7_000,
				tokens_out: 80,
				cost_nano_usd: 80_000_000,
				duration_ms: Some(1_000),
				premium_requests_millionths: 9_000_000,
				identity: Some(ReceiptIdentity {
					role:     ReceiptRole::Advisor,
					provider: Str::new_static("anthropic"),
					model:    Str::new_static("claude-sonnet-4-5"),
				}),
				..TurnReceipt::default()
			})
			.expect("advisor receipt");
		session
			.receipt(TurnReceipt {
				identity: Some(ReceiptIdentity {
					role:     ReceiptRole::Advisor,
					provider: Str::new_static("openai"),
					model:    Str::new_static("gpt-5"),
				}),
				..TurnReceipt::default()
			})
			.expect("second advisor identity");

		let status = StatusLine::from_dom(session.dom());
		assert_eq!(status.turns, 2);
		assert_eq!(
			status.context, 5_500,
			"context is the newest receipt's whole prompt: input + cache read + cache write"
		);
		assert_eq!(status.tokens_in, 4_000);
		assert_eq!(status.tokens_out, 600);
		assert_eq!(status.cache_read, 3_400);
		assert_eq!(status.cache_write, 50);
		assert_eq!(status.cost_nano_usd, 125_000_000);
		let advisor = status.advisor.expect("advisor spend");
		assert_eq!(advisor.cost_nano_usd, 80_000_000);
		assert_eq!(advisor.latest, AdvisorIdentity {
			provider: Str::new_static("openai"),
			model:    Str::new_static("gpt-5"),
		});
		assert_eq!(advisor.identities.as_slice(), &[AdvisorIdentity {
			provider: Str::new_static("anthropic"),
			model:    Str::new_static("claude-sonnet-4-5"),
		}]);
		assert_eq!(
			status.premium_requests_millionths, 1_330_000,
			"advisor billing stays out of primary premium units"
		);
		assert_eq!(
			status.tokens_per_second,
			Some(200.0),
			"advisor receipt does not replace primary throughput"
		);
	}

	#[test]
	fn context_counts_cached_prompt_tokens_so_a_hot_cache_still_shows_pressure() {
		let mut session = session();
		session.begin_turn().expect("turn");
		session.user("one", Vec::new()).expect("user");
		session
			.receipt(TurnReceipt {
				tokens_in:                   5_000,
				tokens_out:                  100,
				cost_nano_usd:               0,
				cache_read:                  95_000,
				cache_write:                 0,
				ttft_ms:                     None,
				duration_ms:                 None,
				premium_requests_millionths: 0,
				identity:                    None,
				recoveries:                  Vec::new(),
			})
			.expect("receipt");
		let status = StatusLine::from_dom(session.dom());
		assert_eq!(status.context, 100_000, "a 95% cache hit is still a 100k prompt");
		assert_eq!(status.tokens_in, 5_000, "cumulative input stays uncached-only");
	}

	#[test]
	fn from_dom_leaves_unjournaled_facts_empty() {
		let mut session = session();
		session.begin_turn().expect("turn");
		session.user("one", Vec::new()).expect("user");
		session
			.receipt(TurnReceipt::tokens(1_000, 200, 0))
			.expect("receipt");
		let status = StatusLine::from_dom(session.dom());
		assert_eq!(status.name, None);
		assert_eq!(status.cache_read, 0);
		assert_eq!(status.cache_write, 0);
		assert_eq!(status.cost_nano_usd, 0);
		assert_eq!(status.premium_requests_millionths, 0);
		assert_eq!(status.tokens_per_second, None, "no duration journaled");
	}

	#[test]
	fn from_dom_reads_the_session_title_from_meta() {
		let mut session = session();
		let meta = session.dom().meta();
		set(&mut session, meta, PropId::Name, Value::Str(Str::new_static("refactor auth")));
		let status = StatusLine::from_dom(session.dom());
		assert_eq!(status.name.as_deref(), Some("refactor auth"));
	}
}
