// Hands SDK replacement for the standalone port's logging shim (see
// ../../README.hands). Messages are discarded instead of written to
// std::cerr, so no iostream code is linked into the SDK, and a failed
// CHECK throws hands_zucchini::CheckFailure instead of calling abort(): the
// JNI entry point catches it and the update falls back to the full APK
// rather than taking down the host app.
#ifndef SHIM_BASE_LOGGING_H_
#define SHIM_BASE_LOGGING_H_

#include <exception>
#include <iosfwd>

namespace logging {
enum LogSeverity {
  LOG_INFO,
  LOG_WARNING,
  LOG_ERROR,
  LOG_FATAL,
  LOG_DFATAL
};
constexpr int LOGGING_FATAL = LOG_FATAL;
inline void SetMinLogLevel(int) {}
}  // namespace logging

#define LOG_INFO 0
#define LOG_WARNING 1
#define LOG_ERROR 2
#define LOG_FATAL 3
#define LOG_DFATAL 4

namespace hands_zucchini {
struct CheckFailure : std::exception {
  const char* what() const noexcept override { return "zucchini check failed"; }
};
}  // namespace hands_zucchini

struct LogMessage {
  LogMessage(const char*, int, int severity) : severity_(severity) {}

  ~LogMessage() noexcept(false) {
    if (severity_ == LOG_FATAL || severity_ == LOG_DFATAL) {
      throw hands_zucchini::CheckFailure();
    }
  }

  template <typename T>
  LogMessage& operator<<(const T&) {
    return *this;
  }

  // Manipulators such as std::endl.
  LogMessage& operator<<(std::ostream& (*)(std::ostream&)) { return *this; }

 private:
  int severity_;
};

#define LOG(severity) LogMessage(__FILE__, __LINE__, LOG_ ## severity)

#define LOG_IF(severity, condition) \
  if (!(condition)) {} else LogMessage(__FILE__, __LINE__, LOG_ ## severity)

#endif  // SHIM_BASE_LOGGING_H_
