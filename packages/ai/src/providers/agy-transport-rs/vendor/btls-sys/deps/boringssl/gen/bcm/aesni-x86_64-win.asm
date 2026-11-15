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

global	aes_hw_encrypt

ALIGN	16
aes_hw_encrypt:

_CET_ENDBR
%ifdef BORINGSSL_DISPATCH_TEST
EXTERN	BORINGSSL_function_hit
	mov	BYTE[((BORINGSSL_function_hit+1))],1
%endif
	movups	xmm2,XMMWORD[rcx]
	mov	eax,DWORD[240+r8]
	movups	xmm0,XMMWORD[r8]
	movups	xmm1,XMMWORD[16+r8]
	lea	r8,[32+r8]
	xorps	xmm2,xmm0
$L$oop_enc1_1:
	aesenc	xmm2,xmm1
	dec	eax
	movups	xmm1,XMMWORD[r8]
	lea	r8,[16+r8]
	jnz	NEAR $L$oop_enc1_1
	aesenclast	xmm2,xmm1
	pxor	xmm0,xmm0
	pxor	xmm1,xmm1
	movups	XMMWORD[rdx],xmm2
	pxor	xmm2,xmm2
	ret



global	aes_hw_decrypt

ALIGN	16
aes_hw_decrypt:

_CET_ENDBR
	movups	xmm2,XMMWORD[rcx]
	mov	eax,DWORD[240+r8]
	movups	xmm0,XMMWORD[r8]
	movups	xmm1,XMMWORD[16+r8]
	lea	r8,[32+r8]
	xorps	xmm2,xmm0
$L$oop_dec1_2:
	aesdec	xmm2,xmm1
	dec	eax
	movups	xmm1,XMMWORD[r8]
	lea	r8,[16+r8]
	jnz	NEAR $L$oop_dec1_2
	aesdeclast	xmm2,xmm1
	pxor	xmm0,xmm0
	pxor	xmm1,xmm1
	movups	XMMWORD[rdx],xmm2
	pxor	xmm2,xmm2
	ret



ALIGN	16
_aesni_encrypt2:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	movups	xmm0,XMMWORD[32+rcx]
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	add	rax,16

$L$enc_loop2:
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$enc_loop2

	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenclast	xmm2,xmm0
	aesenclast	xmm3,xmm0
	ret



ALIGN	16
_aesni_decrypt2:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	movups	xmm0,XMMWORD[32+rcx]
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	add	rax,16

$L$dec_loop2:
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$dec_loop2

	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdeclast	xmm2,xmm0
	aesdeclast	xmm3,xmm0
	ret



ALIGN	16
_aesni_encrypt3:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	xorps	xmm4,xmm0
	movups	xmm0,XMMWORD[32+rcx]
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	add	rax,16

$L$enc_loop3:
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	aesenc	xmm4,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$enc_loop3

	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenclast	xmm2,xmm0
	aesenclast	xmm3,xmm0
	aesenclast	xmm4,xmm0
	ret



ALIGN	16
_aesni_decrypt3:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	xorps	xmm4,xmm0
	movups	xmm0,XMMWORD[32+rcx]
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	add	rax,16

$L$dec_loop3:
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$dec_loop3

	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdeclast	xmm2,xmm0
	aesdeclast	xmm3,xmm0
	aesdeclast	xmm4,xmm0
	ret



ALIGN	16
_aesni_encrypt4:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	xorps	xmm4,xmm0
	xorps	xmm5,xmm0
	movups	xmm0,XMMWORD[32+rcx]
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	DB	0x0f,0x1f,0x00
	add	rax,16

$L$enc_loop4:
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$enc_loop4

	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	aesenclast	xmm2,xmm0
	aesenclast	xmm3,xmm0
	aesenclast	xmm4,xmm0
	aesenclast	xmm5,xmm0
	ret



ALIGN	16
_aesni_decrypt4:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	xorps	xmm4,xmm0
	xorps	xmm5,xmm0
	movups	xmm0,XMMWORD[32+rcx]
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	DB	0x0f,0x1f,0x00
	add	rax,16

$L$dec_loop4:
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$dec_loop4

	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdeclast	xmm2,xmm0
	aesdeclast	xmm3,xmm0
	aesdeclast	xmm4,xmm0
	aesdeclast	xmm5,xmm0
	ret



ALIGN	16
_aesni_encrypt6:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	pxor	xmm3,xmm0
	pxor	xmm4,xmm0
	aesenc	xmm2,xmm1
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	aesenc	xmm3,xmm1
	pxor	xmm5,xmm0
	pxor	xmm6,xmm0
	aesenc	xmm4,xmm1
	pxor	xmm7,xmm0
	movups	xmm0,XMMWORD[rax*1+rcx]
	add	rax,16
	jmp	NEAR $L$enc_loop6_enter
ALIGN	16
$L$enc_loop6:
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
$L$enc_loop6_enter:
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$enc_loop6

	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenclast	xmm2,xmm0
	aesenclast	xmm3,xmm0
	aesenclast	xmm4,xmm0
	aesenclast	xmm5,xmm0
	aesenclast	xmm6,xmm0
	aesenclast	xmm7,xmm0
	ret



ALIGN	16
_aesni_decrypt6:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	pxor	xmm3,xmm0
	pxor	xmm4,xmm0
	aesdec	xmm2,xmm1
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	aesdec	xmm3,xmm1
	pxor	xmm5,xmm0
	pxor	xmm6,xmm0
	aesdec	xmm4,xmm1
	pxor	xmm7,xmm0
	movups	xmm0,XMMWORD[rax*1+rcx]
	add	rax,16
	jmp	NEAR $L$dec_loop6_enter
ALIGN	16
$L$dec_loop6:
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
$L$dec_loop6_enter:
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$dec_loop6

	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdeclast	xmm2,xmm0
	aesdeclast	xmm3,xmm0
	aesdeclast	xmm4,xmm0
	aesdeclast	xmm5,xmm0
	aesdeclast	xmm6,xmm0
	aesdeclast	xmm7,xmm0
	ret



ALIGN	16
_aesni_encrypt8:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	pxor	xmm4,xmm0
	pxor	xmm5,xmm0
	pxor	xmm6,xmm0
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	aesenc	xmm2,xmm1
	pxor	xmm7,xmm0
	pxor	xmm8,xmm0
	aesenc	xmm3,xmm1
	pxor	xmm9,xmm0
	movups	xmm0,XMMWORD[rax*1+rcx]
	add	rax,16
	jmp	NEAR $L$enc_loop8_inner
ALIGN	16
$L$enc_loop8:
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
$L$enc_loop8_inner:
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
$L$enc_loop8_enter:
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	aesenc	xmm8,xmm0
	aesenc	xmm9,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$enc_loop8

	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	aesenclast	xmm2,xmm0
	aesenclast	xmm3,xmm0
	aesenclast	xmm4,xmm0
	aesenclast	xmm5,xmm0
	aesenclast	xmm6,xmm0
	aesenclast	xmm7,xmm0
	aesenclast	xmm8,xmm0
	aesenclast	xmm9,xmm0
	ret



ALIGN	16
_aesni_decrypt8:

	movups	xmm0,XMMWORD[rcx]
	shl	eax,4
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm2,xmm0
	xorps	xmm3,xmm0
	pxor	xmm4,xmm0
	pxor	xmm5,xmm0
	pxor	xmm6,xmm0
	lea	rcx,[32+rax*1+rcx]
	neg	rax
	aesdec	xmm2,xmm1
	pxor	xmm7,xmm0
	pxor	xmm8,xmm0
	aesdec	xmm3,xmm1
	pxor	xmm9,xmm0
	movups	xmm0,XMMWORD[rax*1+rcx]
	add	rax,16
	jmp	NEAR $L$dec_loop8_inner
ALIGN	16
$L$dec_loop8:
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
$L$dec_loop8_inner:
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
$L$dec_loop8_enter:
	movups	xmm1,XMMWORD[rax*1+rcx]
	add	rax,32
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	aesdec	xmm8,xmm0
	aesdec	xmm9,xmm0
	movups	xmm0,XMMWORD[((-16))+rax*1+rcx]
	jnz	NEAR $L$dec_loop8

	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
	aesdeclast	xmm2,xmm0
	aesdeclast	xmm3,xmm0
	aesdeclast	xmm4,xmm0
	aesdeclast	xmm5,xmm0
	aesdeclast	xmm6,xmm0
	aesdeclast	xmm7,xmm0
	aesdeclast	xmm8,xmm0
	aesdeclast	xmm9,xmm0
	ret


global	aes_hw_ecb_encrypt

ALIGN	16
aes_hw_ecb_encrypt:
	mov	QWORD[8+rsp],rdi	;WIN64 prologue
	mov	QWORD[16+rsp],rsi
	mov	rax,rsp
$L$SEH_begin_aes_hw_ecb_encrypt:
	mov	rdi,rcx
	mov	rsi,rdx
	mov	rdx,r8
	mov	rcx,r9
	mov	r8,QWORD[40+rsp]



_CET_ENDBR
	lea	rsp,[((-88))+rsp]
	movaps	XMMWORD[rsp],xmm6
	movaps	XMMWORD[16+rsp],xmm7
	movaps	XMMWORD[32+rsp],xmm8
	movaps	XMMWORD[48+rsp],xmm9
$L$ecb_enc_body:
	and	rdx,-16
	jz	NEAR $L$ecb_ret

	mov	eax,DWORD[240+rcx]
	movups	xmm0,XMMWORD[rcx]
	mov	r11,rcx
	mov	r10d,eax
	test	r8d,r8d
	jz	NEAR $L$ecb_decrypt

	cmp	rdx,0x80
	jb	NEAR $L$ecb_enc_tail

	movdqu	xmm2,XMMWORD[rdi]
	movdqu	xmm3,XMMWORD[16+rdi]
	movdqu	xmm4,XMMWORD[32+rdi]
	movdqu	xmm5,XMMWORD[48+rdi]
	movdqu	xmm6,XMMWORD[64+rdi]
	movdqu	xmm7,XMMWORD[80+rdi]
	movdqu	xmm8,XMMWORD[96+rdi]
	movdqu	xmm9,XMMWORD[112+rdi]
	lea	rdi,[128+rdi]
	sub	rdx,0x80
	jmp	NEAR $L$ecb_enc_loop8_enter
