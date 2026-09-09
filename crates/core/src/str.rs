//! Small string optimization with stack allocation for short strings.
//!
//! `Str` stores strings up to 23 bytes inline, avoiding heap allocation for
//! typical short strings. Longer strings use reference-counted heap storage
//! with O(1) cloning.

use std::{
	borrow::{Borrow, BorrowMut, Cow},
	boxed::Box,
	cmp::Ordering,
	convert::Infallible,
	ffi,
	fmt::{self, Display},
	hash::{self, Hash, Hasher},
	intrinsics, iter,
	iter::FromIterator,
	mem::{self, ManuallyDrop},
	ops,
	ops::{Add, Deref, DerefMut, Index},
	path::Path,
	ptr, slice, str,
	string::String,
	sync::Arc,
};

use bytes::{Buf, Bytes, BytesMut};
use bytes_utils::{Str as BytesStr, StrMut as BytesStrMut, string::StorageMut};
use serde::de;

/// A `Str` is a string type that has the following properties:
///
/// * `size_of::<Str>() == 24`
/// * `Clone` is `O(1)`
/// * Strings are stack-allocated if they are:
///     * Up to 23 bytes long
/// * Additionally, a `Str` can be explicitly created from a `&'static str`
///   without allocation
///
/// Unlike `String`, however, `Str` is immutable. The primary use case for
#[derive(Default, Clone)]
#[repr(transparent)]
pub struct Str(Repr);

/// An error type for UTF-8 validation.
pub type Utf8Error = bytes_utils::string::Utf8Error<Bytes>;

/// An error type for UTF-8 validation.
pub type Utf8ErrorMut = bytes_utils::string::Utf8Error<BytesMut>;

impl Str {
	/// Constructs a `Str` from a `Bytes` object without checking for UTF-8
	/// validity.
	///
	/// # Safety
	///
	/// The caller must ensure that the bytes are valid UTF-8. If this condition
	/// is not met, the behavior is undefined.
	#[inline]
	pub unsafe fn from_utf8_unchecked_owned(u: impl Into<Bytes>) -> Self {
		// SAFETY: The caller guarantees that the bytes are valid UTF-8.
		Self(Repr::spilled(unsafe { BytesStr::from_inner_unchecked(u.into()) }))
	}

	/// Constructs a `Str` from a byte slice without checking for UTF-8
	/// validity.
	///
	/// # Safety
	///
	/// The caller must ensure that the bytes are valid UTF-8. If this condition
	/// is not met, the behavior is undefined.
	#[inline]
	pub unsafe fn from_utf8_unchecked(u: &[u8]) -> Self {
		// SAFETY: The caller guarantees that the bytes are valid UTF-8.
		Self::new(unsafe { str::from_utf8_unchecked(u) })
	}

	/// Constructs a `Str` from a `Bytes` object, checking for UTF-8
	/// validity.
	///
	/// Returns an error if the bytes are not valid UTF-8.
	#[inline]
	pub fn from_utf8_owned(u: impl Into<Bytes>) -> Result<Self, Utf8Error> {
		Ok(Self(Repr::spilled(BytesStr::from_inner(u.into())?)))
	}

	/// Constructs a `Str` from a byte slice, checking for UTF-8 validity.
	///
	/// Returns an error if the bytes are not valid UTF-8.
	#[inline]
	pub fn from_utf8(u: &[u8]) -> Result<Self, str::Utf8Error> {
		Ok(Self::new(str::from_utf8(u)?))
	}

	/// Constructs a `Str` from bytes, replacing invalid UTF-8 sequences with
	/// `U+FFFD`.
	///
	/// When repairs are needed, the repaired string allocation is transferred
	/// into the result.
	#[inline]
	pub fn from_utf8_lossy(u: &[u8]) -> Self {
		match String::from_utf8_lossy(u) {
			Cow::Borrowed(text) => Self::new(text),
			Cow::Owned(text) => Self::from(text),
		}
	}

	/// Constructs an inline variant of `Str`.
	///
	/// This never allocates.
	///
	/// # Panics
	///
	/// Panics if `text.len() > 23`.
	#[inline]
	pub fn new_inline(text: &str) -> Self {
		Self(Repr::inline(text).expect("len <= INLINE_CAP"))
	}

	/// Constructs an empty `Str`.
	///
	/// This is a `const fn` and never allocates.
	#[inline(always)]
	pub const fn empty() -> Self {
		Self(Repr::empty())
	}

	/// Constructs a `Str` from a statically allocated string.
	///
	/// This never allocates.
	#[inline(always)]
	pub const fn new_static(text: &'static str) -> Self {
		// NOTE: this never uses the inline storage; if a canonical
		// representation is needed, we could check for `len() < INLINE_CAP`
		// and call `new_inline`, but this would mean an extra branch.
		Self(Repr::literal(text))
	}

	/// Constructs a `Str` from a `str`, heap-allocating if necessary.
	#[inline(always)]
	pub fn new(text: impl AsRef<str>) -> Self {
		let text = text.as_ref();
		match Repr::inline(text) {
			Some(repr) => Self(repr),
			None => Self(Repr::spilled(text.into())),
		}
	}

	/// Returns a `&str` slice of this `Str`.
	#[inline(always)]
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}

	/// Returns the length of `self` in bytes.
	#[inline(always)]
	pub fn len(&self) -> usize {
		self.0.len()
	}

	/// Returns `true` if `self` has a length of zero bytes.
	#[inline(always)]
	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	/// Returns `true` if `self` is not stored inline.
	#[inline(always)]
	pub const fn is_spilled(&self) -> bool {
		self.0.tag() > INLINE_CAP as u8
	}

	/// Returns `true` if the string is unique.
	#[inline(always)]
	pub fn is_unique(&self) -> bool {
		match self.0.view() {
			View::Inline(_) => true,
			View::Static(_) => false,
			View::Heap(heap) => {
				Arc::strong_count(&heap.shared) == 1 && heap.shared.inner().is_unique()
			},
			View::Big(shared) => Arc::strong_count(shared) == 1 && shared.inner().is_unique(),
		}
	}

	/// Strips a prefix from the string, returning the remainder as a new
	/// `Str`. Returns `None` if the string doesn't start with the prefix.
	#[inline]
	pub fn strip_prefix(&self, prefix: &str) -> Option<Self> {
		let s = self.as_str();
		s.strip_prefix(prefix).map(|r| self.slice_ref(r))
	}

	/// Strips a suffix from the string, returning the remainder as a new
	/// `Str`. Returns `None` if the string doesn't end with the suffix.
	#[inline]
	pub fn strip_suffix(&self, suffix: &str) -> Option<Self> {
		let s = self.as_str();
		s.strip_suffix(suffix).map(|r| self.slice_ref(r))
	}

	/// Returns a substring as a new `Str`.
	/// For spilled strings, this is a zero-copy operation.
	///
	/// # Panics
	/// Panics if the range is not on valid UTF-8 boundaries.
	#[inline]
	pub fn slice<R>(&self, range: R) -> Self
	where
		str: Index<R, Output = str>,
	{
		if self.is_spilled() {
			self.spilled_subslice(&self.as_str()[range])
		} else {
			Self::new_inline(&self[range])
		}
	}

	/// Extracts owned representation of the slice passed.
	/// For spilled strings, this is a zero-copy operation.
	#[inline]
	pub fn slice_ref(&self, subset: &str) -> Self {
		if self.is_spilled() {
			self.spilled_subslice(subset)
		} else {
			Self::new_inline(subset)
		}
	}

	/// Re-anchors `subset` as an owned view of this spilled string.
	///
	/// # Panics
	/// Panics if `subset` does not lie within `self`'s buffer.
	fn spilled_subslice(&self, subset: &str) -> Self {
		let start = self.as_str().as_ptr() as usize;
		let sub = subset.as_ptr() as usize;
		assert!(
			sub >= start && sub + subset.len() <= start + self.len(),
			"subset is not contained in this Str"
		);
		Self(match self.0.view() {
			View::Heap(heap) => {
				// In bounds of a heap view, so the length fits in u32.
				Repr::heap_view(subset.as_ptr(), Arc::clone(&heap.shared), subset.len() as u32)
			},
			// SAFETY: the containment check above proves `subset` borrows
			// from the underlying `&'static str`.
			View::Static(_) => Repr::literal(unsafe { mem::transmute::<&str, &'static str>(subset) }),
			View::Big(shared) => match u32::try_from(subset.len()) {
				Ok(len) => Repr::heap_view(subset.as_ptr(), Arc::clone(shared), len),
				Err(_) => Repr::spilled(shared.as_ref().slice_ref(subset)),
			},
			View::Inline(_) => unreachable!("spilled_subslice on inline repr"),
		})
	}

	/// Splits the string at the given byte index and returns two `Str`s.
	/// For heap-allocated strings, this creates two zero-copy references.
	///
	/// # Panics
	/// Panics if `at` is not on a UTF-8 character boundary.
	#[inline]
	pub fn split_at(&self, at: usize) -> (Self, Self) {
		let (left, right) = self.as_str().split_at(at);
		if self.is_spilled() {
			(self.spilled_subslice(left), self.spilled_subslice(right))
		} else {
			(Self::new_inline(left), Self::new_inline(right))
		}
	}

	/// Returns a string with leading whitespace removed.
	/// For heap strings, this is zero-copy when possible.
	#[inline]
	pub fn trim_start(&self) -> Self {
		let trimmed = self.as_str().trim_start();
		self.slice_ref(trimmed)
	}

	/// Returns a string with trailing whitespace removed.
	/// For heap strings, this is zero-copy when possible.
	#[inline]
	pub fn trim_end(&self) -> Self {
		let trimmed = self.as_str().trim_end();
		self.slice_ref(trimmed)
	}

	/// Returns a string with leading and trailing whitespace removed.
	/// For heap strings, this is zero-copy when possible.
	#[inline]
	pub fn trim(&self) -> Self {
		let trimmed = self.as_str().trim();
		self.slice_ref(trimmed)
	}

	/// Truncates the `Str` to the specified length, zero-copy.
	///
	/// If `len` is greater than or equal to the current length, this has no
	/// effect.
	///
	/// # Panics
	///
	/// Panics if `len` is not on a valid UTF-8 character boundary.
	#[inline]
	pub fn truncate(&mut self, len: usize) {
		if len >= self.len() {
			return;
		}
		assert!(self.as_str().is_char_boundary(len), "Index is not on a char boundary");
		self.0.truncate(len);
	}

	/// Splits on the given separator and returns an iterator of `Str`s.
	/// For heap strings, the splits are zero-copy references.
	pub fn split<'s>(
		&'s self,
		separator: &'s str,
	) -> impl Clone + iter::FusedIterator<Item = Self> + 's {
		self
			.as_str()
			.split(separator)
			.map(move |s| self.slice_ref(s))
	}

	/// Converts the string to ASCII lowercase.
	///
	/// Reuses the allocation when uniquely owned; otherwise copies.
	pub fn into_ascii_lowercase(self) -> Self {
		let mut buf = StrMut::from(self);
		buf.make_ascii_lowercase();
		buf.freeze()
	}

	/// Converts the string to ASCII uppercase.
	///
	/// Reuses the allocation when uniquely owned; otherwise copies.
	pub fn into_ascii_uppercase(self) -> Self {
		let mut buf = StrMut::from(self);
		buf.make_ascii_uppercase();
		buf.freeze()
	}

	/// Returns a byte slice of this `Str`.
	#[inline(always)]
	pub fn as_bytes(&self) -> &[u8] {
		self.as_str().as_bytes()
	}

	/// Tries to convert this `Str` into a `StrMut`.
	#[inline]
	pub fn try_into_mut(self) -> Result<StrMut, Self> {
		match self.0.unpack() {
			Parts::Inline(inline) => Ok(StrMut::new_inline(inline.as_str())),
			Parts::Static(text) => Err(Self(Repr::literal(text))),
			Parts::Heap { ptr, shared, len } => match Arc::try_unwrap(shared) {
				Ok(full) => {
					let offset = ptr as usize - full.as_ptr() as usize;
					let mut bytes = full.into_inner();
					bytes.truncate(offset + len as usize);
					bytes.advance(offset);
					thaw(bytes)
				},
				Err(shared) => Err(Self(Repr::heap_view(ptr, shared, len))),
			},
			Parts::Big(shared) => match Arc::try_unwrap(shared) {
				Ok(full) => thaw(full.into_inner()),
				Err(shared) => Err(Self(Repr::big(shared))),
			},
		}
	}
}

/// Extension trait for `str` to provide `_str` versions of methods that
/// return an allocated `String`.
pub trait StrExt {
	/// Converts the string to lowercase using ASCII rules and returns a
	/// `Str`.
	///
	/// This is a `_str` version of [`str::to_ascii_lowercase`].
	///
	/// # Examples
	///
	/// ```
	/// use omp_core::str::StrExt;
	///
	/// let s = "HELLO";
	/// let string = s.to_ascii_lowercase_str();
	/// assert_eq!(string, "hello");
	/// ```
	fn to_ascii_lowercase_str(&self) -> Str;

	/// Converts the string to uppercase using ASCII rules and returns a
	/// `Str`.
	///
	/// This is a `_str` version of [`str::to_ascii_uppercase`].
	///
	/// # Examples
	///
	/// ```
	/// use omp_core::str::StrExt;
	///
	/// let s = "hello";
	/// let string = s.to_ascii_uppercase_str();
	/// assert_eq!(string, "HELLO");
	/// ```
	fn to_ascii_uppercase_str(&self) -> Str;
}

impl StrExt for str {
	fn to_ascii_lowercase_str(&self) -> Str {
		let mut s = StrMut::new(self);
		s.make_ascii_lowercase();
		s.freeze()
	}

	fn to_ascii_uppercase_str(&self) -> Str {
		let mut s = StrMut::new(self);
		s.make_ascii_uppercase();
		s.freeze()
	}
}

// ============================
// Comparison
// ============================

impl Eq for Str {}
impl PartialEq<Self> for Str {
	fn eq(&self, other: &Self) -> bool {
		self.0.ptr_eq(&other.0) || self.as_str() == other.as_str()
	}
}

impl PartialEq<str> for Str {
	#[inline(always)]
	fn eq(&self, other: &str) -> bool {
		self.as_str() == other
	}
}

impl PartialEq<Str> for str {
	#[inline(always)]
	fn eq(&self, other: &Str) -> bool {
		other == self
	}
}

impl<'a> PartialEq<&'a str> for Str {
	#[inline(always)]
	fn eq(&self, other: &&'a str) -> bool {
		self == *other
	}
}

impl PartialEq<Str> for &str {
	#[inline(always)]
	fn eq(&self, other: &Str) -> bool {
		*self == other
	}
}

impl PartialEq<String> for Str {
	#[inline(always)]
	fn eq(&self, other: &String) -> bool {
		self.as_str() == other
	}
}

impl PartialEq<Str> for String {
	#[inline(always)]
	fn eq(&self, other: &Str) -> bool {
		other == self
	}
}

impl<'a> PartialEq<&'a String> for Str {
	#[inline(always)]
	fn eq(&self, other: &&'a String) -> bool {
		self == *other
	}
}

impl PartialEq<Str> for &String {
	#[inline(always)]
	fn eq(&self, other: &Str) -> bool {
		*self == other
	}
}

impl Ord for Str {
	fn cmp(&self, other: &Self) -> Ordering {
		self.as_str().cmp(other.as_str())
	}
}

impl PartialOrd for Str {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialOrd<str> for Str {
	#[inline(always)]
	fn partial_cmp(&self, other: &str) -> Option<Ordering> {
		self.as_str().partial_cmp(other)
	}
}

impl PartialOrd<Str> for str {
	#[inline(always)]
	fn partial_cmp(&self, other: &Str) -> Option<Ordering> {
		self.partial_cmp(other.as_str())
	}
}

impl<'a> PartialOrd<&'a str> for Str {
	#[inline(always)]
	fn partial_cmp(&self, other: &&'a str) -> Option<Ordering> {
		self.partial_cmp(*other)
	}
}

impl PartialOrd<Str> for &str {
	#[inline(always)]
	fn partial_cmp(&self, other: &Str) -> Option<Ordering> {
		(*self).partial_cmp(other)
	}
}

impl hash::Hash for Str {
	fn hash<H: hash::Hasher>(&self, hasher: &mut H) {
		self.as_str().hash(hasher);
	}
}

// ============================
// Formatting
// ============================

impl fmt::Debug for Str {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		fmt::Debug::fmt(self.as_str(), f)
	}
}

impl Display for Str {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		Display::fmt(self.as_str(), f)
	}
}

impl fmt::Debug for StrMut {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		fmt::Debug::fmt(self.as_str(), f)
	}
}

