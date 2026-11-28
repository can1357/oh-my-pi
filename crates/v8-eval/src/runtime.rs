use std::{
	collections::HashMap,
	ffi::c_void,
	sync::{
		Arc, Mutex, Once,
		atomic::{AtomicBool, Ordering},
		mpsc::Receiver,
	},
};

use serde::Deserialize;

use crate::{
	allocator::bounded_allocator,
	protocol::{BridgeOp, V8ErrorPayload, V8Inbound, V8Outbound},
};

const PRELUDE_JS: &str = include_str!("prelude.js");
const NEAR_HEAP_HEADROOM_BYTES: usize = 16 * 1024 * 1024;

static V8_INIT: Once = Once::new();

pub fn init_v8_platform() {
	V8_INIT.call_once(|| {
		v8::V8::set_flags_from_string(
			"--nominor_gc_task --single_threaded_gc --noconcurrent_recompilation \
			 --nolazy_compile_dispatcher --noparallel_reclaim_unmodified_wrappers",
		);
		let platform = v8::new_default_platform(1, false).make_shared();
		v8::V8::initialize_platform(platform);
		v8::V8::initialize();
	});
}

pub struct RunControl {
	active_run_id:       Mutex<Option<String>>,
	cancel_flag:         AtomicBool,
	heap_limit_exceeded: AtomicBool,
	isolate_handle:      v8::IsolateHandle,
}

impl RunControl {
	pub fn handle_async_inbound(&self, msg: &V8Inbound) {
		match msg {
			V8Inbound::Cancel { run_id } => {
				let matches = self
					.active_run_id
					.lock()
					.is_ok_and(|guard| guard.as_deref() == Some(run_id.as_str()));
				if matches {
					self.cancel_flag.store(true, Ordering::Release);
					self.isolate_handle.terminate_execution();
				}
			},
			V8Inbound::Close => self.terminate_on_eof(),
			V8Inbound::Run { .. } | V8Inbound::ToolReply { .. } => {},
		}
	}

	pub fn terminate_on_eof(&self) {
		self.cancel_flag.store(true, Ordering::Release);
		self.isolate_handle.terminate_execution();
	}
}

unsafe extern "C" fn on_near_heap_limit(
	data: *mut c_void,
	current_heap_limit: usize,
	_initial_heap_limit: usize,
) -> usize {
	if !data.is_null() {
		// SAFETY: `data` is `Arc::as_ptr(&control)` and `Drop` removes this
		// callback before `isolate` and `control` drop.
		let control = unsafe { &*(data as *const RunControl) };
		let already_exceeded = control.heap_limit_exceeded.swap(true, Ordering::AcqRel);
		control.isolate_handle.terminate_execution();
		if already_exceeded {
			return current_heap_limit;
		}
	}
	current_heap_limit.saturating_add(NEAR_HEAP_HEADROOM_BYTES)
}

const unsafe extern "C" fn disallow_wasm_codegen(
	_context: v8::Local<v8::Context>,
	_source: v8::Local<v8::String>,
) -> bool {
	false
}

fn host_import_module_dynamically<'s>(
	scope: &mut v8::PinScope<'s, '_>,
	_host_defined_options: v8::Local<'s, v8::Data>,
	_resource_name: v8::Local<'s, v8::Value>,
	_specifier: v8::Local<'s, v8::String>,
	_import_attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
	let resolver = v8::PromiseResolver::new(scope)?;
	let msg = v8::String::new(scope, "Dynamic import() is disabled in the V8 sandbox")?;
	let err = v8::Exception::type_error(scope, msg);
	resolver.reject(scope, err);
	Some(resolver.get_promise(scope))
}

struct ActiveRun {
	run_id:            String,
	pending_resolvers: HashMap<String, v8::Global<v8::PromiseResolver>>,
	final_expr:        Option<v8::Global<v8::Value>>,
}