ALIGN	16
$L$ecb_enc_loop8:
	movups	XMMWORD[rsi],xmm2
	mov	rcx,r11
	movdqu	xmm2,XMMWORD[rdi]
	mov	eax,r10d
	movups	XMMWORD[16+rsi],xmm3
	movdqu	xmm3,XMMWORD[16+rdi]
	movups	XMMWORD[32+rsi],xmm4
	movdqu	xmm4,XMMWORD[32+rdi]
	movups	XMMWORD[48+rsi],xmm5
	movdqu	xmm5,XMMWORD[48+rdi]
	movups	XMMWORD[64+rsi],xmm6
	movdqu	xmm6,XMMWORD[64+rdi]
	movups	XMMWORD[80+rsi],xmm7
	movdqu	xmm7,XMMWORD[80+rdi]
	movups	XMMWORD[96+rsi],xmm8
	movdqu	xmm8,XMMWORD[96+rdi]
	movups	XMMWORD[112+rsi],xmm9
	lea	rsi,[128+rsi]
	movdqu	xmm9,XMMWORD[112+rdi]
	lea	rdi,[128+rdi]
$L$ecb_enc_loop8_enter:

	call	_aesni_encrypt8

	sub	rdx,0x80
	jnc	NEAR $L$ecb_enc_loop8

	movups	XMMWORD[rsi],xmm2
	mov	rcx,r11
	movups	XMMWORD[16+rsi],xmm3
	mov	eax,r10d
	movups	XMMWORD[32+rsi],xmm4
	movups	XMMWORD[48+rsi],xmm5
	movups	XMMWORD[64+rsi],xmm6
	movups	XMMWORD[80+rsi],xmm7
	movups	XMMWORD[96+rsi],xmm8
	movups	XMMWORD[112+rsi],xmm9
	lea	rsi,[128+rsi]
	add	rdx,0x80
	jz	NEAR $L$ecb_ret

$L$ecb_enc_tail:
	movups	xmm2,XMMWORD[rdi]
	cmp	rdx,0x20
	jb	NEAR $L$ecb_enc_one
	movups	xmm3,XMMWORD[16+rdi]
	je	NEAR $L$ecb_enc_two
	movups	xmm4,XMMWORD[32+rdi]
	cmp	rdx,0x40
	jb	NEAR $L$ecb_enc_three
	movups	xmm5,XMMWORD[48+rdi]
	je	NEAR $L$ecb_enc_four
	movups	xmm6,XMMWORD[64+rdi]
	cmp	rdx,0x60
	jb	NEAR $L$ecb_enc_five
	movups	xmm7,XMMWORD[80+rdi]
	je	NEAR $L$ecb_enc_six
	movdqu	xmm8,XMMWORD[96+rdi]
	xorps	xmm9,xmm9
	call	_aesni_encrypt8
	movups	XMMWORD[rsi],xmm2
	movups	XMMWORD[16+rsi],xmm3
	movups	XMMWORD[32+rsi],xmm4
	movups	XMMWORD[48+rsi],xmm5
	movups	XMMWORD[64+rsi],xmm6
	movups	XMMWORD[80+rsi],xmm7
	movups	XMMWORD[96+rsi],xmm8
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_enc_one:
	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[16+rcx]
	lea	rcx,[32+rcx]
	xorps	xmm2,xmm0
$L$oop_enc1_3:
	aesenc	xmm2,xmm1
	dec	eax
	movups	xmm1,XMMWORD[rcx]
	lea	rcx,[16+rcx]
	jnz	NEAR $L$oop_enc1_3
	aesenclast	xmm2,xmm1
	movups	XMMWORD[rsi],xmm2
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_enc_two:
	call	_aesni_encrypt2
	movups	XMMWORD[rsi],xmm2
	movups	XMMWORD[16+rsi],xmm3
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_enc_three:
	call	_aesni_encrypt3
	movups	XMMWORD[rsi],xmm2
	movups	XMMWORD[16+rsi],xmm3
	movups	XMMWORD[32+rsi],xmm4
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_enc_four:
	call	_aesni_encrypt4
	movups	XMMWORD[rsi],xmm2
	movups	XMMWORD[16+rsi],xmm3
	movups	XMMWORD[32+rsi],xmm4
	movups	XMMWORD[48+rsi],xmm5
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_enc_five:
	xorps	xmm7,xmm7
	call	_aesni_encrypt6
	movups	XMMWORD[rsi],xmm2
	movups	XMMWORD[16+rsi],xmm3
	movups	XMMWORD[32+rsi],xmm4
	movups	XMMWORD[48+rsi],xmm5
	movups	XMMWORD[64+rsi],xmm6
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_enc_six:
	call	_aesni_encrypt6
	movups	XMMWORD[rsi],xmm2
	movups	XMMWORD[16+rsi],xmm3
	movups	XMMWORD[32+rsi],xmm4
	movups	XMMWORD[48+rsi],xmm5
	movups	XMMWORD[64+rsi],xmm6
	movups	XMMWORD[80+rsi],xmm7
	jmp	NEAR $L$ecb_ret

ALIGN	16
$L$ecb_decrypt:
	cmp	rdx,0x80
	jb	NEAR $L$ecb_dec_tail

	movdqu	xmm2,XMMWORD[rdi]
	movdqu	xmm3,XMMWORD[16+rdi]
	movdqu	xmm4,XMMWORD[32+rdi]
	movdqu	xmm5,XMMWORD[48+rdi]
	movdqu	xmm6,XMMWORD[64+rdi]
	movdqu	xmm7,XMMWORD[80+rdi]
	movdqu	xmm8,XMMWORD[96+rdi]
	movdqu	xmm9,XMMWORD[112+rdi]
	lea	rdi,[128+rdi]
	sub	rdx,0x80
	jmp	NEAR $L$ecb_dec_loop8_enter
ALIGN	16
$L$ecb_dec_loop8:
	movups	XMMWORD[rsi],xmm2
	mov	rcx,r11
	movdqu	xmm2,XMMWORD[rdi]
	mov	eax,r10d
	movups	XMMWORD[16+rsi],xmm3
	movdqu	xmm3,XMMWORD[16+rdi]
	movups	XMMWORD[32+rsi],xmm4
	movdqu	xmm4,XMMWORD[32+rdi]
	movups	XMMWORD[48+rsi],xmm5
	movdqu	xmm5,XMMWORD[48+rdi]
	movups	XMMWORD[64+rsi],xmm6
	movdqu	xmm6,XMMWORD[64+rdi]
	movups	XMMWORD[80+rsi],xmm7
	movdqu	xmm7,XMMWORD[80+rdi]
	movups	XMMWORD[96+rsi],xmm8
	movdqu	xmm8,XMMWORD[96+rdi]
	movups	XMMWORD[112+rsi],xmm9
	lea	rsi,[128+rsi]
	movdqu	xmm9,XMMWORD[112+rdi]
	lea	rdi,[128+rdi]
$L$ecb_dec_loop8_enter:

	call	_aesni_decrypt8

	movups	xmm0,XMMWORD[r11]
	sub	rdx,0x80
	jnc	NEAR $L$ecb_dec_loop8

	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	mov	rcx,r11
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	mov	eax,r10d
	movups	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	movups	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	movups	XMMWORD[64+rsi],xmm6
	pxor	xmm6,xmm6
	movups	XMMWORD[80+rsi],xmm7
	pxor	xmm7,xmm7
	movups	XMMWORD[96+rsi],xmm8
	pxor	xmm8,xmm8
	movups	XMMWORD[112+rsi],xmm9
	pxor	xmm9,xmm9
	lea	rsi,[128+rsi]
	add	rdx,0x80
	jz	NEAR $L$ecb_ret

$L$ecb_dec_tail:
	movups	xmm2,XMMWORD[rdi]
	cmp	rdx,0x20
	jb	NEAR $L$ecb_dec_one
	movups	xmm3,XMMWORD[16+rdi]
	je	NEAR $L$ecb_dec_two
	movups	xmm4,XMMWORD[32+rdi]
	cmp	rdx,0x40
	jb	NEAR $L$ecb_dec_three
	movups	xmm5,XMMWORD[48+rdi]
	je	NEAR $L$ecb_dec_four
	movups	xmm6,XMMWORD[64+rdi]
	cmp	rdx,0x60
	jb	NEAR $L$ecb_dec_five
	movups	xmm7,XMMWORD[80+rdi]
	je	NEAR $L$ecb_dec_six
	movups	xmm8,XMMWORD[96+rdi]
	movups	xmm0,XMMWORD[rcx]
	xorps	xmm9,xmm9
	call	_aesni_decrypt8
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	movups	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	movups	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	movups	XMMWORD[64+rsi],xmm6
	pxor	xmm6,xmm6
	movups	XMMWORD[80+rsi],xmm7
	pxor	xmm7,xmm7
	movups	XMMWORD[96+rsi],xmm8
	pxor	xmm8,xmm8
	pxor	xmm9,xmm9
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_dec_one:
	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[16+rcx]
	lea	rcx,[32+rcx]
	xorps	xmm2,xmm0
$L$oop_dec1_4:
	aesdec	xmm2,xmm1
	dec	eax
	movups	xmm1,XMMWORD[rcx]
	lea	rcx,[16+rcx]
	jnz	NEAR $L$oop_dec1_4
	aesdeclast	xmm2,xmm1
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_dec_two:
	call	_aesni_decrypt2
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_dec_three:
	call	_aesni_decrypt3
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	movups	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_dec_four:
	call	_aesni_decrypt4
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	movups	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	movups	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_dec_five:
	xorps	xmm7,xmm7
	call	_aesni_decrypt6
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	movups	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	movups	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	movups	XMMWORD[64+rsi],xmm6
	pxor	xmm6,xmm6
	pxor	xmm7,xmm7
	jmp	NEAR $L$ecb_ret
