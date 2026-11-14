//! Serial, ordered, streaming depth-first traversal.
//!
//! [`Tree`] is for tools whose output order and pruning are sequential:
//! `find` (pre-order or `-depth` contents-first, `-prune`, `-quit`, `-xdev`,
//! `-L`/`-H`) and workspace listing. It shares the filesystem layer,
//! ignore chain, and pruning rules of [`super::walk`], but the caller drives
//! it one event at a time, deciding each entry (and, with
//! [`Tree::skip_dir`], pruning each directory) before its subtree is read.
//!
//! Native walks read ahead while listings are slow (a network filesystem, a
//! cold cache): the subdirectories the traversal will descend into next (in
//! its order: the current directory's, then its ancestors' remaining ones)
//! are opened and listed on the blocking pool, several at a time, so their
//! latencies overlap. Fast listings stay on the traversal, where a hand-off
//! would cost more than the listing. Reports and pruning are unaffected; a
//! pruned directory's listing is dropped. Network mounts met below a local
//! root are reported but not descended into ([`crate::fs::mounts`]).
//!
//! ```ignore
//! let opts = TreeOptions { emit_root: true, ..Default::default() };
//! let mut tree = Tree::new(&fs, root, &opts).await?;
//! while let Some(event) = tree.next().await {
//!     match event {
//!         Event::Entry(entry) => println!("{}", entry.abs.display()),
//!         Event::Error(error) => eprintln!("{}: {}", error.path.display(), error.error),
//!     }
//! }
//! ```

use std::{
	collections::VecDeque,
	ffi::OsStr,
	io,
	mem::ManuallyDrop,
	path::{Path, PathBuf},
	pin::pin,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	task::{Context, Poll, Waker},
	time::{Duration, Instant},
};

use tokio::{
	runtime::Handle,
	task::{JoinHandle, coop::consume_budget},
};

use super::{
	DirError, Options, SEP, WalkError, absolute_root, give_session, is_separator, pruned,
	take_session,
};
use crate::{
	fs::{Detail, Dir, FileId, FileType, Fs, Listing, Record, Session, mounts::Fences},
	ignore::{DirIgnores, Frame as IgnoreFrame, Ignorer, Names, Sources},
};

/// Which symlinks a [`Tree`] follows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Follow {
	/// None, not even a root that is a symlink (it is reported as one).
	Never,
	/// Only the root (`find -H`, `grep -r`).
	#[default]
	Roots,
	/// Every link, with loop detection (`find -L`, `fd -L`).
	Always,
}

/// Order in which a [`Tree`] visits each directory's entries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Order {
	/// As the directory listing returns them.
	Listing,
	/// Byte order of their names (`find`).
	#[default]
	Names,
	/// Byte order of the paths of the files below: a listed directory sorts
	/// as its name plus `/`, so files are visited in the byte order of their
	/// full paths, the order a sorted [`super::collect`] returns.
	Paths,
}

/// Options of a [`Tree`] traversal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeOptions {
	/// Include dot-prefixed entries.
	pub hidden:            bool,
	/// Honour the ignore chain ([`crate::ignore`]).
	pub gitignore:         bool,
	/// Prune entries named `.git`.
	pub skip_git:          bool,
	/// Prune entries named `node_modules`.
	pub skip_node_modules: bool,
	/// Symlink policy.
	pub follow:            Follow,
	/// Listing metadata.
	pub detail:            Detail,
	/// Entries deeper than this are listed with [`Detail::Minimal`]; `None`
	/// applies `detail` everywhere.
	pub detail_max_depth:  Option<usize>,
	/// Order of each directory's entries.
	pub order:             Order,
	/// Report the root itself (depth 0, empty `path`) when `min_depth` is 0.
	pub emit_root:         bool,
	/// Shallowest depth reported; shallower entries are still traversed.
	pub min_depth:         usize,
	/// Deepest depth listed; `None` is unlimited. `min_depth > max_depth`
	/// reports nothing.
	pub max_depth:         Option<usize>,
	/// Report a directory after its contents (`find -depth`) instead of
	/// before.
	pub contents_first:    bool,
	/// Do not descend into directories on another filesystem than the root
	/// (they are still reported).
	pub same_file_system:  bool,
	/// A file name exempt from ignore rules (workspace listing's
	/// `AGENTS.md`); ignored directories are still pruned.
	pub unignored_name:    Option<&'static str>,
	/// Directories listed ahead at once, as [`Options::workers`]; 1 reads
	/// none ahead.
	pub workers:           Option<usize>,
}

impl Default for TreeOptions {
	fn default() -> Self {
		Self {
			hidden:            true,
			gitignore:         false,
			skip_git:          false,
			skip_node_modules: false,
			follow:            Follow::Roots,
			detail:            Detail::Minimal,
			detail_max_depth:  None,
			order:             Order::Names,
			emit_root:         false,
			min_depth:         1,
			max_depth:         None,
			contents_first:    false,
			same_file_system:  false,
			unignored_name:    None,
			workers:           None,
		}
	}
}

