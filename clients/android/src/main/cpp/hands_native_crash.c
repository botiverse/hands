/*
 * Async-signal-safe native crash capture (QNC2, task #120).
 *
 * QNC1 unwound from this signal handler and discarded ucontext, so the first
 * frame described the recorder rather than the crashing thread. QNC2 treats
 * the kernel-provided ucontext as the source of truth: it records the crash
 * thread's registers, PC/LR/SP, pid/tid/name, siginfo, a precomputed loaded
 * image BuildId snapshot, and /proc/self/maps. The Kotlin next-launch path
 * joins context PCs to those images and the server refuses to symbolicate a
 * frame unless its ELF BuildId exactly matches the uploaded symbols archive.
 *
 * The handler itself uses only bounded stack/static storage and
 * async-signal-safe system calls. Loaded-image enumeration and ELF note
 * parsing happen once during nativeInstall, before handlers are installed.
 */
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <link.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>

#include "hands_record_file.h"

#define HANDS_DIR_MAX 512
#define HANDS_MAX_MODULES 192
#define HANDS_MODULE_PATH_MAX 384
#define HANDS_BUILD_ID_MAX 32

struct hands_module {
  uintptr_t start;
  uintptr_t end;
  unsigned char build_id[HANDS_BUILD_ID_MAX];
  size_t build_id_size;
  char path[HANDS_MODULE_PATH_MAX];
};

