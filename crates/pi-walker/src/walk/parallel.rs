//! The tokio engine behind [`super::walk`] and [`super::collect`].
//!
//! A walk spawns `Options::parallelism` long-lived worker tasks on the
//! current tokio runtime, once. Each owns a scratch (sessions, listing
//! buffers, path arenas) and takes directory jobs from a shared queue: it
//! lists a directory, visits its entries, queues all but the first
//! subdirectory it finds and continues with that first subdirectory itself,
//! awaiting only filesystem calls and, in a streaming walk, room in the
//! bounded output channel. The walk is over once no job is queued or running.
//!
//! A [`Sink`] may also settle each directory's visited items on the worker
//! that listed it, before they are sent ([`Sink::settle`]): a search reads
//! and scans the directory's files there, with the worker's own session and
//! state, so no second pool or hand-off sits between walking and searching.
//! The root is listed before the walk starts (its errors fail the start) but
//! settled by a worker, so a large root never holds the start up and the
//! start never waits on the output channel.
//!
//! Dropping the consumer ends the walk: workers are aborted and check the
//! halt flag before each directory and each entry.

use std::{
	cmp::Ordering as CmpOrdering,
	convert::Infallible,
	io,
	marker::PhantomData,
	mem::ManuallyDrop,
	ops::{Deref, DerefMut},
	path::{Path, PathBuf},
	sync::{
		Arc, OnceLock,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use parking_lot::Mutex;
use tokio::{sync::mpsc, task::AbortHandle};

use super::{
	Action, Batch, DirError, Entry, Options, WalkError, Worker, absolute_root,
	arena::{Arena, Bytes},
	cache::Cache,
	give_session, join_child_into, join_into, pruned, take_session,
};
use crate::{
	fs::{Detail, Dir, FileId, FileInfo, FileType, Fs, Listing, Session},
	ignore::{DirIgnores, Frame, Ignorer, Names},
};

/// Directory handles kept open so pending children can open relative to
/// them; past the cap, children open by absolute path.
const MAX_RETAINED_DIRS: usize = 1024;

/// What a walk does with entries: [`super::walk`] visits and produces output,
/// [`super::collect`] filters and keeps, a search ([`super::walk_sink`])
/// selects files and scans them as part of the walk.
///
/// Per directory, entries are first [visited](Sink::visit) synchronously into
/// [`Sink::Item`]s, then those are [settled](Sink::settle) into
/// [`Sink::Out`]s on the same worker, which are sent as one batch.
pub(crate) trait Sink: Send + Sync + 'static {
	/// What a directory's visits produce.
	type Item: Send + 'static;
	/// What a settled directory sends through the output channel.
	type Out: Send + 'static;
	/// One worker's state, kept across the directories it settles (buffers,
	/// scanners).
	type State: Send + 'static;
	/// Kept entries are stored, so every entry path goes to the arena.
	const COLLECTS: bool;
	/// Batches carry the directory they were listed from, when the walk may
	/// keep handles open, so consumers can open files relative to it.
	const KEEPS_DIR: bool;

	/// A new worker's state.
	fn state(&self) -> Self::State;

	/// Visits one entry, pushing the directory's items.
	fn visit(
		&self,
		worker: &mut Worker<'_>,
		entry: &mut Entry<'_>,
		out: &mut Vec<Self::Item>,
	) -> Action;

	/// Settles the non-empty `items` of one directory into its output, on the
	/// worker that listed it, with that worker's `session` and `state`.
	/// `dir` is the open listed directory (none for a cached listing), for
	/// opening files relative to it; otherwise they open by
	/// [`Worker::abs_rel`]. No output sends nothing.
	fn settle(
		&self,
		state: &mut Self::State,
		session: &mut Session,
		worker: &mut Worker<'_>,
		dir: Option<&Dir>,
		items: Vec<Self::Item>,
	) -> impl Future<Output = Vec<Self::Out>> + Send;
}

/// [`Sink`] of [`super::walk`].
pub(super) struct WalkSink<T, V> {
	visit: V,
	_out:  PhantomData<fn() -> T>,
}

impl<T, V> WalkSink<T, V> {
	pub(super) const fn new(visit: V) -> Self {
		Self { visit, _out: PhantomData }
	}
}

impl<T, V> Sink for WalkSink<T, V>
where
	T: Send + 'static,
	V: Fn(&mut Worker<'_>, &Entry<'_>, &mut Vec<T>) -> Action + Send + Sync + 'static,
{
	type Item = T;
	type Out = T;
	type State = ();

	const COLLECTS: bool = false;
	const KEEPS_DIR: bool = true;

	fn state(&self) {}

	fn visit(&self, worker: &mut Worker<'_>, entry: &mut Entry<'_>, out: &mut Vec<T>) -> Action {
		(self.visit)(worker, &*entry, out)
	}

	fn settle(
		&self,
		(): &mut (),
		_: &mut Session,
		_: &mut Worker<'_>,
		_: Option<&Dir>,
		items: Vec<T>,
	) -> impl Future<Output = Vec<T>> + Send {
		std::future::ready(items)
	}
}

/// [`Sink`] of [`super::collect`].
pub(super) struct CollectSink<F> {
	filter: F,
}

impl<F> CollectSink<F> {
	pub(super) const fn new(filter: F) -> Self {
		Self { filter }
	}
}

impl<F> Sink for CollectSink<F>
where
	F: Fn(&mut Worker<'_>, &mut Entry<'_>) -> Action + Send + Sync + 'static,
{
	type Item = Infallible;
	type Out = Infallible;
	type State = ();

	const COLLECTS: bool = true;
	const KEEPS_DIR: bool = false;

	fn state(&self) {}

	fn visit(
		&self,
		worker: &mut Worker<'_>,
		entry: &mut Entry<'_>,
		_out: &mut Vec<Infallible>,
	) -> Action {
		(self.filter)(worker, entry)
	}

	fn settle(
		&self,
		(): &mut (),
		_: &mut Session,
		_: &mut Worker<'_>,
		_: Option<&Dir>,
		items: Vec<Infallible>,
	) -> impl Future<Output = Vec<Infallible>> + Send {
		std::future::ready(items)
	}
}

/// State a walk shares with its consumer.
#[derive(Default)]
pub(super) struct Shared {
	/// Ends the walk: the consumer went away, a visitor stopped it or
	/// panicked, or the output channel closed.
	halt:      AtomicBool,
	/// A visitor panicked.
	panicked:  AtomicBool,
	errors:    Mutex<Vec<DirError>>,
	/// The consumer went away: tasks are aborted, not just halted (a visitor's
	/// stop leaves queued output to finish).
	cancelled: AtomicBool,
	/// The start task and every worker task, for [`Halt`] to abort.
	tasks:     Mutex<Vec<AbortHandle>>,
}

impl Shared {
	/// Directories that could not be read, in no particular order.
	pub(super) fn take_errors(&self) -> Vec<DirError> {
		std::mem::take(&mut *self.errors.lock())
	}

	/// Re-raises a visitor panic, which the task's join swallowed.
	pub(super) fn check_panic(&self) {
		assert!(!self.panicked.load(Ordering::Relaxed), "a walk visitor panicked");
	}

	fn halted(&self) -> bool {
		self.halt.load(Ordering::Relaxed)
	}

	fn halt(&self) {
		self.halt.store(true, Ordering::Relaxed);
	}
}

/// Halts the walk and aborts its tasks when its consumer drops it, also while
/// the walk is still starting.
pub(super) struct Halt(pub(super) Arc<Shared>);

impl Drop for Halt {
	fn drop(&mut self) {
		self.0.cancelled.store(true, Ordering::Relaxed);
		self.0.halt();
		let tasks = std::mem::take(&mut *self.0.tasks.lock());
		for task in tasks {
			task.abort();
		}
	}
}

impl Shared {
	/// Registers `task` for [`Halt`] to abort; aborts it at once when the
	/// consumer dropped the walk before it was registered.
	fn adopt(&self, task: AbortHandle) {
		self.tasks.lock().push(task.clone());
		if self.cancelled.load(Ordering::Relaxed) {
			task.abort();
		}
	}
}

/// A collected entry whose path lives in a scratch arena.
#[derive(Clone, Copy, Debug)]
pub(super) struct Stored {
	pub(super) path:      Bytes,
	pub(super) file_type: FileType,
	pub(super) depth:     usize,
	pub(super) size:      Option<u64>,
	pub(super) mtime:     Option<i64>,
}

/// One directory's share of a sorted collection, set once by the worker that
/// lists it.
type Slot = OnceLock<Vec<Item>>;

/// An entry (key `name`) or a subtree (key `name/`) of one directory.
/// Sorting these keys orders the directory's part of the output exactly as
/// sorting full paths would: a sibling such as `a-b` lands between directory
/// `a` and its contents `a/…` because `-` < `/`.
struct Item {
	name: Bytes,
	kind: ItemKind,
}

enum ItemKind {
	Entry(Stored),
	Dir(Arc<Slot>),
}

fn compare_items(a: &Item, b: &Item) -> CmpOrdering {
	// SAFETY: item names live in scratch arenas that outlive the walk.
	let (an, bn) = unsafe { (a.name.get(), b.name.get()) };
	let n = an.len().min(bn.len());
	match an[..n].cmp(&bn[..n]) {
		CmpOrdering::Equal => {},
		other => return other,
	}
	// One name is a prefix of the other; compare the next key byte, where a
	// subtree key continues with '/' and an entry key ends.
	let next = |name: &[u8], item: &Item| -> i32 {
		if name.len() > n {
			i32::from(name[n])
		} else if matches!(item.kind, ItemKind::Dir(_)) {
			i32::from(b'/')
		} else {
			-1
		}
	};
	next(an, a).cmp(&next(bn, b))
}

/// Appends the entries of the sorted tree below `root` in order.
fn flatten(root: &Slot, out: &mut Vec<Stored>) {
	let mut stack = Vec::new();
	if let Some(items) = root.get() {
		stack.push(items.iter());
	}
	while let Some(top) = stack.last_mut() {
		let Some(item) = top.next() else {
			stack.pop();
			continue;
		};
		match &item.kind {
			ItemKind::Entry(entry) => out.push(*entry),
			ItemKind::Dir(slot) => {
				if let Some(items) = slot.get() {
					stack.push(items.iter());
				}
			},
		}
	}
}

/// A directory handle shared by the jobs of its subdirectories; closed when
/// the last of them has opened its own handle.
struct Held {
	dir:      Arc<Dir>,
	retained: Arc<AtomicUsize>,
}

impl Drop for Held {
	fn drop(&mut self) {
		self.retained.fetch_sub(1, Ordering::Relaxed);
	}
}

/// A directory waiting to be listed.
struct Job {
	/// Open parent to resolve the name against; `None` opens by path.
	parent:   Option<Arc<Held>>,
	/// Walk-relative path; empty for the root.
	rel:      Bytes,
	/// Length of the final component of `rel`.
	name_len: usize,
	/// The root is 0.
	depth:    usize,
	/// Child count from the parent's listing, 0 if unknown.
	count:    u32,
	frame:    Option<Arc<Frame>>,
	/// Sorted-collection slot.
	out:      Option<Arc<Slot>>,
}

/// One worker's scratch.
struct Scratch<S> {
	session: Session,
	/// The sink's per-worker state ([`Sink::State`]).
	state:   S,
	/// Absolute path scratch (cache keys, opens by path, [`Worker::abs`]).
	abs:     PathBuf,
	/// Volatile path of a visited entry that is not retained.
	rel:     Vec<u8>,
	/// Ignore-matching scratch.
	ign:     Vec<u8>,
	/// Ignore-source paths for cache revalidation.
	probe:   Vec<u8>,
	listing: Listing,
	/// Owns every retained path this scratch carved.
	arena:   Arena,
	/// Unordered collection.
	out:     Vec<Stored>,
	/// The first subdirectory the last listing found, for the listing worker
	/// to continue with itself.
	carry:   Option<Job>,
}

/// A directory listed and visited whose items are not yet settled.
struct Listed<K: Sink> {
	/// The open directory, when the listing was not served from the cache.
	dir:   Option<Arc<Dir>>,
	/// Whether the output batch carries `dir` (the walk may keep it open).
	share: bool,
	items: Vec<K::Item>,
}

impl<S> Scratch<S> {
	fn new(fs: &Fs, state: S) -> Self {
		Self {
			session: take_session(fs),
			state,
			abs: PathBuf::new(),
			rel: Vec::new(),
			ign: Vec::new(),
			probe: Vec::new(),
			listing: Listing::default(),
			arena: Arena::default(),
			out: Vec::new(),
			carry: None,
		}
	}
}

/// State shared by one walk's workers.
struct Ctx<K: Sink> {
	fs:        Fs,
	/// Absolute root.
	root:      PathBuf,
	opts:      Options,
	sink:      K,
	ignorer:   Option<Ignorer>,
	cache:     Option<&'static Cache>,
	/// Device of the root under `same_file_system`.
	root_dev:  Option<FileId>,
	retained:  Arc<AtomicUsize>,
	/// Job queue; `None` tells a worker the walk is over.
	jobs:      flume::Sender<Option<Job>>,
	workers:   usize,
	/// Jobs queued or running; a job's continuation counts as part of it.
	pending:   AtomicUsize,
	/// Scratch of workers that ended; every arena is in here or owned by a
	/// running worker.
	scratches: Mutex<Vec<Scratch<K::State>>>,
	shared:    Arc<Shared>,
	/// Output channel of a streaming walk.
	tx:        Option<mpsc::Sender<Batch<K::Out>>>,
	/// Collected entries.
	total:     AtomicUsize,
}

impl<K: Sink> Drop for Ctx<K> {
	fn drop(&mut self) {
		for scratch in self.scratches.get_mut().drain(..) {
			give_session(&self.fs, scratch.session);
		}
	}
}

/// A worker's [`Scratch`], handed back to the walk when the worker ends, also
/// when a visitor panics (which halts the walk) or the task is aborted.
struct Owned<'c, K: Sink> {
	ctx:     &'c Ctx<K>,
	scratch: ManuallyDrop<Scratch<K::State>>,
}

