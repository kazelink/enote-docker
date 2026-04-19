# syntax=docker/dockerfile:1

# Build native dependencies once, then copy only runtime artifacts.
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache python3 make g++ && \
    npm install --omit=dev

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache su-exec && \
    addgroup -S enote && \
    adduser -S enote -G enote && \
    mkdir -p /app/data

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
COPY public ./public
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