impl Display for StrMut {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		Display::fmt(self.as_str(), f)
	}
}

// ============================
// StrMut Comparison
// ============================

impl Eq for StrMut {}
impl PartialEq<Self> for StrMut {
	fn eq(&self, other: &Self) -> bool {
		self.0.ptr_eq(&other.0) || self.as_str() == other.as_str()
	}
}

impl PartialEq<str> for StrMut {
	#[inline(always)]
	fn eq(&self, other: &str) -> bool {
		self.as_str() == other
	}
}

impl PartialEq<StrMut> for str {
	#[inline(always)]
	fn eq(&self, other: &StrMut) -> bool {
		other == self
	}
}

impl<'a> PartialEq<&'a str> for StrMut {
	#[inline(always)]
	fn eq(&self, other: &&'a str) -> bool {
		self == *other
	}
}

impl PartialEq<StrMut> for &str {
	#[inline(always)]
	fn eq(&self, other: &StrMut) -> bool {
		*self == other
	}
}

impl PartialEq<String> for StrMut {
	#[inline(always)]
	fn eq(&self, other: &String) -> bool {
		self.as_str() == other
	}
}

impl PartialEq<StrMut> for String {
	#[inline(always)]
	fn eq(&self, other: &StrMut) -> bool {
		other == self
	}
}

impl<'a> PartialEq<&'a String> for StrMut {
	#[inline(always)]
	fn eq(&self, other: &&'a String) -> bool {
		self == *other
	}
}

impl PartialEq<StrMut> for &String {
	#[inline(always)]
	fn eq(&self, other: &StrMut) -> bool {
		*self == other
	}
}

impl Ord for StrMut {
	fn cmp(&self, other: &Self) -> Ordering {
		self.as_str().cmp(other.as_str())
	}
}

impl PartialOrd for StrMut {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialOrd<str> for StrMut {
	#[inline(always)]
	fn partial_cmp(&self, other: &str) -> Option<Ordering> {
		self.as_str().partial_cmp(other)
	}
}

impl PartialOrd<StrMut> for str {
	#[inline(always)]
	fn partial_cmp(&self, other: &StrMut) -> Option<Ordering> {
		self.partial_cmp(other.as_str())
	}
}

impl<'a> PartialOrd<&'a str> for StrMut {
	#[inline(always)]
	fn partial_cmp(&self, other: &&'a str) -> Option<Ordering> {
		self.partial_cmp(*other)
	}
}

impl PartialOrd<StrMut> for &str {
	#[inline(always)]
	fn partial_cmp(&self, other: &StrMut) -> Option<Ordering> {
		(*self).partial_cmp(other)
	}
}

impl hash::Hash for StrMut {
	fn hash<H: hash::Hasher>(&self, hasher: &mut H) {
		self.as_str().hash(hasher);
	}
}

// ============================
// Borrows
// ============================

impl AsRef<str> for Str {
	#[inline(always)]
	fn as_ref(&self) -> &str {
		self.as_str()
	}
}

impl AsRef<[u8]> for Str {
	#[inline(always)]
	fn as_ref(&self) -> &[u8] {
		self.as_str().as_bytes()
	}
}

impl AsRef<ffi::OsStr> for Str {
	#[inline(always)]
	fn as_ref(&self) -> &ffi::OsStr {
		AsRef::<ffi::OsStr>::as_ref(self.as_str())
	}
}

impl AsRef<Path> for Str {
	#[inline(always)]
	fn as_ref(&self) -> &Path {
		AsRef::<Path>::as_ref(self.as_str())
	}
}

impl Borrow<str> for Str {
	#[inline(always)]
	fn borrow(&self) -> &str {
		self.as_str()
	}
}

impl Deref for Str {
	type Target = str;

	#[inline(always)]
	fn deref(&self) -> &str {
		self.as_str()
	}
}

impl AsRef<str> for StrMut {
	#[inline(always)]
	fn as_ref(&self) -> &str {
		self.as_str()
	}
}

impl AsMut<str> for StrMut {
	#[inline(always)]
	fn as_mut(&mut self) -> &mut str {
		self.as_str_mut()
	}
}

impl AsRef<[u8]> for StrMut {
	#[inline(always)]
	fn as_ref(&self) -> &[u8] {
		self.as_str().as_bytes()
	}
}

impl AsRef<ffi::OsStr> for StrMut {
	#[inline(always)]
	fn as_ref(&self) -> &ffi::OsStr {
		AsRef::<ffi::OsStr>::as_ref(self.as_str())
	}
}

impl AsRef<Path> for StrMut {
	#[inline(always)]
	fn as_ref(&self) -> &Path {
		AsRef::<Path>::as_ref(self.as_str())
	}
}

impl Borrow<str> for StrMut {
	#[inline(always)]
	fn borrow(&self) -> &str {
		self.as_str()
	}
}

impl BorrowMut<str> for StrMut {
	#[inline(always)]
	fn borrow_mut(&mut self) -> &mut str {
		self.as_str_mut()
	}
}

impl Deref for StrMut {
	type Target = str;

	#[inline(always)]
	fn deref(&self) -> &str {
		self.as_str()
	}
}

impl DerefMut for StrMut {
	#[inline(always)]
	fn deref_mut(&mut self) -> &mut str {
		self.as_str_mut()
	}
}

// ============================
// Add implementations
// ============================

impl Add<&str> for Str {
	type Output = Self;

	#[inline]
	fn add(self, rhs: &str) -> Self::Output {
		match self.try_into_mut() {
			Ok(mut lhs) => {
				lhs.push_str(rhs);
				lhs.freeze()
			},
			Err(this) => {
				let mut lhs = StrMut::with_capacity(this.len() + rhs.len());
				lhs.push_str(&this);
				lhs.push_str(rhs);
				lhs.freeze()
			},
		}
	}
}

impl Add<Str> for &str {
	type Output = Str;

	#[inline]
	fn add(self, rhs: Str) -> Self::Output {
		match rhs.try_into_mut() {
			Ok(mut rhs) => {
				rhs.insert(0, self);
				rhs.freeze()
			},
			Err(rhs) => {
				let mut result = StrMut::with_capacity(self.len() + rhs.len());
				result.push_str(self);
				result.push_str(rhs.as_str());
				result.freeze()
			},
		}
	}
}

impl Add<&str> for &Str {
	type Output = Str;

	#[inline]
	fn add(self, rhs: &str) -> Self::Output {
		let mut result = StrMut::with_capacity(self.len() + rhs.len());
		result.push_str(self);
		result.push_str(rhs);
		result.freeze()
	}
}

impl Add<&Str> for &str {
	type Output = Str;

	#[inline]
	fn add(self, rhs: &Str) -> Self::Output {
		let mut result = StrMut::with_capacity(self.len() + rhs.len());
		result.push_str(self);
		result.push_str(rhs.as_str());
		result.freeze()
	}
}

impl Add<&str> for StrMut {
	type Output = Self;

	#[inline]
	fn add(mut self, rhs: &str) -> Self::Output {
		self.push_str(rhs);
		self
	}
}

impl Add<StrMut> for &str {
	type Output = StrMut;

	#[inline]
	fn add(self, mut rhs: StrMut) -> Self::Output {
		// Optimize by inserting at the beginning if we own the rhs
		rhs.insert(0, self);
		rhs
	}
}

impl Add<&str> for &StrMut {
	type Output = StrMut;

	#[inline]
	fn add(self, rhs: &str) -> Self::Output {
		let mut result = StrMut::with_capacity(self.len() + rhs.len());
		result.push_str(self.as_str());
		result.push_str(rhs);
		result
	}
}

impl Add<&StrMut> for &str {
	type Output = StrMut;

	#[inline]
	fn add(self, rhs: &StrMut) -> Self::Output {
		let mut result = StrMut::with_capacity(self.len() + rhs.len());
		result.push_str(self);
		result.push_str(rhs.as_str());
		result
	}
}

// Str + Str combinations
impl Add<Self> for Str {
	type Output = Self;

	#[inline]
	fn add(self, rhs: Self) -> Self::Output {
		match self.try_into_mut() {
			Ok(mut lhs) => {
				lhs.push_str(&rhs);
				lhs.freeze()
			},
			Err(lhs) => match rhs.try_into_mut() {
				Ok(mut rhs) => {
					rhs.insert(0, &lhs);
					rhs.freeze()
				},
				Err(rhs) => {
					let mut result = StrMut::with_capacity(lhs.len() + rhs.len());
					result.push_str(&lhs);
					result.push_str(&rhs);
					result.freeze()
				},
			},
		}
	}
}

impl Add<&Self> for Str {
	type Output = Self;

	#[inline]
	fn add(self, rhs: &Self) -> Self::Output {
		match self.try_into_mut() {
			Ok(mut lhs) => {
				lhs.push_str(rhs);
				lhs.freeze()
			},
			Err(lhs) => {
				let mut result = StrMut::with_capacity(lhs.len() + rhs.len());
				result.push_str(&lhs);
				result.push_str(rhs);
				result.freeze()
			},
		}
	}
}

impl Add<Str> for &Str {
	type Output = Str;

	#[inline]
	fn add(self, rhs: Str) -> Self::Output {
		match rhs.try_into_mut() {
			Ok(mut rhs) => {
				rhs.insert(0, self);
				rhs.freeze()
			},
			Err(rhs) => {
				let mut result = StrMut::with_capacity(self.len() + rhs.len());
				result.push_str(self);
				result.push_str(&rhs);
				result.freeze()
			},
		}
	}
}

impl Add<&Str> for &Str {
	type Output = Str;

	#[inline]
	fn add(self, rhs: &Str) -> Self::Output {
		let mut result = StrMut::with_capacity(self.len() + rhs.len());
		result.push_str(self);
		result.push_str(rhs);
		result.freeze()
	}
}

// StrMut + StrMut combinations
impl Add<Self> for StrMut {
	type Output = Self;

	#[inline]
	fn add(mut self, rhs: Self) -> Self::Output {
		self.push_str(&rhs);
		self
	}
}

impl Add<&Self> for StrMut {
	type Output = Self;

	#[inline]
	fn add(mut self, rhs: &Self) -> Self::Output {
		self.push_str(rhs.as_str());
		self
	}
}

impl Add<StrMut> for &StrMut {
	type Output = StrMut;

	#[inline]
	fn add(self, mut rhs: StrMut) -> Self::Output {
		rhs.insert(0, self.as_str());
		rhs
	}
}

impl Add<&StrMut> for &StrMut {
	type Output = StrMut;

	#[inline]
	fn add(self, rhs: &StrMut) -> Self::Output {
		let mut result = StrMut::with_capacity(self.len() + rhs.len());
		result.push_str(self.as_str());
		result.push_str(rhs.as_str());
		result
	}
}

// ============================
// Repr
// ============================

const INLINE_CAP: usize = 23;

/// Tag byte marking a borrowed `&'static str` view.
const TAG_STATIC: u8 = 0xfd;
/// Tag byte marking a shared heap view of at most `u32::MAX` bytes.
const TAG_HEAP: u8 = 0xfe;
/// Tag byte marking a whole shared buffer longer than `u32::MAX` bytes.
const TAG_BIG: u8 = 0xff;

const HEAP_PAD: usize = INLINE_CAP - size_of::<*const u8>() - size_of::<Arc<BytesStr>>() - 4;
const STATIC_PAD: usize = INLINE_CAP - size_of::<&'static str>();
const BIG_PAD: usize = INLINE_CAP - size_of::<Arc<BytesStr>>();

/// Inline payload: string bytes with the length stored in the tag byte.
#[derive(Clone, Copy)]
#[repr(C)]
struct InlineRepr {
	buf: [u8; INLINE_CAP],
	/// Inline length (`0..=INLINE_CAP`); doubles as the union tag.
	tag: u8,
}

impl InlineRepr {
	#[inline(always)]
	fn as_str(&self) -> &str {
		// SAFETY: `tag <= INLINE_CAP` and the prefix was copied from a `&str`.
		unsafe { str::from_utf8_unchecked(self.buf.get_unchecked(..self.tag as usize)) }
	}
}

/// Shared heap payload: a char-boundary view into an `Arc`-shared buffer.
#[repr(C)]
struct HeapRepr {
	/// First byte of this string's view into `shared`.
	ptr:    *const u8,
	/// Full validated buffer; the view never outlives it.
	shared: Arc<BytesStr>,
	/// View length in bytes.
	len:    u32,
	_pad:   [u8; HEAP_PAD],
	tag:    u8,
}

impl HeapRepr {
	#[inline(always)]
	const fn as_str(&self) -> &str {
		// SAFETY: the view is an in-bounds char-boundary sub-slice of the
		// validated UTF-8 buffer owned by `shared`.
		unsafe { str::from_utf8_unchecked(slice::from_raw_parts(self.ptr, self.len as usize)) }
	}
}

/// Static payload: a borrowed `&'static str`.
#[derive(Clone, Copy)]
#[repr(C)]
struct StaticRepr {
	text: &'static str,
	_pad: [u8; STATIC_PAD],
	tag:  u8,
}

/// Oversized payload: a whole shared buffer longer than `u32::MAX` bytes.
#[repr(C)]
struct BigRepr {
	shared: Arc<BytesStr>,
	_pad:   [u8; BIG_PAD],
	tag:    u8,
}

/// 24-byte backing store of [`Str`].
///
/// A manual tagged union: the byte at offset [`INLINE_CAP`] is the
/// discriminant (`0..=INLINE_CAP` = inline length, or one of the `TAG_*`
/// markers), which every payload struct pins there via explicit padding.
/// The compiler cannot derive this layout itself: an automatic enum rounds
/// each variant up to its 8-byte alignment, colliding with the tag byte.
#[repr(C)]
union Repr {
	inline:  InlineRepr,
	heap:    ManuallyDrop<HeapRepr>,
	literal: StaticRepr,
	big:     ManuallyDrop<BigRepr>,
}

const _: () = {
	assert!(size_of::<Repr>() == INLINE_CAP + 1);
	assert!(mem::offset_of!(InlineRepr, tag) == INLINE_CAP);
	assert!(mem::offset_of!(HeapRepr, tag) == INLINE_CAP);
	assert!(mem::offset_of!(StaticRepr, tag) == INLINE_CAP);
	assert!(mem::offset_of!(BigRepr, tag) == INLINE_CAP);
};

#[allow(
	clippy::non_send_fields_in_send_ty,
	reason = "the raw view pointer borrows immutable bytes owned by the Arc stored beside it"
)]
// SAFETY: heap views borrow immutable bytes owned by the `Arc<BytesStr>`
// stored beside them, static views borrow `'static` data, and all owned
// payloads (`Arc<BytesStr>`) are `Send + Sync`.
unsafe impl Send for Repr {}
// SAFETY: see the `Send` impl; all payloads are immutable.
unsafe impl Sync for Repr {}

