#ifndef SHIM_BASE_NUMERICS_SAFE_CONVERSIONS_H_
#define SHIM_BASE_NUMERICS_SAFE_CONVERSIONS_H_

#include <type_traits>
#include <limits>
#include <utility>
#include "base/logging.h"

namespace base {

// Helper function to dynamically check if a value fits in the Target type.
template <typename Target, typename Source>
constexpr bool IsValueInRangeForNumericType(Source value) {
  if constexpr (std::is_signed_v<Target>) {
    if (std::cmp_less(value, std::numeric_limits<Target>::min())) {
      return false;
    }
  } else {
    if (std::cmp_less(value, 0)) {
      return false;
    }
  }
  if (std::cmp_greater(value, std::numeric_limits<Target>::max())) {
    return false;
  }
  return true;
}

// A failed checked_cast throws like a failed CHECK (see base/logging.h).
struct FatalLogStream {
  ~FatalLogStream() noexcept(false) { throw hands_zucchini::CheckFailure(); }
  template <typename T>
  FatalLogStream& operator<<(const T&) {
    return *this;
  }
};

template <typename Target, typename Source>
constexpr Target checked_cast(Source value) {
  if (!IsValueInRangeForNumericType<Target>(value)) {
    FatalLogStream() << "checked_cast overflow: value " << value << " cannot fit in target type";
  }
  return static_cast<Target>(value);
}

template <typename T>
using StrictNumeric = T;

template <typename Target, typename Source>
constexpr Target strict_cast(Source value) {
  return static_cast<Target>(value);
}

}  // namespace base

#endif  // SHIM_BASE_NUMERICS_SAFE_CONVERSIONS_H_
