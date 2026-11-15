// Copyright 2021 The BoringSSL Authors
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

#include <algorithm>
#include <string>
#include <vector>
#include <map>

#include <openssl/bio.h>
#include <openssl/conf.h>

#include <gtest/gtest.h>

#include "internal.h"


// A |CONF| is an unordered list of sections, where each section contains an
// ordered list of (name, value) pairs.
using ConfModel =
    std::map<std::string, std::vector<std::pair<std::string, std::string>>>;

static void ExpectConfEquals(const CONF *conf, const ConfModel &model) {
  // There is always a default section, even if empty. This is an easy mistake
  // to make in test data, so test for it.
  EXPECT_NE(model.find("default"), model.end())
      << "Model does not have a default section";

  size_t total_values = 0;
  for (const auto &pair : model) {
    const std::string &section = pair.first;
    SCOPED_TRACE(section);

    const STACK_OF(CONF_VALUE) *values =
        NCONF_get_section(conf, section.c_str());
    ASSERT_TRUE(values);
    total_values += pair.second.size();

    EXPECT_EQ(sk_CONF_VALUE_num(values), pair.second.size());

    // If the lengths do not match, still compare up to the smaller of the two,
    // to aid debugging.
    size_t min_len = std::min(sk_CONF_VALUE_num(values), pair.second.size());
    for (size_t i = 0; i < min_len; i++) {
      SCOPED_TRACE(i);
      const std::string &name = pair.second[i].first;
      const std::string &value = pair.second[i].second;

      const CONF_VALUE *v = sk_CONF_VALUE_value(values, i);
      EXPECT_EQ(v->section, section);
      EXPECT_EQ(v->name, name);
      EXPECT_EQ(v->value, value);

      const char *str = NCONF_get_string(conf, section.c_str(), name.c_str());
      ASSERT_NE(str, nullptr);
      EXPECT_EQ(str, value);

      if (section == "default") {
        // nullptr is interpreted as the default section.
        str = NCONF_get_string(conf, nullptr, name.c_str());
        ASSERT_NE(str, nullptr);
        EXPECT_EQ(str, value);
      }
    }
  }

  // Unrecognized sections must return nullptr.
  EXPECT_EQ(NCONF_get_section(conf, "must_not_appear_in_tests"), nullptr);
  EXPECT_EQ(NCONF_get_string(conf, "must_not_appear_in_tests",
                             "must_not_appear_in_tests"),
            nullptr);
  if (!model.empty()) {
    // Valid section, invalid name.
    EXPECT_EQ(NCONF_get_string(conf, model.begin()->first.c_str(),
                               "must_not_appear_in_tests"),
              nullptr);
    if (!model.begin()->second.empty()) {
      // Invalid section, valid name.
      EXPECT_EQ(NCONF_get_string(conf, "must_not_appear_in_tests",
                                 model.begin()->second.front().first.c_str()),
                nullptr);
    }
  }

  // There should not be any other values in |conf|. |conf| currently stores
  // both sections and values in the same map.
  EXPECT_EQ(lh_CONF_SECTION_num_items(conf->sections), model.size());
  EXPECT_EQ(lh_CONF_VALUE_num_items(conf->values), total_values);
}