ALIGN	16
$L$ecb_dec_six:
	call	_aesni_decrypt6
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	movups	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	movups	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	movups	XMMWORD[64+rsi],xmm6
	pxor	xmm6,xmm6
	movups	XMMWORD[80+rsi],xmm7
	pxor	xmm7,xmm7

$L$ecb_ret:
	xorps	xmm0,xmm0
	pxor	xmm1,xmm1
	movaps	xmm6,XMMWORD[rsp]
	movaps	XMMWORD[rsp],xmm0
	movaps	xmm7,XMMWORD[16+rsp]
	movaps	XMMWORD[16+rsp],xmm0
	movaps	xmm8,XMMWORD[32+rsp]
	movaps	XMMWORD[32+rsp],xmm0
	movaps	xmm9,XMMWORD[48+rsp]
	movaps	XMMWORD[48+rsp],xmm0
	lea	rsp,[88+rsp]
$L$ecb_enc_ret:
	mov	rdi,QWORD[8+rsp]	;WIN64 epilogue
	mov	rsi,QWORD[16+rsp]
	ret

$L$SEH_end_aes_hw_ecb_encrypt:
global	aes_hw_ctr32_encrypt_blocks

ALIGN	16
aes_hw_ctr32_encrypt_blocks:
	mov	QWORD[8+rsp],rdi	;WIN64 prologue
	mov	QWORD[16+rsp],rsi
	mov	rax,rsp
$L$SEH_begin_aes_hw_ctr32_encrypt_blocks:
	mov	rdi,rcx
	mov	rsi,rdx
	mov	rdx,r8
	mov	rcx,r9
	mov	r8,QWORD[40+rsp]



_CET_ENDBR
%ifdef BORINGSSL_DISPATCH_TEST
	mov	BYTE[BORINGSSL_function_hit],1
%endif
	cmp	rdx,1
	jne	NEAR $L$ctr32_bulk



	movups	xmm2,XMMWORD[r8]
	movups	xmm3,XMMWORD[rdi]
	mov	edx,DWORD[240+rcx]
	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[16+rcx]
	lea	rcx,[32+rcx]
	xorps	xmm2,xmm0
$L$oop_enc1_5:
	aesenc	xmm2,xmm1
	dec	edx
	movups	xmm1,XMMWORD[rcx]
	lea	rcx,[16+rcx]
	jnz	NEAR $L$oop_enc1_5
	aesenclast	xmm2,xmm1
	pxor	xmm0,xmm0
	pxor	xmm1,xmm1
	xorps	xmm2,xmm3
	pxor	xmm3,xmm3
	movups	XMMWORD[rsi],xmm2
	xorps	xmm2,xmm2
	jmp	NEAR $L$ctr32_epilogue

ALIGN	16
$L$ctr32_bulk:
	lea	r11,[rsp]

	push	rbp

	sub	rsp,288
	and	rsp,-16
	movaps	XMMWORD[(-168)+r11],xmm6
	movaps	XMMWORD[(-152)+r11],xmm7
	movaps	XMMWORD[(-136)+r11],xmm8
	movaps	XMMWORD[(-120)+r11],xmm9
	movaps	XMMWORD[(-104)+r11],xmm10
	movaps	XMMWORD[(-88)+r11],xmm11
	movaps	XMMWORD[(-72)+r11],xmm12
	movaps	XMMWORD[(-56)+r11],xmm13
	movaps	XMMWORD[(-40)+r11],xmm14
	movaps	XMMWORD[(-24)+r11],xmm15
$L$ctr32_body:




	movdqu	xmm2,XMMWORD[r8]
	movdqu	xmm0,XMMWORD[rcx]
	mov	r8d,DWORD[12+r8]
	pxor	xmm2,xmm0
	mov	ebp,DWORD[12+rcx]
	movdqa	XMMWORD[rsp],xmm2
	bswap	r8d
	movdqa	xmm3,xmm2
	movdqa	xmm4,xmm2
	movdqa	xmm5,xmm2
	movdqa	XMMWORD[64+rsp],xmm2
	movdqa	XMMWORD[80+rsp],xmm2
	movdqa	XMMWORD[96+rsp],xmm2
	mov	r10,rdx
	movdqa	XMMWORD[112+rsp],xmm2

	lea	rax,[1+r8]
	lea	rdx,[2+r8]
	bswap	eax
	bswap	edx
	xor	eax,ebp
	xor	edx,ebp
	pinsrd	xmm3,eax,3
	lea	rax,[3+r8]
	movdqa	XMMWORD[16+rsp],xmm3
	pinsrd	xmm4,edx,3
	bswap	eax
	mov	rdx,r10
	lea	r10,[4+r8]
	movdqa	XMMWORD[32+rsp],xmm4
	xor	eax,ebp
	bswap	r10d
	pinsrd	xmm5,eax,3
	xor	r10d,ebp
	movdqa	XMMWORD[48+rsp],xmm5
	lea	r9,[5+r8]
	mov	DWORD[((64+12))+rsp],r10d
	bswap	r9d
	lea	r10,[6+r8]
	mov	eax,DWORD[240+rcx]
	xor	r9d,ebp
	bswap	r10d
	mov	DWORD[((80+12))+rsp],r9d
	xor	r10d,ebp
	lea	r9,[7+r8]
	mov	DWORD[((96+12))+rsp],r10d
	bswap	r9d
	xor	r9d,ebp
	mov	DWORD[((112+12))+rsp],r9d

	movups	xmm1,XMMWORD[16+rcx]

	movdqa	xmm6,XMMWORD[64+rsp]
	movdqa	xmm7,XMMWORD[80+rsp]

	cmp	rdx,8
	jb	NEAR $L$ctr32_tail

	lea	rcx,[128+rcx]
	sub	rdx,8
	jmp	NEAR $L$ctr32_loop8

ALIGN	32
$L$ctr32_loop8:
	add	r8d,8
	movdqa	xmm8,XMMWORD[96+rsp]
	aesenc	xmm2,xmm1
	mov	r9d,r8d
	movdqa	xmm9,XMMWORD[112+rsp]
	aesenc	xmm3,xmm1
	bswap	r9d
	movups	xmm0,XMMWORD[((32-128))+rcx]
	aesenc	xmm4,xmm1
	xor	r9d,ebp
	nop
	aesenc	xmm5,xmm1
	mov	DWORD[((0+12))+rsp],r9d
	lea	r9,[1+r8]
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	movups	xmm1,XMMWORD[((48-128))+rcx]
	bswap	r9d
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	xor	r9d,ebp
	DB	0x66,0x90
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	mov	DWORD[((16+12))+rsp],r9d
	lea	r9,[2+r8]
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	aesenc	xmm8,xmm0
	aesenc	xmm9,xmm0
	movups	xmm0,XMMWORD[((64-128))+rcx]
	bswap	r9d
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	xor	r9d,ebp
	DB	0x66,0x90
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	mov	DWORD[((32+12))+rsp],r9d
	lea	r9,[3+r8]
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	movups	xmm1,XMMWORD[((80-128))+rcx]
	bswap	r9d
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	xor	r9d,ebp
	DB	0x66,0x90
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	mov	DWORD[((48+12))+rsp],r9d
	lea	r9,[4+r8]
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	aesenc	xmm8,xmm0
	aesenc	xmm9,xmm0
	movups	xmm0,XMMWORD[((96-128))+rcx]
	bswap	r9d
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	xor	r9d,ebp
	DB	0x66,0x90
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	mov	DWORD[((64+12))+rsp],r9d
	lea	r9,[5+r8]
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	movups	xmm1,XMMWORD[((112-128))+rcx]
	bswap	r9d
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	xor	r9d,ebp
	DB	0x66,0x90
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	mov	DWORD[((80+12))+rsp],r9d
	lea	r9,[6+r8]
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	aesenc	xmm8,xmm0
	aesenc	xmm9,xmm0
	movups	xmm0,XMMWORD[((128-128))+rcx]
	bswap	r9d
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	xor	r9d,ebp
	DB	0x66,0x90
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	mov	DWORD[((96+12))+rsp],r9d
	lea	r9,[7+r8]
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	movups	xmm1,XMMWORD[((144-128))+rcx]
	bswap	r9d
	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	aesenc	xmm4,xmm0
	xor	r9d,ebp
	movdqu	xmm10,XMMWORD[rdi]
	aesenc	xmm5,xmm0
	mov	DWORD[((112+12))+rsp],r9d
	cmp	eax,11
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	aesenc	xmm8,xmm0
	aesenc	xmm9,xmm0
	movups	xmm0,XMMWORD[((160-128))+rcx]

	jb	NEAR $L$ctr32_enc_done

	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	movups	xmm1,XMMWORD[((176-128))+rcx]

	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	aesenc	xmm8,xmm0
	aesenc	xmm9,xmm0
	movups	xmm0,XMMWORD[((192-128))+rcx]
	je	NEAR $L$ctr32_enc_done

	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	movups	xmm1,XMMWORD[((208-128))+rcx]

	aesenc	xmm2,xmm0
	aesenc	xmm3,xmm0
	aesenc	xmm4,xmm0
	aesenc	xmm5,xmm0
	aesenc	xmm6,xmm0
	aesenc	xmm7,xmm0
	aesenc	xmm8,xmm0
	aesenc	xmm9,xmm0
	movups	xmm0,XMMWORD[((224-128))+rcx]
	jmp	NEAR $L$ctr32_enc_done

