//! Codex `DeviceCheck` attestation envelope and deterministic CBOR encoder.

use std::{env, sync::LazyLock, time::Duration};

use omp_core::{Str, base64_url};
use thiserror::Error;

const BUNDLE_ID: &str = "com.openai.codex";
static APP_SESSION_ID: LazyLock<Str> =
	LazyLock::new(|| Str::from(omp_core::Ulid::generate().to_string()));

/// Native `DeviceCheck` result before CBOR envelope encoding.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceCheckResult {
	/// Whether `DeviceCheck` is supported on this host.
	pub supported:    bool,
	/// Standard-base64 `DeviceCheck` token when generation succeeded.
	pub token_base64: Option<Str>,
	/// Native generation latency when reported.
	pub latency:      Option<Duration>,
}

/// Attestation encoding failures.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum AttestationError {
	/// A string or container exceeds the supported CBOR length range.
	#[error("attestation value exceeds CBOR length limits")]
	CborLength,
}

/// Builds the exact `v1.<base64url-CBOR>` client-attestation value.
pub fn build_client_attestation(result: &DeviceCheckResult) -> Result<Str, AttestationError> {
	let mut entries = Vec::with_capacity(4);
	if result.supported {
		if let Some(token) = result.token_base64.as_ref() {
			entries.push((cbor_text("token")?, cbor_text(token.as_str())?));
		} else {
			entries.push((cbor_text("error_code")?, cbor_unsigned(4)?));
		}
	} else {
		entries.push((cbor_text("error_code")?, cbor_unsigned(3)?));
	}
	entries.push((cbor_text("bundle_id")?, cbor_text(BUNDLE_ID)?));
	let signals = attestation_signals()?;
	let mut wrapped_signals = cbor_header(0x40, signals.len())?;
	wrapped_signals.extend_from_slice(&signals);
	entries.push((cbor_text("f")?, wrapped_signals));
	if let Some(latency) = result.latency {
		let mut value = Vec::with_capacity(9);
		value.push(0xfb);
		value.extend_from_slice(&(latency.as_secs_f64() * 1_000.0).to_be_bytes());
		entries.push((cbor_text("t")?, value));
	}
	let encoded = base64_url::encode_raw(&cbor_map(&entries)?).into_string();
	Ok(Str::from(format!("v1.{encoded}")))
}

/// Generates the JSON value carried by `x-oai-attestation`.
///
/// Unsupported platforms and native framework failures intentionally omit the
/// header; supported-but-tokenless results carry `DeviceCheck` error code 4.
pub async fn generate_codex_attestation() -> Option<Str> {
	#[cfg(all(target_os = "macos", target_arch = "aarch64", feature = "device-attestation"))]
	{
		let result = macos::generate().await.ok()?;
		let token = build_client_attestation(&result).ok()?;
		serde_json::to_string(&serde_json::json!({ "v": 1, "s": 0, "t": token }))
			.ok()
			.map(Str::from)
	}
	#[cfg(not(all(target_os = "macos", target_arch = "aarch64", feature = "device-attestation")))]
	{
		None
	}
}

fn attestation_signals() -> Result<Vec<u8>, AttestationError> {
	let locale = env::var("LANG")
		.ok()
		.and_then(|value| value.split('.').next().map(str::to_owned))
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| "unknown".to_owned());
	let timezone = env::var("TZ")
		.ok()
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| "unknown".to_owned());
	let locale = truncate_utf8(&locale, 64);
	let timezone = truncate_utf8(&timezone, 64);
	let session = truncate_utf8(APP_SESSION_ID.as_str(), 128);
	let mut languages = cbor_header(0x80, 1)?;
	languages.extend_from_slice(&cbor_text(locale)?);
	cbor_map(&[
		(cbor_unsigned(0)?, cbor_unsigned(1)?),
		(cbor_unsigned(1)?, languages),
		(cbor_unsigned(2)?, cbor_text(locale)?),
		(cbor_unsigned(3)?, cbor_text(timezone)?),
		(cbor_unsigned(4)?, cbor_unsigned(0)?),
		(cbor_unsigned(5)?, cbor_unsigned(1)?),
		(cbor_unsigned(6)?, cbor_text(session)?),
	])
}

fn cbor_unsigned(value: usize) -> Result<Vec<u8>, AttestationError> {
	cbor_header(0, value)
}

