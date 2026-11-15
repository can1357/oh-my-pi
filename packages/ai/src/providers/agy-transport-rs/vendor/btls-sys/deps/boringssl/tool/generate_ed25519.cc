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

#include <openssl/curve25519.h>

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "internal.h"


static const struct argument kArguments[] = {
    {
        "-out-public", kRequiredArgument, "The file to write the public key to",
    },
    {
        "-out-private", kRequiredArgument,
        "The file to write the private key to",
    },
    {
        "", kOptionalArgument, "",
    },
};

bool GenerateEd25519Key(const std::vector<std::string> &args) {
  std::map<std::string, std::string> args_map;

  if (!ParseKeyValueArguments(&args_map, args, kArguments)) {
    PrintUsage(kArguments);
    return false;
  }

  uint8_t public_key[32], private_key[64];
  ED25519_keypair(public_key, private_key);

  return WriteToFile(args_map["-out-public"], public_key) &&
         WriteToFile(args_map["-out-private"], private_key);
}