impl ActiveRun {
	fn new(run_id: &str) -> Self {
		Self {
			run_id:            run_id.to_string(),
			pending_resolvers: HashMap::new(),
			final_expr:        None,
		}
	}
}

struct BridgeState {
	active_run:    Option<ActiveRun>,
	next_call_seq: u64,
	max_heap_mb:   u64,
	should_close:  bool,
	control:       Arc<RunControl>,
	emit:          Box<dyn FnMut(V8Outbound)>,
}

impl BridgeState {
	fn emit(&mut self, msg: V8Outbound) {
		(self.emit)(msg);
	}

	fn next_id(&mut self) -> String {
		self.next_call_seq = self.next_call_seq.saturating_add(1);
		format!("call-{}", self.next_call_seq)
	}
}

pub struct V8SandboxRuntime {
	// Drop order matters: `context` before `isolate`, `isolate` before
	// `control`.
	context: v8::Global<v8::Context>,
	isolate: v8::OwnedIsolate,
	control: Arc<RunControl>,
}

impl Drop for V8SandboxRuntime {
	fn drop(&mut self) {
		self
			.isolate
			.remove_near_heap_limit_callback(on_near_heap_limit, 0);
	}
}

impl V8SandboxRuntime {
	pub fn new(max_heap_mb: u64, emit: Box<dyn FnMut(V8Outbound)>) -> Result<Self, String> {
		init_v8_platform();
		let clamped_mb = max_heap_mb.clamp(16, 2048);
		let max_bytes = (clamped_mb as usize) * 1024 * 1024;
		let params = v8::CreateParams::default()
			.heap_limits(0, max_bytes)
			.array_buffer_allocator(bounded_allocator(max_bytes))
			.allow_atomics_wait(false);
		let mut isolate = v8::Isolate::new(params);
		isolate.set_host_import_module_dynamically_callback(host_import_module_dynamically);
		isolate.set_allow_wasm_code_generation_callback(disallow_wasm_codegen);

		let control = Arc::new(RunControl {
			active_run_id:       Mutex::new(None),
			cancel_flag:         AtomicBool::new(false),
			heap_limit_exceeded: AtomicBool::new(false),
			isolate_handle:      isolate.thread_safe_handle(),
		});
		isolate.set_slot(BridgeState {
			active_run: None,
			next_call_seq: 0,
			max_heap_mb: clamped_mb,
			should_close: false,
			control: Arc::clone(&control),
			emit,
		});

		let context = {
			v8::scope!(let scope, &mut isolate);
			let context = v8::Context::new(scope, Default::default());
			let mut ctx_scope = v8::ContextScope::new(scope, context);
			install_prelude(&mut ctx_scope)?;
			v8::Global::new(&ctx_scope, context)
		};

		isolate
			.add_near_heap_limit_callback(on_near_heap_limit, Arc::as_ptr(&control).cast_mut().cast());
		Ok(Self { context, isolate, control })
	}

	pub fn tracker(&self) -> Arc<RunControl> {
		Arc::clone(&self.control)
	}

	pub fn emit_outbound(&mut self, msg: V8Outbound) {
		if let Some(state) = self.isolate.get_slot_mut::<BridgeState>() {
			state.emit(msg);
		}
	}

