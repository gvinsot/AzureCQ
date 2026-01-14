/**
 * Main AzureCQ class - High-performance queue system with Redis + Azure Storage
 */

import { RedisManager } from './redis-manager';
import { AzureManager } from './azure-manager';
import { DeadLetterManager } from './dead-letter-manager';
import {
  QueueConfiguration,
  QueueMessage,
  QueueMessageBatch,
  EnqueueOptions,
  DequeueOptions,
  QueueStats,
  AcknowledgmentResult,
  BatchAcknowledgmentResult,
  NackOptions,
  MessageMoveResult,
  BatchMessageMoveResult,
  DeadLetterQueueInfo,
  AzureCQError,
  ErrorCodes
} from './types';
import { v4 as uuidv4 } from 'uuid';

export class AzureCQ {
  private redis: RedisManager;
  private azure: AzureManager;
  private deadLetter: DeadLetterManager;
  private config: QueueConfiguration;
  private isInitialized = false;
  // Cached Redis connection status to avoid frequent checks
  private redisStatusCache?: {
    status: { isConnected: boolean; isConnecting: boolean; shouldReconnect: boolean; isHealthCheckActive: boolean; hasCustomReconnectScheduled: boolean };
    lastCheckedMs: number;
  };

  constructor(config: QueueConfiguration) {
    this.config = config;
    this.redis = new RedisManager(config.redis);
    this.azure = new AzureManager({
      connectionString: config.azure.connectionString,
      queueName: config.azure.queueName,
      containerName: config.azure.containerName,
      maxInlineMessageSize: config.settings.maxInlineMessageSize
    });
    this.deadLetter = new DeadLetterManager(this.redis, this.azure, config);
  }

  /**
   * Initialize the queue system
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await Promise.all([
        this.redis.connect(),
        this.azure.initialize(),
        this.deadLetter.initialize()
      ]);
      
      this.isInitialized = true;
    } catch (error) {
      throw new AzureCQError(
        'Failed to initialize AzureCQ',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }



  /**
   * Shutdown the queue system
   */
  async shutdown(): Promise<void> {
    await this.redis.disconnect();
    this.isInitialized = false;
  }

  /**
   * Enqueue a single message
   */
  async enqueue(
    message: string | Buffer,
    options: EnqueueOptions = {}
  ): Promise<QueueMessage> {
    this.ensureInitialized();

    try {
      // Redis fallback: if not connected, write directly to Azure
      const redisStatus = this.getRedisStatusThrottled();
      if (!redisStatus.isConnected) {
        const queueMessage = await this.azure.enqueueMessage(
          message,
          options.metadata,
          options.visibilityTimeout,
          options.timeToLive
        );
        return queueMessage;
      }
      
      // Generate ID locally, write to Redis first, then Azure
      const tempId = uuidv4();
      const now = new Date();
      const queueMessage: QueueMessage = {
        id: tempId,
        content: Buffer.isBuffer(message) ? message : Buffer.from(message),
        metadata: options.metadata || {},
        dequeueCount: 0,
        insertedOn: now,
        nextVisibleOn: now
      };

      await Promise.all([
        this.redis.cacheMessage(this.config.name, queueMessage, this.config.settings.redisCacheTtl),
        this.redis.addToHotQueue(this.config.name, queueMessage.id, Date.now())
      ]);

      // Azure write - sync or async based on configuration
      const azureWriteTask = async (): Promise<void> => {
        try {
          // Hot path optimization: delay before Azure write to see if message gets consumed immediately
          const hotPathDelay = this.config.settings.hotPathDelayMs ?? 100; // Default 100ms
          if (hotPathDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, hotPathDelay));
          }

          // If consumer acknowledged during hot path delay, skip Azure enqueue entirely
          const pendingDel = await this.redis.consumePendingDelete(this.config.name, tempId);
          if (pendingDel) {
            await this.redis.removeCachedMessage(this.config.name, tempId);
            await this.redis.removeFromHotQueue(this.config.name, tempId);
            return;
          }

          const minShadowVisibility = 300; // 5 minutes - effectively disable Azure consumption
          const azureMsg = await this.azure.enqueueMessage(
            message,
            options.metadata,
            Math.max(options.visibilityTimeout || 0, minShadowVisibility),
            options.timeToLive
          );
          // Update cached message with Azure popReceipt and official ID
          const updated: QueueMessage = {
            ...queueMessage,
            id: azureMsg.id,
            popReceipt: azureMsg.popReceipt,
            insertedOn: azureMsg.insertedOn,
            nextVisibleOn: azureMsg.nextVisibleOn
          };
          
          // Atomically replace temp message with Azure message to prevent duplicates
          await this.redis.atomicReplaceWithAzureMessage(
            this.config.name,
            tempId, 
            updated, 
            this.config.settings.redisCacheTtl
          );
        } catch (e) {
          const error = e as Error;
          console.error(`Failed to write message ${tempId} to Azure Storage:`, error.message);
          // Mark message in Redis as pending Azure failure for potential recovery
          try {
            await this.redis.cacheMessage(
              this.config.name,
              { ...queueMessage, metadata: { ...queueMessage.metadata, _azureWriteFailed: true, _failureTime: new Date().toISOString() } },
              this.config.settings.redisCacheTtl
            );
          } catch (markError) {
            console.error('Failed to mark message as Azure write failure:', markError);
          }
          // Re-throw in sync mode so caller knows the write failed
          if (this.config.settings.syncAzureWrites) {
            throw e;
          }
        }
      };

