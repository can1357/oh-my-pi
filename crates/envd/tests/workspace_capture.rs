//! Input capture contracts (ADR 0040, Part D): git path sets, deny filter and
//! content scan before hashing, symlinks, determinism, and no published
//! generation.

use std::{fs, future::Future, path::Path, time::Duration};

use omp_envd::{
	blobs::{BlobHost, BlobId},
	docs::DocumentHost,
	docserver::{
		Environment, ServerConfig,
		connection::{ConnectionConfig, serve_connection},
	},
	workspace::{WorkspaceHost, WorkspaceOperationError, WorkspaceOperations},
};
use omp_proto::env::v1::{CaptureInputsReply, CaptureInputsRequest, ListWorkspaceSnapshots};
use omp_vcs::testing::run as git;
use tempfile::TempDir;
use tokio::{io, time};
use tokio_util::sync::CancellationToken;

const DEADLINE: Duration = Duration::from_secs(20);
const MANIFEST_MAGIC_LEN: usize = 7;

async fn within<T>(future: impl Future<Output = T>) -> T {
	time::timeout(DEADLINE, future)
		.await
		.expect("capture exceeded its deterministic deadline")
}

struct Fixture {
	root:       TempDir,
	_state:     TempDir,
	blobs:      BlobHost,
	operations: WorkspaceOperations,
}

impl Fixture {
	async fn new() -> Self {
		let root = TempDir::new().expect("workspace");
		let state = TempDir::new().expect("state");
		let config = ServerConfig::new(root.path()).expect("document config");
		let environment = Environment::new(config).expect("document authority");
		let (client, server) = io::duplex(256 * 1024);
		tokio::spawn(serve_connection(environment, server, ConnectionConfig::default()));
		let documents = within(DocumentHost::connect(client))
			.await
			.expect("document host");
		let workspace = WorkspaceHost::open(root.path()).expect("workspace host");
		let blobs = BlobHost::open(state.path().join("blobs")).expect("blob host");
		let operations = WorkspaceOperations::open(
			workspace,
			documents,
			blobs.clone(),
			state.path().join("worktrees"),
		)
		.expect("workspace operations");
		Self { root, _state: state, blobs, operations }
	}

	fn path(&self) -> &Path {
		self.root.path()
	}

	fn write(&self, relative: &str, body: &[u8]) {
		let path = self.path().join(relative);
		fs::create_dir_all(path.parent().expect("parent")).expect("parent directory");
		fs::write(path, body).expect("fixture file");
	}

	/// Commits `tracked.txt`, `src/lib.rs`, `gone.txt`, a force-added file that
	/// matches `.gitignore`, and the ignore file itself.
	fn commit_baseline(&self) {
		git(self.path(), &["init", "-b", "main"]);
		git(self.path(), &["config", "user.name", "Capture Test"]);
		git(self.path(), &["config", "user.email", "capture@example.invalid"]);
		self.write(".gitignore", b"ignored.txt\nignored-dir/\n");
		self.write("tracked.txt", b"tracked\n");
		self.write("src/lib.rs", b"pub fn f() {}\n");
		self.write("gone.txt", b"to be deleted\n");
		self.write("ignored.txt", b"force added\n");
		git(self.path(), &["add", "-A"]);
		git(self.path(), &["add", "-f", "ignored.txt"]);
		git(self.path(), &["commit", "-m", "baseline"]);
	}

	fn capture(&self, request: CaptureInputsRequest) -> CaptureInputsReply {
		self
			.operations
			.capture_inputs(&request, &CancellationToken::new())
			.expect("capture")
	}

