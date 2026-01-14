/**
 * Dead Letter Queue Manager for AzureCQ
 * Handles message failures, retries, and DLQ operations
 */

import { RedisManager } from './redis-manager';
import { AzureManager } from './azure-manager';
import {
  QueueMessage,
  ProcessingAttempt,
  DeadLetterQueueInfo,
  MessageMoveResult,
  BatchMessageMoveResult,
  NackOptions,
  QueueConfiguration,
  AzureCQError,
  ErrorCodes
} from './types';
import { v4 as uuidv4 } from 'uuid';

export class DeadLetterManager {
  private redis: RedisManager;
  private azure: AzureManager;
  private config: QueueConfiguration;
  private dlqAzure: AzureManager;

  constructor(
    redis: RedisManager,
    azure: AzureManager,
    config: QueueConfiguration
  ) {
    this.redis = redis;
    this.azure = azure;
    this.config = config;
    
    // Create separate Azure manager for DLQ
    this.dlqAzure = new AzureManager({
      connectionString: config.azure.connectionString,
      queueName: this.getDlqName(config.name),
      containerName: config.azure.containerName,
      maxInlineMessageSize: config.settings.maxInlineMessageSize
    });
  }

  /**
   * Initialize DLQ resources
   */
  async initialize(): Promise<void> {
    if (this.config.settings.deadLetter.enabled) {
      await this.dlqAzure.initialize();
    }
  }

  /**
   * Handle message processing failure (NACK)
   * Automatically moves to DLQ if max attempts exceeded
   */
  async nackMessage(
    message: QueueMessage,
    options: NackOptions = {}
  ): Promise<MessageMoveResult> {
    if (!this.config.settings.deadLetter.enabled) {
      throw new AzureCQError(
        'Dead letter queue is not enabled',
        ErrorCodes.DEAD_LETTER_QUEUE_ERROR
      );
    }

    // Record processing attempt
    const attempt: ProcessingAttempt = {
      attemptNumber: message.dequeueCount + 1,
      timestamp: new Date(),
      error: options.reason || 'Processing failed',
      workerId: process.env.WORKER_ID || 'unknown'
    };

    // Add to processing history
    if (!message.processingHistory) {
      message.processingHistory = [];
    }
    message.processingHistory.push(attempt);

    // Check if should move to DLQ
    const shouldMoveToDlq = options.forceDlq || 
      message.dequeueCount >= this.config.settings.deadLetter.maxDeliveryAttempts;

    if (shouldMoveToDlq) {
      return await this.moveMessageToDlq(
        message,
        options.reason || `Exceeded max delivery attempts (${this.config.settings.deadLetter.maxDeliveryAttempts})`
      );
    } else {
      // Retry: Make message visible again after delay
      const retryDelay = options.retryDelaySeconds || this.calculateRetryDelay(message.dequeueCount);
      return await this.scheduleRetry(message, retryDelay);
    }
  }

  /**
   * Manually move a message to dead letter queue
   */
  async moveMessageToDlq(message: QueueMessage, reason: string): Promise<MessageMoveResult> {
    try {
      // Prepare DLQ message
      const dlqMessage: QueueMessage = {
        ...message,
        originalQueueName: message.originalQueueName || this.config.name,
        dlqReason: reason,
        dlqTimestamp: new Date(),
        dequeueCount: 0, // Reset for DLQ
        nextVisibleOn: new Date() // Immediately visible in DLQ
      };

      // Add to DLQ
      await this.dlqAzure.enqueueMessage(
        dlqMessage.content,
        {
          ...dlqMessage.metadata,
          originalQueueName: dlqMessage.originalQueueName,
          dlqReason: reason,
          dlqTimestamp: dlqMessage.dlqTimestamp,
          processingHistory: dlqMessage.processingHistory
        },
        undefined, // No visibility timeout
        this.config.settings.deadLetter.messageTtl
      );

      // Remove from original queue if pop receipt exists
      if (message.popReceipt) {
        try {
          await this.azure.acknowledgeMessage(message.id, message.popReceipt);
        } catch (error) {
          console.warn('Failed to acknowledge original message during DLQ move:', error);
        }
      }

      // Remove from Redis cache
      await Promise.all([
        this.redis.removeCachedMessage(this.config.name, message.id),
        this.redis.removeFromHotQueue(this.config.name, message.id)
      ]);

      return {
        success: true,
        messageId: message.id,
        sourceQueue: this.config.name,
        destinationQueue: this.getDlqName(this.config.name),
        action: 'moved_to_dlq'
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        messageId: message.id,
        sourceQueue: this.config.name,
        destinationQueue: this.getDlqName(this.config.name)
      };
    }
  }

