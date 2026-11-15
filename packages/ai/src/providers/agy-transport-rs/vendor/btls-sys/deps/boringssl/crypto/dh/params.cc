// Copyright 2011-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/dh.h>

#include <openssl/bn.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/span.h>

#include "../fipsmodule/bn/internal.h"
#include "../fipsmodule/dh/internal.h"


static BIGNUM *get_params(BIGNUM *ret, bssl::Span<const BN_ULONG> words) {
  BIGNUM *alloc = nullptr;
  if (ret == nullptr) {
    alloc = BN_new();
    if (alloc == nullptr) {
      return nullptr;
    }
    ret = alloc;
  }

  if (!bn_set_words(ret, words.data(), words.size())) {
    BN_free(alloc);
    return nullptr;
  }

  return ret;
}

BIGNUM *BN_get_rfc3526_prime_1536(BIGNUM *ret) {
  static const BN_ULONG kWords[] = {
      TOBN(0xffffffff, 0xffffffff), TOBN(0xf1746c08, 0xca237327),
      TOBN(0x670c354e, 0x4abc9804), TOBN(0x9ed52907, 0x7096966d),
      TOBN(0x1c62f356, 0x208552bb), TOBN(0x83655d23, 0xdca3ad96),
      TOBN(0x69163fa8, 0xfd24cf5f), TOBN(0x98da4836, 0x1c55d39a),
      TOBN(0xc2007cb8, 0xa163bf05), TOBN(0x49286651, 0xece45b3d),
      TOBN(0xae9f2411, 0x7c4b1fe6), TOBN(0xee386bfb, 0x5a899fa5),
      TOBN(0x0bff5cb6, 0xf406b7ed), TOBN(0xf44c42e9, 0xa637ed6b),
      TOBN(0xe485b576, 0x625e7ec6), TOBN(0x4fe1356d, 0x6d51c245),
      TOBN(0x302b0a6d, 0xf25f1437), TOBN(0xef9519b3, 0xcd3a431b),
      TOBN(0x514a0879, 0x8e3404dd), TOBN(0x020bbea6, 0x3b139b22),
      TOBN(0x29024e08, 0x8a67cc74), TOBN(0xc4c6628b, 0x80dc1cd1),
      TOBN(0xc90fdaa2, 0x2168c234), TOBN(0xffffffff, 0xffffffff),
  };
  return get_params(ret, kWords);
}

BIGNUM *BN_get_rfc3526_prime_2048(BIGNUM *ret) {
  static const BN_ULONG kWords[] = {
      TOBN(0xffffffff, 0xffffffff), TOBN(0x15728e5a, 0x8aacaa68),
      TOBN(0x15d22618, 0x98fa0510), TOBN(0x3995497c, 0xea956ae5),
      TOBN(0xde2bcbf6, 0x95581718), TOBN(0xb5c55df0, 0x6f4c52c9),
      TOBN(0x9b2783a2, 0xec07a28f), TOBN(0xe39e772c, 0x180e8603),
      TOBN(0x32905e46, 0x2e36ce3b), TOBN(0xf1746c08, 0xca18217c),
      TOBN(0x670c354e, 0x4abc9804), TOBN(0x9ed52907, 0x7096966d),
      TOBN(0x1c62f356, 0x208552bb), TOBN(0x83655d23, 0xdca3ad96),
      TOBN(0x69163fa8, 0xfd24cf5f), TOBN(0x98da4836, 0x1c55d39a),
      TOBN(0xc2007cb8, 0xa163bf05), TOBN(0x49286651, 0xece45b3d),
      TOBN(0xae9f2411, 0x7c4b1fe6), TOBN(0xee386bfb, 0x5a899fa5),
      TOBN(0x0bff5cb6, 0xf406b7ed), TOBN(0xf44c42e9, 0xa637ed6b),
      TOBN(0xe485b576, 0x625e7ec6), TOBN(0x4fe1356d, 0x6d51c245),
      TOBN(0x302b0a6d, 0xf25f1437), TOBN(0xef9519b3, 0xcd3a431b),
      TOBN(0x514a0879, 0x8e3404dd), TOBN(0x020bbea6, 0x3b139b22),
      TOBN(0x29024e08, 0x8a67cc74), TOBN(0xc4c6628b, 0x80dc1cd1),
      TOBN(0xc90fdaa2, 0x2168c234), TOBN(0xffffffff, 0xffffffff),
  };
  return get_params(ret, kWords);
}

