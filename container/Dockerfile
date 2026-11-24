# APK metadata parser — Cloudflare Container image
# Force rebuild 1782558219 for bookworm-slim migration

#
# Bumped from `node:20-alpine` (musl libc) to `node:24-bookworm-slim` (glibc)
# so the Android SDK build-tools (aapt, apksigner) — which are glibc ELFs —
# can actually exec. Also bumped Node 20 → 24 LTS.
#
# Uses `aapt` + `apksigner` from Android SDK build-tools (NOT full Android SDK).
# These are small standalone binaries that read APK files, which is all we need.

# Build minidump-stackwalk (Mozilla rust-minidump) for the Electron/Crashpad
# crash-symbolication lane. Built on bookworm so the resulting glibc binary
# runs unmodified in the node:24-bookworm-slim runtime below.
FROM rust:1-bookworm AS minidump-builder
ARG MINIDUMP_STACKWALK_VERSION=0.22.0
RUN cargo install minidump-stackwalk --version ${MINIDUMP_STACKWALK_VERSION} \
    && cp "$(command -v minidump-stackwalk)" /minidump-stackwalk

# rcodesign (apple-codesign) for the signing service: signs and notarizes
# macOS/iOS code on Linux, no Mac or Xcode needed.
FROM rust:1-bookworm AS rcodesign-builder
ARG APPLE_CODESIGN_VERSION=0.29.0
RUN cargo install apple-codesign --version ${APPLE_CODESIGN_VERSION} --locked --bin rcodesign \
    && cp "$(command -v rcodesign)" /rcodesign

FROM node:24-bookworm-slim AS base

COPY --from=rcodesign-builder /rcodesign /usr/local/bin/rcodesign

# minidump-stackwalk binary for the Electron/Crashpad symbolication lane.
COPY --from=minidump-builder /minidump-stackwalk /usr/local/bin/minidump-stackwalk

# Install aapt + apksigner from Android SDK build-tools
# Source: https://github.com/iBotPeaches/Apktool/blob/master/INSTALL.md
# We grab the official Google command-line tools and extract just build-tools.
ARG ANDROID_SDK_VERSION=34.0.0
# The signing service uses a newer apksigner/zipalign (16 KB page alignment,
# --alignment-preserved) without changing the parser's build-tools.
ARG SIGNING_BUILD_TOOLS_VERSION=35.0.0
ENV SIGNING_BUILD_TOOLS=/opt/android-sdk/build-tools/${SIGNING_BUILD_TOOLS_VERSION}
ARG ANDROID_CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip

# Install JDK + unzip + wget + ca-certificates. JDK (not JRE) so we can
# compile the archive-patcher wrapper below; also the sdkmanager runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    ca-certificates \
    wget \
    unzip \
    llvm \
    binutils \
    openssl \
    zip \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Download Android command-line tools + accept licenses + install build-tools
RUN mkdir -p /opt/android-sdk/cmdline-tools && \
    cd /tmp && \
    wget -q "$ANDROID_CMDLINE_TOOLS_URL" -O cmdline-tools.zip && \
    unzip -q cmdline-tools.zip -d /opt/android-sdk/cmdline-tools/ && \
    mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest && \
    rm cmdline-tools.zip

ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/build-tools/${ANDROID_SDK_VERSION}

# Accept licenses + install build-tools (aapt + apksigner are inside)
RUN yes | sdkmanager --licenses >/dev/null 2>&1 || true && \
    sdkmanager "build-tools;${ANDROID_SDK_VERSION}" "build-tools;${SIGNING_BUILD_TOOLS_VERSION}" >/dev/null 2>&1

# Compile a narrow wrapper around Google's apksig library. Unlike parsing
# `apksigner --print-certs`, this preserves verified v3/v3.1 proof-of-rotation
# order and supports multiple independent signers without guessing from text.
COPY apkinspect/ApkInspect.java /opt/apkinspect/ApkInspect.java
RUN javac -encoding UTF-8 \
    -cp "/opt/android-sdk/build-tools/${ANDROID_SDK_VERSION}/lib/apksigner.jar" \
    -d /opt/apkinspect /opt/apkinspect/ApkInspect.java

# archive-patcher (delta/differential update generation) — com.eidu fork of
# Google's Play-Store engine: a single self-contained jar (no transitive deps).
# Compile the thin PatchGen wrapper against it so the container can generate
# file-by-file APK patches. See docs/delta-download-design.md.
ARG ARCHIVE_PATCHER_VERSION=3.0.0
RUN mkdir -p /opt/patchgen && \
    wget -q "https://repo1.maven.org/maven2/com/eidu/archive-patcher/${ARCHIVE_PATCHER_VERSION}/archive-patcher-${ARCHIVE_PATCHER_VERSION}.jar" \
      -O /opt/patchgen/archive-patcher.jar
COPY patchgen/PatchGen.java /opt/patchgen/PatchGen.java
RUN javac -encoding UTF-8 -cp /opt/patchgen/archive-patcher.jar -d /opt/patchgen /opt/patchgen/PatchGen.java

# hap-sign-tool (OpenHarmony developtools_hapsigner, Apache-2.0): signs
# HarmonyOS .hap/.app packages with the key and the AGC certificate and profile
# Hands manages. The prebuilt jar from the project's dist/, pinned by commit
# and checked by SHA-256.
ARG HAPSIGNER_COMMIT=24ef0c843d94f68d16975cac42e377f31def48c6
ARG HAPSIGNER_SHA256=9cee965bb292080a0d29fb48450091f5dcc9d010bb18da39175f581ffed7c4f4
RUN mkdir -p /opt/hapsigner && \
    wget -q "https://raw.githubusercontent.com/openharmony/developtools_hapsigner/${HAPSIGNER_COMMIT}/dist/hap-sign-tool.jar" \
      -O /opt/hapsigner/hap-sign-tool.jar && \
    echo "${HAPSIGNER_SHA256}  /opt/hapsigner/hap-sign-tool.jar" | sha256sum -c -
ENV HAP_SIGN_TOOL=/opt/hapsigner/hap-sign-tool.jar

WORKDIR /app

# Install Node deps. We use --include=dev because tsx (a devDependency) is used to
# run the TypeScript source directly without a separate build step — much faster
# iteration and smaller image than tsc → node. So tsx and its esbuild engine are
# this service's runtime, not build tooling: dropping --include=dev does not slim
# the image, it stops the server from starting.
#
# npm ci, not npm install: install resolves the ranges afresh on every build, so
# the same commit could produce different versions weeks apart. ci installs
# exactly what the lockfile records.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# Copy container source
COPY src ./src

# Build stamp, so /health can answer "which build is serving" rather than only
# "something is serving". Supplied by `image_vars` in the Worker's container config,
# which wrangler passes as a build arg; unset outside a real deploy, and /health then
# reports "unknown" rather than pretending to know.
#
# Deliberately placed after every expensive layer. GIT_SHA changes on every deploy, and
# an ARG invalidates the cache for everything below it - declared up with the other ARGs
# it would rebuild the Rust minidump-stackwalk, the apt layer, the Android SDK and
# `npm ci` on every single deploy. Here it invalidates only the two lines beneath it,
# and `COPY src` above already changes whenever the source does.
ARG GIT_SHA=""
ENV BUILD_SHA=$GIT_SHA

EXPOSE 8080

# Run via tsx (no build step needed in container; Cloudflare Containers build with Docker)
CMD ["npx", "tsx", "src/server.ts"]