impl<'c, K: Sink> Owned<'c, K> {
	const fn new(ctx: &'c Ctx<K>, scratch: Scratch<K::State>) -> Self {
		Self { ctx, scratch: ManuallyDrop::new(scratch) }
	}
}

impl<K: Sink> Deref for Owned<'_, K> {
	type Target = Scratch<K::State>;

	fn deref(&self) -> &Scratch<K::State> {
		&self.scratch
	}
}

impl<K: Sink> DerefMut for Owned<'_, K> {
	fn deref_mut(&mut self) -> &mut Scratch<K::State> {
		&mut self.scratch
	}
}

impl<K: Sink> Drop for Owned<'_, K> {
	fn drop(&mut self) {
		if std::thread::panicking() {
			self.ctx.shared.panicked.store(true, Ordering::Relaxed);
			self.ctx.shared.halt();
			self.ctx.stop();
		}
		// SAFETY: the scratch is taken exactly once, here, and not used again.
		let scratch = unsafe { ManuallyDrop::take(&mut self.scratch) };
		self.ctx.scratches.lock().push(scratch);
	}
}

/// A started walk: the root is listed and its subdirectories are running.
pub(super) struct Started<K: Sink> {
	ctx:             Arc<Ctx<K>>,
	root_slot:       Option<Arc<Slot>>,
	/// Disconnects once every worker has ended.
	done:            flume::Receiver<()>,
	/// Halts the walk and aborts its workers when dropped.
	pub(super) halt: Halt,
}

