// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/x509.h>

#include <assert.h>
#include <inttypes.h>
#include <string.h>

#include <openssl/asn1.h>
#include <openssl/bio.h>
#include <openssl/obj.h>


static int maybe_write(BIO *out, const void *buf, int len) {
  // If |out| is NULL, ignore the output but report the length.
  return out == nullptr || BIO_write(out, buf, len) == len;
}

// do_indent prints |indent| spaces to |out|.
static int do_indent(BIO *out, int indent) {
  for (int i = 0; i < indent; i++) {
    if (!maybe_write(out, " ", 1)) {
      return 0;
    }
  }
  return 1;
}

#define FN_WIDTH_LN 25
#define FN_WIDTH_SN 10

static int do_name_ex(BIO *out, const X509_NAME *n, int indent,
                      unsigned long flags) {
  int prev = -1, orflags;
  char objtmp[80];
  const char *objbuf;
  int outlen, len;
  const char *sep_dn, *sep_mv, *sep_eq;
  int sep_dn_len, sep_mv_len, sep_eq_len;
  if (indent < 0) {
    indent = 0;
  }
  outlen = indent;
  if (!do_indent(out, indent)) {
    return -1;
  }
  switch (flags & XN_FLAG_SEP_MASK) {
    case XN_FLAG_SEP_MULTILINE:
      sep_dn = "\n";
      sep_dn_len = 1;
      sep_mv = " + ";
      sep_mv_len = 3;
      break;

    case XN_FLAG_SEP_COMMA_PLUS:
      sep_dn = ",";
      sep_dn_len = 1;
      sep_mv = "+";
      sep_mv_len = 1;
      indent = 0;
      break;

    case XN_FLAG_SEP_CPLUS_SPC:
      sep_dn = ", ";
      sep_dn_len = 2;
      sep_mv = " + ";
      sep_mv_len = 3;
      indent = 0;
      break;

    case XN_FLAG_SEP_SPLUS_SPC:
      sep_dn = "; ";
      sep_dn_len = 2;
      sep_mv = " + ";
      sep_mv_len = 3;
      indent = 0;
      break;

    default:
      return -1;
  }

  if (flags & XN_FLAG_SPC_EQ) {
    sep_eq = " = ";
    sep_eq_len = 3;
  } else {
    sep_eq = "=";
    sep_eq_len = 1;
  }

  int cnt = X509_NAME_entry_count(n);
  for (int i = 0; i < cnt; i++) {
    const X509_NAME_ENTRY *ent;
    if (flags & XN_FLAG_DN_REV) {
      ent = X509_NAME_get_entry(n, cnt - i - 1);
    } else {
      ent = X509_NAME_get_entry(n, i);
    }
    if (prev != -1) {
      if (prev == X509_NAME_ENTRY_set(ent)) {
        if (!maybe_write(out, sep_mv, sep_mv_len)) {
          return -1;
        }
        outlen += sep_mv_len;
      } else {
        if (!maybe_write(out, sep_dn, sep_dn_len)) {
          return -1;
        }
        outlen += sep_dn_len;
        if (!do_indent(out, indent)) {
          return -1;
        }
        outlen += indent;
      }
    }
    prev = X509_NAME_ENTRY_set(ent);
    const ASN1_OBJECT *fn = X509_NAME_ENTRY_get_object(ent);
    const ASN1_STRING *val = X509_NAME_ENTRY_get_data(ent);
    assert((flags & XN_FLAG_FN_MASK) == XN_FLAG_FN_SN);
    int fn_nid = OBJ_obj2nid(fn);
    if (fn_nid == NID_undef) {
      OBJ_obj2txt(objtmp, sizeof(objtmp), fn, 1);
      objbuf = objtmp;
    } else {
      objbuf = OBJ_nid2sn(fn_nid);
    }
    int objlen = strlen(objbuf);
    if (!maybe_write(out, objbuf, objlen) ||
        !maybe_write(out, sep_eq, sep_eq_len)) {
      return -1;
    }
    outlen += objlen + sep_eq_len;
    // If the field name is unknown then fix up the DER dump flag. We
    // might want to limit this further so it will DER dump on anything
    // other than a few 'standard' fields.
    if ((fn_nid == NID_undef) && (flags & XN_FLAG_DUMP_UNKNOWN_FIELDS)) {
      orflags = ASN1_STRFLGS_DUMP_ALL;
    } else {
      orflags = 0;
    }

    len = ASN1_STRING_print_ex(out, val, flags | orflags);
    if (len < 0) {
      return -1;
    }
    outlen += len;
  }
  return outlen;
}

int X509_NAME_print_ex(BIO *out, const X509_NAME *nm, int indent,
                       unsigned long flags) {
  if (flags == XN_FLAG_COMPAT) {
    return X509_NAME_print(out, nm, indent);
  }
  return do_name_ex(out, nm, indent, flags);
}

int X509_NAME_print_ex_fp(FILE *fp, const X509_NAME *nm, int indent,
                          unsigned long flags) {
  BIO *bio = nullptr;
  if (fp != nullptr) {
    // If |fp| is NULL, this function returns the number of bytes without
    // writing.
    bio = BIO_new_fp(fp, BIO_NOCLOSE);
    if (bio == nullptr) {
      return -1;
    }
  }
  int ret = X509_NAME_print_ex(bio, nm, indent, flags);
  BIO_free(bio);
  return ret;
}
