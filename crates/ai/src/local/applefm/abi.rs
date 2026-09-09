//! Architecture-specific Swift ABI adapters for Foundation Models.

use core::arch::global_asm;

// Swift reserves x8 for indirect results, x20 for the synchronous context, and
// x22 for the async context on AArch64.
#[cfg(target_arch = "aarch64")]
global_asm!(include_str!("aarch64.s"));

#[cfg(target_arch = "x86_64")]
global_asm!(include_str!("x86_64.s"));