ALIGN	16
$L$ctr32_enc_done:
	movdqu	xmm11,XMMWORD[16+rdi]
	pxor	xmm10,xmm0
	movdqu	xmm12,XMMWORD[32+rdi]
	pxor	xmm11,xmm0
	movdqu	xmm13,XMMWORD[48+rdi]
	pxor	xmm12,xmm0
	movdqu	xmm14,XMMWORD[64+rdi]
	pxor	xmm13,xmm0
	movdqu	xmm15,XMMWORD[80+rdi]
	pxor	xmm14,xmm0
	prefetcht0	[448+rdi]
	prefetcht0	[512+rdi]
	pxor	xmm15,xmm0
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1
	aesenc	xmm9,xmm1
	movdqu	xmm1,XMMWORD[96+rdi]
	lea	rdi,[128+rdi]

	aesenclast	xmm2,xmm10
	pxor	xmm1,xmm0
	movdqu	xmm10,XMMWORD[((112-128))+rdi]
	aesenclast	xmm3,xmm11
	pxor	xmm10,xmm0
	movdqa	xmm11,XMMWORD[rsp]
	aesenclast	xmm4,xmm12
	aesenclast	xmm5,xmm13
	movdqa	xmm12,XMMWORD[16+rsp]
	movdqa	xmm13,XMMWORD[32+rsp]
	aesenclast	xmm6,xmm14
	aesenclast	xmm7,xmm15
	movdqa	xmm14,XMMWORD[48+rsp]
	movdqa	xmm15,XMMWORD[64+rsp]
	aesenclast	xmm8,xmm1
	movdqa	xmm0,XMMWORD[80+rsp]
	movups	xmm1,XMMWORD[((16-128))+rcx]
	aesenclast	xmm9,xmm10

	movups	XMMWORD[rsi],xmm2
	movdqa	xmm2,xmm11
	movups	XMMWORD[16+rsi],xmm3
	movdqa	xmm3,xmm12
	movups	XMMWORD[32+rsi],xmm4
	movdqa	xmm4,xmm13
	movups	XMMWORD[48+rsi],xmm5
	movdqa	xmm5,xmm14
	movups	XMMWORD[64+rsi],xmm6
	movdqa	xmm6,xmm15
	movups	XMMWORD[80+rsi],xmm7
	movdqa	xmm7,xmm0
	movups	XMMWORD[96+rsi],xmm8
	movups	XMMWORD[112+rsi],xmm9
	lea	rsi,[128+rsi]

	sub	rdx,8
	jnc	NEAR $L$ctr32_loop8

	add	rdx,8
	jz	NEAR $L$ctr32_done
	lea	rcx,[((-128))+rcx]

$L$ctr32_tail:


	lea	rcx,[16+rcx]
	cmp	rdx,4
	jb	NEAR $L$ctr32_loop3
	je	NEAR $L$ctr32_loop4


	shl	eax,4
	movdqa	xmm8,XMMWORD[96+rsp]
	pxor	xmm9,xmm9

	movups	xmm0,XMMWORD[16+rcx]
	aesenc	xmm2,xmm1
	aesenc	xmm3,xmm1
	lea	rcx,[((32-16))+rax*1+rcx]
	neg	rax
	aesenc	xmm4,xmm1
	add	rax,16
	movups	xmm10,XMMWORD[rdi]
	aesenc	xmm5,xmm1
	aesenc	xmm6,xmm1
	movups	xmm11,XMMWORD[16+rdi]
	movups	xmm12,XMMWORD[32+rdi]
	aesenc	xmm7,xmm1
	aesenc	xmm8,xmm1

	call	$L$enc_loop8_enter

	movdqu	xmm13,XMMWORD[48+rdi]
	pxor	xmm2,xmm10
	movdqu	xmm10,XMMWORD[64+rdi]
	pxor	xmm3,xmm11
	movdqu	XMMWORD[rsi],xmm2
	pxor	xmm4,xmm12
	movdqu	XMMWORD[16+rsi],xmm3
	pxor	xmm5,xmm13
	movdqu	XMMWORD[32+rsi],xmm4
	pxor	xmm6,xmm10
	movdqu	XMMWORD[48+rsi],xmm5
	movdqu	XMMWORD[64+rsi],xmm6
	cmp	rdx,6
	jb	NEAR $L$ctr32_done

	movups	xmm11,XMMWORD[80+rdi]
	xorps	xmm7,xmm11
	movups	XMMWORD[80+rsi],xmm7
	je	NEAR $L$ctr32_done

	movups	xmm12,XMMWORD[96+rdi]
	xorps	xmm8,xmm12
	movups	XMMWORD[96+rsi],xmm8
	jmp	NEAR $L$ctr32_done

ALIGN	32
$L$ctr32_loop4:
	aesenc	xmm2,xmm1
	lea	rcx,[16+rcx]
	dec	eax
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	aesenc	xmm5,xmm1
	movups	xmm1,XMMWORD[rcx]
	jnz	NEAR $L$ctr32_loop4
	aesenclast	xmm2,xmm1
	aesenclast	xmm3,xmm1
	movups	xmm10,XMMWORD[rdi]
	movups	xmm11,XMMWORD[16+rdi]
	aesenclast	xmm4,xmm1
	aesenclast	xmm5,xmm1
	movups	xmm12,XMMWORD[32+rdi]
	movups	xmm13,XMMWORD[48+rdi]

	xorps	xmm2,xmm10
	movups	XMMWORD[rsi],xmm2
	xorps	xmm3,xmm11
	movups	XMMWORD[16+rsi],xmm3
	pxor	xmm4,xmm12
	movdqu	XMMWORD[32+rsi],xmm4
	pxor	xmm5,xmm13
	movdqu	XMMWORD[48+rsi],xmm5
	jmp	NEAR $L$ctr32_done

ALIGN	32
$L$ctr32_loop3:
	aesenc	xmm2,xmm1
	lea	rcx,[16+rcx]
	dec	eax
	aesenc	xmm3,xmm1
	aesenc	xmm4,xmm1
	movups	xmm1,XMMWORD[rcx]
	jnz	NEAR $L$ctr32_loop3
	aesenclast	xmm2,xmm1
	aesenclast	xmm3,xmm1
	aesenclast	xmm4,xmm1

	movups	xmm10,XMMWORD[rdi]
	xorps	xmm2,xmm10
	movups	XMMWORD[rsi],xmm2
	cmp	rdx,2
	jb	NEAR $L$ctr32_done

	movups	xmm11,XMMWORD[16+rdi]
	xorps	xmm3,xmm11
	movups	XMMWORD[16+rsi],xmm3
	je	NEAR $L$ctr32_done

	movups	xmm12,XMMWORD[32+rdi]
	xorps	xmm4,xmm12
	movups	XMMWORD[32+rsi],xmm4

$L$ctr32_done:
	xorps	xmm0,xmm0
	xor	ebp,ebp
	pxor	xmm1,xmm1
	pxor	xmm2,xmm2
	pxor	xmm3,xmm3
	pxor	xmm4,xmm4
	pxor	xmm5,xmm5
	movaps	xmm6,XMMWORD[((-168))+r11]
	movaps	XMMWORD[(-168)+r11],xmm0
	movaps	xmm7,XMMWORD[((-152))+r11]
	movaps	XMMWORD[(-152)+r11],xmm0
	movaps	xmm8,XMMWORD[((-136))+r11]
	movaps	XMMWORD[(-136)+r11],xmm0
	movaps	xmm9,XMMWORD[((-120))+r11]
	movaps	XMMWORD[(-120)+r11],xmm0
	movaps	xmm10,XMMWORD[((-104))+r11]
	movaps	XMMWORD[(-104)+r11],xmm0
	movaps	xmm11,XMMWORD[((-88))+r11]
	movaps	XMMWORD[(-88)+r11],xmm0
	movaps	xmm12,XMMWORD[((-72))+r11]
	movaps	XMMWORD[(-72)+r11],xmm0
	movaps	xmm13,XMMWORD[((-56))+r11]
	movaps	XMMWORD[(-56)+r11],xmm0
	movaps	xmm14,XMMWORD[((-40))+r11]
	movaps	XMMWORD[(-40)+r11],xmm0
	movaps	xmm15,XMMWORD[((-24))+r11]
	movaps	XMMWORD[(-24)+r11],xmm0
	movaps	XMMWORD[rsp],xmm0
	movaps	XMMWORD[16+rsp],xmm0
	movaps	XMMWORD[32+rsp],xmm0
	movaps	XMMWORD[48+rsp],xmm0
	movaps	XMMWORD[64+rsp],xmm0
	movaps	XMMWORD[80+rsp],xmm0
	movaps	XMMWORD[96+rsp],xmm0
	movaps	XMMWORD[112+rsp],xmm0
	mov	rbp,QWORD[((-8))+r11]

	lea	rsp,[r11]

$L$ctr32_epilogue:
	mov	rdi,QWORD[8+rsp]	;WIN64 epilogue
	mov	rsi,QWORD[16+rsp]
	ret

$L$SEH_end_aes_hw_ctr32_encrypt_blocks:
global	aes_hw_cbc_encrypt

ALIGN	16
aes_hw_cbc_encrypt:
	mov	QWORD[8+rsp],rdi	;WIN64 prologue
	mov	QWORD[16+rsp],rsi
	mov	rax,rsp
$L$SEH_begin_aes_hw_cbc_encrypt:
	mov	rdi,rcx
	mov	rsi,rdx
	mov	rdx,r8
	mov	rcx,r9
	mov	r8,QWORD[40+rsp]
	mov	r9,QWORD[48+rsp]



_CET_ENDBR
	test	rdx,rdx
	jz	NEAR $L$cbc_ret

	mov	r10d,DWORD[240+rcx]
	mov	r11,rcx
	test	r9d,r9d
	jz	NEAR $L$cbc_decrypt

	movups	xmm2,XMMWORD[r8]
	mov	eax,r10d
	cmp	rdx,16
	jb	NEAR $L$cbc_enc_tail
	sub	rdx,16
	jmp	NEAR $L$cbc_enc_loop
ALIGN	16
$L$cbc_enc_loop:
	movups	xmm3,XMMWORD[rdi]
	lea	rdi,[16+rdi]

	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[16+rcx]
	xorps	xmm3,xmm0
	lea	rcx,[32+rcx]
	xorps	xmm2,xmm3
