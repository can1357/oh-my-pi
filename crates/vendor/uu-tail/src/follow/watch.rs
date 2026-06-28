// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) tailable untailable stdlib kqueue Uncategorized
// unwatch

use std::{
	io::{BufRead, Write},
	path::{Path, PathBuf},
	sync::mpsc::{self, Receiver, channel},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher, WatcherKind};
#[cfg(target_os = "linux")]
use uucore::signals::ensure_stdout_not_broken;
use uucore::{
	display::Quotable,
	error::{UResult, USimpleError},
};

use crate::{
	args::{FollowMode, Settings},
	follow::files::{FileHandling, PathData},
	paths::{Input, InputKind, MetadataExtTail, PathExtTail},
	platform, text,
};

pub struct WatcherRx {
	watcher:  Box<dyn Watcher>,
	receiver: Receiver<Result<notify::Event, notify::Error>>,
}

impl WatcherRx {
	fn new(
		watcher: Box<dyn Watcher>,
		receiver: Receiver<Result<notify::Event, notify::Error>>,
	) -> Self {
		Self { watcher, receiver }
	}

	/// Wrapper for `notify::Watcher::watch` to also add the parent directory of
	/// `path` if necessary.
	fn watch_with_parent(&mut self, path: &Path) -> UResult<()> {
		let mut path = path.to_owned();
		#[cfg(target_os = "linux")]
		if path.is_file() {
			/*
			NOTE: Using the parent directory instead of the file is a workaround.
			This workaround follows the recommendation of the notify crate authors:
			> On some platforms, if the `path` is renamed or removed while being watched, behavior may
			> be unexpected. See discussions in [#165] and [#166]. If less surprising behavior is wanted
			> one may non-recursively watch the _parent_ directory as well and manage related events.
			NOTE: Adding both: file and parent results in duplicate/wrong events.
			Tested for notify::InotifyWatcher and for notify::PollWatcher.
			*/
			if let Some(parent) = path.parent() {
				if parent.is_dir() {
					path = parent.to_owned();
				} else {
					path = PathBuf::from(".");
				}
			} else {
				return Err(USimpleError::new(
					1,
					format!("cannot watch parent directory of {}", path.quote()),
				));
			}
		}
		if path.is_relative() {
			path = path.canonicalize()?;
		}

		// for syscalls: 2x "inotify_add_watch" ("filename" and ".") and 1x
		// "inotify_rm_watch"
		self.watch(&path, RecursiveMode::NonRecursive)?;
		Ok(())
	}

	fn watch(&mut self, path: &Path, mode: RecursiveMode) -> UResult<()> {
		self
			.watcher
			.watch(path, mode)
			.map_err(|err| USimpleError::new(1, err.to_string()))
	}

	fn unwatch(&mut self, path: &Path) -> UResult<()> {
		self
			.watcher
			.unwatch(path)
			.map_err(|err| USimpleError::new(1, err.to_string()))
	}
}

pub struct Observer {
	/// Whether --retry was given on the command line
	pub retry: bool,

	/// The [`FollowMode`]
	pub follow: Option<FollowMode>,

	/// Indicates whether to use the fallback `polling` method instead of the
	/// platform specific event driven method. Since `use_polling` is subject to
	/// change during runtime it is moved out of [`Settings`].
	pub use_polling: bool,

	pub watcher_rx: Option<WatcherRx>,
	pub orphans:    Vec<PathBuf>,
	pub files:      FileHandling,

	pub pid: platform::Pid,
}

impl Observer {
	pub fn new(
		retry: bool,
		follow: Option<FollowMode>,
		use_polling: bool,
		files: FileHandling,
		pid: platform::Pid,
	) -> Self {
		let pid = if platform::supports_pid_checks(pid) {
			pid
		} else {
			0
		};

		Self { retry, follow, use_polling, watcher_rx: None, orphans: Vec::new(), files, pid }
	}

	pub fn from(settings: &Settings) -> Self {
		Self::new(
			settings.retry,
			settings.follow,
			settings.use_polling,
			FileHandling::from(settings),
			settings.pid,
		)
	}

	pub fn add_path(
		&mut self,
		path: &Path,
		display_name: &str,
		reader: Option<Box<dyn BufRead>>,
		update_last: bool,
	) -> UResult<()> {
		if self.follow.is_some() {
			let path = if path.is_relative() {
				std::env::current_dir()?.join(path)
			} else {
				path.to_owned()
			};
			let metadata = path.metadata().ok();
			self
				.files
				.insert(&path, PathData::new(reader, metadata, display_name), update_last);
		}

		Ok(())
	}