BIGNUM *BN_get_rfc3526_prime_3072(BIGNUM *ret) {
  static const BN_ULONG kWords[] = {
      TOBN(0xffffffff, 0xffffffff), TOBN(0x4b82d120, 0xa93ad2ca),
      TOBN(0x43db5bfc, 0xe0fd108e), TOBN(0x08e24fa0, 0x74e5ab31),
      TOBN(0x770988c0, 0xbad946e2), TOBN(0xbbe11757, 0x7a615d6c),
      TOBN(0x521f2b18, 0x177b200c), TOBN(0xd8760273, 0x3ec86a64),
      TOBN(0xf12ffa06, 0xd98a0864), TOBN(0xcee3d226, 0x1ad2ee6b),
      TOBN(0x1e8c94e0, 0x4a25619d), TOBN(0xabf5ae8c, 0xdb0933d7),
      TOBN(0xb3970f85, 0xa6e1e4c7), TOBN(0x8aea7157, 0x5d060c7d),
      TOBN(0xecfb8504, 0x58dbef0a), TOBN(0xa85521ab, 0xdf1cba64),
      TOBN(0xad33170d, 0x04507a33), TOBN(0x15728e5a, 0x8aaac42d),
      TOBN(0x15d22618, 0x98fa0510), TOBN(0x3995497c, 0xea956ae5),
      TOBN(0xde2bcbf6, 0x95581718), TOBN(0xb5c55df0, 0x6f4c52c9),
      TOBN(0x9b2783a2, 0xec07a28f), TOBN(0xe39e772c, 0x180e8603),
      TOBN(0x32905e46, 0x2e36ce3b), TOBN(0xf1746c08, 0xca18217c),
      TOBN(0x670c354e, 0x4abc9804), TOBN(0x9ed52907, 0x7096966d),
      TOBN(0x1c62f356, 0x208552bb), TOBN(0x83655d23, 0xdca3ad96),
      TOBN(0x69163fa8, 0xfd24cf5f), TOBN(0x98da4836, 0x1c55d39a),
      TOBN(0xc2007cb8, 0xa163bf05), TOBN(0x49286651, 0xece45b3d),
      TOBN(0xae9f2411, 0x7c4b1fe6), TOBN(0xee386bfb, 0x5a899fa5),
      TOBN(0x0bff5cb6, 0xf406b7ed), TOBN(0xf44c42e9, 0xa637ed6b),
      TOBN(0xe485b576, 0x625e7ec6), TOBN(0x4fe1356d, 0x6d51c245),
      TOBN(0x302b0a6d, 0xf25f1437), TOBN(0xef9519b3, 0xcd3a431b),
      TOBN(0x514a0879, 0x8e3404dd), TOBN(0x020bbea6, 0x3b139b22),
      TOBN(0x29024e08, 0x8a67cc74), TOBN(0xc4c6628b, 0x80dc1cd1),
      TOBN(0xc90fdaa2, 0x2168c234), TOBN(0xffffffff, 0xffffffff),
  };
  return get_params(ret, kWords);
}

