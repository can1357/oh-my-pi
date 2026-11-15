// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/conf.h>

#include <assert.h>
#include <ctype.h>
#include <string.h>

#include <openssl/bio.h>
#include <openssl/buf.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "internal.h"


struct conf_section_st {
  char *name;
  // values contains non-owning pointers to the values in the section.
  STACK_OF(CONF_VALUE) *values;
};

static const char kDefaultSectionName[] = "default";

static uint32_t conf_section_hash(const CONF_SECTION *s) {
  return OPENSSL_strhash(s->name);
}

static int conf_section_cmp(const CONF_SECTION *a, const CONF_SECTION *b) {
  return strcmp(a->name, b->name);
}

static uint32_t conf_value_hash(const CONF_VALUE *v) {
  const uint32_t section_hash = OPENSSL_strhash(v->section);
  const uint32_t name_hash = OPENSSL_strhash(v->name);
  return (section_hash << 2) ^ name_hash;
}

static int conf_value_cmp(const CONF_VALUE *a, const CONF_VALUE *b) {
  int cmp = strcmp(a->section, b->section);
  if (cmp != 0) {
    return cmp;
  }

  return strcmp(a->name, b->name);
}

CONF *NCONF_new(void *method) {
  if (method != nullptr) {
    return nullptr;
  }

  CONF *conf = reinterpret_cast<CONF *>(OPENSSL_malloc(sizeof(CONF)));
  if (conf == nullptr) {
    return nullptr;
  }

  conf->sections = lh_CONF_SECTION_new(conf_section_hash, conf_section_cmp);
  conf->values = lh_CONF_VALUE_new(conf_value_hash, conf_value_cmp);
  if (conf->sections == nullptr || conf->values == nullptr) {
    NCONF_free(conf);
    return nullptr;
  }

  return conf;
}

CONF_VALUE *CONF_VALUE_new(void) {
  return reinterpret_cast<CONF_VALUE *>(OPENSSL_zalloc(sizeof(CONF_VALUE)));
}

static void value_free(CONF_VALUE *value) {
  if (value == nullptr) {
    return;
  }
  OPENSSL_free(value->section);
  OPENSSL_free(value->name);
  OPENSSL_free(value->value);
  OPENSSL_free(value);
}

static void section_free(CONF_SECTION *section) {
  if (section == nullptr) {
    return;
  }
  OPENSSL_free(section->name);
  sk_CONF_VALUE_free(section->values);
  OPENSSL_free(section);
}

static void value_free_arg(CONF_VALUE *value, void *arg) { value_free(value); }

static void section_free_arg(CONF_SECTION *section, void *arg) {
  section_free(section);
}

void NCONF_free(CONF *conf) {
  if (conf == nullptr) {
    return;
  }

  lh_CONF_SECTION_doall_arg(conf->sections, section_free_arg, nullptr);
  lh_CONF_SECTION_free(conf->sections);
  lh_CONF_VALUE_doall_arg(conf->values, value_free_arg, nullptr);
  lh_CONF_VALUE_free(conf->values);
  OPENSSL_free(conf);
}

static CONF_SECTION *NCONF_new_section(const CONF *conf, const char *section) {
  CONF_SECTION *s =
      reinterpret_cast<CONF_SECTION *>(OPENSSL_malloc(sizeof(CONF_SECTION)));
  if (!s) {
    return nullptr;
  }
  s->name = OPENSSL_strdup(section);
  s->values = sk_CONF_VALUE_new_null();
  if (s->name == nullptr || s->values == nullptr) {
    goto err;
  }

  CONF_SECTION *old_section;
  if (!lh_CONF_SECTION_insert(conf->sections, &old_section, s)) {
    goto err;
  }
  section_free(old_section);
  return s;

err:
  section_free(s);
  return nullptr;
}

static int is_comment(char c) { return c == '#'; }

static int is_quote(char c) { return c == '"' || c == '\'' || c == '`'; }

static int is_esc(char c) { return c == '\\'; }

