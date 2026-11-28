#ifndef SHIM_ABSL_STRINGS_ASCII_H_
#define SHIM_ABSL_STRINGS_ASCII_H_

namespace absl {

inline bool ascii_isdigit(unsigned char c) {
  return c >= '0' && c <= '9';
}

}  // namespace absl

#endif  // SHIM_ABSL_STRINGS_ASCII_H_
