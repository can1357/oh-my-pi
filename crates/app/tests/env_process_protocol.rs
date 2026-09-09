//! Verifies nullable worktree queries and revision- and generation-fenced
//! process operations.

#![cfg(unix)]

use std::{net::TcpListener, time::Duration};

use omp_envd::exec::{ExecError, ExecHost};
use omp_proto::env::v1::{
	CurrentWorktree, CurrentWorktreeResult, GetProcess, ProcessSpec, ReadyProbe, ReadyTcp,
	RestartProcess, Script, StartProcess, WorktreeOp, WorktreeResult, ready_probe, worktree_op,
};
use url::Url;

#[test]
fn current_worktree_contract_preserves_nullable_primary() {
	let request = WorktreeOp {
		op: Some(worktree_op::Op::Current(CurrentWorktree {
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		})),
		..Default::default()
	};
	assert!(matches!(request.op, Some(worktree_op::Op::Current(_))));

	let response = WorktreeResult {
		current: Some(CurrentWorktreeResult {
			primary: None,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		}),
		..Default::default()
	};
	assert!(
		response
			.current
			.expect("current-worktree result")
			.primary
			.is_none()
	);
}

#[tokio::test]
async fn process_info_and_restart_are_revision_and_generation_fenced() {
	let root = tempfile::tempdir().expect("workspace");
	let cwd_uri = Url::from_directory_path(root.path())
		.expect("workspace URI")
		.to_string();
	let listener = TcpListener::bind(("127.0.0.1", 0)).expect("readiness listener");
	let port = u32::from(listener.local_addr().expect("listener address").port());
	let host = ExecHost::new();
	let started = host
		.start_process(StartProcess {
			name: String::from("revision-fenced"),
			spec: Some(ProcessSpec {
				source: Some(Script {
					text: String::from("while :; do sleep 1; done"),
					..Default::default()
				}),
				cwd_uri,
				..Default::default()
			}),
			ready: vec![ReadyProbe {
				probe: Some(ready_probe::Probe::Tcp(ReadyTcp {
					host: String::from("127.0.0.1"),
					port,
					..Default::default()
				})),
				timeout_ms: 1_000,
				..Default::default()
			}],
			..Default::default()
		})
		.await
		.expect("start process");
	let expected_endpoint = format!("tcp://127.0.0.1:{port}");
	assert_eq!(started.endpoint.as_deref(), Some(expected_endpoint.as_str()));

	let info = host
		.get_process(&GetProcess {
			name: started.name.clone(),
			generation: started.generation,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		})
		.expect("exact generation info");
	assert_eq!(info.endpoint, started.endpoint);
	assert_eq!(
		info
			.spec
			.as_ref()
			.and_then(|spec| spec.source.as_ref())
			.map(|source| source.text.as_str()),
		Some("while :; do sleep 1; done")
	);
	assert_eq!(info.ready.len(), 1);

	assert!(matches!(
		host.get_process(&GetProcess {
			name: started.name.clone(),
			generation: started.generation,
			wire_revision: 0,
			..Default::default()
		}),
		Err(ExecError::WireRevision)
	));

	let restarted = host
		.restart_process(RestartProcess {
			name: started.name.clone(),
			generation: started.generation,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		})
		.await
		.expect("restart exact generation");
	assert_eq!(restarted.generation, started.generation + 1);
	assert!(matches!(
		host.get_process(&GetProcess {
			name: started.name,
			generation: started.generation,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		}),
		Err(ExecError::StaleProcessGeneration { .. })
	));
	host
		.stop_process(&restarted.name, restarted.generation, Duration::from_millis(10))
		.expect("stop replacement");
}
