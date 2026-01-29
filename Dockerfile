# Orbit Tracker v11.0 - Production Dockerfile

FROM node:18-alpine

# Install dependencies for native modules and canvas
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
    pixman-dev \
    fontconfig \
    ttf-dejavu

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app code
COPY index.js ./

# Create data directory
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