/// What a finished collecting walk hands back.
pub(super) struct Outcome {
	pub(super) entries: Vec<Stored>,
	/// Owners of every `entries` path.
	pub(super) arenas:  Vec<Arena>,
	pub(super) errors:  Vec<DirError>,
}

/// Lists `root` and starts walking below it; the root's own items are settled
/// by a worker, not before this returns. `sorted` orders a collection by
/// path; `tx` receives a streaming walk's output.
///
/// # Errors
/// [`WalkError::Root`] when the root cannot be opened or listed.
pub(super) async fn start<K: Sink>(
	fs: &Fs,
	root: &Path,
	opts: &Options,
	sink: K,
	sorted: bool,
	cache: Option<&'static Cache>,
	tx: Option<mpsc::Sender<Batch<K::Out>>>,
) -> Result<Started<K>, WalkError> {
	let shared = Arc::new(Shared::default());
	let halt = Halt(Arc::clone(&shared));
	let (fs, given, opts) = (fs.clone(), root.to_path_buf(), opts.clone());
	let begun = tokio::spawn(async move {
		let root_error = |error: io::Error| WalkError::Root { path: given.clone(), error };
		let abs_root = absolute_root(&fs, &given);
		let workers = opts.parallelism(&fs);
		let mut st = Scratch::new(&fs, sink.state());
		let root_dir = st.session.open_dir(&abs_root).await.map_err(root_error)?;
		let cache = cache
			.filter(|_| opts.detail == Detail::Minimal && fs.is_native() && !opts.same_file_system);
		let (ignorer, root_frame) = if opts.gitignore {
			let (ignorer, frame) = Ignorer::new(&mut st.session, &fs, &abs_root).await;
			(Some(ignorer), frame)
		} else {
			(None, None)
		};
		let root_dev = if opts.same_file_system {
			st.session.identify_dir(&root_dir).await.ok()
		} else {
			None
		};
		let (jobs, queue) = flume::unbounded();
		let ctx = Arc::new(Ctx {
			fs,
			root: abs_root,
			opts,
			sink,
			ignorer,
			cache,
			root_dev,
			retained: Arc::new(AtomicUsize::new(0)),
			jobs,
			workers,
			pending: AtomicUsize::new(0),
			scratches: Mutex::new(Vec::new()),
			shared,
			tx,
			total: AtomicUsize::new(0),
		});
		let root_slot = sorted.then(|| Arc::new(Slot::new()));
		let root_job = Job {
			parent:   None,
			rel:      Bytes::EMPTY,
			name_len: 0,
			depth:    0,
			count:    0,
			frame:    root_frame,
			out:      root_slot.clone(),
		};
		let rooted = ctx.list_dir(&mut st, root_job, Some(root_dir)).await;
		let mut first = st.carry.take().filter(|_| !ctx.shared.halted());
		let listed = match rooted {
			Ok(listed) => Some(listed).filter(|listed| !listed.items.is_empty()),
			Err(error) => {
				ctx.scratches.lock().push(st);
				return Err(root_error(error));
			},
		};
		if listed.is_some() {
			// The seed worker settles the root, so its first subdirectory goes
			// to the queue for any worker; settling is part of the walk.
			if let Some(job) = first.take() {
				ctx.enqueue(job);
			}
			ctx.pending.fetch_add(1, Ordering::Relaxed);
		} else if first.is_some() {
			ctx.pending.fetch_add(1, Ordering::Relaxed);
		}
		let (done_tx, done) = flume::unbounded();
		if first.is_some() || listed.is_some() {
			let mut seed = Some((st, first, listed));
			for _ in 0..workers {
				let (scratch, first, listed) = match seed.take() {
					Some(seed) => seed,
					None => (Scratch::new(&ctx.fs, ctx.sink.state()), None, None),
				};
				let worker =
					Arc::clone(&ctx).work(scratch, first, listed, queue.clone(), done_tx.clone());
				ctx.shared.adopt(tokio::spawn(worker).abort_handle());
			}
		} else {
			ctx.scratches.lock().push(st);
		}
		Ok::<_, WalkError>((ctx, root_slot, done))
	});
	halt.0.adopt(begun.abort_handle());
	let (ctx, root_slot, done) = match begun.await {
		Ok(begun) => begun?,
		Err(join) => std::panic::resume_unwind(join.into_panic()),
	};
	Ok(Started { ctx, root_slot, done, halt })
}