/// One entry reported by [`Tree`].
#[derive(Clone, Copy, Debug)]
pub struct TreeEntry<'a> {
	/// Walk-relative `/`-separated raw path; empty for the root.
	pub path:      &'a [u8],
	/// Absolute path in the walked filesystem's spelling.
	pub abs:       &'a Path,
	/// Entry kind; a followed symlink reports its target's kind.
	pub file_type: FileType,
	/// 0 for the root.
	pub depth:     usize,
	/// Regular-file size, when known.
	pub size:      Option<u64>,
	/// Modification time in Unix nanoseconds, when known.
	pub mtime:     Option<i64>,
}

impl<'a> TreeEntry<'a> {
	/// The walk-relative path as a [`Path`] (`/`-separated; empty for the
	/// root).
	pub fn rel_path(&self) -> &'a Path {
		super::rel_path(self.path)
	}

	/// Final path component (empty for the root).
	pub fn name(&self) -> &'a [u8] {
		match memchr::memrchr(b'/', self.path) {
			Some(slash) => &self.path[slash + 1..],
			None => self.path,
		}
	}
}

/// What [`Tree`] reports.
#[derive(Debug)]
pub enum Event<'a> {
	/// An entry; a reported directory is descended unless
	/// [`Tree::skip_dir`] is called before the next event.
	Entry(TreeEntry<'a>),
	/// A directory (the root included) that could not be opened or listed,
	/// or a followed link that would loop. The traversal continues.
	Error(&'a DirError),
}

/// One entry's report; owed after a directory's contents under
/// `contents_first`.
#[derive(Clone, Copy)]
struct Post {
	file_type: FileType,
	depth:     usize,
	size:      Option<u64>,
	mtime:     Option<i64>,
}

/// A listed directory on the traversal stack.
struct Frame {
	listing:  Listing,
	/// Next record of `listing` to visit.
	next:     usize,
	/// Next record to consider for reading ahead.
	scan:     usize,
	/// Subdirectories being read ahead, in record order.
	ahead:    VecDeque<Ahead>,
	/// Depth of this directory; its entries sit one level deeper.
	depth:    usize,
	ignore:   Option<Arc<IgnoreFrame>>,
	/// The open directory, for relative child opens (`None` past
	/// [`MAX_OPEN_DIRS`]).
	dir:      Option<Arc<Dir>>,
	/// Lengths of this directory's own paths in [`Cx::rel`] and [`Cx::abs`].
	own_rel:  usize,
	own_abs:  usize,
	/// Path lengths to restore once the directory is done.
	rel_len:  usize,
	abs_len:  usize,
	post:     Option<Post>,
	/// Opening this directory pushed an ancestor identity.
	ancestor: bool,
}

/// A subdirectory being opened and listed ahead of the traversal.
struct Ahead {
	/// Record of the subdirectory in its parent's listing.
	index: usize,
	task:  JoinHandle<io::Result<Option<Listed>>>,
}

impl Drop for Ahead {
	/// A listing no longer wanted is not started; one already running
	/// finishes and is dropped.
	fn drop(&mut self) {
		self.task.abort();
	}
}

/// An opened and listed directory, before it becomes a [`Frame`].
struct Listed {
	dir:     Dir,
	/// In [`TreeOptions::order`].
	listing: Listing,
	names:   Names,
	/// Its ignore files, when the walk honours them.
	ignores: DirIgnores,
	/// Its identity, under [`Follow::Always`].
	id:      Option<FileId>,
	/// How long opening and listing it took.
	took:    Duration,
}

/// How [`list`] reaches a directory.
enum Open<'a> {
	/// Already open (the root).
	Opened(Dir),
	/// The subdirectory `name` of an open parent, refusing a symlink that
	/// replaced it.
	Child(&'a Dir, &'a [u8]),
	/// By absolute path, following symlinks.
	Path(&'a Path),
}

/// An owned [`Open`], for a listing read ahead.
enum Target {
	Child(Arc<Dir>, Box<[u8]>),
	Path(PathBuf),
}

/// The native path of the child `name` of the directory at `parent`
/// (encoded `OsStr` bytes).
fn child_path(parent: &[u8], name: &[u8]) -> PathBuf {
	let mut path = Vec::with_capacity(parent.len() + 1 + name.len());
	path.extend_from_slice(parent);
	if !path.last().is_some_and(|&byte| is_separator(byte)) {
		path.push(SEP);
	}
	path.extend_from_slice(name);
	// SAFETY: an encoded `OsStr`, an ASCII separator, and a listed name.
	PathBuf::from(unsafe { std::ffi::OsString::from_encoded_bytes_unchecked(path) })
}

/// What [`list`] needs besides the directory.
struct ListSpec {
	detail:   Detail,
	children: u32,
	order:    Order,
	/// The ignore files to load from the directory.
	ignores:  Option<Sources>,
	/// Leave the directory unlisted unless it is on this device.
	device:   Option<FileId>,
	/// Identify the directory, for loop detection.
	identify: bool,
}

/// Opens and lists one directory into `listing` (recycled), on the
/// traversal or ahead of it: `None` when it lies on another device than
/// `spec.device`.
async fn list(
	session: &mut Session,
	open: Open<'_>,
	spec: &ListSpec,
	mut listing: Listing,
) -> io::Result<Option<Listed>> {
	let started = Instant::now();
	let dir = match open {
		Open::Opened(dir) => dir,
		Open::Child(parent, name) => session.open_child(parent, name).await?,
		Open::Path(path) => session.open_dir(path).await?,
	};
	if let Some(device) = spec.device {
		let id = session.identify_dir(&dir).await.ok();
		if !id.is_some_and(|id| id.dev == device.dev && id.native == device.native) {
			return Ok(None);
		}
	}
	session
		.list_into(&dir, spec.detail, spec.children, &mut listing)
		.await?;
	sort(&mut listing, spec.order);
	let mut names = Names::default();
	let mut ignores = DirIgnores::default();
	if let Some(sources) = spec.ignores {
		for record in listing.records() {
			names.record(listing.name(record), record.file_type, sources.custom);
		}
		if !names.is_empty() {
			ignores = DirIgnores::load(session, &dir, names, sources, false).await;
		}
	}
	let id = if spec.identify {
		session.identify_dir(&dir).await.ok()
	} else {
		None
	};
	Ok(Some(Listed { dir, listing, names, ignores, id, took: started.elapsed() }))
}

/// Puts `listing` in `order`.
fn sort(listing: &mut Listing, order: Order) {
	let Listing { records, names } = listing;
	let names = names.as_slice();
	match order {
		Order::Listing => {},
		Order::Names => {
			records.sort_unstable_by(|a, b| record_name(names, a).cmp(record_name(names, b)));
		},
		Order::Paths => {
			let key = |record: &Record| {
				let slash = (record.file_type == FileType::Dir).then_some(&b'/');
				record_name(names, record).iter().chain(slash)
			};
			records.sort_unstable_by(|a, b| key(a).cmp(key(b)));
		},
	}
}

/// Listings a walk rooted on a network filesystem keeps in flight: each one
/// is mostly a round trip, not disk or CPU work.
const REMOTE_WINDOW: usize = 32;

/// Listing time past which reading ahead pays for its hand-offs. Warm local
/// listings take a few microseconds; a cold disk or a network round trip,
/// milliseconds.
const SLOW_LISTING: Duration = Duration::from_micros(100);

/// Listings read ahead and not yet walked, per listing in flight: finished
/// ones wait for the traversal holding a descriptor and a listing each.
const HELD_PER_ACTIVE: usize = 8;

/// Counts a read-ahead listing as running until it finishes or is
/// dropped unstarted.
struct Active(Arc<AtomicUsize>);

impl Active {
	fn start(count: &Arc<AtomicUsize>) -> Self {
		count.fetch_add(1, Ordering::Relaxed);
		Self(Arc::clone(count))
	}
}

impl Drop for Active {
	fn drop(&mut self) {
		self.0.fetch_sub(1, Ordering::Relaxed);
	}
}

/// Runs `fut`, a native filesystem call that never suspends, without a
/// scheduler round trip; `runtime` drives it should it suspend after all.
fn now<F: Future>(runtime: &Handle, fut: F) -> F::Output {
	let mut fut = pin!(fut);
	match fut.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
		Poll::Ready(out) => out,
		Poll::Pending => runtime.block_on(fut),
	}
}