/// Borrowed view of a [`Repr`], dispatched on the tag byte.
enum View<'r> {
	Inline(&'r InlineRepr),
	Heap(&'r HeapRepr),
	Static(&'static str),
	Big(&'r Arc<BytesStr>),
}

/// Owned decomposition of a [`Repr`]; see [`Repr::unpack`].
enum Parts {
	Inline(InlineRepr),
	Heap { ptr: *const u8, shared: Arc<BytesStr>, len: u32 },
	Static(&'static str),
	Big(Arc<BytesStr>),
}

impl Repr {
	/// Empty inline repr.
	#[inline(always)]
	const fn empty() -> Self {
		Self { inline: InlineRepr { buf: [0; INLINE_CAP], tag: 0 } }
	}

	/// Discriminant byte; every payload initializes it.
	#[inline(always)]
	const fn tag(&self) -> u8 {
		// SAFETY: every variant writes the byte at offset INLINE_CAP.
		unsafe { self.inline.tag }
	}

	/// Inline copy of `text`, or `None` if it exceeds [`INLINE_CAP`].
	#[inline]
	fn inline(text: &str) -> Option<Self> {
		(text.len() <= INLINE_CAP).then(|| {
			let mut buf = [0; INLINE_CAP];
			buf[..text.len()].copy_from_slice(text.as_bytes());
			Self { inline: InlineRepr { buf, tag: text.len() as u8 } }
		})
	}

	/// Borrows a `&'static str` without allocating.
	#[inline(always)]
	const fn literal(text: &'static str) -> Self {
		Self { literal: StaticRepr { text, _pad: [0; STATIC_PAD], tag: TAG_STATIC } }
	}

	/// Shares an owned validated buffer behind a fresh `Arc`.
	fn spilled(text: BytesStr) -> Self {
		match u32::try_from(text.len()) {
			Ok(len) => {
				let shared = Arc::new(text);
				Self::heap_view(shared.as_ptr(), shared, len)
			},
			Err(_) => Self::big(Arc::new(text)),
		}
	}

	/// Heap view into `shared`; `ptr..ptr + len` must be a char-boundary
	/// sub-slice of it.
	#[inline]
	const fn heap_view(ptr: *const u8, shared: Arc<BytesStr>, len: u32) -> Self {
		Self {
			heap: ManuallyDrop::new(HeapRepr { ptr, shared, len, _pad: [0; HEAP_PAD], tag: TAG_HEAP }),
		}
	}

	/// Wraps a whole shared buffer longer than `u32::MAX` bytes.
	const fn big(shared: Arc<BytesStr>) -> Self {
		Self { big: ManuallyDrop::new(BigRepr { shared, _pad: [0; BIG_PAD], tag: TAG_BIG }) }
	}

	#[inline(always)]
	fn view(&self) -> View<'_> {
		let tag = self.tag();
		// SAFETY: the tag byte identifies the initialized union field.
		unsafe {
			if tag as usize <= INLINE_CAP {
				View::Inline(&self.inline)
			} else if tag == TAG_HEAP {
				View::Heap(&self.heap)
			} else if tag == TAG_STATIC {
				View::Static(self.literal.text)
			} else {
				View::Big(&self.big.shared)
			}
		}
	}

	/// Consumes `self` into owned parts without running its destructor.
	fn unpack(self) -> Parts {
		let this = ManuallyDrop::new(self);
		// SAFETY: the tag identifies the live field, and `this` is never
		// dropped, so each `Arc` is moved out exactly once.
		unsafe {
			match this.tag() {
				TAG_HEAP => {
					let HeapRepr { ptr, shared, len, .. } = ptr::read(&*this.heap);
					Parts::Heap { ptr, shared, len }
				},
				TAG_STATIC => Parts::Static(this.literal.text),
				TAG_BIG => Parts::Big(ptr::read(&*this.big).shared),
				_ => Parts::Inline(this.inline),
			}
		}
	}

	#[inline]
	fn as_str(&self) -> &str {
		match self.view() {
			View::Inline(inline) => inline.as_str(),
			View::Heap(heap) => heap.as_str(),
			View::Static(text) => text,
			View::Big(shared) => shared,
		}
	}

	#[inline(always)]
	fn len(&self) -> usize {
		match self.view() {
			View::Inline(inline) => inline.tag as usize,
			View::Heap(heap) => heap.len as usize,
			View::Static(text) => text.len(),
			View::Big(shared) => shared.len(),
		}
	}

	#[inline(always)]
	fn is_empty(&self) -> bool {
		self.len() == 0
	}

	#[inline]
	fn ptr_eq(&self, other: &Self) -> bool {
		same_str(self.as_str(), other.as_str())
	}

	/// Shrinks to `len` bytes in place, zero-copy.
	///
	/// The caller has checked that `len < self.len()` and that `len` lies on
	/// a char boundary.
	fn truncate(&mut self, len: usize) {
		debug_assert!(len < self.len());
		// SAFETY: the tag identifies the live field; shrinking a view keeps
		// it in bounds and on a char boundary (checked by the caller).
		unsafe {
			match self.tag() {
				TAG_HEAP => self.heap.len = len as u32,
				TAG_STATIC => {
					let text = self.literal.text;
					self.literal.text = &text[..len];
				},
				TAG_BIG => {
					let Parts::Big(shared) = mem::take(self).unpack() else {
						unreachable!();
					};
					*self = match u32::try_from(len) {
						Ok(len32) => Self::heap_view(shared.as_ptr(), shared, len32),
						Err(_) => Self::spilled(shared.as_ref().slice(..len)),
					};
				},
				_ => self.inline.tag = len as u8,
			}
		}
	}
}

impl Clone for Repr {
	#[inline]
	fn clone(&self) -> Self {
		match self.view() {
			View::Heap(heap) => Self::heap_view(heap.ptr, Arc::clone(&heap.shared), heap.len),
			View::Big(shared) => Self::big(Arc::clone(shared)),
			// SAFETY: inline and static payloads are plain copyable bytes.
			_ => unsafe { ptr::read(self) },
		}
	}
}

impl Default for Repr {
	#[inline]
	fn default() -> Self {
		Self::empty()
	}
}

impl Drop for Repr {
	#[inline]
	fn drop(&mut self) {
		// SAFETY: the tag identifies the live field; each `Arc` drops once.
		unsafe {
			match self.tag() {
				TAG_HEAP => ManuallyDrop::drop(&mut self.heap),
				TAG_BIG => ManuallyDrop::drop(&mut self.big),
				_ => {},
			}
		}
	}
}

/// Pointer-identity fast path shared by [`Str`] and [`StrMut`] equality.
///
/// Pointer identity alone is not equality: zero-copy prefix slices share
/// their parent's start pointer with a different length.
#[inline]
fn same_str(this: &str, that: &str) -> bool {
	ptr::eq(this.as_ptr(), that.as_ptr()) && this.len() == that.len()
}

/// Reclaims a uniquely-owned buffer as a mutable string, or repacks it
/// immutable when the bytes are still shared.
fn thaw(bytes: Bytes) -> Result<StrMut, Str> {
	match bytes.try_into_mut() {
		// SAFETY: the bytes were validated as UTF-8 when the `Str` was built.
		Ok(bytes) => Ok(StrMut(MutRepr::Heap(unsafe { BytesStrMut::from_inner_unchecked(bytes) }))),
		// SAFETY: same bytes, still valid UTF-8.
		Err(bytes) => Err(Str(Repr::spilled(unsafe { BytesStr::from_inner_unchecked(bytes) }))),
	}
}

/// Backing store of [`StrMut`]: inline buffer or growable heap string.
enum MutRepr {
	Inline(heapless::String<INLINE_CAP, u8>),
	Heap(BytesStrMut),
}

impl Clone for MutRepr {
	#[inline]
	fn clone(&self) -> Self {
		match self {
			Self::Heap(data) => Self::Heap(data.clone()),
			// SAFETY: the Inline variant contains only plain copyable data
			// (a fixed-size array plus a length).
			_ => unsafe { ptr::read(self) },
		}
	}
}

impl Default for MutRepr {
	#[inline]
	fn default() -> Self {
		Self::new()
	}
}

impl MutRepr {
	#[inline(always)]
	const fn new() -> Self {
		Self::Inline(heapless::String::new())
	}

	/// Inline copy of `text`, or `None` if it exceeds [`INLINE_CAP`].
	#[inline(always)]
	fn new_inline(text: &str) -> Option<Self> {
		heapless::String::try_from(text).ok().map(Self::Inline)
	}

	#[inline(always)]
	fn copy_from_str(text: &str) -> Self {
		match heapless::String::try_from(text) {
			Ok(buf) => Self::Inline(buf),
			Err(_) => Self::Heap(text.into()),
		}
	}

	#[inline(always)]
	fn len(&self) -> usize {
		match self {
			Self::Heap(data) => data.len(),
			Self::Inline(buf) => buf.len(),
		}
	}

	#[inline(always)]
	fn is_empty(&self) -> bool {
		self.len() == 0
	}

	#[inline]
	fn as_str(&self) -> &str {
		match self {
			Self::Heap(data) => data,
			Self::Inline(buf) => buf.as_str(),
		}
	}

	#[inline]
	fn ptr_eq(&self, other: &Self) -> bool {
		same_str(self.as_str(), other.as_str())
	}
}

// ============================
// Extend / Format
// ============================

/// Internal helper for [`sf!`] compile-time vs runtime formatting dispatch.
#[doc(hidden)]
#[inline(always)]
pub const fn sf_fmt(args: fmt::Arguments<'_>) -> Str {
	intrinsics::const_eval_select((args,), sf_fmt_const, sf_fmt_runtime)
}

/// Internal helper for [`sf!`] const-eval formatting.
#[doc(hidden)]
pub const fn sf_fmt_const(args: fmt::Arguments<'_>) -> Str {
	match args.as_str() {
		Some(s) => Str::new_static(s),
		None => panic!("cannot format dynamic arguments in a const context"),
	}
}

/// Internal helper for [`sf!`] runtime formatting.
#[doc(hidden)]
#[inline]
pub fn sf_fmt_runtime(args: fmt::Arguments<'_>) -> Str {
	if let Some(s) = args.as_str() {
		Str::new_static(s)
	} else {
		let mut w = StrMut::default();
		fmt::Write::write_fmt(&mut w, args)
			.expect("a formatting trait implementation returned an error");
		w.freeze()
	}
}

/// Formats arguments to a [`Str`], potentially without allocating.
///
/// See [`std::format!`] or [`format_args!`] for syntax documentation.
#[macro_export]
macro_rules! sf {
	() => {
		$crate::Str::empty()
	};
	($fmt:literal, $($tt:tt)*) => {{
		$crate::str::sf_fmt(::core::format_args!($fmt, $($tt)*))
	}};
	($lit:literal) => {{
		$crate::str::sf_fmt(::core::format_args!($lit))
	}};
	($expr:expr) => {
		$crate::Str::new_static($expr)
	};
}

/// Formats arguments to a [`StrMut`], potentially without allocating.
///
/// See [`std::format!`] or [`format_args!`] for syntax documentation.
#[macro_export]
macro_rules! fmts_mut {
    ($($tt:tt)*) => {{
        let mut w = $crate::str::StrMut::default();
        ::std::fmt::Write::write_fmt(&mut w, format_args!($($tt)*))
         .expect("a formatting trait implementation returned an error");
        w
    }};
}

macro_rules! impl_extend {
    // Case with explicit lifetime
    (for<$lt:lifetime> $type:ty, ($this:ident, $item:ident) => $($body:tt)*) => {
        impl<$lt> Extend<$type> for StrMut {
            fn extend<T: IntoIterator<Item = $type>>(&mut self, iter: T) {
                let $this: &mut StrMut = self;
                for $item in iter {
                    $($body)*
                }
            }
        }
        impl<$lt> FromIterator<$type> for StrMut {
            fn from_iter<T: IntoIterator<Item = $type>>(iter: T) -> Self {
                let mut $this = StrMut::default();
                $this.extend(iter);
                $this
            }
        }
        impl<$lt> FromIterator<$type> for Str {
            fn from_iter<T: IntoIterator<Item = $type>>(iter: T) -> Self {
                let mut $this = StrMut::default();
                $this.extend(iter);
                $this.freeze()
            }
        }
    };
    // Case without lifetimes
    ($type:ty, ($this:ident, $item:ident) => $($body:tt)*) => {
        impl Extend<$type> for StrMut {
            fn extend<T: IntoIterator<Item = $type>>(&mut self, iter: T) {
                let $this: &mut StrMut = self;
                for $item in iter {
                    $($body)*
                }
            }
        }
        impl FromIterator<$type> for StrMut {
            fn from_iter<T: IntoIterator<Item = $type>>(iter: T) -> Self {
                let mut $this = StrMut::default();
                $this.extend(iter);
                $this
            }
        }
        impl FromIterator<$type> for Str {
            fn from_iter<T: IntoIterator<Item = $type>>(iter: T) -> Self {
                let mut $this = StrMut::default();
                $this.extend(iter);
                $this.freeze()
            }
        }
    };
}

impl_extend!(char, (s, rhs) => s.push(rhs));
impl_extend!(String, (s, rhs) => s.push_str(rhs.as_str()));
impl_extend!(for<'a> &'a String, (s, rhs) => s.push_str(rhs.as_str()));
impl_extend!(for<'a> &'a str, (s, rhs) => s.push_str(rhs));

// ============================
// StrMut
// ============================

/// Mutable, growable counterpart of [`Str`]: same inline layout for
/// strings up to 23 bytes, heap-backed above.
///
/// Build with `push`/`push_str` (or
/// [`fmts_mut!`](crate::fmts_mut)), then [`freeze`](Self::freeze)
/// into an immutable [`Str`] without copying.
#[derive(Default, Clone)]
#[repr(transparent)]
pub struct StrMut(MutRepr);

impl StrMut {
	/// Constructs a `StrMut` from a `BytesMut` object without checking for
	/// UTF-8 validity.
	///
	/// # Safety
	///
	/// The caller must ensure that the bytes are valid UTF-8. If this condition
	/// is not met, the behavior is undefined.
	#[inline]
	pub unsafe fn from_utf8_unchecked_owned(u: impl Into<BytesMut>) -> Self {
		// SAFETY: The caller guarantees that the bytes are valid UTF-8.
		Self(MutRepr::Heap(unsafe { BytesStrMut::from_inner_unchecked(u.into()) }))
	}

	/// Constructs a `StrMut` from a byte slice without checking for UTF-8
	/// validity.
	///
	/// # Safety
	///
	/// The caller must ensure that the bytes are valid UTF-8. If this condition
	/// is not met, the behavior is undefined.
	#[inline]
	pub unsafe fn from_utf8_unchecked(u: &[u8]) -> Self {
		// SAFETY: The caller guarantees that the bytes are valid UTF-8.
		Self::new(unsafe { str::from_utf8_unchecked(u) })
	}

	/// Constructs a `StrMut` from a `BytesMut` object, checking for UTF-8
	/// validity.
	///
	/// Returns an error if the bytes are not valid UTF-8.
	#[inline]
	pub fn from_utf8_owned(u: impl Into<BytesMut>) -> Result<Self, Utf8ErrorMut> {
		let u: BytesMut = u.into();
		Ok(Self(MutRepr::Heap(BytesStrMut::from_inner(u)?)))
	}

	/// Constructs a `StrMut` from a byte slice, checking for UTF-8 validity.
	///
	/// Returns an error if the bytes are not valid UTF-8.
	#[inline]
	pub fn from_utf8(u: &[u8]) -> Result<Self, str::Utf8Error> {
		Ok(Self::new(str::from_utf8(u)?))
	}

	/// Constructs an inline variant of `StrMut`.
	///
	/// This never allocates.
	///
	/// # Panics
	///
	/// Panics if `text.len() > 23`.
	#[inline]
	pub fn new_inline(text: &str) -> Self {
		Self(MutRepr::new_inline(text).expect("len <= INLINE_CAP"))
	}

	/// Constructs a `Str` from a `str`, heap-allocating if necessary.
	#[inline(always)]
	pub fn new(text: impl AsRef<str>) -> Self {
		Self(MutRepr::copy_from_str(text.as_ref()))
	}

	/// Constructs a `StrMut` with the given capacity.
	#[inline]
	pub fn with_capacity(capacity: usize) -> Self {
		if capacity > INLINE_CAP {
			// SAFETY: A newly allocated BytesMut with capacity is empty, and an
			// empty byte buffer is trivially valid UTF-8.
			Self(MutRepr::Heap(unsafe {
				BytesStrMut::from_inner_unchecked(BytesMut::with_capacity(capacity))
			}))
		} else {
			Self(MutRepr::new())
		}
	}

	/// Returns a `&str` slice of this `Str`.
	#[inline(always)]
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}

	/// Returns a mutable `&str` slice of this `Str`.
	#[inline(always)]
	pub fn as_str_mut(&mut self) -> &mut str {
		match &mut self.0 {
			// SAFETY: BytesStrMut guarantees that its inner BytesMut contains valid UTF-8.
			MutRepr::Heap(data) => unsafe { str::from_utf8_unchecked_mut(data.as_bytes_mut()) },
			MutRepr::Inline(buf) => buf.as_mut_str(),
		}
	}

	/// Returns the length of `self` in bytes.
	#[inline(always)]
	pub fn len(&self) -> usize {
		self.0.len()
	}

	/// Returns `true` if `self` has a length of zero bytes.
	#[inline(always)]
	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	/// Truncates the `Str` to the specified length.
	///
	/// If `len` is greater than the current length, this has no effect.
	///
	/// # Panics
	///
	/// Panics if `len` is greater than the current length of the `Str` or if
	/// `len` is not on a valid UTF-8 character boundary.
	#[inline]
	pub fn truncate(&mut self, len: usize) {
		match &mut self.0 {
			MutRepr::Inline(buf) => {
				buf.truncate(len);
			},
			MutRepr::Heap(heap) => {
				assert!(heap.is_char_boundary(len), "Index is not on a char boundary");
				// SAFETY: Truncating at a char boundary (verified by the assert above)
				// preserves UTF-8 validity of the underlying byte buffer.
				unsafe {
					heap.inner_mut().truncate(len);
				}
			},
		}
	}

	/// Returns `true` if `self` is heap-allocated.
	#[inline(always)]
	pub const fn is_spilled(&self) -> bool {
		matches!(self.0, MutRepr::Heap(..))
	}

	/// Reserves capacity for at least `additional` more bytes to be inserted in
	/// the given `StrMut`.
	#[inline]
	pub fn reserve(&mut self, additional: usize) {
		match &mut self.0 {
			MutRepr::Inline(buf) => {
				let cap = buf.len() + additional;
				if cap > INLINE_CAP {
					let cap = cap.next_power_of_two();
					// SAFETY: A newly allocated BytesMut with capacity is empty, and an
					// empty byte buffer is trivially valid UTF-8.
					let mut heap =
						unsafe { BytesStrMut::from_inner_unchecked(BytesMut::with_capacity(cap)) };
					heap.push_str(buf.as_str());
					*self = Self(MutRepr::Heap(heap));
				}
			},
			MutRepr::Heap(heap) => {
				// SAFETY: Reserving capacity does not modify the existing UTF-8 bytes,
				// only extends the available capacity.
				unsafe {
					heap.inner_mut().reserve(additional);
				}
			},
		}
	}

	/// Builds a [`Str`] from `self`.
	#[inline]
	pub fn freeze(self) -> Str {
		Str(match self.0 {
			MutRepr::Inline(buf) => Repr::inline(buf.as_str()).expect("len <= INLINE_CAP"),
			MutRepr::Heap(heap) => Repr::spilled(heap.freeze()),
		})
	}

	/// Appends the given [`char`] to the end of `self`'s buffer.
	#[inline]
	pub fn push(&mut self, c: char) {
		let mut buf = [0; 4];
		self.push_str(c.encode_utf8(&mut buf));
	}

	/// Appends a given string slice onto the end of `self`'s buffer.
	#[inline]
	pub fn push_str(&mut self, s: &str) {
		match &mut self.0 {
			MutRepr::Inline(buf) => {
				let len = buf.len();
				if buf.push_str(s).is_err() {
					let mut heap = BytesMut::with_capacity((len + s.len()).next_power_of_two());
					heap.extend_from_slice(buf.as_bytes());
					heap.extend_from_slice(s.as_bytes());
					// SAFETY: We copy valid UTF-8 bytes from buf and s into heap.
					// Both sources are valid UTF-8, so the result is valid UTF-8.
					*self = Self(MutRepr::Heap(unsafe { BytesStrMut::from_inner_unchecked(heap) }));
				}
			},
			MutRepr::Heap(heap) => heap.push_str(s),
		}
	}

	/// Pushes raw bytes onto the end of `self`'s buffer.
	///
	/// # Safety
	///
	/// The caller must ensure that the bytes are valid UTF-8. If this condition
	/// is not met, the behavior is undefined.
	#[inline]
	pub unsafe fn extend_from_bytes_unchecked(&mut self, s: &[u8]) {
		match &mut self.0 {
			MutRepr::Inline(buf) => {
				let len = buf.len();
				// SAFETY: The caller guarantees that s contains valid UTF-8 bytes.
				// We extend the inline buffer's internal vector directly.
				if unsafe { buf.as_mut_vec().extend_from_slice(s).is_err() } {
					let mut heap = BytesMut::with_capacity((len + s.len()).next_power_of_two());
					heap.extend_from_slice(buf.as_bytes());
					heap.extend_from_slice(s);
					// SAFETY: buf contains valid UTF-8 and the caller guarantees s
					// contains valid UTF-8, so heap contains valid UTF-8.
					*self = Self(MutRepr::Heap(unsafe { BytesStrMut::from_inner_unchecked(heap) }));
				}
			},
			// SAFETY: The caller guarantees that s contains valid UTF-8 bytes.
			MutRepr::Heap(heap) => unsafe { heap.inner_mut().push_slice(s) },
		}
	}

	/// Inserts a given string slice at the specified position in `self`'s
	/// buffer.
	///
	/// # Panics
	///
	/// Panics if `index` is greater than the current length of the string or if
	/// it is not on a valid UTF-8 character boundary.
	#[inline]
	pub fn insert(&mut self, index: usize, s: &str) {
		match &mut self.0 {
			MutRepr::Inline(buf) => {
				// First check if index is on a valid char boundary
				assert!(
					buf.is_char_boundary(index),
					"index is not on a valid UTF-8 character boundary"
				);

				if buf.insert_str(index, s).is_err() {
					// Inline buffer doesn't have enough capacity, promote to heap
					let old_len = buf.len();
					let new_len = old_len + s.len();
					let mut heap = BytesMut::with_capacity(new_len.next_power_of_two());

					// Copy the part before the insertion point
					heap.extend_from_slice(&buf.as_bytes()[..index]);
					// Insert the new string
					heap.extend_from_slice(s.as_bytes());
					// Copy the part after the insertion point
					heap.extend_from_slice(&buf.as_bytes()[index..]);

					// SAFETY: We copy valid UTF-8 bytes from buf (before and after index)
					// and valid UTF-8 bytes from s. The result is valid UTF-8 because we
					// insert at a valid char boundary (verified by the assert above).
					*self = Self(MutRepr::Heap(unsafe { BytesStrMut::from_inner_unchecked(heap) }));
				}
			},
			MutRepr::Heap(heap) => {
				assert!(
					heap.is_char_boundary(index),
					"index is not on a valid UTF-8 character boundary"
				);
				// SAFETY: We have mutable access to the StrMut, so we can get
				// mutable access to the inner BytesMut.
				let inner = unsafe { heap.inner_mut() };

				let len = inner.len();
				let string_len = s.len();
				inner.reserve(string_len);

				// SAFETY: Move the bytes starting from `index` to their new location
				// `string_len` bytes ahead. This is safe because we checked there is
				// sufficient capacity, and `index` is a char boundary.
				unsafe {
					let ptr = inner.as_mut_ptr();
					ptr::copy(ptr.add(index), ptr.add(index + string_len), len - index);
				}

				// SAFETY: Copy the new string slice into the vacated region if
				// `index != len`, or into the uninitialized spare capacity otherwise.
				// The source (s) and destination do not overlap because s is an
				// independent string slice.
				unsafe {
					ptr::copy_nonoverlapping(s.as_ptr(), inner.as_mut_ptr().add(index), string_len);
				}

				// SAFETY: We've just initialized `string_len` bytes at position
				// `index`, and moved the existing bytes to make room. The total
				// length is now len + string_len. The resulting bytes are valid
				// UTF-8 because we inserted at a char boundary and s is valid UTF-8.
				unsafe {
					inner.set_len(len + string_len);
				}
			},
		}
	}
}

impl fmt::Write for StrMut {
	#[inline]
	fn write_str(&mut self, s: &str) -> fmt::Result {
		self.push_str(s);
		Ok(())
	}
}

// ============================
// IntoStr
// ============================

/// Convert value to [`Str`]/[`StrMut`] using [`Display`],
/// potentially without allocating.
///
/// Almost identical to [`ToString`], but converts to [`Str`]/[`StrMut`]
/// instead.
pub trait IntoStr: Display {
	/// Convert value to [`Str`].
	fn into_str(self) -> Str
	where
		Self: Sized,
	{
		self.to_str()
	}

	/// Convert value to [`StrMut`].
	fn into_str_mut(self) -> StrMut
	where
		Self: Sized,
	{
		self.into_str().into()
	}

	/// Convert value to [`Str`].
	fn to_str(&self) -> Str {
		sf!("{self}")
	}

	/// Convert value to [`StrMut`].
	fn to_strmut(&self) -> StrMut {
		self.to_str().into()
	}
}

impl IntoStr for &str {
	#[inline]
	fn into_str(self) -> Str {
		Str::new(self)
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		StrMut::new(self)
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str::new(self)
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		StrMut::new(self)
	}
}

impl IntoStr for &mut str {
	#[inline]
	fn into_str(self) -> Str {
		Str::new(self)
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		StrMut::new(self)
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str::new(self)
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		StrMut::new(self)
	}
}

impl IntoStr for Str {
	#[inline]
	fn into_str(self) -> Str {
		self
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		self.into()
	}

	#[inline]
	fn to_str(&self) -> Str {
		self.clone()
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		StrMut::new(self.as_str())
	}
}

impl IntoStr for StrMut {
	#[inline]
	fn into_str(self) -> Str {
		self.freeze()
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		self
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str::new(self.as_str())
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		self.clone()
	}
}

impl IntoStr for CowStr<'_> {
	#[inline]
	fn into_str(self) -> Str {
		match self {
			CowStr::Borrowed(s) => Str::new(s),
			CowStr::Owned(s) => s.freeze(),
		}
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		match self {
			CowStr::Borrowed(s) => StrMut::new(s),
			CowStr::Owned(s) => s,
		}
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str::new(self.as_str())
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		StrMut::new(self.as_str())
	}
}

impl IntoStr for String {
	#[inline]
	fn into_str(self) -> Str {
		Str(Repr::spilled(self.into()))
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		// SAFETY: String guarantees its contents are valid UTF-8. We convert
		// into bytes and then wrap in BytesStrMut, preserving UTF-8 validity.
		StrMut(MutRepr::Heap(unsafe {
			BytesStrMut::from_inner_unchecked(Bytes::from(self.into_bytes()).into())
		}))
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str::new(self.as_str())
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		self.as_str().into()
	}
}

impl IntoStr for BytesStr {
	#[inline]
	fn into_str(self) -> Str {
		Str(Repr::spilled(self))
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		// SAFETY: BytesStr guarantees its contents are valid UTF-8. Converting
		// to BytesMut preserves the UTF-8 bytes.
		StrMut(MutRepr::Heap(unsafe { BytesStrMut::from_inner_unchecked(self.into_inner().into()) }))
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str(Repr::spilled(self.clone()))
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		self.deref().into()
	}
}

impl IntoStr for Cow<'_, str> {
	#[inline]
	fn into_str(self) -> Str {
		match self {
			Cow::Borrowed(s) => Str::new(s),
			Cow::Owned(s) => Str(Repr::spilled(s.into())),
		}
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		match self {
			Cow::Borrowed(s) => StrMut::new(s),
			Cow::Owned(s) => s.into_str_mut(),
		}
	}

	#[inline]
	fn to_str(&self) -> Str {
		match self {
			Cow::Borrowed(s) => Str::new(s),
			Cow::Owned(s) => s.into_str(),
		}
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		match self {
			Cow::Borrowed(s) => StrMut::new(s),
			Cow::Owned(s) => s.into_str_mut(),
		}
	}
}

