#![cfg(unix)]

use std::{sync::Arc, time::Duration};

use omp_shell::{
	Shell, ShellOptions, ShellRunOptions,
	bash::trace::{RunTrace, history::HistoryData},
	cancel::{AbortReason, CancelToken},
	minimizer::MinimizerOptions,
};

#[tokio::test(flavor = "multi_thread")]
async fn stop_after_segment_end_reports_only_prevented_work() {
	let root = tempfile::tempdir().unwrap();
	let config = root.path().join("filters.toml");
	std::fs::write(
		&config,
		"schema_version = 1\n[filters.printf]\nmatch_command = \"^printf$\"\nreplace = [{ pattern = \
		 \"hello\", replacement = \"HI\" }]\n",
	)
	.unwrap();
	let cases = [
		("reachable and-tail", "slow_ok && printf hello", true, false, 0),
		("unreachable and-tail", "slow_fail && printf hello", false, false, 1),
		("unconditional tail", "slow_fail; printf hello", true, false, 1),
		("no tail", "printf hello; slow_ok", false, false, 0),
		("exit-established stop", "slow_exit; printf hello", false, true, 0),
	];
	let mut mismatches = Vec::new();
	for (name, script, expected_cancelled, expected_exit, end_status) in cases {
		let shell = Shell::new(Some(ShellOptions {
			minimizer: Some(MinimizerOptions {
				enabled: Some(true),
				settings_path: Some(config.to_str().unwrap().into()),
				..Default::default()
			}),
			..Default::default()
		}));
		let setup = "slow_ok() { /bin/sleep 0.8 & return 0; }; slow_fail() { /bin/sleep 0.8 & \
		             return 1; }; slow_exit() { /bin/sleep 0.8 & exit 0; }";
		let setup_result = shell
			.run(
				ShellRunOptions { command: setup.into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.unwrap();
		assert_eq!(setup_result.exit_code, Some(0), "{name}: valid fixture");
		if name == "reachable and-tail" {
			let (control_tx, control_rx) = flume::unbounded::<String>();
			let control = shell
				.run(
					ShellRunOptions { command: script.into(), ..Default::default() },
					Some(control_tx),
					CancelToken::default(),
				)
				.await
				.unwrap();
			assert_eq!(control.exit_code, Some(0), "uncancelled control status");
			assert!(!control.cancelled, "uncancelled control");
			assert_eq!(
				control_rx.drain().collect::<String>(),
				"hello",
				"the same conditional tail runs without cancellation"
			);
		}
		let trace = Arc::new(RunTrace::new(script));
		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let stop_segment = if name == "no tail" { 1 } else { 0 };
		let (tx, rx) = flume::unbounded::<String>();
		let observe = async {
			loop {
				let snap = trace.snapshot();
				if snap.history.iter().any(|e| {
					e.vpid == snap.root_vpid
						&& e.segment == Some(stop_segment)
						&& matches!(e.data, HistoryData::RunEnd { status } if status == end_status)
				}) {
					assert_eq!(
						snap.status, None,
						"{name}: physical segment ended, logical chain still active"
					);
					abort.abort(AbortReason::Signal);
					break;
				}
				tokio::task::yield_now().await;
			}
		};
		let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
			tokio::join!(
				shell.run(
					ShellRunOptions {
						command: script.into(),
						trace: Some(trace.clone()),
						..Default::default()
					},
					Some(tx),
					cancel
				),
				observe
			)
		})
		.await
		.unwrap_or_else(|_| panic!("{name}: required segmented RunEnd not observed"));
		let result = result.unwrap();
		let output: String = rx.drain().collect();
		let expected_output = if stop_segment == 1 { "hello" } else { "" };
		assert_eq!(output, expected_output, "{name}: no extra segment emitted output");
		assert!(!result.timed_out, "{name}: explicit cancellation, not timeout");
		assert_eq!(result.ended_by_exit, expected_exit, "{name}: exit attribution");
		if !expected_cancelled {
			assert_eq!(result.exit_code, Some(end_status), "{name}: preserve completed status");
		}
		println!(
			"{name}: root RunEnd {end_status}; output={output:?}; result={result:?}; expect \
			 cancelled={expected_cancelled}"
		);
		if result.cancelled != expected_cancelled {
			mismatches.push((name, expected_cancelled, result.cancelled));
		}
	}
	assert!(mismatches.is_empty(), "wrong cancellation attribution: {mismatches:?}");
}