$L$oop_enc1_6:
	aesenc	xmm2,xmm1
	dec	eax
	movups	xmm1,XMMWORD[rcx]
	lea	rcx,[16+rcx]
	jnz	NEAR $L$oop_enc1_6
	aesenclast	xmm2,xmm1
	mov	eax,r10d
	mov	rcx,r11
	movups	XMMWORD[rsi],xmm2
	lea	rsi,[16+rsi]
	sub	rdx,16
	jnc	NEAR $L$cbc_enc_loop
	add	rdx,16
	jnz	NEAR $L$cbc_enc_tail
	pxor	xmm0,xmm0
	pxor	xmm1,xmm1
	movups	XMMWORD[r8],xmm2
	pxor	xmm2,xmm2
	pxor	xmm3,xmm3
	jmp	NEAR $L$cbc_ret

$L$cbc_enc_tail:
	mov	rcx,rdx
	xchg	rsi,rdi
	DD	0x9066A4F3
	mov	ecx,16
	sub	rcx,rdx
	xor	eax,eax
	DD	0x9066AAF3
	lea	rdi,[((-16))+rdi]
	mov	eax,r10d
	mov	rsi,rdi
	mov	rcx,r11
	xor	rdx,rdx
	jmp	NEAR $L$cbc_enc_loop

ALIGN	16
$L$cbc_decrypt:
	cmp	rdx,16
	jne	NEAR $L$cbc_decrypt_bulk



	movdqu	xmm2,XMMWORD[rdi]
	movdqu	xmm3,XMMWORD[r8]
	movdqa	xmm4,xmm2
	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[16+rcx]
	lea	rcx,[32+rcx]
	xorps	xmm2,xmm0
$L$oop_dec1_7:
	aesdec	xmm2,xmm1
	dec	r10d
	movups	xmm1,XMMWORD[rcx]
	lea	rcx,[16+rcx]
	jnz	NEAR $L$oop_dec1_7
	aesdeclast	xmm2,xmm1
	pxor	xmm0,xmm0
	pxor	xmm1,xmm1
	movdqu	XMMWORD[r8],xmm4
	xorps	xmm2,xmm3
	pxor	xmm3,xmm3
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	jmp	NEAR $L$cbc_ret
ALIGN	16
$L$cbc_decrypt_bulk:
	lea	r11,[rsp]

	push	rbp

	sub	rsp,176
	and	rsp,-16
	movaps	XMMWORD[16+rsp],xmm6
	movaps	XMMWORD[32+rsp],xmm7
	movaps	XMMWORD[48+rsp],xmm8
	movaps	XMMWORD[64+rsp],xmm9
	movaps	XMMWORD[80+rsp],xmm10
	movaps	XMMWORD[96+rsp],xmm11
	movaps	XMMWORD[112+rsp],xmm12
	movaps	XMMWORD[128+rsp],xmm13
	movaps	XMMWORD[144+rsp],xmm14
	movaps	XMMWORD[160+rsp],xmm15
$L$cbc_decrypt_body:
	mov	rbp,rcx
	movups	xmm10,XMMWORD[r8]
	mov	eax,r10d
	cmp	rdx,0x50
	jbe	NEAR $L$cbc_dec_tail

	movups	xmm0,XMMWORD[rcx]
	movdqu	xmm2,XMMWORD[rdi]
	movdqu	xmm3,XMMWORD[16+rdi]
	movdqa	xmm11,xmm2
	movdqu	xmm4,XMMWORD[32+rdi]
	movdqa	xmm12,xmm3
	movdqu	xmm5,XMMWORD[48+rdi]
	movdqa	xmm13,xmm4
	movdqu	xmm6,XMMWORD[64+rdi]
	movdqa	xmm14,xmm5
	movdqu	xmm7,XMMWORD[80+rdi]
	movdqa	xmm15,xmm6
	cmp	rdx,0x70
	jbe	NEAR $L$cbc_dec_six_or_seven

	sub	rdx,0x70
	lea	rcx,[112+rcx]
	jmp	NEAR $L$cbc_dec_loop8_enter
ALIGN	16
$L$cbc_dec_loop8:
	movups	XMMWORD[rsi],xmm9
	lea	rsi,[16+rsi]
$L$cbc_dec_loop8_enter:
	movdqu	xmm8,XMMWORD[96+rdi]
	pxor	xmm2,xmm0
	movdqu	xmm9,XMMWORD[112+rdi]
	pxor	xmm3,xmm0
	movups	xmm1,XMMWORD[((16-112))+rcx]
	pxor	xmm4,xmm0
	mov	rbp,-1
	cmp	rdx,0x70
	pxor	xmm5,xmm0
	pxor	xmm6,xmm0
	pxor	xmm7,xmm0
	pxor	xmm8,xmm0

	aesdec	xmm2,xmm1
	pxor	xmm9,xmm0
	movups	xmm0,XMMWORD[((32-112))+rcx]
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	adc	rbp,0
	and	rbp,128
	aesdec	xmm9,xmm1
	add	rbp,rdi
	movups	xmm1,XMMWORD[((48-112))+rcx]
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	aesdec	xmm8,xmm0
	aesdec	xmm9,xmm0
	movups	xmm0,XMMWORD[((64-112))+rcx]
	nop
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
	movups	xmm1,XMMWORD[((80-112))+rcx]
	nop
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	aesdec	xmm8,xmm0
	aesdec	xmm9,xmm0
	movups	xmm0,XMMWORD[((96-112))+rcx]
	nop
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
	movups	xmm1,XMMWORD[((112-112))+rcx]
	nop
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	aesdec	xmm8,xmm0
	aesdec	xmm9,xmm0
	movups	xmm0,XMMWORD[((128-112))+rcx]
	nop
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
	movups	xmm1,XMMWORD[((144-112))+rcx]
	cmp	eax,11
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	aesdec	xmm8,xmm0
	aesdec	xmm9,xmm0
	movups	xmm0,XMMWORD[((160-112))+rcx]
	jb	NEAR $L$cbc_dec_done
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
	movups	xmm1,XMMWORD[((176-112))+rcx]
	nop
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	aesdec	xmm8,xmm0
	aesdec	xmm9,xmm0
	movups	xmm0,XMMWORD[((192-112))+rcx]
	je	NEAR $L$cbc_dec_done
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
	movups	xmm1,XMMWORD[((208-112))+rcx]
	nop
	aesdec	xmm2,xmm0
	aesdec	xmm3,xmm0
	aesdec	xmm4,xmm0
	aesdec	xmm5,xmm0
	aesdec	xmm6,xmm0
	aesdec	xmm7,xmm0
	aesdec	xmm8,xmm0
	aesdec	xmm9,xmm0
	movups	xmm0,XMMWORD[((224-112))+rcx]
	jmp	NEAR $L$cbc_dec_done
ALIGN	16
$L$cbc_dec_done:
	aesdec	xmm2,xmm1
	aesdec	xmm3,xmm1
	pxor	xmm10,xmm0
	pxor	xmm11,xmm0
	aesdec	xmm4,xmm1
	aesdec	xmm5,xmm1
	pxor	xmm12,xmm0
	pxor	xmm13,xmm0
	aesdec	xmm6,xmm1
	aesdec	xmm7,xmm1
	pxor	xmm14,xmm0
	pxor	xmm15,xmm0
	aesdec	xmm8,xmm1
	aesdec	xmm9,xmm1
	movdqu	xmm1,XMMWORD[80+rdi]

	aesdeclast	xmm2,xmm10
	movdqu	xmm10,XMMWORD[96+rdi]
	pxor	xmm1,xmm0
	aesdeclast	xmm3,xmm11
	pxor	xmm10,xmm0
	movdqu	xmm0,XMMWORD[112+rdi]
	aesdeclast	xmm4,xmm12
	lea	rdi,[128+rdi]
	movdqu	xmm11,XMMWORD[rbp]
	aesdeclast	xmm5,xmm13
	aesdeclast	xmm6,xmm14
	movdqu	xmm12,XMMWORD[16+rbp]
	movdqu	xmm13,XMMWORD[32+rbp]
	aesdeclast	xmm7,xmm15
	aesdeclast	xmm8,xmm1
	movdqu	xmm14,XMMWORD[48+rbp]
	movdqu	xmm15,XMMWORD[64+rbp]
	aesdeclast	xmm9,xmm10
	movdqa	xmm10,xmm0
	movdqu	xmm1,XMMWORD[80+rbp]
	movups	xmm0,XMMWORD[((-112))+rcx]

	movups	XMMWORD[rsi],xmm2
	movdqa	xmm2,xmm11
	movups	XMMWORD[16+rsi],xmm3
	movdqa	xmm3,xmm12
	movups	XMMWORD[32+rsi],xmm4
	movdqa	xmm4,xmm13
	movups	XMMWORD[48+rsi],xmm5
	movdqa	xmm5,xmm14
	movups	XMMWORD[64+rsi],xmm6
	movdqa	xmm6,xmm15
	movups	XMMWORD[80+rsi],xmm7
	movdqa	xmm7,xmm1
	movups	XMMWORD[96+rsi],xmm8
	lea	rsi,[112+rsi]

	sub	rdx,0x80
	ja	NEAR $L$cbc_dec_loop8

	movaps	xmm2,xmm9
	lea	rcx,[((-112))+rcx]
	add	rdx,0x70
	jle	NEAR $L$cbc_dec_clear_tail_collected
	movups	XMMWORD[rsi],xmm9
	lea	rsi,[16+rsi]
	cmp	rdx,0x50
	jbe	NEAR $L$cbc_dec_tail

	movaps	xmm2,xmm11
$L$cbc_dec_six_or_seven:
	cmp	rdx,0x60
	ja	NEAR $L$cbc_dec_seven

	movaps	xmm8,xmm7
	call	_aesni_decrypt6
	pxor	xmm2,xmm10
	movaps	xmm10,xmm8
	pxor	xmm3,xmm11
	movdqu	XMMWORD[rsi],xmm2
	pxor	xmm4,xmm12
	movdqu	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	pxor	xmm5,xmm13
	movdqu	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	pxor	xmm6,xmm14
	movdqu	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	pxor	xmm7,xmm15
	movdqu	XMMWORD[64+rsi],xmm6
	pxor	xmm6,xmm6
	lea	rsi,[80+rsi]
	movdqa	xmm2,xmm7
	pxor	xmm7,xmm7
	jmp	NEAR $L$cbc_dec_tail_collected

