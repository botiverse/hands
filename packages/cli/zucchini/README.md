# Zucchini patch generator

`zucchini-gen.cjs` is Chromium's Zucchini patcher compiled to WebAssembly and
embedded in one Node script, so `hands builds publish-android --generate-deltas`
can make `archive-patcher-zucchini-v1+xz` patches on any CI machine with Node
and a JDK, without native binaries. `patchgen/PatchGen.java --zucchini` runs it
between archive-patcher's delta-friendly blobs; Android SDK 0.16.0+ applies the
result with the native applier in `clients/android/src/main/cpp`.

```
node zucchini-gen.cjs gen <old> <new> <patch> [<imposed matches>]
node zucchini-gen.cjs apply <old> <patch> <new>
```

## Sources

- Shared with the Android SDK's applier, compiled from
  `clients/android/src/main/cpp/zucchini` (see its `README.hands` for the
  upstream revision, license and modified shims). The generator and the applier
  must come from the same revision.
- Generator-only files in `src/components/zucchini`, copied from the same
  standalone port (https://github.com/rhythmcache/zucchini, commit 70262b4,
  BSD 3-Clause) with two changes, marked "Hands:":
  - `imposed_ensemble_matcher.cc` does not drop DEX matches when there is more
    than one. Upstream drops them all in that case, which turns a multidex APK
    into a raw diff about as large as bsdiff's; PatchGen pairs the DEX files
    itself.
  - `heuristic_ensemble_matcher.cc` includes `<cmath>`.
- `hands_zucchini_gen.cc`, the command-line entry point.

## Rebuilding

`./build.sh` with Emscripten 7.0.1 on PATH (`emsdk install 7.0.1 && emsdk
activate 7.0.1`). The build is deterministic; CI rebuilds it and fails if the
committed `zucchini-gen.cjs` differs.
