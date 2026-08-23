#include "hands_record_file.h"

#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

#define HANDS_RECORD_COLLISION_ATTEMPTS 64U

static int hands_path_append(char *path, size_t capacity, size_t *offset, const char *text) {
  size_t i = 0;
  while (text[i] != '\0') {
    if (*offset + 1 >= capacity) return 0;
    path[(*offset)++] = text[i++];
  }
  path[*offset] = '\0';
  return 1;
}

static int hands_path_append_dec(char *path, size_t capacity, size_t *offset, uint64_t value) {
  char digits[21];
  int index = 20;
  digits[index--] = '\0';
  if (value == 0) digits[index--] = '0';
  while (value != 0 && index >= 0) {
    digits[index--] = (char)('0' + value % 10U);
    value /= 10U;
  }
  return hands_path_append(path, capacity, offset, &digits[index + 1]);
}

static int hands_format_crash_record_path(const char *directory, uint64_t timestamp_ms,
                                          pid_t pid, pid_t tid, unsigned int collision,
                                          char *path, size_t capacity) {
  if (directory == NULL || path == NULL || capacity == 0) return 0;
  size_t offset = 0;
  path[0] = '\0';
  if (!hands_path_append(path, capacity, &offset, directory) ||
      !hands_path_append(path, capacity, &offset, "/native-") ||
      !hands_path_append_dec(path, capacity, &offset, timestamp_ms) ||
      !hands_path_append(path, capacity, &offset, "-") ||
      !hands_path_append_dec(path, capacity, &offset, (uint64_t)pid) ||
      !hands_path_append(path, capacity, &offset, "-") ||
      !hands_path_append_dec(path, capacity, &offset, (uint64_t)tid)) {
    return 0;
  }
  if (collision > 0 &&
      (!hands_path_append(path, capacity, &offset, "-") ||
       !hands_path_append_dec(path, capacity, &offset, (uint64_t)collision))) {
    return 0;
  }
  return hands_path_append(path, capacity, &offset, ".qnc");
}

int hands_open_crash_record(const char *directory, uint64_t timestamp_ms, pid_t pid, pid_t tid,
                            char *path, size_t path_capacity) {
  for (unsigned int collision = 0; collision < HANDS_RECORD_COLLISION_ATTEMPTS; collision++) {
    if (!hands_format_crash_record_path(directory, timestamp_ms, pid, tid, collision,
                                        path, path_capacity)) {
      return -1;
    }
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd >= 0) return fd;
    if (errno != EEXIST) return -1;
  }
  return -1;
}
