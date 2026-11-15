; This file is generated from a similarly-named Perl script in the BoringSSL
; source tree. Do not edit by hand.

%ifidn __OUTPUT_FORMAT__, win64
default	rel
%define XMMWORD
%define YMMWORD
%define ZMMWORD
%define _CET_ENDBR

%ifdef BORINGSSL_PREFIX
%include "boringssl_prefix_symbols_nasm.inc"
%endif
section	.text code align=64





global	CRYPTO_rdrand

ALIGN	16
CRYPTO_rdrand:

_CET_ENDBR
	xor	rax,rax
	rdrand	r8

	adc	rax,rax
	mov	QWORD[rcx],r8
	ret







global	CRYPTO_rdrand_multiple8_buf

ALIGN	16
CRYPTO_rdrand_multiple8_buf:

_CET_ENDBR
	test	rdx,rdx
	jz	NEAR $L$out
	mov	r8,8
$L$loop:
	rdrand	r9
	jnc	NEAR $L$err
	mov	QWORD[rcx],r9
	add	rcx,r8
	sub	rdx,r8
	jnz	NEAR $L$loop
$L$out:
	mov	rax,1
	ret
$L$err:
	xor	rax,rax
	ret


%else
; Work around https://bugzilla.nasm.us/show_bug.cgi?id=3392738
ret
%endif
