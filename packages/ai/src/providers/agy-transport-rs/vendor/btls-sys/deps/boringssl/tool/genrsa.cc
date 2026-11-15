// Copyright 2015 The BoringSSL Authors
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

#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>

#include "internal.h"


static const struct argument kArguments[] = {
    {
     "-bits", kOptionalArgument,
     "The number of bits in the modulus (default: 2048)",
    },
    {
     "", kOptionalArgument, "",
    },
};

bool GenerateRSAKey(const std::vector<std::string> &args) {
  std::map<std::string, std::string> args_map;

  if (!ParseKeyValueArguments(&args_map, args, kArguments)) {
    PrintUsage(kArguments);
    return false;
  }

  unsigned bits;
  if (!GetUnsigned(&bits, "-bits", 2048, args_map)) {
    PrintUsage(kArguments);
    return false;
  }

  bssl::UniquePtr<RSA> rsa(RSA_new());
  bssl::UniquePtr<BIGNUM> e(BN_new());
  bssl::UniquePtr<BIO> bio(BIO_new_fp(stdout, BIO_NOCLOSE));

  if (!BN_set_word(e.get(), RSA_F4) ||
      !RSA_generate_key_ex(rsa.get(), bits, e.get(), NULL) ||
      !PEM_write_bio_RSAPrivateKey(bio.get(), rsa.get(), NULL /* cipher */,
                                   NULL /* key */, 0 /* key len */,
                                   NULL /* password callback */,
                                   NULL /* callback arg */)) {
    ERR_print_errors_fp(stderr);
    return false;
  }

  return true;
}