TEST(ConfTest, Parse) {
  const struct {
    std::string in;
    ConfModel model;
  } kTests[] = {
      // Test basic parsing.
      {
          R"(# Comment

key=value

[section_name]
key=value2
)",
          {
              {"default", {{"key", "value"}}},
              {"section_name", {{"key", "value2"}}},
          },
      },

      // If a section is listed multiple times, keys add to the existing one.
      {
          R"(key1 = value1

[section1]
key2 = value2

[section2]
key3 = value3

[default]
key4 = value4

[section1]
key5 = value5
)",
          {
              {"default", {{"key1", "value1"}, {"key4", "value4"}}},
              {"section1", {{"key2", "value2"}, {"key5", "value5"}}},
              {"section2", {{"key3", "value3"}}},
          },
      },

      // Although the CONF parser internally uses a buffer size of 512 bytes to
      // read one line, it detects truncation and is able to parse long lines.
      {
          std::string(1000, 'a') + " = " + std::string(1000, 'b') + "\n",
          {
              {"default", {{std::string(1000, 'a'), std::string(1000, 'b')}}},
          },
      },

      // Trailing backslashes are line continations.
      {
          "key=\\\nvalue\nkey2=foo\\\nbar=baz",
          {
              {"default", {{"key", "value"}, {"key2", "foobar=baz"}}},
          },
      },

      // To be a line continuation, it must be at the end of the line.
      {
          "key=\\\nvalue\nkey2=foo\\ \nbar=baz",
          {
              {"default", {{"key", "value"}, {"key2", "foo"}, {"bar", "baz"}}},
          },
      },

      // A line continuation without any following line is ignored.
      {
          "key=value\\",
          {
              {"default", {{"key", "value"}}},
          },
      },

      // Values may have embedded whitespace, but leading and trailing
      // whitespace is dropped.
      {
          "key =  \t  foo   \t\t\tbar  \t  ",
          {
              {"default", {{"key", "foo   \t\t\tbar"}}},
          },
      },

      // Empty sections still end up in the file.
      {
          "[section1]\n[section2]\n[section3]\n",
          {
              {"default", {}},
              {"section1", {}},
              {"section2", {}},
              {"section3", {}},
          },
      },

      // Section names can contain spaces and punctuation.
      {
          "[This! Is. A? Section;]\nkey = value",
          {
              {"default", {}},
              {"This! Is. A? Section;", {{"key", "value"}}},
          },
      },

      // Trailing data after a section line is ignored.
      {
          "[section] key = value\nkey2 = value2\n",
          {
              {"default", {}},
              {"section", {{"key2", "value2"}}},
          },
      },

      // Comments may appear within a line. Escapes and quotes, however,
      // suppress the comment character.
      {
          R"(
key1 = # comment
key2 = "# not a comment"
key3 = '# not a comment'
key4 = `# not a comment`
key5 = \# not a comment
)",
          {
              {"default",
               {
                   {"key1", ""},
                   {"key2", "# not a comment"},
                   {"key3", "# not a comment"},
                   {"key4", "# not a comment"},
                   {"key5", "# not a comment"},
               }},
          },
      },

      // Quotes may appear in the middle of a string. Inside quotes, escape
      // sequences like \n are not evaluated. \X always evaluates to X.
      {
          R"(
key1 = mix "of" 'different' `quotes`
key2 = "`'"
key3 = "\r\n\b\t\""
key4 = '\r\n\b\t\''
key5 = `\r\n\b\t\``
)",
          {
              {"default",
               {
                   {"key1", "mix of different quotes"},
                   {"key2", "`'"},
                   {"key3", "rnbt\""},
                   {"key4", "rnbt'"},
                   {"key5", "rnbt`"},
               }},
          },
      },

      // Outside quotes, escape sequences like \n are evaluated. Unknown escapes
      // turn into the character.
      {
          R"(
key = \r\n\b\t\"\'\`\z
)",
          {
              {"default",
               {
                   {"key", "\r\n\b\t\"'`z"},
               }},
          },
      },

      // Escapes (but not quoting) work inside section names.
      {
          "[section\\ name]\nkey = value\n",
          {
              {"default", {}},
              {"section name", {{"key", "value"}}},
          },
      },

      // Escapes (but not quoting) are skipped over in key names, but they are
      // left unevaluated. This is probably a bug.
      {
          "key\\ name = value\n",
          {
              {"default", {{"key\\ name", "value"}}},
          },
      },

      // Keys can specify sections explicitly with ::.
      {
          R"(
[section1]
default::key1 = value1
section1::key2 = value2
section2::key3 = value3
section1::key4 = value4
section2::key5 = value5
default::key6 = value6
key7 = value7  # section1
)",
          {
              {"default", {{"key1", "value1"}, {"key6", "value6"}}},
              {"section1",
               {{"key2", "value2"}, {"key4", "value4"}, {"key7", "value7"}}},
              {"section2", {{"key3", "value3"}, {"key5", "value5"}}},
          },
      },

      // Punctuation is allowed in key names.
      {
          "key!%&*+,-./;?@^_|~1 = value\n",
          {
              {"default", {{"key!%&*+,-./;?@^_|~1", "value"}}},
          },
      },

      // Only the first equals counts as a key/value separator.
      {
          "key======",
          {
              {"default", {{"key", "====="}}},
          },
      },

      // Empty keys and empty values are allowed.
      {
          R"(
[both_empty]
=
[empty_key]
=value
[empty_value]
key=
[equals]
======
[]
empty=section
)",
          {
              {"default", {}},
              {"both_empty", {{"", ""}}},
              {"empty_key", {{"", "value"}}},
              {"empty_value", {{"key", ""}}},
              {"equals", {{"", "====="}}},
              {"", {{"empty", "section"}}},
          },
      },

      // After the first equals, the value can freely contain more equals.
      {
          "key1 = \\$value1\nkey2 = \"$value2\"",
          {
              {"default", {{"key1", "$value1"}, {"key2", "$value2"}}},
          },
      },

      // Non-ASCII bytes are allowed in values.
      {
          "key = \xe2\x98\x83",
          {
              {"default", {{"key", "\xe2\x98\x83"}}},
          },
      },

      // An escaped backslash is not a line continuation.
      {
          R"(
key1 = value1\\
key2 = value2
)",
          {
              {"default", {{"key1", "value1\\"}, {"key2", "value2"}}},
          },
      },

      // An unterminated escape sequence at the end of a line is silently
      // ignored. Normally, this would be a line continuation, but the line
      // continuation logic does not count backslashes and only looks at the
      // last two characters. This is probably a bug.
      {
          R"(
key1 = value1\\\
key2 = value2
)",
          {
              {"default", {{"key1", "value1\\"}, {"key2", "value2"}}},
          },
      },

      // The above also happens inside a quoted string, even allowing the quoted
      // string to be unterminated. This is also probably a bug.
      {
          R"(
key1 = "value1\\\
key2 = value2
)",
          {
              {"default", {{"key1", "value1\\"}, {"key2", "value2"}}},
          },
      },
  };
  for (const auto &t : kTests) {
    SCOPED_TRACE(t.in);
    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(t.in.data(), t.in.size()));
    ASSERT_TRUE(bio);
    bssl::UniquePtr<CONF> conf(NCONF_new(nullptr));
    ASSERT_TRUE(conf);
    ASSERT_TRUE(NCONF_load_bio(conf.get(), bio.get(), nullptr));

    ExpectConfEquals(conf.get(), t.model);
  }

  const char *kInvalidTests[] = {
      // Missing equals sign.
      "key",
      // Unterminated section heading.
      "[section",
      // Section names can only contain alphanumeric characters, punctuation,
      // and escapes. Quotes are not punctuation.
      "[\"section\"]",
      // Keys can only contain alphanumeric characters, punctuaion, and escapes.
      "key name = value",
      "\"key\" = value",
      // Variable references have been removed.
      "key1 = value1\nkey2 = $key1",
  };
  for (const auto &t : kInvalidTests) {
    SCOPED_TRACE(t);
    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(t, strlen(t)));
    ASSERT_TRUE(bio);
    bssl::UniquePtr<CONF> conf(NCONF_new(nullptr));
    ASSERT_TRUE(conf);
    EXPECT_FALSE(NCONF_load_bio(conf.get(), bio.get(), nullptr));
  }
}

