// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
//! Traits and implementations for iterating over lines in a file-like object.
//!
//! This module provides a [`WordCountable`] trait and implementations
//! for some common file-like objects. Use the [`WordCountable::buffered`]
//! method to get an iterator over lines of a file-like object.
use std::{
	fs::File,
	io::{BufRead, BufReader, Read},
};

#[cfg(unix)]
pub trait WordCountable: Read {
	type Buffered: BufRead;
	fn buffered(self) -> Self::Buffered;
	fn inner_file(&mut self) -> Option<&mut File>;
}

#[cfg(all(not(unix), not(target_os = "wasi")))]
pub trait WordCountable: Read {
	type Buffered: BufRead;
	fn buffered(self) -> Self::Buffered;
	fn inner_file(&mut self) -> Option<&mut File>;
}

#[cfg(target_os = "wasi")]
pub trait WordCountable: Read {
	type Buffered: BufRead;
	fn buffered(self) -> Self::Buffered;
}

// pi-uutils: stdin is the context's plain streaming reader (no fd), so it is
// wrapped in a BufReader to satisfy the BufRead requirement and reports no
// inner file (forcing the streaming byte-count path in count_fast).
#[cfg(not(target_os = "wasi"))]
impl WordCountable for pi_uutils_ctx::CtxStdin {
	type Buffered = BufReader<Self>;

	fn buffered(self) -> Self::Buffered {
		BufReader::new(self)
	}

	fn inner_file(&mut self) -> Option<&mut File> {
		None
	}
}

#[cfg(target_os = "wasi")]
impl WordCountable for pi_uutils_ctx::CtxStdin {
	type Buffered = BufReader<Self>;

	fn buffered(self) -> Self::Buffered {
		BufReader::new(self)
	}
}

#[cfg(not(target_os = "wasi"))]
impl WordCountable for File {
	type Buffered = BufReader<Self>;

	fn buffered(self) -> Self::Buffered {
		BufReader::new(self)
	}

	fn inner_file(&mut self) -> Option<&mut File> {
		Some(self)
	}
}

#[cfg(target_os = "wasi")]
impl WordCountable for File {
	type Buffered = BufReader<Self>;

	fn buffered(self) -> Self::Buffered {
		BufReader::new(self)
	}
}
