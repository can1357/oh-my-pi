//! Searches answered by the ovnfs daemon instead of walking its mount.
//!
//! A root strictly below an ovnfs mount ([`ovnfs_root`]) lies in a checkout
//! that the daemon serves from its overlay: it searches in-process what a
//! walk would read file by file over NFS. [`glob`] and [`grep`] ask it when
//! their options mean the same there, and return `None` whenever it cannot
//! or should not answer (options it does not mirror, no daemon, another
//! protocol version, a daemon serving another mount, an error reply,
//! malformed frames), so the caller walks natively. Dropping their futures
//! closes the connection, which cancels the daemon's search.
//!
//! The admin protocol frames JSON objects with a little-endian `u32` length:
//! the client says `{"hello": …}` and gets `{"welcome": {version, ops,
//! mount, …}}`, then `{"id": N, "<op>": args}` is answered by `{"id": N,
//! "ok": reply}` or `{"id": N, "error": …}`; event frames may interleave.
#![cfg_attr(not(unix), allow(dead_code, reason = "without Unix sockets the daemon is never asked"))]

use std::{
	ops::Not,
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
	fs::{FileType, Fs, mounts::ovnfs_root},
	glob::{GlobMatch, GlobOptions, Selector},
	grep::{ContextLine, GrepOptions, GrepResult, Match, Mode},
};

/// The admin protocol generation this client speaks.
const PROTOCOL_VERSION: u32 = 5;

/// Largest frame payload either side sends.
const MAX_FRAME: u32 = 16 << 20;

/// The request id of the one request a connection carries.
const REQUEST_ID: u64 = 1;

/// [`crate::glob::glob`] answered by the daemon serving `root`'s checkout;
/// `selector` is the compiled `opts.pattern`, `pattern` its effective text.
pub(crate) async fn glob(
	fs: &Fs,
	root: &Path,
	pattern: &str,
	selector: &Selector,
	opts: &GlobOptions,
) -> Option<Vec<GlobMatch>> {
	// The daemon never follows links, cannot see a caller's stop flag, and
	// descends into `node_modules` whenever the pattern names it; a zero
	// depth is unlimited to it.
	if opts.walk.follow_links
		|| opts.walk.stop.is_some()
		|| opts.walk.max_depth == Some(0)
		|| (opts.include_node_modules == Some(false) && selector.mentions_node_modules())
	{
		return None;
	}
	let (socket, dir) = ovnfs_root(fs, root)?;
	glob_at(&socket, &dir, pattern, opts).await
}

/// [`glob`] on the daemon at `socket`, for the canonical directory `dir`.
async fn glob_at(
	socket: &Path,
	dir: &Path,
	pattern: &str,
	opts: &GlobOptions,
) -> Option<Vec<GlobMatch>> {
	let args = GlobArgs {
		dir,
		pattern,
		anchored: !opts.recursive,
		kind: opts.file_type.map(Kind::from),
		limit: opts.max_results,
		sort_by_mtime: opts.sort_by_mtime,
		hidden: opts.walk.hidden,
		no_ignore: !opts.walk.gitignore,
		node_modules: opts.include_node_modules == Some(true),
		max_depth: opts.walk.max_depth,
	};
	let reply: GlobReply = call(socket, dir, Op::Glob(args)).await?;
	Some(
		reply
			.matches
			.unwrap_or_default()
			.into_iter()
			.map(|m| GlobMatch {
				path:      m.path,
				file_type: m.kind.into(),
				size:      u64::try_from(m.size).ok(),
				mtime:     (m.mtime != 0).then_some(m.mtime),
			})
			.collect(),
	)
}

/// [`crate::grep::grep`] answered by the daemon serving `root`'s checkout,
/// for directory roots and patterns compiled by
/// [`GrepOptions::compile`].
pub(crate) async fn grep(fs: &Fs, root: &Path, opts: &GrepOptions) -> Option<GrepResult> {
	// Streaming and type filters stay native, as do a stop flag the daemon
	// cannot see and zero limits, which mean "unlimited" to it.
	if opts.source.is_none()
		|| opts.sink.is_some()
		|| opts.file_type.is_some()
		|| opts.walk.stop.is_some()
		|| opts.max_count == Some(0)
		|| opts.max_count_per_file == Some(0)
		|| opts.max_columns == Some(0)
	{
		return None;
	}
	let (socket, dir) = ovnfs_root(fs, root)?;
	// A file root is searched as text by the native scanner.
	if !std::fs::metadata(&dir).ok()?.is_dir() {
		return None;
	}
	grep_at(&socket, &dir, opts).await
}