/// The directories being listed, deepest last. Dropped deepest first, so
/// no frame releases a long ignore chain while ancestors still hold it.
struct Stack(Vec<Frame>);

impl Drop for Stack {
	fn drop(&mut self) {
		while self.0.pop().is_some() {}
	}
}

/// Directory handles kept open down the stack for relative child opens;
/// deeper directories open by path, so deep trees cannot exhaust
/// descriptors.
const MAX_OPEN_DIRS: usize = 64;

/// Where a [`Tree`] is in its traversal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
	/// Nothing reported yet.
	Root,
	/// The root is reported (or not wanted); its listing is next.
	Init,
	/// Entries of the directories on the stack.
	Walk,
	/// The root's contents-first report, if wanted.
	Tail,
	Done,
}

/// What a [`Tree`] reports next, resolved against the paths in [`Cx`].
#[derive(Clone, Copy)]
enum Emit {
	Entry(Post),
	/// The error in [`Cx::error`].
	Error,
}

/// A directory just reported, whose descent waits for [`Tree::skip_dir`].
#[derive(Clone, Copy)]
struct Descent {
	/// Record of the directory in the top frame's listing.
	index:    usize,
	followed: bool,
	/// Identity of a followed link's target.
	target:   Option<FileId>,
	depth:    usize,
	saved:    (usize, usize),
}

