# Docker Setup for AzureCQ

This document explains how to run AzureCQ with Docker Compose, including Redis, Azurite (Azure Storage Emulator), and the performance test.

## Prerequisites

- Docker
- Docker Compose

## Quick Start

To run the performance test with all required services:

```bash
docker-compose up --build
```

This will:
1. Start a Redis container
2. Start an Azurite container (Azure Storage Emulator)
3. Build and run the AzureCQ application with the performance test

## Services

### Redis
- **Image**: `redis:7.2-alpine`
- **Port**: `6379`
- **Features**: Persistence enabled with AOF
- **Health Check**: Redis ping command

### Azurite (Azure Storage Emulator)
- **Image**: `mcr.microsoft.com/azure-storage/azurite:latest`
- **Ports**:
  - `10000`: Blob service
  - `10001`: Queue service
  - `10002`: Table service
- **Features**: Full Azure Storage API compatibility
- **Health Check**: Service properties endpoint

### Application
- **Build**: Custom Dockerfile
- **Command**: `npm run example:performance` (runs performance test by default)
- **Dependencies**: Waits for Redis and Azurite to be healthy

## Environment Variables

The application container is configured with these environment variables:

### Redis Configuration
- `REDIS_HOST=redis` - Redis server hostname (points to the Redis container)
- `REDIS_PORT=6379` - Redis server port
- `REDIS_PASSWORD=""` - Redis password (empty for development)

### Azure Storage Configuration
- `AZURE_STORAGE_CONNECTION_STRING` - Pre-configured connection string for Azurite emulator with all endpoints

### Application Configuration
- `NODE_ENV=development` - Node.js environment mode
- `DEBUG=azurecq:*` - Optional debug logging (commented out by default)

All examples now use these environment variables and will automatically connect to the containerized services when run via Docker Compose.

## Custom Commands

You can override the default command to run different examples:

```bash
# Run basic usage example
docker-compose run --rm app npm run example:basic

# Run dead letter queue example
docker-compose run --rm app npm run example:dlq

# Run queue management example
docker-compose run --rm app npm run example:queue-mgmt

# Run connection resilience example
docker-compose run --rm app npm run example:resilience

# Run optimized connections example
docker-compose run --rm app npm run example:optimized

# Run acknowledgment timeout example
docker-compose run --rm app npm run example:timeout

# Run advanced performance improvements example
docker-compose run --rm app npm run example:perf-advanced

# Run Azure Storage Queue vs AzureCQ performance comparison
# Note: This example requires real Azure Storage or running locally with Azurite
# docker-compose run --rm app npm run example:azure-comparison
```

## Development Mode

For development with live code changes:

```bash
# Start only Redis and Azurite
docker-compose up redis azurite

# Run your code locally with the containerized services
npm run example:performance
```

## Cleanup

To stop all services and remove containers:

```bash
docker-compose down
```

To also remove volumes (will delete Redis and Azurite data):

```bash
docker-compose down -v
```

## Troubleshooting

### Services Not Ready
If you see connection errors, the health checks ensure services are ready before the app starts. You can check service status:

```bash
# Check Redis
docker-compose exec redis redis-cli ping

# Check Azurite Queue service
curl http://localhost:10001/devstoreaccount1?comp=properties&restype=service

# Check Azurite Blob service
curl http://localhost:10000/devstoreaccount1?comp=properties&restype=service
```

### Port Conflicts
If you have Redis or other services running locally, you may need to change the ports in `docker-compose.yml`:

```yaml
ports:
  - "6380:6379"  # Changed from 6379:6379
```

### Performance Issues
For better performance on Windows/macOS, consider:
- Using Docker Desktop with WSL2 backend (Windows)
- Allocating more resources to Docker Desktop
- Using named volumes instead of bind mounts for better I/O performance

## Production Considerations

This setup is for development and testing. For production:

1. Use production Redis (Azure Redis Cache, ElastiCache, etc.)
2. Use real Azure Storage instead of Azurite
3. Implement proper secrets management
4. Add monitoring and logging
5. Use multi-stage Docker builds for smaller images
6. Implement proper security scanning and updates
