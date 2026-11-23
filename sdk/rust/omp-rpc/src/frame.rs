//! Protocol v2 `rpc_chunk` reassembly (mirrors the Python `_RpcFrameDecoder`).

use serde_json::Value;

/// Physical stdout frame limit a v2 server must advertise.
pub(crate) const MAX_FRAME_BYTES: i64 = 1024 * 1024;
/// Reassembled logical frame limit a v2 server must advertise.
pub(crate) const MAX_REASSEMBLED_BYTES: i64 = 64 * 1024 * 1024;
/// Largest decoded payload of one chunk.
const CHUNK_PAYLOAD_BYTES: usize = 256 * 1024;
/// Chunks needed for the largest logical frame: ceil(64 MiB / 256 KiB).
const MAX_CHUNK_COUNT: i64 =
	(MAX_REASSEMBLED_BYTES + CHUNK_PAYLOAD_BYTES as i64 - 1) / CHUNK_PAYLOAD_BYTES as i64;
const MAX_CHUNK_ID_CHARS: usize = 128;

struct PendingChunks {
	chunk_id:    String,
	count:       i64,
	byte_length: i64,
	next_index:  i64,
	bytes:       Vec<u8>,
}

/// Reassembles chunk sequences; every error is fatal to the transport.
#[derive(Default)]
pub(crate) struct FrameDecoder {
	pending: Option<PendingChunks>,
}

impl FrameDecoder {
	/// Feeds one physical frame; returns the logical frame once complete.
	pub(crate) fn push(&mut self, value: Value) -> Result<Option<Value>, String> {
		if value.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
			if self.pending.is_some() {
				return Err("RPC chunk sequence was interrupted".to_owned());
			}
			if !value.is_object() {
				return Err("RPC frame must be a JSON object".to_owned());
			}
			return Ok(Some(value));
		}
		let chunk_id = value
			.get("chunkId")
			.and_then(Value::as_str)
			.unwrap_or_default();
		// `as_i64` rejects booleans, floats, and out-of-range integers.
		let index = value.get("index").and_then(Value::as_i64);
		let count = value.get("count").and_then(Value::as_i64);
		let byte_length = value.get("byteLength").and_then(Value::as_i64);
		let data = value
			.get("data")
			.and_then(Value::as_str)
			.unwrap_or_default();
		let (Some(index), Some(count), Some(byte_length)) = (index, count, byte_length) else {
			return Err("Invalid RPC chunk metadata".to_owned());
		};
		if chunk_id.is_empty()
			|| chunk_id.chars().count() > MAX_CHUNK_ID_CHARS
			|| index < 0
			|| !(2..=MAX_CHUNK_COUNT).contains(&count)
			|| index >= count
			|| !(MAX_FRAME_BYTES..=MAX_REASSEMBLED_BYTES).contains(&byte_length)
			|| data.is_empty()
		{
			return Err("Invalid RPC chunk metadata".to_owned());
		}
		let chunk = decode_base64(data).ok_or_else(|| "Invalid RPC chunk data".to_owned())?;
		if chunk.len() > CHUNK_PAYLOAD_BYTES {
			return Err("RPC chunk payload exceeds the transport limit".to_owned());
		}
		let pending = match &mut self.pending {
			Some(pending) => pending,
			None if index != 0 => return Err("RPC chunk sequence must start at index 0".to_owned()),
			None => self.pending.insert(PendingChunks {
				chunk_id: chunk_id.to_owned(),
				count,
				byte_length,
				next_index: 0,
				bytes: Vec::new(),
			}),
		};
		if pending.chunk_id != chunk_id
			|| pending.count != count
			|| pending.byte_length != byte_length
			|| pending.next_index != index
		{
			return Err("RPC chunk sequence mismatch".to_owned());
		}
		pending.bytes.extend_from_slice(&chunk);
		pending.next_index += 1;
		let received = pending.bytes.len() as i64;
		if received > pending.byte_length {
			return Err("RPC chunk sequence exceeds its declared length".to_owned());
		}
		if pending.next_index < pending.count {
			return Ok(None);
		}
		if received != pending.byte_length {
			return Err("RPC chunk sequence length mismatch".to_owned());
		}
		let Some(pending) = self.pending.take() else {
			unreachable!("pending sequence checked above")
		};
		let text = String::from_utf8(pending.bytes)
			.map_err(|_| "Failed to decode reassembled RPC frame".to_owned())?;
		let frame: Value = serde_json::from_str(&text)
			.map_err(|_| "Failed to decode reassembled RPC frame".to_owned())?;
		if !frame.is_object() {
			return Err("RPC frame must be a JSON object".to_owned());
		}
		Ok(Some(frame))
	}
}

fn sextet(byte: u8) -> Option<u32> {
	let value = match byte {
		b'A'..=b'Z' => byte - b'A',
		b'a'..=b'z' => byte - b'a' + 26,
		b'0'..=b'9' => byte - b'0' + 52,
		b'+' => 62,
		b'/' => 63,
		_ => return None,
	};
	Some(u32::from(value))
}

/// Strict canonical standard base64 (padded, no whitespace, zero pad bits), so
/// only the encoding Python's `base64.b64encode` would produce is accepted;
/// `None` when malformed.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
	let bytes = text.as_bytes();
	let (quads, rest) = bytes.as_chunks::<4>();
	if quads.is_empty() || !rest.is_empty() {
		return None;
	}
	let mut out = Vec::with_capacity(quads.len() * 3);
	for (position, quad) in quads.iter().enumerate() {
		let padding = quad.iter().rev().take_while(|&&byte| byte == b'=').count();
		if padding > 2 || (padding > 0 && position + 1 != quads.len()) {
			return None;
		}
		let mut bits = 0u32;
		for &byte in &quad[..4 - padding] {
			bits = bits << 6 | sextet(byte)?;
		}
		bits <<= 6 * padding as u32;
		if bits & ((1 << (8 * padding)) - 1) != 0 {
			return None;
		}
		out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8][..3 - padding]);
	}
	Some(out)
}

#[cfg(test)]
fn encode_base64(bytes: &[u8]) -> String {
	const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for group in bytes.chunks(3) {
		let bits = group
			.iter()
			.enumerate()
			.fold(0u32, |bits, (index, &byte)| bits | u32::from(byte) << (16 - 8 * index));
		for index in 0..4 {
			if index <= group.len() {
				out.push(ALPHABET[(bits >> (18 - 6 * index) & 0x3f) as usize] as char);
			} else {
				out.push('=');
			}
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn base64_is_strict_and_canonical() {
		for sample in
			[&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar", &[0xff, 0x00, 0x7f]]
		{
			let encoded = encode_base64(sample);
			if !sample.is_empty() {
				assert_eq!(decode_base64(&encoded).as_deref(), Some(sample));
			}
		}
		assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
		assert_eq!(encode_base64(b"fo"), "Zm8=");
		assert!(decode_base64("Zm8").is_none());
		assert!(decode_base64("Zm=8").is_none());
		assert!(decode_base64("Zm8=Zm8=").is_none());
		assert!(decode_base64("Zm 8").is_none());
		// Non-zero pad bits: lenient decoders accept these, canonical ones must not.
		assert!(decode_base64("Zm9=").is_none());
		assert!(decode_base64("Zh==").is_none());
	}
}