/// [`grep`] on the daemon at `socket`, for the canonical directory `dir`.
async fn grep_at(socket: &Path, dir: &Path, opts: &GrepOptions) -> Option<GrepResult> {
	let source = opts.source.as_ref()?;
	let content = opts.mode == Mode::Content;
	let args = GrepArgs {
		dir,
		pattern: &source.pattern,
		ignore_case: source.ignore_case,
		multiline: opts.multiline,
		glob: opts
			.glob
			.as_deref()
			.map(str::trim)
			.filter(|glob| !glob.is_empty()),
		anchored: !opts.recursive,
		exclude: &opts.exclude,
		mode: match opts.mode {
			Mode::Content => None,
			Mode::Count => Some("count"),
			Mode::FilesWithMatches => Some("filesWithMatches"),
		},
		before: if content { opts.before } else { 0 },
		after: if content { opts.after } else { 0 },
		max_columns: opts.max_columns,
		offset: opts.offset,
		max_count: opts.max_count,
		max_count_per_file: opts.max_count_per_file,
		hidden: opts.walk.hidden,
		no_ignore: !opts.walk.gitignore,
	};
	let reply: GrepReply = call(socket, dir, Op::Grep(args)).await?;
	let count = opts.mode == Mode::Count;
	Some(GrepResult {
		matches:            reply
			.matches
			.unwrap_or_default()
			.into_iter()
			.map(|m| Match {
				path:      m.path,
				line:      m.line,
				text:      m.text,
				before:    context(m.before),
				after:     context(m.after),
				truncated: m.truncated,
				column:    m.column.filter(|&column| column > 0),
				count:     count.then_some(m.count),
			})
			.collect(),
		total_matches:      reply.total_matches,
		files_with_matches: reply.files_with_matches,
		files_searched:     reply.files_searched,
		limit_reached:      reply.limit_reached,
		skipped_oversized:  reply.skipped_oversized,
		binary_matches:     Vec::new(),
	})
}

/// Context lines of a daemon match.
fn context(lines: Option<Vec<Line>>) -> Vec<ContextLine> {
	lines
		.unwrap_or_default()
		.into_iter()
		.map(|l| ContextLine { line: l.line, text: l.text })
		.collect()
}

/// Whether the daemon `welcome`d on a connection serves `dir`: the protocol
/// generation matches, `op` is offered, and `dir` lies strictly below its
/// mount (whose parent is resolved like `dir` was).
fn serves(welcome: &Welcome, op: &str, dir: &Path) -> bool {
	if welcome.version != PROTOCOL_VERSION || !welcome.ops.iter().any(|offered| offered == op) {
		return false;
	}
	let (Some(parent), Some(name)) = (welcome.mount.parent(), welcome.mount.file_name()) else {
		return false;
	};
	let Ok(parent) = std::fs::canonicalize(parent) else {
		return false;
	};
	dir.strip_prefix(parent.join(name))
		.is_ok_and(|rel| !rel.as_os_str().is_empty())
}

/// Runs `op` for `dir` on the daemon at `socket` over a connection of its
/// own; `None` on any failure.
#[cfg(unix)]
async fn call<R: DeserializeOwned>(socket: &Path, dir: &Path, op: Op<'_>) -> Option<R> {
	use tokio::{
		io::{AsyncReadExt, AsyncWriteExt},
		net::UnixStream,
	};

	/// Sends `value` as one frame.
	async fn send(stream: &mut UnixStream, value: &(impl Serialize + Sync)) -> Option<()> {
		let mut frame = vec![0; 4];
		serde_json::to_writer(&mut frame, value).ok()?;
		let len = u32::try_from(frame.len() - 4)
			.ok()
			.filter(|&len| len <= MAX_FRAME)?;
		frame[..4].copy_from_slice(&len.to_le_bytes());
		stream.write_all(&frame).await.ok()
	}

	/// Reads the next frame's payload into `buf`.
	async fn receive(stream: &mut UnixStream, buf: &mut Vec<u8>) -> Option<()> {
		let mut header = [0; 4];
		stream.read_exact(&mut header).await.ok()?;
		let len = u32::from_le_bytes(header);
		if len > MAX_FRAME {
			return None;
		}
		buf.clear();
		buf.resize(usize::try_from(len).ok()?, 0);
		stream.read_exact(buf).await.ok()?;
		Some(())
	}

	let mut stream = UnixStream::connect(socket).await.ok()?;
	send(&mut stream, &Hello { hello: Client { client: "pi" } }).await?;
	let mut buf = Vec::new();
	receive(&mut stream, &mut buf).await?;
	let greeting: Greeting = serde_json::from_slice(&buf).ok()?;
	if !serves(&greeting.welcome, op.name(), dir) {
		return None;
	}
	send(&mut stream, &Request { id: REQUEST_ID, op }).await?;
	loop {
		receive(&mut stream, &mut buf).await?;
		// Events and other requests' frames carry no id of ours.
		let envelope: Envelope = serde_json::from_slice(&buf).ok()?;
		if envelope.id == Some(REQUEST_ID) {
			let reply: Reply<R> = serde_json::from_slice(&buf).ok()?;
			return reply.ok;
		}
	}
}