impl<K: Sink> Started<K> {
	/// Resolves once every worker has ended.
	pub(super) async fn finished(&self) {
		let _ = self.done.recv_async().await;
	}

	/// The kept entries of a finished collecting walk.
	pub(super) fn into_outcome(self) -> Outcome {
		let ctx = &self.ctx;
		ctx.shared.check_panic();
		let scratches = std::mem::take(&mut *ctx.scratches.lock());
		let mut entries = Vec::with_capacity(ctx.total.load(Ordering::Relaxed));
		let mut arenas = Vec::with_capacity(scratches.len());
		for Scratch { session, arena, out, .. } in scratches {
			give_session(&ctx.fs, session);
			arenas.push(arena);
			if self.root_slot.is_none() {
				entries.extend(out);
			}
		}
		if let Some(slot) = &self.root_slot {
			flatten(slot, &mut entries);
		}
		Outcome { entries, arenas, errors: ctx.shared.take_errors() }
	}
}

impl<K: Sink> Ctx<K> {
	/// Queues `job` for any worker.
	fn enqueue(&self, job: Job) {
		self.pending.fetch_add(1, Ordering::Relaxed);
		// The queue is unbounded and a send fails only once every worker is gone.
		let _ = self.jobs.send(Some(job));
	}

	/// Tells every worker the walk is over.
	fn stop(&self) {
		for _ in 0..self.workers {
			let _ = self.jobs.send(None);
		}
	}

