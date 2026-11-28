mod protocol;
mod runtime;

use std::{
	env,
	io::{self, BufWriter},
	process::ExitCode,
	sync::mpsc,
};

use crate::{
	protocol::{ReadFrameError, V8Inbound, V8Outbound, read_inbound_frame, write_outbound_frame},
	runtime::V8SandboxRuntime,
};

const DEFAULT_MAX_HEAP_MB: u64 = 256;

fn parse_max_heap_mb() -> Result<u64, String> {
	let mut max_heap_mb = DEFAULT_MAX_HEAP_MB;
	let mut args = env::args().skip(1);
	while let Some(arg) = args.next() {
		match arg.as_str() {
			"--max-heap-mb" => {
				let val = args
					.next()
					.ok_or_else(|| "--max-heap-mb requires an integer argument".to_string())?;
				max_heap_mb = val
					.parse::<u64>()
					.map_err(|_| format!("invalid --max-heap-mb value: {val}"))?;
			},
			other => {
				return Err(format!("unknown argument: {other}"));
			},
		}
	}
	Ok(max_heap_mb)
}

fn main() -> ExitCode {
	let max_heap_mb = match parse_max_heap_mb() {
		Ok(v) => v,
		Err(err) => {
			eprintln!("{err}");
			return ExitCode::FAILURE;
		},
	};

	let mut runtime = match V8SandboxRuntime::new(
		max_heap_mb,
		Box::new(|msg| {
			let stdout = io::stdout();
			let mut writer = BufWriter::new(stdout.lock());
			let _ = write_outbound_frame(&mut writer, &msg);
		}),
	) {
		Ok(rt) => rt,
		Err(err) => {
			eprintln!("failed to initialize V8 runtime: {err}");
			return ExitCode::FAILURE;
		},
	};

	let tracker = runtime.tracker();
	let (tx, rx) = mpsc::channel::<V8Inbound>();
	let (err_tx, err_rx) = mpsc::channel::<String>();

	std::thread::spawn(move || {
		let stdin = io::stdin();
		let mut reader = stdin.lock();
		loop {
			match read_inbound_frame(&mut reader) {
				Ok(msg) => {
					tracker.handle_async_inbound(&msg);
					let is_close = matches!(msg, V8Inbound::Close);
					if tx.send(msg).is_err() || is_close {
						break;
					}
				},
				Err(ReadFrameError::Eof) => {
					tracker.terminate_on_eof();
					break;
				},
				Err(ReadFrameError::TooLarge) => {
					tracker.terminate_on_eof();
					let _ = err_tx.send("inbound frame exceeded 16 MiB limit".to_string());
					break;
				},
				Err(ReadFrameError::Json(err)) => {
					tracker.terminate_on_eof();
					let _ = err_tx.send(format!("malformed inbound JSON frame: {err}"));
					break;
				},
				Err(ReadFrameError::Io(err)) => {
					tracker.terminate_on_eof();
					let _ = err_tx.send(format!("stdin read error: {err}"));
					break;
				},
			}
		}
	});

	runtime.emit_outbound(V8Outbound::Ready);

	while let Ok(msg) = rx.recv() {
		match msg {
			V8Inbound::Init => {
				// Runtime initialized at startup; ready frame already emitted.
			},
			V8Inbound::Run { run_id, code, filename, final_expr_suppressed } => {
				if runtime.run_cell(&run_id, &code, &filename, final_expr_suppressed, &rx) {
					runtime.emit_outbound(V8Outbound::Closed);
					return ExitCode::SUCCESS;
				}
			},
			V8Inbound::Close => {
				runtime.emit_outbound(V8Outbound::Closed);
				return ExitCode::SUCCESS;
			},
			V8Inbound::ToolReply { .. } | V8Inbound::Cancel { .. } => {},
		}
	}

	if let Ok(err) = err_rx.try_recv() {
		eprintln!("{err}");
		return ExitCode::FAILURE;
	}

	ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
	use std::{cell::RefCell, rc::Rc, sync::mpsc, time::Duration};

	use super::*;

	fn run_with_events(
		rt: &mut V8SandboxRuntime,
		events: &Rc<RefCell<Vec<V8Outbound>>>,
		run_id: &str,
		code: &str,
	) -> Vec<V8Outbound> {
		events.borrow_mut().clear();
		let (_tx, rx) = mpsc::channel();
		rt.run_cell(run_id, code, "test.js", false, &rx);
		events.borrow().clone()
	}

	#[test]
	fn persistent_state_and_final_expr() {
		let events = Rc::new(RefCell::new(Vec::new()));
		let events_clone = Rc::clone(&events);
		let mut rt = V8SandboxRuntime::new(
			64,
			Box::new(move |msg| {
				events_clone.borrow_mut().push(msg);
			}),
		)
		.expect("runtime");

		let out1 = run_with_events(&mut rt, &events, "r1", "var x = 7; __omp_set_final_expr__((x));");
		assert!(
			out1
				.iter()
				.any(|m| matches!(m, V8Outbound::Text { chunk, .. } if chunk.trim() == "7"))
		);
		assert!(
			out1
				.iter()
				.any(|m| matches!(m, V8Outbound::Result { ok: true, .. }))
		);

		let out2 = run_with_events(&mut rt, &events, "r2", "__omp_set_final_expr__((x * 6));");
		assert!(
			out2
				.iter()
				.any(|m| matches!(m, V8Outbound::Text { chunk, .. } if chunk.trim() == "42"))
		);
		assert!(
			out2
				.iter()
				.any(|m| matches!(m, V8Outbound::Result { ok: true, .. }))
		);
	}

	#[test]
	fn host_globals_absent_and_dynamic_import_rejected() {
		let events = Rc::new(RefCell::new(Vec::new()));
		let events_clone = Rc::clone(&events);
		let mut rt = V8SandboxRuntime::new(
			64,
			Box::new(move |msg| {
				events_clone.borrow_mut().push(msg);
			}),
		)
		.expect("runtime");

		let out = run_with_events(
			&mut rt,
			&events,
			"r1",
			"__omp_set_final_expr__(({ bun: typeof Bun, deno: typeof Deno, proc: typeof process, \
			 req: typeof require, f: typeof fetch, ws: typeof WebSocket, st: typeof setTimeout, \
			 v8raw: typeof __v8_call_tool }));",
		);
		let text = out
			.iter()
			.find_map(|m| match m {
				V8Outbound::Text { chunk, .. } => Some(chunk.clone()),
				_ => None,
			})
			.expect("text output");
		assert!(
			text.contains("bun: 'undefined'")
				|| text.contains("bun: \"undefined\"")
				|| text.contains("bun: undefined"),
			"got: {text}"
		);
		assert!(!text.contains("function"), "unexpected function in {text}");

		let out_imp = run_with_events(&mut rt, &events, "r2", "import('node:fs')");
		assert!(out_imp.iter().any(|m| matches!(
			m,
			V8Outbound::Result { ok: false, error: Some(err), .. } if err.message.contains("disabled")
		)));
	}

	#[test]
	fn tool_call_and_url_roundtrip() {
		let events = Rc::new(RefCell::new(Vec::new()));
		let events_clone = Rc::clone(&events);
		let (tx, rx) = mpsc::channel();
		let mut rt = V8SandboxRuntime::new(
			64,
			Box::new(move |msg| {
				if let V8Outbound::ToolCall { id, name, .. } = &msg {
					assert_eq!(name, "echo");
					let _ = tx.send(V8Inbound::ToolReply {
						id:    id.clone(),
						ok:    true,
						value: Some(serde_json::json!({ "ok": 123 })),
						error: None,
					});
				}
				events_clone.borrow_mut().push(msg);
			}),
		)
		.expect("runtime");

		rt.run_cell(
			"r1",
			"(async () => { const res = await tool.echo({ a: 1 }); __omp_set_final_expr__((res.ok)); \
			 })()",
			"test.js",
			false,
			&rx,
		);
		let out = events.borrow();
		assert!(
			out.iter()
				.any(|m| matches!(m, V8Outbound::Text { chunk, .. } if chunk.trim() == "123"))
		);
		assert!(
			out.iter()
				.any(|m| matches!(m, V8Outbound::Result { ok: true, .. }))
		);
	}

	#[test]
	fn infinite_loop_cancelled_via_tracker() {
		let events = Rc::new(RefCell::new(Vec::new()));
		let events_clone = Rc::clone(&events);
		let mut rt = V8SandboxRuntime::new(
			64,
			Box::new(move |msg| {
				events_clone.borrow_mut().push(msg);
			}),
		)
		.expect("runtime");

		let tracker = rt.tracker();
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(50));
			tracker.handle_async_inbound(&V8Inbound::Cancel { run_id: "r_inf".into() });
		});

		let (_tx, rx) = mpsc::channel();
		rt.run_cell("r_inf", "while (true) {}", "inf.js", false, &rx);
		let out = events.borrow();
		assert!(out.iter().any(|m| matches!(
			m,
			V8Outbound::Result { ok: false, error: Some(err), .. } if err.is_abort == Some(true)
		)));
	}

	#[test]
	fn heap_limit_enforced_cleanly() {
		let events = Rc::new(RefCell::new(Vec::new()));
		let events_clone = Rc::clone(&events);
		let mut rt = V8SandboxRuntime::new(
			16,
			Box::new(move |msg| {
				events_clone.borrow_mut().push(msg);
			}),
		)
		.expect("runtime");

		let (_tx, rx) = mpsc::channel();
		rt.run_cell(
			"r_oom",
			"const arr = []; while (true) { arr.push(new Array(10000).fill('x')); }",
			"oom.js",
			false,
			&rx,
		);
		let out = events.borrow();
		assert!(out.iter().any(|m| matches!(
			m,
			V8Outbound::Result { ok: false, error: Some(err), .. }
				if err.name.as_deref() == Some("RangeError") && err.message.contains("heap limit exceeded")
		)));
	}

	#[test]
	fn deadlocked_promise_fails_cleanly() {
		let events = Rc::new(RefCell::new(Vec::new()));
		let events_clone = Rc::clone(&events);
		let mut rt = V8SandboxRuntime::new(
			64,
			Box::new(move |msg| {
				events_clone.borrow_mut().push(msg);
			}),
		)
		.expect("runtime");

		let out = run_with_events(&mut rt, &events, "r_hang", "new Promise(() => {})");
		assert!(out.iter().any(|m| matches!(
			m,
			V8Outbound::Result { ok: false, error: Some(err), .. }
				if err.message.contains("no pending host operations")
		)));
	}
}
