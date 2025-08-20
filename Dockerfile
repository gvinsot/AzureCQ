# Use Alpine for smaller image size
FROM node:20-alpine

# Install curl for health checks
RUN apk add --no-cache curl

# Set working directory
WORKDIR /app

# Install global dependencies for runtime
RUN npm install -g ts-node typescript

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Copy source code first (needed for build context)
COPY src/ ./src/
COPY examples/ ./examples/

# Install all dependencies (including dev dependencies for ts-node and TypeScript)
RUN npm ci && npm cache clean --force


# Default command (can be overridden in docker-compose)
CMD ["npm", "run", "example:performance"]