impl IntoStr for Box<str> {
	#[inline]
	fn into_str(self) -> Str {
		Str(Repr::spilled(self.into()))
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		// SAFETY: Box<str> guarantees its contents are valid UTF-8. Converting
		// to boxed bytes and then to BytesMut preserves the UTF-8 bytes.
		StrMut(MutRepr::Heap(unsafe {
			BytesStrMut::from_inner_unchecked(Bytes::from(self.into_boxed_bytes()).into())
		}))
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str::new(self.as_ref())
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		StrMut::new(self.as_ref())
	}
}

impl IntoStr for Arc<str> {
	#[inline]
	fn into_str(self) -> Str {
		let bytes: Arc<[u8]> = self.into();
		// SAFETY: Arc<str> guarantees its contents are valid UTF-8. Converting
		// to Arc<[u8]> preserves the bytes without modification.
		Str(Repr::spilled(unsafe { BytesStr::from_inner_unchecked(Bytes::from_owner(bytes)) }))
	}

	#[inline]
	fn into_str_mut(self) -> StrMut {
		StrMut::new(self.as_ref())
	}

	#[inline]
	fn to_str(&self) -> Str {
		Str::new(self.as_ref())
	}

	#[inline]
	fn to_strmut(&self) -> StrMut {
		StrMut::new(self.as_ref())
	}
}

impl<T> IntoStr for &T
where
	T: Display + ?Sized,
{
	default fn into_str(self) -> Str {
		sf!("{}", self)
	}

	#[inline]
	default fn into_str_mut(self) -> StrMut {
		fmts_mut!("{}", self)
	}

	#[inline]
	default fn to_str(&self) -> Str {
		sf!("{}", *self)
	}

	#[inline]
	default fn to_strmut(&self) -> StrMut {
		fmts_mut!("{}", *self)
	}
}

// ============================
// From
// ============================

impl str::FromStr for Str {
	type Err = Infallible;

	#[inline]
	fn from_str(s: &str) -> Result<Self, Self::Err> {
		Ok(Self::new(s))
	}
}

impl From<fmt::Arguments<'_>> for Str {
	#[inline]
	fn from(args: fmt::Arguments<'_>) -> Self {
		args.into_str()
	}
}

/* removed From<&str> and From<&mut str> for Str */

impl From<&str> for StrMut {
	#[inline]
	fn from(s: &str) -> Self {
		Self::new(s)
	}
}

impl From<&mut str> for StrMut {
	#[inline]
	fn from(s: &mut str) -> Self {
		Self::new(s)
	}
}

impl From<&str> for Str {
	#[inline]
	fn from(s: &str) -> Self {
		Self::new(s)
	}
}

impl From<&String> for Str {
	#[inline]
	fn from(s: &String) -> Self {
		Self::new(s)
	}
}

impl From<&String> for StrMut {
	#[inline]
	fn from(s: &String) -> Self {
		Self::new(s)
	}
}

impl From<String> for Str {
	#[inline(always)]
	fn from(text: String) -> Self {
		Self(Repr::spilled(text.into()))
	}
}

impl From<String> for StrMut {
	#[inline(always)]
	fn from(text: String) -> Self {
		// SAFETY: String guarantees its contents are valid UTF-8. Converting
		// into bytes preserves those UTF-8 bytes.
		Self(MutRepr::Heap(unsafe {
			BytesStrMut::from_inner_unchecked(Bytes::from(text.into_bytes()).into())
		}))
	}
}

impl From<&BytesStr> for Str {
	#[inline]
	fn from(s: &BytesStr) -> Self {
		Self(Repr::spilled(s.clone()))
	}
}

impl From<&BytesStr> for StrMut {
	#[inline]
	fn from(s: &BytesStr) -> Self {
		Self::new(&**s)
	}
}

impl From<BytesStr> for Str {
	#[inline(always)]
	fn from(text: BytesStr) -> Self {
		Self(Repr::spilled(text))
	}
}

impl From<BytesStr> for StrMut {
	#[inline(always)]
	fn from(text: BytesStr) -> Self {
		// SAFETY: BytesStr guarantees its contents are valid UTF-8. Converting
		// to BytesMut preserves the UTF-8 bytes.
		Self(MutRepr::Heap(unsafe {
			BytesStrMut::from_inner_unchecked(BytesMut::from(text.into_inner()))
		}))
	}
}

impl From<BytesStrMut> for Str {
	#[inline]
	fn from(value: BytesStrMut) -> Self {
		Self(Repr::spilled(value.freeze()))
	}
}

impl From<BytesStrMut> for StrMut {
	#[inline]
	fn from(value: BytesStrMut) -> Self {
		Self(MutRepr::Heap(value))
	}
}

impl<'a> From<Cow<'a, str>> for Str {
	#[inline]
	fn from(cow: Cow<'a, str>) -> Self {
		match cow {
			Cow::Borrowed(s) => Self::new(s),
			Cow::Owned(s) => Self::from(s),
		}
	}
}

impl<'a> From<Cow<'a, str>> for StrMut {
	#[inline]
	fn from(s: Cow<'a, str>) -> Self {
		match s {
			Cow::Borrowed(borrowed) => borrowed.into(),
			Cow::Owned(owned) => owned.into(),
		}
	}
}

impl From<Str> for BytesStr {
	#[inline]
	fn from(text: Str) -> Self {
		match text.0.unpack() {
			Parts::Inline(inline) => inline.as_str().into(),
			Parts::Static(text) => Self::from_static(text),
			Parts::Heap { ptr, shared, len } => {
				// SAFETY: the view is an in-bounds char-boundary sub-slice of
				// the validated buffer.
				let view =
					unsafe { str::from_utf8_unchecked(slice::from_raw_parts(ptr, len as usize)) };
				shared.slice_ref(view)
			},
			Parts::Big(shared) => {
				Arc::try_unwrap(shared).unwrap_or_else(|shared| shared.as_ref().clone())
			},
		}
	}
}

impl From<StrMut> for BytesStr {
	#[inline(always)]
	fn from(text: StrMut) -> Self {
		match text.0 {
			MutRepr::Heap(data) => data.freeze(),
			_ => text.as_str().into(),
		}
	}
}

impl From<Str> for String {
	#[inline(always)]
	fn from(text: Str) -> Self {
		text.as_str().into()
	}
}

impl From<StrMut> for String {
	#[inline(always)]
	fn from(text: StrMut) -> Self {
		text.as_str().into()
	}
}

