//! End-of-task write coalescing for the JS thread.
//!
//! Every connection that gained corked bytes during the current JS task is
//! listed here; one `queueMicrotask` per task then flushes them all, so a
//! burst of sends costs one syscall per connection instead of one per frame
//! (the `uncork`-on-next-tick idea of Node streams). The flush runs before any
//! awaited continuation of the sending code, so request/response latency only
//! pays one microtask.

use std::{cell::RefCell, ptr, sync::Arc};

use napi::{Env, JsValue, Result, check_status, sys};

use super::conn::Shared;

/// `queueMicrotask` and the native flush callback, referenced once per env.
struct FlushFns {
	env:             sys::napi_env,
	queue_microtask: sys::napi_ref,
	flush:           sys::napi_ref,
}

thread_local! {
	/// Connections whose cork flushes at the end of the current JS task.
	static CORKED: RefCell<Vec<Arc<Shared>>> = const { RefCell::new(Vec::new()) };
	/// The JS thread's flush functions. The references are deliberately never
	/// deleted: they live as long as the env, and a stale entry from a torn
	/// down env on the same thread is replaced, not dereferenced.
	static FLUSH_FNS: RefCell<Option<FlushFns>> = const { RefCell::new(None) };
}

/// Flush `shared`'s cork at the end of the current JS task.
pub fn schedule(env: &Env, shared: &Arc<Shared>) -> Result<()> {
	let first = CORKED.with_borrow_mut(|corked| {
		corked.push(Arc::clone(shared));
		corked.len() == 1
	});
	if first && let Err(error) = queue_flush(env) {
		// Never strand bytes: without a microtask, write them now.
		flush_all();
		return Err(error);
	}
	Ok(())
}

fn flush_all() {
	for shared in CORKED.take() {
		shared.flush_cork();
	}
}

fn queue_flush(env: &Env) -> Result<()> {
	let raw_env = env.raw();
	let (queue_microtask, flush) = FLUSH_FNS.with_borrow_mut(|cached| -> Result<_> {
		if let Some(fns) = cached.as_ref()
			&& fns.env == raw_env
		{
			return Ok((fns.queue_microtask, fns.flush));
		}
		let mut global = ptr::null_mut();
		// SAFETY: `raw_env` is the live env of the current JS-thread call.
		let status = unsafe { sys::napi_get_global(raw_env, &mut global) };
		check_status!(status, "get global")?;
		let mut queue_microtask = ptr::null_mut();
		// SAFETY: `global` is a live object of `raw_env`; the key is
		// NUL-terminated.
		let status = unsafe {
			sys::napi_get_named_property(
				raw_env,
				global,
				c"queueMicrotask".as_ptr(),
				&mut queue_microtask,
			)
		};
		check_status!(status, "get queueMicrotask")?;
		let flush = env.create_function_from_closure::<(), (), _>("ipcFlushCorks", |_| {
			flush_all();
			Ok(())
		})?;
		let fns = FlushFns {
			env:             raw_env,
			queue_microtask: reference(raw_env, queue_microtask)?,
			flush:           reference(raw_env, flush.value().value)?,
		};
		let refs = (fns.queue_microtask, fns.flush);
		*cached = Some(fns);
		Ok(refs)
	})?;
	let queue_microtask = dereference(raw_env, queue_microtask)?;
	let flush = dereference(raw_env, flush)?;
	let mut receiver = ptr::null_mut();
	// SAFETY: `raw_env` is the live env of the current JS-thread call.
	let status = unsafe { sys::napi_get_undefined(raw_env, &mut receiver) };
	check_status!(status, "get undefined")?;
	let mut ignored = ptr::null_mut();
	// SAFETY: all handles belong to `raw_env`; `flush` is one valid argument.
	let status = unsafe {
		sys::napi_call_function(raw_env, receiver, queue_microtask, 1, &flush, &mut ignored)
	};
	check_status!(status, "queueMicrotask")
}

fn reference(env: sys::napi_env, value: sys::napi_value) -> Result<sys::napi_ref> {
	let mut reference = ptr::null_mut();
	// SAFETY: `value` is a live handle of `env`, the current JS-thread env.
	let status = unsafe { sys::napi_create_reference(env, value, 1, &mut reference) };
	check_status!(status, "reference flush function")?;
	Ok(reference)
}

fn dereference(env: sys::napi_env, reference: sys::napi_ref) -> Result<sys::napi_value> {
	let mut value = ptr::null_mut();
	// SAFETY: `reference` was created on `env` and is never deleted.
	let status = unsafe { sys::napi_get_reference_value(env, reference, &mut value) };
	check_status!(status, "load flush function")?;
	Ok(value)
}
