#!/usr/bin/env pwsh
# Multi-platform build, push, and deploy script for enote

$IMAGE = "op09090/enote:latest"
$PLATFORMS = "linux/amd64,linux/arm64,linux/arm/v7"

Write-Host "🔨 Building and pushing $IMAGE for platforms: $PLATFORMS" -ForegroundColor Cyan

# Build with cache optimization
docker buildx build `
  --platform $PLATFORMS `
  --tag $IMAGE `
  --cache-to type=registry,ref=$IMAGE-cache,mode=max `
  --cache-from type=registry,ref=$IMAGE-cache `
  --push `
  .

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Build and push completed" -ForegroundColor Green

Write-Host "🔄 Redeploying containers..." -ForegroundColor Cyan

docker compose down
docker compose up -d

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Containers redeployed successfully" -ForegroundColor Green
    docker ps
} else {
    Write-Host "❌ Deployment failed" -ForegroundColor Red
    exit 1
}
