//! Privacy-bounded operating-system path monitoring for live voice.
//!
//! The controller consumes the native route-change edge while the actor sees
//! only [`LivePathFacts`]: interface identity/class and network-cost flags. No
//! addresses, SSIDs, gateway identifiers, proxy values, or native path handles
//! cross this module.

use std::future;

use omp_chat::overlays::live::LivePathFacts;
use omp_core::Str;

fn sanitized_interface_identity(name: &str) -> Option<Str> {
	let safe = name.len() <= 32
		&& !name.is_empty()
		&& name.parse::<std::net::IpAddr>().is_err()
		&& name
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
	safe.then(|| Str::from(name))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LivePathUpdate {
	pub(crate) facts:         LivePathFacts,
	pub(crate) route_changed: bool,
}

/// Long-lived native path monitor for one live call.
pub(crate) struct LivePathMonitor {
	updates:  flume::Receiver<LivePathUpdate>,
	shutdown: flume::Sender<()>,
}

impl LivePathMonitor {
	pub(crate) fn start() -> Self {
		let (updates_tx, updates) = flume::unbounded();
		let (shutdown, shutdown_rx) = flume::bounded(1);
		platform::start(updates_tx, shutdown_rx);
		Self { updates, shutdown }
	}

	pub(crate) fn try_changed(&self) -> Option<LivePathUpdate> {
		self.updates.try_recv().ok()
	}

	pub(crate) async fn changed(&self) -> LivePathUpdate {
		match self.updates.recv_async().await {
			Ok(update) => update,
			Err(_) => future::pending().await,
		}
	}
}

impl Drop for LivePathMonitor {
	fn drop(&mut self) {
		let _ = self.shutdown.try_send(());
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CStr, c_char, c_int, c_void},
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
	};

	use block2::RcBlock;
	use dispatch2::DispatchQueue;
	use objc2::runtime::Bool;
	use omp_chat::overlays::live::{LivePathClass, LivePathFacts};
	use omp_core::Str;
	use parking_lot::Mutex;

	use super::{LivePathUpdate, sanitized_interface_identity};

	const NW_PATH_STATUS_SATISFIED: c_int = 1;
	const NW_INTERFACE_TYPE_WIFI: c_int = 1;
	const NW_INTERFACE_TYPE_CELLULAR: c_int = 2;
	const NW_INTERFACE_TYPE_WIRED: c_int = 3;
	const NW_INTERFACE_TYPE_LOOPBACK: c_int = 4;

	#[link(name = "Network", kind = "framework")]
	unsafe extern "C" {
		fn nw_path_monitor_create() -> *mut c_void;
		fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
		fn nw_path_monitor_set_update_handler(monitor: *mut c_void, handler: *mut c_void);
		fn nw_path_monitor_start(monitor: *mut c_void);
		fn nw_path_monitor_cancel(monitor: *mut c_void);
		fn nw_path_get_status(path: *mut c_void) -> c_int;
		fn nw_path_is_constrained(path: *mut c_void) -> bool;
		fn nw_path_is_expensive(path: *mut c_void) -> bool;
		fn nw_path_enumerate_interfaces(path: *mut c_void, block: *mut c_void);
		fn nw_interface_get_name(interface: *mut c_void) -> *const c_char;
		fn nw_interface_get_type(interface: *mut c_void) -> c_int;
	}

	unsafe extern "C" {
		fn objc_release(value: *mut c_void);
	}

	pub(super) fn start(updates: flume::Sender<LivePathUpdate>, shutdown: flume::Receiver<()>) {
		let _ = std::thread::Builder::new()
			.name("omp-live-path".to_owned())
			.spawn(move || run(updates, shutdown));
	}

	fn run(updates: flume::Sender<LivePathUpdate>, shutdown: flume::Receiver<()>) {
		// SAFETY: Network.framework returns a +1 opaque Objective-C object.
		let monitor = unsafe { nw_path_monitor_create() };
		if monitor.is_null() {
			return;
		}
		let queue = DispatchQueue::new("com.ohmypi.live-path", None);
		let seen = Arc::new(AtomicBool::new(false));
		let handler_seen = Arc::clone(&seen);
		let handler = RcBlock::new(move |path: *mut c_void| {
			if path.is_null() {
				return;
			}
			let facts = path_facts(path);
			let route_changed = handler_seen.swap(true, Ordering::AcqRel);
			let _ = updates.send(LivePathUpdate { facts, route_changed });
		});
		// SAFETY: `monitor`, the serial queue, and the heap block remain alive
		// until cancellation below. Network.framework copies the handler.
		unsafe {
			nw_path_monitor_set_update_handler(monitor, RcBlock::as_ptr(&handler).cast());
			nw_path_monitor_set_queue(
				monitor,
				std::ptr::from_ref::<DispatchQueue>(&*queue)
					.cast_mut()
					.cast(),
			);
			nw_path_monitor_start(monitor);
		}
		let _ = shutdown.recv();
		// SAFETY: cancellation and the matching release consume the monitor
		// created above. Its retained queue and copied handler are released by
		// Network.framework after callbacks drain.
		unsafe {
			nw_path_monitor_cancel(monitor);
			objc_release(monitor);
		}
	}

	fn path_facts(path: *mut c_void) -> LivePathFacts {
		let selected = Arc::new(Mutex::new(None));
		let selected_by_block = Arc::clone(&selected);
		let interface_block = RcBlock::new(move |interface: *mut c_void| -> Bool {
			if interface.is_null() {
				return Bool::YES;
			}
			// Network.framework enumerates only interfaces used by this path.
			// Retain the first one as its presentation identity.
			let mut selected = selected_by_block.lock();
			if selected.is_some() {
				return Bool::NO;
			}
			// SAFETY: the interface is valid for this synchronous enumeration.
			let name = unsafe { interface_name(interface) };
			// SAFETY: the interface is valid for this synchronous enumeration.
			let class = unsafe { interface_class(interface) };
			*selected = Some((name, class));
			Bool::NO
		});
		// SAFETY: `path` belongs to the active update callback and the block is
		// alive for the synchronous enumeration.
		unsafe {
			nw_path_enumerate_interfaces(path, RcBlock::as_ptr(&interface_block).cast());
		}
		let selected = selected.lock().clone();
		// SAFETY: all queries are read-only and `path` remains valid throughout
		// the enclosing Network.framework callback.
		let (available, constrained, expensive) = unsafe {
			(
				nw_path_get_status(path) == NW_PATH_STATUS_SATISFIED,
				nw_path_is_constrained(path),
				nw_path_is_expensive(path),
			)
		};
		LivePathFacts {
			available,
			interface: selected.as_ref().and_then(|(name, _)| name.clone()),
			class: selected.and_then(|(_, class)| class),
			constrained: Some(constrained),
			metered: None,
			expensive: Some(expensive),
		}
	}

	unsafe fn interface_name(interface: *mut c_void) -> Option<Str> {
		// SAFETY: caller supplies an interface owned by the current path.
		let raw = unsafe { nw_interface_get_name(interface) };
		if raw.is_null() {
			return None;
		}
		// SAFETY: Network.framework returns a NUL-terminated name whose lifetime
		// covers the callback; copy it into `Str` before returning.
		let name = unsafe { CStr::from_ptr(raw) }.to_str().ok()?;
		sanitized_interface_identity(name)
	}

	unsafe fn interface_class(interface: *mut c_void) -> Option<LivePathClass> {
		// SAFETY: caller supplies an interface owned by the current path.
		Some(match unsafe { nw_interface_get_type(interface) } {
			NW_INTERFACE_TYPE_WIFI => LivePathClass::Wifi,
			NW_INTERFACE_TYPE_CELLULAR => LivePathClass::Cellular,
			NW_INTERFACE_TYPE_WIRED => LivePathClass::Wired,
			NW_INTERFACE_TYPE_LOOPBACK => LivePathClass::Loopback,
			_ => LivePathClass::Other,
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn interface_identity_accepts_native_names_and_rejects_sensitive_shapes() {
		assert_eq!(sanitized_interface_identity("en0").as_deref(), Some("en0"));
		assert_eq!(sanitized_interface_identity("pdp_ip0").as_deref(), Some("pdp_ip0"));
		assert!(sanitized_interface_identity("192.0.2.14").is_none());
		assert!(sanitized_interface_identity("Cafe Wi-Fi").is_none());
		assert!(sanitized_interface_identity("https://proxy.example").is_none());
		assert!(sanitized_interface_identity(&"x".repeat(33)).is_none());
	}
}

#[cfg(not(target_os = "macos"))]
mod platform {
	use super::LivePathUpdate;

	pub(super) fn start(updates: flume::Sender<LivePathUpdate>, shutdown: flume::Receiver<()>) {
		let _ = std::thread::Builder::new()
			.name("omp-live-path".to_owned())
			.spawn(move || {
				let _updates = updates;
				let _ = shutdown.recv();
			});
	}
}