BIGNUM *BN_get_rfc3526_prime_4096(BIGNUM *ret) {
  static const BN_ULONG kWords[] = {
      TOBN(0xffffffff, 0xffffffff), TOBN(0x4df435c9, 0x34063199),
      TOBN(0x86ffb7dc, 0x90a6c08f), TOBN(0x93b4ea98, 0x8d8fddc1),
      TOBN(0xd0069127, 0xd5b05aa9), TOBN(0xb81bdd76, 0x2170481c),
      TOBN(0x1f612970, 0xcee2d7af), TOBN(0x233ba186, 0x515be7ed),
      TOBN(0x99b2964f, 0xa090c3a2), TOBN(0x287c5947, 0x4e6bc05d),
      TOBN(0x2e8efc14, 0x1fbecaa6), TOBN(0xdbbbc2db, 0x04de8ef9),
      TOBN(0x2583e9ca, 0x2ad44ce8), TOBN(0x1a946834, 0xb6150bda),
      TOBN(0x99c32718, 0x6af4e23c), TOBN(0x88719a10, 0xbdba5b26),
      TOBN(0x1a723c12, 0xa787e6d7), TOBN(0x4b82d120, 0xa9210801),
      TOBN(0x43db5bfc, 0xe0fd108e), TOBN(0x08e24fa0, 0x74e5ab31),
      TOBN(0x770988c0, 0xbad946e2), TOBN(0xbbe11757, 0x7a615d6c),
      TOBN(0x521f2b18, 0x177b200c), TOBN(0xd8760273, 0x3ec86a64),
      TOBN(0xf12ffa06, 0xd98a0864), TOBN(0xcee3d226, 0x1ad2ee6b),
      TOBN(0x1e8c94e0, 0x4a25619d), TOBN(0xabf5ae8c, 0xdb0933d7),
      TOBN(0xb3970f85, 0xa6e1e4c7), TOBN(0x8aea7157, 0x5d060c7d),
      TOBN(0xecfb8504, 0x58dbef0a), TOBN(0xa85521ab, 0xdf1cba64),
      TOBN(0xad33170d, 0x04507a33), TOBN(0x15728e5a, 0x8aaac42d),
      TOBN(0x15d22618, 0x98fa0510), TOBN(0x3995497c, 0xea956ae5),
      TOBN(0xde2bcbf6, 0x95581718), TOBN(0xb5c55df0, 0x6f4c52c9),
      TOBN(0x9b2783a2, 0xec07a28f), TOBN(0xe39e772c, 0x180e8603),
      TOBN(0x32905e46, 0x2e36ce3b), TOBN(0xf1746c08, 0xca18217c),
      TOBN(0x670c354e, 0x4abc9804), TOBN(0x9ed52907, 0x7096966d),
      TOBN(0x1c62f356, 0x208552bb), TOBN(0x83655d23, 0xdca3ad96),
      TOBN(0x69163fa8, 0xfd24cf5f), TOBN(0x98da4836, 0x1c55d39a),
      TOBN(0xc2007cb8, 0xa163bf05), TOBN(0x49286651, 0xece45b3d),
      TOBN(0xae9f2411, 0x7c4b1fe6), TOBN(0xee386bfb, 0x5a899fa5),
      TOBN(0x0bff5cb6, 0xf406b7ed), TOBN(0xf44c42e9, 0xa637ed6b),
      TOBN(0xe485b576, 0x625e7ec6), TOBN(0x4fe1356d, 0x6d51c245),
      TOBN(0x302b0a6d, 0xf25f1437), TOBN(0xef9519b3, 0xcd3a431b),
      TOBN(0x514a0879, 0x8e3404dd), TOBN(0x020bbea6, 0x3b139b22),
      TOBN(0x29024e08, 0x8a67cc74), TOBN(0xc4c6628b, 0x80dc1cd1),
      TOBN(0xc90fdaa2, 0x2168c234), TOBN(0xffffffff, 0xffffffff),
  };
  return get_params(ret, kWords);
}