impl From<Str> for Bytes {
	#[inline(always)]
	fn from(text: Str) -> Self {
		BytesStr::from(text).into_inner()
	}
}

impl From<StrMut> for Bytes {
	#[inline(always)]
	fn from(text: StrMut) -> Self {
		match text.0 {
			MutRepr::Heap(data) => data.into_inner().into(),
			MutRepr::Inline(buf) => Self::copy_from_slice(buf.as_bytes()),
		}
	}
}

impl From<Str> for BytesMut {
	#[inline(always)]
	fn from(value: Str) -> Self {
		Bytes::from(value).into()
	}
}

impl From<StrMut> for BytesMut {
	#[inline(always)]
	fn from(text: StrMut) -> Self {
		match text.0 {
			MutRepr::Heap(data) => data.into_inner(),
			MutRepr::Inline(buf) => Self::from(buf.as_bytes()),
		}
	}
}

impl From<Str> for BytesStrMut {
	#[inline(always)]
	fn from(value: Str) -> Self {
		// SAFETY: Str is guaranteed to contain valid UTF-8, so converting it to
		// BytesMut and then to BytesStrMut preserves UTF-8 validity.
		unsafe { Self::from_inner_unchecked(BytesMut::from(value)) }
	}
}

impl From<StrMut> for BytesStrMut {
	#[inline(always)]
	fn from(value: StrMut) -> Self {
		match value.0 {
			MutRepr::Heap(data) => data,
			// SAFETY: buf contains valid UTF-8 (guaranteed by StrMut invariants).
			// Converting to BytesMut preserves the UTF-8 bytes.
			MutRepr::Inline(buf) => unsafe {
				Self::from_inner_unchecked(BytesMut::from(buf.as_bytes()))
			},
		}
	}
}

impl From<StrMut> for Str {
	#[inline]
	fn from(value: StrMut) -> Self {
		value.freeze()
	}
}

impl From<Str> for StrMut {
	#[inline]
	fn from(value: Str) -> Self {
		match value.try_into_mut() {
			Ok(mutable) => mutable,
			Err(value) => Self::new(value.as_str()),
		}
	}
}

impl From<Arc<str>> for Str {
	#[inline]
	fn from(value: Arc<str>) -> Self {
		let bytes: Arc<[u8]> = value.into();
		// SAFETY: Arc<str> guarantees its contents are valid UTF-8. Converting
		// to Arc<[u8]> preserves the bytes without modification.
		Self(Repr::spilled(unsafe { BytesStr::from_inner_unchecked(Bytes::from_owner(bytes)) }))
	}
}

impl From<Box<str>> for Str {
	#[inline]
	fn from(value: Box<str>) -> Self {
		Self(Repr::spilled(value.into()))
	}
}

impl From<Box<str>> for StrMut {
	#[inline]
	fn from(value: Box<str>) -> Self {
		// SAFETY: Box<str> guarantees its contents are valid UTF-8. Converting
		// to boxed bytes and then to BytesMut preserves the UTF-8 bytes.
		Self(MutRepr::Heap(unsafe {
			BytesStrMut::from_inner_unchecked(Bytes::from(value.into_boxed_bytes()).into())
		}))
	}
}

// ============================
// Serde
// ============================

impl serde::Serialize for Str {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		self.as_str().serialize(serializer)
	}
}

impl<'de> serde::Deserialize<'de> for Str {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		use serde::de::{Error, Unexpected};
		struct StrVisitor;

		impl serde::de::Visitor<'_> for StrVisitor {
			type Value = Str;

			fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
				formatter.write_str("a string")
			}

			fn visit_str<E: Error>(self, v: &str) -> Result<Self::Value, E> {
				Ok(Str::new(v))
			}

			fn visit_string<E: Error>(self, v: String) -> Result<Self::Value, E> {
				Ok(Str::from(v))
			}

			fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Self::Value, E> {
				match str::from_utf8(v) {
					Ok(s) => Ok(Str::new(s)),
					Err(_) => Err(Error::invalid_value(Unexpected::Bytes(v), &self)),
				}
			}

			fn visit_byte_buf<E: Error>(self, v: Vec<u8>) -> Result<Self::Value, E> {
				match String::from_utf8(v) {
					Ok(s) => Ok(Str::from(s)),
					Err(e) => Err(Error::invalid_value(Unexpected::Bytes(&e.into_bytes()), &self)),
				}
			}
		}

		deserializer.deserialize_str(StrVisitor)
	}
}

/// Mirrors `String`'s JSON Schema so derives use `Str` fields directly
/// instead of per-field `#[schemars(with = "String")]` overrides.
#[cfg(feature = "schemars")]
impl schemars::JsonSchema for Str {
	fn inline_schema() -> bool {
		<String as schemars::JsonSchema>::inline_schema()
	}

	fn schema_name() -> std::borrow::Cow<'static, str> {
		<String as schemars::JsonSchema>::schema_name()
	}

	fn schema_id() -> std::borrow::Cow<'static, str> {
		<String as schemars::JsonSchema>::schema_id()
	}

	fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
		<String as schemars::JsonSchema>::json_schema(generator)
	}
}

impl serde::Serialize for CowStr<'_> {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		self.as_str().serialize(serializer)
	}
}

impl<'de: 'a, 'a> serde::Deserialize<'de> for CowStr<'a> {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		use serde::de::{Error, Unexpected};

		struct CowStrVisitor;

		impl<'de> serde::de::Visitor<'de> for CowStrVisitor {
			type Value = CowStr<'de>;

			fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
				formatter.write_str("a string")
			}

			fn visit_str<E: Error>(self, v: &str) -> Result<Self::Value, E> {
				Ok(CowStr::Owned(StrMut::from(v)))
			}

			fn visit_borrowed_str<E: Error>(self, v: &'de str) -> Result<Self::Value, E> {
				Ok(CowStr::Borrowed(v))
			}

			fn visit_string<E: Error>(self, v: String) -> Result<Self::Value, E> {
				Ok(CowStr::Owned(StrMut::from(v)))
			}

			fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Self::Value, E> {
				match str::from_utf8(v) {
					Ok(s) => Ok(CowStr::Owned(StrMut::from(s))),
					Err(_) => Err(Error::invalid_value(Unexpected::Bytes(v), &self)),
				}
			}

			fn visit_borrowed_bytes<E>(self, v: &'de [u8]) -> Result<Self::Value, E>
			where
				E: de::Error,
			{
				match str::from_utf8(v) {
					Ok(s) => Ok(CowStr::Borrowed(s)),
					Err(_) => Err(Error::invalid_value(Unexpected::Bytes(v), &self)),
				}
			}

			fn visit_byte_buf<E: Error>(self, v: Vec<u8>) -> Result<Self::Value, E> {
				match String::from_utf8(v) {
					Ok(s) => Ok(CowStr::Owned(StrMut::from(s))),
					Err(e) => Err(Error::invalid_value(Unexpected::Bytes(&e.into_bytes()), &self)),
				}
			}
		}

		deserializer.deserialize_str(CowStrVisitor)
	}
}

/// A clone-on-write smart pointer for strings with small string optimization.
///
/// The type `CowStr` is a smart pointer providing clone-on-write
/// functionality: it can enclose and provide immutable access to borrowed data,
/// and clone the data lazily when mutation or ownership is required.
///
/// `CowStr` implements `Deref`, which means that you can call non-mutating
/// methods directly on the data it encloses.
#[derive(Clone)]
pub enum CowStr<'a> {
	/// Borrowed data.
	Borrowed(&'a str),
	/// Owned data.
	Owned(StrMut),
}

impl<'a> CowStr<'a> {
	/// Creates a new `CowStr` from a string slice.
	#[inline]
	pub const fn from_str(s: &'a str) -> Self {
		CowStr::Borrowed(s)
	}

	/// Creates a new `CowStr` from an owned `StrMut`.
	#[inline]
	pub const fn from_owned(s: StrMut) -> Self {
		CowStr::Owned(s)
	}

	/// Returns a `&str` slice of this `CowStr`.
	#[inline]
	pub fn as_str(&self) -> &str {
		match self {
			CowStr::Borrowed(s) => s,
			CowStr::Owned(s) => s.as_str(),
		}
	}

	/// Returns the length of the string in bytes.
	#[inline]
	pub fn len(&self) -> usize {
		self.as_str().len()
	}

	/// Returns `true` if the string has a length of zero bytes.
	#[inline]
	pub fn is_empty(&self) -> bool {
		self.as_str().is_empty()
	}

	/// Returns true if the data is borrowed.
	#[inline]
	pub const fn is_borrowed(&self) -> bool {
		matches!(self, CowStr::Borrowed(_))
	}

	/// Returns true if the data is owned.
	#[inline]
	pub const fn is_owned(&self) -> bool {
		matches!(self, CowStr::Owned(_))
	}

	/// Assigns the slice passed to the `CowStr`.
	#[inline]
	pub fn assign_slice_ref(&mut self, subset: &'a str) {
		match self {
			CowStr::Owned(owned) => {
				// SAFETY: We copy valid UTF-8 bytes from `subset` to the beginning of
				// `owned`, then truncate to the copied length. The source is valid UTF-8,
				// so the result is valid UTF-8. The memory regions do not overlap
				// because subset is an independent string slice.
				unsafe {
					ptr::copy(subset.as_ptr(), owned.as_mut_ptr(), subset.len());
					owned.truncate(subset.len());
				}
			},
			CowStr::Borrowed(_) => *self = CowStr::Borrowed(subset),
		}
	}

	/// Assigns self to be equal to the range given within the `CowStr` itself.
	#[inline]
	pub fn assign_range(&mut self, range: impl Into<ops::Range<usize>>) {
		let range = range.into();
		match self {
			CowStr::Owned(owned) => {
				let len = range.end - range.start;
				// SAFETY: We copy a substring of valid UTF-8 bytes within `owned` to the
				// beginning, then truncate. The range is validated by the caller (or will
				// panic on invalid access). Both pointers derive from one mutable borrow,
				// and ptr::copy handles the overlap. The resulting bytes are valid UTF-8
				// because they're a substring of valid UTF-8.
				unsafe {
					if range.start > 0 {
						let base = owned.as_str_mut().as_mut_ptr();
						ptr::copy(base.add(range.start).cast_const(), base, len);
					}
					owned.truncate(len);
				}
			},
			CowStr::Borrowed(s) => {
				*self = CowStr::Borrowed(&s[range]);
			},
		}
	}

	/// Converts the `CowStr` into a `CowStr` that represents the specified
	/// range.
	///
	/// Clones the data if it is not already owned.
	///
	/// # Panics
	///
	/// Panics if the range is out of bounds.
	#[inline]
	pub fn into_range(self, range: impl Into<ops::Range<usize>>) -> Self {
		let range = range.into();
		match self {
			CowStr::Borrowed(s) => CowStr::Borrowed(&s[range]),
			CowStr::Owned(mut owned) => {
				let len = range.end - range.start;
				// SAFETY: We copy a substring of valid UTF-8 bytes within `owned` to the
				// beginning, then truncate. The range is validated by the caller (or will
				// panic on invalid access). Both pointers derive from one mutable borrow,
				// and ptr::copy handles the overlap. The resulting bytes are valid UTF-8
				// because they're a substring of valid UTF-8.
				unsafe {
					if range.start > 0 {
						let base = owned.as_str_mut().as_mut_ptr();
						ptr::copy(base.add(range.start).cast_const(), base, len);
					}
					owned.truncate(len);
				}
				CowStr::Owned(owned)
			},
		}
	}

	/// Converts the `CowStr` into a `CowStr` that represents the specified
	/// slice reference.
	///
	/// Clones the data if it is not already owned.
	///
	/// # Panics
	///
	/// Panics if the slice reference is out of bounds.
	#[inline]
	pub fn into_slice_ref(self, subset: &'a str) -> Self {
		match self {
			CowStr::Borrowed(_) => CowStr::Borrowed(subset),
			CowStr::Owned(mut owned) => {
				// SAFETY: We copy valid UTF-8 bytes from `subset` to the beginning of
				// `owned`, then truncate to the copied length. The source is valid UTF-8,
				// so the result is valid UTF-8. The memory regions do not overlap
				// because subset is an independent string slice.
				unsafe {
					ptr::copy(subset.as_ptr(), owned.as_mut_ptr(), subset.len());
					owned.truncate(subset.len());
				}
				CowStr::Owned(owned)
			},
		}
	}

	/// Converts the `CowStr` into an owned `CowStr`.
	#[inline]
	pub fn into_owned(self) -> CowStr<'static> {
		match self {
			CowStr::Borrowed(s) => CowStr::Owned(s.into()),
			CowStr::Owned(owned) => CowStr::Owned(owned),
		}
	}

	/// Borrows the `CowStr` with a new lifetime.
	#[inline]
	pub fn borrow(&self) -> CowStr<'_> {
		match self {
			CowStr::Borrowed(s) => CowStr::Borrowed(s),
			CowStr::Owned(o) => CowStr::Borrowed(o.as_str()),
		}
	}

	/// Returns a new `CowStr` with the given string appended.
	#[inline]
	pub fn push_str(&mut self, s: &str) {
		self.as_mut().push_str(s);
	}

	/// Returns a new `CowStr` with the given character appended.
	#[inline]
	pub fn push(&mut self, c: char) {
		self.as_mut().push(c);
	}

	/// Truncates the string to the specified length.
	#[inline]
	pub fn truncate(&mut self, len: usize) {
		if self.len() > len {
			match self {
				CowStr::Borrowed(s) => {
					*self = CowStr::Borrowed(s.split_at(len).0);
				},
				CowStr::Owned(s) => {
					s.truncate(len);
				},
			}
		}
	}

	/// Trims the string in place, removing leading and trailing whitespace.
	///
	/// This method does not allocate if the `CowStr` is a borrowed `&str`.
	#[inline]
	pub fn trim(&mut self) {
		match self {
			CowStr::Borrowed(s) => {
				*self = CowStr::Borrowed(s.trim());
			},
			CowStr::Owned(s) => {
				let range = s
					.substr_range(s.trim())
					.expect("substr_range should not fail");
				self.assign_range(range);
			},
		}
	}

	/// Trims the end of the string in place, removing trailing whitespace.
	///
	/// This method does not allocate if the `CowStr` is a borrowed `&str`.
	#[inline]
	pub fn trim_end(&mut self) {
		match self {
			CowStr::Borrowed(s) => {
				*self = CowStr::Borrowed(s.trim_end());
			},
			CowStr::Owned(s) => {
				let range = s
					.substr_range(s.trim_end())
					.expect("substr_range should not fail");
				self.assign_range(range);
			},
		}
	}

	/// Trims the start of the string in place, removing leading whitespace.
	///
	/// This method does not allocate if the `CowStr` is a borrowed `&str`.
	#[inline]
	pub fn trim_start(&mut self) {
		match self {
			CowStr::Borrowed(s) => {
				*self = CowStr::Borrowed(s.trim_start());
			},
			CowStr::Owned(s) => {
				let range = s
					.substr_range(s.trim_start())
					.expect("substr_range should not fail");
				self.assign_range(range);
			},
		}
	}

	/// Makes the string ASCII lowercase.
	#[inline]
	pub fn make_ascii_lowercase(&mut self) {
		// Only convert to owned if we actually need to modify
		if self.as_str().bytes().any(|b| b.is_ascii_uppercase()) {
			self.as_mut().make_ascii_lowercase();
		}
	}

	/// Makes the string ASCII uppercase.
	#[inline]
	pub fn make_ascii_uppercase(&mut self) {
		// Only convert to owned if we actually need to modify
		if self.as_str().bytes().any(|b| b.is_ascii_lowercase()) {
			self.as_mut().make_ascii_uppercase();
		}
	}
}

impl AsMut<StrMut> for CowStr<'_> {
	fn as_mut(&mut self) -> &mut StrMut {
		match self {
			CowStr::Borrowed(s) => {
				*self = CowStr::Owned(StrMut::new(s));
				match self {
					CowStr::Owned(owned) => owned,
					_ => unreachable!(),
				}
			},
			CowStr::Owned(owned) => owned,
		}
	}
}

// ============================
// Conversions
// ============================

impl<'a> From<&'a str> for CowStr<'a> {
	#[inline]
	fn from(s: &'a str) -> Self {
		CowStr::Borrowed(s)
	}
}

impl From<StrMut> for CowStr<'_> {
	#[inline]
	fn from(s: StrMut) -> Self {
		CowStr::Owned(s)
	}
}

impl From<Str> for CowStr<'_> {
	#[inline]
	fn from(s: Str) -> Self {
		CowStr::Owned(StrMut::from(s))
	}
}

impl From<String> for CowStr<'_> {
	#[inline]
	fn from(s: String) -> Self {
		CowStr::Owned(StrMut::from(s))
	}
}

