#ifndef COMPONENTS_ZUCCHINI_ZUCCHINI_CAPI_H_
#define COMPONENTS_ZUCCHINI_ZUCCHINI_CAPI_H_

#include <stdint.h>
#include <stddef.h>

#include "components/zucchini/buildflags.h"

#ifdef __cplusplus
extern "C" {
#endif

// Zucchini status codes (mappable to process exit codes).
typedef enum {
  ZUCCHINI_STATUS_SUCCESS = 0,
  ZUCCHINI_STATUS_INVALID_PARAM = 1,
  ZUCCHINI_STATUS_FILE_READ_ERROR = 2,
  ZUCCHINI_STATUS_FILE_WRITE_ERROR = 3,
  ZUCCHINI_STATUS_PATCH_READ_ERROR = 4,
  ZUCCHINI_STATUS_PATCH_WRITE_ERROR = 5,
  ZUCCHINI_STATUS_INVALID_OLD_IMAGE = 6,
  ZUCCHINI_STATUS_INVALID_NEW_IMAGE = 7,
  ZUCCHINI_STATUS_DISK_FULL = 8,
  ZUCCHINI_STATUS_IO_ERROR = 9,
  ZUCCHINI_STATUS_FATAL = 10,
} zucchini_status_t;

// Applies a Zucchini patch to |old_data| and writes the result to |new_data|.
// Returns a status code (0 for success, or non-zero status code on failure).
int zucchini_apply_patch(
    const uint8_t* old_data, size_t old_size,
    const uint8_t* patch_data, size_t patch_size,
    uint8_t* new_data, size_t new_size);

// Parses the patch header and returns the expected size of the patched file.
// Returns 0 on failure.
size_t zucchini_get_new_size(const uint8_t* patch_data, size_t patch_size);

// Returns a human-readable string name of the status code.
const char* zucchini_status_to_string(int status_code);

#if ZUCCHINI_ENABLE_GENERATOR
// Generates a Zucchini patch between |old_data| and |new_data|.
// Writes the serialized patch to |patch_data| (pre-allocated to |patch_size|).
// Returns the actual size of the generated patch on success, or 0 on failure.
// If |patch_data| is null or |patch_size| is smaller than required, it returns the required size.
size_t zucchini_generate_patch(
    const uint8_t* old_data, size_t old_size,
    const uint8_t* new_data, size_t new_size,
    uint8_t* patch_data, size_t patch_size);
#endif

#ifdef __cplusplus
}
#endif

#endif  // COMPONENTS_ZUCCHINI_ZUCCHINI_CAPI_H_
