#ifndef HANDS_RECORD_FILE_H
#define HANDS_RECORD_FILE_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/*
 * Opens a unique QNC record with O_EXCL. The identity is timestamp+pid+tid;
 * bounded numeric suffixes preserve evidence if those coordinates collide.
 * Returns the file descriptor, or -1 without truncating an existing record.
 */
int hands_open_crash_record(const char *directory, uint64_t timestamp_ms, pid_t pid, pid_t tid,
                            char *path, size_t path_capacity);

#endif
