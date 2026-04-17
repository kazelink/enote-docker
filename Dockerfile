# Stage 1: Build native dependencies
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++ alpine-sdk

COPY package*.json ./
RUN npm install

# Stage 2: Final lightweight image
FROM node:20-alpine

# su-exec allows running as non-root after fixing permissions
RUN apk add --no-cache su-exec && \
    addgroup -S enote && adduser -S enote -G enote

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY . .

RUN mkdir -p /app/data && chmod +x /app/entrypoint.sh

ENV NODE_ENV=production
VOLUME ["/app/data"]
EXPOSE 3000

# Start as root to fix volume permissions, then drop to enote user
ENTRYPOINT ["/app/entrypoint.sh"]
