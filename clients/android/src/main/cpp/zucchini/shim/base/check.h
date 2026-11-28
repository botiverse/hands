#ifndef SHIM_BASE_CHECK_H_
#define SHIM_BASE_CHECK_H_

#include "base/logging.h"

#define CHECK(condition) \
  if (!(condition)) LogMessage(__FILE__, __LINE__, LOG_FATAL) << "Check failed: " #condition ". "

#ifdef NDEBUG
#define DCHECK(condition) \
  if (false && (condition)) LogMessage(__FILE__, __LINE__, LOG_DFATAL)
#else
#define DCHECK(condition) CHECK(condition)
#endif

#define NOTREACHED() CHECK(false)

#endif  // SHIM_BASE_CHECK_H_