/// What happens before the next event, once the last one is delivered.
#[derive(Clone, Copy)]
enum After {
	Nothing,
	/// The root was reported before its listing.
	Root,
	/// Descend into the reported directory.
	Descend(Descent),
	/// Restore the paths to these lengths.
	Restore((usize, usize)),
	/// Report `post`, then restore the paths.
	Post {
		post:    Post,
		restore: (usize, usize),
	},
}

/// What entering one entry came to.
enum Entered {
	/// Nothing to report; paths are restored.
	Next,
	Emit(Emit),
	/// Walk this directory next; the entry's path stays pushed.
	Push(Frame),
}

/// A serial depth-first traversal driven by the caller.
///
/// [`Tree::next`] yields events in [`TreeOptions`] order and
/// [`Tree::skip_dir`] prunes the directory just reported. Dropping it cancels
/// the traversal; it spends the task's coop budget per entry, so a raced
/// traversal (`select!`, timeout) gets cancelled even when no listing
/// suspends.
pub struct Tree {
	stack: Stack,
	cx:    Cx,
	phase: Phase,
	/// Kind, size, and mtime of the root.
	root:  Post,
}

impl Tree {
	/// Opens `root` for traversal under `opts`. Under [`Follow::Never`] a
	/// symlinked root is reported (if `emit_root`) and not descended.
	///
	/// # Errors
	/// [`WalkError::Root`] when `root` does not exist.
	pub async fn new(fs: &Fs, root: &Path, opts: &TreeOptions) -> Result<Self, WalkError> {
		let abs_root = absolute_root(fs, root);
		let mut session = take_session(fs);
		let root_error = |error| WalkError::Root { path: root.to_path_buf(), error };
		let follow_root = opts.follow != Follow::Never;
		let stat = match session.stat(&abs_root, follow_root).await {
			Ok(info) => Ok(info),
			// A dangling root link is reported as the link.
			Err(error) if follow_root && error.kind() == io::ErrorKind::NotFound => session
				.stat(&abs_root, false)
				.await
				.map_err(|_| root_error(error)),
			Err(error) => Err(root_error(error)),
		};
		let info = match stat {
			Ok(info) => info,
			Err(error) => {
				give_session(fs, session);
				return Err(error);
			},
		};
		let full = opts.detail == Detail::Full;
		let file_type = info.file_type;
		let phase = if file_type.is_none() || opts.max_depth.is_some_and(|max| opts.min_depth > max) {
			Phase::Done
		} else {
			Phase::Root
		};
		let file_type = file_type.unwrap_or(FileType::File);
		let fences = Fences::of(fs, &abs_root);
		let runtime = Handle::try_current().ok().filter(|_| fs.is_native());
		let workers = Options { workers: opts.workers, ..Options::default() }.parallelism(fs);
		let window = match runtime {
			Some(_) if workers > 1 && fences.remote_root() => REMOTE_WINDOW,
			Some(_) if workers > 1 => workers,
			_ => 0,
		};
		let held_cap = window * HELD_PER_ACTIVE;
		// Network listings are presumed slow until measured.
		let latency = if fences.remote_root() {
			SLOW_LISTING * 2
		} else {
			Duration::ZERO
		};
		Ok(Self {
			stack: Stack(Vec::new()),
			phase,
			root: Post {
				file_type,
				depth: 0,
				size: (full && file_type == FileType::File).then_some(info.size),
				mtime: full.then_some(info.stamp.mtime),
			},
			cx: Cx {
				abs: abs_root.as_os_str().as_encoded_bytes().to_vec(),
				fs: fs.clone(),
				opts: opts.clone(),
				session: ManuallyDrop::new(session),
				root: abs_root,
				ignorer: None,
				root_dev: None,
				ancestors: Vec::new(),
				pool: Vec::new(),
				ign: Vec::new(),
				rel: Vec::new(),
				open_dirs: 0,
				error: None,
				after: After::Nothing,
				fences,
				runtime,
				window,
				held_cap,
				active: Arc::default(),
				held: 0,
				exhausted: false,
				latency,
				slow: SLOW_LISTING,
				scratch: Vec::new(),
			},
		})
	}

