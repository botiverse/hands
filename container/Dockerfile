# syntax=docker/dockerfile:1
# APK metadata parser — Cloudflare Container image
# Force rebuild 2026-06-26 18:01 UTC to fix aapt ENOENT (use --include=dev so tsx ships).
#
# Uses `aapt` + `apksigner` from Android SDK build-tools (NOT full Android SDK).
# These are small standalone binaries that read APK files, which is all we need.

FROM node:20-alpine AS base

# Install aapt + apksigner from Android SDK build-tools
# Source: https://github.com/iBotPeaches/Apktool/blob/master/INSTALL.md
# We grab the official Google command-line tools and extract just build-tools.
ARG ANDROID_SDK_VERSION=34.0.0
ARG ANDROID_CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip

# Install JDK + unzip + wget
RUN apk add --no-cache openjdk17-jre-headless unzip wget bash

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