//! Proves UI, telemetry, and jobs control owners enforce identity fences and
//! preserve results.
use std::{collections::BTreeSet, sync::Arc};

use async_trait::async_trait;
use omp_core::{Principal, Str};
use omp_envd::exthost::{
	ControlAuthority,
	control::{
		ControlConnectionIdentity, ControlEffect, ControlProtocolError, ControlRequestContext,
	},
	presentation::{
		JobsControlAuthority, JobsControlOwner, TelemetryControlAuthority, UiControlAuthority,
		UiControlOwner, UiControlRequest, UiControlResult,
	},
};
use omp_observability::authority::{
	DurableTelemetryQuery, TelemetryAuthorityError, TelemetryAuthorityIdentity,
};
use serde_json::{Map, Value, json};

fn identity(generation: u64) -> Arc<ControlConnectionIdentity> {
	Arc::new(ControlConnectionIdentity {
		extension:          Str::new_static("extension"),
		principal:          Principal::new(Str::new_static("principal"), Str::new_static("User")),
		artifact_digest:    Str::new_static("artifact"),
		layer:              Str::new_static("project"),
		tier:               Str::new_static("local"),
		trust:              Str::new_static("sandboxed"),
		host_generation:    generation,
		session_generation: 3,
		capabilities:       Arc::new(
			["ui.dialogs", "ui.commands", "ui.slots", "ui.notify"]
				.into_iter()
				.map(Str::new_static)
				.collect::<BTreeSet<_>>(),
		),
	})
}

fn context(connection: Arc<ControlConnectionIdentity>, request_id: u64) -> ControlRequestContext {
	ControlRequestContext { connection, request_id, invocation: None }
}

struct UiOwner;

#[async_trait]
impl UiControlOwner for UiOwner {
	async fn request(
		&self,
		_context: ControlRequestContext,
		request: UiControlRequest,
	) -> Result<UiControlResult, ControlProtocolError> {
		match request {
			UiControlRequest::Presentation => Ok(UiControlResult::Value(json!({
				"charset": "unicode",
				"appearance": "dark",
				"width": 100,
				"height": 30,
				"graphics": "cells",
				"hyperlinks": true,
				"has_ui": true,
			}))),
			UiControlRequest::Overlay { .. } => Ok(UiControlResult::Value(json!({"id": "overlay-1"}))),
			UiControlRequest::OverlayClose { .. } => Ok(UiControlResult::Ack),
			_ => Err(ControlProtocolError::new("unexpected", "unexpected UI request")),
		}
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		effect: Value,
	) -> Result<(), ControlProtocolError> {
		assert_eq!(effect["kind"], "mount");
		Ok(())
	}
}

struct DurableQuery;

impl DurableTelemetryQuery for DurableQuery {
	fn query(
		&self,
		identity: &TelemetryAuthorityIdentity,
		query: &Value,
	) -> Result<Value, TelemetryAuthorityError> {
		assert_eq!(identity.installed_at_ms, 500);
		assert_eq!(query["limit"], 5);
		Ok(json!({
			"rows": [{"events": [], "bindings": {}, "session": "s", "turn": 1,
				"values": {"count()": 2}}],
			"total": 1,
			"cursor": null,
			"truncated": false,
			"scanned_sessions": 1,
			"scanned_events": 2,
			"backfilled": false,
			"floored": true,
			"elapsed_ms": 1,
		}))
	}

	fn rev_metrics(
		&self,
		_identity: &TelemetryAuthorityIdentity,
		_tool: &str,
		_family: Option<&str>,
		_since: Option<&Value>,
		_scope: &str,
	) -> Result<Value, TelemetryAuthorityError> {
		Ok(json!([]))
	}
}

struct JobsOwner;

#[async_trait]
impl JobsControlOwner for JobsOwner {
	async fn register_job(
		&self,
		_context: ControlRequestContext,
		arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let job = arguments
			.get("job")
			.ok_or_else(|| ControlProtocolError::new("invalid_job", "job is missing"))?;
		Ok(job.clone())
	}
}

#[tokio::test]
async fn owners_are_identity_fenced_and_preserve_real_results() {
	let live = identity(7);
	let ui = UiControlAuthority::new(live.clone(), Arc::new(UiOwner));
	let ui_context = context(live.clone(), 1);
	ui.authorize(&ui_context, "omp.ui.presentation", &Map::new())
		.unwrap();
	let presentation = ui
		.request(ui_context.clone(), Str::new_static("omp.ui.presentation"), Map::new())
		.await
		.unwrap();
	assert_eq!(presentation["has_ui"], true);
	ui.effect(
		context(live.clone(), 2),
		ControlEffect::Ui(json!({"kind": "mount", "body": {"key": "status"}})),
	)
	.await
	.unwrap();

	let stale = context(identity(6), 3);
	assert!(
		ui.authorize(&stale, "omp.ui.presentation", &Map::new())
			.is_err()
	);

	let telemetry = TelemetryControlAuthority::new(live.clone(), 500, Arc::new(DurableQuery));
	let query = telemetry
		.request(
			context(live.clone(), 4),
			Str::new_static("omp.telemetry.query"),
			Map::from_iter([("query".to_owned(), json!({"limit": 5}))]),
		)
		.await
		.unwrap();
	assert_eq!(query["rows"][0]["values"]["count()"], 2);
	assert_eq!(query["floored"], true);

	let opened = telemetry
		.request(
			context(live.clone(), 5),
			Str::new_static("omp.telemetry.span.open"),
			Map::from_iter([
				("name".to_owned(), json!("extension.contract")),
				("attributes".to_owned(), json!({"generation": 7})),
			]),
		)
		.await
		.unwrap();
	let handle = opened["handle"].as_str().unwrap().to_owned();
	telemetry
		.request(
			context(live.clone(), 6),
			Str::new_static("omp.telemetry.span.close"),
			Map::from_iter([
				("handle".to_owned(), json!(handle)),
				("attributes".to_owned(), json!({"rows": 1})),
				("events".to_owned(), json!([{"name": "done", "attributes": {}}])),
				("fault".to_owned(), Value::Null),
			]),
		)
		.await
		.unwrap();

	let jobs = JobsControlAuthority::new(live.clone(), Arc::new(JobsOwner));
	let registered = jobs
		.request(
			context(live, 7),
			Str::new_static("omp.jobs.register"),
			Map::from_iter([("job".to_owned(), json!({"id": "job-1", "generation": 9}))]),
		)
		.await
		.unwrap();
	assert_eq!(registered["id"], "job-1");
}