	/// Paths in the captured manifest blob, in manifest order.
	fn manifest_paths(&self, reply: &CaptureInputsReply) -> Vec<String> {
		let hash: [u8; 32] = reply.manifest_hash[..]
			.try_into()
			.expect("32-byte manifest hash");
		let bytes = self
			.blobs
			.get(BlobId { hash, size: reply.manifest_size })
			.expect("manifest blob");
		let mut at = MANIFEST_MAGIC_LEN + 4;
		let mut paths = Vec::new();
		while at < bytes.len() {
			let length =
				u32::from_be_bytes(bytes[at..at + 4].try_into().expect("path length")) as usize;
			at += 4;
			paths.push(String::from_utf8(bytes[at..at + length].to_vec()).expect("utf-8 path"));
			at += length + 4 + 32;
		}
		paths
	}
}

fn request(include_untracked: bool) -> CaptureInputsRequest {
	CaptureInputsRequest {
		include_untracked,
		wire_revision: omp_proto::SCHEMA_REV,
		..Default::default()
	}
}

fn credential_body() -> Vec<u8> {
	format!("token = ghp_{}\n", "a1B2c3D4e5".repeat(4)).into_bytes()
}

fn excluded(reply: &CaptureInputsReply, rule: &str) -> u64 {
	reply
		.excluded_rules
		.iter()
		.find(|entry| entry.rule == rule)
		.map_or(0, |entry| entry.files)
}

#[tokio::test]
async fn path_set_follows_git_not_the_walker() {
	let fixture = Fixture::new().await;
	fixture.commit_baseline();
	fs::remove_file(fixture.path().join("gone.txt")).expect("delete tracked file");
	fixture.write("tracked.txt", b"edited\n");
	fixture.write("new.txt", b"untracked\n");
	fixture.write("ignored-dir/skip.txt", b"untracked but ignored\n");
	fixture.write(".ignore", b"new.txt\n");

	let reply = fixture.capture(request(true));
	let paths = fixture.manifest_paths(&reply);
	assert_eq!(
		paths,
		[".gitignore", ".ignore", "ignored.txt", "new.txt", "src/lib.rs", "tracked.txt"],
		"tracked incl. force-added ignored file, untracked unignored, minus deleted, `.ignore` inert"
	);
	assert_eq!(reply.files, paths.len() as u64);
	assert!(reply.refused.is_empty());

	let tracked_only = fixture.capture(request(false));
	assert_eq!(fixture.manifest_paths(&tracked_only), [
		".gitignore",
		"ignored.txt",
		"src/lib.rs",
		"tracked.txt"
	]);
}

#[tokio::test]
async fn deny_globs_exclude_untracked_files_before_hashing() {
	let fixture = Fixture::new().await;
	fixture.commit_baseline();
	fixture.write(".env", b"SECRET_VALUE=1\n");
	fixture.write("deploy/.env.production", b"SECRET_VALUE=2\n");
	fixture.write("keys/server.pem", b"not a real key\n");
	fixture.write(".ssh/config", b"Host x\n");
	fixture.write("operator.local", b"operator denied\n");
	fixture.write("kept.txt", b"fine\n");

	let reply = fixture
		.capture(CaptureInputsRequest { deny_globs: vec!["*.local".to_owned()], ..request(true) });
	let paths = fixture.manifest_paths(&reply);
	assert!(paths.contains(&"kept.txt".to_owned()));
	for denied in
		[".env", "deploy/.env.production", "keys/server.pem", ".ssh/config", "operator.local"]
	{
		assert!(!paths.contains(&denied.to_owned()), "{denied} was captured");
	}
	assert_eq!(excluded(&reply, ".env"), 1);
	assert_eq!(excluded(&reply, ".env.*"), 1);
	assert_eq!(excluded(&reply, "*.pem"), 1);
	assert_eq!(excluded(&reply, ".ssh/**"), 1);
	assert_eq!(excluded(&reply, "*.local"), 1);
	// No byte of an excluded file reached the blob store: the only blobs are
	// the kept files and the manifest.
	let denied_hash = omp_core::Hash32::sum(b"SECRET_VALUE=1\n");
	let stat = fixture
		.blobs
		.stat(denied_hash.as_bytes())
		.expect("blob stat");
	assert!(!stat.present, "a denied file was hashed into the blob store");
}