	/// One worker: settles the already listed `root` if it has one (counted
	/// as a job), runs `first`, then jobs from `queue`, until the walk's last
	/// job has finished. `_done` disconnects when the worker ends.
	async fn work(
		self: Arc<Self>,
		scratch: Scratch<K::State>,
		first: Option<Job>,
		root: Option<Listed<K>>,
		queue: flume::Receiver<Option<Job>>,
		_done: flume::Sender<()>,
	) {
		let mut scratch = Owned::new(self.as_ref(), scratch);
		if let Some(root) = root {
			self.deliver(&mut scratch, root).await;
			if self.pending.fetch_sub(1, Ordering::AcqRel) == 1 {
				self.stop();
				return;
			}
		}
		let mut next = first;
		loop {
			let job = match next.take() {
				Some(job) => job,
				None => match queue.recv_async().await {
					Ok(Some(job)) => job,
					Ok(None) | Err(_) => break,
				},
			};
			self.chain(&mut scratch, job).await;
			if self.pending.fetch_sub(1, Ordering::AcqRel) == 1 {
				self.stop();
				break;
			}
		}
	}

	/// Records a directory below the root that could not be read.
	fn report(&self, rel: Bytes, error: io::Error) {
		// SAFETY: job paths live in scratch arenas, which the context keeps
		// until the walk is finished.
		let path = self.fs.join(&self.root, unsafe { rel.get() });
		self.shared.errors.lock().push(DirError { path, error });
	}

