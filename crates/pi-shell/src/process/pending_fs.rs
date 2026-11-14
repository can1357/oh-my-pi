//! `PI_SHELL_FS=pending`: every filesystem operation answers `Pending` at
//! least once before completing, so a conformance harness can check that the
//! engine never blocks on (or depends on the timing of) an fs answer.

use std::{
	io,
	task::{Context, Poll},
};

use bstr::{BStr, BString};

use crate::bash::{
	File, Fs, FsPending, FsPoll, OpenFlags, Stat,
	fs::{Access, DirIter, PwEntry, PwQuery, TempNode, TempPurpose},
};

/// An answer that is `Pending` on its first poll (waking at once), then
/// whatever the wrapped answer is.
struct Deferred<T> {
	inner:  Inner<T>,
	waited: bool,
}

enum Inner<T> {
	Ready(Option<io::Result<T>>),
	Pending(Box<dyn FsPending<T>>),
}

impl<T: Send> FsPending<T> for Deferred<T> {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
		if !self.waited {
			self.waited = true;
			cx.waker().wake_by_ref();
			return Poll::Pending;
		}
		match &mut self.inner {
			Inner::Ready(res) => Poll::Ready(
				res.take()
					.unwrap_or_else(|| Err(io::ErrorKind::Other.into())),
			),
			Inner::Pending(p) => p.poll(cx),
		}
	}
}

fn defer<T: Send + 'static>(poll: FsPoll<T>) -> FsPoll<T> {
	let inner = match poll {
		FsPoll::Ready(res) => Inner::Ready(Some(res)),
		FsPoll::Pending(p) => Inner::Pending(p),
	};
	FsPoll::Pending(Box::new(Deferred { inner, waited: false }))
}

/// A filesystem whose every operation is deferred once.
pub struct PendingFs<F>(pub F);

impl<F: Fs> Fs for PendingFs<F> {
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		defer(self.0.open(path, flags, mode))
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
		defer(self.0.stat(path, follow))
	}

	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()> {
		defer(self.0.access(path, mode))
	}

	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>> {
		defer(self.0.read_dir(path))
	}

	fn readlink(&mut self, path: &BStr) -> FsPoll<BString> {
		defer(self.0.readlink(path))
	}

	fn realpath(&mut self, path: &BStr) -> FsPoll<BString> {
		defer(self.0.realpath(path))
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		defer(self.0.mkfifo_or_temp(purpose))
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		defer(self.0.chdir_check(path))
	}

	fn unlink(&mut self, path: &BStr) -> FsPoll<()> {
		defer(self.0.unlink(path))
	}

	fn rename(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		defer(self.0.rename(from, to))
	}

	fn symlink(&mut self, target: &BStr, path: &BStr) -> FsPoll<()> {
		defer(self.0.symlink(target, path))
	}

	fn link(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		defer(self.0.link(from, to))
	}

	fn lock(&mut self, path: &BStr) -> FsPoll<Box<dyn File>> {
		defer(self.0.lock(path))
	}

	fn lock_fd(&mut self, file: crate::bash::OsHandle, lock: crate::bash::fs::FdLock) -> FsPoll<()> {
		defer(self.0.lock_fd(file, lock))
	}

	fn mkdir(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		defer(self.0.mkdir(path, mode))
	}

	fn rmdir(&mut self, path: &BStr) -> FsPoll<()> {
		defer(self.0.rmdir(path))
	}

	fn chmod(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		defer(self.0.chmod(path, mode))
	}

	fn chown(
		&mut self,
		path: &BStr,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> FsPoll<()> {
		defer(self.0.chown(path, uid, gid, follow))
	}

	fn sync(&mut self) -> FsPoll<()> {
		defer(self.0.sync())
	}

	fn getxattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<BString> {
		defer(self.0.getxattr(path, name, follow))
	}

	fn setxattr(&mut self, path: &BStr, name: &BStr, value: &[u8], follow: bool) -> FsPoll<()> {
		defer(self.0.setxattr(path, name, value, follow))
	}

	fn removexattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<()> {
		defer(self.0.removexattr(path, name, follow))
	}

	fn listxattr(&mut self, path: &BStr, follow: bool) -> FsPoll<Vec<BString>> {
		defer(self.0.listxattr(path, follow))
	}

	fn user_db(&mut self, query: &PwQuery) -> FsPoll<Vec<PwEntry>> {
		defer(self.0.user_db(query))
	}
}
