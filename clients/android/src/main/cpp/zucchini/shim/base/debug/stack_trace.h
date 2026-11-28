#ifndef SHIM_BASE_DEBUG_STACK_TRACE_H_
#define SHIM_BASE_DEBUG_STACK_TRACE_H_

#include <string>

namespace base {
namespace debug {

class StackTrace {
 public:
  StackTrace() = default;
  std::string ToString() const { return "Stack trace not available"; }
};

}  // namespace debug
}  // namespace base

#endif  // SHIM_BASE_DEBUG_STACK_TRACE_H_
