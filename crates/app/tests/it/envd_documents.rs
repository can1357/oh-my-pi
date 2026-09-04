//! Unix document-daemon integration tests.

use std::{fs, future::Future, sync::mpsc, thread, time::Duration};

use bytes::Bytes;
use omp_core::{Hash32, Str, sf};
use omp_envd::{
	blobs::BlobHost,
	docs::DocumentHost,
	docserver::{
		Environment, ServerConfig,
		connection::{ConnectionConfig, PROTOCOL_MAJOR, PROTOCOL_MINOR, serve_connection},
	},
	workspace::{WorkspaceError, WorkspaceHost},
};
use omp_proto::{
	blob::v1 as blob_pb,
	document::v1::{
		self as document_pb, commit_transaction_response, read_document_response, read_selection,
		summarize_document_response, text_mutation,
	},
};
use tempfile::TempDir;
use tokio::{io, time};
use tokio_util::sync::CancellationToken;

const DEADLINE: Duration = Duration::from_secs(10);

async fn within<T>(future: impl Future<Output = T>) -> T {
	time::timeout(DEADLINE, future)
		.await
		.expect("resource operation exceeded its deterministic deadline")
}

const fn rust_fixture() -> &'static [u8] {
	br#"pub fn aggregate(values: &[u64]) -> u64 {
    let mut total = 0;
    for value in values {
        if *value == 0 {
            continue;
        }
        let doubled = value * 2;
        let adjusted = doubled + 1;
        total += adjusted;
    }
    if total > 100 {
        total - 10
    } else {
        total + 10
    }
}

pub fn label(value: u64) -> String {
    let prefix = "value";
    let separator = ':';
    let rendered = value.to_string();
    format!("{prefix}{separator}{rendered}")
}
"#
}

const fn proposed_content(content: &'static [u8]) -> document_pb::TextMutation {
	document_pb::TextMutation {
		base_revision: None,
		change:        Some(text_mutation::Change::ProposedContent(Bytes::from_static(content))),
		stale_policy:  document_pb::StalePolicy::Fail as i32,
		format_policy: document_pb::FormatPolicy::Disabled as i32,
	}
}

