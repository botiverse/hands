/*
 * Async-signal-safe native crash capture (symbolication matrix, task #80).
 *
 * Discipline (same as the iOS handler): the signal handler uses ONLY
 * async-signal-safe calls — open/write/close, time(), and local char
 * formatting. No malloc, no JSON, no dladdr, no locks. The record is raw
 * frame PCs from _Unwind_Backtrace plus a copy of /proc/self/maps; the
 * Kotlin side turns PCs into (soname, offset, BuildId) on the NEXT launch,
 * where address-space math is done from the maps snapshot.
 */
#include <fcntl.h>
#include <jni.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <unwind.h>

#define QUIVER_MAX_FRAMES 64
#define QUIVER_DIR_MAX 512

static char g_crash_dir[QUIVER_DIR_MAX];
static volatile sig_atomic_t g_handling = 0;
static int g_fatal_signals[] = {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static struct sigaction g_previous[sizeof(g_fatal_signals) / sizeof(int)];
static char g_altstack[SIGSTKSZ * 2];

struct quiver_unwind_state {
  uintptr_t frames[QUIVER_MAX_FRAMES];
  int count;
};

static _Unwind_Reason_Code quiver_unwind_cb(struct _Unwind_Context *ctx, void *arg) {
  struct quiver_unwind_state *state = (struct quiver_unwind_state *)arg;
  if (state->count >= QUIVER_MAX_FRAMES) return _URC_END_OF_STACK;
  uintptr_t pc = _Unwind_GetIP(ctx);
  if (pc != 0) state->frames[state->count++] = pc;
  return _URC_NO_REASON;
}

static size_t quiver_append(char *buf, size_t cap, size_t off, const char *text) {
  size_t n = strlen(text);
  if (off + n >= cap) return off;
  memcpy(buf + off, text, n);
  buf[off + n] = '\0';
  return off + n;
}

static size_t quiver_append_hex(char *buf, size_t cap, size_t off, uint64_t value) {
  char tmp[19];
  int i = 18;
  tmp[i--] = '\0';
  if (value == 0) tmp[i--] = '0';
  while (value != 0 && i >= 0) {
    static const char digits[] = "0123456789abcdef";
    tmp[i--] = digits[value & 0xf];
    value >>= 4;
  }
  return quiver_append(buf, cap, off, &tmp[i + 1]);
}

static size_t quiver_append_dec(char *buf, size_t cap, size_t off, uint64_t value) {
  char tmp[21];
  int i = 20;
  tmp[i--] = '\0';
  if (value == 0) tmp[i--] = '0';
  while (value != 0 && i >= 0) {
    tmp[i--] = (char)('0' + (value % 10));
    value /= 10;
  }
  return quiver_append(buf, cap, off, &tmp[i + 1]);
}

static void quiver_copy_maps(int out_fd) {
  int maps_fd = open("/proc/self/maps", O_RDONLY);
  if (maps_fd < 0) return;
  char chunk[4096];
  ssize_t n;
  while ((n = read(maps_fd, chunk, sizeof(chunk))) > 0) {
    ssize_t written = 0;
    while (written < n) {
      ssize_t w = write(out_fd, chunk + written, (size_t)(n - written));
      if (w <= 0) break;
      written += w;
    }
  }
  close(maps_fd);
}

static void quiver_signal_handler(int signo, siginfo_t *info, void *ucontext) {
  (void)ucontext;
  /* Re-entrancy guard (sentry-native inproc pattern): a crash inside the
   * handler — e.g. unwinding a corrupted stack — must not recurse; fall
   * straight through to the default disposition. */
  if (g_handling) {
    signal(signo, SIG_DFL);
    raise(signo);
    return;
  }
  g_handling = 1;
  if (g_crash_dir[0] != '\0') {
    long long ts = (long long)time(NULL) * 1000LL;

    char path[QUIVER_DIR_MAX + 64];
    size_t off = 0;
    off = quiver_append(path, sizeof(path), off, g_crash_dir);
    off = quiver_append(path, sizeof(path), off, "/native-");
    off = quiver_append_dec(path, sizeof(path), off, (uint64_t)ts);
    off = quiver_append(path, sizeof(path), off, ".qnc");

    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
      char header[256];
      off = 0;
      off = quiver_append(header, sizeof(header), off, "QNC1\nsignal ");
      off = quiver_append_dec(header, sizeof(header), off, (uint64_t)signo);
      off = quiver_append(header, sizeof(header), off, "\nfault_addr 0x");
      off = quiver_append_hex(header, sizeof(header), off,
                              (uint64_t)(uintptr_t)(info != NULL ? info->si_addr : 0));
      off = quiver_append(header, sizeof(header), off, "\ncrash_at ");
      off = quiver_append_dec(header, sizeof(header), off, (uint64_t)ts);
      off = quiver_append(header, sizeof(header), off, "\nframes\n");
      write(fd, header, off);

      struct quiver_unwind_state state;
      state.count = 0;
      _Unwind_Backtrace(quiver_unwind_cb, &state);
      char line[32];
      for (int i = 0; i < state.count; i++) {
        off = 0;
        off = quiver_append(line, sizeof(line), off, "0x");
        off = quiver_append_hex(line, sizeof(line), off, (uint64_t)state.frames[i]);
        off = quiver_append(line, sizeof(line), off, "\n");
        write(fd, line, off);
      }

      write(fd, "maps\n", 5);
      quiver_copy_maps(fd);
      close(fd);
    }
  }

  /* Restore and re-raise so the system (and any chained handler) proceeds. */
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
Java_io_quiver_update_QuiverNativeCrash_nativeInstall(JNIEnv *env, jclass clazz, jstring crash_dir) {
  (void)clazz;
  const char *dir = (*env)->GetStringUTFChars(env, crash_dir, NULL);
  if (dir == NULL) return;
  strncpy(g_crash_dir, dir, sizeof(g_crash_dir) - 1);
  g_crash_dir[sizeof(g_crash_dir) - 1] = '\0';
  (*env)->ReleaseStringUTFChars(env, crash_dir, dir);

  stack_t ss;
  ss.ss_sp = g_altstack;
  ss.ss_size = sizeof(g_altstack);
  ss.ss_flags = 0;
  sigaltstack(&ss, NULL);

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = quiver_signal_handler;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
  for (size_t i = 0; i < sizeof(g_fatal_signals) / sizeof(int); i++) {
    sigaction(g_fatal_signals[i], &sa, &g_previous[i]);
  }
}
