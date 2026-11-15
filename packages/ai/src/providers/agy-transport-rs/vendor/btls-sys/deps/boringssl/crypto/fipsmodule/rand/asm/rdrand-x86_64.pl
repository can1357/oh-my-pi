#!/usr/bin/env perl

# Copyright 2015 The BoringSSL Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

use strict;

my $flavour = shift;
my $output  = shift;
if ($flavour =~ /\./) { $output = $flavour; undef $flavour; }

my $win64 = 0;
$win64 = 1 if ($flavour =~ /[nm]asm|mingw64/ || $output =~ /\.asm$/);

$0 =~ m/(.*[\/\\])[^\/\\]+$/;
my $dir = $1;
my $xlate;
( $xlate="${dir}../../../perlasm/x86_64-xlate.pl" and -f $xlate) or
die "can't locate x86_64-xlate.pl";

open OUT,"| \"$^X\" \"$xlate\" $flavour \"$output\"";
*STDOUT=*OUT;

my ($out, $len, $tmp1, $tmp2) = $win64 ? ("%rcx", "%rdx", "%r8", "%r9")
                                       : ("%rdi", "%rsi", "%rdx", "%rcx");

print<<___;
.text

# CRYPTO_rdrand writes eight bytes of random data from the hardware RNG to
# |out|. It returns one on success or zero on hardware failure.
# int CRYPTO_rdrand(uint8_t out[8]);
.globl	CRYPTO_rdrand
.type	CRYPTO_rdrand,\@abi-omnipotent
.align	16
CRYPTO_rdrand:
.cfi_startproc
	_CET_ENDBR
	xorq %rax, %rax
	rdrand $tmp1
	# An add-with-carry of zero effectively sets %rax to the carry flag.
	adcq %rax, %rax
	movq $tmp1, 0($out)
	retq
.cfi_endproc
.size CRYPTO_rdrand,.-CRYPTO_rdrand

# CRYPTO_rdrand_multiple8_buf fills |len| bytes at |buf| with random data from
# the hardware RNG. The |len| argument must be a multiple of eight. It returns
# one on success and zero on hardware failure.
# int CRYPTO_rdrand_multiple8_buf(uint8_t *buf, size_t len);
.globl CRYPTO_rdrand_multiple8_buf
.type CRYPTO_rdrand_multiple8_buf,\@abi-omnipotent
.align 16
CRYPTO_rdrand_multiple8_buf:
.cfi_startproc
	_CET_ENDBR
	test $len, $len
	jz .Lout
	movq \$8, $tmp1
.Lloop:
	rdrand $tmp2
	jnc .Lerr
	movq $tmp2, 0($out)
	addq $tmp1, $out
	subq $tmp1, $len
	jnz .Lloop
.Lout:
	movq \$1, %rax
	retq
.Lerr:
	xorq %rax, %rax
	retq
.cfi_endproc
.size CRYPTO_rdrand_multiple8_buf,.-CRYPTO_rdrand_multiple8_buf
___

close STDOUT or die "error closing STDOUT: $!";	# flush