BIGNUM *BN_get_rfc3526_prime_6144(BIGNUM *ret) {
  static const BN_ULONG kWords[] = {
      TOBN(0xffffffff, 0xffffffff), TOBN(0xe694f91e, 0x6dcc4024),
      TOBN(0x12bf2d5b, 0x0b7474d6), TOBN(0x043e8f66, 0x3f4860ee),
      TOBN(0x387fe8d7, 0x6e3c0468), TOBN(0xda56c9ec, 0x2ef29632),
      TOBN(0xeb19ccb1, 0xa313d55c), TOBN(0xf550aa3d, 0x8a1fbff0),
      TOBN(0x06a1d58b, 0xb7c5da76), TOBN(0xa79715ee, 0xf29be328),
      TOBN(0x14cc5ed2, 0x0f8037e0), TOBN(0xcc8f6d7e, 0xbf48e1d8),
      TOBN(0x4bd407b2, 0x2b4154aa), TOBN(0x0f1d45b7, 0xff585ac5),
      TOBN(0x23a97a7e, 0x36cc88be), TOBN(0x59e7c97f, 0xbec7e8f3),
      TOBN(0xb5a84031, 0x900b1c9e), TOBN(0xd55e702f, 0x46980c82),
      TOBN(0xf482d7ce, 0x6e74fef6), TOBN(0xf032ea15, 0xd1721d03),
      TOBN(0x5983ca01, 0xc64b92ec), TOBN(0x6fb8f401, 0x378cd2bf),
      TOBN(0x33205151, 0x2bd7af42), TOBN(0xdb7f1447, 0xe6cc254b),
      TOBN(0x44ce6cba, 0xced4bb1b), TOBN(0xda3edbeb, 0xcf9b14ed),
      TOBN(0x179727b0, 0x865a8918), TOBN(0xb06a53ed, 0x9027d831),
      TOBN(0xe5db382f, 0x413001ae), TOBN(0xf8ff9406, 0xad9e530e),
      TOBN(0xc9751e76, 0x3dba37bd), TOBN(0xc1d4dcb2, 0x602646de),
      TOBN(0x36c3fab4, 0xd27c7026), TOBN(0x4df435c9, 0x34028492),
      TOBN(0x86ffb7dc, 0x90a6c08f), TOBN(0x93b4ea98, 0x8d8fddc1),
      TOBN(0xd0069127, 0xd5b05aa9), TOBN(0xb81bdd76, 0x2170481c),
      TOBN(0x1f612970, 0xcee2d7af), TOBN(0x233ba186, 0x515be7ed),
      TOBN(0x99b2964f, 0xa090c3a2), TOBN(0x287c5947, 0x4e6bc05d),
      TOBN(0x2e8efc14, 0x1fbecaa6), TOBN(0xdbbbc2db, 0x04de8ef9),
      TOBN(0x2583e9ca, 0x2ad44ce8), TOBN(0x1a946834, 0xb6150bda),
      TOBN(0x99c32718, 0x6af4e23c), TOBN(0x88719a10, 0xbdba5b26),
      TOBN(0x1a723c12, 0xa787e6d7), TOBN(0x4b82d120, 0xa9210801),
      TOBN(0x43db5bfc, 0xe0fd108e), TOBN(0x08e24fa0, 0x74e5ab31),
      TOBN(0x770988c0, 0xbad946e2), TOBN(0xbbe11757, 0x7a615d6c),
      TOBN(0x521f2b18, 0x177b200c), TOBN(0xd8760273, 0x3ec86a64),
      TOBN(0xf12ffa06, 0xd98a0864), TOBN(0xcee3d226, 0x1ad2ee6b),
      TOBN(0x1e8c94e0, 0x4a25619d), TOBN(0xabf5ae8c, 0xdb0933d7),
      TOBN(0xb3970f85, 0xa6e1e4c7), TOBN(0x8aea7157, 0x5d060c7d),
      TOBN(0xecfb8504, 0x58dbef0a), TOBN(0xa85521ab, 0xdf1cba64),
      TOBN(0xad33170d, 0x04507a33), TOBN(0x15728e5a, 0x8aaac42d),
      TOBN(0x15d22618, 0x98fa0510), TOBN(0x3995497c, 0xea956ae5),
      TOBN(0xde2bcbf6, 0x95581718), TOBN(0xb5c55df0, 0x6f4c52c9),
      TOBN(0x9b2783a2, 0xec07a28f), TOBN(0xe39e772c, 0x180e8603),
      TOBN(0x32905e46, 0x2e36ce3b), TOBN(0xf1746c08, 0xca18217c),
      TOBN(0x670c354e, 0x4abc9804), TOBN(0x9ed52907, 0x7096966d),
      TOBN(0x1c62f356, 0x208552bb), TOBN(0x83655d23, 0xdca3ad96),
      TOBN(0x69163fa8, 0xfd24cf5f), TOBN(0x98da4836, 0x1c55d39a),
      TOBN(0xc2007cb8, 0xa163bf05), TOBN(0x49286651, 0xece45b3d),
      TOBN(0xae9f2411, 0x7c4b1fe6), TOBN(0xee386bfb, 0x5a899fa5),
      TOBN(0x0bff5cb6, 0xf406b7ed), TOBN(0xf44c42e9, 0xa637ed6b),
      TOBN(0xe485b576, 0x625e7ec6), TOBN(0x4fe1356d, 0x6d51c245),
      TOBN(0x302b0a6d, 0xf25f1437), TOBN(0xef9519b3, 0xcd3a431b),
      TOBN(0x514a0879, 0x8e3404dd), TOBN(0x020bbea6, 0x3b139b22),
      TOBN(0x29024e08, 0x8a67cc74), TOBN(0xc4c6628b, 0x80dc1cd1),
      TOBN(0xc90fdaa2, 0x2168c234), TOBN(0xffffffff, 0xffffffff),
  };
  return get_params(ret, kWords);
}