static char g_crash_dir[HANDS_DIR_MAX];
static volatile sig_atomic_t g_handling = 0;
static int g_fatal_signals[] = {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static struct sigaction g_previous[sizeof(g_fatal_signals) / sizeof(int)];
static char g_altstack[SIGSTKSZ * 2];
static struct hands_module g_modules[HANDS_MAX_MODULES];
static size_t g_module_count = 0;

static size_t hands_strlen(const char *text) {
  size_t n = 0;
  if (text == NULL) return 0;
  while (text[n] != '\0') n++;
  return n;
}

static size_t hands_append(char *buf, size_t cap, size_t off, const char *text) {
  size_t n = hands_strlen(text);
  if (off + n >= cap) return off;
  for (size_t i = 0; i < n; i++) buf[off + i] = text[i];
  buf[off + n] = '\0';
  return off + n;
}

static size_t hands_append_hex(char *buf, size_t cap, size_t off, uint64_t value) {
  char tmp[19];
  int i = 18;
  tmp[i--] = '\0';
  if (value == 0) tmp[i--] = '0';
  while (value != 0 && i >= 0) {
    static const char digits[] = "0123456789abcdef";
    tmp[i--] = digits[value & 0xf];
    value >>= 4;
  }
  return hands_append(buf, cap, off, &tmp[i + 1]);
}

static size_t hands_append_dec(char *buf, size_t cap, size_t off, uint64_t value) {
  char tmp[21];
  int i = 20;
  tmp[i--] = '\0';
  if (value == 0) tmp[i--] = '0';
  while (value != 0 && i >= 0) {
    tmp[i--] = (char)('0' + (value % 10));
    value /= 10;
  }
  return hands_append(buf, cap, off, &tmp[i + 1]);
}

static size_t hands_append_signed_dec(char *buf, size_t cap, size_t off, int64_t value) {
  if (value < 0) {
    off = hands_append(buf, cap, off, "-");
    /* Avoid signed overflow for INT64_MIN. */
    return hands_append_dec(buf, cap, off, (uint64_t)(-(value + 1)) + 1U);
  }
  return hands_append_dec(buf, cap, off, (uint64_t)value);
}

static void hands_write_all(int fd, const void *data, size_t size) {
  const char *bytes = (const char *)data;
  size_t written = 0;
  while (written < size) {
    ssize_t n = write(fd, bytes + written, size - written);
    if (n > 0) {
      written += (size_t)n;
    } else if (n < 0 && errno == EINTR) {
      continue;
    } else {
      break;
    }
  }
}

static void hands_write_text(int fd, const char *text) {
  hands_write_all(fd, text, hands_strlen(text));
}

static void hands_write_key_hex(int fd, const char *key, uint64_t value) {
  char line[96];
  size_t off = 0;
  off = hands_append(line, sizeof(line), off, key);
  off = hands_append(line, sizeof(line), off, " 0x");
  off = hands_append_hex(line, sizeof(line), off, value);
  off = hands_append(line, sizeof(line), off, "\n");
  hands_write_all(fd, line, off);
}

static void hands_write_key_dec(int fd, const char *key, uint64_t value) {
  char line[96];
  size_t off = 0;
  off = hands_append(line, sizeof(line), off, key);
  off = hands_append(line, sizeof(line), off, " ");
  off = hands_append_dec(line, sizeof(line), off, value);
  off = hands_append(line, sizeof(line), off, "\n");
  hands_write_all(fd, line, off);
}

static void hands_write_key_signed_dec(int fd, const char *key, int64_t value) {
  char line[96];
  size_t off = 0;
  off = hands_append(line, sizeof(line), off, key);
  off = hands_append(line, sizeof(line), off, " ");
  off = hands_append_signed_dec(line, sizeof(line), off, value);
  off = hands_append(line, sizeof(line), off, "\n");
  hands_write_all(fd, line, off);
}

static uintptr_t hands_align4(uintptr_t value) {
  return (value + 3U) & ~(uintptr_t)3U;
}

static void hands_copy_bounded(char *dst, size_t cap, const char *src) {
  if (cap == 0) return;
  size_t i = 0;
  if (src != NULL) {
    while (i + 1 < cap && src[i] != '\0') {
      dst[i] = src[i];
      i++;
    }
  }
  dst[i] = '\0';
}

/* Called only at install time, never from a signal handler. */
static int hands_collect_module(struct dl_phdr_info *info, size_t size, void *data) {
  (void)size;
  (void)data;
  if (g_module_count >= HANDS_MAX_MODULES || info == NULL || info->dlpi_phdr == NULL) return 0;

  uintptr_t start = UINTPTR_MAX;
  uintptr_t end = 0;
  const unsigned char *build_id = NULL;
  size_t build_id_size = 0;

  for (ElfW(Half) i = 0; i < info->dlpi_phnum; i++) {
    const ElfW(Phdr) *phdr = &info->dlpi_phdr[i];
    if (phdr->p_type == PT_LOAD && phdr->p_memsz > 0) {
      uintptr_t segment_start = (uintptr_t)info->dlpi_addr + (uintptr_t)phdr->p_vaddr;
      uintptr_t segment_end = segment_start + (uintptr_t)phdr->p_memsz;
      if (segment_start < start) start = segment_start;
      if (segment_end > end) end = segment_end;
    }
    if (phdr->p_type != PT_NOTE || phdr->p_memsz < sizeof(ElfW(Nhdr))) continue;

    const unsigned char *cursor =
        (const unsigned char *)((uintptr_t)info->dlpi_addr + (uintptr_t)phdr->p_vaddr);
    const unsigned char *limit = cursor + (size_t)phdr->p_memsz;
    while ((size_t)(limit - cursor) >= sizeof(ElfW(Nhdr))) {
      const ElfW(Nhdr) *note = (const ElfW(Nhdr) *)cursor;
      cursor += sizeof(ElfW(Nhdr));
      uintptr_t name_size = hands_align4((uintptr_t)note->n_namesz);
      uintptr_t desc_size = hands_align4((uintptr_t)note->n_descsz);
      if (name_size > (uintptr_t)(limit - cursor)) break;
      const unsigned char *name = cursor;
      cursor += name_size;
      if (desc_size > (uintptr_t)(limit - cursor)) break;
      const unsigned char *desc = cursor;
      cursor += desc_size;
      if (note->n_type == NT_GNU_BUILD_ID && note->n_namesz >= 3 &&
          name[0] == 'G' && name[1] == 'N' && name[2] == 'U' && note->n_descsz > 0) {
        build_id = desc;
        build_id_size = note->n_descsz;
        break;
      }
    }
  }

  if (start == UINTPTR_MAX || end <= start) return 0;
  struct hands_module *module = &g_modules[g_module_count++];
  module->start = start;
  module->end = end;
  module->build_id_size = build_id_size > HANDS_BUILD_ID_MAX ? HANDS_BUILD_ID_MAX : build_id_size;
  for (size_t i = 0; i < module->build_id_size; i++) module->build_id[i] = build_id[i];
  hands_copy_bounded(module->path, sizeof(module->path),
                     info->dlpi_name != NULL && info->dlpi_name[0] != '\0'
                         ? info->dlpi_name
                         : "/proc/self/exe");
  return 0;
}

static void hands_refresh_modules(void) {
  g_module_count = 0;
  memset(g_modules, 0, sizeof(g_modules));
  dl_iterate_phdr(hands_collect_module, NULL);
}

static void hands_write_thread_name(int fd, pid_t tid) {
  char path[96];
  size_t off = 0;
  off = hands_append(path, sizeof(path), off, "/proc/self/task/");
  off = hands_append_dec(path, sizeof(path), off, (uint64_t)tid);
  off = hands_append(path, sizeof(path), off, "/comm");
  int name_fd = open(path, O_RDONLY);
  if (name_fd < 0) return;
  unsigned char name[64];
  ssize_t n = read(name_fd, name, sizeof(name));
  close(name_fd);
  if (n <= 0) return;
  while (n > 0 && (name[n - 1] == '\n' || name[n - 1] == '\r' || name[n - 1] == '\0')) n--;

  static const char digits[] = "0123456789abcdef";
  char line[160];
  off = 0;
  off = hands_append(line, sizeof(line), off, "thread_name_hex ");
  for (ssize_t i = 0; i < n && off + 2 < sizeof(line); i++) {
    line[off++] = digits[(name[i] >> 4) & 0xf];
    line[off++] = digits[name[i] & 0xf];
  }
  line[off++] = '\n';
  hands_write_all(fd, line, off);
}

static void hands_write_frame(int fd, uintptr_t pc, const char *source) {
  if (pc == 0) return;
  char line[96];
  size_t off = 0;
  off = hands_append(line, sizeof(line), off, "0x");
  off = hands_append_hex(line, sizeof(line), off, (uint64_t)pc);
  off = hands_append(line, sizeof(line), off, " ");
  off = hands_append(line, sizeof(line), off, source);
  off = hands_append(line, sizeof(line), off, "\n");
  hands_write_all(fd, line, off);
}

static void hands_write_context(int fd, void *ucontext) {
  uintptr_t pc = 0;
  uintptr_t lr = 0;
  hands_write_text(fd, "registers\n");
  if (ucontext == NULL) {
    hands_write_text(fd, "frames\n");
    return;
  }
  const ucontext_t *context = (const ucontext_t *)ucontext;
  hands_write_key_hex(fd, "uc_flags", (uint64_t)context->uc_flags);

#if defined(__aarch64__)
  hands_write_text(fd, "arch arm64-v8a\n");
  for (int i = 0; i < 31; i++) {
    char name[8];
    size_t off = 0;
    off = hands_append(name, sizeof(name), off, "x");
    off = hands_append_dec(name, sizeof(name), off, (uint64_t)i);
    name[off] = '\0';
    hands_write_key_hex(fd, name, (uint64_t)context->uc_mcontext.regs[i]);
  }
  hands_write_key_hex(fd, "sp", (uint64_t)context->uc_mcontext.sp);
  hands_write_key_hex(fd, "pc", (uint64_t)context->uc_mcontext.pc);
  hands_write_key_hex(fd, "pstate", (uint64_t)context->uc_mcontext.pstate);
  hands_write_key_hex(fd, "fault_address", (uint64_t)context->uc_mcontext.fault_address);
  pc = (uintptr_t)context->uc_mcontext.pc;
  lr = (uintptr_t)context->uc_mcontext.regs[30];
#elif defined(__arm__)
  hands_write_text(fd, "arch armeabi-v7a\n");
  hands_write_key_hex(fd, "r0", (uint64_t)context->uc_mcontext.arm_r0);
  hands_write_key_hex(fd, "r1", (uint64_t)context->uc_mcontext.arm_r1);
  hands_write_key_hex(fd, "r2", (uint64_t)context->uc_mcontext.arm_r2);
  hands_write_key_hex(fd, "r3", (uint64_t)context->uc_mcontext.arm_r3);
  hands_write_key_hex(fd, "r4", (uint64_t)context->uc_mcontext.arm_r4);
  hands_write_key_hex(fd, "r5", (uint64_t)context->uc_mcontext.arm_r5);
  hands_write_key_hex(fd, "r6", (uint64_t)context->uc_mcontext.arm_r6);
  hands_write_key_hex(fd, "r7", (uint64_t)context->uc_mcontext.arm_r7);
  hands_write_key_hex(fd, "r8", (uint64_t)context->uc_mcontext.arm_r8);
  hands_write_key_hex(fd, "r9", (uint64_t)context->uc_mcontext.arm_r9);
  hands_write_key_hex(fd, "r10", (uint64_t)context->uc_mcontext.arm_r10);
  hands_write_key_hex(fd, "fp", (uint64_t)context->uc_mcontext.arm_fp);
  hands_write_key_hex(fd, "ip", (uint64_t)context->uc_mcontext.arm_ip);
  hands_write_key_hex(fd, "sp", (uint64_t)context->uc_mcontext.arm_sp);
  hands_write_key_hex(fd, "lr", (uint64_t)context->uc_mcontext.arm_lr);
  hands_write_key_hex(fd, "pc", (uint64_t)context->uc_mcontext.arm_pc);
  hands_write_key_hex(fd, "cpsr", (uint64_t)context->uc_mcontext.arm_cpsr);
  hands_write_key_hex(fd, "fault_address", (uint64_t)context->uc_mcontext.fault_address);
  pc = (uintptr_t)context->uc_mcontext.arm_pc & ~(uintptr_t)1U;
  lr = (uintptr_t)context->uc_mcontext.arm_lr & ~(uintptr_t)1U;
#elif defined(__x86_64__)
  hands_write_text(fd, "arch x86_64\n");
  hands_write_key_hex(fd, "r8", (uint64_t)context->uc_mcontext.gregs[REG_R8]);
  hands_write_key_hex(fd, "r9", (uint64_t)context->uc_mcontext.gregs[REG_R9]);
  hands_write_key_hex(fd, "r10", (uint64_t)context->uc_mcontext.gregs[REG_R10]);
  hands_write_key_hex(fd, "r11", (uint64_t)context->uc_mcontext.gregs[REG_R11]);
  hands_write_key_hex(fd, "r12", (uint64_t)context->uc_mcontext.gregs[REG_R12]);
  hands_write_key_hex(fd, "r13", (uint64_t)context->uc_mcontext.gregs[REG_R13]);
  hands_write_key_hex(fd, "r14", (uint64_t)context->uc_mcontext.gregs[REG_R14]);
  hands_write_key_hex(fd, "r15", (uint64_t)context->uc_mcontext.gregs[REG_R15]);
  hands_write_key_hex(fd, "rdi", (uint64_t)context->uc_mcontext.gregs[REG_RDI]);
  hands_write_key_hex(fd, "rsi", (uint64_t)context->uc_mcontext.gregs[REG_RSI]);
  hands_write_key_hex(fd, "rbp", (uint64_t)context->uc_mcontext.gregs[REG_RBP]);
  hands_write_key_hex(fd, "rbx", (uint64_t)context->uc_mcontext.gregs[REG_RBX]);
  hands_write_key_hex(fd, "rdx", (uint64_t)context->uc_mcontext.gregs[REG_RDX]);
  hands_write_key_hex(fd, "rax", (uint64_t)context->uc_mcontext.gregs[REG_RAX]);
  hands_write_key_hex(fd, "rcx", (uint64_t)context->uc_mcontext.gregs[REG_RCX]);
  hands_write_key_hex(fd, "rsp", (uint64_t)context->uc_mcontext.gregs[REG_RSP]);
  hands_write_key_hex(fd, "rip", (uint64_t)context->uc_mcontext.gregs[REG_RIP]);
  hands_write_key_hex(fd, "eflags", (uint64_t)context->uc_mcontext.gregs[REG_EFL]);
  hands_write_key_hex(fd, "trapno", (uint64_t)context->uc_mcontext.gregs[REG_TRAPNO]);
  hands_write_key_hex(fd, "error", (uint64_t)context->uc_mcontext.gregs[REG_ERR]);
  hands_write_key_hex(fd, "cr2", (uint64_t)context->uc_mcontext.gregs[REG_CR2]);
  pc = (uintptr_t)context->uc_mcontext.gregs[REG_RIP];
#else
  hands_write_text(fd, "arch unknown\n");
#endif

  hands_write_text(fd, "frames\n");
  hands_write_frame(fd, pc, "context_pc");
  if (lr != 0 && lr != pc) hands_write_frame(fd, lr, "context_lr");
}

static void hands_write_modules(int fd) {
  hands_write_text(fd, "modules\n");
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < g_module_count; i++) {
    const struct hands_module *module = &g_modules[i];
    char line[HANDS_MODULE_PATH_MAX + 192];
    size_t off = 0;
    off = hands_append(line, sizeof(line), off, "0x");
    off = hands_append_hex(line, sizeof(line), off, (uint64_t)module->start);
    off = hands_append(line, sizeof(line), off, "-0x");
    off = hands_append_hex(line, sizeof(line), off, (uint64_t)module->end);
    off = hands_append(line, sizeof(line), off, " ");
    if (module->build_id_size == 0) {
      off = hands_append(line, sizeof(line), off, "-");
    } else {
      for (size_t j = 0; j < module->build_id_size && off + 2 < sizeof(line); j++) {
        line[off++] = digits[(module->build_id[j] >> 4) & 0xf];
        line[off++] = digits[module->build_id[j] & 0xf];
      }
    }
    off = hands_append(line, sizeof(line), off, " ");
    off = hands_append(line, sizeof(line), off, module->path);
    off = hands_append(line, sizeof(line), off, "\n");
    hands_write_all(fd, line, off);
  }
}