  /**
   * Move a message from dead letter queue back to main queue
   * 
   * Note: Azure Queue Storage doesn't support fetching a specific message by ID.
   * This method will search through visible messages in batches. For large DLQs,
   * consider using moveAllFromDeadLetter() instead.
   * 
   * @param messageId - The ID of the message to move
   * @param maxSearchBatches - Maximum number of batches to search (default: 10, each batch = 32 messages)
   */
  async moveMessageFromDlq(messageId: string, maxSearchBatches: number = 10): Promise<MessageMoveResult> {
    try {
      // Search through multiple batches to find the message
      let targetMessage: QueueMessage | undefined;
      let batchesSearched = 0;
      const processedMessages: QueueMessage[] = [];

      while (batchesSearched < maxSearchBatches) {
        const dlqMessages = await this.dlqAzure.dequeueMessages(32);
        batchesSearched++;
        
        if (dlqMessages.length === 0) {
          break; // Queue is empty
        }

        for (const msg of dlqMessages) {
          if (msg.id === messageId) {
            targetMessage = msg;
          } else {
            processedMessages.push(msg);
          }
        }

        if (targetMessage) {
          break; // Found our message
        }
      }

      // Re-enqueue messages that weren't our target (make them visible again immediately)
      // This minimizes the window where other messages are invisible
      for (const msg of processedMessages) {
        try {
          await this.dlqAzure.enqueueMessage(msg.content, msg.metadata, 0);
          if (msg.popReceipt) {
            await this.dlqAzure.acknowledgeMessage(msg.id, msg.popReceipt);
          }
        } catch (reEnqueueError) {
          console.warn(`Failed to re-enqueue DLQ message ${msg.id}:`, reEnqueueError);
          // Message will become visible again after visibility timeout expires
        }
      }

      if (!targetMessage) {
        return {
          success: false,
          error: `Message not found in dead letter queue after searching ${batchesSearched} batches (${batchesSearched * 32} messages). Message may not exist or may be temporarily invisible.`,
          messageId,
          sourceQueue: this.getDlqName(this.config.name),
          destinationQueue: this.config.name,
          action: 'moved_from_dlq'
        };
      }

      // Prepare message for main queue
      const restoredMessage: QueueMessage = {
        ...targetMessage,
        dequeueCount: 0, // Reset delivery count
        nextVisibleOn: new Date(), // Immediately available
        dlqReason: undefined,
        dlqTimestamp: undefined
      };

      // Add back to main queue
      await this.azure.enqueueMessage(
        restoredMessage.content,
        restoredMessage.metadata,
        undefined, // No visibility timeout
        undefined  // Use default TTL
      );

      // Acknowledge removal from DLQ
      if (targetMessage.popReceipt) {
        await this.dlqAzure.acknowledgeMessage(targetMessage.id, targetMessage.popReceipt);
      }

      return {
        success: true,
        messageId,
        sourceQueue: this.getDlqName(this.config.name),
        destinationQueue: this.config.name,
        action: 'moved_from_dlq'
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        messageId,
        sourceQueue: this.getDlqName(this.config.name),
        destinationQueue: this.config.name
      };
    }
  }