	pub fn run_cell(
		&mut self,
		run_id: &str,
		code: &str,
		filename: &str,
		suppress_final_expr: bool,
		emit_completion_value: bool,
		rx: &Receiver<V8Inbound>,
	) -> bool {
		self.control.cancel_flag.store(false, Ordering::Release);
		self
			.control
			.heap_limit_exceeded
			.store(false, Ordering::Release);
		self.isolate.cancel_terminate_execution();

		if let Ok(mut guard) = self.control.active_run_id.lock() {
			*guard = Some(run_id.to_string());
		}
		if let Some(state) = self.isolate.get_slot_mut::<BridgeState>() {
			state.active_run = Some(ActiveRun::new(run_id));
			state.should_close = false;
		}

		let outcome = self.run_cell_inner(
			run_id,
			code,
			filename,
			suppress_final_expr,
			emit_completion_value,
			rx,
		);

		if let Ok(mut guard) = self.control.active_run_id.lock() {
			*guard = None;
		}
		let should_close = self
			.isolate
			.get_slot_mut::<BridgeState>()
			.is_some_and(|state| {
				state.active_run = None;
				state.should_close
			});

		let outcome = if outcome.is_ok() && self.control.cancel_flag.swap(false, Ordering::AcqRel) {
			Err(V8ErrorPayload::abort("Execution aborted"))
		} else {
			outcome
		};

		match outcome {
			Ok(()) => self.emit_outbound(V8Outbound::Result {
				run_id: run_id.to_string(),
				ok:     true,
				error:  None,
			}),
			Err(err) => self.emit_outbound(V8Outbound::Result {
				run_id: run_id.to_string(),
				ok:     false,
				error:  Some(err),
			}),
		}

		should_close
	}

	fn run_cell_inner(
		&mut self,
		run_id: &str,
		code: &str,
		filename: &str,
		suppress_final_expr: bool,
		emit_completion_value: bool,
		rx: &Receiver<V8Inbound>,
	) -> Result<(), V8ErrorPayload> {
		v8::scope!(let scope, &mut self.isolate);
		let context = v8::Local::new(scope, &self.context);
		let mut ctx_scope = v8::ContextScope::new(scope, context);

		let res = (|| -> Result<(), V8ErrorPayload> {
			let tc = std::pin::pin!(v8::TryCatch::new(&mut ctx_scope));
			let mut tc = tc.init();

			let source = v8::String::new(&tc, code)
				.ok_or_else(|| V8ErrorPayload::new("Failed to allocate V8 source string"))?;
			let resource_name = v8::String::new(&tc, filename)
				.ok_or_else(|| V8ErrorPayload::new("Failed to allocate V8 filename string"))?;
			let origin = v8::ScriptOrigin::new(
				&tc,
				resource_name.into(),
				0,
				0,
				false,
				-1,
				None,
				false,
				false,
				false,
				None,
			);

			let script = v8::Script::compile(&tc, source, Some(&origin))
				.ok_or_else(|| extract_try_catch_error(&mut tc))?;
			let result_val = script
				.run(&tc)
				.ok_or_else(|| extract_try_catch_error(&mut tc))?;

			tc.perform_microtask_checkpoint();
			if tc.has_caught() || tc.has_terminated() {
				return Err(extract_try_catch_error(&mut tc));
			}

			let root_settled_val = if let Ok(promise) = v8::Local::<v8::Promise>::try_from(result_val)
			{
				drive_promise(&mut tc, promise, run_id, rx)?
			} else {
				result_val
			};

			let final_expr = tc
				.get_slot_mut::<BridgeState>()
				.and_then(|s| s.active_run.as_mut())
				.and_then(|r| r.final_expr.take());

			let value_to_emit = if suppress_final_expr {
				None
			} else if let Some(val_global) = final_expr {
				let val = v8::Local::new(&tc, &val_global);
				if let Ok(promise) = v8::Local::<v8::Promise>::try_from(val) {
					Some(drive_promise(&mut tc, promise, run_id, rx)?)
				} else {
					Some(val)
				}
			} else if emit_completion_value {
				Some(root_settled_val)
			} else {
				None
			};

			if let Some(val) = value_to_emit {
				let global = context.global(&tc);
				if let Some(key) = v8::String::new(&tc, "__omp_emit_final_expr__")
					&& let Some(emit_val) = global.get(&tc, key.into())
					&& let Ok(emit_fn) = v8::Local::<v8::Function>::try_from(emit_val)
				{
					emit_fn.call(&tc, global.into(), &[val]);
					if tc.has_caught() || tc.has_terminated() {
						return Err(extract_try_catch_error(&mut tc));
					}
				}
			}

			Ok(())
		})();

		let finished_run = ctx_scope
			.get_slot_mut::<BridgeState>()
			.and_then(|s| s.active_run.take());
		if let Some(run) = finished_run
			&& !run.pending_resolvers.is_empty()
		{
			reject_resolvers(
				&ctx_scope,
				run.pending_resolvers.into_values(),
				"V8 cell finished before host call settled",
				false,
			);
		}

		res
	}
}