ALIGN	16
$L$cbc_dec_seven:
	movups	xmm8,XMMWORD[96+rdi]
	xorps	xmm9,xmm9
	call	_aesni_decrypt8
	movups	xmm9,XMMWORD[80+rdi]
	pxor	xmm2,xmm10
	movups	xmm10,XMMWORD[96+rdi]
	pxor	xmm3,xmm11
	movdqu	XMMWORD[rsi],xmm2
	pxor	xmm4,xmm12
	movdqu	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	pxor	xmm5,xmm13
	movdqu	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	pxor	xmm6,xmm14
	movdqu	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	pxor	xmm7,xmm15
	movdqu	XMMWORD[64+rsi],xmm6
	pxor	xmm6,xmm6
	pxor	xmm8,xmm9
	movdqu	XMMWORD[80+rsi],xmm7
	pxor	xmm7,xmm7
	lea	rsi,[96+rsi]
	movdqa	xmm2,xmm8
	pxor	xmm8,xmm8
	pxor	xmm9,xmm9
	jmp	NEAR $L$cbc_dec_tail_collected

$L$cbc_dec_tail:
	movups	xmm2,XMMWORD[rdi]
	sub	rdx,0x10
	jbe	NEAR $L$cbc_dec_one

	movups	xmm3,XMMWORD[16+rdi]
	movaps	xmm11,xmm2
	sub	rdx,0x10
	jbe	NEAR $L$cbc_dec_two

	movups	xmm4,XMMWORD[32+rdi]
	movaps	xmm12,xmm3
	sub	rdx,0x10
	jbe	NEAR $L$cbc_dec_three

	movups	xmm5,XMMWORD[48+rdi]
	movaps	xmm13,xmm4
	sub	rdx,0x10
	jbe	NEAR $L$cbc_dec_four

	movups	xmm6,XMMWORD[64+rdi]
	movaps	xmm14,xmm5
	movaps	xmm15,xmm6
	xorps	xmm7,xmm7
	call	_aesni_decrypt6
	pxor	xmm2,xmm10
	movaps	xmm10,xmm15
	pxor	xmm3,xmm11
	movdqu	XMMWORD[rsi],xmm2
	pxor	xmm4,xmm12
	movdqu	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	pxor	xmm5,xmm13
	movdqu	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	pxor	xmm6,xmm14
	movdqu	XMMWORD[48+rsi],xmm5
	pxor	xmm5,xmm5
	lea	rsi,[64+rsi]
	movdqa	xmm2,xmm6
	pxor	xmm6,xmm6
	pxor	xmm7,xmm7
	sub	rdx,0x10
	jmp	NEAR $L$cbc_dec_tail_collected

ALIGN	16
$L$cbc_dec_one:
	movaps	xmm11,xmm2
	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[16+rcx]
	lea	rcx,[32+rcx]
	xorps	xmm2,xmm0
$L$oop_dec1_8:
	aesdec	xmm2,xmm1
	dec	eax
	movups	xmm1,XMMWORD[rcx]
	lea	rcx,[16+rcx]
	jnz	NEAR $L$oop_dec1_8
	aesdeclast	xmm2,xmm1
	xorps	xmm2,xmm10
	movaps	xmm10,xmm11
	jmp	NEAR $L$cbc_dec_tail_collected
ALIGN	16
$L$cbc_dec_two:
	movaps	xmm12,xmm3
	call	_aesni_decrypt2
	pxor	xmm2,xmm10
	movaps	xmm10,xmm12
	pxor	xmm3,xmm11
	movdqu	XMMWORD[rsi],xmm2
	movdqa	xmm2,xmm3
	pxor	xmm3,xmm3
	lea	rsi,[16+rsi]
	jmp	NEAR $L$cbc_dec_tail_collected
ALIGN	16
$L$cbc_dec_three:
	movaps	xmm13,xmm4
	call	_aesni_decrypt3
	pxor	xmm2,xmm10
	movaps	xmm10,xmm13
	pxor	xmm3,xmm11
	movdqu	XMMWORD[rsi],xmm2
	pxor	xmm4,xmm12
	movdqu	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	movdqa	xmm2,xmm4
	pxor	xmm4,xmm4
	lea	rsi,[32+rsi]
	jmp	NEAR $L$cbc_dec_tail_collected
ALIGN	16
$L$cbc_dec_four:
	movaps	xmm14,xmm5
	call	_aesni_decrypt4
	pxor	xmm2,xmm10
	movaps	xmm10,xmm14
	pxor	xmm3,xmm11
	movdqu	XMMWORD[rsi],xmm2
	pxor	xmm4,xmm12
	movdqu	XMMWORD[16+rsi],xmm3
	pxor	xmm3,xmm3
	pxor	xmm5,xmm13
	movdqu	XMMWORD[32+rsi],xmm4
	pxor	xmm4,xmm4
	movdqa	xmm2,xmm5
	pxor	xmm5,xmm5
	lea	rsi,[48+rsi]
	jmp	NEAR $L$cbc_dec_tail_collected

ALIGN	16
$L$cbc_dec_clear_tail_collected:
	pxor	xmm3,xmm3
	pxor	xmm4,xmm4
	pxor	xmm5,xmm5
$L$cbc_dec_tail_collected:
	movups	XMMWORD[r8],xmm10
	and	rdx,15
	jnz	NEAR $L$cbc_dec_tail_partial
	movups	XMMWORD[rsi],xmm2
	pxor	xmm2,xmm2
	jmp	NEAR $L$cbc_dec_ret
ALIGN	16
$L$cbc_dec_tail_partial:
	movaps	XMMWORD[rsp],xmm2
	pxor	xmm2,xmm2
	mov	rcx,16
	mov	rdi,rsi
	sub	rcx,rdx
	lea	rsi,[rsp]
	DD	0x9066A4F3
	movdqa	XMMWORD[rsp],xmm2

$L$cbc_dec_ret:
	xorps	xmm0,xmm0
	pxor	xmm1,xmm1
	movaps	xmm6,XMMWORD[16+rsp]
	movaps	XMMWORD[16+rsp],xmm0
	movaps	xmm7,XMMWORD[32+rsp]
	movaps	XMMWORD[32+rsp],xmm0
	movaps	xmm8,XMMWORD[48+rsp]
	movaps	XMMWORD[48+rsp],xmm0
	movaps	xmm9,XMMWORD[64+rsp]
	movaps	XMMWORD[64+rsp],xmm0
	movaps	xmm10,XMMWORD[80+rsp]
	movaps	XMMWORD[80+rsp],xmm0
	movaps	xmm11,XMMWORD[96+rsp]
	movaps	XMMWORD[96+rsp],xmm0
	movaps	xmm12,XMMWORD[112+rsp]
	movaps	XMMWORD[112+rsp],xmm0
	movaps	xmm13,XMMWORD[128+rsp]
	movaps	XMMWORD[128+rsp],xmm0
	movaps	xmm14,XMMWORD[144+rsp]
	movaps	XMMWORD[144+rsp],xmm0
	movaps	xmm15,XMMWORD[160+rsp]
	movaps	XMMWORD[160+rsp],xmm0
	mov	rbp,QWORD[((-8))+r11]

	lea	rsp,[r11]

$L$cbc_ret:
	mov	rdi,QWORD[8+rsp]	;WIN64 epilogue
	mov	rsi,QWORD[16+rsp]
	ret

$L$SEH_end_aes_hw_cbc_encrypt:
global	aes_hw_encrypt_key_to_decrypt_key

ALIGN	16
aes_hw_encrypt_key_to_decrypt_key:

_CET_ENDBR

	mov	edx,DWORD[240+rcx]
	shl	edx,4

	lea	r8,[16+rdx*1+rcx]

	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[r8]
	movups	XMMWORD[r8],xmm0
	movups	XMMWORD[rcx],xmm1
	lea	rcx,[16+rcx]
	lea	r8,[((-16))+r8]

$L$dec_key_inverse:
	movups	xmm0,XMMWORD[rcx]
	movups	xmm1,XMMWORD[r8]
	aesimc	xmm0,xmm0
	aesimc	xmm1,xmm1
	lea	rcx,[16+rcx]
	lea	r8,[((-16))+r8]
	movups	XMMWORD[16+r8],xmm0
	movups	XMMWORD[(-16)+rcx],xmm1
	cmp	r8,rcx
	ja	NEAR $L$dec_key_inverse

	movups	xmm0,XMMWORD[rcx]
	aesimc	xmm0,xmm0
	pxor	xmm1,xmm1
	movups	XMMWORD[r8],xmm0
	pxor	xmm0,xmm0
	ret


global	aes_hw_set_encrypt_key_base

ALIGN	16
aes_hw_set_encrypt_key_base:

$L$SEH_begin_aes_hw_set_encrypt_key_base_1:
_CET_ENDBR
%ifdef BORINGSSL_DISPATCH_TEST
	mov	BYTE[((BORINGSSL_function_hit+3))],1
%endif
	sub	rsp,8

$L$SEH_prologue_aes_hw_set_encrypt_key_base_2:
$L$SEH_endprologue_aes_hw_set_encrypt_key_base_3:
	movups	xmm0,XMMWORD[rcx]
	xorps	xmm4,xmm4
	lea	rax,[16+r8]
	cmp	edx,256
	je	NEAR $L$14rounds
	cmp	edx,192
	je	NEAR $L$12rounds
	cmp	edx,128
	jne	NEAR $L$bad_keybits

$L$10rounds:
	mov	edx,9

	movups	XMMWORD[r8],xmm0
	aeskeygenassist	xmm1,xmm0,0x1
	call	$L$key_expansion_128_cold
	aeskeygenassist	xmm1,xmm0,0x2
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x4
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x8
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x10
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x20
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x40
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x80
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x1b
	call	$L$key_expansion_128
	aeskeygenassist	xmm1,xmm0,0x36
	call	$L$key_expansion_128
	movups	XMMWORD[rax],xmm0
	mov	DWORD[80+rax],edx
	xor	eax,eax
	jmp	NEAR $L$enc_key_ret

