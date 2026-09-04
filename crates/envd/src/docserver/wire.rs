//! Bounded length-delimited protobuf framing for document-server connections.

use std::{io, num::NonZeroUsize};

use bytes::BytesMut;
use omp_proto::{
	document::v1::{ClientFrame, ServerFrame},
	prost::Message,
};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Default maximum encoded protobuf payload accepted from one client frame.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// Length-delimited protobuf framing policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameConfig {
	max_frame_bytes: NonZeroUsize,
}

impl FrameConfig {
	/// Creates a framing policy with a nonzero encoded-payload limit.
	pub const fn new(max_frame_bytes: NonZeroUsize) -> Self {
		Self { max_frame_bytes }
	}

	/// Returns the maximum encoded protobuf payload length.
	pub const fn max_frame_bytes(self) -> usize {
		self.max_frame_bytes.get()
	}
}

impl Default for FrameConfig {
	fn default() -> Self {
		Self::new(NonZeroUsize::new(DEFAULT_MAX_FRAME_BYTES).expect("default frame limit is nonzero"))
	}
}

/// A malformed, oversized, truncated, or failed transport frame.
#[derive(Debug, Error)]
pub enum WireError {
	/// The byte stream failed.
	#[error("document transport I/O failed: {0}")]
	Io(#[from] io::Error),
	/// The length prefix exceeds the protobuf varint representation.
	#[error("document frame length prefix is invalid")]
	InvalidLengthPrefix,
	/// The declared payload exceeds the configured connection limit.
	#[error("document frame payload is {actual} bytes; limit is {limit}")]
	FrameTooLarge {
		/// Declared payload length.
		actual: usize,
		/// Configured payload limit.
		limit:  usize,
	},
	/// A client payload is not a valid `ClientFrame` protobuf message.
	#[error("invalid document client frame: {0}")]
	InvalidClientFrame(#[from] omp_proto::prost::DecodeError),
	/// A server payload is not a valid `ServerFrame` protobuf message.
	#[error("invalid document server frame: {0}")]
	InvalidServerFrame(omp_proto::prost::DecodeError),
	/// A protobuf frame could not be encoded.
	#[error("document frame encoding failed: {0}")]
	InvalidFrameEncoding(#[from] omp_proto::prost::EncodeError),
}

/// Reads one varint-length-delimited client frame, returning `None` at clean
/// EOF and reusing `scratch` between frames.
pub async fn read_client_frame<R>(
	reader: &mut R,
	config: FrameConfig,
	scratch: &mut BytesMut,
) -> Result<Option<ClientFrame>, WireError>
where
	R: AsyncRead + Unpin,
{
	let Some(length) = read_payload(reader, config, scratch).await? else {
		return Ok(None);
	};
	Ok(Some(ClientFrame::decode(&scratch[..length])?))
}

/// Reads one varint-length-delimited server frame, returning `None` at clean
/// EOF and reusing `scratch` between frames.
pub async fn read_server_frame<R>(
	reader: &mut R,
	config: FrameConfig,
	scratch: &mut BytesMut,
) -> Result<Option<ServerFrame>, WireError>
where
	R: AsyncRead + Unpin,
{
	let Some(length) = read_payload(reader, config, scratch).await? else {
		return Ok(None);
	};
	ServerFrame::decode(&scratch[..length])
		.map(Some)
		.map_err(WireError::InvalidServerFrame)
}

/// Writes and flushes one varint-length-delimited server frame, reusing
/// `scratch` after the write completes.
pub async fn write_server_frame<W>(
	writer: &mut W,
	frame: &ServerFrame,
	config: FrameConfig,
	scratch: &mut BytesMut,
) -> Result<(), WireError>
where
	W: AsyncWrite + Unpin,
{
	let length = frame.encoded_len();
	if length > config.max_frame_bytes() {
		return Err(WireError::FrameTooLarge { actual: length, limit: config.max_frame_bytes() });
	}
	scratch.clear();
	scratch.reserve(length + encoded_varint_len(length));
	frame.encode_length_delimited(scratch)?;
	writer.write_all(scratch).await?;
	writer.flush().await?;
	Ok(())
}

/// Writes and flushes one varint-length-delimited client frame, reusing
/// `scratch` after the write completes.
pub async fn write_client_frame<W>(
	writer: &mut W,
	frame: &ClientFrame,
	config: FrameConfig,
	scratch: &mut BytesMut,
) -> Result<(), WireError>
where
	W: AsyncWrite + Unpin,
{
	let length = frame.encoded_len();
	if length > config.max_frame_bytes() {
		return Err(WireError::FrameTooLarge { actual: length, limit: config.max_frame_bytes() });
	}
	scratch.clear();
	scratch.reserve(length + encoded_varint_len(length));
	frame.encode_length_delimited(scratch)?;
	writer.write_all(scratch).await?;
	writer.flush().await?;
	Ok(())
}

async fn read_payload<R>(
	reader: &mut R,
	config: FrameConfig,
	scratch: &mut BytesMut,
) -> Result<Option<usize>, WireError>
where
	R: AsyncRead + Unpin,
{
	let Some(length) = read_length(reader).await? else {
		return Ok(None);
	};
	if length > config.max_frame_bytes() {
		return Err(WireError::FrameTooLarge { actual: length, limit: config.max_frame_bytes() });
	}
	scratch.clear();
	scratch.resize(length, 0);
	reader.read_exact(scratch).await?;
	Ok(Some(length))
}

async fn read_length<R>(reader: &mut R) -> Result<Option<usize>, WireError>
where
	R: AsyncRead + Unpin,
{
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let mut byte = [0_u8; 1];
		match reader.read_exact(&mut byte).await {
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && shift == 0 => {
				return Ok(None);
			},
			Err(error) => {
				return Err(error.into());
			},
		}
		let part = u64::from(byte[0] & 0x7f);
		if shift == 63 && part > 1 {
			return Err(WireError::InvalidLengthPrefix);
		}
		value |= part << shift;
		if byte[0] & 0x80 == 0 {
			return usize::try_from(value)
				.map(Some)
				.map_err(|_| WireError::InvalidLengthPrefix);
		}
	}
	Err(WireError::InvalidLengthPrefix)
}

const fn encoded_varint_len(mut value: usize) -> usize {
	let mut length = 1;
	while value >= 0x80 {
		value >>= 7;
		length += 1;
	}
	length
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn frames_round_trip_and_clean_eof_is_distinct_from_truncation() {
		let client = ClientFrame { request_id: 7, body: None };
		let mut encoded = Vec::new();
		client.encode_length_delimited(&mut encoded).unwrap();
		let mut scratch = BytesMut::new();
		let mut input = encoded.as_slice();
		assert_eq!(
			read_client_frame(&mut input, FrameConfig::default(), &mut scratch)
				.await
				.unwrap(),
			Some(client)
		);
		assert_eq!(
			read_client_frame(&mut input, FrameConfig::default(), &mut scratch)
				.await
				.unwrap(),
			None
		);

		let mut truncated = [3_u8, 1_u8].as_slice();
		assert!(matches!(
			read_client_frame(&mut truncated, FrameConfig::default(), &mut scratch).await,
			Err(WireError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof
		));
	}

	#[tokio::test]
	async fn configured_limit_rejects_reads_and_writes() {
		let config = FrameConfig::new(NonZeroUsize::new(1).unwrap());
		let mut input = [2_u8, 0_u8, 0_u8].as_slice();
		let mut read_scratch = BytesMut::new();
		assert!(matches!(
			read_client_frame(&mut input, config, &mut read_scratch).await,
			Err(WireError::FrameTooLarge { actual: 2, limit: 1 })
		));

		let frame = ServerFrame { request_id: 1, body: None };
		let mut output = Vec::new();
		let mut scratch = BytesMut::new();
		assert!(matches!(
			write_server_frame(&mut output, &frame, config, &mut scratch).await,
			Err(WireError::FrameTooLarge { .. })
		));
	}
}
