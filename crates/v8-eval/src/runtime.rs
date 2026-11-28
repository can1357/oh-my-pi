use std::{
	collections::HashMap,
	ffi::c_void,
	sync::{
		Arc, Mutex, Once,
		atomic::{AtomicBool, Ordering},
		mpsc::Receiver,
	},
};

use crate::protocol::{ReadOptions, V8ErrorPayload, V8Inbound, V8Outbound, WriteEncoding};

const PRELUDE_JS: &str = include_str!("prelude.js");
const NEAR_HEAP_HEADROOM_BYTES: usize = 16 * 1024 * 1024;

static V8_INIT: Once = Once::new();

pub fn init_v8_platform() {
	V8_INIT.call_once(|| {
		v8::V8::set_flags_from_string("--no-expose-wasm");
		let platform = v8::new_default_platform(1, false).make_shared();
		v8::V8::initialize_platform(platform);
		v8::V8::initialize();
	});
}

struct NearHeapState {
	handle:   v8::IsolateHandle,
	exceeded: Arc<AtomicBool>,
}

unsafe extern "C" fn on_near_heap_limit(
	data: *mut c_void,
	current_heap_limit: usize,
	_initial_heap_limit: usize,
) -> usize {
	if !data.is_null() {
		// SAFETY: `data` was created by `Box::into_raw` and lives until isolate
		// teardown.
		let state = unsafe { &*(data as *const NearHeapState) };
		state.exceeded.store(true, Ordering::SeqCst);
		state.handle.terminate_execution();
	}
	current_heap_limit.saturating_add(NEAR_HEAP_HEADROOM_BYTES)
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

struct BridgeState {
	active_run_id:     Option<String>,
	next_call_seq:     u64,
	pending_resolvers: HashMap<String, v8::Global<v8::PromiseResolver>>,
	final_expr_set:    bool,
	final_expr_value:  Option<v8::Global<v8::Value>>,
	emit:              Box<dyn FnMut(V8Outbound)>,
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

pub struct RunHandleTracker {
	active_run_id:  Arc<Mutex<Option<String>>>,
	cancel_flag:    Arc<AtomicBool>,
	isolate_handle: v8::IsolateHandle,
}

impl RunHandleTracker {
	pub fn handle_async_inbound(&self, msg: &V8Inbound) {
		match msg {
			V8Inbound::Cancel { run_id } => {
				let matches = self
					.active_run_id
					.lock()
					.is_ok_and(|guard| guard.as_deref() == Some(run_id.as_str()));
				if matches {
					self.cancel_flag.store(true, Ordering::SeqCst);
					self.isolate_handle.terminate_execution();
				}
			},
			V8Inbound::Close => {
				self.cancel_flag.store(true, Ordering::SeqCst);
				self.isolate_handle.terminate_execution();
			},
			V8Inbound::Init | V8Inbound::Run { .. } | V8Inbound::ToolReply { .. } => {},
		}
	}

	pub fn terminate_on_eof(&self) {
		self.cancel_flag.store(true, Ordering::SeqCst);
		self.isolate_handle.terminate_execution();
	}
}

pub struct V8SandboxRuntime {
	isolate:             v8::OwnedIsolate,
	context:             v8::Global<v8::Context>,
	max_heap_mb:         u64,
	heap_limit_exceeded: Arc<AtomicBool>,
	cancel_flag:         Arc<AtomicBool>,
	active_run_tracker:  Arc<Mutex<Option<String>>>,
	near_heap_ptr:       *mut NearHeapState,
}

impl Drop for V8SandboxRuntime {
	fn drop(&mut self) {
		if !self.near_heap_ptr.is_null() {
			// SAFETY: `near_heap_ptr` was allocated via `Box::into_raw` when
			// registering the callback.
			unsafe {
				drop(Box::from_raw(self.near_heap_ptr));
			}
			self.near_heap_ptr = std::ptr::null_mut();
		}
	}
}

impl V8SandboxRuntime {
	pub fn new(max_heap_mb: u64, emit: Box<dyn FnMut(V8Outbound)>) -> Result<Self, String> {
		init_v8_platform();
		let clamped_mb = max_heap_mb.clamp(16, 2048);
		let params = v8::CreateParams::default().heap_limits(0, (clamped_mb as usize) * 1024 * 1024);
		let mut isolate = v8::Isolate::new(params);
		isolate.set_host_import_module_dynamically_callback(host_import_module_dynamically);

		let isolate_handle = isolate.thread_safe_handle();
		let heap_limit_exceeded = Arc::new(AtomicBool::new(false));
		let near_heap_ptr = Box::into_raw(Box::new(NearHeapState {
			handle:   isolate_handle,
			exceeded: Arc::clone(&heap_limit_exceeded),
		}));
		isolate.add_near_heap_limit_callback(on_near_heap_limit, near_heap_ptr.cast());

		isolate.set_slot(BridgeState {
			active_run_id: None,
			next_call_seq: 0,
			pending_resolvers: HashMap::new(),
			final_expr_set: false,
			final_expr_value: None,
			emit,
		});

		let context = {
			v8::scope!(let scope, &mut isolate);
			let context = v8::Context::new(scope, Default::default());
			let mut ctx_scope = v8::ContextScope::new(scope, context);
			install_prelude(&mut ctx_scope)?;
			v8::Global::new(&ctx_scope, context)
		};

		Ok(Self {
			isolate,
			context,
			max_heap_mb: clamped_mb,
			heap_limit_exceeded,
			cancel_flag: Arc::new(AtomicBool::new(false)),
			active_run_tracker: Arc::new(Mutex::new(None)),
			near_heap_ptr,
		})
	}

	pub fn tracker(&self) -> RunHandleTracker {
		RunHandleTracker {
			active_run_id:  Arc::clone(&self.active_run_tracker),
			cancel_flag:    Arc::clone(&self.cancel_flag),
			isolate_handle: self.isolate.thread_safe_handle(),
		}
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
		final_expr_suppressed: bool,
		rx: &Receiver<V8Inbound>,
	) -> bool {
		// Clear any stale termination/heap flags before starting a new run.
		self.cancel_flag.store(false, Ordering::SeqCst);
		self.heap_limit_exceeded.store(false, Ordering::SeqCst);
		self.isolate.cancel_terminate_execution();

		if let Ok(mut guard) = self.active_run_tracker.lock() {
			*guard = Some(run_id.to_string());
		}
		if let Some(state) = self.isolate.get_slot_mut::<BridgeState>() {
			state.active_run_id = Some(run_id.to_string());
			state.pending_resolvers.clear();
			state.final_expr_set = false;
			state.final_expr_value = None;
		}

		let mut should_close = false;
		let outcome =
			self.run_cell_inner(run_id, code, filename, final_expr_suppressed, rx, &mut should_close);

		if let Ok(mut guard) = self.active_run_tracker.lock() {
			*guard = None;
		}
		if let Some(state) = self.isolate.get_slot_mut::<BridgeState>() {
			state.active_run_id = None;
			state.pending_resolvers.clear();
			state.final_expr_set = false;
			state.final_expr_value = None;
		}

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
		final_expr_suppressed: bool,
		rx: &Receiver<V8Inbound>,
		should_close: &mut bool,
	) -> Result<(), V8ErrorPayload> {
		let max_heap_mb = self.max_heap_mb;
		let heap_exceeded = Arc::clone(&self.heap_limit_exceeded);
		let cancel_flag = Arc::clone(&self.cancel_flag);
		let context_global = self.context.clone();

		v8::scope!(let scope, &mut self.isolate);
		let context = v8::Local::new(scope, &context_global);
		let mut ctx_scope = v8::ContextScope::new(scope, context);

		let tc = std::pin::pin!(v8::TryCatch::new(&mut ctx_scope));
		let mut tc = tc.init();

		let Some(source) = v8::String::new(&tc, code) else {
			return Err(V8ErrorPayload::new("Failed to allocate V8 source string"));
		};
		let Some(resource_name) = v8::String::new(&tc, filename) else {
			return Err(V8ErrorPayload::new("Failed to allocate V8 filename string"));
		};
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

		let Some(script) = v8::Script::compile(&tc, source, Some(&origin)) else {
			return Err(extract_try_catch_error(&tc, max_heap_mb, &heap_exceeded, &cancel_flag));
		};

		let Some(result_val) = script.run(&tc) else {
			return Err(extract_try_catch_error(&tc, max_heap_mb, &heap_exceeded, &cancel_flag));
		};

		tc.perform_microtask_checkpoint();
		if tc.has_caught() || tc.has_terminated() {
			return Err(extract_try_catch_error(&tc, max_heap_mb, &heap_exceeded, &cancel_flag));
		}

		if let Ok(promise) = v8::Local::<v8::Promise>::try_from(result_val) {
			loop {
				match promise.state() {
					v8::PromiseState::Fulfilled => break,
					v8::PromiseState::Rejected => {
						let reason = promise.result(&tc);
						return Err(format_js_value_error(&tc, reason, None));
					},
					v8::PromiseState::Pending => {
						let has_pending = tc
							.get_slot::<BridgeState>()
							.is_some_and(|s| !s.pending_resolvers.is_empty());
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
									.and_then(|s| s.pending_resolvers.remove(&id));
								if let Some(resolver_global) = resolver_global {
									let resolver = v8::Local::new(&tc, &resolver_global);
									if ok {
										let val = json_to_v8(
											&tc,
											value.as_ref().unwrap_or(&serde_json::Value::Null),
										)
										.unwrap_or_else(|_| v8::undefined(&tc).into());
										resolver.resolve(&tc, val);
									} else {
										let err_payload =
											error.unwrap_or_else(|| V8ErrorPayload::new("Tool call failed"));
										let err_val = v8_error_from_payload(&tc, &err_payload);
										resolver.reject(&tc, err_val);
									}
								}
								tc.perform_microtask_checkpoint();
								if tc.has_caught() || tc.has_terminated() {
									return Err(extract_try_catch_error(
										&tc,
										max_heap_mb,
										&heap_exceeded,
										&cancel_flag,
									));
								}
							},
							Ok(V8Inbound::Cancel { run_id: cancel_id }) => {
								if cancel_id == run_id {
									reject_all_pending(&mut tc, "Execution aborted", true);
									return Err(V8ErrorPayload {
										name:          Some("AbortError".into()),
										message:       "Execution aborted".into(),
										stack:         None,
										is_abort:      Some(true),
										is_tool_error: None,
									});
								}
							},
							Ok(V8Inbound::Close) | Err(_) => {
								*should_close = true;
								reject_all_pending(&mut tc, "V8 runtime closed", true);
								return Err(V8ErrorPayload {
									name:          Some("AbortError".into()),
									message:       "V8 runtime closed".into(),
									stack:         None,
									is_abort:      Some(true),
									is_tool_error: None,
								});
							},
							Ok(V8Inbound::Init | V8Inbound::Run { .. }) => {},
						}
					},
				}
			}
		}

		let final_val_global = tc.get_slot_mut::<BridgeState>().and_then(|state| {
			if state.final_expr_set && !final_expr_suppressed {
				state.final_expr_value.take()
			} else {
				state.final_expr_value = None;
				None
			}
		});

		if let Some(val_global) = final_val_global {
			let val = v8::Local::new(&tc, &val_global);
			let global = context.global(&tc);
			if let Some(key) = v8::String::new(&tc, "__omp_emit_final_expr__")
				&& let Some(emit_val) = global.get(&tc, key.into())
				&& let Ok(emit_fn) = v8::Local::<v8::Function>::try_from(emit_val)
			{
				emit_fn.call(&tc, global.into(), &[val]);
				if tc.has_caught() || tc.has_terminated() {
					return Err(extract_try_catch_error(&tc, max_heap_mb, &heap_exceeded, &cancel_flag));
				}
			}
		}

		Ok(())
	}
}

