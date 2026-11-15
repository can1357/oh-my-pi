// Copyright 2024 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package build

// A Target is a build target for consumption by the downstream build systems.
// All pre-generated files are baked input its source lists.
type Target struct {
	// Srcs is the list of C, C++, or Rust files (determined by file extension)
	// that are built into the target.
	Srcs []string `json:"srcs,omitempty"`
	// Hdrs is the list public headers that should be available to external
	// projects using this target.
	Hdrs []string `json:"hdrs,omitempty"`
	// InternalHdrs is the list of internal headers that should be available to
	// this target, as well as any internal targets using this target.
	InternalHdrs []string `json:"internal_hdrs,omitempty"`
	// Asm is the a list of assembly files to be passed to a gas-compatible
	// assembler.
	Asm []string `json:"asm,omitempty"`
	// Nasm is the a list of assembly files to be passed to a nasm-compatible
	// assembler.
	Nasm []string `json:"nasm,omitempty"`
	// Data is a list of test data files that should be available when the test is
	// run.
	Data []string `json:"data,omitempty"`
}
