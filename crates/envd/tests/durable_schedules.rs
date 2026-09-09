//! Proves durable schedule recovery, clocks, idempotency, budgets, backfill,
//! and overlap policy.
use std::{
	collections::BTreeSet,
	sync::{Arc, Mutex},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_core::Str;
use omp_envd::schedules::{
	BudgetReservation, DurableScheduleError, ScheduleCaller, ScheduleDeliveryBackend,
	ScheduleDeliveryReceipt, ScheduleDeliveryRequest, open_durable_scheduler,
	open_durable_scheduler_manual, open_durable_scheduler_unbound,
};
use serde_json::{Map, Value, json};
use tokio::{task, time};

#[derive(Default)]
struct DeliveryState {
	attempts:  usize,
	effects:   usize,
	delivered: BTreeSet<Str>,
}

struct Delivery {
	state:       Mutex<DeliveryState>,
	reservation: BudgetReservation,
}

impl Delivery {
	fn new(reservation: BudgetReservation) -> Arc<Self> {
		Arc::new(Self { state: Mutex::new(DeliveryState::default()), reservation })
	}
}

#[async_trait::async_trait]
impl ScheduleDeliveryBackend for Delivery {
	async fn estimate(&self, _request: &ScheduleDeliveryRequest) -> Result<BudgetReservation, Str> {
		Ok(self.reservation)
	}

	async fn deliver(
		&self,
		request: ScheduleDeliveryRequest,
	) -> Result<ScheduleDeliveryReceipt, Str> {
		let mut state = self.state.lock().expect("delivery state");
		state.attempts += 1;
		if state.delivered.insert(request.idempotency_key) {
			state.effects += 1;
		}
		Ok(ScheduleDeliveryReceipt {
			receipt:     Str::from("delivered"),
			run_id:      None,
			cost_micros: self.reservation.cost_micros,
			requests:    self.reservation.requests,
		})
	}
}

fn caller() -> ScheduleCaller {
	ScheduleCaller {
		owner:              Str::from("session-1"),
		extension_owner:    Str::from("extension-1"),
		principal:          Str::from("principal-1"),
		artifact_digest:    Str::from("artifact-1"),
		host_generation:    1,
		session_generation: 1,
	}
}

fn object(value: Value) -> Map<String, Value> {
	value.as_object().expect("object").clone()
}

fn at_schedule(name: &str, missed: &str, scope: &str, delivery: Value) -> Map<String, Value> {
	object(json!({
		"name": name,
		"trigger": {"kind": "at", "epoch_ms": 1},
		"delivery": delivery,
		"scope": scope,
		"missed": missed,
		"overlap": "skip",
	}))
}
fn every_schedule(name: &str, missed: &str, overlap: &str) -> Map<String, Value> {
	object(json!({
		"name": name,
		"trigger": {"kind": "every", "interval_ms": 1, "jitter_ms": 0, "align": false},
		"delivery": {"kind": "inject", "prompt": name},
		"scope": "project",
		"missed": missed,
		"overlap": overlap,
	}))
}

async fn schedule_id(
	handle: &omp_envd::schedules::DurableScheduleHandle,
	arguments: Map<String, Value>,
) -> String {
	handle
		.request(caller(), "omp.agents.schedule", arguments)
		.await
		.expect("schedule")
		.get("id")
		.and_then(Value::as_str)
		.expect("schedule id")
		.to_owned()
}

async fn history(handle: &omp_envd::schedules::DurableScheduleHandle, id: &str) -> Vec<Value> {
	handle
		.request(
			caller(),
			"omp.agents.schedule.history",
			object(json!({"schedule_id": id, "limit": 100})),
		)
		.await
		.expect("history")
		.as_array()
		.expect("history rows")
		.clone()
}

#[tokio::test]
async fn replaced_owner_bind_is_generation_fenced_and_newest_owner_binds() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("schedules.sqlite");
	let fenced = open_durable_scheduler_unbound(&path).expect("open first scheduler");
	let owner = open_durable_scheduler_unbound(&path).expect("open replacement scheduler");
	let delivery = Delivery::new(BudgetReservation::default());
	let error = fenced
		.bind_delivery(delivery.clone())
		.await
		.expect_err("replaced owner must be fenced");
	assert!(matches!(error, DurableScheduleError::StaleGeneration { expected, active }
		if expected == fenced.generation() && active == owner.generation()));
	owner
		.bind_delivery(delivery)
		.await
		.expect("newest owner binds");
}