      // If syncAzureWrites is enabled, wait for Azure confirmation
      if (this.config.settings.syncAzureWrites) {
        await azureWriteTask();
      } else {
        // Fire-and-forget for performance (but with proper error logging now)
        void azureWriteTask();
      }

      return queueMessage;
      
    } catch (error) {
      if (error instanceof AzureCQError) {
        throw error;
      }
      throw new AzureCQError(
        'Failed to enqueue message',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Enqueue multiple messages in batch
   */
  async enqueueBatch(
    messages: Array<{
      content: string | Buffer;
      options?: EnqueueOptions;
    }>
  ): Promise<QueueMessageBatch> {
    this.ensureInitialized();

    if (messages.length === 0) {
      return {
        messages: [],
        batchId: uuidv4(),
        count: 0
      };
    }

    try {
      // Redis fallback: if not connected, write directly to Azure
      const redisStatus = this.getRedisStatusThrottled();
      if (!redisStatus.isConnected) {
        const azureMessages = await this.azure.enqueueMessageBatch(
          messages.map(msg => ({
            content: msg.content,
            metadata: msg.options?.metadata,
            visibilityTimeoutSeconds: msg.options?.visibilityTimeout,
            timeToLiveSeconds: msg.options?.timeToLive
          }))
        );
        return {
          messages: azureMessages,
          batchId: uuidv4(),
          count: azureMessages.length
        };
      }
      const now = new Date();
      const tempMessages: QueueMessage[] = messages.map(() => ({
        id: uuidv4(),
        content: Buffer.alloc(0),
        metadata: {},
        dequeueCount: 0,
        insertedOn: now,
        nextVisibleOn: now
      }));

      // Fill content/metadata
      tempMessages.forEach((m, i) => {
        const src = messages[i];
        m.content = Buffer.isBuffer(src.content) ? src.content : Buffer.from(src.content);
        m.metadata = src.options?.metadata || {};
      });

      await Promise.all([
        this.redis.cacheMessageBatch(this.config.name, tempMessages, this.config.settings.redisCacheTtl),
        this.redis.addToHotQueueBatch(this.config.name, tempMessages.map(m => m.id))
      ]);

      // Azure writes with hot path optimization - sync or async based on config
      const azureBatchWriteTask = async (): Promise<void> => {
        try {
          // Hot path optimization: delay before Azure write
          const hotPathDelay = this.config.settings.hotPathDelayMs ?? 100; // Default 100ms
          if (hotPathDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, hotPathDelay));
          }

          // Filter out any temp IDs already acknowledged during hot path delay
          const remaining = [] as typeof messages;
          const remainingTempIds: string[] = [];
          
          for (let i = 0; i < tempMessages.length; i++) {
            const tempId = tempMessages[i].id;
            const wasAcked = await this.redis.consumePendingDelete(this.config.name, tempId);
            if (!wasAcked) {
              remaining.push(messages[i]);
              remainingTempIds.push(tempId);
            } else {
              await this.redis.removeCachedMessage(this.config.name, tempId);
              await this.redis.removeFromHotQueue(this.config.name, tempId);
            }
          }
          
          if (remaining.length === 0) return;
          const minShadowVisibility = 300; // 5 minutes - effectively disable Azure consumption
          const azureMessages = await this.azure.enqueueMessageBatch(
            remaining.map(msg => ({
              content: msg.content,
              metadata: msg.options?.metadata,
              visibilityTimeoutSeconds: Math.max(msg.options?.visibilityTimeout || 0, minShadowVisibility),
              timeToLiveSeconds: msg.options?.timeToLive
            }))
          );

          // Atomically replace temp messages with Azure messages to prevent duplicates
          const replacements = azureMessages.map((azureMessage, idx) => ({
            tempId: remainingTempIds[idx],
            azureMessage
          }));
          
          await this.redis.atomicBatchReplaceWithAzureMessages(
            this.config.name,
            replacements,
            this.config.settings.redisCacheTtl
          );
        } catch (e) {
          const error = e as Error;
          console.error(`Failed to write batch messages to Azure Storage:`, error.message);
          // Mark failed messages in Redis for potential recovery
          try {
            for (const tempMsg of tempMessages) {
              await this.redis.cacheMessage(
                this.config.name,
                { ...tempMsg, metadata: { ...tempMsg.metadata, _azureWriteFailed: true, _failureTime: new Date().toISOString() } },
                this.config.settings.redisCacheTtl
              );
            }
          } catch (markError) {
            console.error('Failed to mark messages as Azure write failure:', markError);
          }
          if (this.config.settings.syncAzureWrites) {
            throw e;
          }
        }
      };

      // If syncAzureWrites is enabled, wait for Azure confirmation
      if (this.config.settings.syncAzureWrites) {
        await azureBatchWriteTask();
      } else {
        void azureBatchWriteTask();
      }

      return {
        messages: tempMessages,
        batchId: uuidv4(),
        count: tempMessages.length
      };
    } catch (error) {
      throw new AzureCQError(
        'Failed to enqueue batch',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Dequeue a single message
   * @param options.blockingTimeout - If set, blocks waiting for a message (seconds)
   */
  async dequeue(options: DequeueOptions = {}): Promise<QueueMessage | null> {
    this.ensureInitialized();

    // If blocking mode requested and Redis is connected, use blocking dequeue
    if (options.blockingTimeout && options.blockingTimeout > 0) {
      const redisStatus = this.getRedisStatusThrottled();
      if (redisStatus.isConnected && !options.skipRedisHotQueue) {
        const message = await this.redis.blockingDequeue(
          this.config.name, 
          options.blockingTimeout
        );
        if (message) {
          return message;
        }
        // If blocking timed out, fall through to Azure
      }
    }

    const result = await this.dequeueBatch({ ...options, maxMessages: 1 });
    return result.messages.length > 0 ? result.messages[0] : null;
  }

  /**
   * Dequeue multiple messages in batch
   */
  async dequeueBatch(options: DequeueOptions = {}): Promise<QueueMessageBatch> {
    this.ensureInitialized();

    const maxMessages = Math.min(options.maxMessages || 1, this.config.settings.batchSize);
    const batchId = uuidv4();

    try {
      // If Redis connected and not skipped, try hot queue first
      let cachedMessages: QueueMessage[] = [];
      const redisStatus = this.getRedisStatusThrottled();
      if (redisStatus.isConnected && !options.skipRedisHotQueue) {
        cachedMessages = await this.redis.atomicBatchDequeue(this.config.name, maxMessages);
      }

      // If we need more messages, get them from Azure Storage
      let azureMessages: QueueMessage[] = [];
      const remainingCount = maxMessages - cachedMessages.length;

      if (remainingCount > 0) {
        azureMessages = await this.azure.dequeueMessages(
          remainingCount,
          options.visibilityTimeout
        );
        // Note: No re-caching to Redis - these messages are already dequeued
        // and will be processed immediately. Re-caching would be wasteful.
      }

      const allMessages = [...cachedMessages, ...azureMessages];

      return {
        messages: allMessages,
        batchId,
        count: allMessages.length
      };
    } catch (error) {
      if (error instanceof AzureCQError) {
        throw error;
      }
      throw new AzureCQError(
        'Failed to dequeue messages',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Acknowledge (delete) a single message
   */
  async acknowledge(message: QueueMessage): Promise<AcknowledgmentResult> {
    this.ensureInitialized();

    try {
      // Fast-ack in Redis; schedule Azure delete if we have mapping
      await Promise.all([
        this.redis.removeCachedMessage(this.config.name, message.id),
        this.redis.removeFromHotQueue(this.config.name, message.id),
        this.redis.setPendingDelete(this.config.name, message.id, this.config.settings.redisCacheTtl)
      ]);

      // Attempt immediate Azure delete if popReceipt present or mapping exists
      void (async () => {
        try {
          if (message.popReceipt) {
            await this.azure.acknowledgeMessage(message.id, message.popReceipt);
            await this.redis.removeIdMapping(this.config.name, message.id);
          } else {
            const mapping = await this.redis.getIdMapping(this.config.name, message.id);
            if (mapping?.popReceipt) {
              await this.azure.acknowledgeMessage(mapping.azureId, mapping.popReceipt);
              await this.redis.removeIdMapping(this.config.name, message.id);
            }
          }
        } catch (e) {
          // Log but don't throw - message was already removed from Redis
          // Azure message will become visible again after visibility timeout if this fails
          console.warn(`Failed to acknowledge message ${message.id} in Azure Storage:`, (e as Error).message);
        }
      })();

      return { success: true, messageId: message.id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        messageId: message.id
      };
    }
  }

  /**
   * Acknowledge multiple messages in batch
   */
  async acknowledgeBatch(messages: QueueMessage[]): Promise<BatchAcknowledgmentResult> {
    this.ensureInitialized();

    if (messages.length === 0) {
      return {
        success: true,
        results: [],
        batchId: uuidv4(),
        successCount: 0,
        failureCount: 0
      };
    }

    const batchId = uuidv4();
    const results: AcknowledgmentResult[] = [];

    // Fast-ack in Redis for all
    const ids = messages.map(m => m.id);
    await Promise.all([
      this.redis.removeCachedMessageBatch(this.config.name, ids),
      this.redis.removeFromHotQueueBatch(this.config.name, ids),
      ...ids.map(id => this.redis.setPendingDelete(this.config.name, id, this.config.settings.redisCacheTtl))
    ]);

    // Best-effort Azure deletes where we have popReceipt or mapping
    void (async () => {
      try {
        const directAcks = messages.filter(m => m.popReceipt).map(m => ({ messageId: m.id, popReceipt: m.popReceipt! }));
        if (directAcks.length > 0) {
          await this.azure.acknowledgeMessageBatch(directAcks);
          await this.redis.removeCachedMessageBatch(this.config.name, directAcks.map(a => a.messageId));
        }
        const noReceipt = messages.filter(m => !m.popReceipt);
        for (const m of noReceipt) {
          const mapping = await this.redis.getIdMapping(this.config.name, m.id);
          if (mapping?.popReceipt) {
            await this.azure.acknowledgeMessage(mapping.azureId, mapping.popReceipt);
            await this.redis.removeIdMapping(this.config.name, m.id);
          }
        }
      } catch (e) {
        // Log but don't throw - messages were already removed from Redis
        // Azure messages will become visible again after visibility timeout if this fails
        console.warn(`Failed to acknowledge batch messages in Azure Storage:`, (e as Error).message);
      }
    })();

    for (const id of ids) {
      results.push({ success: true, messageId: id });
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    return {
      success: failureCount === 0,
      results,
      batchId,
      successCount,
      failureCount
    };
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<QueueStats> {
    this.ensureInitialized();

    try {
      const [azureStats, redisStats] = await Promise.all([
        this.azure.getQueueStats(),
        this.redis.getQueueStats(this.config.name)
      ]);

      return {
        ...azureStats,
        name: this.config.name,
        messageCount: azureStats.messageCount + redisStats.hotCount
      };
    } catch (error) {
      throw new AzureCQError(
        'Failed to get queue statistics',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Health check for both Redis and Azure Storage
   */
  async healthCheck(): Promise<{
    overall: boolean;
    redis: boolean;
    azure: boolean;
    details?: string;
  }> {
    try {
      const [redisHealthy, azureStats] = await Promise.all([
        this.redis.healthCheck(),
        this.azure.getQueueStats().catch(() => null)
      ]);

      const azureHealthy = azureStats !== null;
      const overall = redisHealthy && azureHealthy;

      return {
        overall,
        redis: redisHealthy,
        azure: azureHealthy,
        details: overall ? 'All systems operational' : 'Some components are unhealthy'
      };
    } catch (error) {
      return {
        overall: false,
        redis: false,
        azure: false,
        details: `Health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Negative acknowledgment - marks message as failed
   * Automatically retries or moves to DLQ based on configuration
   */
  async nack(message: QueueMessage, options: NackOptions = {}): Promise<MessageMoveResult> {
    this.ensureInitialized();
    return await this.deadLetter.nackMessage(message, options);
  }

  /**
   * Manually move a message to dead letter queue
   */
  async moveToDeadLetter(message: QueueMessage, reason: string): Promise<MessageMoveResult> {
    this.ensureInitialized();
    return await this.deadLetter.moveMessageToDlq(message, reason);
  }

  /**
   * Move a message from dead letter queue back to main queue
   */
  async moveFromDeadLetter(messageId: string): Promise<MessageMoveResult> {
    this.ensureInitialized();
    return await this.deadLetter.moveMessageFromDlq(messageId);
  }

  /**
   * Batch move messages to dead letter queue
   */
  async moveToDeadLetterBatch(
    messages: Array<{ message: QueueMessage; reason: string }>
  ): Promise<BatchMessageMoveResult> {
    this.ensureInitialized();
    return await this.deadLetter.moveMessagesToDlq(messages);
  }

  /**
   * Batch move messages from dead letter queue back to main queue
   */
  async moveFromDeadLetterBatch(messageIds: string[]): Promise<BatchMessageMoveResult> {
    this.ensureInitialized();
    return await this.deadLetter.moveMessagesFromDlq(messageIds);
  }

  /**
   * Get dead letter queue information and statistics
   */
  async getDeadLetterInfo(): Promise<DeadLetterQueueInfo> {
    this.ensureInitialized();
    return await this.deadLetter.getDlqInfo();
  }

  /**
   * Purge all messages from dead letter queue
   */
  async purgeDeadLetter(): Promise<number> {
    this.ensureInitialized();
    const result = await this.deadLetter.purgeDlq();
    return result.success ? (result.purgedCount || 0) : 0;
  }

  /**
   * Enhanced dequeue with automatic retry/DLQ handling
   */
  async dequeueWithRetry(options?: DequeueOptions): Promise<{
    message: QueueMessage | null;
    processor: (processingFn: () => Promise<void>) => Promise<void>;
  }>;
  async dequeueWithRetry<T>(
    processingFunction: (message: QueueMessage) => Promise<T>
  ): Promise<{
    processed: boolean;
    retried: boolean;
    movedToDlq: boolean;
    result?: T;
    error?: string;
  }>;
  async dequeueWithRetry<T>(
    optionsOrFunction?: DequeueOptions | ((message: QueueMessage) => Promise<T>)
  ): Promise<any> {
    this.ensureInitialized();
    
    // Check if first argument is a processing function
    if (typeof optionsOrFunction === 'function') {
      const processingFunction = optionsOrFunction;
      const message = await this.dequeue();
      
      if (!message) {
        return { processed: false, retried: false, movedToDlq: false };
      }

      try {
        const result = await processingFunction(message);
        await this.acknowledge(message);
        
        return {
          processed: true,
          retried: false,
          movedToDlq: false,
          result
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        const nackResult = await this.nack(message, {
          reason: errorMessage
        });

        return {
          processed: false,
          retried: nackResult.action === 'retry',
          movedToDlq: nackResult.action === 'moved_to_dlq',
          error: errorMessage
        };
      }
    }

    // Original implementation for processor pattern
    const options = optionsOrFunction as DequeueOptions || {};
    const message = await this.dequeue(options);
    
    if (!message) {
      return {
        message: null,
        processor: async () => { /* no-op */ }
      };
    }

    const processor = async (processingFn: () => Promise<void>): Promise<void> => {
      const startTime = Date.now();
      
      try {
        await processingFn();
        
        // Success - acknowledge the message
        const ackResult = await this.acknowledge(message);
        if (!ackResult.success) {
          console.warn('Failed to acknowledge message after successful processing:', ackResult.error);
        }
        
      } catch (error) {
        // Processing failed - handle retry/DLQ
        const processingDuration = Date.now() - startTime;
        
        await this.nack(message, {
          reason: error instanceof Error ? error.message : 'Processing failed',
          // Could add custom logic here for different error types
        });
      }
    };

    return { message, processor };
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new AzureCQError(
        'AzureCQ not initialized. Call initialize() first.',
        ErrorCodes.AZURE_STORAGE_ERROR
      );
    }
  }

  // Throttle Redis status checks to once every 2 seconds for faster recovery detection
  private getRedisStatusThrottled(): { isConnected: boolean; isConnecting: boolean; shouldReconnect: boolean; isHealthCheckActive: boolean; hasCustomReconnectScheduled: boolean } {
    const now = Date.now();
    const throttleMs = 2000; // Reduced from 15s to 2s for faster connection state detection
    if (!this.redisStatusCache || now - this.redisStatusCache.lastCheckedMs > throttleMs) {
      const status = this.redis.getConnectionStatus();
      this.redisStatusCache = { status, lastCheckedMs: now };
      return status;
    }
    return this.redisStatusCache.status;
  }
}

// Static methods for queue management
export class QueueManager {
  private azure: AzureManager;

  constructor(connectionString: string) {
    this.azure = new AzureManager({
      connectionString,
      queueName: 'temp', // Will be ignored for management operations
      containerName: 'temp', // Will be ignored for management operations
      maxInlineMessageSize: 64 * 1024
    });
  }

  /**
   * Create a new queue
   */
  async createQueue(queueName: string): Promise<void> {
    await this.azure.createQueue(queueName);
  }

  /**
   * Delete a queue
   */
  async deleteQueue(queueName: string): Promise<void> {
    await this.azure.deleteQueue(queueName);
  }

  /**
   * List all queues
   */
  async listQueues(): Promise<string[]> {
    return await this.azure.listQueues();
  }
}




