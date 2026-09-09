//! End-to-end coverage for built-in source tool contracts.

#![cfg(unix)]

use bytes::Bytes;
use omp_e2e::{
	Result, error,
	support::{DEFAULT_TIMEOUT, EnvHarness, Scratch, within},
};
use omp_env::{EnvClient, InvocationEvent};
use omp_proto::env::v1::InvokeTool;
use omp_tool::{CallOutcome, Registry};
use serde_json::{Value, json};

const FIXTURE_ROOT: &str =
	concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/tests/fixtures/special-sources");

async fn invoke_ok(
	client: &EnvClient,
	invocation_id: &str,
	name: &str,
	rev: &str,
	args: Value,
) -> Result<Value> {
	let mut invocation = within(
		"opening built-in invocation",
		DEFAULT_TIMEOUT,
		client.invoke(InvokeTool {
			invocation_id: invocation_id.to_owned(),
			name: name.to_owned(),
			rev: rev.to_owned(),
			..InvokeTool::default()
		}),
	)
	.await??;
	match within("built-in acceptance", DEFAULT_TIMEOUT, invocation.next_event()).await?? {
		Some(InvocationEvent::Accepted(_)) => {},
		Some(event) => return Err(error(format!("expected accepted event, got {event:?}"))),
		None => return Err(error(format!("built-in invocation closed before acceptance"))),
	}
	within(
		"committing built-in arguments",
		DEFAULT_TIMEOUT,
		invocation.commit_args(
			Bytes::from(serde_json::to_vec(&args)?),
			Bytes::from_static(b"tool-sources-test-token"),
			1000,
			None,
		),
	)
	.await??;
	loop {
		match within("built-in verdict", DEFAULT_TIMEOUT, invocation.next_event()).await?? {
			Some(InvocationEvent::Verdict(verdict)) => {
				if verdict.is_error {
					return Err(error(format!(
						"{name} returned an error: {}",
						String::from_utf8_lossy(&verdict.json)
					)));
				}
				return match serde_json::from_slice::<CallOutcome<Value, Value>>(&verdict.json)? {
					CallOutcome::Ok(payload) => Ok(payload),
					other => {
						return Err(error(format!("{name} returned a non-success outcome: {other:?}")));
					},
				};
			},
			Some(InvocationEvent::Update(_)) => {},
			Some(InvocationEvent::Accepted(_)) => {
				return Err(error(format!("built-in invocation was accepted twice")));
			},
			Some(InvocationEvent::Admission(_)) => {
				return Err(error(format!("unexpected admission in built-in invocation")));
			},
			None => return Err(error(format!("built-in invocation closed before its verdict"))),
		}
	}
}

fn checked_fixture(relative: &str) -> &'static [u8] {
	match relative {
		"archives/bundle.zip" => {
			include_bytes!("../../tools/tests/fixtures/special-sources/archives/bundle.zip")
		},
		"database/catalog.sqlite" => {
			include_bytes!("../../tools/tests/fixtures/special-sources/database/catalog.sqlite")
		},
		"images/pixel.png" => {
			include_bytes!("../../tools/tests/fixtures/special-sources/images/pixel.png")
		},
		"profiles/run.cpuprofile" => {
			include_bytes!("../../tools/tests/fixtures/special-sources/profiles/run.cpuprofile")
		},
		_ => panic!("unknown checked fixture {relative}"),
	}
}

#[tokio::test]
async fn production_env_reads_special_sources_and_shares_write_edit_snapshots() -> Result<()> {
	assert!(std::path::Path::new(FIXTURE_ROOT).is_dir());
	let scratch = Scratch::new()?;
	for relative in [
		"archives/bundle.zip",
		"database/catalog.sqlite",
		"images/pixel.png",
		"profiles/run.cpuprofile",
	] {
		scratch.write(relative, checked_fixture(relative))?;
	}
	let env = EnvHarness::spawn(&scratch, Registry::new()).await?;

	for (id, path) in [
		("read-archive", "archives/bundle.zip:dir/member.txt:raw"),
		("read-database", "database/catalog.sqlite:people:2"),
		("read-image", "images/pixel.png"),
		("read-profile", "profiles/run.cpuprofile"),
	] {
		let payload = invoke_ok(env.client(), id, "read", "2", json!({"path": path})).await?;
		assert!(payload.is_object(), "read payload for {path}: {payload}");
	}

	let initial = "alpha\nbeta\n";
	let write = invoke_ok(
		env.client(),
		"write-create",
		"write",
		"2",
		json!({"path":"roundtrip.txt", "content":initial}),
	)
	.await?;
	assert_eq!(write["byte_len"].as_u64(), Some(initial.len() as u64));
	assert_eq!(scratch.read("roundtrip.txt")?, initial.as_bytes());

	let tag = omp_edit::store::file_hash(&initial);
	let edit_input = format!("[roundtrip.txt#{tag}]\nPUT 2.=2:\n+gamma\n");
	invoke_ok(env.client(), "edit-after-write", "edit", "hl.1", json!({"input":edit_input})).await?;
	assert_eq!(scratch.read("roundtrip.txt")?, b"alpha\ngamma\n");

	let final_content = "final café 東京\n";
	let overwrite = invoke_ok(
		env.client(),
		"write-overwrite",
		"write",
		"2",
		json!({"path":"roundtrip.txt", "content":final_content}),
	)
	.await?;
	assert_eq!(overwrite["byte_len"].as_u64(), Some(final_content.len() as u64));
	assert_eq!(scratch.read("roundtrip.txt")?, final_content.as_bytes());

	env.shutdown().await?;
	Ok(())
}