	/// Lists and visits `job`, then keeps going with the first subdirectory
	/// it found (the others are queued); nothing happens once the walk is
	/// halted. Unreadable directories are reported.
	async fn chain(&self, st: &mut Scratch<K::State>, mut job: Job) {
		loop {
			if self.shared.halted() {
				break;
			}
			let rel = job.rel;
			if let Err(error) = self.visit_dir(st, job, None).await {
				self.report(rel, error);
			}
			let Some(next) = st.carry.take() else {
				break;
			};
			job = next;
		}
	}

	/// Lists and visits one directory, then settles and sends its output.
	async fn visit_dir(
		&self,
		st: &mut Scratch<K::State>,
		job: Job,
		opened: Option<Dir>,
	) -> io::Result<()> {
		let listed = self.list_dir(st, job, opened).await?;
		self.deliver(st, listed).await;
		Ok(())
	}

	/// Settles the items of a listed directory on this worker, with its
	/// session and state, and sends the output. A streaming walk waits here
	/// for room in its channel, pausing the worker while the consumer is not
	/// polling.
	async fn deliver(&self, st: &mut Scratch<K::State>, listed: Listed<K>) {
		let Listed { dir, share, items } = listed;
		if items.is_empty() {
			return;
		}
		let Scratch { session, abs, state, .. } = st;
		let mut worker = Worker { fs: &self.fs, root: &self.root, abs };
		let out = self
			.sink
			.settle(state, session, &mut worker, dir.as_deref(), items)
			.await;
		let Some(tx) = &self.tx else {
			return;
		};
		if out.is_empty() {
			return;
		}
		let dir = if share && K::KEEPS_DIR { dir } else { None };
		if tx.send(Batch { dir, items: out }).await.is_err() {
			self.shared.halt();
		}
	}

