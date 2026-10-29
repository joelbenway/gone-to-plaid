# Copyright (c) Joel Benway
# SPDX-License-Identifier: MIT

# ==========================================
# Stage 1: Build & Compile Native Dependencies
# ==========================================
FROM docker.io/library/node:22-bookworm-slim AS builder

WORKDIR /app

# Install native build tools required for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package*.json ./

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy source code and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove development dependencies for a lean production image
RUN npm prune --omit=dev

# ==========================================
# Stage 2: Minimal Production Runtime
# ==========================================
FROM docker.io/library/node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8085 \
    DATA_DIR=/data

# Create dedicated non-root user and group
RUN groupadd -r plaid && useradd -r -g plaid -m -d /data plaid

# Copy runtime node_modules, compiled assets, and package.json
COPY --from=builder --chown=plaid:plaid /app/node_modules ./node_modules
COPY --from=builder --chown=plaid:plaid /app/dist ./dist
COPY --from=builder --chown=plaid:plaid /app/package.json ./

# Ensure data directory exists with correct permissions
RUN mkdir -p /data && chown -R plaid:plaid /data

USER plaid
VOLUME ["/data"]
EXPOSE 8085

ENTRYPOINT ["node", "dist/index.js"]