fn drive_promise<'s>(
	tc: &mut v8::PinnedRef<'s, v8::TryCatch<'_, '_, v8::HandleScope<'_>>>,
	promise: v8::Local<'s, v8::Promise>,
	run_id: &str,
	rx: &Receiver<V8Inbound>,
) -> Result<v8::Local<'s, v8::Value>, V8ErrorPayload> {
	loop {
		match promise.state() {
			v8::PromiseState::Fulfilled => return Ok(promise.result(tc)),
			v8::PromiseState::Rejected => {
				let reason = promise.result(tc);
				return Err(format_js_value_error(tc, reason, None));
			},
			v8::PromiseState::Pending => {
				let has_pending = tc
					.get_slot::<BridgeState>()
					.and_then(|s| s.active_run.as_ref())
					.is_some_and(|r| !r.pending_resolvers.is_empty());
				if !has_pending {
					return Err(V8ErrorPayload::new(
						"Top-level Promise settled neither resolved nor rejected (no pending host \
						 operations)",
					));
				}
				match rx.recv() {
					Ok(V8Inbound::ToolReply { id, ok, value, error }) => {
						let resolver_global = tc
							.get_slot_mut::<BridgeState>()
							.and_then(|s| s.active_run.as_mut())
							.and_then(|r| r.pending_resolvers.remove(&id));
						if let Some(resolver_global) = resolver_global {
							let resolver = v8::Local::new(tc, &resolver_global);
							if ok {
								let val =
									json_to_v8(tc, value.as_ref().unwrap_or(&serde_json::Value::Null))
										.unwrap_or_else(|_| v8::undefined(tc).into());
								resolver.resolve(tc, val);
							} else {
								let err_payload =
									error.unwrap_or_else(|| V8ErrorPayload::new("Tool call failed"));
								let err_val = v8_error_from_payload(tc, &err_payload);
								resolver.reject(tc, err_val);
							}
						}
						tc.perform_microtask_checkpoint();
						if tc.has_caught() || tc.has_terminated() {
							return Err(extract_try_catch_error(tc));
						}
					},
					Ok(V8Inbound::Run { run_id: busy_id, .. }) => {
						if let Some(state) = tc.get_slot_mut::<BridgeState>() {
							state.emit(V8Outbound::Result {
								run_id: busy_id,
								ok:     false,
								error:  Some(V8ErrorPayload::new(
									"V8 isolate is busy executing another cell",
								)),
							});
						}
					},
					Ok(V8Inbound::Cancel { run_id: cancel_id }) => {
						if cancel_id == run_id {
							reject_all_pending(tc, "Execution aborted", true);
							return Err(V8ErrorPayload::abort("Execution aborted"));
						}
					},
					Ok(V8Inbound::Close) | Err(_) => {
						if let Some(state) = tc.get_slot_mut::<BridgeState>() {
							state.should_close = true;
						}
						reject_all_pending(tc, "V8 runtime closed", true);
						return Err(V8ErrorPayload::abort("V8 runtime closed"));
					},
				}
			},
		}
	}
}

fn reject_all_pending(scope: &mut v8::PinScope<'_, '_>, message: &str, is_abort: bool) {
	let pending: Vec<v8::Global<v8::PromiseResolver>> = scope
		.get_slot_mut::<BridgeState>()
		.and_then(|s| s.active_run.as_mut())
		.map_or_default(|run| run.pending_resolvers.drain().map(|(_, v)| v).collect());
	reject_resolvers(scope, pending, message, is_abort);
}

