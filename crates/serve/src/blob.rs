//! Tonic projection of the daemon's content-addressed blob store.

use std::{fs, io, path::PathBuf, pin, sync::Arc};

use bytes::Bytes;
use futures::{Stream, StreamExt};
use omp_core::Hash32;
use omp_journal::blob::{self, BlobRef, BlobStore};
use omp_proto::omp::blob::v1::{self as pb, blob_server};
use tokio::{io::AsyncReadExt as _, task};
use tonic::{Request, Response, Status};

const CHUNK_SIZE: usize = 64 * 1024;
const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
type BlobStream = pin::Pin<Box<dyn Stream<Item = Result<pb::Chunk, Status>> + Send + 'static>>;

/// RPC server backed by one daemon-owned content-addressed store.
#[derive(Clone)]
pub struct BlobRpc {
	store: Arc<BlobStore>,
}

impl BlobRpc {
	/// Wraps a daemon-owned blob store.
	pub const fn new(store: Arc<BlobStore>) -> Self {
		Self { store }
	}
}

#[tonic::async_trait]
impl blob_server::Blob for BlobRpc {
	type GetStream = BlobStream;

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "blob", rpc.method = "stat")
	)]
	async fn stat(
		&self,
		request: Request<pb::StatRequest>,
	) -> Result<Response<pb::StatResponse>, Status> {
		let hash = parse_hash(&request.into_inner().hash)?;
		let reference = BlobRef { hash, size: 0 };
		let path = self.store.path(&reference);
		let metadata = task::spawn_blocking(move || fs::metadata(path))
			.await
			.map_err(join_status)?;
		match metadata {
			Ok(metadata) if metadata.is_file() => {
				Ok(Response::new(pb::StatResponse { present: true, size: metadata.len() }))
			},
			Ok(_) => Ok(Response::new(pb::StatResponse { present: false, size: 0 })),
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				Ok(Response::new(pb::StatResponse { present: false, size: 0 }))
			},
			Err(error) => Err(io_status(error)),
		}
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "blob", rpc.method = "get")
	)]
	async fn get(
		&self,
		request: Request<pb::GetRequest>,
	) -> Result<Response<Self::GetStream>, Status> {
		let request = request.into_inner();
		let hash = parse_hash(&request.hash)?;
		let store = Arc::clone(&self.store);
		let range =
			task::spawn_blocking(move || store.open_range(hash, request.offset, request.length))
				.await
				.map_err(join_status)?
				.map_err(storage_status)?;
		let reference = range.reference();
		let length = range.len();
		let mut file = tokio::fs::File::from_std(range.into_file());
		let stream = async_stream::try_stream! {
			let mut sent = 0_u64;
			if length == 0 {
				yield pb::Chunk {
					data: Bytes::new(),
					hash: Bytes::copy_from_slice(reference.hash.as_bytes()),
					size: Some(reference.size),
				};
			}
			while sent < length {
				let wanted = usize::try_from((length - sent).min(CHUNK_SIZE as u64))
					.expect("blob chunk bound fits usize");
				let mut data = vec![0_u8; wanted];
				let count = file.read(&mut data).await.map_err(io_status)?;
				if count == 0 {
					Err(Status::data_loss("blob range ended before its declared length"))?;
				}
				data.truncate(count);
				let first = sent == 0;
				sent += u64::try_from(count).expect("blob chunk count fits u64");
				yield pb::Chunk {
					data: Bytes::from(data),
					hash: if first {
						Bytes::copy_from_slice(reference.hash.as_bytes())
					} else {
						Bytes::new()
					},
					size: first.then_some(reference.size),
				};
			}
		};
		Ok(Response::new(Box::pin(stream)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "blob", rpc.method = "put")
	)]
	async fn put(
		&self,
		request: Request<tonic::Streaming<pb::Chunk>>,
	) -> Result<Response<pb::PutResponse>, Status> {
		let mut incoming = request.into_inner();
		let mut bytes = Vec::new();
		let mut expected_hash = None;
		let mut expected_size = None;
		let mut first = true;
		while let Some(chunk) = incoming.next().await {
			let chunk = chunk?;
			if first {
				expected_hash = (!chunk.hash.is_empty())
					.then(|| parse_hash(&chunk.hash))
					.transpose()?;
				expected_size = chunk.size;
				first = false;
			} else if !chunk.hash.is_empty() || chunk.size.is_some() {
				return Err(Status::invalid_argument(
					"blob hash and declared size are permitted only on the first upload chunk",
				));
			}
			let next_len = bytes
				.len()
				.checked_add(chunk.data.len())
				.ok_or_else(|| Status::resource_exhausted("blob exceeds supported size"))?;
			if next_len > MAX_UPLOAD_BYTES {
				return Err(Status::resource_exhausted("blob exceeds the 64 MiB RPC upload limit"));
			}
			bytes.extend_from_slice(&chunk.data);
		}
		let store = Arc::clone(&self.store);
		let digest = validate_upload(&bytes, expected_hash, expected_size)?;
		let reference = task::spawn_blocking(move || store.put(&bytes))
			.await
			.map_err(join_status)?
			.map_err(storage_status)?;
		debug_assert_eq!(reference.hash, digest);
		Ok(Response::new(pb::PutResponse {
			hash: Bytes::copy_from_slice(reference.hash.as_bytes()),
			size: reference.size,
		}))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "blob", rpc.method = "delete")
	)]
	async fn delete(
		&self,
		request: Request<pb::DeleteRequest>,
	) -> Result<Response<pb::DeleteResponse>, Status> {
		let hash = parse_hash(&request.into_inner().hash)?;
		let path: PathBuf = self.store.path(&BlobRef { hash, size: 0 });
		let deleted = task::spawn_blocking(move || match fs::remove_file(path) {
			Ok(()) => Ok(true),
			Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
			Err(error) => Err(error),
		})
		.await
		.map_err(join_status)?
		.map_err(io_status)?;
		Ok(Response::new(pb::DeleteResponse { deleted }))
	}
}