fn reject_all_pending(scope: &mut v8::PinScope<'_, '_>, message: &str, is_abort: bool) {
	let pending: Vec<v8::Global<v8::PromiseResolver>> = scope
		.get_slot_mut::<BridgeState>()
		.map_or_default(|state| state.pending_resolvers.drain().map(|(_, v)| v).collect());
	let payload = V8ErrorPayload {
		name:          Some(if is_abort { "AbortError" } else { "Error" }.into()),
		message:       message.into(),
		stack:         None,
		is_abort:      if is_abort { Some(true) } else { None },
		is_tool_error: None,
	};
	for resolver_global in pending {
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

fn cb_text(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	_rv: v8::ReturnValue,
) {
	let chunk = args.get(0).to_rust_string_lossy(scope);
	if let Some(state) = scope.get_slot_mut::<BridgeState>()
		&& let Some(run_id) = state.active_run_id.clone()
	{
		state.emit(V8Outbound::Text { run_id, chunk });
	}
}

fn cb_display(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	_rv: v8::ReturnValue,
) {
	let output = match v8_to_json(scope, args.get(0)) {
		Ok(val) => val,
		Err(msg) => {
			throw_type_error(scope, &msg);
			return;
		},
	};
	if let Some(state) = scope.get_slot_mut::<BridgeState>()
		&& let Some(run_id) = state.active_run_id.clone()
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
	if let Some(state) = scope.get_slot_mut::<BridgeState>() {
		state.final_expr_set = true;
		state.final_expr_value = Some(global_val);
	}
	rv.set(val);
}

fn cb_call_tool(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	mut rv: v8::ReturnValue,
) {
	let name = args.get(0).to_rust_string_lossy(scope);
	let arg_val = args.get(1);
	let tool_args = if arg_val.is_undefined() || arg_val.is_null() {
		serde_json::Value::Object(serde_json::Map::new())
	} else {
		match v8_to_json(scope, arg_val) {
			Ok(val) => val,
			Err(msg) => {
				throw_type_error(scope, &msg);
				return;
			},
		}
	};

	let Some(resolver) = v8::PromiseResolver::new(scope) else {
		throw_type_error(scope, "Failed to allocate PromiseResolver");
		return;
	};
	let promise = resolver.get_promise(scope);
	let resolver_global = v8::Global::new(scope, resolver);

	if let Some(state) = scope.get_slot_mut::<BridgeState>() {
		if let Some(run_id) = state.active_run_id.clone() {
			let id = state.next_id();
			state.pending_resolvers.insert(id.clone(), resolver_global);
			state.emit(V8Outbound::ToolCall { id, run_id, name, args: tool_args });
		} else {
			let err = V8ErrorPayload::new("tool call outside active V8 run");
			let err_val = v8_error_from_payload(scope, &err);
			let local_res = v8::Local::new(scope, &resolver_global);
			local_res.reject(scope, err_val);
		}
	}
	rv.set(promise.into());
}

fn cb_url_read(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	mut rv: v8::ReturnValue,
) {
	let path = args.get(0).to_rust_string_lossy(scope);
	let opt_val = args.get(1);
	let options = if opt_val.is_undefined() || opt_val.is_null() {
		None
	} else {
		match v8_to_json(scope, opt_val) {
			Ok(val) => serde_json::from_value::<ReadOptions>(val).ok(),
			Err(msg) => {
				throw_type_error(scope, &msg);
				return;
			},
		}
	};

	let Some(resolver) = v8::PromiseResolver::new(scope) else {
		throw_type_error(scope, "Failed to allocate PromiseResolver");
		return;
	};
	let promise = resolver.get_promise(scope);
	let resolver_global = v8::Global::new(scope, resolver);

	if let Some(state) = scope.get_slot_mut::<BridgeState>()
		&& let Some(run_id) = state.active_run_id.clone()
	{
		let id = state.next_id();
		state.pending_resolvers.insert(id.clone(), resolver_global);
		state.emit(V8Outbound::UrlRead { id, run_id, path, options });
	}
	rv.set(promise.into());
}

fn cb_url_write(
	scope: &mut v8::PinScope<'_, '_>,
	args: v8::FunctionCallbackArguments,
	mut rv: v8::ReturnValue,
) {
	let path = args.get(0).to_rust_string_lossy(scope);
	let data = args.get(1).to_rust_string_lossy(scope);
	let enc_str = args.get(2).to_rust_string_lossy(scope);
	let encoding = if enc_str == "base64" {
		WriteEncoding::Base64
	} else {
		WriteEncoding::Utf8
	};

	let Some(resolver) = v8::PromiseResolver::new(scope) else {
		throw_type_error(scope, "Failed to allocate PromiseResolver");
		return;
	};
	let promise = resolver.get_promise(scope);
	let resolver_global = v8::Global::new(scope, resolver);

	if let Some(state) = scope.get_slot_mut::<BridgeState>()
		&& let Some(run_id) = state.active_run_id.clone()
	{
		let id = state.next_id();
		state.pending_resolvers.insert(id.clone(), resolver_global);
		state.emit(V8Outbound::UrlWrite { id, run_id, path, data, encoding });
	}
	rv.set(promise.into());
}

fn throw_type_error(scope: &v8::PinScope<'_, '_>, message: &str) {
	if let Some(msg) = v8::String::new(scope, message) {
		let err = v8::Exception::type_error(scope, msg);
		scope.throw_exception(err);
	}
}

fn v8_to_json(
	scope: &mut v8::PinScope<'_, '_>,
	value: v8::Local<'_, v8::Value>,
) -> Result<serde_json::Value, String> {
	if value.is_undefined() {
		return Ok(serde_json::Value::Null);
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
	serde_json::from_str(&raw).map_err(|err| format!("Failed to parse serialized JSON: {err}"))
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
		if payload.is_abort == Some(true)
			&& let Some(k) = v8::String::new(scope, "isAbort")
		{
			let v = v8::Boolean::new(scope, true);
			obj.set(scope, k.into(), v.into());
		}
		if payload.is_tool_error == Some(true)
			&& let Some(k) = v8::String::new(scope, "isToolError")
		{
			let v = v8::Boolean::new(scope, true);
			obj.set(scope, k.into(), v.into());
		}
	}
	err_val
}

fn extract_try_catch_error(
	tc: &v8::PinnedRef<'_, v8::TryCatch<'_, '_, v8::HandleScope<'_>>>,
	max_heap_mb: u64,
	heap_exceeded: &AtomicBool,
	cancel_flag: &AtomicBool,
) -> V8ErrorPayload {
	if tc.has_terminated() {
		tc.cancel_terminate_execution();
		if heap_exceeded.swap(false, Ordering::SeqCst) {
			return V8ErrorPayload {
				name:          Some("RangeError".into()),
				message:       format!("V8 isolate heap limit exceeded ({max_heap_mb} MiB)"),
				stack:         None,
				is_abort:      None,
				is_tool_error: None,
			};
		}
		if cancel_flag.load(Ordering::SeqCst) {
			return V8ErrorPayload {
				name:          Some("AbortError".into()),
				message:       "Execution aborted".into(),
				stack:         None,
				is_abort:      Some(true),
				is_tool_error: None,
			};
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
		let is_abort =
			name.as_deref() == Some("AbortError") || name.as_deref() == Some("ToolAbortError");
		let is_tool_error = name.as_deref() == Some("ToolError");
		return V8ErrorPayload {
			name,
			message,
			stack,
			is_abort: if is_abort { Some(true) } else { None },
			is_tool_error: if is_tool_error { Some(true) } else { None },
		};
	}
	V8ErrorPayload::new(value.to_rust_string_lossy(scope))
}
