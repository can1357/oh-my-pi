use std::fmt;

use crate::error::Parse;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct DecodedLength(u64);

impl DecodedLength {
    pub(crate) const MAX_LEN: u64 = u64::MAX - 2;
    pub(crate) const CLOSE_DELIMITED: DecodedLength = DecodedLength(u64::MAX);
    pub(crate) const CHUNKED: DecodedLength = DecodedLength(u64::MAX - 1);
    pub(crate) const ZERO: DecodedLength = DecodedLength(0);

    /// Takes the length as a content-length without other checks.
    ///
    /// Should only be called if previously confirmed this isn't
    /// CLOSE_DELIMITED or CHUNKED.
    #[inline]
    pub(crate) fn danger_len(self) -> u64 {
        debug_assert!(self.0 < Self::CHUNKED.0);
        self.0
    }

    /// Converts to an `Option<u64>` representing a Known or Unknown length.
    #[inline]
    pub(crate) fn into_opt(self) -> Option<u64> {
        match self {
            DecodedLength::CHUNKED | DecodedLength::CLOSE_DELIMITED => None,
            DecodedLength(known) => Some(known),
        }
    }

    /// Checks the `u64` is within the maximum allowed for content-length.
    pub(crate) fn checked_new(len: u64) -> Result<Self, Parse> {
        if len <= Self::MAX_LEN {
            Ok(DecodedLength(len))
        } else {
            warn!(
                "content-length bigger than maximum: {} > {}",
                len,
                Self::MAX_LEN
            );
            Err(Parse::TooLarge)
        }
    }

    /// Subtracts the given amount from the length, if it's a known length.
    pub(crate) fn sub_if(&mut self, amt: u64) {
        match *self {
            DecodedLength::CHUNKED | DecodedLength::CLOSE_DELIMITED => (),
            DecodedLength(ref mut known) => {
                *known -= amt;
            }
        }
    }

    /// Returns whether this represents an exact length.
    ///
    /// This includes 0, which of course is an exact known length.
    ///
    /// It would return false if "chunked" or otherwise size-unknown.
    #[inline]
    pub(crate) fn is_exact(&self) -> bool {
        self.0 <= Self::MAX_LEN
    }
}

impl From<Option<u64>> for DecodedLength {
    fn from(len: Option<u64>) -> Self {
        // If the length is u64::MAX, oh well, just reported chunked.
        len.and_then(|len| Self::checked_new(len).ok())
            .unwrap_or(DecodedLength::CHUNKED)
    }
}

impl fmt::Debug for DecodedLength {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            DecodedLength::CLOSE_DELIMITED => f.write_str("CLOSE_DELIMITED"),
            DecodedLength::CHUNKED => f.write_str("CHUNKED"),
            DecodedLength(n) => f.debug_tuple("DecodedLength").field(&n).finish(),
        }
    }
}

impl fmt::Display for DecodedLength {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            DecodedLength::CLOSE_DELIMITED => f.write_str("close-delimited"),
            DecodedLength::CHUNKED => f.write_str("chunked encoding"),
            DecodedLength::ZERO => f.write_str("empty"),
            DecodedLength(n) => write!(f, "content-length ({n} bytes)"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl DecodedLength {
        pub(crate) fn new(len: u64) -> Self {
            debug_assert!(len <= Self::MAX_LEN);
            DecodedLength(len)
        }
    }

    #[test]
    fn sub_if_known() {
        let mut len = DecodedLength::new(30);
        len.sub_if(20);

        assert_eq!(len.0, 10);
    }

    #[test]
    fn sub_if_chunked() {
        let mut len = DecodedLength::CHUNKED;
        len.sub_if(20);

        assert_eq!(len, DecodedLength::CHUNKED);
    }
}