fn validate_upload(
	bytes: &[u8],
	expected_hash: Option<Hash32>,
	expected_size: Option<u64>,
) -> Result<Hash32, Status> {
	let actual_size = u64::try_from(bytes.len())
		.map_err(|_| Status::resource_exhausted("blob exceeds supported size"))?;
	if expected_size.is_some_and(|expected| expected != actual_size) {
		return Err(Status::invalid_argument("uploaded blob size does not match declared size"));
	}
	let digest = Hash32::sum(bytes);
	if expected_hash.is_some_and(|expected| expected != digest) {
		return Err(Status::invalid_argument("uploaded blob hash does not match declared digest"));
	}
	Ok(digest)
}

fn parse_hash(bytes: &[u8]) -> Result<Hash32, Status> {
	<[u8; 32]>::try_from(bytes)
		.map(Hash32::new)
		.map_err(|_| Status::invalid_argument("blob hash must be exactly 32 bytes"))
}

fn join_status(error: task::JoinError) -> Status {
	Status::internal(format!("blob worker failed: {error}"))
}

fn io_status(error: io::Error) -> Status {
	if error.kind() == io::ErrorKind::NotFound {
		Status::not_found("blob not found")
	} else {
		Status::internal(format!("blob store I/O failed: {error}"))
	}
}

fn storage_status(error: blob::Error) -> Status {
	match error {
		blob::Error::NotFound => Status::not_found("blob not found"),
		blob::Error::RangeOutOfBounds { .. } => {
			Status::out_of_range("blob range offset exceeds stored size")
		},
		blob::Error::Corrupt { .. } => Status::data_loss("stored blob size is corrupt"),
		other => Status::internal(format!("blob store failed: {other}")),
	}
}
#[cfg(test)]
mod tests {
	use omp_core::Hash32;

	use super::validate_upload;

	#[test]
	fn rejected_declared_digest_is_detected_before_storage() {
		let bytes = b"bounded upload";
		let wrong = Hash32::sum(b"different upload");
		let error = validate_upload(bytes, Some(wrong), Some(bytes.len() as u64))
			.expect_err("mismatched digest must be rejected");
		assert_eq!(error.code(), tonic::Code::InvalidArgument);
		assert_eq!(
			validate_upload(bytes, Some(Hash32::sum(bytes)), Some(bytes.len() as u64))
				.expect("matching digest"),
			Hash32::sum(bytes)
		);
	}
}
