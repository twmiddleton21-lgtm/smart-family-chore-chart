# syntax=docker/dockerfile:1
#
# Smart Family Chore Chart: FRONTEND-ONLY image.
#
# !! NOT production-ready for family data !!
# This image serves the static React build. All family data (profiles,
# chores, points, meals, the parent PIN) lives in each browser's
# localStorage. The container stores nothing, shares nothing between
# devices, and provides no real authentication. A shared backend, server-side
# storage, parent authentication and a safe migration of existing browser
# data are required first: see docs/SHARED-DATA-PLAN.md.
#
# Base images are pinned by version tag AND digest for reproducible builds.
# Update both together (tag for readability, digest for immutability).

ARG NODE_IMAGE=node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.5-alpine3.24@sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86

# ---------- Build stage: install exact locked dependencies and build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true

# Install from the lockfile only (reproducible; fails if out of sync).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy only what the build needs (see also .dockerignore).
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src

# Type check + production build (tests run in CI before the image is built).
RUN npm run build

# ---------- Runtime stage: static files served by unprivileged nginx ----------
FROM ${NGINX_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Smart Family Chore Chart" \
      org.opencontainers.image.description="Static family chore chart (frontend only). Data stays in each browser's localStorage; no shared multi-device data or server-side authentication." \
      org.opencontainers.image.licenses="UNLICENSED"

# Replace the default site config; the headers snippet is included by it.
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx/security-headers.inc /etc/nginx/conf.d/security-headers.inc

# Only the built static files. No source, node_modules, env files or data.
COPY --from=build /app/dist /usr/share/nginx/html

# The base image already runs as the unprivileged "nginx" user (uid 101).
USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