#[tokio::test]
async fn credential_shaped_body_is_excluded_and_counted() {
	let fixture = Fixture::new().await;
	fixture.commit_baseline();
	fixture.write("notes/token.txt", &credential_body());
	fixture.write("notes/plain.txt", b"nothing to see\n");

	let reply = fixture.capture(request(true));
	let paths = fixture.manifest_paths(&reply);
	assert!(!paths.contains(&"notes/token.txt".to_owned()));
	assert!(paths.contains(&"notes/plain.txt".to_owned()));
	assert_eq!(excluded(&reply, "Credential"), 1);
	let hit = omp_core::Hash32::sum(credential_body());
	assert!(!fixture.blobs.stat(hit.as_bytes()).expect("stat").present);
}

#[tokio::test]
async fn tracked_matches_refuse_the_capture() {
	let fixture = Fixture::new().await;
	fixture.commit_baseline();
	fixture.write(".env", b"TRACKED=1\n");
	git(fixture.path(), &["add", "-f", ".env"]);
	let reply = fixture.capture(request(true));
	assert_eq!(reply.refused.len(), 1);
	assert_eq!(reply.refused[0].path, ".env");
	assert_eq!(reply.refused[0].rule, ".env");
	assert!(reply.manifest_hash.is_empty());

	git(fixture.path(), &["rm", "-q", "--cached", ".env"]);
	fs::remove_file(fixture.path().join(".env")).expect("remove .env");
	assert!(fixture.capture(request(true)).refused.is_empty());

	// A tracked file that differs from HEAD is content-scanned.
	fixture.write("tracked.txt", &credential_body());
	let reply = fixture.capture(request(true));
	assert_eq!(reply.refused.len(), 1);
	assert_eq!(reply.refused[0].path, "tracked.txt");
	assert_eq!(reply.refused[0].rule, "Credential");

	// The operator's allow list exempts one named path.
	let allowed = fixture.capture(CaptureInputsRequest {
		allow_paths: vec!["tracked.txt".to_owned()],
		..request(true)
	});
	assert!(allowed.refused.is_empty());
	assert!(
		fixture
			.manifest_paths(&allowed)
			.contains(&"tracked.txt".to_owned())
	);
}

#[cfg(unix)]
#[tokio::test]
async fn untracked_symlinks_are_skipped_and_counted_tracked_ones_refuse() {
	use std::os::unix::fs::symlink;

	let fixture = Fixture::new().await;
	fixture.commit_baseline();
	symlink(fixture.path().join("src"), fixture.path().join("vendor")).expect("untracked symlink");

	let reply = fixture.capture(request(true));
	assert_eq!(reply.excluded_symlinks, 1);
	assert!(
		!fixture
			.manifest_paths(&reply)
			.contains(&"vendor".to_owned())
	);
	assert!(reply.refused.is_empty());

	git(fixture.path(), &["add", "vendor"]);
	let reply = fixture.capture(request(true));
	assert_eq!(reply.refused.len(), 1);
	assert_eq!(reply.refused[0].path, "vendor");
	assert_eq!(reply.excluded_symlinks, 0);
}

