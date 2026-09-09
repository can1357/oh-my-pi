//! P1: the real document authority serializes stale non-overlapping edits.

#![cfg(unix)]

use bytes::Bytes;
use omp_core::Str;
use omp_e2e::{
	Context as _, Result, error,
	support::{DocServerTask, Scratch, within},
};
use omp_envd::docs::{DocumentHost, DocumentLease};
use omp_proto::document::v1::{
	self as document, commit_transaction_response, read_document_response, read_selection,
	text_mutation,
};
use tokio::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

const LIMIT: Duration = Duration::from_secs(20);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn p1_docserver_rebases_concurrent_non_overlapping_edits() -> Result<()> {
	within("P1 document race", LIMIT, async {
		let scratch = Scratch::new().context("create P1 project")?;
		scratch.write("race.txt", b"left=0\nright=0\n")?;
		let server = DocServerTask::spawn(
			scratch.project().to_path_buf(),
			scratch.state().join("docserver.sock"),
			Vec::new(),
		)
		.await?;
		let uri = Url::from_file_path(std::fs::canonicalize(scratch.project().join("race.txt"))?)
			.map_err(|()| error("fixture path is not a file URL"))?
			.to_string();
		let host_a = server.connect().await?;
		let host_b = server.connect().await?;
		let cancel = CancellationToken::new();
		let mut lease_a = open(&host_a, &uri, &cancel).await?;
		let mut lease_b = open(&host_b, &uri, &cancel).await?;
		let base = lease_a
			.head()
			.revision
			.as_ref()
			.context("A revision")?
			.sequence;
		assert_eq!(
			lease_b
				.head()
				.revision
				.as_ref()
				.context("B revision")?
				.sequence,
			base
		);

		let (a, b) = tokio::join!(
			commit(&host_a, &mut lease_a, 1, 5, 6, b"1"),
			commit(&host_b, &mut lease_b, 2, 13, 14, b"2"),
		);
		let a = a?;
		let b = b?;
		assert!(a.committed && b.committed, "both non-overlapping edits commit");
		assert!(a.rebased || b.rebased, "one stale edit is explicitly rebased");
		assert_ne!(a.sequence, b.sequence);
		assert_eq!(scratch.read("race.txt")?, b"left=1\nright=2\n");

		let final_lease = open(&host_a, &uri, &cancel).await?;
		assert_eq!(read_whole(&host_a, &final_lease).await?.as_ref(), b"left=1\nright=2\n");
		host_a.close(final_lease, &cancel).await?;
		host_a.close(lease_a, &cancel).await?;
		host_b.close(lease_b, &cancel).await?;
		server.shutdown().await?;
		Ok(())
	})
	.await?
}

struct Commit {
	committed: bool,
	rebased:   bool,
	sequence:  u64,
}

async fn commit(
	host: &DocumentHost,
	lease: &mut DocumentLease,
	id: u128,
	start: u64,
	end: u64,
	replacement: &'static [u8],
) -> Result<Commit> {
	let response = host
		.commit(
			lease,
			Bytes::copy_from_slice(&id.to_be_bytes()),
			document::TextMutation {
				base_revision: None,
				change:        Some(text_mutation::Change::Edits(document::ByteEdits {
					edits: vec![document::ByteEdit {
						start,
						end,
						replacement: Bytes::from_static(replacement),
					}],
				})),
				stale_policy:  document::StalePolicy::RebaseNonOverlapping as i32,
				format_policy: document::FormatPolicy::Disabled as i32,
			},
			&CancellationToken::new(),
		)
		.await?;
	match response.outcome {
		Some(commit_transaction_response::Outcome::Committed(committed)) => {
			let operation = committed
				.operations
				.into_iter()
				.next()
				.context("operation result")?;
			let sequence = operation
				.head
				.and_then(|head| head.revision)
				.context("committed revision")?
				.sequence;
			Ok(Commit { committed: true, rebased: operation.rebased, sequence })
		},
		other => Err(error(format!("non-overlapping edit did not commit: {other:?}"))),
	}
}

async fn open(host: &DocumentHost, uri: &str, cancel: &CancellationToken) -> Result<DocumentLease> {
	host
		.open(Str::new(uri), Some(Str::new_static("text")), cancel)
		.await
		.map_err(Into::into)
}

async fn read_whole(host: &DocumentHost, lease: &DocumentLease) -> Result<Bytes> {
	let response = host
		.read(
			lease,
			document::ReadSelection {
				selection: Some(read_selection::Selection::Whole(document::WholeDocument {})),
			},
			&CancellationToken::new(),
		)
		.await?;
	match response.body {
		Some(read_document_response::Body::Content(bytes)) => Ok(bytes),
		_ => Err(error("whole read returned no content")),
	}
}
