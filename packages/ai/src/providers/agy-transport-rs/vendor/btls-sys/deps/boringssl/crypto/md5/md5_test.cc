// Copyright 2018 The BoringSSL Authors
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

#include <openssl/md5.h>

#include <gtest/gtest.h>

#include "internal.h"
#include "../test/abi_test.h"


#if defined(MD5_ASM) && defined(SUPPORTS_ABI_TEST)
TEST(MD5Test, ABI) {
  MD5_CTX ctx;
  MD5_Init(&ctx);

  static const uint8_t kBuf[MD5_CBLOCK * 8] = {0};
  CHECK_ABI(md5_block_asm_data_order, ctx.h, kBuf, 1);
  CHECK_ABI(md5_block_asm_data_order, ctx.h, kBuf, 2);
  CHECK_ABI(md5_block_asm_data_order, ctx.h, kBuf, 4);
  CHECK_ABI(md5_block_asm_data_order, ctx.h, kBuf, 8);
}
#endif  // MD5_ASM && SUPPORTS_ABI_TEST