/// ADR 0073 (ADR 0071 O4): the isolated view omits an empty directory and a
/// symlink that stays inside the workspace, because the snapshot walk keeps
/// regular files only. Ignored until S2 replays both into the view (ADR
/// 0073 D3-D5); S2 removes the attribute. Unix only (ADR 0073 D9).
#[cfg(unix)]
#[tokio::test]
#[ignore = "ADR 0073 S2: the view does not replay links or leaf directories yet"]
async fn isolated_view_keeps_empty_directories_and_in_root_symlinks() {
	use std::os::unix::fs::symlink;

	use omp_proto::env::v1::CreateWorktree;

	let fixture = Fixture::new().await;
	fixture.write("src/a.txt", b"a\n");
	fs::create_dir(fixture.path().join("empty")).expect("empty directory");
	symlink("src/a.txt", fixture.path().join("link")).expect("in-root symlink");

	let created = fixture
		.operations
		.create_worktree(
			&CreateWorktree { name: "view".to_owned(), ..Default::default() },
			&CancellationToken::new(),
		)
		.expect("create worktree");
	let view = url::Url::parse(&created.root_uri)
		.expect("worktree root URI")
		.to_file_path()
		.expect("worktree file URI");

	// Holds today: regular files are cloned, so only the gap below can fail.
	assert_eq!(fs::read(view.join("src/a.txt")).expect("cloned file"), b"a\n");

	let mut missing = Vec::new();
	let is_directory = fs::symlink_metadata(view.join("empty")).is_ok_and(|meta| meta.is_dir());
	if !is_directory {
		missing.push("empty/ (directory)");
	}
	let target = fs::read_link(view.join("link")).ok();
	if target.as_deref() != Some(Path::new("src/a.txt")) {
		missing.push("link -> src/a.txt (symlink)");
	}
	assert!(
		missing.is_empty(),
		"isolated view dropped entries the live workspace has: {missing:?} (ADR 0073)"
	);
}

#[tokio::test]
async fn manifest_digest_is_deterministic_and_content_sensitive() {
	let fixture = Fixture::new().await;
	fixture.commit_baseline();
	fixture.write("new.txt", b"untracked\n");
	let first = fixture.capture(request(true));
	let second = fixture.capture(request(true));
	assert_eq!(first.manifest_hash, second.manifest_hash);
	assert_eq!(first.manifest_size, second.manifest_size);
	assert_eq!((first.files, first.bytes), (second.files, second.bytes));

	fixture.write("new.txt", b"changed\n");
	assert_ne!(fixture.capture(request(true)).manifest_hash, first.manifest_hash);
}

#[tokio::test]
async fn capture_publishes_no_generation_or_snapshot_record() {
	let fixture = Fixture::new().await;
	fixture.commit_baseline();
	let list = ListWorkspaceSnapshots {
		limit: 10,
		wire_revision: omp_proto::SCHEMA_REV,
		..Default::default()
	};
	let before = fixture
		.operations
		.list_snapshots(&list)
		.expect("list before");
	assert!(before.snapshots.is_empty());

	fixture.capture(request(true));
	assert!(
		fixture
			.operations
			.list_snapshots(&list)
			.expect("list after capture")
			.snapshots
			.is_empty(),
		"capture published a snapshot record"
	);

	let snapshot = fixture
		.operations
		.snapshot(
			&omp_proto::env::v1::SnapshotWorkspace {
				wire_revision: omp_proto::SCHEMA_REV,
				..Default::default()
			},
			&CancellationToken::new(),
		)
		.expect("snapshot");
	fixture.capture(request(true));
	fixture.write("later.txt", b"after\n");
	fixture.capture(request(true));
	let after = fixture
		.operations
		.list_snapshots(&list)
		.expect("list after");
	assert_eq!(after.snapshots.len(), 1);
	assert_eq!(after.snapshots[0].generation, snapshot.generation);
}

#[tokio::test]
async fn capture_requires_a_git_repository_and_the_current_wire_revision() {
	let fixture = Fixture::new().await;
	assert!(matches!(
		fixture
			.operations
			.capture_inputs(&request(true), &CancellationToken::new()),
		Err(WorkspaceOperationError::NotARepository)
	));
	fixture.commit_baseline();
	assert!(matches!(
		fixture.operations.capture_inputs(
			&CaptureInputsRequest { wire_revision: 0, ..Default::default() },
			&CancellationToken::new()
		),
		Err(WorkspaceOperationError::WireRevision)
	));
}