	pub fn add_bad_path(
		&mut self,
		path: &Path,
		display_name: &str,
		update_last: bool,
	) -> UResult<()> {
		if self.retry && self.follow.is_some() {
			return self.add_path(path, display_name, None, update_last);
		}

		Ok(())
	}

	pub fn start(&mut self, settings: &Settings) -> UResult<()> {
		if settings.follow.is_none() {
			return Ok(());
		}

		let (tx, rx) = channel();

		/*
		Watcher is implemented per platform using the best implementation available on that
		platform. In addition to such event driven implementations, a polling implementation
		is also provided that should work on any platform.
		Linux / Android: inotify
		macOS: FSEvents / kqueue
		Windows: ReadDirectoryChangesWatcher
		FreeBSD / NetBSD / OpenBSD / DragonflyBSD: kqueue
		Fallback: polling every n seconds

		NOTE:
		We force the use of kqueue with: features=["macos_kqueue"].
		On macOS only `kqueue` is suitable for our use case because `FSEvents`
		waits for file close util it delivers a modify event. See:
		https://github.com/notify-rs/notify/issues/240
		*/

		let watcher: Box<dyn Watcher>;
		let watcher_config = notify::Config::default()
			.with_poll_interval(settings.sleep_sec)
			/*
			NOTE: By enabling compare_contents, performance will be significantly impacted
			as all files will need to be read and hashed at each `poll_interval`.
			However, this is necessary to pass: "gnu/tests/tail-2/F-vs-rename.sh"
			*/
			.with_compare_contents(true);
		if self.use_polling || RecommendedWatcher::kind() == WatcherKind::PollWatcher {
			self.use_polling = true; // We have to use polling because there's no supported backend
			watcher = Box::new(notify::PollWatcher::new(tx, watcher_config).unwrap());
		} else {
			let tx_clone = tx.clone();
			match RecommendedWatcher::new(tx, notify::Config::default()) {
				Ok(w) => watcher = Box::new(w),
				Err(e) if e.to_string().starts_with("Too many open files") => {
					/*
					NOTE: This ErrorKind is `Uncategorized`, but it is not recommended
					to match an error against `Uncategorized`
					NOTE: Could be tested with decreasing `max_user_instances`, e.g.:
					`sudo sysctl fs.inotify.max_user_instances=64`
					*/
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"tail: {} cannot be used, reverting to polling: Too many open files",
						text::BACKEND
					);
					pi_uutils_ctx::set_exit_code(1);
					self.use_polling = true;
					watcher = Box::new(notify::PollWatcher::new(tx_clone, watcher_config).unwrap());
				},
				Err(e) => return Err(USimpleError::new(1, e.to_string())),
			}
		}

		self.watcher_rx = Some(WatcherRx::new(watcher, rx));
		self.init_files(&settings.inputs)?;

