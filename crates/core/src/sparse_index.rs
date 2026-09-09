//! Index conversion traits for sparse containers.
//!
//! Defines `TrySparseIndex` for types that map to `usize` indices with
//! validation, enabling enum keys, bounded integers, and other constrained
//! index types.

use std::{convert, error};
/// A trait for types that can be safely converted to and from indices.
///
/// This trait extends [`SparseIndex`] with fallible conversion methods,
/// allowing for validation of index values during conversion. It's particularly
/// useful for bounded types like small integers or enums with gaps in their
/// value range.
///
/// # Examples
///
/// ```
/// use omp_core::sparse_index::TrySparseIndex;
///
/// // u8 implements TrySparseIndex with bounds checking
/// assert!(u8::try_from_index(255).is_ok());
/// assert!(u8::try_from_index(256).is_err());
/// ```
pub trait TrySparseIndex: Sized {
	/// The error type returned when index conversion fails.
	type Error: error::Error;

	/// Returns the index for this value.
	fn index(&self) -> usize;

	/// Converts an index to this type, assuming the index is valid.
	///
	/// # Safety
	///
	/// This method should only be called with indices that are known to be valid
	/// for the type. For fallible conversion, use [`Self::try_from_index`].
	fn from_index(index: usize) -> Self {
		Self::try_from_index(index).expect("index is valid by TrySparseIndex::from_index contract")
	}

	/// Attempts to convert an index to this type.
	///
	/// # Errors
	///
	/// Returns an error if the index is not valid for this type.
	fn try_from_index(index: usize) -> Result<Self, Self::Error>;

	/// Validates that every index in a sorted iterator is valid for this type.
	///
	/// The default checks each index individually: validity for an arbitrary
	/// type (e.g. an enum with gaps) is not an interval, so probing only the
	/// extremes is insufficient. Types whose valid indices form a contiguous
	/// range (like the integer implementations) override this with an O(1)
	/// min/max check.
	fn validate_sorted(indices: impl DoubleEndedIterator<Item = usize>) -> Result<(), Self::Error> {
		for index in indices {
			Self::try_from_index(index)?;
		}
		Ok(())
	}
}

/// Min/max bulk validation for types whose valid indices form a contiguous
/// range: on a sorted iterator, checking the extremes covers every element.
fn validate_extremes<T: TrySparseIndex>(
	mut indices: impl DoubleEndedIterator<Item = usize>,
) -> Result<(), T::Error> {
	if let Some(max) = indices.next_back() {
		T::try_from_index(max)?;
	}
	if let Some(min) = indices.next() {
		T::try_from_index(min)?;
	}
	Ok(())
}

/// Blanket implementation of [`TrySparseIndex`] for all [`SparseIndex`] types.
///
/// This allows any infallible sparse index type to be used in contexts
/// requiring [`TrySparseIndex`] without additional boilerplate.
impl<T: SparseIndex> TrySparseIndex for T {
	type Error = convert::Infallible;

	fn index(&self) -> usize {
		self.index()
	}

	fn from_index(index: usize) -> Self {
		Self::from_index(index)
	}

	fn try_from_index(index: usize) -> Result<Self, Self::Error> {
		Ok(Self::from_index(index))
	}

	fn validate_sorted(_: impl DoubleEndedIterator<Item = usize>) -> Result<(), Self::Error> {
		Ok(())
	}
}

/// A trait for types that can be infallibly converted to and from indices.
///
/// This trait is for types that have a bijective mapping with `usize` indices,
/// where every possible index value is valid. Examples include most enums
/// without gaps or wrapper types around indices.
///
/// For types that may have invalid index values, use [`TrySparseIndex`]
/// instead.
///
/// # Examples
///
/// ```
/// use omp_core::sparse_index::TrySparseIndex;
///
/// #[repr(usize)]
/// #[derive(Copy, Clone, Debug)]
/// enum Color {
/// 	Red   = 0,
/// 	Green = 1,
/// 	Blue  = 2,
/// }
///
/// #[derive(Debug)]
/// struct ColorError(String);
///
/// impl std::fmt::Display for ColorError {
/// 	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
/// 		write!(f, "{}", self.0)
/// 	}
/// }
///
/// impl std::error::Error for ColorError {}
///
/// impl TrySparseIndex for Color {
/// 	type Error = ColorError;
///
/// 	fn index(&self) -> usize {
/// 		*self as usize
/// 	}
///
/// 	fn try_from_index(index: usize) -> Result<Self, Self::Error> {
/// 		match index {
/// 			0 => Ok(Color::Red),
/// 			1 => Ok(Color::Green),
/// 			2 => Ok(Color::Blue),
/// 			_ => Err(ColorError("Invalid color index".to_string())),
/// 		}
/// 	}
/// }
/// ```
pub trait SparseIndex: Sized {
	/// Returns the index for this value.
	fn index(&self) -> usize;

