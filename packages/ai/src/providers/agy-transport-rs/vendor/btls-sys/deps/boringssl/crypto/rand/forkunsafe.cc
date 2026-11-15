// Copyright 2017 The BoringSSL Authors
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

#include <openssl/rand.h>

#include <stdlib.h>

#include "../fipsmodule/rand/internal.h"
#include "../internal.h"


// g_buffering_enabled is one if fork-unsafe buffering has been enabled and zero
// otherwise.
static bssl::Atomic<uint32_t> g_buffering_enabled;

#if !defined(OPENSSL_WINDOWS)
void RAND_enable_fork_unsafe_buffering(int fd) {
  // We no longer support setting the file-descriptor with this function.
  if (fd != -1) {
    abort();
  }

  g_buffering_enabled.store(1);
}

void RAND_disable_fork_unsafe_buffering(void) { g_buffering_enabled.store(0); }
#endif

int rand_fork_unsafe_buffering_enabled(void) {
  return g_buffering_enabled.load() != 0;
}