ALIGN	16
$L$12rounds:
	movq	xmm2,QWORD[16+rcx]
	mov	edx,11

	movups	XMMWORD[r8],xmm0
	aeskeygenassist	xmm1,xmm2,0x1
	call	$L$key_expansion_192a_cold
	aeskeygenassist	xmm1,xmm2,0x2
	call	$L$key_expansion_192b
	aeskeygenassist	xmm1,xmm2,0x4
	call	$L$key_expansion_192a
	aeskeygenassist	xmm1,xmm2,0x8
	call	$L$key_expansion_192b
	aeskeygenassist	xmm1,xmm2,0x10
	call	$L$key_expansion_192a
	aeskeygenassist	xmm1,xmm2,0x20
	call	$L$key_expansion_192b
	aeskeygenassist	xmm1,xmm2,0x40
	call	$L$key_expansion_192a
	aeskeygenassist	xmm1,xmm2,0x80
	call	$L$key_expansion_192b
	movups	XMMWORD[rax],xmm0
	mov	DWORD[48+rax],edx
	xor	rax,rax
	jmp	NEAR $L$enc_key_ret

ALIGN	16
$L$14rounds:
	movups	xmm2,XMMWORD[16+rcx]
	mov	edx,13
	lea	rax,[16+rax]

	movups	XMMWORD[r8],xmm0
	movups	XMMWORD[16+r8],xmm2
	aeskeygenassist	xmm1,xmm2,0x1
	call	$L$key_expansion_256a_cold
	aeskeygenassist	xmm1,xmm0,0x1
	call	$L$key_expansion_256b
	aeskeygenassist	xmm1,xmm2,0x2
	call	$L$key_expansion_256a
	aeskeygenassist	xmm1,xmm0,0x2
	call	$L$key_expansion_256b
	aeskeygenassist	xmm1,xmm2,0x4
	call	$L$key_expansion_256a
	aeskeygenassist	xmm1,xmm0,0x4
	call	$L$key_expansion_256b
	aeskeygenassist	xmm1,xmm2,0x8
	call	$L$key_expansion_256a
	aeskeygenassist	xmm1,xmm0,0x8
	call	$L$key_expansion_256b
	aeskeygenassist	xmm1,xmm2,0x10
	call	$L$key_expansion_256a
	aeskeygenassist	xmm1,xmm0,0x10
	call	$L$key_expansion_256b
	aeskeygenassist	xmm1,xmm2,0x20
	call	$L$key_expansion_256a
	aeskeygenassist	xmm1,xmm0,0x20
	call	$L$key_expansion_256b
	aeskeygenassist	xmm1,xmm2,0x40
	call	$L$key_expansion_256a
	movups	XMMWORD[rax],xmm0
	mov	DWORD[16+rax],edx
	xor	rax,rax
	jmp	NEAR $L$enc_key_ret

ALIGN	16
$L$bad_keybits:
	mov	rax,-2
$L$enc_key_ret:
	pxor	xmm0,xmm0
	pxor	xmm1,xmm1
	pxor	xmm2,xmm2
	pxor	xmm3,xmm3
	pxor	xmm4,xmm4
	pxor	xmm5,xmm5
	add	rsp,8

	ret

$L$SEH_end_aes_hw_set_encrypt_key_base_4:

ALIGN	16
$L$key_expansion_128:

	movups	XMMWORD[rax],xmm0
	lea	rax,[16+rax]
$L$key_expansion_128_cold:
	shufps	xmm4,xmm0,16
	xorps	xmm0,xmm4
	shufps	xmm4,xmm0,140
	xorps	xmm0,xmm4
	shufps	xmm1,xmm1,255
	xorps	xmm0,xmm1
	ret


ALIGN	16
$L$key_expansion_192a:

	movups	XMMWORD[rax],xmm0
	lea	rax,[16+rax]
$L$key_expansion_192a_cold:
	movaps	xmm5,xmm2
$L$key_expansion_192b_warm:
	shufps	xmm4,xmm0,16
	movdqa	xmm3,xmm2
	xorps	xmm0,xmm4
	shufps	xmm4,xmm0,140
	pslldq	xmm3,4
	xorps	xmm0,xmm4
	pshufd	xmm1,xmm1,85
	pxor	xmm2,xmm3
	pxor	xmm0,xmm1
	pshufd	xmm3,xmm0,255
	pxor	xmm2,xmm3
	ret


ALIGN	16
$L$key_expansion_192b:

	movaps	xmm3,xmm0
	shufps	xmm5,xmm0,68
	movups	XMMWORD[rax],xmm5
	shufps	xmm3,xmm2,78
	movups	XMMWORD[16+rax],xmm3
	lea	rax,[32+rax]
	jmp	NEAR $L$key_expansion_192b_warm


ALIGN	16
$L$key_expansion_256a:

	movups	XMMWORD[rax],xmm2
	lea	rax,[16+rax]
$L$key_expansion_256a_cold:
	shufps	xmm4,xmm0,16
	xorps	xmm0,xmm4
	shufps	xmm4,xmm0,140
	xorps	xmm0,xmm4
	shufps	xmm1,xmm1,255
	xorps	xmm0,xmm1
	ret


ALIGN	16
$L$key_expansion_256b:

	movups	XMMWORD[rax],xmm0
	lea	rax,[16+rax]

	shufps	xmm4,xmm2,16
	xorps	xmm2,xmm4
	shufps	xmm4,xmm2,140
	xorps	xmm2,xmm4
	shufps	xmm1,xmm1,170
	xorps	xmm2,xmm1
	ret



global	aes_hw_set_encrypt_key_alt

ALIGN	16
aes_hw_set_encrypt_key_alt:

$L$SEH_begin_aes_hw_set_encrypt_key_alt_1:
_CET_ENDBR
%ifdef BORINGSSL_DISPATCH_TEST
	mov	BYTE[((BORINGSSL_function_hit+3))],1
%endif
	sub	rsp,8

$L$SEH_prologue_aes_hw_set_encrypt_key_alt_2:
$L$SEH_endprologue_aes_hw_set_encrypt_key_alt_3:
	movups	xmm0,XMMWORD[rcx]
	xorps	xmm4,xmm4
	lea	rax,[16+r8]
	cmp	edx,256
	je	NEAR $L$14rounds_alt
	cmp	edx,192
	je	NEAR $L$12rounds_alt
	cmp	edx,128
	jne	NEAR $L$bad_keybits_alt

	mov	edx,9
	movdqa	xmm5,XMMWORD[$L$key_rotate]
	mov	r10d,8
	movdqa	xmm4,XMMWORD[$L$key_rcon1]
	movdqa	xmm2,xmm0
	movdqu	XMMWORD[r8],xmm0
	jmp	NEAR $L$oop_key128

ALIGN	16
$L$oop_key128:
	pshufb	xmm0,xmm5
	aesenclast	xmm0,xmm4
	pslld	xmm4,1
	lea	rax,[16+rax]

	movdqa	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm2,xmm3

	pxor	xmm0,xmm2
	movdqu	XMMWORD[(-16)+rax],xmm0
	movdqa	xmm2,xmm0

	dec	r10d
	jnz	NEAR $L$oop_key128

	movdqa	xmm4,XMMWORD[$L$key_rcon1b]

	pshufb	xmm0,xmm5
	aesenclast	xmm0,xmm4
	pslld	xmm4,1

	movdqa	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm2,xmm3

	pxor	xmm0,xmm2
	movdqu	XMMWORD[rax],xmm0

	movdqa	xmm2,xmm0
	pshufb	xmm0,xmm5
	aesenclast	xmm0,xmm4

	movdqa	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm3,xmm2
	pslldq	xmm2,4
	pxor	xmm2,xmm3

	pxor	xmm0,xmm2
	movdqu	XMMWORD[16+rax],xmm0

	mov	DWORD[96+rax],edx
	xor	eax,eax
	jmp	NEAR $L$enc_key_ret_alt

ALIGN	16
$L$12rounds_alt:
	movq	xmm2,QWORD[16+rcx]
	mov	edx,11
	movdqa	xmm5,XMMWORD[$L$key_rotate192]
	movdqa	xmm4,XMMWORD[$L$key_rcon1]
	mov	r10d,8
	movdqu	XMMWORD[r8],xmm0
	jmp	NEAR $L$oop_key192

ALIGN	16
$L$oop_key192:
	movq	QWORD[rax],xmm2
	movdqa	xmm1,xmm2
	pshufb	xmm2,xmm5
	aesenclast	xmm2,xmm4
	pslld	xmm4,1
	lea	rax,[24+rax]

	movdqa	xmm3,xmm0
	pslldq	xmm0,4
	pxor	xmm3,xmm0
	pslldq	xmm0,4
	pxor	xmm3,xmm0
	pslldq	xmm0,4
	pxor	xmm0,xmm3

	pshufd	xmm3,xmm0,0xff
	pxor	xmm3,xmm1
	pslldq	xmm1,4
	pxor	xmm3,xmm1

	pxor	xmm0,xmm2
	pxor	xmm2,xmm3
	movdqu	XMMWORD[(-16)+rax],xmm0

	dec	r10d
	jnz	NEAR $L$oop_key192

	mov	DWORD[32+rax],edx
	xor	eax,eax
	jmp	NEAR $L$enc_key_ret_alt

ALIGN	16
$L$14rounds_alt:
	movups	xmm2,XMMWORD[16+rcx]
	mov	edx,13
	lea	rax,[16+rax]
	movdqa	xmm5,XMMWORD[$L$key_rotate]
	movdqa	xmm4,XMMWORD[$L$key_rcon1]
	mov	r10d,7
	movdqu	XMMWORD[r8],xmm0
	movdqa	xmm1,xmm2
	movdqu	XMMWORD[16+r8],xmm2
	jmp	NEAR $L$oop_key256