impl<'a> From<Cow<'a, str>> for CowStr<'a> {
	#[inline]
	fn from(cow: Cow<'a, str>) -> Self {
		match cow {
			Cow::Borrowed(s) => CowStr::Borrowed(s),
			Cow::Owned(s) => CowStr::Owned(StrMut::from(s)),
		}
	}
}

impl<'a> From<CowStr<'a>> for Cow<'a, str> {
	#[inline]
	fn from(cow: CowStr<'a>) -> Self {
		match cow {
			CowStr::Borrowed(s) => Cow::Borrowed(s),
			CowStr::Owned(s) => Cow::Owned(s.as_str().to_string()),
		}
	}
}

impl<'a> From<CowStr<'a>> for Str {
	#[inline]
	fn from(cow: CowStr<'a>) -> Self {
		match cow {
			CowStr::Borrowed(s) => Self::new(s),
			CowStr::Owned(s) => Self::from(s),
		}
	}
}

impl<'a> From<CowStr<'a>> for StrMut {
	#[inline]
	fn from(cow: CowStr<'a>) -> Self {
		match cow {
			CowStr::Borrowed(s) => Self::from(s),
			CowStr::Owned(s) => s,
		}
	}
}

// ============================
// Deref and AsRef
// ============================

impl Deref for CowStr<'_> {
	type Target = str;

	#[inline]
	fn deref(&self) -> &str {
		self.as_str()
	}
}

impl AsRef<str> for CowStr<'_> {
	#[inline]
	fn as_ref(&self) -> &str {
		self.as_str()
	}
}

impl AsRef<[u8]> for CowStr<'_> {
	#[inline]
	fn as_ref(&self) -> &[u8] {
		self.as_str().as_bytes()
	}
}

impl Borrow<str> for CowStr<'_> {
	#[inline]
	fn borrow(&self) -> &str {
		self.as_str()
	}
}

// ============================
// Display and Debug
// ============================

impl Display for CowStr<'_> {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		Display::fmt(self.as_str(), f)
	}
}

impl fmt::Debug for CowStr<'_> {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		fmt::Debug::fmt(self.as_str(), f)
	}
}

// ============================
// Equality
// ============================

impl PartialEq for CowStr<'_> {
	#[inline]
	fn eq(&self, other: &Self) -> bool {
		self.as_str() == other.as_str()
	}
}

impl Eq for CowStr<'_> {}

impl PartialEq<str> for CowStr<'_> {
	#[inline]
	fn eq(&self, other: &str) -> bool {
		self.as_str() == other
	}
}

impl PartialEq<CowStr<'_>> for str {
	#[inline]
	fn eq(&self, other: &CowStr<'_>) -> bool {
		self == other.as_str()
	}
}

impl PartialEq<&str> for CowStr<'_> {
	#[inline]
	fn eq(&self, other: &&str) -> bool {
		self.as_str() == *other
	}
}

impl PartialEq<CowStr<'_>> for &str {
	#[inline]
	fn eq(&self, other: &CowStr<'_>) -> bool {
		*self == other.as_str()
	}
}

impl PartialEq<String> for CowStr<'_> {
	#[inline]
	fn eq(&self, other: &String) -> bool {
		self.as_str() == other.as_str()
	}
}

impl PartialEq<CowStr<'_>> for String {
	#[inline]
	fn eq(&self, other: &CowStr<'_>) -> bool {
		self.as_str() == other.as_str()
	}
}

impl PartialEq<Str> for CowStr<'_> {
	#[inline]
	fn eq(&self, other: &Str) -> bool {
		self.as_str() == other.as_str()
	}
}

impl PartialEq<CowStr<'_>> for Str {
	#[inline]
	fn eq(&self, other: &CowStr<'_>) -> bool {
		self.as_str() == other.as_str()
	}
}

impl PartialEq<StrMut> for CowStr<'_> {
	#[inline]
	fn eq(&self, other: &StrMut) -> bool {
		self.as_str() == other.as_str()
	}
}

impl PartialEq<CowStr<'_>> for StrMut {
	#[inline]
	fn eq(&self, other: &CowStr<'_>) -> bool {
		self.as_str() == other.as_str()
	}
}

// ============================
// Ordering
// ============================

impl PartialOrd for CowStr<'_> {
	#[inline]
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for CowStr<'_> {
	#[inline]
	fn cmp(&self, other: &Self) -> Ordering {
		self.as_str().cmp(other.as_str())
	}
}

impl PartialOrd<str> for CowStr<'_> {
	#[inline(always)]
	fn partial_cmp(&self, other: &str) -> Option<Ordering> {
		self.as_str().partial_cmp(other)
	}
}

impl PartialOrd<CowStr<'_>> for str {
	#[inline(always)]
	fn partial_cmp(&self, other: &CowStr<'_>) -> Option<Ordering> {
		self.partial_cmp(other.as_str())
	}
}

impl PartialOrd<&str> for CowStr<'_> {
	#[inline(always)]
	fn partial_cmp(&self, other: &&str) -> Option<Ordering> {
		self.partial_cmp(*other)
	}
}

impl PartialOrd<CowStr<'_>> for &str {
	#[inline(always)]
	fn partial_cmp(&self, other: &CowStr<'_>) -> Option<Ordering> {
		(*self).partial_cmp(other)
	}
}

// ============================
// Hash
// ============================

impl Hash for CowStr<'_> {
	#[inline]
	fn hash<H: Hasher>(&self, state: &mut H) {
		self.as_str().hash(state);
	}
}

// ============================
// Default
// ============================

impl Default for CowStr<'_> {
	#[inline]
	fn default() -> Self {
		CowStr::Owned(StrMut::default())
	}
}

// ============================
// Tests
// ============================

#[cfg(test)]
mod tests {
	use std::{ffi::OsStr, path::Path};

	use serde_json as json;

	use super::*;

	const PREFIX: &str = "prefix__";
	const REMAINDER: &str = "abcdefghijklmnopjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const LONG_TEXT: &str = "prefix__abcdefghijklmnopjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const SPACED: &str = "   prefix__abcdefghijklmnopjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

	fn heap_ptr(s: &Str) -> (*const u8, usize) {
		assert!(s.is_spilled(), "expected spilled representation");
		(s.as_str().as_ptr(), s.len())
	}

	#[test]
	fn test_str_is_24_bytes() {
		assert_eq!(mem::size_of::<Str>(), 24);
	}

	#[test]
	fn test_static_slice_is_zero_copy() {
		const TEXT: &str = "static text that is quite long";
		let s = Str::new_static(TEXT);
		let sliced = s.slice(7..11);
		assert!(sliced.is_spilled());
		assert_eq!(sliced, "text");
		assert_eq!(sliced.as_str().as_ptr(), TEXT.as_bytes()[7..].as_ptr());
	}

	#[test]
	fn test_truncate_heap_is_zero_copy() {
		let mut s = Str::new(LONG_TEXT);
		let (ptr, _) = heap_ptr(&s);
		s.truncate(PREFIX.len());
		assert_eq!(s, PREFIX);
		assert_eq!(heap_ptr(&s), (ptr, PREFIX.len()));
	}

	#[test]
	fn shared_buffer_prefix_slice_is_not_equal_to_parent() {
		let parent = Str::new(LONG_TEXT);
		let prefix = parent.slice(..PREFIX.len());
		// Both share the parent's start pointer; equality must still compare
		// lengths, not just pointer identity.
		assert_eq!(heap_ptr(&prefix).0, heap_ptr(&parent).0);
		assert_ne!(prefix, parent);
		assert_ne!(parent, prefix);
		assert_eq!(prefix, Str::new(PREFIX));
		assert_eq!(parent, parent.slice(..));
	}

	#[test]
	fn strip_prefix_reuses_heap_storage() {
		let value = Str::new(LONG_TEXT);
		assert!(value.is_spilled());

		let (orig_ptr, orig_len) = heap_ptr(&value);
		assert_eq!(orig_len, LONG_TEXT.len());

		let remainder = value.strip_prefix(PREFIX).expect("prefix matches");
		assert_eq!(remainder.as_str(), REMAINDER);

		let (rem_ptr, rem_len) = heap_ptr(&remainder);
		assert_eq!(rem_len, REMAINDER.len());

		// SAFETY: both pointers originate from the same allocation provided by
		// bytes::Bytes, so offset_from is valid.
		unsafe {
			assert_eq!(rem_ptr.offset_from(orig_ptr) as usize, PREFIX.len());
		}
	}

	#[test]
	fn split_at_reuses_heap_storage() {
		let value = Str::new(LONG_TEXT);
		assert!(value.is_spilled());

		let split_at = PREFIX.len();
		let (left, right) = value.split_at(split_at);

		assert_eq!(left.as_str(), &LONG_TEXT[..split_at]);
		assert_eq!(right.as_str(), &LONG_TEXT[split_at..]);

		let (orig_ptr, _) = heap_ptr(&value);
		let (left_ptr, left_len) = heap_ptr(&left);
		let (right_ptr, right_len) = heap_ptr(&right);

		assert_eq!(left_len, split_at);
		assert_eq!(right_len, LONG_TEXT.len() - split_at);

		// SAFETY: All pointers originate from the same allocation provided by
		// bytes::Bytes, so offset_from is valid.
		unsafe {
			assert_eq!(left_ptr.offset_from(orig_ptr) as usize, 0);
			assert_eq!(right_ptr.offset_from(orig_ptr) as usize, split_at);
		}
	}

	#[test]
	fn trim_start_reuses_heap_storage() {
		let value = Str::new(SPACED);
		assert!(value.is_spilled());

		let trimmed = value.trim_start();
		assert_eq!(trimmed.as_str(), LONG_TEXT);

		let (orig_ptr, _) = heap_ptr(&value);
		let (trim_ptr, _) = heap_ptr(&trimmed);

		// SAFETY: Both pointers originate from the same allocation provided by
		// bytes::Bytes, so offset_from is valid.
		unsafe {
			assert_eq!(trim_ptr.offset_from(orig_ptr) as usize, 3);
		}
	}

	#[test]
	fn test_add_operations() {
		// Test Str + &str
		let s1 = Str::new("hello");
		let result = s1 + " world";
		assert_eq!(result.as_str(), "hello world");

		// Test &str + Str
		let s2 = Str::new("world");
		let result = "hello " + s2;
		assert_eq!(result.as_str(), "hello world");

		// Test &Str + &str
		let s3 = Str::new("hello");
		let result = &s3 + " world";
		assert_eq!(result.as_str(), "hello world");

		// Test &str + &Str
		let s4 = Str::new("world");
		let result = "hello " + &s4;
		assert_eq!(result.as_str(), "hello world");

		// Test StrMut + &str
		let m1 = StrMut::new("hello");
		let result = m1 + " world";
		assert_eq!(result.as_str(), "hello world");

		// Test &str + StrMut
		let m2 = StrMut::new("world");
		let result = "hello " + m2;
		assert_eq!(result.as_str(), "hello world");

		// Test &StrMut + &str
		let m3 = StrMut::new("hello");
		let result = &m3 + " world";
		assert_eq!(result.as_str(), "hello world");

		// Test &str + &StrMut
		let m4 = StrMut::new("world");
		let result = "hello " + &m4;
		assert_eq!(result.as_str(), "hello world");

		// Test with heap-allocated strings
		let long = Str::new("this is a very long string that will be heap allocated");
		let result = &long + " and more";
		assert_eq!(
			result.as_str(),
			"this is a very long string that will be heap allocated and more"
		);
	}

	#[test]
	fn test_insert_inline_to_heap_promotion() {
		// Test that insert properly promotes from inline to heap when needed
		let mut s = StrMut::new("hello world");
		assert!(!s.is_spilled()); // Should be inline

		// Insert something that will exceed inline capacity
		s.insert(6, "beautiful and wonderful ");
		assert_eq!(s.as_str(), "hello beautiful and wonderful world");
		assert!(s.is_spilled()); // Should now be on heap

		// Test insert at the beginning
		let mut s = StrMut::new("world");
		s.insert(0, "hello ");
		assert_eq!(s.as_str(), "hello world");

		// Test insert at the end
		let mut s = StrMut::new("hello");
		s.insert(5, " world");
		assert_eq!(s.as_str(), "hello world");

		// Test insert that triggers promotion with more text
		let mut s = StrMut::new("12345678901234567890"); // 20 chars, near limit
		s.insert(10, "ABCDE"); // This will exceed inline capacity
		assert_eq!(s.as_str(), "1234567890ABCDE1234567890");
		assert!(s.is_spilled());
	}

	#[test]
	fn test_cow_basic_operations() {
		// Test borrowed variant
		let s = "hello world";
		let cow = CowStr::from(s);
		assert!(cow.is_borrowed());
		assert!(!cow.is_owned());
		assert_eq!(cow.as_str(), "hello world");
		assert_eq!(cow.len(), 11);
		assert!(!cow.is_empty());

		// Test owned variant
		let mut_str = StrMut::new("hello");
		let cow = CowStr::from(mut_str);
		assert!(!cow.is_borrowed());
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello");
	}

	#[test]
	fn test_cow_to_mut() {
		// Start with borrowed
		let s = "hello";
		let mut cow = CowStr::from(s);
		assert!(cow.is_borrowed());

		// Convert to owned via as_mut
		let mutable = cow.as_mut();
		mutable.push_str(" world");
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello world");

		// Second call to as_mut doesn't clone again
		let mutable2 = cow.as_mut();
		mutable2.push_str("!");
		assert_eq!(cow.as_str(), "hello world!");
	}

