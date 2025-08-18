# AzureCQ Examples

This directory contains comprehensive examples demonstrating how to use AzureCQ effectively.

## Prerequisites

1. **Redis Server**: Running locally or remotely
2. **Azure Storage Account**: With connection string
3. **Environment Variables**:
   ```bash
   export AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=..."
   export REDIS_HOST="localhost"        # optional, defaults to localhost
   export REDIS_PORT="6379"             # optional, defaults to 6379
   export REDIS_PASSWORD="your-password" # optional
   ```

## Running Examples

### Setup
```bash
cd examples
npm install
```

### Basic Usage Example
Demonstrates fundamental AzureCQ operations:
```bash
npm run basic
```

**Features demonstrated:**
- Queue initialization
- Single message enqueue/dequeue
- Batch operations
- Large message handling (>64KB)
- Message acknowledgment
- Health checks and statistics

### Queue Management Example
Shows how to manage queues programmatically:
```bash
npm run queue-mgmt
```

**Features demonstrated:**
- Creating and deleting queues
- Listing existing queues
- Queue naming conventions
- Queue lifecycle management
- Bulk queue operations

### Performance Testing Example
Comprehensive performance benchmarking:
```bash
npm run performance
```

**Features demonstrated:**
- Single vs batch operation performance
- Throughput measurements
- Latency analysis
- Large message performance
- Performance comparison insights

## Example Details

### 1. Basic Usage (`basic-usage.ts`)

```typescript
// Simple enqueue/dequeue
const message = await queue.enqueue('Hello, World!');
const received = await queue.dequeue();
await queue.acknowledge(received);

// Batch operations
const batch = await queue.enqueueBatch([
  { content: 'Message 1' },
  { content: 'Message 2' }
]);
const receivedBatch = await queue.dequeueBatch({ maxMessages: 10 });
await queue.acknowledgeBatch(receivedBatch.messages);
```

### 2. Queue Management (`queue-management.ts`)

```typescript
const manager = new QueueManager(connectionString);

// Create queues
await manager.createQueue('my-new-queue');

// List all queues
const queues = await manager.listQueues();

// Delete queue
await manager.deleteQueue('old-queue');
```

### 3. Performance Testing (`performance-test.ts`)

```typescript
const tester = new PerformanceTester();
await tester.initialize();

// Test different scenarios
const singleMetrics = await tester.testSingleEnqueue(1000);
const batchMetrics = await tester.testBatchEnqueue(1000, 32);
const largeMetrics = await tester.testLargeMessages(10);
```

## Expected Performance

Based on typical configurations:

| Operation | Throughput | Latency |
|-----------|------------|---------|
| Single Enqueue | 500-800 msgs/sec | 5-15ms |
| Batch Enqueue | 1000-2000 msgs/sec | 10-30ms |
| Single Dequeue (Hot) | 600-1000 msgs/sec | 3-8ms |
| Batch Dequeue | 800-1500 msgs/sec | 15-40ms |
| Large Messages | 50-200 msgs/sec | 50-200ms |

*Performance varies based on:*
- Redis server specifications
- Azure Storage region/performance tier
- Network latency
- Message size and complexity

## Configuration Examples

### Development Configuration
```typescript
const config: QueueConfiguration = {
  name: 'dev-queue',
  redis: {
    host: 'localhost',
    port: 6379,
    keyPrefix: 'dev:'
  },
  azure: {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
    queueName: 'dev-queue',
    containerName: 'dev-container'
  },
  settings: {
    maxInlineMessageSize: 32 * 1024, // 32KB for dev
    redisCacheTtl: 1800, // 30 minutes
    batchSize: 16, // Smaller batches for dev
    retry: {
      maxAttempts: 2,
      backoffMs: 500
    }
  }
};
```

### Production Configuration
```typescript
const config: QueueConfiguration = {
  name: 'prod-queue',
  redis: {
    host: process.env.REDIS_HOST!,
    port: parseInt(process.env.REDIS_PORT!),
    password: process.env.REDIS_PASSWORD,
    keyPrefix: 'prod:'
  },
  azure: {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
    queueName: 'prod-queue',
    containerName: 'prod-container'
  },
  settings: {
    maxInlineMessageSize: 64 * 1024, // 64KB
    redisCacheTtl: 3600, // 1 hour
    batchSize: 32, // Optimal batch size
    retry: {
      maxAttempts: 5,
      backoffMs: 1000
    }
  }
};
```

## Error Handling Examples

### Graceful Degradation
```typescript
try {
  await queue.enqueue(message);
} catch (error) {
  if (error instanceof AzureCQError) {
    switch (error.code) {
      case ErrorCodes.REDIS_CONNECTION_ERROR:
        // Redis is down, but Azure Storage will persist
        console.log('Redis unavailable, falling back to Azure Storage');
        break;
      case ErrorCodes.AZURE_STORAGE_ERROR:
        // Critical error - storage is unavailable
        console.error('Storage unavailable:', error.message);
        throw error;
      default:
        console.error('Queue error:', error.message);
    }
  }
}
```

### Retry Logic
```typescript
async function enqueueWithRetry(message: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await queue.enqueue(message);
      return;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      const backoff = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
}
```

## Best Practices Demonstrated

1. **Resource Management**: Proper initialization and shutdown
2. **Error Handling**: Comprehensive error catching and recovery
3. **Batch Processing**: Optimal batch sizes for performance
4. **Monitoring**: Health checks and statistics tracking
5. **Testing**: Performance benchmarking and validation

## Troubleshooting

### Common Issues

**Connection Errors:**
- Verify Redis server is running and accessible
- Check Azure Storage connection string is valid
- Ensure firewall rules allow connections

**Performance Issues:**
- Monitor Redis memory usage
- Check Azure Storage throttling limits
- Optimize batch sizes for your workload

**Message Handling:**
- Verify pop receipts for acknowledgments
- Check message visibility timeouts
- Monitor dead letter patterns

### Debug Mode

Enable detailed logging:
```typescript
// Set environment variable
process.env.DEBUG = 'azurecq:*';

// Or add console logging in your application
queue.on('error', console.error);
queue.on('message', console.log);
```

## Next Steps

After running these examples:

1. **Customize Configuration**: Adapt settings for your use case
2. **Implement Monitoring**: Add metrics and alerting
3. **Scale Testing**: Test with your expected message volumes
4. **Production Deployment**: Deploy with proper environment configuration
5. **Optimize Performance**: Tune batch sizes and cache settings

For more advanced patterns and integrations, see the main [README](../README.md) and [documentation](https://github.com/your-username/azurecq/wiki).