BIGNUM *BN_get_rfc3526_prime_8192(BIGNUM *ret) {
  static const BN_ULONG kWords[] = {
      TOBN(0xffffffff, 0xffffffff), TOBN(0x60c980dd, 0x98edd3df),
      TOBN(0xc81f56e8, 0x80b96e71), TOBN(0x9e3050e2, 0x765694df),
      TOBN(0x9558e447, 0x5677e9aa), TOBN(0xc9190da6, 0xfc026e47),
      TOBN(0x889a002e, 0xd5ee382b), TOBN(0x4009438b, 0x481c6cd7),
      TOBN(0x359046f4, 0xeb879f92), TOBN(0xfaf36bc3, 0x1ecfa268),
      TOBN(0xb1d510bd, 0x7ee74d73), TOBN(0xf9ab4819, 0x5ded7ea1),
      TOBN(0x64f31cc5, 0x0846851d), TOBN(0x4597e899, 0xa0255dc1),
      TOBN(0xdf310ee0, 0x74ab6a36), TOBN(0x6d2a13f8, 0x3f44f82d),
      TOBN(0x062b3cf5, 0xb3a278a6), TOBN(0x79683303, 0xed5bdd3a),
      TOBN(0xfa9d4b7f, 0xa2c087e8), TOBN(0x4bcbc886, 0x2f8385dd),
      TOBN(0x3473fc64, 0x6cea306b), TOBN(0x13eb57a8, 0x1a23f0c7),
      TOBN(0x22222e04, 0xa4037c07), TOBN(0xe3fdb8be, 0xfc848ad9),
      TOBN(0x238f16cb, 0xe39d652d), TOBN(0x3423b474, 0x2bf1c978),
      TOBN(0x3aab639c, 0x5ae4f568), TOBN(0x2576f693, 0x6ba42466),
      TOBN(0x741fa7bf, 0x8afc47ed), TOBN(0x3bc832b6, 0x8d9dd300),
      TOBN(0xd8bec4d0, 0x73b931ba), TOBN(0x38777cb6, 0xa932df8c),
      TOBN(0x74a3926f, 0x12fee5e4), TOBN(0xe694f91e, 0x6dbe1159),
      TOBN(0x12bf2d5b, 0x0b7474d6), TOBN(0x043e8f66, 0x3f4860ee),
      TOBN(0x387fe8d7, 0x6e3c0468), TOBN(0xda56c9ec, 0x2ef29632),
      TOBN(0xeb19ccb1, 0xa313d55c), TOBN(0xf550aa3d, 0x8a1fbff0),
      TOBN(0x06a1d58b, 0xb7c5da76), TOBN(0xa79715ee, 0xf29be328),
      TOBN(0x14cc5ed2, 0x0f8037e0), TOBN(0xcc8f6d7e, 0xbf48e1d8),
      TOBN(0x4bd407b2, 0x2b4154aa), TOBN(0x0f1d45b7, 0xff585ac5),
      TOBN(0x23a97a7e, 0x36cc88be), TOBN(0x59e7c97f, 0xbec7e8f3),
      TOBN(0xb5a84031, 0x900b1c9e), TOBN(0xd55e702f, 0x46980c82),
      TOBN(0xf482d7ce, 0x6e74fef6), TOBN(0xf032ea15, 0xd1721d03),
      TOBN(0x5983ca01, 0xc64b92ec), TOBN(0x6fb8f401, 0x378cd2bf),
      TOBN(0x33205151, 0x2bd7af42), TOBN(0xdb7f1447, 0xe6cc254b),
      TOBN(0x44ce6cba, 0xced4bb1b), TOBN(0xda3edbeb, 0xcf9b14ed),
      TOBN(0x179727b0, 0x865a8918), TOBN(0xb06a53ed, 0x9027d831),
      TOBN(0xe5db382f, 0x413001ae), TOBN(0xf8ff9406, 0xad9e530e),
      TOBN(0xc9751e76, 0x3dba37bd), TOBN(0xc1d4dcb2, 0x602646de),
      TOBN(0x36c3fab4, 0xd27c7026), TOBN(0x4df435c9, 0x34028492),
      TOBN(0x86ffb7dc, 0x90a6c08f), TOBN(0x93b4ea98, 0x8d8fddc1),
      TOBN(0xd0069127, 0xd5b05aa9), TOBN(0xb81bdd76, 0x2170481c),
      TOBN(0x1f612970, 0xcee2d7af), TOBN(0x233ba186, 0x515be7ed),
      TOBN(0x99b2964f, 0xa090c3a2), TOBN(0x287c5947, 0x4e6bc05d),
      TOBN(0x2e8efc14, 0x1fbecaa6), TOBN(0xdbbbc2db, 0x04de8ef9),
      TOBN(0x2583e9ca, 0x2ad44ce8), TOBN(0x1a946834, 0xb6150bda),
      TOBN(0x99c32718, 0x6af4e23c), TOBN(0x88719a10, 0xbdba5b26),
      TOBN(0x1a723c12, 0xa787e6d7), TOBN(0x4b82d120, 0xa9210801),
      TOBN(0x43db5bfc, 0xe0fd108e), TOBN(0x08e24fa0, 0x74e5ab31),
      TOBN(0x770988c0, 0xbad946e2), TOBN(0xbbe11757, 0x7a615d6c),
      TOBN(0x521f2b18, 0x177b200c), TOBN(0xd8760273, 0x3ec86a64),
      TOBN(0xf12ffa06, 0xd98a0864), TOBN(0xcee3d226, 0x1ad2ee6b),
      TOBN(0x1e8c94e0, 0x4a25619d), TOBN(0xabf5ae8c, 0xdb0933d7),
      TOBN(0xb3970f85, 0xa6e1e4c7), TOBN(0x8aea7157, 0x5d060c7d),
      TOBN(0xecfb8504, 0x58dbef0a), TOBN(0xa85521ab, 0xdf1cba64),
      TOBN(0xad33170d, 0x04507a33), TOBN(0x15728e5a, 0x8aaac42d),
      TOBN(0x15d22618, 0x98fa0510), TOBN(0x3995497c, 0xea956ae5),
      TOBN(0xde2bcbf6, 0x95581718), TOBN(0xb5c55df0, 0x6f4c52c9),
      TOBN(0x9b2783a2, 0xec07a28f), TOBN(0xe39e772c, 0x180e8603),
      TOBN(0x32905e46, 0x2e36ce3b), TOBN(0xf1746c08, 0xca18217c),
      TOBN(0x670c354e, 0x4abc9804), TOBN(0x9ed52907, 0x7096966d),
      TOBN(0x1c62f356, 0x208552bb), TOBN(0x83655d23, 0xdca3ad96),
      TOBN(0x69163fa8, 0xfd24cf5f), TOBN(0x98da4836, 0x1c55d39a),
      TOBN(0xc2007cb8, 0xa163bf05), TOBN(0x49286651, 0xece45b3d),
      TOBN(0xae9f2411, 0x7c4b1fe6), TOBN(0xee386bfb, 0x5a899fa5),
      TOBN(0x0bff5cb6, 0xf406b7ed), TOBN(0xf44c42e9, 0xa637ed6b),
      TOBN(0xe485b576, 0x625e7ec6), TOBN(0x4fe1356d, 0x6d51c245),
      TOBN(0x302b0a6d, 0xf25f1437), TOBN(0xef9519b3, 0xcd3a431b),
      TOBN(0x514a0879, 0x8e3404dd), TOBN(0x020bbea6, 0x3b139b22),
      TOBN(0x29024e08, 0x8a67cc74), TOBN(0xc4c6628b, 0x80dc1cd1),
      TOBN(0xc90fdaa2, 0x2168c234), TOBN(0xffffffff, 0xffffffff),
  };
  return get_params(ret, kWords);
}