	#[test]
	fn test_cow_assign_slice_ref() {
		let original = "hello world";

		// Test with borrowed
		let mut cow = CowStr::from(original);
		cow.assign_slice_ref("goodbye");
		assert!(cow.is_borrowed());
		assert_eq!(cow.as_str(), "goodbye");

		// Test with owned
		let mut cow = CowStr::from(StrMut::new("hello world"));
		cow.assign_slice_ref("bye");
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "bye");
	}

	#[test]
	fn test_cow_assign_range() {
		// Test with borrowed
		let mut cow = CowStr::from("hello world");
		cow.assign_range(0..5);
		assert!(cow.is_borrowed());
		assert_eq!(cow.as_str(), "hello");

		// Test with owned
		let mut cow = CowStr::from(StrMut::new("hello world"));
		cow.assign_range(6..11);
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "world");

		// Test range in middle
		let mut cow = CowStr::from(StrMut::new("hello world"));
		cow.assign_range(3..8);
		assert_eq!(cow.as_str(), "lo wo");
	}

	#[test]
	fn test_cow_into_range() {
		// Test with borrowed
		let cow = CowStr::from("hello world");
		let new_cow = cow.into_range(0..5);
		assert!(new_cow.is_borrowed());
		assert_eq!(new_cow.as_str(), "hello");

		// Test with owned
		let cow = CowStr::from(StrMut::new("hello world"));
		let new_cow = cow.into_range(6..11);
		assert!(new_cow.is_owned());
		assert_eq!(new_cow.as_str(), "world");
	}

	#[test]
	fn test_cow_into_slice_ref() {
		let original = "hello world";

		// Test with borrowed
		let cow = CowStr::from(original);
		let subset = &original[6..11];
		let new_cow = cow.into_slice_ref(subset);
		assert!(new_cow.is_borrowed());
		assert_eq!(new_cow.as_str(), "world");

		// Test with owned
		let cow = CowStr::from(StrMut::new("hello world"));
		let new_cow = cow.into_slice_ref("new");
		assert!(new_cow.is_owned());
		assert_eq!(new_cow.as_str(), "new");
	}

	#[test]
	fn test_cow_mutating_operations() {
		// Test push_str
		let mut cow = CowStr::from("hello");
		cow.push_str(" world");
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello world");

		// Test push
		let mut cow = CowStr::from("hello");
		cow.push('!');
		assert_eq!(cow.as_str(), "hello!");

		// Test truncate with borrowed
		let mut cow = CowStr::from("hello world");
		cow.truncate(5);
		assert!(cow.is_borrowed());
		assert_eq!(cow.as_str(), "hello");

		// Test truncate with owned
		let mut cow = CowStr::from(StrMut::new("hello world"));
		cow.truncate(5);
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello");
	}

	#[test]
	fn test_cow_trim_operations() {
		// Test trim with borrowed
		let mut cow = CowStr::from("  hello world  ");
		cow.trim();
		assert!(cow.is_borrowed());
		assert_eq!(cow.as_str(), "hello world");

		// Test trim with owned
		let mut cow = CowStr::from(StrMut::new("  hello world  "));
		cow.trim();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello world");

		// Test trim_start with borrowed
		let mut cow = CowStr::from("  hello");
		cow.trim_start();
		assert!(cow.is_borrowed());
		assert_eq!(cow.as_str(), "hello");

		// Test trim_start with owned
		let mut cow = CowStr::from(StrMut::new("  hello"));
		cow.trim_start();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello");

		// Test trim_end with borrowed
		let mut cow = CowStr::from("hello  ");
		cow.trim_end();
		assert!(cow.is_borrowed());
		assert_eq!(cow.as_str(), "hello");

		// Test trim_end with owned
		let mut cow = CowStr::from(StrMut::new("hello  "));
		cow.trim_end();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello");
	}

	#[test]
	fn test_cow_ascii_case_conversion() {
		// Test lowercase - should not convert to owned if no changes needed
		let mut cow = CowStr::from("hello");
		cow.make_ascii_lowercase();
		assert!(cow.is_borrowed()); // Still borrowed since no uppercase letters

		let mut cow = CowStr::from("HELLO");
		cow.make_ascii_lowercase();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello");

		// Test uppercase
		let mut cow = CowStr::from("HELLO");
		cow.make_ascii_uppercase();
		assert!(cow.is_borrowed()); // Still borrowed since no lowercase letters

		let mut cow = CowStr::from("hello");
		cow.make_ascii_uppercase();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "HELLO");
	}

	#[test]
	fn test_cow_equality() {
		let cow1 = CowStr::from("hello");
		let cow2 = CowStr::from(StrMut::new("hello"));

		assert_eq!(cow1, cow2);
		assert_eq!(cow1, "hello");
		assert_eq!("hello", cow1);
		assert_eq!(cow1, String::from("hello"));
		assert_eq!(cow1, Str::new("hello"));
		assert_eq!(cow1, StrMut::new("hello"));
	}

	#[test]
	fn test_cow_ordering() {
		let cow1 = CowStr::from("apple");
		let cow2 = CowStr::from("banana");
		let cow3 = CowStr::from(StrMut::new("apple"));

		assert!(cow1 < cow2);
		assert!(cow2 > cow1);
		assert_eq!(cow1.cmp(&cow3), std::cmp::Ordering::Equal);
	}

	#[test]
	fn test_cow_hash() {
		use std::{
			collections::hash_map::DefaultHasher,
			hash::{Hash, Hasher},
		};

		let cow1 = CowStr::from("hello");
		let cow2 = CowStr::from(StrMut::new("hello"));

		let mut hasher1 = DefaultHasher::new();
		cow1.hash(&mut hasher1);
		let hash1 = hasher1.finish();

		let mut hasher2 = DefaultHasher::new();
		cow2.hash(&mut hasher2);
		let hash2 = hasher2.finish();

		assert_eq!(hash1, hash2);
	}

	#[test]
	fn test_cow_into_owned() {
		// From borrowed
		let cow = CowStr::from("hello");
		let owned = cow.into_str_mut();
		assert_eq!(owned.as_str(), "hello");

		// From already owned
		let cow = CowStr::from(StrMut::new("world"));
		let owned = cow.into_str_mut();
		assert_eq!(owned.as_str(), "world");
	}

	#[test]
	fn test_cow_into_str() {
		let cow = CowStr::from("hello");
		let string = cow.into_str();
		assert_eq!(string.as_str(), "hello");
	}

	#[test]
	fn test_cow_cow_conversion() {
		// From Cow to CowStr
		let std_cow = Cow::Borrowed("hello");
		let cow: CowStr = std_cow.into();
		assert!(cow.is_borrowed());

		let std_cow = Cow::<str>::Owned(String::from("world"));
		let cow: CowStr = std_cow.into();
		assert!(cow.is_owned());

		// From CowStr to Cow
		let cow = CowStr::from("hello");
		let std_cow: Cow<str> = cow.into();
		assert!(matches!(std_cow, Cow::Borrowed(_)));
	}

	#[test]
	fn test_cow_from_conversions() {
		// From Str
		let string = Str::new("hello");
		let cow: CowStr = string.into();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "hello");

		// From String
		let string = String::from("world");
		let cow: CowStr = string.into();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "world");

		// Into Str
		let cow = CowStr::from("test");
		let string: Str = cow.into();
		assert_eq!(string.as_str(), "test");

		// Into StrMut
		let cow = CowStr::from("test");
		let string_mut: StrMut = cow.into();
		assert_eq!(string_mut.as_str(), "test");
	}

	#[test]
	fn test_cow_default() {
		let cow: CowStr = Default::default();
		assert!(cow.is_owned());
		assert_eq!(cow.as_str(), "");
		assert!(cow.is_empty());
	}

	#[test]
	fn test_cow_deref_and_borrow() {
		let cow = CowStr::from("hello world");

		// Test Deref
		assert_eq!(&*cow, "hello world");

		// Test AsRef<str>
		let s: &str = cow.as_ref();
		assert_eq!(s, "hello world");

		// Test AsRef<[u8]>
		let bytes: &[u8] = cow.as_ref();
		assert_eq!(bytes, b"hello world");
	}

	#[test]
	fn test_cow_serde() {
		// Test serialization
		let cow = CowStr::from("hello world");
		let json = json::to_string(&cow).unwrap();
		assert_eq!(json, r#""hello world""#);

		// Test deserialization - will succesfully borrow!
		let deserialized: CowStr = json::from_str(&json).unwrap();
		assert!(!deserialized.is_owned());
		assert_eq!(deserialized.as_str(), "hello world");

		// Test with owned variant
		let cow = CowStr::from(StrMut::new("test"));
		let json = json::to_string(&cow).unwrap();
		assert_eq!(json, r#""test""#);
	}

	// ============================
	// Empty and Boundary Tests (from lib/core/tests/string.rs)
	// ============================

	#[test]
	fn test_empty_strings() {
		// Empty Str
		let s = Str::new("");
		assert!(s.is_empty());
		assert_eq!(s.len(), 0);
		assert!(!s.is_spilled());
		assert_eq!(s.as_str(), "");

		// Empty StrMut
		let mut m = StrMut::new("");
		assert!(m.is_empty());
		assert_eq!(m.len(), 0);
		assert!(!m.is_spilled());
		m.push_str("");
		assert!(m.is_empty());

		// Operations on empty
		assert_eq!(s.trim(), "");
		assert_eq!(s.trim_start(), "");
		assert_eq!(s.trim_end(), "");
		assert_eq!(s.strip_prefix("x"), None);
		assert_eq!(s.strip_suffix("x"), None);

		let (l, r) = s.split_at(0);
		assert!(l.is_empty());
		assert!(r.is_empty());

		// Empty split
		let parts: Vec<_> = s.split("x").collect();
		assert_eq!(parts.len(), 1);
		assert_eq!(parts[0], "");
	}

	#[test]
	fn test_exact_inline_capacity() {
		// 23 bytes - maximum inline capacity
		let text = "12345678901234567890123"; // exactly 23 bytes
		assert_eq!(text.len(), 23);

		let s = Str::new(text);
		assert!(!s.is_spilled());
		assert_eq!(s.len(), 23);
		assert_eq!(s.as_str(), text);

		let m = StrMut::new(text);
		assert!(!m.is_spilled());
		assert_eq!(m.len(), 23);
	}

	#[test]
	fn test_boundary_24_bytes() {
		// 24 bytes - first to require heap
		let text = "123456789012345678901234"; // 24 bytes
		assert_eq!(text.len(), 24);

		let s = Str::new(text);
		assert!(s.is_spilled());
		assert_eq!(s.len(), 24);
		assert_eq!(s.as_str(), text);

		let m = StrMut::new(text);
		assert!(m.is_spilled());
		assert_eq!(m.len(), 24);
	}

	#[test]
	fn test_slice_boundaries() {
		let text = "0123456789";
		let s = Str::new(text);

		// Full range
		assert_eq!(s.slice(..), text);
		assert_eq!(s.slice(0..10), text);

		// Empty slices
		assert_eq!(s.slice(0..0), "");
		assert_eq!(s.slice(5..5), "");
		assert_eq!(s.slice(10..10), "");

		// Single char
		assert_eq!(s.slice(0..1), "0");
		assert_eq!(s.slice(9..10), "9");

		// Prefix/suffix
		assert_eq!(s.slice(..5), "01234");
		assert_eq!(s.slice(5..), "56789");
	}

	#[test]
	#[should_panic(expected = "Index is not on a char boundary")]
	fn test_truncate_non_char_boundary_inline() {
		let mut s = Str::new("hello world 世界");
		s.truncate(13); // Middle of '世' (3 bytes)
	}

	#[test]
	#[should_panic(expected = "Index is not on a char boundary")]
	fn test_truncate_non_char_boundary_heap() {
		let mut s = Str::new("hello world hello world 世界");
		s.truncate(26); // Middle of '世'
	}

	// ============================
	// UTF-8 Validation Tests
	// ============================

	#[test]
	fn test_from_utf8_valid() {
		let valid = b"hello world";
		let s = Str::from_utf8(valid).unwrap();
		assert_eq!(s.as_str(), "hello world");

		let valid_utf8 = "hello 世界 🌍".as_bytes();
		let s = Str::from_utf8(valid_utf8).unwrap();
		assert_eq!(s.as_str(), "hello 世界 🌍");
	}

	#[test]
	fn test_from_utf8_invalid() {
		let invalid = &[0xff, 0xfe, 0xfd];
		assert!(Str::from_utf8(invalid).is_err());

		let invalid = &[0xc0, 0x80]; // Overlong encoding
		assert!(Str::from_utf8(invalid).is_err());
	}

	#[test]
	fn test_from_utf8_lossy() {
		let valid = Str::from_utf8_lossy("hello 世界".as_bytes());
		assert_eq!(valid.as_str(), "hello 世界");

		let invalid = Str::from_utf8_lossy(b"hello \xff world");
		assert_eq!(invalid.as_str(), "hello � world");
	}

	#[test]
	fn test_from_utf8_owned_valid() {
		let valid = Bytes::from("hello world");
		let s = Str::from_utf8_owned(valid).unwrap();
		assert_eq!(s.as_str(), "hello world");
		assert!(s.is_spilled());
	}

	#[test]
	fn test_from_utf8_owned_invalid() {
		let invalid = Bytes::from_static(&[0xff, 0xfe, 0xfd]);
		assert!(Str::from_utf8_owned(invalid).is_err());
	}

	#[test]
	fn test_from_utf8_mut_valid() {
		let valid = b"hello";
		let m = StrMut::from_utf8(valid).unwrap();
		assert_eq!(m.as_str(), "hello");
	}

	#[test]
	fn test_from_utf8_mut_invalid() {
		let invalid = &[0xff, 0xfe];
		assert!(StrMut::from_utf8(invalid).is_err());
	}

	#[test]
	fn test_multibyte_char_boundaries() {
		// Emoji (4 bytes) + Chinese (3 bytes each)
		let text = "🌍世界";
		let s = Str::new(text);
		assert_eq!(s.len(), 10); // 4 + 3 + 3

		// Split at valid boundaries
		let (l, r) = s.split_at(4);
		assert_eq!(l.as_str(), "🌍");
		assert_eq!(r.as_str(), "世界");

		// Truncate at valid boundary
		let mut s2 = Str::new(text);
		s2.truncate(4);
		assert_eq!(s2.as_str(), "🌍");
	}

	#[test]
	#[should_panic(expected = "byte index 1 is not a char boundary")]
	fn test_split_at_invalid_boundary() {
		let s = Str::new("世界");
		let _ = s.split_at(1); // Middle of '世' (3 bytes)
	}

	// ============================
	// Error Path Tests
	// ============================

	#[test]
	#[should_panic(expected = "len <= INLINE_CAP")]
	fn test_new_inline_panic() {
		let too_long = "123456789012345678901234"; // 24 bytes
		let _ = Str::new_inline(too_long);
	}

	#[test]
	#[should_panic(expected = "len <= INLINE_CAP")]
	fn test_new_inline_mut_panic() {
		let too_long = "123456789012345678901234";
		let _ = StrMut::new_inline(too_long);
	}

	#[test]
	#[should_panic(expected = "index is not on a valid UTF-8 character boundary")]
	fn test_insert_non_char_boundary_inline() {
		let mut m = StrMut::new("世界");
		m.insert(1, "x"); // Middle of '世'
	}

	#[test]
	#[should_panic(expected = "index is not on a valid UTF-8 character boundary")]
	fn test_insert_non_char_boundary_heap() {
		let mut m = StrMut::new("hello world hello world 世界");
		m.insert(25, "x"); // Middle of '世'
	}

	#[test]
	fn test_try_into_mut_success_inline() {
		let s = Str::new("hello");
		let m = s.try_into_mut().unwrap();
		assert_eq!(m.as_str(), "hello");
		assert!(!m.is_spilled());
	}

	#[test]
	fn test_try_into_mut_success_heap_unique() {
		let s = Str::new("hello world hello world!!");
		let m = s.try_into_mut().unwrap();
		assert_eq!(m.as_str(), "hello world hello world!!");
		assert!(m.is_spilled());
	}

	#[test]
	fn test_try_into_mut_failure_shared() {
		let s = Str::new("hello world hello world!!");
		let s2 = s.clone();

		// Should fail because Bytes is shared
		let result = s.try_into_mut();
		assert!(result.is_err());

		// Original value should be recoverable
		let original = result.unwrap_err();
		assert_eq!(original.as_str(), "hello world hello world!!");
		assert_eq!(s2.as_str(), "hello world hello world!!");
	}

	// ============================
	// Inline→Heap Transition Tests
	// ============================

	#[test]
	fn test_push_str_inline_to_heap() {
		let mut m = StrMut::new("12345678901234567890"); // 20 bytes
		assert!(!m.is_spilled());

		m.push_str("1234"); // Total 24 bytes
		assert!(m.is_spilled());
		assert_eq!(m.as_str(), "123456789012345678901234");
	}

	#[test]
	fn test_push_char_inline_to_heap() {
		let mut m = StrMut::new("1234567890123456789012"); // 22 bytes
		assert!(!m.is_spilled());

		m.push('x');
		assert!(!m.is_spilled()); // 23 bytes, still inline

		m.push('y');
		assert!(m.is_spilled()); // 24 bytes, now heap
		assert_eq!(m.as_str(), "1234567890123456789012xy");
	}

	#[test]
	fn test_push_multibyte_char_promotion() {
		let mut m = StrMut::new("12345678901234567890"); // 20 bytes
		assert!(!m.is_spilled());

		m.push('🌍'); // 4 bytes emoji
		assert!(m.is_spilled()); // 24 bytes total
		assert_eq!(m.as_str(), "12345678901234567890🌍");
	}

	#[test]
	fn test_reserve_triggers_promotion() {
		let mut m = StrMut::new("hello"); // 5 bytes inline
		assert!(!m.is_spilled());

		m.reserve(20); // Reserve 20 more, total capacity 25
		assert!(m.is_spilled());
		assert_eq!(m.as_str(), "hello");

		// Should still have capacity
		m.push_str("12345678901234567890"); // 25 bytes total
		assert_eq!(m.as_str(), "hello12345678901234567890");
	}

	#[test]
	fn test_sequential_operations_promotion() {
		let mut m = StrMut::new("abc");
		assert!(!m.is_spilled());

		for _ in 0..5 {
			m.push_str("1234"); // 4 bytes each
		}
		// Total: 3 + 20 = 23 bytes (still inline)
		assert!(!m.is_spilled());

		m.push('x');
		assert!(m.is_spilled()); // 24 bytes
	}

	// ============================
	// Slicing & Zero-Copy Tests
	// ============================

	#[test]
	fn test_strip_prefix_none() {
		let s = Str::new("hello world");
		assert_eq!(s.strip_prefix("goodbye"), None);
		assert_eq!(s.strip_prefix("hello world!"), None);
	}

	#[test]
	fn test_strip_suffix_none() {
		let s = Str::new("hello world");
		assert_eq!(s.strip_suffix("goodbye"), None);
		assert_eq!(s.strip_suffix("!hello world"), None);
	}

	#[test]
	fn test_slice_ref_inline() {
		let text = "hello world";
		let s = Str::new(text);
		assert!(!s.is_spilled());

		let subset = &text[6..11]; // "world"
		let sliced = s.slice_ref(subset);
		assert_eq!(sliced.as_str(), "world");
		assert!(!sliced.is_spilled()); // Should still be inline
	}

	#[test]
	fn test_trim_end_zero_copy_heap() {
		let text = "hello world hello world hello   ";
		let s = Str::new(text);
		assert!(s.is_spilled());

		let trimmed = s.trim_end();
		assert_eq!(trimmed.as_str(), "hello world hello world hello");
		assert!(trimmed.is_spilled());
	}

	#[test]
	fn test_split_iterator_complete() {
		let s = Str::new("a,b,c,d,e");
		let parts: Vec<_> = s.split(",").collect();
		assert_eq!(parts.len(), 5);
		assert_eq!(parts[0], "a");
		assert_eq!(parts[1], "b");
		assert_eq!(parts[4], "e");

		// Multiple separators
		let s2 = Str::new("a,,b");
		let parts2: Vec<_> = s2.split(",").collect();
		assert_eq!(parts2.len(), 3);
		assert_eq!(parts2[1], ""); // Empty between ,,
	}

	#[test]
	fn test_split_no_separator() {
		let s = Str::new("hello");
		let parts: Vec<_> = s.split(",").collect();
		assert_eq!(parts.len(), 1);
		assert_eq!(parts[0], "hello");
	}

	// ============================
	// Uniqueness & Sharing Tests
	// ============================

	#[test]
	fn test_is_unique_inline() {
		let s = Str::new("hello");
		assert!(s.is_unique()); // Inline always unique
	}

	#[test]
	fn test_is_unique_heap_unshared() {
		let s = Str::new("hello world hello world!!");
		assert!(s.is_unique()); // Newly created heap string is unique
	}

	#[test]
	fn test_is_unique_heap_shared() {
		let s1 = Str::new("hello world hello world!!");
		let s2 = s1.clone();

		assert!(!s1.is_unique()); // Now shared
		assert!(!s2.is_unique());
	}

	#[test]
	fn test_into_ascii_uppercase_leaves_shared_clone_untouched() {
		let s1 = Str::new("hello world hello world!!");
		let s2 = s1.clone();

		// Shared storage: the conversion must copy, not mutate in place.
		let upper = s1.into_ascii_uppercase();

		assert_eq!(upper.as_str(), "HELLO WORLD HELLO WORLD!!");
		assert_eq!(s2.as_str(), "hello world hello world!!"); // Unchanged
	}

	// ============================
	// Conversion Tests
	// ============================

	#[test]
	fn test_from_arc_str() {
		let arc: Arc<str> = "hello world hello world".into();
		let s = Str::from(arc);
		assert!(s.is_spilled());
		assert_eq!(s.as_str(), "hello world hello world");
	}

	#[test]
	fn test_from_box_str() {
		let boxed: Box<str> = "hello world".into();
		let s = Str::from(boxed);
		assert_eq!(s.as_str(), "hello world");
	}

	#[test]
	fn test_from_cow_borrowed() {
		let cow = Cow::Borrowed("hello");
		let s = Str::from(cow);
		assert_eq!(s.as_str(), "hello");
	}

	#[test]
	fn test_from_cow_owned() {
		let cow = Cow::<str>::Owned(String::from("hello world hello world"));
		let s = Str::from(cow);
		assert_eq!(s.as_str(), "hello world hello world");
	}

	#[test]
	fn test_into_string() {
		let s = Str::new("hello world");
		let string: String = s.into();
		assert_eq!(string, "hello world");
	}

	#[test]
	fn test_into_bytes() {
		let s = Str::new("hello world hello world");
		let bytes: bytes::Bytes = s.into();
		assert_eq!(&bytes[..], b"hello world hello world");
	}

	#[test]
	fn test_into_bytes_inline() {
		let s = Str::new("hello");
		let bytes: bytes::Bytes = s.into();
		assert_eq!(&bytes[..], b"hello");
	}

	#[test]
	fn test_from_iterator_char() {
		let chars = vec!['h', 'e', 'l', 'l', 'o'];
		let s: Str = chars.into_iter().collect();
		assert_eq!(s.as_str(), "hello");
	}

	#[test]
	fn test_from_iterator_str_ref() {
		let strs = vec!["hello", " ", "world"];
		let s: Str = strs.into_iter().collect();
		assert_eq!(s.as_str(), "hello world");
	}

	#[test]
	fn test_from_iterator_string() {
		let strings = vec![String::from("hello"), String::from(" "), String::from("world")];
		let s: Str = strings.into_iter().collect();
		assert_eq!(s.as_str(), "hello world");
	}

	#[test]
	fn test_from_iterator_triggers_heap() {
		let s: Str = "123456789012345678901234".chars().collect();
		assert!(s.is_spilled());
		assert_eq!(s.as_str(), "123456789012345678901234");
	}

	// ============================
	// StrExt Tests
	// ============================

	#[test]
	fn test_to_ascii_lowercase_str() {
		let s = "HELLO WORLD";
		let lower = s.to_ascii_lowercase_str();
		assert_eq!(lower.as_str(), "hello world");
		assert!(!lower.is_spilled());

		let long = "HELLO WORLD HELLO WORLD!!";
		let lower_long = long.to_ascii_lowercase_str();
		assert_eq!(lower_long.as_str(), "hello world hello world!!");
		assert!(lower_long.is_spilled());
	}

	#[test]
	fn test_to_ascii_uppercase_str() {
		let s = "hello world";
		let upper = s.to_ascii_uppercase_str();
		assert_eq!(upper.as_str(), "HELLO WORLD");

		let already_upper = "HELLO";
		let upper2 = already_upper.to_ascii_uppercase_str();
		assert_eq!(upper2.as_str(), "HELLO");
	}

	#[test]
	fn test_into_ascii_lowercase() {
		let s = Str::new("HELLO");
		let lower = s.into_ascii_lowercase();
		assert_eq!(lower.as_str(), "hello");
	}

	#[test]
	fn test_into_ascii_uppercase() {
		let s = Str::new("hello");
		let upper = s.into_ascii_uppercase();
		assert_eq!(upper.as_str(), "HELLO");
	}

	// ============================
	// Macro Tests
	// ============================

	#[test]
	fn test_sf_basic() {
		let s = sf!("hello {}", "world");
		assert_eq!(s.as_str(), "hello world");
	}

	#[test]
	fn test_sf_numbers() {
		let s = sf!("count: {}, value: {:.2}", 42, std::f64::consts::PI);
		assert_eq!(s.as_str(), "count: 42, value: 3.14");
	}

	#[test]
	fn test_sf_no_args() {
		let s = sf!("static text");
		assert_eq!(s.as_str(), "static text");
		assert!(s.is_spilled());
	}

	#[test]
	fn test_sf_mut_basic() {
		let mut s = fmts_mut!("hello {}", "world");
		assert_eq!(s.as_str(), "hello world");
		s.push('!');
		assert_eq!(s.as_str(), "hello world!");
	}

	#[test]
	fn test_sf_heap_allocation() {
		let s = sf!("{}", "123456789012345678901234");
		assert!(s.is_spilled());
		assert_eq!(s.as_str(), "123456789012345678901234");
	}

	// ============================
	// Static String Tests
	// ============================

	#[test]
	fn test_new_static() {
		const STATIC: &str = "hello world hello world";
		let s = Str::new_static(STATIC);

		// Static strings always use heap representation (never inline)
		assert!(s.is_spilled());
		assert_eq!(s.as_str(), STATIC);

		// Even short strings
		const SHORT: &str = "hi";
		let s2 = Str::new_static(SHORT);
		assert!(s2.is_spilled()); // Still heap due to static
	}

	// ============================
	// Serde Tests
	// ============================

	#[test]
	fn test_str_serde_roundtrip() {
		let s = Str::new("hello world");
		let json = json::to_string(&s).unwrap();
		assert_eq!(json, r#""hello world""#);

		let deserialized: Str = json::from_str(&json).unwrap();
		assert_eq!(deserialized.as_str(), "hello world");
	}

	#[test]
	fn test_str_serde_empty() {
		let s = Str::new("");
		let json = json::to_string(&s).unwrap();
		assert_eq!(json, r#""""#);

		let deserialized: Str = json::from_str(&json).unwrap();
		assert!(deserialized.is_empty());
	}

	#[test]
	fn test_str_serde_multibyte() {
		let s = Str::new("世界 🌍");
		let json = json::to_string(&s).unwrap();

		let deserialized: Str = json::from_str(&json).unwrap();
		assert_eq!(deserialized.as_str(), "世界 🌍");
	}

	// ============================
	// Edge Cases
	// ============================

	#[test]
	fn test_clone_inline() {
		let s1 = Str::new("hello");
		let s2 = s1.clone();
		assert_eq!(s1, s2);
		assert!(!s1.is_spilled());
		assert!(!s2.is_spilled());
	}

	#[test]
	fn test_clone_heap() {
		let s1 = Str::new("hello world hello world!!");
		let s2 = s1.clone();
		assert_eq!(s1, s2);

		// Should share same backing
		assert!(!s1.is_unique());
		assert!(!s2.is_unique());
	}

	#[test]
	fn test_default_str() {
		let s = Str::default();
		assert!(s.is_empty());
		assert!(!s.is_spilled());
	}

	#[test]
	fn test_default_strmut() {
		let m = StrMut::default();
		assert!(m.is_empty());
		assert!(!m.is_spilled());
	}

	#[test]
	fn test_with_capacity_inline() {
		let m = StrMut::with_capacity(10);
		assert!(!m.is_spilled());
		assert!(m.is_empty());
	}

	#[test]
	fn test_with_capacity_heap() {
		let m = StrMut::with_capacity(100);
		assert!(m.is_spilled());
		assert!(m.is_empty());
	}

	#[test]
	fn test_freeze_inline() {
		let m = StrMut::new("hello");
		let s = m.freeze();
		assert_eq!(s.as_str(), "hello");
		assert!(!s.is_spilled());
	}

	#[test]
	fn test_freeze_heap() {
		let m = StrMut::new("hello world hello world!!");
		let s = m.freeze();
		assert_eq!(s.as_str(), "hello world hello world!!");
		assert!(s.is_spilled());
	}

	#[test]
	fn test_extend_empty_iterator() {
		let mut m = StrMut::new("hello");
		let empty: Vec<&str> = vec![];
		m.extend(empty);
		assert_eq!(m.as_str(), "hello");
	}

	#[test]
	fn test_equality_different_repr() {
		// Same content, different representations
		let inline = Str::new("hello");
		let heap = Str::new("hello world hello world!!").slice(0..5);

		assert_eq!(inline, heap);
		assert!(!inline.is_spilled());
		assert!(heap.is_spilled());
	}

	#[test]
	fn test_ordering() {
		let a = Str::new("apple");
		let b = Str::new("banana");
		let c = Str::new("cherry");

		assert!(a < b);
		assert!(b < c);
		assert!(a < c);
		assert!((b >= a));
	}

	#[test]
	fn test_hash_consistency() {
		use std::{
			collections::hash_map::DefaultHasher,
			hash::{Hash, Hasher},
		};

		let s1 = Str::new("hello world");
		let s2 = Str::new("hello world hello world").slice(0..11);

		let mut h1 = DefaultHasher::new();
		s1.hash(&mut h1);

		let mut h2 = DefaultHasher::new();
		s2.hash(&mut h2);

		assert_eq!(h1.finish(), h2.finish());
	}

	#[test]
	fn test_as_bytes() {
		let s = Str::new("hello 🌍");
		let bytes = s.as_bytes();
		assert_eq!(bytes, "hello 🌍".as_bytes());
	}

	#[test]
	fn test_insert_at_end() {
		let mut m = StrMut::new("hello");
		m.insert(5, " world");
		assert_eq!(m.as_str(), "hello world");
	}

	#[test]
	fn test_insert_at_start() {
		let mut m = StrMut::new("world");
		m.insert(0, "hello ");
		assert_eq!(m.as_str(), "hello world");
	}

	#[test]
	fn test_truncate_noop() {
		let mut s = Str::new("hello");
		s.truncate(100); // Greater than length
		assert_eq!(s.as_str(), "hello");

		s.truncate(5); // Exact length
		assert_eq!(s.as_str(), "hello");
	}

	#[test]
	fn test_truncate_mut_noop() {
		let mut m = StrMut::new("hello");
		m.truncate(100);
		assert_eq!(m.as_str(), "hello");
	}

	#[test]
	fn test_deref_coercion() {
		let s = Str::new("hello");
		let len = s.len(); // Should work via Deref
		assert_eq!(len, 5);

		// Can pass to function expecting &str
		fn takes_str(s: &str) -> usize {
			s.len()
		}
		assert_eq!(takes_str(&s), 5);
	}

	#[test]
	fn test_borrow_trait() {
		use std::borrow::Borrow;

		let s = Str::new("hello");
		let borrowed: &str = s.borrow();
		assert_eq!(borrowed, "hello");
	}

	#[test]
	fn test_as_ref_os_str() {
		let s = Str::new("hello");
		let os_str: &OsStr = s.as_ref();
		assert_eq!(os_str, "hello");
	}

	#[test]
	fn test_as_ref_path() {
		let s = Str::new("/tmp/file.txt");
		let path: &Path = s.as_ref();
		assert_eq!(path.to_str().unwrap(), "/tmp/file.txt");
	}

	#[test]
	fn test_partial_eq_str() {
		let s = Str::new("hello");
		assert_eq!(s, "hello");
		assert_eq!("hello", s);
		assert_ne!(s, "world");
	}

	#[test]
	fn test_partial_eq_string() {
		let s = Str::new("hello");
		let string = String::from("hello");
		assert_eq!(s, string);
		assert_eq!(string, s);
	}

	#[test]
	fn test_strmut_deref_mut() {
		let mut m = StrMut::new("hello");
		let str_mut: &mut str = &mut m;
		str_mut.make_ascii_uppercase();
		assert_eq!(m.as_str(), "HELLO");
	}

	#[test]
	fn test_from_str_parse() {
		let s: Str = "hello world".parse().unwrap();
		assert_eq!(s.as_str(), "hello world");
	}

	#[test]
	fn test_into_str_trait() {
		use super::IntoStr;

		let s: Str = "hello".into_str();
		assert_eq!(s.as_str(), "hello");

		let num: i32 = 42;
		let s2 = (&num).to_str();
		assert_eq!(s2.as_str(), "42");
	}

	#[test]
	fn test_write_trait() {
		use std::fmt::Write;

		let mut m = StrMut::new("hello");
		write!(&mut m, " {}", 42).unwrap();
		assert_eq!(m.as_str(), "hello 42");
	}

	#[test]
	fn test_display_format() {
		let s = Str::new("hello");
		let formatted = format!("{s}");
		assert_eq!(formatted, "hello");
	}

	#[test]
	fn test_debug_format() {
		let s = Str::new("hello");
		let formatted = format!("{s:?}");
		assert_eq!(formatted, "\"hello\"");
	}

	#[test]
	fn test_slice_heap_zero_copy() {
		let s = Str::new("hello world hello world!!");
		let sliced = s.slice(6..11);
		assert_eq!(sliced.as_str(), "world");
		assert!(sliced.is_spilled());
	}

	#[test]
	fn test_slice_inline_creates_inline() {
		let s = Str::new("hello world");
		let sliced = s.slice(0..5);
		assert_eq!(sliced.as_str(), "hello");
		assert!(!sliced.is_spilled());
	}

	#[test]
	fn test_reserve_heap_noop() {
		let mut m = StrMut::new("hello world hello world!!");
		assert!(m.is_spilled());

		let initial_len = m.len();
		m.reserve(10);

		assert_eq!(m.len(), initial_len);
		assert_eq!(m.as_str(), "hello world hello world!!");
	}

	#[test]
	fn test_push_empty_string() {
		let mut m = StrMut::new("hello");
		m.push_str("");
		assert_eq!(m.as_str(), "hello");
	}

	#[test]
	fn test_split_empty_separator() {
		let s = Str::new("hello");
		let parts = s.split("").filter(|s| !s.is_empty()).count();
		assert_eq!(parts, 5);
	}

	#[test]
	fn test_from_bytes_mut() {
		let bytes_mut = BytesMut::from("hello world hello world");
		let result = StrMut::from_utf8_owned(bytes_mut);
		assert!(result.is_ok());
		let m = result.unwrap();
		assert_eq!(m.as_str(), "hello world hello world");
		assert!(m.is_spilled());
	}

	#[test]
	fn test_into_bytes_mut() {
		let m = StrMut::new("hello world hello world");
		let bytes_mut: BytesMut = m.into();
		assert_eq!(&bytes_mut[..], b"hello world hello world");
	}

	#[test]
	fn test_str_to_str() {
		let s = Str::new("hello");
		let str_ref = {
			use bytes_utils::Str;
			Str::from(s)
		};
		assert_eq!(&*str_ref, "hello");
	}

	#[test]
	fn test_strmut_to_strmut() {
		let m = StrMut::new("hello world hello world");
		let str_mut: bytes_utils::StrMut = m.into();
		assert_eq!(&*str_mut, "hello world hello world");
	}
}