	/// The next event; `None` once the traversal is complete.
	pub async fn next(&mut self) -> Option<Event<'_>> {
		let emit = self.advance().await?;
		Some(match emit {
			Emit::Entry(post) => Event::Entry(self.cx.entry(post)),
			Emit::Error => Event::Error(self.cx.error.as_ref().expect("an error was just recorded")),
		})
	}

	/// Reads ahead whatever listings cost.
	#[cfg(test)]
	pub(crate) const fn read_ahead_always(&mut self) {
		self.cx.slow = Duration::ZERO;
	}

	/// Do not descend into the directory [`Tree::next`] just reported (no
	/// effect for other entries or under `contents_first`).
	pub const fn skip_dir(&mut self) {
		match self.cx.after {
			After::Descend(descent) => self.cx.after = After::Restore(descent.saved),
			After::Root => {
				self.cx.after = After::Nothing;
				self.phase = Phase::Done;
			},
			_ => {},
		}
	}

	/// Runs the traversal to the next report.
	async fn advance(&mut self) -> Option<Emit> {
		loop {
			match std::mem::replace(&mut self.cx.after, After::Nothing) {
				After::Nothing | After::Root => {},
				After::Restore((rel, abs)) => self.cx.restore(rel, abs),
				After::Post { post, restore } => {
					self.cx.after = After::Restore(restore);
					return Some(Emit::Entry(post));
				},
				After::Descend(descent) => {
					let parent = self
						.stack
						.0
						.last_mut()
						.expect("a reported directory has a parent");
					let ahead = self.cx.take_ahead(parent, descent.index);
					let parent = &*parent;
					let record = parent.listing.records()[descent.index];
					let name = parent.listing.name(&record);
					let listed = self
						.cx
						.list_child(
							parent,
							ahead,
							descent.followed,
							name,
							descent.target,
							descent.depth,
							record.children,
							None,
							descent.saved,
						)
						.await;
					match listed {
						Ok(Some(frame)) => self.stack.0.push(frame),
						Ok(None) => self.cx.restore(descent.saved.0, descent.saved.1),
						Err(error) => return Some(self.cx.error(error, None, descent.saved)),
					}
				},
			}
			match self.phase {
				Phase::Done => return None,
				Phase::Root => {
					self.phase = Phase::Init;
					if self.cx.opts.emit_root
						&& self.cx.opts.min_depth == 0
						&& !self.cx.opts.contents_first
					{
						self.cx.after = After::Root;
						return Some(Emit::Entry(self.root));
					}
				},
				Phase::Init => {
					self.phase = Phase::Tail;
					if self.root.file_type == FileType::Dir && self.cx.opts.max_depth != Some(0) {
						match self.cx.open_root().await {
							Ok(frame) => {
								self.stack.0.push(frame);
								self.phase = Phase::Walk;
							},
							Err(error) => {
								let saved = (0, self.cx.abs.len());
								return Some(self.cx.error(error, None, saved));
							},
						}
					}
				},
				Phase::Walk => {
					if !self.cx.exhausted && self.cx.room() {
						self.cx.read_ahead(&mut self.stack.0);
					}
					let Some(frame) = self.stack.0.last_mut() else {
						self.phase = Phase::Tail;
						continue;
					};
					if frame.next == frame.listing.len() {
						let frame = self.stack.0.pop().expect("the loop holds a frame");
						if let Some(emit) = self.cx.close(frame) {
							return Some(emit);
						}
						continue;
					}
					let index = frame.next;
					frame.next += 1;
					// Native listings never suspend: spend the task's coop budget
					// so a racing cancellation (`select!`, timeout, abort) and
					// other tasks still get the worker.
					consume_budget().await;
					let parent = self.stack.0.last_mut().expect("the loop holds a frame");
					match self.cx.enter(parent, index).await {
						Entered::Next => {},
						Entered::Emit(emit) => return Some(emit),
						Entered::Push(frame) => self.stack.0.push(frame),
					}
				},
				Phase::Tail => {
					self.phase = Phase::Done;
					if self.cx.opts.emit_root
						&& self.cx.opts.min_depth == 0
						&& self.cx.opts.contents_first
					{
						return Some(Emit::Entry(self.root));
					}
				},
			}
		}
	}
}

impl Drop for Tree {
	fn drop(&mut self) {
		// SAFETY: the session is taken exactly once, here, and not used again.
		let session = unsafe { ManuallyDrop::take(&mut self.cx.session) };
		give_session(&self.cx.fs, session);
	}
}

/// Everything a traversal needs besides the stack of directories.
struct Cx {
	fs:        Fs,
	opts:      TreeOptions,
	session:   ManuallyDrop<Session>,
	/// Absolute root.
	root:      PathBuf,
	ignorer:   Option<Ignorer>,
	root_dev:  Option<FileId>,
	/// Identities of the open directories under [`Follow::Always`].
	ancestors: Vec<FileId>,
	/// Recycled listings.
	pool:      Vec<Listing>,
	ign:       Vec<u8>,
	/// Walk-relative path of the current entry.
	rel:       Vec<u8>,
	/// Absolute path of the current entry (encoded `OsStr` bytes).
	abs:       Vec<u8>,
	open_dirs: usize,
	/// The failure [`Emit::Error`] reports.
	error:     Option<DirError>,
	after:     After,
	/// Network mounts not descended into.
	fences:    Fences,
	/// Runs read-ahead listings; `None` for providers and outside tokio.
	runtime:   Option<Handle>,
	/// Most listings running ahead of the traversal; 0 reads none ahead.
	window:    usize,
	/// Most [`Ahead`]s held, running or finished.
	held_cap:  usize,
	/// Read-ahead listings running.
	active:    Arc<AtomicUsize>,
	/// [`Ahead`]s held by the stack's frames.
	held:      usize,
	/// Every subdirectory of the stack's frames was considered for reading
	/// ahead; a new frame brings more.
	exhausted: bool,
	/// Moving average of how long a listing takes; reading ahead runs while
	/// it exceeds `slow`.
	latency:   Duration,
	/// [`SLOW_LISTING`]; tests lower it to read ahead on fast disks.
	slow:      Duration,
	/// Walk-relative path of a subdirectory considered for reading ahead.
	scratch:   Vec<u8>,
}

