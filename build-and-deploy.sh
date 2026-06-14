#!/bin/bash
# Multi-platform build, push, and deploy script for enote

IMAGE="op09090/enote:latest"
PLATFORMS="linux/amd64,linux/arm64,linux/arm/v7"

echo "🔨 Building and pushing $IMAGE for platforms: $PLATFORMS"

# Build with cache optimization
docker buildx build \
  --platform $PLATFORMS \
  --tag $IMAGE \
  --cache-to type=registry,ref=$IMAGE-cache,mode=max \
  --cache-from type=registry,ref=$IMAGE-cache \
  --push \
  .

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Build and push completed"

echo "🔄 Redeploying containers..."

docker compose down
docker compose up -d

if [ $? -eq 0 ]; then
    echo "✅ Containers redeployed successfully"
    docker ps
else
    echo "❌ Deployment failed"
    exit 1
fi