static int is_conf_ws(char c) {
  // This differs from |OPENSSL_isspace| in that CONF does not accept '\v' and
  // '\f' as whitespace.
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static int is_name_char(char c) {
  // Alphanumeric characters, and a handful of symbols, may appear in value and
  // section names without escaping.
  return OPENSSL_isalnum(c) || c == '_' || c == '!' || c == '.' || c == '%' ||
         c == '&' || c == '*' || c == '+' || c == ',' || c == '/' || c == ';' ||
         c == '?' || c == '@' || c == '^' || c == '~' || c == '|' || c == '-';
}

static int str_copy(CONF *conf, char *section, char **pto, char *from) {
  int q, to = 0, len = 0;
  char v;
  BUF_MEM *buf;

  buf = BUF_MEM_new();
  if (buf == nullptr) {
    return 0;
  }

  len = strlen(from) + 1;
  if (!BUF_MEM_grow(buf, len)) {
    goto err;
  }

  for (;;) {
    if (is_quote(*from)) {
      q = *from;
      from++;
      while (*from != '\0' && *from != q) {
        if (is_esc(*from)) {
          from++;
          if (*from == '\0') {
            break;
          }
        }
        buf->data[to++] = *(from++);
      }
      if (*from == q) {
        from++;
      }
    } else if (is_esc(*from)) {
      from++;
      v = *(from++);
      if (v == '\0') {
        break;
      } else if (v == 'r') {
        v = '\r';
      } else if (v == 'n') {
        v = '\n';
      } else if (v == 'b') {
        v = '\b';
      } else if (v == 't') {
        v = '\t';
      }
      buf->data[to++] = v;
    } else if (*from == '\0') {
      break;
    } else if (*from == '$') {
      // Historically, $foo would expand to a previously-parsed value. This
      // feature has been removed as it was unused and is a DoS vector. If
      // trying to embed '$' in a line, either escape it or wrap the value in
      // quotes.
      OPENSSL_PUT_ERROR(CONF, CONF_R_VARIABLE_EXPANSION_NOT_SUPPORTED);
      goto err;
    } else {
      buf->data[to++] = *(from++);
    }
  }

  buf->data[to] = '\0';
  OPENSSL_free(*pto);
  *pto = buf->data;
  OPENSSL_free(buf);
  return 1;

err:
  BUF_MEM_free(buf);
  return 0;
}

static CONF_SECTION *get_section(const CONF *conf, const char *section) {
  CONF_SECTION templ;
  OPENSSL_memset(&templ, 0, sizeof(templ));
  templ.name = (char *)section;
  return lh_CONF_SECTION_retrieve(conf->sections, &templ);
}

const STACK_OF(CONF_VALUE) *NCONF_get_section(const CONF *conf,
                                              const char *section) {
  const CONF_SECTION *section_obj = get_section(conf, section);
  if (section_obj == nullptr) {
    return nullptr;
  }
  return section_obj->values;
}

const char *NCONF_get_string(const CONF *conf, const char *section,
                             const char *name) {
  CONF_VALUE templ, *value;

  if (section == nullptr) {
    section = kDefaultSectionName;
  }

  OPENSSL_memset(&templ, 0, sizeof(templ));
  templ.section = (char *)section;
  templ.name = (char *)name;
  value = lh_CONF_VALUE_retrieve(conf->values, &templ);
  if (value == nullptr) {
    return nullptr;
  }
  return value->value;
}

static int add_string(const CONF *conf, CONF_SECTION *section,
                      CONF_VALUE *value) {
  value->section = OPENSSL_strdup(section->name);
  if (value->section == nullptr) {
    return 0;
  }

  if (!sk_CONF_VALUE_push(section->values, value)) {
    return 0;
  }

  CONF_VALUE *old_value;
  if (!lh_CONF_VALUE_insert(conf->values, &old_value, value)) {
    // Remove |value| from |section->values|, so we do not leave a dangling
    // pointer.
    sk_CONF_VALUE_pop(section->values);
    return 0;
  }
  if (old_value != nullptr) {
    (void)sk_CONF_VALUE_delete_ptr(section->values, old_value);
    value_free(old_value);
  }

  return 1;
}

static char *eat_ws(char *p) {
  while (*p != '\0' && is_conf_ws(*p)) {
    p++;
  }
  return p;
}

static char *scan_esc(char *p) {
  assert(p[0] == '\\');
  return p[1] == '\0' ? p + 1 : p + 2;
}

static char *eat_name(char *p) {
  for (;;) {
    if (is_esc(*p)) {
      p = scan_esc(p);
      continue;
    }
    if (!is_name_char(*p)) {
      return p;
    }
    p++;
  }
}

static char *scan_quote(char *p) {
  int q = *p;

  p++;
  while (*p != '\0' && *p != q) {
    if (is_esc(*p)) {
      p++;
      if (*p == '\0') {
        return p;
      }
    }
    p++;
  }
  if (*p == q) {
    p++;
  }
  return p;
}

static void clear_comments(char *p) {
  for (;;) {
    if (!is_conf_ws(*p)) {
      break;
    }
    p++;
  }

  for (;;) {
    if (is_comment(*p)) {
      *p = '\0';
      return;
    }
    if (is_quote(*p)) {
      p = scan_quote(p);
      continue;
    }
    if (is_esc(*p)) {
      p = scan_esc(p);
      continue;
    }
    if (*p == '\0') {
      return;
    } else {
      p++;
    }
  }
}

int NCONF_load_bio(CONF *conf, BIO *in, long *out_error_line) {
  static const size_t CONFBUFSIZE = 512;
  int bufnum = 0, i, ii;
  BUF_MEM *buff = nullptr;
  char *s, *p, *end;
  int again;
  long eline = 0;
  CONF_VALUE *v = nullptr;
  CONF_SECTION *sv = nullptr;
  char *section = nullptr, *buf;
  char *start, *psection, *pname;

  if ((buff = BUF_MEM_new()) == nullptr) {
    OPENSSL_PUT_ERROR(CONF, ERR_R_BUF_LIB);
    goto err;
  }

  section = OPENSSL_strdup(kDefaultSectionName);
  if (section == nullptr) {
    goto err;
  }

  sv = NCONF_new_section(conf, section);
  if (sv == nullptr) {
    OPENSSL_PUT_ERROR(CONF, CONF_R_UNABLE_TO_CREATE_NEW_SECTION);
    goto err;
  }

  bufnum = 0;
  again = 0;
  for (;;) {
    if (!BUF_MEM_grow(buff, bufnum + CONFBUFSIZE)) {
      OPENSSL_PUT_ERROR(CONF, ERR_R_BUF_LIB);
      goto err;
    }
    p = &(buff->data[bufnum]);
    *p = '\0';
    BIO_gets(in, p, CONFBUFSIZE - 1);
    p[CONFBUFSIZE - 1] = '\0';
    ii = i = strlen(p);
    if (i == 0 && !again) {
      break;
    }
    again = 0;
    while (i > 0) {
      if ((p[i - 1] != '\r') && (p[i - 1] != '\n')) {
        break;
      } else {
        i--;
      }
    }
    // we removed some trailing stuff so there is a new
    // line on the end.
    if (ii && i == ii) {
      again = 1;  // long line
    } else {
      p[i] = '\0';
      eline++;  // another input line
    }

    // we now have a line with trailing \r\n removed

    // i is the number of bytes
    bufnum += i;

    v = nullptr;
    // check for line continuation
    if (bufnum >= 1) {
      // If we have bytes and the last char '\\' and
      // second last char is not '\\'
      p = &(buff->data[bufnum - 1]);
      if (is_esc(p[0]) && ((bufnum <= 1) || !is_esc(p[-1]))) {
        bufnum--;
        again = 1;
      }
    }
    if (again) {
      continue;
    }
    bufnum = 0;
    buf = buff->data;

    clear_comments(buf);
    s = eat_ws(buf);
    if (*s == '\0') {
      continue;  // blank line
    }
    if (*s == '[') {
      char *ss;

      s++;
      start = eat_ws(s);
      ss = start;
    again:
      end = eat_name(ss);
      p = eat_ws(end);
      if (*p != ']') {
        if (*p != '\0' && ss != p) {
          ss = p;
          goto again;
        }
        OPENSSL_PUT_ERROR(CONF, CONF_R_MISSING_CLOSE_SQUARE_BRACKET);
        goto err;
      }
      *end = '\0';
      if (!str_copy(conf, nullptr, &section, start)) {
        goto err;
      }
      if ((sv = get_section(conf, section)) == nullptr) {
        sv = NCONF_new_section(conf, section);
      }
      if (sv == nullptr) {
        OPENSSL_PUT_ERROR(CONF, CONF_R_UNABLE_TO_CREATE_NEW_SECTION);
        goto err;
      }
      continue;
    } else {
      pname = s;
      psection = nullptr;
      end = eat_name(s);
      if ((end[0] == ':') && (end[1] == ':')) {
        *end = '\0';
        end += 2;
        psection = pname;
        pname = end;
        end = eat_name(end);
      }
      p = eat_ws(end);
      if (*p != '=') {
        OPENSSL_PUT_ERROR(CONF, CONF_R_MISSING_EQUAL_SIGN);
        goto err;
      }
      *end = '\0';
      p++;
      start = eat_ws(p);
      while (*p != '\0') {
        p++;
      }
      p--;
      while (p != start && is_conf_ws(*p)) {
        p--;
      }
      p++;
      *p = '\0';

      if (!(v = CONF_VALUE_new())) {
        goto err;
      }
      if (psection == nullptr) {
        psection = section;
      }
      v->name = OPENSSL_strdup(pname);
      if (v->name == nullptr) {
        goto err;
      }
      if (!str_copy(conf, psection, &(v->value), start)) {
        goto err;
      }

      CONF_SECTION *tv;
      if (strcmp(psection, section) != 0) {
        if ((tv = get_section(conf, psection)) == nullptr) {
          tv = NCONF_new_section(conf, psection);
        }
        if (tv == nullptr) {
          OPENSSL_PUT_ERROR(CONF, CONF_R_UNABLE_TO_CREATE_NEW_SECTION);
          goto err;
        }
      } else {
        tv = sv;
      }
      if (add_string(conf, tv, v) == 0) {
        goto err;
      }
      v = nullptr;
    }
  }
  BUF_MEM_free(buff);
  OPENSSL_free(section);
  return 1;

err:
  BUF_MEM_free(buff);
  OPENSSL_free(section);
  if (out_error_line != nullptr) {
    *out_error_line = eline;
  }
  ERR_add_error_dataf("line %ld", eline);
  value_free(v);
  return 0;
}

int NCONF_load(CONF *conf, const char *filename, long *out_error_line) {
  BIO *in = BIO_new_file(filename, "rb");
  int ret;

  if (in == nullptr) {
    OPENSSL_PUT_ERROR(CONF, ERR_R_SYS_LIB);
    return 0;
  }

  ret = NCONF_load_bio(conf, in, out_error_line);
  BIO_free(in);

  return ret;
}

int CONF_parse_list(const char *list, char sep, int remove_whitespace,
                    int (*list_cb)(const char *elem, size_t len, void *usr),
                    void *arg) {
  int ret;
  const char *lstart, *tmpend, *p;

  if (list == nullptr) {
    OPENSSL_PUT_ERROR(CONF, CONF_R_LIST_CANNOT_BE_NULL);
    return 0;
  }

  lstart = list;
  for (;;) {
    if (remove_whitespace) {
      while (*lstart && OPENSSL_isspace((unsigned char)*lstart)) {
        lstart++;
      }
    }
    p = strchr(lstart, sep);
    if (p == lstart || !*lstart) {
      ret = list_cb(nullptr, 0, arg);
    } else {
      if (p) {
        tmpend = p - 1;
      } else {
        tmpend = lstart + strlen(lstart) - 1;
      }
      if (remove_whitespace) {
        while (OPENSSL_isspace((unsigned char)*tmpend)) {
          tmpend--;
        }
      }
      ret = list_cb(lstart, tmpend - lstart + 1, arg);
    }
    if (ret <= 0) {
      return ret;
    }
    if (p == nullptr) {
      return 1;
    }
    lstart = p + 1;
  }
}

int CONF_modules_load_file(const char *filename, const char *appname,
                           unsigned long flags) {
  return 1;
}

void CONF_modules_unload(int all) {}

void CONF_modules_free(void) {}

void OPENSSL_config(const char *config_name) {}

void OPENSSL_no_config(void) {}
