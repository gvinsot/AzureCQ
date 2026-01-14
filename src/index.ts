/**
 * AzureCQ - High-performance queue system based on Redis and Azure Storage
 * 
 * Features:
 * - Hybrid storage: Redis for hot cache + Azure Storage for persistence
 * - No message loss guarantee through Azure Storage durability
 * - High performance through Redis caching and batch operations
 * - Automatic large message handling via Azure Blob Storage
 * - Cost-effective alternative to Azure Service Bus
 */

export { AzureCQ, QueueManager } from './azurecq';
export { RedisManager } from './redis-manager';
export { AzureManager } from './azure-manager';
export { DeadLetterManager } from './dead-letter-manager';

// Export all types from types module
export * from './types';

// Export performance optimizations for advanced users
export {
  BinaryMessageCodec,
  AdvancedRedisOperations,
  ObjectPool,
  BufferPool,
  ConcurrentBatchProcessor,
  StreamingProcessor,
  PerformanceMonitor,
  PerformancePresets
} from './performance-optimizations';