/// Without Unix sockets there is no daemon to ask.
#[cfg(not(unix))]
async fn call<R: DeserializeOwned>(_socket: &Path, _dir: &Path, _op: Op<'_>) -> Option<R> {
	None
}

/// The client's first frame.
#[derive(Serialize)]
struct Hello {
	/// Who is asking.
	hello: Client,
}

/// The `hello` payload.
#[derive(Serialize)]
struct Client {
	/// Client name, for the daemon's logs.
	client: &'static str,
}

/// The daemon's first frame.
#[derive(Deserialize)]
struct Greeting {
	/// What the daemon speaks and serves.
	welcome: Welcome,
}

/// The `welcome` payload, as far as a search needs it.
#[derive(Deserialize)]
struct Welcome {
	/// Protocol generation.
	version: u32,
	/// Operations the daemon answers.
	#[serde(default)]
	ops:     Vec<String>,
	/// The mount it serves; empty while unmounted.
	#[serde(default)]
	mount:   PathBuf,
}

/// One request frame: `{"id": N, "<op>": args}`.
#[derive(Serialize)]
struct Request<'a> {
	/// Request id echoed by the reply.
	id: u64,
	/// The operation and its arguments.
	#[serde(flatten)]
	op: Op<'a>,
}

/// A search operation with its arguments.
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Op<'a> {
	/// Content search.
	Grep(GrepArgs<'a>),
	/// Path search.
	Glob(GlobArgs<'a>),
}

impl Op<'_> {
	/// The operation's name in the welcome's `ops`.
	const fn name(&self) -> &'static str {
		match self {
			Self::Grep(_) => "grep",
			Self::Glob(_) => "glob",
		}
	}
}

/// Any frame, read for its request id.
#[derive(Deserialize)]
struct Envelope {
	/// The request a reply answers; absent on events.
	id: Option<u64>,
}

/// A reply frame; an error reply carries no `ok`.
#[derive(Deserialize)]
struct Reply<R> {
	/// The operation's result.
	ok: Option<R>,
}

/// Zero, for `skip_serializing_if`.
fn is_zero<T: Default + PartialEq>(value: &T) -> bool {
	*value == T::default()
}

/// Arguments of the daemon's `grep`; unset fields are left out.
#[derive(Serialize)]
struct GrepArgs<'a> {
	/// Canonical search root.
	dir:                &'a Path,
	/// Pattern in pi's regex dialect.
	pattern:            &'a str,
	/// Case-insensitive matching.
	#[serde(skip_serializing_if = "Not::not")]
	ignore_case:        bool,
	/// Matches may span lines.
	#[serde(skip_serializing_if = "Not::not")]
	multiline:          bool,
	/// [`Selector::scope`] glob.
	#[serde(skip_serializing_if = "Option::is_none")]
	glob:               Option<&'a str>,
	/// Slash-free globs match at the root only.
	#[serde(skip_serializing_if = "Not::not")]
	anchored:           bool,
	/// [`Selector::exclude`] patterns.
	#[serde(skip_serializing_if = "<[String]>::is_empty")]
	exclude:            &'a [String],
	/// `count` or `filesWithMatches`; absent for content.
	#[serde(skip_serializing_if = "Option::is_none")]
	mode:               Option<&'static str>,
	/// Context lines before each match.
	#[serde(skip_serializing_if = "is_zero")]
	before:             usize,
	/// Context lines after each match.
	#[serde(skip_serializing_if = "is_zero")]
	after:              usize,
	/// Cut reported lines to this many bytes.
	#[serde(skip_serializing_if = "Option::is_none")]
	max_columns:        Option<usize>,
	/// Results skipped in path order.
	#[serde(skip_serializing_if = "is_zero")]
	offset:             u64,
	/// Results returned after `offset`.
	#[serde(skip_serializing_if = "Option::is_none")]
	max_count:          Option<u64>,
	/// Content matches kept per file.
	#[serde(skip_serializing_if = "Option::is_none")]
	max_count_per_file: Option<u64>,
	/// Include dot-prefixed entries.
	#[serde(skip_serializing_if = "Not::not")]
	hidden:             bool,
	/// Ignore `.gitignore` and friends.
	#[serde(skip_serializing_if = "Not::not")]
	no_ignore:          bool,
}