ALIGN	16
$L$oop_key256:
	pshufb	xmm2,xmm5
	aesenclast	xmm2,xmm4

	movdqa	xmm3,xmm0
	pslldq	xmm0,4
	pxor	xmm3,xmm0
	pslldq	xmm0,4
	pxor	xmm3,xmm0
	pslldq	xmm0,4
	pxor	xmm0,xmm3
	pslld	xmm4,1

	pxor	xmm0,xmm2
	movdqu	XMMWORD[rax],xmm0

	dec	r10d
	jz	NEAR $L$done_key256

	pshufd	xmm2,xmm0,0xff
	pxor	xmm3,xmm3
	aesenclast	xmm2,xmm3

	movdqa	xmm3,xmm1
	pslldq	xmm1,4
	pxor	xmm3,xmm1
	pslldq	xmm1,4
	pxor	xmm3,xmm1
	pslldq	xmm1,4
	pxor	xmm1,xmm3

	pxor	xmm2,xmm1
	movdqu	XMMWORD[16+rax],xmm2
	lea	rax,[32+rax]
	movdqa	xmm1,xmm2

	jmp	NEAR $L$oop_key256

$L$done_key256:
	mov	DWORD[16+rax],edx
	xor	eax,eax
	jmp	NEAR $L$enc_key_ret_alt

ALIGN	16
$L$bad_keybits_alt:
	mov	rax,-2
$L$enc_key_ret_alt:
	pxor	xmm0,xmm0
	pxor	xmm1,xmm1
	pxor	xmm2,xmm2
	pxor	xmm3,xmm3
	pxor	xmm4,xmm4
	pxor	xmm5,xmm5
	add	rsp,8

	ret

$L$SEH_end_aes_hw_set_encrypt_key_alt_4:

section	.rdata rdata align=8
ALIGN	64
$L$bswap_mask:
	DB	15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0
$L$increment32:
	DD	6,6,6,0
$L$increment64:
	DD	1,0,0,0
$L$xts_magic:
	DD	0x87,0,1,0
$L$increment1:
	DB	0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1
$L$key_rotate:
	DD	0x0c0f0e0d,0x0c0f0e0d,0x0c0f0e0d,0x0c0f0e0d
$L$key_rotate192:
	DD	0x04070605,0x04070605,0x04070605,0x04070605
$L$key_rcon1:
	DD	1,1,1,1
$L$key_rcon1b:
	DD	0x1b,0x1b,0x1b,0x1b

	DB	65,69,83,32,102,111,114,32,73,110,116,101,108,32,65,69
	DB	83,45,78,73,44,32,67,82,89,80,84,79,71,65,77,83
	DB	32,98,121,32,60,97,112,112,114,111,64,111,112,101,110,115
	DB	115,108,46,111,114,103,62,0
ALIGN	64
section	.text

EXTERN	__imp_RtlVirtualUnwind

ALIGN	16
ecb_ccm64_se_handler:
	push	rsi
	push	rdi
	push	rbx
	push	rbp
	push	r12
	push	r13
	push	r14
	push	r15
	pushfq
	sub	rsp,64

	mov	rax,QWORD[120+r8]
	mov	rbx,QWORD[248+r8]

	mov	rsi,QWORD[8+r9]
	mov	r11,QWORD[56+r9]

	mov	r10d,DWORD[r11]
	lea	r10,[r10*1+rsi]
	cmp	rbx,r10
	jb	NEAR $L$common_seh_tail

	mov	rax,QWORD[152+r8]

	mov	r10d,DWORD[4+r11]
	lea	r10,[r10*1+rsi]
	cmp	rbx,r10
	jae	NEAR $L$common_seh_tail

	lea	rsi,[rax]
	lea	rdi,[512+r8]
	mov	ecx,8
	DD	0xa548f3fc
	lea	rax,[88+rax]

	jmp	NEAR $L$common_seh_tail



ALIGN	16
ctr_xts_se_handler:
	push	rsi
	push	rdi
	push	rbx
	push	rbp
	push	r12
	push	r13
	push	r14
	push	r15
	pushfq
	sub	rsp,64

	mov	rax,QWORD[120+r8]
	mov	rbx,QWORD[248+r8]

	mov	rsi,QWORD[8+r9]
	mov	r11,QWORD[56+r9]

	mov	r10d,DWORD[r11]
	lea	r10,[r10*1+rsi]
	cmp	rbx,r10
	jb	NEAR $L$common_seh_tail

	mov	rax,QWORD[152+r8]

	mov	r10d,DWORD[4+r11]
	lea	r10,[r10*1+rsi]
	cmp	rbx,r10
	jae	NEAR $L$common_seh_tail

	mov	rax,QWORD[208+r8]

	lea	rsi,[((-168))+rax]
	lea	rdi,[512+r8]
	mov	ecx,20
	DD	0xa548f3fc

	mov	rbp,QWORD[((-8))+rax]
	mov	QWORD[160+r8],rbp
	jmp	NEAR $L$common_seh_tail



ALIGN	16
cbc_se_handler:
	push	rsi
	push	rdi
	push	rbx
	push	rbp
	push	r12
	push	r13
	push	r14
	push	r15
	pushfq
	sub	rsp,64

	mov	rax,QWORD[152+r8]
	mov	rbx,QWORD[248+r8]

	lea	r10,[$L$cbc_decrypt_bulk]
	cmp	rbx,r10
	jb	NEAR $L$common_seh_tail

	mov	rax,QWORD[120+r8]

	lea	r10,[$L$cbc_decrypt_body]
	cmp	rbx,r10
	jb	NEAR $L$common_seh_tail

	mov	rax,QWORD[152+r8]

	lea	r10,[$L$cbc_ret]
	cmp	rbx,r10
	jae	NEAR $L$common_seh_tail

	lea	rsi,[16+rax]
	lea	rdi,[512+r8]
	mov	ecx,20
	DD	0xa548f3fc

	mov	rax,QWORD[208+r8]

	mov	rbp,QWORD[((-8))+rax]
	mov	QWORD[160+r8],rbp

$L$common_seh_tail:
	mov	rdi,QWORD[8+rax]
	mov	rsi,QWORD[16+rax]
	mov	QWORD[152+r8],rax
	mov	QWORD[168+r8],rsi
	mov	QWORD[176+r8],rdi

	mov	rdi,QWORD[40+r9]
	mov	rsi,r8
	mov	ecx,154
	DD	0xa548f3fc

	mov	rsi,r9
	xor	rcx,rcx
	mov	rdx,QWORD[8+rsi]
	mov	r8,QWORD[rsi]
	mov	r9,QWORD[16+rsi]
	mov	r10,QWORD[40+rsi]
	lea	r11,[56+rsi]
	lea	r12,[24+rsi]
	mov	QWORD[32+rsp],r10
	mov	QWORD[40+rsp],r11
	mov	QWORD[48+rsp],r12
	mov	QWORD[56+rsp],rcx
	call	QWORD[__imp_RtlVirtualUnwind]

	mov	eax,1
	add	rsp,64
	popfq
	pop	r15
	pop	r14
	pop	r13
	pop	r12
	pop	rbp
	pop	rbx
	pop	rdi
	pop	rsi
	ret


section	.pdata rdata align=4
ALIGN	4
	DD	$L$SEH_begin_aes_hw_ecb_encrypt wrt ..imagebase
	DD	$L$SEH_end_aes_hw_ecb_encrypt wrt ..imagebase
	DD	$L$SEH_info_ecb wrt ..imagebase

	DD	$L$SEH_begin_aes_hw_ctr32_encrypt_blocks wrt ..imagebase
	DD	$L$SEH_end_aes_hw_ctr32_encrypt_blocks wrt ..imagebase
	DD	$L$SEH_info_ctr32 wrt ..imagebase
	DD	$L$SEH_begin_aes_hw_cbc_encrypt wrt ..imagebase
	DD	$L$SEH_end_aes_hw_cbc_encrypt wrt ..imagebase
	DD	$L$SEH_info_cbc wrt ..imagebase
section	.xdata rdata align=8
ALIGN	8
$L$SEH_info_ecb:
	DB	9,0,0,0
	DD	ecb_ccm64_se_handler wrt ..imagebase
	DD	$L$ecb_enc_body wrt ..imagebase,$L$ecb_enc_ret wrt ..imagebase
$L$SEH_info_ctr32:
	DB	9,0,0,0
	DD	ctr_xts_se_handler wrt ..imagebase
	DD	$L$ctr32_body wrt ..imagebase,$L$ctr32_epilogue wrt ..imagebase
$L$SEH_info_cbc:
	DB	9,0,0,0
	DD	cbc_se_handler wrt ..imagebase
section	.pdata
ALIGN	4
	DD	$L$SEH_begin_aes_hw_set_encrypt_key_base_1 wrt ..imagebase
	DD	$L$SEH_end_aes_hw_set_encrypt_key_base_4 wrt ..imagebase
	DD	$L$SEH_info_aes_hw_set_encrypt_key_base_0 wrt ..imagebase

	DD	$L$SEH_begin_aes_hw_set_encrypt_key_alt_1 wrt ..imagebase
	DD	$L$SEH_end_aes_hw_set_encrypt_key_alt_4 wrt ..imagebase
	DD	$L$SEH_info_aes_hw_set_encrypt_key_alt_0 wrt ..imagebase


section	.xdata
ALIGN	4
$L$SEH_info_aes_hw_set_encrypt_key_base_0:
	DB	1
	DB	$L$SEH_endprologue_aes_hw_set_encrypt_key_base_3-$L$SEH_begin_aes_hw_set_encrypt_key_base_1
	DB	1
	DB	0
	DB	$L$SEH_prologue_aes_hw_set_encrypt_key_base_2-$L$SEH_begin_aes_hw_set_encrypt_key_base_1
	DB	2

	DW	0
$L$SEH_info_aes_hw_set_encrypt_key_alt_0:
	DB	1
	DB	$L$SEH_endprologue_aes_hw_set_encrypt_key_alt_3-$L$SEH_begin_aes_hw_set_encrypt_key_alt_1
	DB	1
	DB	0
	DB	$L$SEH_prologue_aes_hw_set_encrypt_key_alt_2-$L$SEH_begin_aes_hw_set_encrypt_key_alt_1
	DB	2

	DW	0
%else
; Work around https://bugzilla.nasm.us/show_bug.cgi?id=3392738
ret
%endif