	/// Converts an index to this type.
	///
	/// # Panics
	///
	/// May panic if the index is not valid for this type. For fallible
	/// conversion, implement [`TrySparseIndex`] instead.
	fn from_index(index: usize) -> Self;
}

/// Error type for numeric index conversions that are out of bounds.
#[derive(Debug, thiserror::Error)]
pub enum NumericIndexError {
	/// The provided index exceeds the maximum value for the target type.
	#[error("index out of bounds: {received} is not in [0..{max}]")]
	OutOfBounds {
		/// Maximum valid index for the type.
		max:      usize,
		/// Index that was provided.
		received: usize,
	},
}

/// Macro to implement [`TrySparseIndex`] for unsigned integer types.
///
/// This provides bounds-checked conversions for numeric types, ensuring
/// that indices fit within the target type's range.
macro_rules! impl_integers {
    ($($u:ty => $i:ty),*) => {
        $(
            impl TrySparseIndex for $u {
                type Error = NumericIndexError;

                #[inline]
                fn index(&self) -> usize {
                    *self as usize
                }
                #[inline]
                fn from_index(index: usize) -> Self {
                    index as $u
                }
                #[inline]
                fn try_from_index(index: usize) -> Result<Self, Self::Error> {
                  if index > <$u>::MAX as usize {
                     Err(NumericIndexError::OutOfBounds {
                        max: <$u>::MAX as usize,
                        received: index,
                     })
                  } else {
                     Ok(Self::from_index(index))
                  }
                }
                #[inline]
                fn validate_sorted(
                    indices: impl DoubleEndedIterator<Item = usize>,
                ) -> Result<(), Self::Error> {
                    validate_extremes::<Self>(indices)
                }
            }


            impl TrySparseIndex for $i {
                type Error = NumericIndexError;

                #[inline]
                fn index(&self) -> usize {
                    *self as usize
                }
                #[inline]
                fn from_index(index: usize) -> Self {
                    index as $i
                }
                #[inline]
                fn try_from_index(index: usize) -> Result<Self, Self::Error> {
                  if index > <$i>::MAX as usize {
                     Err(NumericIndexError::OutOfBounds {
                        max: <$i>::MAX as usize,
                        received: index,
                     })
                  } else {
                     Ok(Self::from_index(index))
                  }
                }
                #[inline]
                fn validate_sorted(
                    indices: impl DoubleEndedIterator<Item = usize>,
                ) -> Result<(), Self::Error> {
                    validate_extremes::<Self>(indices)
                }
            }

            impl TrySparseIndex for std::num::NonZero<$i> {
                type Error = NumericIndexError;

                #[inline]
                fn index(&self) -> usize {
                    self.get() as usize - 1
                }
                #[inline]
                fn from_index(index: usize) -> Self {
                    // Checked add + checked conversion: truncating casts could
                    // otherwise produce 0 (e.g. index 255 for NonZeroI8 wrapping
                    // through 256), which NonZero must never hold.
                    let value = index
                        .checked_add(1)
                        .and_then(|v| <$i>::try_from(v).ok())
                        .expect("index out of range");
                    Self::new(value).expect("index + 1 is non-zero")
                }
                #[inline]
                fn try_from_index(index: usize) -> Result<Self, Self::Error> {
                  if index >= <$i>::MAX as usize {
                     Err(NumericIndexError::OutOfBounds {
                        max: <$i>::MAX as usize - 1,
                        received: index,
                     })
                  } else {
                     Ok(Self::from_index(index))
                  }
                }
                #[inline]
                fn validate_sorted(
                    indices: impl DoubleEndedIterator<Item = usize>,
                ) -> Result<(), Self::Error> {
                    validate_extremes::<Self>(indices)
                }
            }

            impl TrySparseIndex for std::num::NonZero<$u> {
                type Error = NumericIndexError;

                #[inline]
                fn index(&self) -> usize {
                    self.get() as usize - 1
                }
                #[inline]
                fn from_index(index: usize) -> Self {
                    // Checked add + checked conversion: truncating casts could
                    // otherwise produce 0 (e.g. index 255 for NonZeroU8 wrapping
                    // through 256), which NonZero must never hold.
                    let value = index
                        .checked_add(1)
                        .and_then(|v| <$u>::try_from(v).ok())
                        .expect("index out of range");
                    Self::new(value).expect("index + 1 is non-zero")
                }
                #[inline]
                fn try_from_index(index: usize) -> Result<Self, Self::Error> {
                  if index >= <$u>::MAX as usize {
                     Err(NumericIndexError::OutOfBounds {
                        max: <$u>::MAX as usize - 1,
                        received: index,
                     })
                  } else {
                     Ok(Self::from_index(index))
                  }
                }
                #[inline]
                fn validate_sorted(
                    indices: impl DoubleEndedIterator<Item = usize>,
                ) -> Result<(), Self::Error> {
                    validate_extremes::<Self>(indices)
                }
            }
        )*
    };
}

impl_integers!(
	u8 => i8,
	u16 => i16,
	u32 => i32,
	u64 => i64,
	usize => isize
);
