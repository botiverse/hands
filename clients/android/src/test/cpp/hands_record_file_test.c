#include "hands_record_file.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char first[1024];
  char second[1024];
  int first_fd = hands_open_crash_record(argv[1], 1721810000123ULL, 4123, 4177,
                                         first, sizeof(first));
  int second_fd = hands_open_crash_record(argv[1], 1721810000123ULL, 4123, 4177,
                                          second, sizeof(second));
  if (first_fd < 0 || second_fd < 0) return 3;
  close(first_fd);
  close(second_fd);
  struct stat first_stat;
  struct stat second_stat;
  if (strcmp(first, second) == 0 || stat(first, &first_stat) != 0 ||
      stat(second, &second_stat) != 0) {
    return 4;
  }
  if (strstr(first, "native-1721810000123-4123-4177.qnc") == NULL ||
      strstr(second, "native-1721810000123-4123-4177-1.qnc") == NULL) {
    return 5;
  }
  puts("QNC2 record identity collision test PASS");
  return 0;
}
