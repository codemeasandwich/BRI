# BRI + api-ape Docker Image
# Plug-and-play database server with WebSocket RPC interface

FROM oven/bun:1-alpine

WORKDIR /app

# Copy server files
COPY server/package.json ./

# Install dependencies
RUN bun install --production

# Copy server source
COPY server/ ./

# Create data directory
RUN mkdir -p /data

# Environment defaults
ENV PORT=3000
ENV DATA_DIR=/data
ENV MAX_MEMORY_MB=256

# Expose WebSocket/HTTP port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/api/ape/ping || exit 1

# Run the server
CMD ["bun", "run", "index.js"]