fn reject_resolvers(
	scope: &v8::PinScope<'_, '_>,
	resolvers: impl IntoIterator<Item = v8::Global<v8::PromiseResolver>>,
	message: &str,
	is_abort: bool,
) {
	let payload = if is_abort {
		V8ErrorPayload::abort(message)
	} else {
		V8ErrorPayload::new(message)
	};
	for resolver_global in resolvers {
		let resolver = v8::Local::new(scope, &resolver_global);
		let err_val = v8_error_from_payload(scope, &payload);
		resolver.reject(scope, err_val);
	}
}

fn install_prelude(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String> {
	let global = scope.get_current_context().global(scope);
	bind_fn(scope, global, "__v8_text", cb_text)?;
	bind_fn(scope, global, "__v8_display", cb_display)?;
	bind_fn(scope, global, "__v8_call_tool", cb_call_tool)?;
	bind_fn(scope, global, "__v8_url_read", cb_url_read)?;
	bind_fn(scope, global, "__v8_url_write", cb_url_write)?;
	bind_fn(scope, global, "__v8_set_final_expr", cb_set_final_expr)?;
	bind_fn(scope, global, "__v8_utf8_encode", cb_utf8_encode)?;
	bind_fn(scope, global, "__v8_utf8_decode", cb_utf8_decode)?;

	let tc = std::pin::pin!(v8::TryCatch::new(scope));
	let tc = tc.init();
	let src = v8::String::new(&tc, PRELUDE_JS).ok_or("Failed to allocate prelude string")?;
	let name = v8::String::new(&tc, "[omp-v8-prelude]").ok_or("Failed to allocate prelude name")?;
	let origin =
		v8::ScriptOrigin::new(&tc, name.into(), 0, 0, false, -1, None, false, false, false, None);
	let script =
		v8::Script::compile(&tc, src, Some(&origin)).ok_or("Failed to compile V8 prelude")?;
	if script.run(&tc).is_none() || tc.has_caught() {
		let msg = tc.exception().and_then(|e| e.to_string(&tc)).map_or_else(
			|| "Unknown prelude initialization error".to_string(),
			|s| s.to_rust_string_lossy(&tc),
		);
		return Err(msg);
	}
	Ok(())
}

fn bind_fn(
	scope: &mut v8::PinScope<'_, '_>,
	global: v8::Local<'_, v8::Object>,
	name: &str,
	callback: impl v8::MapFnTo<v8::FunctionCallback>,
) -> Result<(), String> {
	let key =
		v8::String::new(scope, name).ok_or_else(|| format!("Failed to allocate key {name}"))?;
	let func = v8::Function::new(scope, callback)
		.ok_or_else(|| format!("Failed to create function {name}"))?;
	global.set(scope, key.into(), func.into());
	Ok(())
}

fn cb_utf8_encode(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	mut rv: v8::ReturnValue,
) {
	let text = args.get(0).to_rust_string_lossy(scope);
	let bytes = text.as_bytes();
	let ab = v8::ArrayBuffer::new(scope, bytes.len());
	let bs = ab.get_backing_store();
	for (slot, &b) in bs.iter().zip(bytes) {
		slot.set(b);
	}
	let Some(arr) = v8::Uint8Array::new(scope, ab, 0, bytes.len()) else {
		throw_type_error(scope, "Failed to allocate Uint8Array");
		return;
	};
	rv.set(arr.into());
}

fn cb_utf8_decode(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	mut rv: v8::ReturnValue,
) {
	let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(args.get(0)) else {
		throw_type_error(scope, "TextDecoder.decode() expects an ArrayBuffer or ArrayBufferView");
		return;
	};
	let fatal = args.get(1).boolean_value(scope);
	let ignore_bom = args.get(2).boolean_value(scope);
	let mut buf = vec![0u8; view.byte_length()];
	view.copy_contents(&mut buf);
	let slice = if !ignore_bom && buf.starts_with(&[0xef, 0xbb, 0xbf]) {
		&buf[3..]
	} else {
		&buf[..]
	};
	let decoded = if fatal {
		let Ok(s) = std::str::from_utf8(slice) else {
			throw_type_error(scope, "The encoded data was not valid.");
			return;
		};
		std::borrow::Cow::Borrowed(s)
	} else {
		String::from_utf8_lossy(slice)
	};
	let Some(out) = v8::String::new(scope, &decoded) else {
		throw_type_error(scope, "Failed to allocate decoded string");
		return;
	};
	rv.set(out.into());
}

fn cb_text(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	_rv: v8::ReturnValue,
) {
	let chunk = args.get(0).to_rust_string_lossy(scope);
	const MAX_CHUNK_BYTES: usize = 1024 * 1024;
	if let Some(state) = scope.get_slot_mut::<BridgeState>()
		&& let Some(run_id) = state.active_run.as_ref().map(|r| r.run_id.clone())
	{
		if chunk.len() <= MAX_CHUNK_BYTES {
			state.emit(V8Outbound::Text { run_id, chunk });
		} else {
			let mut start = 0;
			while start < chunk.len() {
				let mut end = (start + MAX_CHUNK_BYTES).min(chunk.len());
				while end > start && !chunk.is_char_boundary(end) {
					end -= 1;
				}
				if end == start {
					end = chunk.len();
				}
				state.emit(V8Outbound::Text {
					run_id: run_id.clone(),
					chunk:  chunk[start..end].to_string(),
				});
				start = end;
			}
		}
	}
}

fn cb_display(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	_rv: v8::ReturnValue,
) {
	let output = match v8_to_raw_json(scope, args.get(0)) {
		Ok(val) => val,
		Err(msg) => {
			throw_type_error(scope, &msg);
			return;
		},
	};
	if let Some(state) = scope.get_slot_mut::<BridgeState>()
		&& let Some(run_id) = state.active_run.as_ref().map(|r| r.run_id.clone())
	{
		state.emit(V8Outbound::Display { run_id, output });
	}
}

fn cb_set_final_expr(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	mut rv: v8::ReturnValue,
) {
	let val = args.get(0);
	let global_val = v8::Global::new(scope, val);
	if let Some(run) = scope
		.get_slot_mut::<BridgeState>()
		.and_then(|s| s.active_run.as_mut())
	{
		run.final_expr = Some(global_val);
	}
	rv.set(val);
}

fn dispatch_bridge_call(
	scope: &mut v8::PinScope<'_, '_>,
	mut rv: v8::ReturnValue,
	outside_err: &str,
	op: BridgeOp,
) {
	let Some(resolver) = v8::PromiseResolver::new(scope) else {
		throw_type_error(scope, "Failed to allocate PromiseResolver");
		return;
	};
	let promise = resolver.get_promise(scope);

	let has_active_run = scope
		.get_slot::<BridgeState>()
		.is_some_and(|s| s.active_run.is_some());
	if has_active_run {
		let resolver_global = v8::Global::new(scope, resolver);
		if let Some(state) = scope.get_slot_mut::<BridgeState>() {
			let id = state.next_id();
			if let Some(run) = state.active_run.as_mut() {
				let run_id = run.run_id.clone();
				run.pending_resolvers.insert(id.clone(), resolver_global);
				state.emit(V8Outbound::BridgeCall { id, run_id, op });
			}
		}
	} else {
		let err = V8ErrorPayload::new(outside_err);
		let err_val = v8_error_from_payload(scope, &err);
		resolver.reject(scope, err_val);
	}
	rv.set(promise.into());
}

fn cb_call_tool(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	rv: v8::ReturnValue,
) {
	let name = args.get(0).to_rust_string_lossy(scope);
	let arg_val = args.get(1);
	let tool_args = if arg_val.is_undefined() || arg_val.is_null() {
		serde_json::value::RawValue::from_string("{}".to_string()).expect("empty json object")
	} else {
		match v8_to_raw_json(scope, arg_val) {
			Ok(val) => val,
			Err(msg) => {
				throw_type_error(scope, &msg);
				return;
			},
		}
	};
	dispatch_bridge_call(scope, rv, "tool call outside active V8 run", BridgeOp::Tool {
		name,
		args: tool_args,
	});
}

#[derive(Deserialize)]
struct ReadOptions {
	offset: Option<u64>,
	#[expect(dead_code, reason = "validated during serde deserialization")]
	limit:  Option<u64>,
}

fn cb_url_read(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	rv: v8::ReturnValue,
) {
	let path = args.get(0).to_rust_string_lossy(scope);
	let opt_val = args.get(1);
	let options = if opt_val.is_undefined() || opt_val.is_null() {
		None
	} else {
		match v8_to_raw_json(scope, opt_val) {
			Ok(raw)
				if serde_json::from_str::<ReadOptions>(raw.get())
					.is_ok_and(|o| o.offset != Some(0)) =>
			{
				Some(raw)
			},
			Ok(_) => {
				throw_type_error(
					scope,
					"read() options offset (>= 1) and limit (>= 0) must be integers",
				);
				return;
			},
			Err(msg) => {
				throw_type_error(scope, &msg);
				return;
			},
		}
	};
	dispatch_bridge_call(scope, rv, "url read outside active V8 run", BridgeOp::Read {
		path,
		options,
	});
}

fn cb_url_write(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	rv: v8::ReturnValue,
) {
	let path = args.get(0).to_rust_string_lossy(scope);
	let data = args.get(1).to_rust_string_lossy(scope);
	let encoding = if args.get(2).to_rust_string_lossy(scope) == "base64" {
		"base64".to_string()
	} else {
		"utf8".to_string()
	};
	dispatch_bridge_call(scope, rv, "url write outside active V8 run", BridgeOp::Write {
		path,
		data,
		encoding,
	});
}

fn throw_type_error(scope: &v8::PinScope<'_, '_>, message: &str) {
	if let Some(msg) = v8::String::new(scope, message) {
		let err = v8::Exception::type_error(scope, msg);
		scope.throw_exception(err);
	}
}

fn v8_to_raw_json(
	scope: &mut v8::PinScope<'_, '_>,
	value: v8::Local<'_, v8::Value>,
) -> Result<Box<serde_json::value::RawValue>, String> {
	if value.is_undefined() {
		return serde_json::value::RawValue::from_string("null".to_string())
			.map_err(|err| err.to_string());
	}
	let tc = std::pin::pin!(v8::TryCatch::new(scope));
	let tc = tc.init();
	let Some(json_str) = v8::json::stringify(&tc, value) else {
		let reason = tc.exception().and_then(|e| e.to_string(&tc)).map_or_else(
			|| "Value cannot be JSON-serialized across the V8 sandbox boundary".to_string(),
			|s| s.to_rust_string_lossy(&tc),
		);
		return Err(reason);
	};
	let raw = json_str.to_rust_string_lossy(&tc);
	serde_json::value::RawValue::from_string(raw)
		.map_err(|err| format!("Failed to parse serialized JSON: {err}"))
}

fn json_to_v8<'s>(
	scope: &v8::PinScope<'s, '_>,
	value: &serde_json::Value,
) -> Result<v8::Local<'s, v8::Value>, String> {
	if value.is_null() {
		return Ok(v8::null(scope).into());
	}
	let raw = serde_json::to_string(value).map_err(|err| err.to_string())?;
	let Some(json_str) = v8::String::new(scope, &raw) else {
		return Err("Failed to allocate JSON string".to_string());
	};
	v8::json::parse(scope, json_str).ok_or_else(|| "Failed to parse JSON into V8 value".to_string())
}