static void hands_copy_maps(int out_fd) {
  int maps_fd = open("/proc/self/maps", O_RDONLY);
  if (maps_fd < 0) return;
  char chunk[4096];
  ssize_t n;
  while ((n = read(maps_fd, chunk, sizeof(chunk))) > 0) {
    hands_write_all(out_fd, chunk, (size_t)n);
  }
  close(maps_fd);
}

static void hands_signal_handler(int signo, siginfo_t *info, void *ucontext) {
  if (g_handling) {
    signal(signo, SIG_DFL);
    raise(signo);
    return;
  }
  g_handling = 1;
  if (g_crash_dir[0] != '\0') {
    struct timespec now;
    uint64_t ts = clock_gettime(CLOCK_REALTIME, &now) == 0
        ? (uint64_t)now.tv_sec * 1000U + (uint64_t)now.tv_nsec / 1000000U
        : (uint64_t)time(NULL) * 1000U;
    pid_t tid = (pid_t)syscall(__NR_gettid);

    char path[HANDS_DIR_MAX + 64];
    int fd = hands_open_crash_record(g_crash_dir, ts, getpid(), tid, path, sizeof(path));
    if (fd >= 0) {
      hands_write_text(fd, "QNC2\n");
      hands_write_key_dec(fd, "signal", (uint64_t)signo);
      hands_write_key_signed_dec(fd, "signal_code", info != NULL ? (int64_t)info->si_code : 0);
      hands_write_key_hex(fd, "fault_addr", (uint64_t)(uintptr_t)(info != NULL ? info->si_addr : 0));
      hands_write_key_dec(fd, "crash_at", ts);
      hands_write_key_dec(fd, "pid", (uint64_t)getpid());
      hands_write_key_dec(fd, "tid", (uint64_t)tid);
      hands_write_thread_name(fd, tid);
      hands_write_context(fd, ucontext);
      hands_write_modules(fd);
      hands_write_text(fd, "maps\n");
      hands_copy_maps(fd);
      close(fd);
    }
  }

  /* Restore and re-raise so debuggerd and any previously installed handler run. */
  for (size_t i = 0; i < sizeof(g_fatal_signals) / sizeof(int); i++) {
    if (g_fatal_signals[i] == signo) {
      sigaction(signo, &g_previous[i], NULL);
      raise(signo);
      return;
    }
  }
  signal(signo, SIG_DFL);
  raise(signo);
}

JNIEXPORT void JNICALL
Java_build_hands_update_HandsNativeCrash_nativeInstall(JNIEnv *env, jclass clazz, jstring crash_dir) {
  (void)clazz;
  const char *dir = (*env)->GetStringUTFChars(env, crash_dir, NULL);
  if (dir == NULL) return;
  strncpy(g_crash_dir, dir, sizeof(g_crash_dir) - 1);
  g_crash_dir[sizeof(g_crash_dir) - 1] = '\0';
  (*env)->ReleaseStringUTFChars(env, crash_dir, dir);

  hands_refresh_modules();

  stack_t ss;
  ss.ss_sp = g_altstack;
  ss.ss_size = sizeof(g_altstack);
  ss.ss_flags = 0;
  sigaltstack(&ss, NULL);

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = hands_signal_handler;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
  for (size_t i = 0; i < sizeof(g_fatal_signals) / sizeof(int); i++) {
    sigaction(g_fatal_signals[i], &sa, &g_previous[i]);
  }
}