int DH_generate_parameters_ex(DH *dh, int prime_bits, int generator,
                              BN_GENCB *cb) {
  // We generate DH parameters as follows
  // find a prime q which is prime_bits/2 bits long.
  // p=(2*q)+1 or (p-1)/2 = q
  // For this case, g is a generator if
  // g^((p-1)/q) mod p != 1 for values of q which are the factors of p-1.
  // Since the factors of p-1 are q and 2, we just need to check
  // g^2 mod p != 1 and g^q mod p != 1.
  //
  // Having said all that,
  // there is another special case method for the generators 2, 3 and 5.
  // for 2, p mod 24 == 11
  // for 3, p mod 12 == 5  <<<<< does not work for safe primes.
  // for 5, p mod 10 == 3 or 7
  //
  // Thanks to Phil Karn <karn@qualcomm.com> for the pointers about the
  // special generators and for answering some of my questions.
  //
  // I've implemented the second simple method :-).
  // Since DH should be using a safe prime (both p and q are prime),
  // this generator function can take a very very long time to run.

  // Actually there is no reason to insist that 'generator' be a generator.
  // It's just as OK (and in some sense better) to use a generator of the
  // order-q subgroup.

  if (prime_bits <= 0 || prime_bits > OPENSSL_DH_MAX_MODULUS_BITS) {
    OPENSSL_PUT_ERROR(DH, DH_R_MODULUS_TOO_LARGE);
    return 0;
  }

  // Make sure |dh| has the necessary elements
  if (dh->p == nullptr) {
    dh->p = BN_new();
    if (dh->p == nullptr) {
      OPENSSL_PUT_ERROR(DH, ERR_R_BN_LIB);
      return 0;
    }
  }
  if (dh->g == nullptr) {
    dh->g = BN_new();
    if (dh->g == nullptr) {
      OPENSSL_PUT_ERROR(DH, ERR_R_BN_LIB);
      return 0;
    }
  }

  BN_ULONG t1, t2, g;
  if (generator <= 1) {
    OPENSSL_PUT_ERROR(DH, DH_R_BAD_GENERATOR);
    return 0;
  }
  if (generator == DH_GENERATOR_2) {
    t1 = 24;
    t2 = 11;
    g = 2;
  } else if (generator == DH_GENERATOR_5) {
    t1 = 10;
    t2 = 3;
    g = 5;
  } else {
    // In the general case, don't worry if 'generator' is a generator or not:
    // since we are using safe primes, it will generate either an order-q or an
    // order-2q group, which both is OK.
    t1 = 2;
    t2 = 1;
    g = generator;
  }

  bssl::UniquePtr<BIGNUM> t1_bn(BN_new()), t2_bn(BN_new());
  if (t1_bn == nullptr || t2_bn == nullptr ||
      !BN_set_word(t1_bn.get(), t1) ||  //
      !BN_set_word(t2_bn.get(), t2) ||  //
      !BN_generate_prime_ex(dh->p, prime_bits, 1, t1_bn.get(), t2_bn.get(),
                            cb) ||
      !BN_GENCB_call(cb, 3, 0) ||  //
      !BN_set_word(dh->g, g)) {
    OPENSSL_PUT_ERROR(DH, ERR_R_BN_LIB);
    return 0;
  }

  return 1;
}

static int int_dh_bn_cpy(BIGNUM **dst, const BIGNUM *src) {
  BIGNUM *a = nullptr;

  if (src) {
    a = BN_dup(src);
    if (!a) {
      return 0;
    }
  }

  BN_free(*dst);
  *dst = a;
  return 1;
}

static int int_dh_param_copy(DH *to, const DH *from, int is_x942) {
  if (is_x942 == -1) {
    is_x942 = !!from->q;
  }
  if (!int_dh_bn_cpy(&to->p, from->p) ||
      !int_dh_bn_cpy(&to->g, from->g)) {
    return 0;
  }

  if (!is_x942) {
    return 1;
  }

  if (!int_dh_bn_cpy(&to->q, from->q)) {
    return 0;
  }

  return 1;
}

DH *DHparams_dup(const DH *dh) {
  DH *ret = DH_new();
  if (!ret) {
    return nullptr;
  }

  if (!int_dh_param_copy(ret, dh, -1)) {
    DH_free(ret);
    return nullptr;
  }

  return ret;
}
