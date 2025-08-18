/**
 * Redis Manager with Advanced Performance Optimizations
 * Consolidated from enhanced-redis-manager.ts for single, optimized implementation
 */

import Redis from 'ioredis';
import { QueueMessage, AzureCQError, ErrorCodes } from './types';
import { 
  BinaryMessageCodec, 
  AdvancedRedisOperations, 
  ObjectPool, 
  PerformanceMonitor,
  PerformancePresets 
} from './performance-optimizations';

export class RedisManager {
  private redis!: Redis;
  private keyPrefix: string;
  private config: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
    performanceProfile?: keyof typeof PerformancePresets;
  };
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private healthCheckInterval?: NodeJS.Timeout;
  private customReconnectTimeout?: NodeJS.Timeout;
  private shouldReconnect: boolean = true;
  private performanceMonitor: PerformanceMonitor;
  
  // Object pools for memory optimization
  private messagePool: ObjectPool<Partial<QueueMessage>>;
  private bufferPool: ObjectPool<Buffer>;

  constructor(config: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
    performanceProfile?: keyof typeof PerformancePresets;
  }) {
    this.config = config;
    this.keyPrefix = config.keyPrefix || 'azurecq:';
    this.performanceMonitor = new PerformanceMonitor();
    
    // Initialize object pools
    this.messagePool = new ObjectPool<Partial<QueueMessage>>(
      () => ({}),
      100,
      (obj) => {
        // Reset object
        Object.keys(obj).forEach(key => delete (obj as any)[key]);
      }
    );
    
    this.bufferPool = new ObjectPool<Buffer>(
      () => Buffer.allocUnsafe(64 * 1024),
      50,
      (buffer) => buffer.fill(0)
    );
    
    this.createRedisConnection();
  }

  private createRedisConnection(): void {
    const profile = this.config.performanceProfile || 'BALANCED';
    const redisConfig = PerformancePresets[profile].redis;
    
    this.redis = new Redis({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      db: this.config.db || 0,
      lazyConnect: true,
      enableReadyCheck: true,
      autoResubscribe: true,
      ...redisConfig // Apply performance profile
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.redis.on('connect', () => {
      console.log('Redis connected successfully');
      this.isConnected = true;
      this.isConnecting = false;
      
      if (this.customReconnectTimeout) {
        clearTimeout(this.customReconnectTimeout);
        this.customReconnectTimeout = undefined;
      }
    });

    this.redis.on('ready', () => {
      console.log('Redis ready for commands');
      this.isConnected = true;
      this.isConnecting = false;
    });

    this.redis.on('error', (error) => {
      console.error('Redis connection error:', error);
      this.isConnected = false;
      
      if (this.isCriticalError(error)) {
        this.handleCriticalError(error);
      }
    });

    this.redis.on('close', () => {
      console.log('Redis connection closed');
      this.isConnected = false;
    });

    this.redis.on('reconnecting', (time: number) => {
      console.log(`Redis automatically reconnecting in ${time}ms...`);
      this.isConnecting = true;
      this.isConnected = false;
    });

    this.redis.on('end', () => {
      console.warn('Redis connection ended');
      this.isConnected = false;
      this.isConnecting = false;
      
      if (this.shouldReconnect && !this.isConnecting) {
        this.scheduleManualReconnect();
      }
    });
  }

  private isCriticalError(error: Error): boolean {
    const criticalErrorCodes = ['WRONGTYPE', 'NOAUTH', 'AUTH', 'LOADING', 'READONLY'];
    return criticalErrorCodes.some(code => 
      error.message.includes(code) || (error as any).code === code
    );
  }

  private handleCriticalError(error: Error): void {
    console.error('Critical Redis error requiring manual intervention:', error.message);
    this.shouldReconnect = false;
  }

  private scheduleManualReconnect(): void {
    if (this.customReconnectTimeout) return;

    console.log('Scheduling manual Redis reconnection in 30 seconds...');
    this.customReconnectTimeout = setTimeout(async () => {
      this.customReconnectTimeout = undefined;
      
      if (!this.shouldReconnect || this.isConnected || this.isConnecting) {
        return;
      }

      try {
        console.log('Attempting manual Redis reconnection...');
        this.isConnecting = true;
        await this.redis.connect();
        console.log('Manual Redis reconnection successful');
      } catch (error) {
        console.error('Manual reconnection failed, will retry:', error);
        this.isConnecting = false;
        if (this.shouldReconnect) {
          this.scheduleManualReconnect();
        }
      }
    }, 30000);
  }

  /**
   * Connect to Redis with performance monitoring
   */
  async connect(): Promise<void> {
    return this.performanceMonitor.time('connect', async () => {
      this.shouldReconnect = true;
      await this.redis.connect();
      this.startHealthCheck();
      console.log('Redis connected and monitoring started');
    });
  }

  /**
   * Enhanced batch message caching with binary serialization
   */
  async cacheMessageBatch(queueName: string, messages: QueueMessage[], ttlSeconds: number): Promise<void> {
    if (messages.length === 0) return;

    return this.performanceMonitor.time('cacheMessageBatch', async () => {
      await this.executeWithFallback(
        async () => {
          const pipeline = this.redis.pipeline();
          
          for (const message of messages) {
            const key = this.getMessageKey(queueName, message.id);
            
            // Use binary serialization for better performance
            const binaryData = BinaryMessageCodec.encode(message);
            pipeline.setex(key, ttlSeconds, binaryData);
          }

          await pipeline.exec();
        },
        undefined,
        'cacheMessageBatch',
        false
      );
    });
  }

  /**
   * Enhanced batch message retrieval with atomic operations
   */
  async getCachedMessageBatch(queueName: string, messageIds: string[]): Promise<(QueueMessage | null)[]> {
    if (messageIds.length === 0) return [];

    return this.performanceMonitor.time('getCachedMessageBatch', async () => {
      return await this.executeWithFallback(
        async () => {
          return await AdvancedRedisOperations.batchGetMessages(
            this.redis,
            queueName,
            messageIds,
            this.keyPrefix
          );
        },
        messageIds.map(() => null),
        'getCachedMessageBatch',
        false
      );
    });
  }

  /**
   * Atomic batch dequeue using Lua script
   */
  async atomicBatchDequeue(queueName: string, count: number): Promise<QueueMessage[]> {
    return this.performanceMonitor.time('atomicBatchDequeue', async () => {
      return await this.executeWithFallback(
        async () => {
          const queueKey = this.getHotQueueKey(queueName);
          const cachePrefix = `${this.keyPrefix}msg:${queueName}:`;
          
          const results = await AdvancedRedisOperations.atomicBatchDequeue(
            this.redis,
            queueKey,
            cachePrefix,
            count
          );
          
          return results.map(r => r.data);
        },
        [],
        'atomicBatchDequeue',
        false
      );
    });
  }

  /**
   * Optimized batch hot queue operations
   */
  async addToHotQueueBatch(queueName: string, messageIds: string[], priorities?: number[]): Promise<void> {
    if (messageIds.length === 0) return;

    return this.performanceMonitor.time('addToHotQueueBatch', async () => {
      await this.executeWithFallback(
        async () => {
          const key = this.getHotQueueKey(queueName);
          const pipeline = this.redis.pipeline();
          
          messageIds.forEach((messageId, index) => {
            const priority = priorities?.[index] || Date.now();
            pipeline.zadd(key, priority, messageId);
          });
          
          await pipeline.exec();
        },
        undefined,
        'addToHotQueueBatch',
        false
      );
    });
  }

  /**
   * Memory-efficient cache cleanup
   */
  async cleanupExpiredCache(queueName: string, maxAge: number = 3600): Promise<number> {
    return this.performanceMonitor.time('cleanupExpiredCache', async () => {
      return await this.executeWithFallback(
        async () => {
          const pattern = `${this.keyPrefix}msg:${queueName}:*`;
          const cutoffTime = Date.now() - (maxAge * 1000);
          let cleaned = 0;
          
          // Use SCAN for memory-efficient iteration
          const stream = this.redis.scanStream({
            match: pattern,
            count: 100
          });
          
          for await (const keys of stream) {
            if (keys.length === 0) continue;
            
            const pipeline = this.redis.pipeline();
            keys.forEach((key: string) => pipeline.get(key));
            
            const results = await pipeline.exec();
            const toDelete: string[] = [];
            
            results?.forEach((result, index) => {
              if (result && result[0] === null && result[1]) {
                try {
                  const message = BinaryMessageCodec.decode(result[1] as Buffer);
                  if (message.insertedOn.getTime() < cutoffTime) {
                    toDelete.push(keys[index]);
                  }
                } catch {
                  // If we can't decode, it's probably old format - clean it up
                  toDelete.push(keys[index]);
                }
              }
            });
            
            if (toDelete.length > 0) {
              await this.redis.del(...toDelete);
              cleaned += toDelete.length;
            }
          }
          
          return cleaned;
        },
        0,
        'cleanupExpiredCache',
        false
      );
    });
  }

  /**
   * Get comprehensive performance metrics
   */
  getPerformanceMetrics(): Record<string, any> {
    return {
      redis: this.performanceMonitor.getStats(),
      connection: this.getConnectionStatus(),
      memory: {
        messagePoolSize: this.messagePool.size(),
        bufferPoolSize: this.bufferPool.size(),
        heapUsed: process.memoryUsage().heapUsed,
        heapTotal: process.memoryUsage().heapTotal
      }
    };
  }

  /**
   * Reset performance metrics
   */
  resetPerformanceMetrics(): void {
    this.performanceMonitor.reset();
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (!this.isConnected && !this.isConnecting) {
        console.log('Redis not connected - triggering manual reconnection');
        this.scheduleManualReconnect();
      } else if (this.isConnected) {
        try {
          await this.redis.ping();
        } catch (error) {
          console.warn('Redis ping failed:', error);
        }
      }
    }, 30000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    
    if (this.customReconnectTimeout) {
      clearTimeout(this.customReconnectTimeout);
      this.customReconnectTimeout = undefined;
    }
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.stopHealthCheck();
    this.isConnected = false;
    this.isConnecting = false;
    
    try {
      await this.redis.disconnect();
      console.log('Redis disconnected successfully');
    } catch (error) {
      console.warn('Error during Redis disconnect:', error);
    }
  }

  private async executeWithFallback<T>(
    operation: () => Promise<T>,
    fallbackValue: T,
    operationName: string,
    throwOnError: boolean = false
  ): Promise<T> {
    try {
      if (!this.isConnected) {
        if (throwOnError) {
          throw new AzureCQError(
            'Redis is not connected',
            ErrorCodes.REDIS_CONNECTION_ERROR
          );
        }
        
        if (this.isConnecting) {
          console.warn(`Redis reconnecting for ${operationName}, using fallback`);
        } else {
          console.warn(`Redis not connected for ${operationName}, using fallback`);
        }
        return fallbackValue;
      }

      return await operation();
      
    } catch (error) {
      console.warn(`Redis ${operationName} failed:`, error);
      this.isConnected = false;
      
      if (throwOnError) {
        throw new AzureCQError(
          `Failed to execute Redis ${operationName}`,
          ErrorCodes.REDIS_CONNECTION_ERROR,
          error as Error
        );
      }
      
      return fallbackValue;
    }
  }

  getConnectionStatus(): {
    isConnected: boolean;
    isConnecting: boolean;
    shouldReconnect: boolean;
    isHealthCheckActive: boolean;
    hasCustomReconnectScheduled: boolean;
  } {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      shouldReconnect: this.shouldReconnect,
      isHealthCheckActive: this.healthCheckInterval !== undefined,
      hasCustomReconnectScheduled: this.customReconnectTimeout !== undefined
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConnected) return false;

    return await this.executeWithFallback(
      async () => {
        await this.redis.ping();
        return true;
      },
      false,
      'healthCheck',
      false
    );
  }

  // Legacy compatibility methods
  async cacheMessage(queueName: string, message: QueueMessage, ttlSeconds: number): Promise<void> {
    return this.cacheMessageBatch(queueName, [message], ttlSeconds);
  }

  async getCachedMessage(queueName: string, messageId: string): Promise<QueueMessage | null> {
    const results = await this.getCachedMessageBatch(queueName, [messageId]);
    return results[0];
  }

  async removeCachedMessage(queueName: string, messageId: string): Promise<void> {
    const key = this.getMessageKey(queueName, messageId);
    await this.executeWithFallback(
      () => this.redis.del(key),
      undefined,
      'removeCachedMessage',
      false
    );
  }

  async addToHotQueue(queueName: string, messageId: string, priority: number = 0): Promise<void> {
    return this.addToHotQueueBatch(queueName, [messageId], [priority]);
  }

  async getFromHotQueue(queueName: string, count: number = 1): Promise<string[]> {
    const key = this.getHotQueueKey(queueName);
    return await this.executeWithFallback(
      () => this.redis.zpopmin(key, count),
      [],
      'getFromHotQueue',
      false
    );
  }

  async removeFromHotQueue(queueName: string, messageId: string): Promise<void> {
    const key = this.getHotQueueKey(queueName);
    await this.executeWithFallback(
      () => this.redis.zrem(key, messageId),
      undefined,
      'removeFromHotQueue',
      false
    );
  }

  async getQueueStats(queueName: string): Promise<{ hotCount: number }> {
    const key = this.getHotQueueKey(queueName);
    return await this.executeWithFallback(
      async () => {
        const hotCount = await this.redis.zcard(key);
        return { hotCount };
      },
      { hotCount: 0 },
      'getQueueStats',
      false
    );
  }

  private getMessageKey(queueName: string, messageId: string): string {
    return `${this.keyPrefix}msg:${queueName}:${messageId}`;
  }

  private getHotQueueKey(queueName: string): string {
    return `${this.keyPrefix}hot:${queueName}`;
  }
}