#[tokio::test]
async fn document_host_round_trips_a_real_revisioned_docserver_session() {
	let repository = TempDir::new().expect("scratch repository");
	let config = ServerConfig::new(repository.path()).expect("docserver config");
	let source = config.environment_root().join("fixture.rs");
	fs::write(&source, rust_fixture()).expect("document fixture");
	let uri = config.file_uri(&source).expect("document URI").to_string();
	let expected_root_uri = config
		.file_uri(config.environment_root())
		.expect("root URI")
		.to_string();
	let environment = Environment::new(config).expect("document authority");
	let (client_stream, server_stream) = io::duplex(256 * 1024);
	let server = tokio::spawn(serve_connection(
		environment.clone(),
		server_stream,
		ConnectionConfig::default(),
	));
	let host = within(DocumentHost::connect(client_stream))
		.await
		.expect("document hello");
	assert_eq!(host.hello().protocol_major, PROTOCOL_MAJOR);
	assert_eq!(host.hello().protocol_minor, PROTOCOL_MINOR);
	assert!(!host.hello().workspace_id.is_empty());
	assert!(!host.hello().server_epoch.is_empty());
	assert_eq!(host.hello().root_uri.as_str(), expected_root_uri);

	let cancel = CancellationToken::new();
	let mut writer = within(host.open(Str::new(&uri), Some(sf!("rust")), &cancel))
		.await
		.expect("writer lease");
	let mut stale_writer = within(host.open(Str::new(&uri), Some(sf!("rust")), &cancel))
		.await
		.expect("stale-writer lease");
	let pinned_revision = writer.head().revision.clone().expect("pinned revision");
	assert_eq!(stale_writer.head().revision.as_ref(), Some(&pinned_revision));

	let selected = within(host.read(
		&writer,
		document_pb::ReadSelection {
			selection: Some(read_selection::Selection::Bytes(document_pb::ByteRangeSelection {
				ranges: vec![document_pb::ByteRange { start: 0, end: 18 }],
			})),
		},
		&cancel,
	))
	.await
	.expect("pinned range read");
	assert_eq!(selected.head.as_ref(), Some(writer.head()));
	let read_document_response::Body::Slices(slices) = selected.body.expect("range-read body")
	else {
		panic!("range read returned whole-document content");
	};
	assert_eq!(slices.slices.len(), 1);
	assert_eq!(&slices.slices[0].content[..], &rust_fixture()[..18]);

	let summarized = within(host.summarize(
		&writer,
		document_pb::CodeSummaryOptions {
			min_body_lines:     2,
			min_comment_lines:  4,
			unfold_until_lines: 0,
			unfold_limit_lines: 0,
			enable_prose:       false,
			min_total_lines:    1,
			render_mode:        document_pb::SummaryRenderMode::Plain as i32,
			language:           "rust".into(),
		},
		&cancel,
	))
	.await
	.expect("pinned structural summary");
	assert_eq!(summarized.head.as_ref(), Some(writer.head()));
	let Some(summarize_document_response::Outcome::Summary(summary)) = summarized.outcome else {
		panic!("fixture must produce a structural summary");
	};
	assert!(summary.parsed);
	assert!(summary.elided);
	assert!(!summary.segments.is_empty());

	static COMMITTED: &[u8] = b"pub fn answer() -> u64 {\n    42\n}\n";
	let committed = within(host.commit(
		&mut writer,
		Bytes::from_static(b"first-edit-00001"),
		proposed_content(COMMITTED),
		&cancel,
	))
	.await
	.expect("committed transaction");
	assert!(matches!(committed.outcome, Some(commit_transaction_response::Outcome::Committed(_))));
	let advanced_revision = writer.head().revision.as_ref().expect("advanced revision");
	assert_ne!(advanced_revision, &pinned_revision);

	let rejected = within(host.commit(
		&mut stale_writer,
		Bytes::from_static(b"stale-edit-00001"),
		proposed_content(b"pub fn stale() {}\n"),
		&cancel,
	))
	.await
	.expect("stale transaction outcome");
	let Some(commit_transaction_response::Outcome::Rejected(rejected)) = rejected.outcome else {
		panic!("stale lease unexpectedly committed");
	};
	assert_eq!(rejected.reason, document_pb::TransactionRejectReason::StaleBase as i32);
	assert_eq!(stale_writer.head().revision.as_ref(), Some(&pinned_revision));

	let observer = within(host.open(Str::new(&uri), Some(sf!("rust")), &cancel))
		.await
		.expect("observer lease");
	assert_eq!(observer.head().revision, writer.head().revision);
	let observed = within(host.read(
		&observer,
		document_pb::ReadSelection {
			selection: Some(read_selection::Selection::Whole(document_pb::WholeDocument {})),
		},
		&cancel,
	))
	.await
	.expect("advanced revision read");
	let read_document_response::Body::Content(content) = observed.body.expect("whole-document body")
	else {
		panic!("whole read returned slices");
	};
	assert_eq!(&content[..], COMMITTED);

	within(host.close(observer, &cancel))
		.await
		.expect("close observer lease");
	within(host.close(stale_writer, &cancel))
		.await
		.expect("close stale lease");
	within(host.close(writer, &cancel))
		.await
		.expect("close writer lease");
	drop(host);
	within(server)
		.await
		.expect("docserver session task")
		.expect("docserver session");
	within(environment.shutdown()).await;
}