		Ok(())
	}

	pub fn follow_descriptor(&self) -> bool {
		self.follow == Some(FollowMode::Descriptor)
	}

	pub fn follow_name(&self) -> bool {
		self.follow == Some(FollowMode::Name)
	}

	pub fn follow_descriptor_retry(&self) -> bool {
		self.follow_descriptor() && self.retry
	}

	pub fn follow_name_retry(&self) -> bool {
		self.follow_name() && self.retry
	}

	fn init_files(&mut self, inputs: &Vec<Input>) -> UResult<()> {
		if let Some(watcher_rx) = &mut self.watcher_rx {
			for input in inputs {
				match input.kind() {
					InputKind::Stdin => (),
					InputKind::File(path) => {
						#[cfg(all(unix, not(target_os = "linux")))]
						if !path.is_file() {
							continue;
						}
						let mut path = path.clone();
						if path.is_relative() {
							path = std::env::current_dir()?.join(path);
						}

						if path.is_tailable() {
							// Add existing regular files to `Watcher` (InotifyWatcher).
							watcher_rx.watch_with_parent(&path)?;
						} else if !path.is_orphan() {
							// If `path` is not a tailable file, add its parent to `Watcher`.
							watcher_rx.watch(path.parent().unwrap(), RecursiveMode::NonRecursive)?;
							// Add symlinks to orphans for retry polling (target may not exist)
							if path.is_symlink() {
								self.orphans.push(path);
							}
						} else {
							// If there is no parent, add `path` to `orphans`.
							self.orphans.push(path);
						}
					},
				}
			}
		}
		Ok(())
	}

	#[allow(clippy::cognitive_complexity)]
	fn handle_event(&mut self, event: &notify::Event, settings: &Settings) -> UResult<Vec<PathBuf>> {
		use notify::event::{
			CreateKind, DataChange, EventKind, MetadataKind, ModifyKind, RemoveKind, RenameMode,
		};

		let event_path = event.paths.first().unwrap();
		let mut paths: Vec<PathBuf> = vec![];
		let display_name = self.files.get(event_path).display_name.clone();

		match event.kind {
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any | MetadataKind::WriteTime) | ModifyKind::Data(DataChange::Any) | ModifyKind::Name(RenameMode::To)) |
            EventKind::Create(CreateKind::File | CreateKind::Folder | CreateKind::Any) => {
                if let Ok(new_md) = event_path.metadata() {
                    let is_tailable = new_md.is_tailable();
                    let pd = self.files.get(event_path);
                    if let Some(old_md) = &pd.metadata {
                        if is_tailable {
                            // We resume tracking from the start of the file,
                            // assuming it has been truncated to 0. This mimics GNU's `tail`
                            // behavior and is the usual truncation operation for log files.
                            if !old_md.is_tailable() {
                                let _ = writeln!(
                                    pi_uutils_ctx::stderr(),
                                    "tail: {} has become accessible",
                                    display_name.quote()
                                );
                                self.files.update_reader(event_path)?;
                            } else if pd.reader.is_none() {
                                let _ = writeln!(
                                    pi_uutils_ctx::stderr(),
                                    "tail: {} has appeared;  following new file",
                                    display_name.quote()
                                );
                                self.files.update_reader(event_path)?;
                            } else if event.kind == EventKind::Modify(ModifyKind::Name(RenameMode::To))
                            || (self.use_polling && !old_md.file_id_eq(&new_md)) {
                                let _ = writeln!(
                                    pi_uutils_ctx::stderr(),
                                    "tail: {} has been replaced;  following new file",
                                    display_name.quote()
                                );
                                self.files.update_reader(event_path)?;
                            } else if old_md.got_truncated(&new_md)? {
                                let _ = writeln!(
                                    pi_uutils_ctx::stderr(),
                                    "tail: {}: file truncated",
                                    display_name
                                );
                                self.files.update_reader(event_path)?;
                            }
                            paths.push(event_path.clone());
                        } else if !is_tailable && old_md.is_tailable() {
                            if pd.reader.is_some() {
                                self.files.reset_reader(event_path);
                            } else {
                                let _ = writeln!(
                                    pi_uutils_ctx::stderr(),
                                    "tail: {} has been replaced with an untailable file",
                                    display_name.quote()
                                );
                            }
                        }
                    } else if is_tailable {
                        let _ = writeln!(
                            pi_uutils_ctx::stderr(),
                            "tail: {} has appeared;  following new file",
                            display_name.quote()
                        );
                        self.files.update_reader(event_path)?;
                        paths.push(event_path.clone());
                    } else if settings.retry {
                        if self.follow_descriptor() {
                            let _ = writeln!(
                                pi_uutils_ctx::stderr(),
                                "tail: {} has been replaced with an untailable file; giving up on this name",
                                display_name.quote()
                            );
                            let _ = self.watcher_rx.as_mut().unwrap().watcher.unwatch(event_path);
                            self.files.remove(event_path);
                            if self.files.no_files_remaining(settings) {
                                return Err(USimpleError::new(1, "no files remaining".to_string()));
                            }
                        } else {
                            let _ = writeln!(
                                pi_uutils_ctx::stderr(),
                                "tail: {} has been replaced with an untailable file",
                                display_name.quote()
                            );
                        }
                    }
                    self.files.update_metadata(event_path, Some(new_md));
                } else if event_path.is_symlink() && settings.retry {
                    self.files.reset_reader(event_path);
                    self.orphans.push(event_path.clone());
                }
            }
            EventKind::Remove(RemoveKind::File | RemoveKind::Any)

                // | EventKind::Modify(ModifyKind::Name(RenameMode::Any))
                | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                if self.follow_name() {
                    if settings.retry {
                        if let Some(old_md) = self.files.get_mut_metadata(event_path)
                            && old_md.is_tailable() && self.files.get(event_path).reader.is_some() {
                                let _ = writeln!(
                                    pi_uutils_ctx::stderr(),
                                    "tail: {} has become inaccessible: No such file or directory",
                                    display_name.quote()
                                );
                            }
                        if event_path.is_orphan() && !self.orphans.contains(event_path) {
                            let _ = writeln!(
                                pi_uutils_ctx::stderr(),
                                "tail: directory containing watched file was removed"
                            );
                            let _ = writeln!(
                                pi_uutils_ctx::stderr(),
                                "tail: {} cannot be used, reverting to polling",
                                text::BACKEND
                            );
                            self.orphans.push(event_path.clone());
                            let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
                        }
                    } else {
                        let _ = writeln!(
                            pi_uutils_ctx::stderr(),
                            "tail: {}: No such file or directory",
                            display_name
                        );
                        if !self.files.files_remaining() && self.use_polling {
                            // NOTE: GNU's tail exits here for `---disable-inotify`
                            return Err(USimpleError::new(1, "no files remaining".to_string()));
                        }
                    }
                    self.files.reset_reader(event_path);
                } else if self.follow_descriptor_retry() {
                    // --retry only effective for the initial open
                    let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
                    self.files.remove(event_path);
                } else if self.use_polling && event.kind == EventKind::Remove(RemoveKind::Any) {
                    /*
                    BUG: The watched file was removed. Since we're using Polling, this
                    could be a rename. We can't tell because `notify::PollWatcher` doesn't
                    recognize renames properly.
                    Ideally we want to call seek to offset 0 on the file handle.
                    But because we only have access to `PathData::reader` as `BufRead`,
                    we cannot seek to 0 with `BufReader::seek_relative`.
                    Also because we don't have the new name, we cannot work around this
                    by simply reopening the file.
                    */
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::Both))
                /*
                NOTE: For `tail -f a`, keep tracking additions to b after `mv a b`
                (gnu/tests/tail-2/descriptor-vs-rename.sh)
                NOTE: The File/BufReader doesn't need to be updated.
                However, we need to update our `files.map`.
                This can only be done for inotify, because this EventKind does not
                trigger for the PollWatcher.
                BUG: As a result, there's a bug if polling is used:
                $ tail -f file_a ---disable-inotify
                $ mv file_a file_b
                $ echo A >> file_b
                $ echo A >> file_a
                The last append to file_a is printed, however this shouldn't be because
                after the "mv" tail should only follow "file_b".
                TODO: [2022-05; jhscheer] add test for this bug
                */

                if self.follow_descriptor() => {
                    let new_path = event.paths.last().unwrap();
                    paths.push(new_path.clone());

                    let new_data = PathData::from_other_with_path(self.files.remove(event_path), new_path);
                    self.files.insert(
                        new_path,
                        new_data,
                        self.files.get_last().unwrap() == event_path
                    );

                    // Unwatch old path and watch new path
                    let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
                    self.watcher_rx.as_mut().unwrap().watch_with_parent(new_path)?;
                }
            _ => {}
        }
		Ok(paths)
	}
}