#[tokio::test]
async fn project_schedule_recovers_after_session_exit_and_deduplicates_restart() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("schedules.sqlite");
	let delivery = Delivery::new(BudgetReservation { cost_micros: 2, requests: 1 });
	let handle = open_durable_scheduler_manual(&path, delivery.clone()).expect("open scheduler");
	let id = schedule_id(
		&handle,
		at_schedule("persisted", "coalesce", "project", json!({"kind": "inject", "prompt": "wake"})),
	)
	.await;
	handle.expire_session().await.expect("session exit");
	drop(handle);
	task::yield_now().await;

	let restarted =
		open_durable_scheduler_manual(&path, delivery.clone()).expect("restart scheduler");
	let rows = history(&restarted, &id).await;
	assert_eq!(rows.len(), 1);
	assert_eq!(rows[0].get("outcome").and_then(Value::as_str), Some("injected"));
	assert_eq!(delivery.state.lock().expect("state").effects, 1);
	drop(restarted);
	task::yield_now().await;

	let restarted_again =
		open_durable_scheduler_manual(&path, delivery.clone()).expect("second restart");
	assert_eq!(history(&restarted_again, &id).await.len(), 1);
	let state = delivery.state.lock().expect("state");
	assert_eq!(state.attempts, 1);
	assert_eq!(state.effects, 1);
}
#[tokio::test]
async fn owned_clock_fires_without_a_chat_timer() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("clock.sqlite");
	let delivery = Delivery::new(BudgetReservation::default());
	let handle = open_durable_scheduler(&path, delivery.clone()).expect("open clock scheduler");
	let at_ms: u64 = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("clock")
		.as_millis()
		.try_into()
		.expect("epoch millis");
	let mut arguments =
		at_schedule("clock", "coalesce", "project", json!({"kind": "inject", "prompt": "clock"}));
	arguments
		.insert("trigger".to_owned(), json!({"kind": "at", "epoch_ms": at_ms.saturating_add(25)}));
	let id = schedule_id(&handle, arguments).await;
	time::sleep(Duration::from_millis(100)).await;
	let rows = history(&handle, &id).await;
	assert_eq!(rows.len(), 1);
	assert_eq!(rows[0].get("outcome").and_then(Value::as_str), Some("injected"));
	assert_eq!(delivery.state.lock().expect("state").effects, 1);
}

#[tokio::test]
async fn pending_intent_replay_uses_idempotency_key_without_repeating_effect() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("schedules.sqlite");
	let delivery = Delivery::new(BudgetReservation::default());
	let handle = open_durable_scheduler_manual(&path, delivery.clone()).expect("open scheduler");
	let id = schedule_id(
		&handle,
		at_schedule("ambiguous", "coalesce", "project", json!({"kind": "inject", "prompt": "once"})),
	)
	.await;
	drop(handle);
	task::yield_now().await;

	let key = format!("{id}:1");
	{
		let mut state = delivery.state.lock().expect("state");
		state.delivered.insert(Str::from(key.as_str()));
		state.effects = 1;
	}
	let connection = rusqlite::Connection::open(&path).expect("open journal");
	let event = json!({
		"op": "firing_intent",
		"firing": {
			"schedule_id": id,
			"idempotency_key": key,
			"at_ms": 1,
			"late_ms": 0,
			"outcome": null,
			"artifact_digest": "artifact-1",
			"principal": "principal-1",
			"run_id": null,
			"detail": null,
			"cost_micros": 0,
			"requests": 0,
			"scheduler_generation": 1,
			"schedule_generation": 1
		}
	});
	connection
		.execute(
			"INSERT INTO schedule_journal(owner_generation, written_ms, event_json) VALUES(1, 1, ?1)",
			[serde_json::to_string(&event).expect("serialize event")],
		)
		.expect("append ambiguous intent");
	drop(connection);

	let restarted =
		open_durable_scheduler_manual(&path, delivery.clone()).expect("restart scheduler");
	let rows = history(&restarted, &id).await;
	assert_eq!(rows.len(), 1);
	assert_eq!(rows[0].get("outcome").and_then(Value::as_str), Some("injected"));
	let state = delivery.state.lock().expect("state");
	assert_eq!(state.attempts, 1);
	assert_eq!(state.effects, 1, "backend deduped the replayed intent key");
}