  /**
   * Batch move messages to DLQ
   */
  async moveMessagesToDlq(
    messages: Array<{ message: QueueMessage; reason: string }>
  ): Promise<BatchMessageMoveResult> {
    const results: MessageMoveResult[] = [];

    for (const { message, reason } of messages) {
      const result = await this.moveMessageToDlq(message, reason);
      results.push(result);
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    return {
      success: failureCount === 0,
      results,
      successCount,
      failureCount
    };
  }

  /**
   * Batch move messages from DLQ back to main queue
   */
  async moveMessagesFromDlq(messageIds: string[]): Promise<BatchMessageMoveResult> {
    const results: MessageMoveResult[] = [];

    for (const messageId of messageIds) {
      const result = await this.moveMessageFromDlq(messageId);
      results.push(result);
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    return {
      success: failureCount === 0,
      results,
      successCount,
      failureCount
    };
  }

  /**
   * Get dead letter queue information
   */
  async getDlqInfo(): Promise<DeadLetterQueueInfo> {
    if (!this.config.settings.deadLetter.enabled) {
      return {
        isEnabled: false,
        queueName: this.getDlqName(this.config.name),
        messageCount: 0,
        maxDeliveryAttempts: this.config.settings.deadLetter.maxDeliveryAttempts,
        messageTtl: this.config.settings.deadLetter.messageTtl
      };
    }

    try {
      const stats = await this.dlqAzure.getQueueStats();
      
      // Get oldest and newest message timestamps by peeking messages (non-destructive)
      let oldestMessage: Date | undefined;
      let newestMessage: Date | undefined;

      if (stats.messageCount > 0) {
        try {
          // Use peekMessages instead of dequeueMessages to avoid consuming messages
          const sampleMessages = await this.dlqAzure.peekMessages(32);
          
          if (sampleMessages.length > 0) {
            const timestamps = sampleMessages.map(msg => msg.insertedOn);
            oldestMessage = new Date(Math.min(...timestamps.map(d => d.getTime())));
            newestMessage = new Date(Math.max(...timestamps.map(d => d.getTime())));
          }
        } catch (peekError) {
          console.warn('Failed to peek DLQ messages for timestamp info:', peekError);
        }
      }

      return {
        isEnabled: this.config.settings.deadLetter.enabled,
        queueName: this.getDlqName(this.config.name),
        messageCount: stats.messageCount,
        maxDeliveryAttempts: this.config.settings.deadLetter.maxDeliveryAttempts,
        messageTtl: this.config.settings.deadLetter.messageTtl,
        oldestMessage,
        newestMessage
      };

    } catch (error) {
      throw new AzureCQError(
        'Failed to get DLQ information',
        ErrorCodes.DEAD_LETTER_QUEUE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Purge all messages from dead letter queue
   * 
   * @param maxIterations - Maximum number of batch iterations to prevent infinite loops (default: 1000)
   * @param maxConsecutiveFailures - Stop if this many consecutive acknowledgments fail (default: 10)
   */
  async purgeDlq(
    maxIterations: number = 1000,
    maxConsecutiveFailures: number = 10
  ): Promise<{ success: boolean; queueName: string; purgedCount?: number; skippedCount?: number; error?: string }> {
    if (!this.config.settings.deadLetter.enabled) {
      throw new AzureCQError(
        'Dead letter queue is not enabled',
        ErrorCodes.DEAD_LETTER_QUEUE_ERROR
      );
    }

    let purgedCount = 0;
    let skippedCount = 0;
    let consecutiveFailures = 0;
    let iterations = 0;
    
    try {
      while (iterations < maxIterations) {
        iterations++;
        const messages = await this.dlqAzure.dequeueMessages(32);
        
        if (messages.length === 0) {
          break; // Queue is empty
        }

        // Acknowledge all messages to delete them
        for (const message of messages) {
          if (message.popReceipt) {
            try {
              await this.dlqAzure.acknowledgeMessage(message.id, message.popReceipt);
              purgedCount++;
              consecutiveFailures = 0; // Reset on success
            } catch (ackError) {
              console.warn(`Failed to acknowledge DLQ message ${message.id} during purge:`, ackError);
              skippedCount++;
              consecutiveFailures++;
              
              if (consecutiveFailures >= maxConsecutiveFailures) {
                return {
                  success: false,
                  queueName: this.getDlqName(this.config.name),
                  purgedCount,
                  skippedCount,
                  error: `Stopped after ${maxConsecutiveFailures} consecutive acknowledgment failures`
                };
              }
            }
          } else {
            skippedCount++;
          }
        }
      }

      if (iterations >= maxIterations) {
        return {
          success: false,
          queueName: this.getDlqName(this.config.name),
          purgedCount,
          skippedCount,
          error: `Stopped after reaching maximum iterations (${maxIterations}). Queue may still contain messages.`
        };
      }

      return {
        success: true,
        queueName: this.getDlqName(this.config.name),
        purgedCount,
        skippedCount
      };

    } catch (error) {
      return {
        success: false,
        queueName: this.getDlqName(this.config.name),
        purgedCount,
        skippedCount,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Schedule a retry for a failed message
   */
  private async scheduleRetry(message: QueueMessage, delaySeconds: number): Promise<MessageMoveResult> {
    try {
      // Update message visibility timeout to delay retry
      const retryTime = new Date(Date.now() + (delaySeconds * 1000));
      
      // Re-enqueue with delay
      await this.azure.enqueueMessage(
        message.content,
        {
          ...message.metadata,
          processingHistory: message.processingHistory
        },
        delaySeconds // Visibility timeout = retry delay
      );

      // If we have pop receipt, acknowledge the original
      if (message.popReceipt) {
        await this.azure.acknowledgeMessage(message.id, message.popReceipt);
      }

      return {
        success: true,
        messageId: message.id,
        sourceQueue: this.config.name,
        destinationQueue: this.config.name,
        action: 'retry',
        retryDelaySeconds: delaySeconds
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        messageId: message.id,
        sourceQueue: this.config.name,
        destinationQueue: this.config.name
      };
    }
  }

  /**
   * Calculate exponential backoff retry delay
   */
  private calculateRetryDelay(attemptNumber: number): number {
    const baseDelay = this.config.settings.retry.backoffMs / 1000; // Convert to seconds
    const maxDelay = 300; // 5 minutes max
    
    const delay = Math.min(baseDelay * Math.pow(2, attemptNumber), maxDelay);
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.3; // ±30% jitter
    return Math.floor(delay * (1 + jitter));
  }

  /**
   * Get DLQ name for a given queue
   */
  private getDlqName(queueName: string): string {
    return `${queueName}${this.config.settings.deadLetter.queueSuffix}`;
  }
}
