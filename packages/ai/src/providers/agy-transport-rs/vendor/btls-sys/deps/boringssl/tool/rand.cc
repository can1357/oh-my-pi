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

#include <string>
#include <vector>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include <openssl/rand.h>

#include "internal.h"


static const struct argument kArguments[] = {
    {
     "-hex", kBooleanArgument,
     "Hex encoded output."
    },
    {
     "", kOptionalArgument, "",
    },
};

bool Rand(const std::vector<std::string> &args) {
  bool forever = true, hex = false;
  size_t len = 0;

  if (!args.empty()) {
    std::vector<std::string> args_copy(args);
    const std::string &last_arg = args.back();

    if (!last_arg.empty() && last_arg[0] != '-') {
      char *endptr;
      unsigned long long num = strtoull(last_arg.c_str(), &endptr, 10);
      if (*endptr == 0) {
        len = num;
        forever = false;
        args_copy.pop_back();
      }
    }

    std::map<std::string, std::string> args_map;
    if (!ParseKeyValueArguments(&args_map, args_copy, kArguments)) {
      PrintUsage(kArguments);
      return false;
    }

    hex = args_map.count("-hex") > 0;
  }

  uint8_t buf[4096];
  uint8_t hex_buf[8192];

  size_t done = 0;
  while (forever || done < len) {
    size_t todo = sizeof(buf);
    if (!forever && todo > len - done) {
      todo = len - done;
    }
    RAND_bytes(buf, todo);
    if (hex) {
      static const char hextable[16 + 1] = "0123456789abcdef";
      for (unsigned i = 0; i < todo; i++) {
        hex_buf[i*2] = hextable[buf[i] >> 4];
        hex_buf[i*2 + 1] = hextable[buf[i] & 0xf];
      }
      if (fwrite(hex_buf, todo*2, 1, stdout) != 1) {
        return false;
      }
    } else {
      if (fwrite(buf, todo, 1, stdout) != 1) {
        return false;
      }
    }
    done += todo;
  }

  if (hex && fwrite("\n", 1, 1, stdout) != 1) {
    return false;
  }

  return true;
}