	/// Lists the directory of `job` (already `opened` for the root) and emits
	/// it. Errors are open and listing failures.
	async fn list_dir(
		&self,
		st: &mut Scratch<K::State>,
		job: Job,
		opened: Option<Dir>,
	) -> io::Result<Listed<K>> {
		let Job { parent, rel: rel_bytes, name_len, depth, count, frame, out } = job;
		// SAFETY: job paths live in scratch arenas, which the context keeps
		// until the walk is finished.
		let rel = unsafe { rel_bytes.get() };
		let dir_job = DirJob { rel: rel_bytes, depth, out };
		if let Some(cache) = self.cache {
			join_into(&self.fs, &self.root, rel, &mut st.abs);
			if let Some(cached) = cache
				.lookup(&mut st.session, &st.abs, self.ignorer.is_some(), &mut st.probe)
				.await
			{
				drop(parent);
				drop(opened);
				let frame = match &cached.ignores {
					Some(ignores) if self.ignorer.is_some() => {
						ignores.frame(frame.as_ref(), cached.names, rel)
					},
					_ => frame,
				};
				let items = self
					.emit(st, dir_job, &cached.listing, frame.as_ref(), None)
					.await;
				return Ok(Listed { dir: None, share: false, items });
			}
		}

		let dir = match (opened, parent) {
			(Some(dir), _) => dir,
			(None, Some(parent)) => {
				let opened = st
					.session
					.open_child(&parent.dir, &rel[rel.len() - name_len..])
					.await;
				drop(parent);
				opened?
			},
			(None, None) => {
				join_into(&self.fs, &self.root, rel, &mut st.abs);
				st.session.open_dir(&st.abs).await?
			},
		};
		if depth > 0
			&& let Some(root_dev) = self.root_dev
		{
			match st.session.identify_dir(&dir).await {
				Ok(id) if id.dev == root_dev.dev && id.native == root_dev.native => {},
				_ => return Ok(Listed { dir: None, share: false, items: Vec::new() }),
			}
		}
		// Stamp before listing: any later change moves the stamp on.
		let stamp = if self.cache.is_some() {
			st.session.stat_dir(&dir).await.ok()
		} else {
			None
		};
		let mut listing = std::mem::take(&mut st.listing);
		if let Err(error) = st
			.session
			.list_into(&dir, self.opts.detail, count, &mut listing)
			.await
		{
			st.listing = listing;
			return Err(error);
		}
		let mut names = Names::default();
		if self.ignorer.is_some() || stamp.is_some() {
			for record in listing.records() {
				names.record(listing.name(record), record.file_type);
			}
		}
		let ignores = if self.ignorer.is_none() {
			None
		} else if names.is_empty() {
			Some(DirIgnores::default())
		} else {
			Some(DirIgnores::load(&mut st.session, &dir, names, stamp.is_some()).await)
		};
		let frame = match &ignores {
			Some(ignores) => ignores.frame(frame.as_ref(), names, rel),
			None => frame,
		};
		if let (Some(cache), Some(stamp)) = (self.cache, stamp) {
			join_into(&self.fs, &self.root, rel, &mut st.abs);
			cache.store(&mut st.session, &st.abs, &dir, stamp, &listing, names, ignores.as_ref());
		}
		let dir = Arc::new(dir);
		let share = self.retained.load(Ordering::Relaxed) < MAX_RETAINED_DIRS;
		let items = self
			.emit(st, dir_job, &listing, frame.as_ref(), share.then_some(&dir))
			.await;
		st.listing = listing;
		Ok(Listed { dir: Some(dir), share, items })
	}