/// The daemon's `grep` reply.
#[derive(Deserialize)]
struct GrepReply {
	/// Results in path order; `null` when none.
	#[serde(default)]
	matches:            Option<Vec<GrepHit>>,
	/// See [`GrepResult::total_matches`].
	total_matches:      u64,
	/// See [`GrepResult::files_with_matches`].
	files_with_matches: u64,
	/// See [`GrepResult::files_searched`].
	files_searched:     u64,
	/// See [`GrepResult::limit_reached`].
	#[serde(default)]
	limit_reached:      bool,
	/// See [`GrepResult::skipped_oversized`].
	#[serde(default)]
	skipped_oversized:  u64,
}

/// One daemon `grep` result.
#[derive(Deserialize)]
struct GrepHit {
	/// Root-relative path.
	path:      String,
	/// 1-based first matching line; 0 outside content mode.
	line:      u64,
	/// Matching line or block.
	text:      String,
	/// Context before.
	#[serde(default)]
	before:    Option<Vec<Line>>,
	/// Context after.
	#[serde(default)]
	after:     Option<Vec<Line>>,
	/// `max_columns` cut `text`.
	#[serde(default)]
	truncated: bool,
	/// 1-based column of the first match in a cut line; 0 or absent otherwise.
	#[serde(default)]
	column:    Option<u32>,
	/// The file's match count in count mode.
	#[serde(default)]
	count:     u64,
}

/// A daemon context line.
#[derive(Deserialize)]
struct Line {
	/// 1-based line number.
	line: u64,
	/// Line text.
	text: String,
}

/// Arguments of the daemon's `glob`; unset fields are left out.
#[derive(Serialize)]
struct GlobArgs<'a> {
	/// Canonical search root.
	dir:           &'a Path,
	/// Pattern in pi's glob dialect.
	pattern:       &'a str,
	/// Slash-free patterns match at the root only.
	#[serde(skip_serializing_if = "Not::not")]
	anchored:      bool,
	/// Entry type filter.
	#[serde(rename = "type", skip_serializing_if = "Option::is_none")]
	kind:          Option<Kind>,
	/// Most matches returned.
	#[serde(skip_serializing_if = "Option::is_none")]
	limit:         Option<usize>,
	/// Newest first, with sizes and mtimes.
	#[serde(skip_serializing_if = "Not::not")]
	sort_by_mtime: bool,
	/// Include dot-prefixed entries.
	#[serde(skip_serializing_if = "Not::not")]
	hidden:        bool,
	/// Ignore `.gitignore` and friends.
	#[serde(skip_serializing_if = "Not::not")]
	no_ignore:     bool,
	/// Descend into `node_modules`.
	#[serde(skip_serializing_if = "Not::not")]
	node_modules:  bool,
	/// Deepest depth reported (root's children are 1).
	#[serde(skip_serializing_if = "Option::is_none")]
	max_depth:     Option<usize>,
}

/// The daemon's `glob` reply.
#[derive(Deserialize)]
struct GlobReply {
	/// Matches in result order; `null` when none.
	#[serde(default)]
	matches: Option<Vec<GlobHit>>,
}

/// One daemon `glob` match.
#[derive(Deserialize)]
struct GlobHit {
	/// Root-relative path.
	path:  String,
	/// Entry type.
	#[serde(rename = "type")]
	kind:  Kind,
	/// Regular-file size, -1 when absent.
	size:  i64,
	/// Unix nanoseconds, 0 when absent.
	mtime: i64,
}

/// An entry type on the wire.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
	/// Regular file.
	File,
	/// Directory.
	Dir,
	/// Symbolic link.
	Symlink,
}

impl From<FileType> for Kind {
	fn from(kind: FileType) -> Self {
		match kind {
			FileType::File => Self::File,
			FileType::Dir => Self::Dir,
			FileType::Symlink => Self::Symlink,
		}
	}
}

