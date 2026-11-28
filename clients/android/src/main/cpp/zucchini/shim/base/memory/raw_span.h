#ifndef SHIM_BASE_MEMORY_RAW_SPAN_H_
#define SHIM_BASE_MEMORY_RAW_SPAN_H_

#include "base/containers/span.h"

namespace base {

struct DanglingUntriaged {};

template <typename T, typename Tag = void>
using raw_span = base::span<T, std::dynamic_extent>;

}  // namespace base

using base::raw_span;
using base::DanglingUntriaged;

#endif  // SHIM_BASE_MEMORY_RAW_SPAN_H_
