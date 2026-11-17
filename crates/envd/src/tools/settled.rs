//! `agent_settled` hook reply decoding, row selection and Continue/Settle fold.

use std::{
	cmp::Ordering,
	future::Future,
	sync::{Arc, Weak},
};

use omp_contract::{BoxFut, HookContext, NativeHookHost, NativeReply, NativeVerdict};
use omp_core::Str;
use omp_proto::toolhost::v1::HookEventId;
use serde_json::Value as JsonValue;

use super::hooks::{HookControlFactory, HookSubscription};

/// One decoded Continue reply: the prompt that starts another turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SettledContinue {
	/// Text the next turn reads.
	pub prompt: Str,
	/// Producer label, when the hook supplied one.
	pub label:  Option<Str>,
}

/// Decodes a Python `agent_settled` reply; `None` means Settle.
pub(crate) fn decode_settled_reply(reply: &JsonValue) -> Option<SettledContinue> {
	let object = reply.as_object()?;
	let prompt = object
		.get("prompt")?
		.as_str()
		.filter(|prompt| !prompt.is_empty())?;
	let label = object
		.get("label")
		.and_then(JsonValue::as_str)
		.map(Str::from);
	Some(SettledContinue { prompt: Str::from(prompt), label })
}

/// Selects the domain `agent_settled` rows of one session generation, in call
/// order.
pub(crate) fn settled_rows<'a>(
	rows: impl IntoIterator<Item = &'a HookSubscription>,
	session: &str,
	session_generation: u64,
) -> Vec<HookSubscription> {
	let mut selected: Vec<HookSubscription> = rows
		.into_iter()
		.filter(|row| {
			row.event == "agent_settled"
				&& row.phase == "domain"
				&& row.session == session
				&& row.identity.session_generation == session_generation
		})
		.cloned()
		.collect();
	selected.sort_by(|a, b| -> Ordering {
		(&a.identity.layer, &a.identity.extension, a.order, &a.name).cmp(&(
			&b.identity.layer,
			&b.identity.extension,
			b.order,
			&b.name,
		))
	});
	selected
}

/// Calls rows in order: the first Continue is pending; later hooks see it and
/// may veto with Settle. A failed or timed-out call never vetoes (fail-open).
pub(crate) async fn resolve_settled<F, Fut>(rows: &[HookSubscription], mut call: F) -> NativeReply
where
	F: FnMut(&HookSubscription, Option<&SettledContinue>) -> Fut,
	Fut: Future<Output = Option<JsonValue>>,
{
	let mut pending: Option<(SettledContinue, Str)> = None;
	for row in rows {
		let pending_continue = pending.as_ref().map(|(continuation, _)| continuation);
		let Some(reply) = call(row, pending_continue).await else {
			// Raise / timeout: contribute Settle without vetoing a pending Continue.
			continue;
		};
		match decode_settled_reply(&reply) {
			Some(found) => {
				if pending.is_none() {
					let source = found
						.label
						.clone()
						.unwrap_or_else(|| row.identity.extension.clone());
					pending = Some((found, source));
				}
			},
			None if pending.is_some() => {
				// Explicit Settle after a Continue vetoes it.
				return NativeReply { verdict: NativeVerdict::Defer, context: Vec::new() };
			},
			None => {},
		}
	}
	match pending {
		Some((found, source)) => NativeReply {
			verdict: NativeVerdict::Continue,
			context: vec![HookContext { source, body: found.prompt }],
		},
		None => NativeReply { verdict: NativeVerdict::Defer, context: Vec::new() },
	}
}

/// In-process host that answers `agent_settled` from the session's Python
/// hook rows. Holds the factory weakly: the factory owns the gate it is
/// attached to.
///
/// Assumes one admission gate per session (one `EnvServer` per session), so
/// the session id bound here is the only session the gate serves, and a session
/// generation that stays constant for the runtime this host was attached in.
pub(crate) struct AgentSettledHost {
	hooks:      Weak<HookControlFactory>,
	session:    Str,
	generation: u64,
}

impl AgentSettledHost {
	/// Attaches one host to the factory's gate; call once per session gate.
	pub(crate) fn attach(hooks: &Arc<HookControlFactory>, session: Str, generation: u64) {
		let host = Arc::new(Self { hooks: Arc::downgrade(hooks), session, generation });
		hooks
			.admission_gate()
			.attach_native(host, &[HookEventId::HookEventAgentSettled]);
	}
}