fn v8_error_from_payload<'s>(
	scope: &v8::PinScope<'s, '_>,
	payload: &V8ErrorPayload,
) -> v8::Local<'s, v8::Value> {
	let msg = v8::String::new(scope, &payload.message).unwrap_or_else(|| v8::String::empty(scope));
	let err_val = match payload.name.as_deref() {
		Some("TypeError") => v8::Exception::type_error(scope, msg),
		Some("RangeError") => v8::Exception::range_error(scope, msg),
		Some("ReferenceError") => v8::Exception::reference_error(scope, msg),
		Some("SyntaxError") => v8::Exception::syntax_error(scope, msg),
		_ => v8::Exception::error(scope, msg),
	};
	if let Ok(obj) = v8::Local::<v8::Object>::try_from(err_val) {
		if let Some(name) = &payload.name
			&& let Some(k) = v8::String::new(scope, "name")
			&& let Some(v) = v8::String::new(scope, name)
		{
			obj.set(scope, k.into(), v.into());
		}
		if let Some(stack) = &payload.stack
			&& let Some(k) = v8::String::new(scope, "stack")
			&& let Some(v) = v8::String::new(scope, stack)
		{
			obj.set(scope, k.into(), v.into());
		}
		let is_abort = matches!(payload.name.as_deref(), Some("AbortError" | "ToolAbortError"));
		if is_abort && let Some(k) = v8::String::new(scope, "isAbort") {
			let v = v8::Boolean::new(scope, true);
			obj.set(scope, k.into(), v.into());
		}
		if payload.name.as_deref() == Some("ToolError")
			&& let Some(k) = v8::String::new(scope, "isToolError")
		{
			let v = v8::Boolean::new(scope, true);
			obj.set(scope, k.into(), v.into());
		}
	}
	err_val
}

