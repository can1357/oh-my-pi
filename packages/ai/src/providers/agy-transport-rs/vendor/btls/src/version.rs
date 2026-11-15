// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

use std::ffi::CStr;

use crate::ffi::{
    OpenSSL_version, OpenSSL_version_num, OPENSSL_BUILT_ON, OPENSSL_CFLAGS, OPENSSL_DIR,
    OPENSSL_PLATFORM, OPENSSL_VERSION,
};

/// OPENSSL_VERSION_NUMBER is a numeric release version identifier:
///
/// `MNNFFPPS: major minor fix patch status`
///
/// The status nibble has one of the values 0 for development, 1 to e for betas 1 to 14, and f for release.
///
/// for example
///
/// `0x000906000 == 0.9.6 dev`
/// `0x000906023 == 0.9.6b beta 3`
/// `0x00090605f == 0.9.6e release`
///
/// Versions prior to 0.9.3 have identifiers < 0x0930. Versions between 0.9.3 and 0.9.5 had a version identifier with this interpretation:
///
/// `MMNNFFRBB major minor fix final beta/patch`
///
/// for example
///
/// `0x000904100 == 0.9.4 release`
/// `0x000905000 == 0.9.5 dev`
///
/// Version 0.9.5a had an interim interpretation that is like the current one, except the patch level got the highest bit set, to keep continuity. The number was therefore 0x0090581f
///
/// The return value of this function can be compared to the macro to make sure that the correct version of the library has been loaded, especially when using DLLs on Windows systems.
#[must_use]
pub fn number() -> i64 {
    unsafe { OpenSSL_version_num() as i64 }
}

/// The text variant of the version number and the release date. For example, "OpenSSL 0.9.5a 1 Apr 2000".
#[must_use]
pub fn version() -> &'static str {
    unsafe {
        CStr::from_ptr(OpenSSL_version(OPENSSL_VERSION))
            .to_str()
            .unwrap()
    }
}

/// The compiler flags set for the compilation process in the form "compiler: ..." if available or
/// "compiler: information not available" otherwise.
#[must_use]
pub fn c_flags() -> &'static str {
    unsafe {
        CStr::from_ptr(OpenSSL_version(OPENSSL_CFLAGS))
            .to_str()
            .unwrap()
    }
}

/// The date of the build process in the form "built on: ..." if available or "built on: date not available" otherwise.
#[must_use]
pub fn built_on() -> &'static str {
    unsafe {
        CStr::from_ptr(OpenSSL_version(OPENSSL_BUILT_ON))
            .to_str()
            .unwrap()
    }
}

/// The "Configure" target of the library build in the form "platform: ..." if available or "platform: information not available" otherwise.
#[must_use]
pub fn platform() -> &'static str {
    unsafe {
        CStr::from_ptr(OpenSSL_version(OPENSSL_PLATFORM))
            .to_str()
            .unwrap()
    }
}

/// The "OPENSSLDIR" setting of the library build in the form "OPENSSLDIR: "..."" if available or "OPENSSLDIR: N/A" otherwise.
#[must_use]
pub fn dir() -> &'static str {
    unsafe {
        CStr::from_ptr(OpenSSL_version(OPENSSL_DIR))
            .to_str()
            .unwrap()
    }
}

/// This test ensures that we do not segfault when calling the functions of this module
/// and that the strings respect a reasonable format.
#[test]
fn test_versions() {
    println!("Number: '{}'", number());
    println!("Version: '{}'", version());
    println!("C flags: '{}'", c_flags());
    println!("Built on: '{}'", built_on());
    println!("Platform: '{}'", platform());
    println!("Dir: '{}'", dir());

    assert!(number() > 0);
    assert!(version().starts_with("BoringSSL"));
    assert!(c_flags().starts_with("compiler:"));
    assert!(built_on().starts_with("built on:"));
    assert!(dir().starts_with("OPENSSLDIR:"));
}