impl NativeHookHost for AgentSettledHost {
	fn decide<'a>(&'a self, event: HookEventId, payload: &'a JsonValue) -> BoxFut<'a, NativeReply> {
		Box::pin(async move {
			if event != HookEventId::HookEventAgentSettled {
				return NativeReply::default();
			}
			let Some(hooks) = self.hooks.upgrade() else {
				return NativeReply::default();
			};
			hooks
				.dispatch_agent_settled(&self.session, self.generation, payload)
				.await
		})
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, BTreeSet},
		sync::Arc,
		time,
	};

	use omp_core::{Principal, sf};
	use serde_json::json;

	use super::*;
	use crate::{
		exthost::{CallbackConcurrency, control::ControlConnectionIdentity},
		tools::hooks::{HookEventPolicy, HookFailurePolicy},
	};

	fn row(
		ext: &str,
		order: i32,
		event: &str,
		phase: &str,
		session: &str,
		generation: u64,
	) -> HookSubscription {
		HookSubscription {
			identity: Arc::new(ControlConnectionIdentity {
				extension:          Str::from(ext),
				principal:          Principal::new(sf!("test"), sf!("Test")),
				artifact_digest:    sf!("sha256:test"),
				layer:              sf!("project"),
				tier:               sf!("trusted"),
				trust:              sf!("trusted"),
				host_generation:    1,
				session_generation: generation,
				capabilities:       Arc::new(BTreeSet::new()),
			}),
			session: Str::from(session),
			event: Str::from(event),
			phase: Str::from(phase),
			name: Str::from(format!("{ext}/{order}")),
			order,
			on_failure: None,
			timeout: None,
			concurrency: CallbackConcurrency::Serialized,
			providers: None,
			servers: None,
			method_globs: Box::new([]),
			event_policy: HookEventPolicy {
				revision:    1,
				timeout:     time::Duration::from_secs(1),
				on_failure:  HookFailurePolicy::Defer,
				default:     json!({}),
				composition: BTreeMap::new(),
			},
		}
	}

	fn settled(ext: &str, order: i32) -> HookSubscription {
		row(ext, order, "agent_settled", "domain", "s1", 1)
	}

	fn names(rows: &[HookSubscription]) -> Vec<String> {
		rows.iter().map(|r| r.name.to_string()).collect()
	}

	#[test]
	fn continue_object_decodes() {
		let reply = json!({"prompt":"go on","label":"lint","visible":false,"role":"system","collapse_prior":true});
		let got = decode_settled_reply(&reply).expect("continue");
		assert_eq!(got.prompt, "go on");
		assert_eq!(got.label.as_deref(), Some("lint"));
	}

	#[test]
	fn settle_none_and_junk_decode_as_settle() {
		for reply in [json!({}), json!(null), json!({"prompt":3}), json!("continue")] {
			assert_eq!(decode_settled_reply(&reply), None);
		}
	}

	#[test]
	fn empty_prompt_is_settle() {
		assert_eq!(decode_settled_reply(&json!({"prompt":""})), None);
	}

	#[test]
	fn rows_are_ordered_and_filtered() {
		let rows = vec![
			settled("b-ext", 0),
			settled("a-ext", 1),
			row("a-ext", 0, "other", "domain", "s1", 1),
			row("a-ext", 0, "agent_settled", "pre", "s1", 1),
			row("a-ext", 0, "agent_settled", "domain", "s2", 1),
			settled("a-ext", 0),
		];
		assert_eq!(names(&settled_rows(rows.iter(), "s1", 1)), ["a-ext/0", "a-ext/1", "b-ext/0"]);
	}

	#[test]
	fn rows_of_another_generation_are_skipped() {
		let rows = vec![row("a-ext", 0, "agent_settled", "domain", "s1", 2), settled("b-ext", 0)];
		assert_eq!(names(&settled_rows(rows.iter(), "s1", 1)), ["b-ext/0"]);
	}

	#[tokio::test]
	async fn first_continue_wins_and_later_continues_are_ignored() {
		let rows = vec![settled("a", 0), settled("b", 0), settled("c", 0)];
		let mut calls = 0;
		let reply = resolve_settled(&rows, |r, pending| {
			calls += 1;
			let out = match r.identity.extension.as_str() {
				"a" => json!({}),
				"b" => {
					assert!(pending.is_none());
					json!({"prompt":"x"})
				},
				_ => {
					assert_eq!(pending.map(|c| c.prompt.as_str()), Some("x"));
					json!({"prompt":"y"})
				},
			};
			async move { Some(out) }
		})
		.await;
		assert_eq!(calls, 3, "hooks after the first Continue still run");
		assert_eq!(reply.verdict, NativeVerdict::Continue);
		assert_eq!(reply.context, vec![HookContext { source: sf!("b"), body: sf!("x") }]);
	}

	#[tokio::test]
	async fn later_settle_vetoes_a_pending_continue() {
		let rows = vec![settled("a", 0), settled("b", 0), settled("c", 0)];
		let mut calls = 0;
		let reply = resolve_settled(&rows, |r, pending| {
			calls += 1;
			let out = match r.identity.extension.as_str() {
				"a" => json!({"prompt":"keep"}),
				"b" => {
					assert_eq!(pending.map(|c| c.prompt.as_str()), Some("keep"));
					json!({})
				},
				_ => panic!("veto stops further hooks"),
			};
			async move { Some(out) }
		})
		.await;
		assert_eq!(calls, 2);
		assert_eq!(reply, NativeReply::default());
	}

	#[tokio::test]
	async fn failed_call_after_continue_does_not_veto() {
		let rows = vec![settled("a", 0), settled("b", 0)];
		let reply = resolve_settled(&rows, |r, pending| {
			let out = match r.identity.extension.as_str() {
				"a" => Some(json!({"prompt":"keep"})),
				"b" => {
					assert_eq!(pending.map(|c| c.prompt.as_str()), Some("keep"));
					None
				},
				_ => unreachable!(),
			};
			async move { out }
		})
		.await;
		assert_eq!(reply.verdict, NativeVerdict::Continue);
		assert_eq!(reply.context[0].body, "keep");
	}

	#[tokio::test]
	async fn failed_call_counts_as_settle_and_the_next_hook_runs() {
		let rows = vec![settled("a", 0), settled("b", 0)];
		let reply = resolve_settled(&rows, |r, _pending| {
			let out = (r.identity.extension == "b").then(|| json!({"prompt":"z","label":"L"}));
			async move { out }
		})
		.await;
		assert_eq!(reply.verdict, NativeVerdict::Continue);
		assert_eq!(reply.context[0].body, "z");
		assert_eq!(reply.context[0].source, "L");
	}

	#[tokio::test]
	async fn no_continue_defers() {
		let rows = vec![settled("a", 0)];
		let reply = resolve_settled(&rows, |_, _| async { Some(json!({})) }).await;
		assert_eq!(reply, NativeReply::default());
	}
}
