# ═══════════════════════════════════════════════════════════════════════════════
# ORBIT TRACKER v10.9 - Fly.io Dockerfile
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:18-alpine

# Install build dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    pixman-dev

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev && npm cache clean --force

# Copy application code
COPY . .

# Create data directory (will be overwritten by volume mount)
RUN mkdir -p /data

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Expose health check port
EXPOSE 8080

# Run the bot
CMD ["node", "index.js"]