fn cbor_text(value: &str) -> Result<Vec<u8>, AttestationError> {
	let mut output = cbor_header(0x60, value.len())?;
	output.extend_from_slice(value.as_bytes());
	Ok(output)
}

fn cbor_map(entries: &[(Vec<u8>, Vec<u8>)]) -> Result<Vec<u8>, AttestationError> {
	let size: usize = entries
		.iter()
		.map(|(key, value)| key.len() + value.len())
		.sum();
	let mut output = Vec::with_capacity(size + 5);
	output.extend_from_slice(&cbor_header(0xa0, entries.len())?);
	for (key, value) in entries {
		output.extend_from_slice(key);
		output.extend_from_slice(value);
	}
	Ok(output)
}

fn cbor_header(major: u8, value: usize) -> Result<Vec<u8>, AttestationError> {
	if value < 24 {
		Ok(vec![major + value as u8])
	} else if let Ok(value) = u8::try_from(value) {
		Ok(vec![major + 24, value])
	} else if let Ok(value) = u16::try_from(value) {
		let mut output = vec![major + 25];
		output.extend_from_slice(&value.to_be_bytes());
		Ok(output)
	} else if let Ok(value) = u32::try_from(value) {
		let mut output = vec![major + 26];
		output.extend_from_slice(&value.to_be_bytes());
		Ok(output)
	} else {
		Err(AttestationError::CborLength)
	}
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> &str {
	if value.len() <= maximum_bytes {
		return value;
	}
	let mut end = maximum_bytes;
	while !value.is_char_boundary(end) {
		end -= 1;
	}
	&value[..end]
}

#[cfg(all(target_os = "macos", target_arch = "aarch64", feature = "device-attestation"))]
mod macos {
	use std::{ffi::c_void, slice, time::Instant};

	use block2::RcBlock;
	use objc2::{
		msg_send,
		runtime::{AnyClass, AnyObject},
	};
	use objc2_foundation::NSError;
	use omp_core::Str;
	use thiserror::Error;

	use super::DeviceCheckResult;

	#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
	pub(super) enum DeviceCheckError {
		#[error("DeviceCheck framework is unavailable")]
		Unavailable,
		#[error("DeviceCheck completion channel closed")]
		CompletionClosed,
	}

	pub(super) async fn generate() -> Result<DeviceCheckResult, DeviceCheckError> {
		let Some((receiver, started)) = start_generate()? else {
			return Ok(DeviceCheckResult::default());
		};
		let token = receiver
			.recv_async()
			.await
			.map_err(|_| DeviceCheckError::CompletionClosed)?;
		Ok(DeviceCheckResult {
			supported:    true,
			token_base64: token.map(Str::from),
			latency:      Some(started.elapsed()),
		})
	}

	fn start_generate()
	-> Result<Option<(flume::Receiver<Option<String>>, Instant)>, DeviceCheckError> {
		let class = AnyClass::get(c"DCDevice").ok_or(DeviceCheckError::Unavailable)?;
		// SAFETY: DCDevice is looked up dynamically and these selectors are the
		// stable DeviceCheck framework API available since macOS 11.
		let device: *mut AnyObject = unsafe { msg_send![class, currentDevice] };
		if device.is_null() {
			return Err(DeviceCheckError::Unavailable);
		}
		let supported: bool = unsafe { msg_send![device, isSupported] };
		if !supported {
			return Ok(None);
		}
		let started = Instant::now();
		let (sender, receiver) = flume::bounded(1);
		let completion = RcBlock::new(move |data: *mut AnyObject, error: *mut NSError| {
			if !error.is_null() || data.is_null() {
				let _ = sender.send(None);
				return;
			}
			// SAFETY: successful completion passes an NSData instance; its bytes
			// remain valid for the duration of this copied block invocation.
			let pointer: *const c_void = unsafe { msg_send![data, bytes] };
			let length: usize = unsafe { msg_send![data, length] };
			let bytes = unsafe { slice::from_raw_parts(pointer.cast::<u8>(), length) };
			let _ = sender.send(Some(omp_core::base64::encode(bytes).into_string()));
		});
		// SAFETY: completion is copied by DeviceCheck and owns the channel sender.
		let (): () = unsafe { msg_send![device, generateTokenWithCompletionHandler: &*completion] };
		Ok(Some((receiver, started)))
	}
}
