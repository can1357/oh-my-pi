//! Pipeline streaming and bounded-pipe regression tests.
#![cfg(unix)]

use std::{
	io::{BufRead, BufReader, Read},
	process::{Command, Stdio},
	sync::mpsc,
	thread,
	time::{Duration, Instant},
};

fn shell_command(script: &str) -> Command {
	let mut command = Command::new(env!("CARGO_BIN_EXE_omp-sh"));
	command.args(["-c", script]);
	command
}

fn assert_streams_before_exit(script: &str) {
	let mut child = shell_command(script)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn omp-sh");
	let stdout = child.stdout.take().expect("piped stdout");
	let start = Instant::now();
	let (first_line_tx, first_line_rx) = mpsc::sync_channel(1);
	let reader = thread::spawn(move || {
		let mut reader = BufReader::new(stdout);
		let mut output = String::new();
		let mut line = String::new();
		while reader.read_line(&mut line).expect("read shell stdout") != 0 {
			if output.is_empty() {
				let _ = first_line_tx.send(start.elapsed());
			}
			output.push_str(&line);
			line.clear();
		}
		output
	});

	let first_line = if let Ok(first_line) = first_line_rx.recv_timeout(Duration::from_millis(1_200))
	{
		first_line
	} else {
		let _ = child.kill();
		let _ = child.wait();
		let _ = reader.join();
		panic!("`{script}` buffered its first line until exit");
	};
	assert!(first_line < Duration::from_millis(1_200), "first line arrived at {first_line:?}");
	assert!(
		child.try_wait().expect("poll omp-sh").is_none(),
		"`{script}` exited before observation"
	);
	let deadline = Instant::now() + Duration::from_secs(10);
	let status = loop {
		if let Some(status) = child.try_wait().expect("poll omp-sh") {
			break status;
		}
		if Instant::now() >= deadline {
			let _ = child.kill();
			let _ = child.wait();
			panic!("`{script}` did not exit after streaming its first line");
		}
		thread::sleep(Duration::from_millis(10));
	};
	let output = reader.join().expect("join stdout reader");
	let mut stderr = String::new();
	child
		.stderr
		.take()
		.expect("piped stderr")
		.read_to_string(&mut stderr)
		.expect("read shell stderr");
	assert!(status.success(), "`{script}` failed: {stderr}");
	assert!(output.starts_with("hit\n"), "unexpected output for `{script}`: {output:?}");
}

#[test]
fn compound_and_function_pipeline_stages_stream_before_exit() {
	for script in [
		"{ echo hit; sleep 2; } | cat",
		"{ echo hit; sleep 2; } | grep .",
		"f() { echo hit; sleep 2; }; f | cat",
	] {
		assert_streams_before_exit(script);
	}
}

#[test]
fn compound_stage_larger_than_pipe_buffer_does_not_deadlock() {
	let script = "{ seq 1 200000; echo hit; } | head -n 1";
	let mut child = shell_command(script)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn omp-sh");
	let mut stdout = child.stdout.take().expect("piped stdout");
	let mut stderr = child.stderr.take().expect("piped stderr");
	let stdout_reader = thread::spawn(move || {
		let mut bytes = Vec::new();
		stdout.read_to_end(&mut bytes).expect("read shell stdout");
		bytes
	});
	let stderr_reader = thread::spawn(move || {
		let mut bytes = Vec::new();
		stderr.read_to_end(&mut bytes).expect("read shell stderr");
		bytes
	});

	let deadline = Instant::now() + Duration::from_secs(10);
	let status = loop {
		if let Some(status) = child.try_wait().expect("poll omp-sh") {
			break status;
		}
		if Instant::now() >= deadline {
			let _ = child.kill();
			let _ = child.wait();
			panic!("pipeline deadlocked after filling its connecting pipe");
		}
		thread::sleep(Duration::from_millis(10));
	};
	let stdout = stdout_reader.join().expect("join stdout reader");
	let stderr = stderr_reader.join().expect("join stderr reader");
	assert!(status.success(), "pipeline failed: {}", String::from_utf8_lossy(&stderr));
	assert_eq!(String::from_utf8_lossy(&stdout).lines().next(), Some("1"));
}