impl From<Kind> for FileType {
	fn from(kind: Kind) -> Self {
		match kind {
			Kind::File => Self::File,
			Kind::Dir => Self::Dir,
			Kind::Symlink => Self::Symlink,
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
	};

	use serde_json::{Value, json};
	use tokio::{
		io::{AsyncReadExt, AsyncWriteExt},
		net::{UnixListener, UnixStream},
		task::JoinHandle,
	};

	use super::{glob_at, grep_at};
	use crate::{
		fs::FileType,
		glob::{GlobMatch, GlobOptions},
		grep::{ContextLine, GrepOptions, GrepResult, Match},
		walk,
	};

	/// A scratch directory holding a fake daemon's socket and mount.
	struct Scratch(PathBuf);

	impl Scratch {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			// Short: Unix socket paths are limited to ~100 bytes.
			let path = std::env::temp_dir().join(format!("pi-ovnfs-{}-{seq}", std::process::id()));
			std::fs::create_dir_all(path.join("mnt")).expect("create scratch dir");
			Self(path.canonicalize().expect("canonical scratch dir"))
		}

		fn socket(&self) -> PathBuf {
			self.0.join("admin.sock")
		}

		/// The fake daemon's mount point.
		fn mount(&self) -> PathBuf {
			self.0.join("mnt")
		}

		/// A search root in a checkout below the mount.
		fn dir(&self) -> PathBuf {
			self.mount().join("checkout")
		}
	}

	impl Drop for Scratch {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	async fn read_frame(stream: &mut UnixStream) -> Option<Value> {
		let mut header = [0; 4];
		stream.read_exact(&mut header).await.ok()?;
		let mut body = vec![0; usize::try_from(u32::from_le_bytes(header)).ok()?];
		stream.read_exact(&mut body).await.ok()?;
		serde_json::from_slice(&body).ok()
	}

	async fn write_frame(stream: &mut UnixStream, body: &str) {
		let len = u32::try_from(body.len()).expect("frame length");
		let _ = stream.write_all(&len.to_le_bytes()).await;
		let _ = stream.write_all(body.as_bytes()).await;
	}

	fn welcome(version: u32, op: &str, mount: &Path) -> String {
		json!({"welcome": {"version": version, "ops": [op], "proto": "nfs", "port": 0, "mount": mount, "state": "/s"}})
			.to_string()
	}

	/// Serves one connection: answers the hello with `welcome`, then the
	/// request with `frames`; yields the request frame, if one came.
	fn serve(scratch: &Scratch, welcome: String, frames: Vec<String>) -> JoinHandle<Option<Value>> {
		let listener = UnixListener::bind(scratch.socket()).expect("bind socket");
		tokio::spawn(async move {
			let (mut stream, _) = listener.accept().await.ok()?;
			let hello = read_frame(&mut stream).await?;
			assert_eq!(hello, json!({"hello": {"client": "pi"}}));
			write_frame(&mut stream, &welcome).await;
			let request = read_frame(&mut stream).await?;
			for frame in frames {
				write_frame(&mut stream, &frame).await;
			}
			Some(request)
		})
	}

	fn glob_options() -> GlobOptions {
		GlobOptions {
			pattern:              "*.rs".to_owned(),
			recursive:            false,
			file_type:            Some(FileType::File),
			max_results:          Some(5),
			sort_by_mtime:        true,
			include_node_modules: Some(true),
			walk:                 walk::Options {
				hidden: true,
				gitignore: false,
				max_depth: Some(3),
				..walk::Options::default()
			},
		}
	}

	async fn glob(
		scratch: &Scratch,
		welcome: String,
		frames: Vec<String>,
	) -> (Option<Vec<GlobMatch>>, Option<Value>) {
		let daemon = serve(scratch, welcome, frames);
		let found = glob_at(&scratch.socket(), &scratch.dir(), "*.rs", &glob_options()).await;
		(found, daemon.await.expect("daemon"))
	}