fn extract_try_catch_error(
	tc: &mut v8::PinnedRef<'_, v8::TryCatch<'_, '_, v8::HandleScope<'_>>>,
) -> V8ErrorPayload {
	if tc.has_terminated() {
		tc.cancel_terminate_execution();
		if let Some(state) = tc.get_slot_mut::<BridgeState>() {
			if state
				.control
				.heap_limit_exceeded
				.swap(false, Ordering::AcqRel)
			{
				state.should_close = true;
				return V8ErrorPayload::named(
					"RangeError",
					format!("V8 isolate heap limit exceeded ({} MiB)", state.max_heap_mb),
				);
			}
			if state.control.cancel_flag.load(Ordering::Acquire) {
				return V8ErrorPayload::abort("Execution aborted");
			}
		}
		return V8ErrorPayload::new("V8 execution terminated");
	}
	let msg = tc.message();
	if let Some(exception) = tc.exception() {
		return format_js_value_error(tc, exception, msg);
	}
	V8ErrorPayload::new("Unknown V8 execution error")
}

fn format_js_value_error(
	scope: &v8::PinScope<'_, '_>,
	value: v8::Local<'_, v8::Value>,
	v8_msg: Option<v8::Local<'_, v8::Message>>,
) -> V8ErrorPayload {
	if let Ok(obj) = v8::Local::<v8::Object>::try_from(value) {
		let get_str = |key_name: &str| -> Option<String> {
			let key = v8::String::new(scope, key_name)?;
			let val = obj.get(scope, key.into())?;
			if val.is_undefined() || val.is_null() {
				return None;
			}
			Some(val.to_rust_string_lossy(scope))
		};
		let name = get_str("name");
		let message = get_str("message").unwrap_or_else(|| value.to_rust_string_lossy(scope));
		let mut stack = get_str("stack");
		if stack.is_none()
			&& let Some(m) = v8_msg
		{
			let line = m.get_line_number(scope).unwrap_or(0);
			let col = m.get_start_column().saturating_add(1);
			let resource = m
				.get_script_resource_name(scope)
				.map_or_else(|| "<eval>".to_string(), |r| r.to_rust_string_lossy(scope));
			stack = Some(match &name {
				Some(n) => format!("{n}: {message}\n    at {resource}:{line}:{col}"),
				None => format!("{message}\n    at {resource}:{line}:{col}"),
			});
		}
		return V8ErrorPayload { name, message, stack };
	}
	V8ErrorPayload::new(value.to_rust_string_lossy(scope))
}
