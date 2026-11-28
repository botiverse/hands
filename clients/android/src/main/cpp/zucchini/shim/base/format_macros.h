#ifndef SHIM_BASE_FORMAT_MACROS_H_
#define SHIM_BASE_FORMAT_MACROS_H_

// size_t / ptrdiff_t printf length modifiers. The port defined these as the
// MSVC-only "Iu"/"Id"; with Bionic and glibc that reads an unsigned int.
#ifndef PRIuS
#define PRIuS "zu"
#endif

#ifndef PRIdS
#define PRIdS "td"
#endif

#endif  // SHIM_BASE_FORMAT_MACROS_H_