#[test]
fn workspace_host_matches_direct_walker_and_cancels_an_active_walk() {
	let repository = TempDir::new().expect("scratch workspace");
	fs::create_dir(repository.path().join("nested")).expect("nested directory");
	fs::write(repository.path().join("alpha.txt"), b"alpha\n").expect("alpha fixture");
	fs::write(repository.path().join("nested/beta.bin"), [0, 1, 2, 255]).expect("binary fixture");
	fs::write(repository.path().join("nested/gamma.rs"), b"fn gamma() {}\n")
		.expect("source fixture");

	let host = WorkspaceHost::open(repository.path()).expect("workspace host");
	let request = host.request().hidden(true).gitignore(false).cache(false);
	let hosted_walk = host
		.walk(&request, &CancellationToken::new())
		.expect("hosted walk");
	let direct_walk = request.collect().expect("direct walker walk");
	assert_eq!(hosted_walk, direct_walk, "host must preserve every walker output byte");

	let hosted_candidates = host
		.candidates(&request, &CancellationToken::new())
		.expect("hosted candidates");
	let direct_candidates = request
		.collect_file_candidates()
		.expect("direct walker candidates");
	assert_eq!(
		hosted_candidates, direct_candidates,
		"host must preserve every direct candidate field and path byte"
	);
	for (hosted, direct) in hosted_candidates.iter().zip(&direct_candidates) {
		assert_eq!(hosted.relative.as_bytes(), direct.relative.as_bytes());
	}

	let bulk = repository.path().join("bulk");
	fs::create_dir(&bulk).expect("bulk fixture directory");
	for index in 0..12_000 {
		fs::write(bulk.join(format!("entry-{index:05}.txt")), b"x").expect("bulk fixture entry");
	}
	let active_request = host.request().gitignore(false).cache(false);
	let active_host = host;
	let cancel = CancellationToken::new();
	let worker_cancel = cancel.clone();
	let (started_tx, started_rx) = mpsc::sync_channel(0);
	let (result_tx, result_rx) = mpsc::sync_channel(1);
	let worker = thread::spawn(move || {
		started_tx.send(()).expect("announce active walk");
		let result = active_host.walk(&active_request, &worker_cancel);
		result_tx.send(result).expect("return cancelled walk");
	});
	// Cancel before releasing the rendezvous: the walk provably starts with a
	// cancelled token, so it must terminate with `Cancelled` instead of walking
	// the bulk tree to completion. Cancelling after release raced the walk on
	// loaded hosts.
	cancel.cancel();
	started_rx
		.recv_timeout(DEADLINE)
		.expect("active walk did not start before deadline");
	let cancelled = result_rx
		.recv_timeout(DEADLINE)
		.expect("cancelled walk did not stop before deadline");
	assert!(matches!(cancelled, Err(WorkspaceError::Cancelled)));
	worker.join().expect("active walker thread");
}

#[test]
fn blob_host_puts_stats_ranges_and_deletes_real_storage_content() {
	let state = TempDir::new().expect("scratch blob state");
	let host = BlobHost::open(state.path()).expect("blob storage authority");
	let content = b"binary\0blob\xffpayload";
	let id = host.put(content).expect("blob put");
	assert_eq!(id.hash, Hash32::sum(content).into_bytes());
	assert_eq!(id.size, content.len() as u64);

	let stat = host.stat(&id.hash).expect("blob stat");
	assert!(stat.present);
	assert_eq!(stat.size, id.size);
	assert_eq!(&host.get(id).expect("complete blob")[..], content);

	let ranged = host
		.get_request(&blob_pb::GetRequest {
			hash:   Bytes::copy_from_slice(&id.hash),
			offset: 7,
			length: 5,
		})
		.expect("ranged blob get");
	assert_eq!(ranged.id(), id);
	assert_eq!(&ranged.read_all().expect("read selected range")[..], &content[7..12]);

	let deleted = host.delete(&id.hash).expect("blob delete");
	assert!(deleted.deleted);
	let absent = host.stat(&id.hash).expect("post-delete stat");
	assert!(!absent.present);
	assert_eq!(absent.size, 0);
	assert!(
		!host
			.delete(&id.hash)
			.expect("idempotent blob delete")
			.deleted
	);
}