	#[tokio::test]
	async fn glob_maps_options_and_reply_skipping_other_frames() {
		let scratch = Scratch::new();
		let reply = json!({"id": 1, "ok": {"matches": [
			{"path": "src/a.rs", "type": "file", "size": 3, "mtime": 1_500_000_000},
			{"path": "src/link.rs", "type": "symlink", "size": -1, "mtime": 0},
		], "total": 2, "truncated": false}});
		let frames = vec![
			json!({"event": {"name": "checkout", "payload": {}}}).to_string(),
			json!({"id": 7, "ok": {}}).to_string(),
			reply.to_string(),
		];
		let (found, request) = glob(&scratch, welcome(5, "glob", &scratch.mount()), frames).await;
		assert_eq!(
			request,
			Some(json!({"id": 1, "glob": {
				"dir": scratch.dir(), "pattern": "*.rs", "anchored": true, "type": "file", "limit": 5,
				"sort_by_mtime": true, "hidden": true, "no_ignore": true, "node_modules": true, "max_depth": 3,
			}}))
		);
		assert_eq!(
			found,
			Some(vec![
				GlobMatch {
					path:      "src/a.rs".to_owned(),
					file_type: FileType::File,
					size:      Some(3),
					mtime:     Some(1_500_000_000),
				},
				GlobMatch {
					path:      "src/link.rs".to_owned(),
					file_type: FileType::Symlink,
					size:      None,
					mtime:     None,
				},
			])
		);
	}

	#[tokio::test]
	async fn grep_maps_options_and_reply() {
		let scratch = Scratch::new();
		let reply = json!({"id": 1, "ok": {
			"matches": [{
				"path": "src/a.rs", "line": 4, "text": "…foo…", "truncated": true, "column": 7, "count": 0,
				"before": [{"line": 3, "text": "x"}], "after": [{"line": 5, "text": "y"}],
			}],
			"total_matches": 3, "files_with_matches": 2, "files_searched": 9,
			"limit_reached": true, "skipped_oversized": 1,
		}});
		let daemon = serve(&scratch, welcome(5, "grep", &scratch.mount()), vec![reply.to_string()]);
		let opts = GrepOptions {
			glob: Some(" *.rs ".to_owned()),
			exclude: vec!["vendor".to_owned()],
			before: 1,
			after: 2,
			max_columns: Some(80),
			offset: 1,
			max_count: Some(10),
			max_count_per_file: Some(2),
			walk: walk::Options { hidden: false, gitignore: true, ..walk::Options::default() },
			..GrepOptions::compile("fo+".to_owned(), true, true).expect("compile")
		};
		let found = grep_at(&scratch.socket(), &scratch.dir(), &opts).await;
		assert_eq!(
			daemon.await.expect("daemon"),
			Some(json!({"id": 1, "grep": {
				"dir": scratch.dir(), "pattern": "fo+", "ignore_case": true, "multiline": true, "glob": "*.rs",
				"exclude": ["vendor"], "before": 1, "after": 2, "max_columns": 80, "offset": 1, "max_count": 10,
				"max_count_per_file": 2,
			}}))
		);
		assert_eq!(
			found,
			Some(GrepResult {
				matches:            vec![Match {
					path:      "src/a.rs".to_owned(),
					line:      4,
					text:      "…foo…".to_owned(),
					before:    vec![ContextLine { line: 3, text: "x".to_owned() }],
					after:     vec![ContextLine { line: 5, text: "y".to_owned() }],
					truncated: true,
					column:    Some(7),
					count:     None,
				}],
				total_matches:      3,
				files_with_matches: 2,
				files_searched:     9,
				limit_reached:      true,
				skipped_oversized:  1,
				binary_matches:     Vec::new(),
			})
		);
	}

	#[tokio::test]
	async fn refusals_and_failures_fall_back() {
		let ok = json!({"id": 1, "ok": {"matches": [], "total": 0, "truncated": false}}).to_string();
		/// What a case is named, how the daemon greets, and what it replies.
		type Case = (&'static str, fn(&Scratch) -> String, String);
		let other = Scratch::new();
		let cases: [Case; 6] = [
			("old protocol", |s| welcome(4, "glob", &s.mount()), ok.clone()),
			("op not offered", |s| welcome(5, "grep", &s.mount()), ok.clone()),
			("root is the mount", |s| welcome(5, "glob", &s.dir()), ok.clone()),
			("another mount", |s| welcome(5, "glob", &s.0.join("elsewhere")), ok.clone()),
			(
				"error reply",
				|s| welcome(5, "glob", &s.mount()),
				json!({"id": 1, "error": {"code": "invalid", "message": "bad"}}).to_string(),
			),
			("malformed reply", |s| welcome(5, "glob", &s.mount()), "{".to_owned()),
		];
		for (case, greeting, reply) in cases {
			let scratch = Scratch::new();
			let (found, _) = glob(&scratch, greeting(&scratch), vec![reply]).await;
			assert_eq!(found, None, "{case}");
		}
		let absent = glob_at(&other.socket(), &other.dir(), "*.rs", &glob_options()).await;
		assert_eq!(absent, None, "no daemon");
	}
}
