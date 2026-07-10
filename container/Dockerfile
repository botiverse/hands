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

FROM node:24-bookworm-slim AS base

# minidump-stackwalk binary for the Electron/Crashpad symbolication lane.
COPY --from=minidump-builder /minidump-stackwalk /usr/local/bin/minidump-stackwalk

# Install aapt + apksigner from Android SDK build-tools
# Source: https://github.com/iBotPeaches/Apktool/blob/master/INSTALL.md
# We grab the official Google command-line tools and extract just build-tools.
ARG ANDROID_SDK_VERSION=34.0.0
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
    sdkmanager "build-tools;${ANDROID_SDK_VERSION}" >/dev/null 2>&1

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

WORKDIR /app

# Install Node deps. We use --include=dev because tsx (a devDependency) is used to
# run the TypeScript source directly without a separate build step — much faster
# iteration and smaller image than tsc → node.
COPY package.json ./
COPY package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund

# Copy container source
COPY src ./src

EXPOSE 8080

# Run via tsx (no build step needed in container; Cloudflare Containers build with Docker)
CMD ["npx", "tsx", "src/server.ts"]
