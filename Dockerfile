# Orbit Tracker v11.0 - Production Dockerfile
# Multi-stage build for smaller image size

FROM node:18-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Production image
FROM node:18-alpine

# Install runtime dependencies for native modules and canvas
RUN apk add --no-cache \
    sqlite-dev \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    pixman-dev \
    fontconfig \
    ttf-dejavu

WORKDIR /app

# Copy built node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./

# Create data directory for SQLite
RUN mkdir -p /data && chown -R node:node /data /app

# Switch to non-root user
USER node

# Expose health check port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the bot
CMD ["node", "index.js"]
