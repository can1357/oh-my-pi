//! Generic utilities.

use crate::error;

/// Trait for integer types that support parsing from strings with a radix.
pub trait ParseIntRadix: Sized {
	/// Parse a string as this integer type using the specified radix.
	fn from_str_radix(s: &str, radix: u32) -> Result<Self, std::num::ParseIntError>;

	/// Returns the name of the integer type as a static string.
	fn type_name() -> &'static str;
}

macro_rules! impl_parse_int_radix {
	($t:ty) => {
		impl ParseIntRadix for $t {
			fn from_str_radix(s: &str, radix: u32) -> Result<Self, std::num::ParseIntError> {
				Self::from_str_radix(s, radix)
			}

			fn type_name() -> &'static str {
				stringify!($t)
			}
		}
	};
}

impl_parse_int_radix!(u8);
impl_parse_int_radix!(u16);
impl_parse_int_radix!(i32);
impl_parse_int_radix!(u32);
impl_parse_int_radix!(usize);

/// Parse the given string as an integer in the specified radix.
///
/// # Arguments
///
/// * `s` - The string to parse.
/// * `radix` - The base to use for parsing.
///
/// # Type Parameters
///
/// * `T` - The integer type to parse. Must implement `ParseIntRadix`.
///
/// # Examples
///
/// ```
/// use brush_core::int_utils::parse;
///
/// let result: u32 = parse("42", 10)?;
/// assert_eq!(result, 42);
///
/// let result: u8 = parse("FF", 16)?;
/// assert_eq!(result, 255);
/// # Ok::<(), brush_core::error::Error>(())
/// ```
pub fn parse<T: ParseIntRadix>(s: &str, radix: u32) -> Result<T, error::Error> {
	T::from_str_radix(s, radix).map_err(|inner| {
		error::ErrorKind::IntParseError {
			s: s.to_owned(),
			int_type_name: T::type_name(),
			radix,
			inner,
		}
		.into()
	})
}