#[allow(clippy::cognitive_complexity)]
pub fn follow(mut observer: Observer, settings: &Settings) -> UResult<()> {
	if observer.files.no_files_remaining(settings) && !observer.files.only_stdin_remaining() {
		return Err(USimpleError::new(1, "no files remaining".to_string()));
	}

	let process = platform::ProcessChecker::new(observer.pid);

	let mut timeout_counter = 0;

	// main follow loop
	loop {
		let mut _read_some = false;

		// If `--pid=p`, tail checks whether process p
		// is alive at least every `--sleep-interval=N` seconds
		if settings.follow.is_some() && observer.pid != 0 && process.is_dead() {
			// p is dead, tail will also terminate
			break;
		}

		// For `-F` we need to poll if an orphan path becomes available during runtime.
		// If a path becomes an orphan during runtime, it will be added to orphans.
		// To be able to differentiate between the cases of test_retry8 and test_retry9,
		// here paths will not be removed from orphans if the path becomes available.
		if observer.follow_name_retry() {
			for new_path in &observer.orphans {
				if new_path.exists() {
					let pd = observer.files.get(new_path);
					let md = new_path.metadata().unwrap();
					if md.is_tailable() && pd.reader.is_none() {
						let _ = writeln!(
							pi_uutils_ctx::stderr(),
							"tail: {} has appeared;  following new file",
							pd.display_name.quote()
						);
						observer.files.update_metadata(new_path, Some(md));
						observer.files.update_reader(new_path)?;
						_read_some = observer.files.tail_file(new_path, settings.verbose)?;
						observer
							.watcher_rx
							.as_mut()
							.unwrap()
							.watch_with_parent(new_path)?;
					}
				}
			}
		}

		// With  -f, sleep for approximately N seconds (default 1.0) between iterations;
		// We wake up if Notify sends an Event or if we wait more than `sleep_sec`.
		let rx_result = observer
			.watcher_rx
			.as_mut()
			.unwrap()
			.receiver
			.recv_timeout(settings.sleep_sec);

		if rx_result.is_ok() {
			timeout_counter = 0;
		}

		let mut paths = vec![]; // Paths worth checking for new content to print

		// Helper closure to process a single event
		let process_event = |observer: &mut Observer,
		                     event: notify::Event,
		                     settings: &Settings,
		                     paths: &mut Vec<PathBuf>|
		 -> UResult<()> {
			if let Some(event_path) = event.paths.first()
				&& observer.files.contains_key(event_path)
			{
				// Handle Event if it is about a path that we are monitoring
				let new_paths = observer.handle_event(&event, settings)?;
				for p in new_paths {
					if !paths.contains(&p) {
						paths.push(p);
					}
				}
			}
			Ok(())
		};

		match rx_result {
			Ok(Ok(event)) => {
				process_event(&mut observer, event, settings, &mut paths)?;

				// Drain any additional pending events to batch them together.
				// This prevents redundant headers when multiple inotify events
				// are queued (e.g., after resuming from SIGSTOP).
				// Multiple iterations with spin_loop hints give the notify
				// background thread chances to deliver pending events.
				for _ in 0..100 {
					while let Ok(Ok(event)) = observer.watcher_rx.as_mut().unwrap().receiver.try_recv() {
						process_event(&mut observer, event, settings, &mut paths)?;
					}
					// Use both yield and spin hint for broader CPU support
					std::thread::yield_now();
					std::hint::spin_loop();
				}
			},
			Ok(Err(notify::Error { kind: notify::ErrorKind::Io(ref e), paths }))
				if e.kind() == std::io::ErrorKind::NotFound =>
			{
				if let Some(event_path) = paths.first()
					&& observer.files.contains_key(event_path)
				{
					let _ = observer
						.watcher_rx
						.as_mut()
						.unwrap()
						.watcher
						.unwatch(event_path);
				}
			},
			Ok(Err(notify::Error { kind: notify::ErrorKind::MaxFilesWatch, .. })) => {
				return Err(USimpleError::new(1, format!("{} resources exhausted", text::BACKEND)));
			},
			Ok(Err(e)) => {
				return Err(USimpleError::new(1, format!("NotifyError: {}", e)));
			},
			Err(mpsc::RecvTimeoutError::Timeout) => {
				timeout_counter += 1;
				// Check if stdout pipe is still open
				#[cfg(target_os = "linux")]
				if let Ok(false) = ensure_stdout_not_broken() {
					return Ok(());
				}
			},
			Err(e) => {
				return Err(USimpleError::new(1, format!("RecvTimeoutError: {}", e)));
			},
		}

		if observer.use_polling && settings.follow.is_some() {
			// Consider all files to potentially have new content.
			// This is a workaround because `Notify::PollWatcher`
			// does not recognize the "renaming" of files.
			paths = observer.files.keys().cloned().collect::<Vec<_>>();
		}

		// main print loop
		for path in &paths {
			_read_some = observer.files.tail_file(path, settings.verbose)?;
		}

		if timeout_counter == settings.max_unchanged_stats {
			/*
			TODO: [2021-10; jhscheer] implement timeout_counter for each file.
			'--max-unchanged-stats=n'
			When tailing a file by name, if there have been n (default n=5) consecutive iterations
			for which the file has not changed, then open/fstat the file to determine if that file
			name is still associated with the same device/inode-number pair as before. When
			following a log file that is rotated, this is approximately the number of seconds
			between when tail prints the last pre-rotation lines and when it prints the lines that
			have accumulated in the new log file. This option is meaningful only when polling
			(i.e., without inotify) and when following by name.
			*/
		}
	}

	Ok(())
}
