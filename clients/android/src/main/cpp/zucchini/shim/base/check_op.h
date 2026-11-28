#ifndef SHIM_BASE_CHECK_OP_H_
#define SHIM_BASE_CHECK_OP_H_

#include "base/check.h"

#define CHECK_OP(name, op, val1, val2) \
  if (!((val1) op (val2))) LogMessage(__FILE__, __LINE__, LOG_FATAL) << "Check failed: " #val1 " " #op " " #val2 " (" << (val1) << " vs " << (val2) << "). "

#define CHECK_EQ(val1, val2) CHECK_OP(EQ, ==, val1, val2)
#define CHECK_NE(val1, val2) CHECK_OP(NE, !=, val1, val2)
#define CHECK_LE(val1, val2) CHECK_OP(LE, <=, val1, val2)
#define CHECK_LT(val1, val2) CHECK_OP(LT, <, val1, val2)
#define CHECK_GE(val1, val2) CHECK_OP(GE, >=, val1, val2)
#define CHECK_GT(val1, val2) CHECK_OP(GT, >, val1, val2)

#ifdef NDEBUG
#define DCHECK_EQ(val1, val2) if (false) CHECK_EQ(val1, val2)
#define DCHECK_NE(val1, val2) if (false) CHECK_NE(val1, val2)
#define DCHECK_LE(val1, val2) if (false) CHECK_LE(val1, val2)
#define DCHECK_LT(val1, val2) if (false) CHECK_LT(val1, val2)
#define DCHECK_GE(val1, val2) if (false) CHECK_GE(val1, val2)
#define DCHECK_GT(val1, val2) if (false) CHECK_GT(val1, val2)
#else
#define DCHECK_EQ(val1, val2) CHECK_EQ(val1, val2)
#define DCHECK_NE(val1, val2) CHECK_NE(val1, val2)
#define DCHECK_LE(val1, val2) CHECK_LE(val1, val2)
#define DCHECK_LT(val1, val2) CHECK_LT(val1, val2)
#define DCHECK_GE(val1, val2) CHECK_GE(val1, val2)
#define DCHECK_GT(val1, val2) CHECK_GT(val1, val2)
#endif

#endif  // SHIM_BASE_CHECK_OP_H_