	/// Filters and delivers one directory's listing and queues its
	/// subdirectories; the output its visits produced. With `dir` (passed
	/// while the walk may keep handles open), children open relative to it;
	/// cached and over-cap listings pass `None` and children open by path.
	async fn emit(
		&self,
		st: &mut Scratch<K::State>,
		job: DirJob,
		listing: &Listing,
		frame: Option<&Arc<Frame>>,
		dir: Option<&Arc<Dir>>,
	) -> Vec<K::Item> {
		let opts = &self.opts;
		let mut batch = Vec::new();
		let depth = job.depth + 1;
		if opts.max_depth.is_some_and(|max| depth > max) {
			return batch;
		}
		let descend = opts.max_depth.is_none_or(|max| depth < max);
		// SAFETY: job paths live in scratch arenas, which the context keeps
		// until the walk is finished.
		let rel = unsafe { job.rel.get() };
		let Scratch { session, abs, rel: volatile, ign, arena, out: unordered, carry, .. } = st;
		let mut items = Vec::new();
		if job.out.is_some() {
			items.reserve(listing.len());
		}
		let mut collected = 0usize;
		let mut held: Option<Arc<Held>> = None;
		for record in listing.records() {
			if self.shared.halted() {
				break;
			}
			let name = listing.name(record);
			if pruned(name, opts.hidden, opts.skip_git, opts.skip_node_modules) {
				continue;
			}
			let (mut file_type, mut size, mut mtime) = (record.file_type, record.size, record.mtime);
			if file_type == FileType::Symlink && opts.follow_links {
				let Some((target, info)) = follow(session, abs, &self.fs, &self.root, rel, name).await
				else {
					continue;
				};
				file_type = target;
				size = (target == FileType::File).then_some(info.size);
				mtime = Some(info.stamp.mtime);
			}
			let is_dir = file_type == FileType::Dir;
			let kept = (K::COLLECTS || (is_dir && descend)).then(|| {
				if rel.is_empty() {
					arena.push(&[name])
				} else {
					arena.push(&[rel, b"/", name])
				}
			});
			let path: &[u8] = if let Some(bytes) = kept {
				// SAFETY: the arena outlives the walk.
				unsafe { bytes.get() }
			} else {
				volatile.clear();
				if !rel.is_empty() {
					volatile.extend_from_slice(rel);
					volatile.push(b'/');
				}
				volatile.extend_from_slice(name);
				volatile.as_slice()
			};
			if let Some(ignorer) = &self.ignorer
				&& ignorer.ignored(frame.map(|frame| &**frame), path, is_dir, ign)
			{
				continue;
			}
			let mut entry = Entry { path, file_type, depth, size, mtime };
			let mut worker = Worker { fs: &self.fs, root: &self.root, abs: &mut *abs };
			match self.sink.visit(&mut worker, &mut entry, &mut batch) {
				Action::Stop => {
					self.shared.halt();
					break;
				},
				Action::SkipDir => continue,
				Action::Skip => {},
				Action::Continue => {
					if K::COLLECTS
						&& let Some(bytes) = kept
					{
						let stored = Stored {
							path: bytes,
							file_type: entry.file_type,
							depth,
							size: entry.size,
							mtime: entry.mtime,
						};
						if job.out.is_some() {
							items
								.push(Item { name: bytes.tail(name.len()), kind: ItemKind::Entry(stored) });
						} else {
							unordered.push(stored);
						}
						collected += 1;
					}
				},
			}
			if !is_dir || !descend {
				continue;
			}
			let Some(bytes) = kept else { continue };
			// A linked directory opens by path: `open_child` refuses symlinks.
			let parent = match dir {
				Some(dir) if record.file_type != FileType::Symlink => {
					let held = held.get_or_insert_with(|| {
						self.retained.fetch_add(1, Ordering::Relaxed);
						Arc::new(Held { dir: Arc::clone(dir), retained: Arc::clone(&self.retained) })
					});
					Some(Arc::clone(held))
				},
				_ => None,
			};
			let slot = job.out.as_ref().map(|_| {
				let slot = Arc::new(Slot::new());
				items
					.push(Item { name: bytes.tail(name.len()), kind: ItemKind::Dir(Arc::clone(&slot)) });
				slot
			});
			let child = Job {
				parent,
				rel: bytes,
				name_len: name.len(),
				depth,
				count: record.children,
				frame: frame.cloned(),
				out: slot,
			};
			if carry.is_none() {
				*carry = Some(child);
			} else {
				self.enqueue(child);
			}
		}
		if collected > 0 {
			self.total.fetch_add(collected, Ordering::Relaxed);
		}
		if let Some(out) = job.out {
			items.sort_unstable_by(compare_items);
			let _ = out.set(items);
		}
		batch
	}
}

/// The parts of a job [`Ctx::emit`] needs.
struct DirJob {
	rel:   Bytes,
	depth: usize,
	out:   Option<Arc<Slot>>,
}

/// Resolves the symlink `name` in the walk-relative directory `dir` for
/// [`Options::follow_links`]: `None` for dangling links, links to special
/// files, and links to `dir` or one of its ancestors.
async fn follow(
	session: &mut Session,
	abs: &mut PathBuf,
	fs: &Fs,
	root: &Path,
	dir: &[u8],
	name: &[u8],
) -> Option<(FileType, FileInfo)> {
	join_child_into(fs, root, dir, name, abs);
	let info = session.stat(abs.as_path(), true).await.ok()?;
	match info.file_type? {
		FileType::File => Some((FileType::File, info)),
		FileType::Dir => {
			let target = session.identify(abs.as_path()).await.ok()?;
			// Cycles are rare and shallow: identify the enclosing directories
			// only when a linked directory needs checking.
			let mut up = dir;
			loop {
				join_into(fs, root, up, abs);
				if session
					.identify(abs.as_path())
					.await
					.is_ok_and(|id| id == target)
				{
					return None;
				}
				if up.is_empty() {
					return Some((FileType::Dir, info));
				}
				up = &up[..memchr::memrchr(b'/', up).unwrap_or(0)];
			}
		},
		FileType::Symlink => None,
	}
}