TEST(ConfTest, ParseList) {
  const struct {
    const char *list;
    char sep;
    bool remove_whitespace;
    std::vector<std::string> expected;
  } kTests[] = {
      {"", ',', /*remove_whitespace=*/0, {""}},
      {"", ',', /*remove_whitespace=*/1, {""}},

      {" ", ',', /*remove_whitespace=*/0, {" "}},
      {" ", ',', /*remove_whitespace=*/1, {""}},

      {"hello world", ',', /*remove_whitespace=*/0, {"hello world"}},
      {"hello world", ',', /*remove_whitespace=*/1, {"hello world"}},

      {" hello world ", ',', /*remove_whitespace=*/0, {" hello world "}},
      {" hello world ", ',', /*remove_whitespace=*/1, {"hello world"}},

      {"hello,world", ',', /*remove_whitespace=*/0, {"hello", "world"}},
      {"hello,world", ',', /*remove_whitespace=*/1, {"hello", "world"}},

      {"hello,,world", ',', /*remove_whitespace=*/0, {"hello", "", "world"}},
      {"hello,,world", ',', /*remove_whitespace=*/1, {"hello", "", "world"}},

      {"\tab cd , , ef gh ",
       ',',
       /*remove_whitespace=*/0,
       {"\tab cd ", " ", " ef gh "}},
      {"\tab cd , , ef gh ",
       ',',
       /*remove_whitespace=*/1,
       {"ab cd", "", "ef gh"}},
  };
  for (const auto& t : kTests) {
    SCOPED_TRACE(t.list);
    SCOPED_TRACE(t.sep);
    SCOPED_TRACE(t.remove_whitespace);

    std::vector<std::string> result;
    auto append_to_vector = [](const char *elem, size_t len, void *arg) -> int {
      auto *vec = static_cast<std::vector<std::string> *>(arg);
      vec->push_back(std::string(elem, len));
      return 1;
    };
    ASSERT_TRUE(CONF_parse_list(t.list, t.sep, t.remove_whitespace,
                                append_to_vector, &result));
    EXPECT_EQ(result, t.expected);
  }
}