#[tokio::test]
async fn recovery_honors_skip_and_hard_budget_refusal() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("schedules.sqlite");
	let delivery = Delivery::new(BudgetReservation { cost_micros: 10, requests: 1 });
	let handle = open_durable_scheduler_manual(&path, delivery.clone()).expect("open scheduler");
	let skipped = schedule_id(
		&handle,
		at_schedule("skip", "skip", "project", json!({"kind": "inject", "prompt": "skip"})),
	)
	.await;
	let mut refused_args = at_schedule(
		"refused",
		"coalesce",
		"project",
		json!({"kind": "spawn", "spec": {"agent": "task", "task": "work"}}),
	);
	refused_args.insert(
		"budget".to_owned(),
		json!({
			"max_usd_per_firing": 0.000005,
			"max_usd_per_window": 0.000005,
			"window_ms": 60000,
			"max_requests_per_firing": 1
		}),
	);
	let refused = schedule_id(&handle, refused_args).await;
	drop(handle);
	task::yield_now().await;

	let restarted =
		open_durable_scheduler_manual(&path, delivery.clone()).expect("restart scheduler");
	assert!(history(&restarted, &skipped).await.is_empty());
	let skipped_info = restarted
		.request(caller(), "omp.agents.schedule.info", object(json!({"schedule_id": skipped})))
		.await
		.expect("skip info");
	assert_eq!(skipped_info.get("miss_count").and_then(Value::as_u64), Some(1));
	let refused_history = history(&restarted, &refused).await;
	assert_eq!(refused_history.len(), 1);
	assert_eq!(refused_history[0].get("outcome").and_then(Value::as_str), Some("budget_refused"));
	assert_eq!(delivery.state.lock().expect("state").effects, 0);
}
#[tokio::test]
async fn coalesce_backfill_and_overlap_are_projected_durably() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("schedules.sqlite");
	let delivery = Delivery::new(BudgetReservation::default());
	let handle = open_durable_scheduler_manual(&path, delivery.clone()).expect("open scheduler");
	let coalesced = schedule_id(&handle, every_schedule("coalesced", "coalesce", "queue")).await;
	let backfilled = schedule_id(&handle, every_schedule("backfilled", "backfill", "queue")).await;
	drop(handle);
	time::sleep(Duration::from_millis(80)).await;

	let restarted =
		open_durable_scheduler_manual(&path, delivery.clone()).expect("restart scheduler");
	let coalesced_history = history(&restarted, &coalesced).await;
	assert_eq!(coalesced_history.len(), 1);
	assert_eq!(coalesced_history[0].get("outcome").and_then(Value::as_str), Some("injected"));
	let backfilled_history = history(&restarted, &backfilled).await;
	assert!(
		(2..=33).contains(&backfilled_history.len()),
		"backfill replays at most 32 individual occurrences and one coalesced remainder"
	);
	assert!(
		backfilled_history
			.iter()
			.all(|row| row.get("outcome").and_then(Value::as_str) == Some("injected"))
	);

	let overlap_path = temp.path().join("overlap.sqlite");
	let overlap = open_durable_scheduler_manual(&overlap_path, delivery.clone())
		.expect("open overlap scheduler");
	let overlap_id = schedule_id(&overlap, every_schedule("overlap", "coalesce", "skip")).await;
	time::sleep(Duration::from_millis(5)).await;
	overlap
		.process_due(
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("clock")
				.as_millis()
				.try_into()
				.expect("epoch millis"),
		)
		.await
		.expect("process overlap");
	let overlap_history = history(&overlap, &overlap_id).await;
	assert_eq!(
		overlap_history
			.iter()
			.filter(|row| row.get("outcome").and_then(Value::as_str) == Some("injected"))
			.count(),
		1
	);
	assert!(
		overlap_history
			.iter()
			.any(|row| row.get("outcome").and_then(Value::as_str) == Some("skipped"))
	);
}
