# Use Node.js 18 Alpine for smaller image size
FROM node:20-alpine

# Install curl for health checks
RUN apk add --no-cache curl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Copy source code first (needed for build context)
COPY src/ ./src/
COPY examples/ ./examples/

# Install all dependencies (including dev dependencies for ts-node and TypeScript)
RUN npm ci && npm cache clean --force

# Install global dependencies for runtime
RUN npm install -g ts-node typescript

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S azurecq -u 1001

# Change ownership of the app directory
RUN chown -R azurecq:nodejs /app
USER azurecq

# Expose port (if needed for future web interface)
EXPOSE 3000

# Default command (can be overridden in docker-compose)
CMD ["npm", "run", "example:performance"]
