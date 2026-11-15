use crate::ffi;
use crate::stack::Stackable;
use foreign_types::ForeignTypeRef;
use libc::c_ulong;
use std::ffi::CStr;
use std::str;

/// fake free method, since SRTP_PROTECTION_PROFILE is static
unsafe fn free(_profile: *mut ffi::SRTP_PROTECTION_PROFILE) {}

foreign_type_and_impl_send_sync! {
    type CType = ffi::SRTP_PROTECTION_PROFILE;
    fn drop = free;

    pub struct SrtpProtectionProfile;
}

impl Stackable for SrtpProtectionProfile {
    type StackType = ffi::stack_st_SRTP_PROTECTION_PROFILE;
}

impl SrtpProtectionProfileRef {
    #[must_use]
    pub fn id(&self) -> SrtpProfileId {
        SrtpProfileId::from_raw(unsafe { (*self.as_ptr()).id })
    }

    #[must_use]
    pub fn name(&self) -> &'static str {
        unsafe { CStr::from_ptr((*self.as_ptr()).name.cast()) }
            .to_str()
            .expect("should be UTF-8")
    }
}

/// An identifier of an SRTP protection profile.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct SrtpProfileId(c_ulong);

impl SrtpProfileId {
    pub const SRTP_AES128_CM_SHA1_80: SrtpProfileId =
        SrtpProfileId(ffi::SRTP_AES128_CM_SHA1_80 as _);
    pub const SRTP_AES128_CM_SHA1_32: SrtpProfileId =
        SrtpProfileId(ffi::SRTP_AES128_CM_SHA1_32 as _);
    pub const SRTP_AES128_F8_SHA1_80: SrtpProfileId =
        SrtpProfileId(ffi::SRTP_AES128_F8_SHA1_80 as _);
    pub const SRTP_AES128_F8_SHA1_32: SrtpProfileId =
        SrtpProfileId(ffi::SRTP_AES128_F8_SHA1_32 as _);
    pub const SRTP_NULL_SHA1_80: SrtpProfileId = SrtpProfileId(ffi::SRTP_NULL_SHA1_80 as _);
    pub const SRTP_NULL_SHA1_32: SrtpProfileId = SrtpProfileId(ffi::SRTP_NULL_SHA1_32 as _);

    /// Creates a `SrtpProfileId` from an integer representation.
    #[must_use]
    pub fn from_raw(value: c_ulong) -> SrtpProfileId {
        SrtpProfileId(value)
    }

    /// Returns the integer representation of `SrtpProfileId`.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn as_raw(&self) -> c_ulong {
        self.0
    }
}
