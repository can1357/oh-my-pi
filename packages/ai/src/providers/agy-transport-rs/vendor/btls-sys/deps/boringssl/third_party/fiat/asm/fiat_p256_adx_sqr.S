#include <openssl/asm_base.h>

#if !defined(OPENSSL_NO_ASM) && defined(OPENSSL_X86_64) && \
    (defined(__APPLE__) || defined(__ELF__))

.text
#if defined(__APPLE__)
.private_extern _fiat_p256_adx_sqr
.global _fiat_p256_adx_sqr
_fiat_p256_adx_sqr:
#else
.type fiat_p256_adx_sqr, @function
.hidden fiat_p256_adx_sqr
.global fiat_p256_adx_sqr
fiat_p256_adx_sqr:
#endif

.cfi_startproc
_CET_ENDBR
pushq %rbp
.cfi_adjust_cfa_offset 8
.cfi_offset rbp, -16
movq %rsp, %rbp
movq (%rsi), %rdx
mulxq 0x18(%rsi), %rax, %r10
mulxq %rdx, %r11, %rcx
mulxq 0x8(%rsi), %r8, %r9
movq %rbx, -0x80(%rsp)
.cfi_offset rbx, -16-0x80
xorq %rbx, %rbx
adoxq %r8, %r8
movq %r12, -0x78(%rsp)
.cfi_offset r12, -16-0x78
mulxq 0x10(%rsi), %rbx, %r12
movq 0x8(%rsi), %rdx
movq %r13, -0x70(%rsp)
.cfi_offset r13, -16-0x70
movq %r14, -0x68(%rsp)
.cfi_offset r14, -16-0x68
mulxq %rdx, %r13, %r14
movq %r15, -0x60(%rsp)
.cfi_offset r15, -16-0x60
movq %rdi, -0x58(%rsp)
mulxq 0x10(%rsi), %r15, %rdi
adcxq %r15, %r12
movq %r11, -0x50(%rsp)
mulxq 0x18(%rsi), %r15, %r11
adcxq %rdi, %r10
movq $0x0, %rdi
adcxq %rdi, %r11
clc
adcxq %r9, %rbx
adoxq %rbx, %rbx
adcxq %r12, %rax
adoxq %rax, %rax
adcxq %r10, %r15
adoxq %r15, %r15
movq 0x10(%rsi), %rdx
mulxq 0x18(%rsi), %r9, %r12
adcxq %r11, %r9
adcxq %rdi, %r12
mulxq %rdx, %r10, %r11
clc
adcxq %r8, %rcx
adcxq %rbx, %r13
adcxq %rax, %r14
adoxq %r9, %r9
adcxq %r15, %r10
movq 0x18(%rsi), %rdx
mulxq %rdx, %r8, %rbx
adoxq %r12, %r12
adcxq %r9, %r11
movq -0x50(%rsp), %rsi
adcxq %r12, %r8
movq $0x100000000, %rax
movq %rax, %rdx
mulxq %rsi, %rax, %r15
adcxq %rdi, %rbx
adoxq %rdi, %rbx
xorq %r9, %r9
adoxq %rcx, %rax
adoxq %r13, %r15
mulxq %rax, %rdi, %rcx
adcxq %r15, %rdi
adoxq %r14, %rcx
movq $0xffffffff00000001, %rdx
mulxq %rsi, %r13, %r14
adoxq %r10, %r14
adcxq %rcx, %r13
mulxq %rax, %r10, %r12
adoxq %r11, %r12
movq %r9, %r11
adoxq %r8, %r11
adcxq %r14, %r10
movq %r9, %r8
adcxq %r12, %r8
movq %r9, %rax
adcxq %r11, %rax
movq %r9, %r15
adoxq %rbx, %r15
movq $0x100000000, %rdx
mulxq %rdi, %rbx, %rcx
movq %r9, %r14
adcxq %r15, %r14
movq %r9, %r12
adoxq %r12, %r12
adcxq %r9, %r12
adoxq %r13, %rbx
mulxq %rbx, %r13, %r11
movq $0xffffffff00000001, %r15
movq %r15, %rdx
mulxq %rbx, %r15, %rsi
adoxq %r10, %rcx
adoxq %r8, %r11
mulxq %rdi, %r10, %r8
adcxq %rcx, %r13
adoxq %rax, %r8
adcxq %r11, %r10
adoxq %r14, %rsi
movq %r12, %rdi
movq %r9, %rax
adoxq %rax, %rdi
adcxq %r8, %r15
movq %rax, %r14
adcxq %rsi, %r14
adcxq %r9, %rdi
decq %r9
movq %r13, %rbx
subq %r9, %rbx
movq $0xffffffff, %rcx
movq %r10, %r11
sbbq %rcx, %r11
movq %r15, %r8
sbbq %rax, %r8
movq %r14, %rsi
sbbq %rdx, %rsi
sbbq %rax, %rdi
cmovcq %r13, %rbx
cmovcq %r15, %r8
cmovcq %r10, %r11
cmovcq %r14, %rsi
movq -0x58(%rsp), %rdi
movq %rsi, 0x18(%rdi)
movq %rbx, (%rdi)
movq %r11, 0x8(%rdi)
movq %r8, 0x10(%rdi)
movq -0x80(%rsp), %rbx
.cfi_restore rbx
movq -0x78(%rsp), %r12
.cfi_restore r12
movq -0x70(%rsp), %r13
.cfi_restore r13
movq -0x68(%rsp), %r14
.cfi_restore r14
movq -0x60(%rsp), %r15
.cfi_restore r15
popq %rbp
.cfi_restore rbp
.cfi_adjust_cfa_offset -8
retq
.cfi_endproc
#if defined(__ELF__)
.size fiat_p256_adx_sqr, .-fiat_p256_adx_sqr
#endif

#endif
