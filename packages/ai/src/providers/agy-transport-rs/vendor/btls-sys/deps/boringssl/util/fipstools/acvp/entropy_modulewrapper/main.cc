// Copyright 2025 The BoringSSL Authors
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

#include <stdio.h>
#include <string.h>

#include "../modulewrapper/modulewrapper.h"


int main(int argc, char **argv) {
  if (argc != 1 && strcmp(argv[1], "--version") == 0) {
    printf("Built for architecture: ");

#if defined(OPENSSL_X86_64)
    puts("x86-64 (64-bit)");
#elif defined(OPENSSL_ARM)
    puts("ARM (32-bit)");
#elif defined(OPENSSL_AARCH64)
    puts("aarch64 (64-bit)");
#else
#error "FIPS build not supported on this architecture"
#endif
    return 0;
  } else if (argc != 1) {
    fprintf(stderr, "Usage: %s [--version]\n", argv[0]);
    return 4;
  }

  return bssl::acvp::RunModuleWrapper();
}