/// `bytes` (built from encoded `OsStr` pieces) as a path.
fn as_path(bytes: &[u8]) -> &Path {
	// SAFETY: every byte string passed here concatenates encoded `OsStr`
	// data, ASCII separators, and raw listed names.
	Path::new(unsafe { OsStr::from_encoded_bytes_unchecked(bytes) })
}

fn record_name<'n>(names: &'n [u8], record: &Record) -> &'n [u8] {
	let start = record.name_off as usize;
	&names[start..start + record.name_len as usize]
}

impl Cx {
	/// The report of `post` at the current paths.
	fn entry(&self, post: Post) -> TreeEntry<'_> {
		TreeEntry {
			path:      &self.rel,
			abs:       as_path(&self.abs),
			file_type: post.file_type,
			depth:     post.depth,
			size:      post.size,
			mtime:     post.mtime,
		}
	}

	/// Truncates the paths to the lengths in effect before an entry.
	fn restore(&mut self, rel: usize, abs: usize) {
		self.rel.truncate(rel);
		self.abs.truncate(abs);
	}

	/// Nothing to report for the entry at `saved`: restores the paths.
	fn finish(&mut self, saved: (usize, usize)) -> Entered {
		self.restore(saved.0, saved.1);
		Entered::Next
	}

	/// Records a failure at the current path to report, then `owed` (if any)
	/// and the path restore to `saved`.
	fn error(&mut self, error: io::Error, owed: Option<Post>, saved: (usize, usize)) -> Emit {
		self.error = Some(DirError { path: as_path(&self.abs).to_path_buf(), error });
		self.after = match owed {
			Some(post) => After::Post { post, restore: saved },
			None => After::Restore(saved),
		};
		Emit::Error
	}

	/// Opens and lists the root into its frame.
	async fn open_root(&mut self) -> io::Result<Frame> {
		if self.opts.same_file_system {
			self.root_dev = self.session.identify(&self.root).await.ok();
		}
		let inherited = if self.opts.gitignore {
			let sources = Sources { vcs: true, custom: None, parents: true };
			let (ignorer, frame) =
				Ignorer::new(&mut self.session, &self.fs, &self.root, sources).await;
			self.ignorer = Some(ignorer);
			frame
		} else {
			None
		};
		let saved = (0, self.abs.len());
		let dir = self.session.open_dir(&self.root).await?;
		let spec = self.spec(0, 0, None);
		let listing = self.pool.pop().unwrap_or_default();
		let listed = list(&mut self.session, Open::Opened(dir), &spec, listing)
			.await?
			.expect("a listing without a device check is never skipped");
		Ok(self.frame(listed, 0, inherited.as_ref(), None, saved))
	}

	/// Finishes a fully walked directory: its contents-first report, if any.
	fn close(&mut self, frame: Frame) -> Option<Emit> {
		let Frame { listing, ahead, dir, post, ancestor, rel_len, abs_len, .. } = frame;
		self.release(ahead.len());
		drop(ahead);
		self.pool.push(listing);
		if dir.is_some() {
			self.open_dirs -= 1;
		}
		drop(dir);
		if ancestor {
			self.ancestors.pop();
		}
		if let Some(post) = post {
			self.after = After::Restore((rel_len, abs_len));
			return Some(Emit::Entry(post));
		}
		self.restore(rel_len, abs_len);
		None
	}

	/// Accounts for `count` [`Ahead`]s leaving the stack.
	const fn release(&mut self, count: usize) {
		self.held -= count;
	}

	/// Whether another listing may start ahead of the traversal.
	fn room(&self) -> bool {
		self.latency > self.slow
			&& self.held < self.held_cap
			&& self.active.load(Ordering::Relaxed) < self.window
	}

	/// The read-ahead of `parent`'s `index`th record, if any; earlier ones
	/// are dropped, as the traversal has passed them.
	fn take_ahead(&mut self, parent: &mut Frame, index: usize) -> Option<Ahead> {
		let mut released = 0;
		let mut taken = None;
		while let Some(ahead) = parent.ahead.pop_front_if(|ahead| ahead.index <= index) {
			released += 1;
			if ahead.index == index {
				taken = Some(ahead);
				break;
			}
		}
		self.release(released);
		taken
	}

	/// Starts listing the subdirectories the traversal will descend into
	/// next while there is [`Cx::room`]: the deepest directory's first, each
	/// directory's in record order.
	fn read_ahead(&mut self, stack: &mut [Frame]) {
		for frame in stack.iter_mut().rev() {
			let depth = frame.depth + 1;
			let mut index = if self.opts.max_depth.is_some_and(|max| depth >= max) {
				frame.listing.len()
			} else {
				frame.scan.max(frame.next)
			};
			while index < frame.listing.len() {
				if !self.room() {
					frame.scan = index;
					return;
				}
				let record = frame.listing.records()[index];
				index += 1;
				let name = frame.listing.name(&record);
				if record.file_type != FileType::Dir || !self.descends(frame, name) {
					continue;
				}
				let task = self.spawn(frame.dir.clone(), frame.own_abs, name, depth, record.children);
				frame.ahead.push_back(Ahead { index: index - 1, task });
				self.held += 1;
			}
			frame.scan = index;
		}
		self.exhausted = true;
	}

	/// Whether the traversal descends into `frame`'s listed subdirectory
	/// `name`, as far as names, fences, and ignore files tell.
	fn descends(&mut self, frame: &Frame, name: &[u8]) -> bool {
		if pruned(name, self.opts.hidden, self.opts.skip_git, self.opts.skip_node_modules) {
			return false;
		}
		self.scratch.clear();
		self.scratch.extend_from_slice(&self.rel[..frame.own_rel]);
		if !self.scratch.is_empty() {
			self.scratch.push(b'/');
		}
		self.scratch.extend_from_slice(name);
		!self.fences.contains(&self.scratch)
			&& !self.ignorer.as_ref().is_some_and(|ignorer| {
				ignorer.ignored(frame.ignore.as_deref(), &self.scratch, true, &mut self.ign)
			})
	}

	/// Lists the subdirectory `name` at `depth` of `parent` (open, else by
	/// path from its absolute path, the first `own_abs` bytes of
	/// [`Cx::abs`]) on the blocking pool.
	fn spawn(
		&mut self,
		parent: Option<Arc<Dir>>,
		own_abs: usize,
		name: &[u8],
		depth: usize,
		children: u32,
	) -> JoinHandle<io::Result<Option<Listed>>> {
		let spec = self.spec(depth, children, self.root_dev);
		let listing = self.pool.pop().unwrap_or_default();
		let target = match parent {
			Some(parent) => Target::Child(parent, name.into()),
			None => Target::Path(child_path(&self.abs[..own_abs], name)),
		};
		let runtime = self.runtime.clone().expect("read-ahead runs on a runtime");
		let active = Active::start(&self.active);
		let pool = runtime.clone();
		pool.spawn_blocking(move || {
			let _active = active;
			let open = match &target {
				Target::Child(parent, name) => Open::Child(parent, name),
				Target::Path(path) => Open::Path(path),
			};
			let fs = Fs::native();
			let mut session = take_session(&fs);
			let listed = now(&runtime, list(&mut session, open, &spec, listing));
			give_session(&fs, session);
			listed
		})
	}

	/// How to list a directory at `depth` with `children` entries (0 when
	/// unknown), unless it lies off `device`.
	fn spec(&self, depth: usize, children: u32, device: Option<FileId>) -> ListSpec {
		ListSpec {
			detail: self.detail(depth),
			children,
			order: self.opts.order,
			ignores: self.ignorer.as_ref().map(Ignorer::sources),
			device,
			identify: self.opts.follow == Follow::Always,
		}
	}

	/// The frame of a directory listed at `depth`, at the current paths.
	fn frame(
		&mut self,
		listed: Listed,
		depth: usize,
		parent_ignore: Option<&Arc<IgnoreFrame>>,
		post: Option<Post>,
		saved: (usize, usize),
	) -> Frame {
		let Listed { dir, listing, names, ignores, id, took } = listed;
		self.latency = (self.latency * 7 + took) / 8;
		let ignore = if self.ignorer.is_some() {
			ignores.frame(parent_ignore, names, &self.rel)
		} else {
			None
		};
		if let Some(id) = id {
			self.ancestors.push(id);
		}
		let dir = (self.open_dirs < MAX_OPEN_DIRS).then(|| Arc::new(dir));
		self.open_dirs += usize::from(dir.is_some());
		self.exhausted = false;
		Frame {
			listing,
			next: 0,
			scan: 0,
			ahead: VecDeque::new(),
			depth,
			ignore,
			dir,
			own_rel: self.rel.len(),
			own_abs: self.abs.len(),
			rel_len: saved.0,
			abs_len: saved.1,
			post,
			ancestor: id.is_some(),
		}
	}

	/// Visits the `index`th entry of `parent`.
	async fn enter(&mut self, parent: &mut Frame, index: usize) -> Entered {
		let record = parent.listing.records()[index];
		let name = parent.listing.name(&record);
		if pruned(name, self.opts.hidden, self.opts.skip_git, self.opts.skip_node_modules) {
			return Entered::Next;
		}
		let saved = (self.rel.len(), self.abs.len());
		self.push_name(name);
		self.enter_pushed(parent, index, record, saved).await
	}

	async fn enter_pushed(
		&mut self,
		parent: &mut Frame,
		index: usize,
		record: Record,
		saved: (usize, usize),
	) -> Entered {
		let depth = parent.depth + 1;
		let (mut file_type, mut size, mut mtime) = (record.file_type, record.size, record.mtime);
		let followed = file_type == FileType::Symlink && self.opts.follow == Follow::Always;
		if followed {
			match self.session.stat(as_path(&self.abs), true).await {
				Err(error) => return Entered::Emit(self.error(error, None, saved)),
				Ok(info) => {
					let Some(target) = info.file_type else {
						return self.finish(saved);
					};
					file_type = target;
					if self.detail(parent.depth) == Detail::Full {
						size = (target == FileType::File).then_some(info.size);
						mtime = Some(info.stamp.mtime);
					}
				},
			}
		}
		let is_dir = file_type == FileType::Dir;
		if let Some(ignorer) = &self.ignorer {
			let exempt = matches!(file_type, FileType::File | FileType::Symlink)
				&& self
					.opts
					.unignored_name
					.is_some_and(|unignored| unignored.as_bytes() == parent.listing.name(&record));
			if !exempt && ignorer.ignored(parent.ignore.as_deref(), &self.rel, is_dir, &mut self.ign) {
				return self.finish(saved);
			}
		}
		let mut target = None;
		if followed && is_dir {
			match self.session.identify(as_path(&self.abs)).await {
				Err(error) => return Entered::Emit(self.error(error, None, saved)),
				Ok(id) if self.ancestors.contains(&id) => {
					let error = io::Error::other("filesystem loop detected");
					return Entered::Emit(self.error(error, None, saved));
				},
				Ok(id) => target = Some(id),
			}
		}
		let reported = depth >= self.opts.min_depth;
		let report = Post { file_type, depth, size, mtime };
		let descend = is_dir
			&& self.opts.max_depth.is_none_or(|max| depth < max)
			&& !self.fences.contains(&self.rel);
		if reported && !self.opts.contents_first {
			self.after = if descend {
				After::Descend(Descent { index, followed, target, depth, saved })
			} else {
				After::Restore(saved)
			};
			return Entered::Emit(Emit::Entry(report));
		}
		let post = (reported && self.opts.contents_first).then_some(report);
		if descend {
			let ahead = self.take_ahead(parent, index);
			let parent = &*parent;
			let name = parent.listing.name(&record);
			let listed = self
				.list_child(parent, ahead, followed, name, target, depth, record.children, post, saved)
				.await;
			match listed {
				Ok(Some(frame)) => return Entered::Push(frame),
				Ok(None) => {},
				Err(error) => return Entered::Emit(self.error(error, post, saved)),
			}
		}
		match post {
			Some(post) => {
				self.after = After::Restore(saved);
				Entered::Emit(Emit::Entry(post))
			},
			None => self.finish(saved),
		}
	}

	/// Opens and lists the directory `name` of `parent` (by path when
	/// `followed`), or takes its read-ahead; `None` when it lies on another
	/// filesystem than the root.
	#[expect(clippy::too_many_arguments, reason = "everything one entry decided")]
	async fn list_child(
		&mut self,
		parent: &Frame,
		ahead: Option<Ahead>,
		followed: bool,
		name: &[u8],
		target: Option<FileId>,
		depth: usize,
		children: u32,
		post: Option<Post>,
		saved: (usize, usize),
	) -> io::Result<Option<Frame>> {
		let listed = if let Some(mut ahead) = ahead {
			match (&mut ahead.task).await {
				Ok(listed) => listed?,
				Err(join) if join.is_panic() => std::panic::resume_unwind(join.into_panic()),
				Err(join) => return Err(io::Error::other(join)),
			}
		} else {
			// A followed link's target is identified already.
			let device = match (self.root_dev, target) {
				(Some(root), Some(id)) if id.dev != root.dev || id.native != root.native => {
					return Ok(None);
				},
				(root, None) => root,
				(_, Some(_)) => None,
			};
			let spec = self.spec(depth, children, device);
			let listing = self.pool.pop().unwrap_or_default();
			let open = match (&parent.dir, followed) {
				(Some(dir), false) => Open::Child(dir, name),
				_ => Open::Path(as_path(&self.abs)),
			};
			list(&mut self.session, open, &spec, listing).await?
		};
		Ok(listed.map(|listed| self.frame(listed, depth, parent.ignore.as_ref(), post, saved)))
	}

	/// Listing detail for a directory at `depth`.
	fn detail(&self, depth: usize) -> Detail {
		if self.opts.detail_max_depth.is_some_and(|max| depth >= max) {
			Detail::Minimal
		} else {
			self.opts.detail
		}
	}

	/// Appends the child `name` to the current paths.
	fn push_name(&mut self, name: &[u8]) {
		if !self.rel.is_empty() {
			self.rel.push(b'/');
		}
		self.rel.extend_from_slice(name);
		if self.fs.is_native() {
			if !self.abs.last().is_some_and(|&byte| is_separator(byte)) {
				self.abs.push(SEP);
			}
			self.abs.extend_from_slice(name);
		} else {
			// URL children append one percent-encoded segment, keeping the
			// parent spelling as a prefix.
			self.abs = self
				.fs
				.join(as_path(&self.abs), name)
				.into_os_string()
				.into_encoded_bytes();
		}
	}
}
