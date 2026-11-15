// Copyright 2014 The BoringSSL Authors
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

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"


bool ParseKeyValueArguments(std::map<std::string, std::string> *out_args,
                            const std::vector<std::string> &args,
                            const struct argument *templates) {
  out_args->clear();

  for (size_t i = 0; i < args.size(); i++) {
    const std::string &arg = args[i];
    const struct argument *templ = nullptr;
    for (size_t j = 0; templates[j].name[0] != 0; j++) {
      if (strcmp(arg.c_str(), templates[j].name) == 0) {
        templ = &templates[j];
        break;
      }
    }

    if (templ == nullptr) {
      fprintf(stderr, "Unknown argument: %s\n", arg.c_str());
      return false;
    }

    if (out_args->find(arg) != out_args->end()) {
      fprintf(stderr, "Duplicate argument: %s\n", arg.c_str());
      return false;
    }

    if (templ->type == kBooleanArgument) {
      (*out_args)[arg] = "";
    } else {
      if (i + 1 >= args.size()) {
        fprintf(stderr, "Missing argument for option: %s\n", arg.c_str());
        return false;
      }
      (*out_args)[arg] = args[++i];
    }
  }

  for (size_t j = 0; templates[j].name[0] != 0; j++) {
    const struct argument *templ = &templates[j];
    if (templ->type == kRequiredArgument &&
        out_args->find(templ->name) == out_args->end()) {
      fprintf(stderr, "Missing value for required argument: %s\n", templ->name);
      return false;
    }
  }

  return true;
}

void PrintUsage(const struct argument *templates) {
  for (size_t i = 0; templates[i].name[0] != 0; i++) {
    const struct argument *templ = &templates[i];
    fprintf(stderr, "%s\t%s\n", templ->name, templ->description);
  }
}

bool GetUnsigned(unsigned *out, const std::string &arg_name,
                 unsigned default_value,
                 const std::map<std::string, std::string> &args) {
  const auto &it = args.find(arg_name);
  if (it == args.end()) {
    *out = default_value;
    return true;
  }

  const std::string &value = it->second;
  if (value.empty()) {
    return false;
  }

  errno = 0;
  char *endptr;
  unsigned long int num = strtoul(value.c_str(), &endptr, 10);
  if (num == ULONG_MAX && errno == ERANGE) {
    return false;
  }
  if (*endptr != 0 || num > UINT_MAX) {
    return false;
  }
  *out = static_cast<unsigned>(num);

  return true;
}
