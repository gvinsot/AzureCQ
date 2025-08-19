/**
 * Azure Storage Queue and Blob integration
 */

import { QueueServiceClient, QueueClient } from '@azure/storage-queue';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { QueueMessage, QueueStats, AzureCQError, ErrorCodes } from './types';
import { v4 as uuidv4 } from 'uuid';

export class AzureManager {
  private queueServiceClient!: QueueServiceClient;
  private blobServiceClient!: BlobServiceClient;
  private queueClient!: QueueClient;
  private containerClient!: ContainerClient;
  private maxInlineMessageSize: number;
  private config: {
    connectionString: string;
    queueName: string;
    containerName: string;
    maxInlineMessageSize: number;
  };
  private retryConfig = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2
  };

  constructor(config: {
    connectionString: string;
    queueName: string;
    containerName: string;
    maxInlineMessageSize: number;
  }) {
    this.config = config;
    this.maxInlineMessageSize = config.maxInlineMessageSize;
    
    this.initializeClients();
  }

  private initializeClients(): void {
    try {
      this.queueServiceClient = QueueServiceClient.fromConnectionString(this.config.connectionString);
      this.blobServiceClient = BlobServiceClient.fromConnectionString(this.config.connectionString);
      
      this.queueClient = this.queueServiceClient.getQueueClient(this.config.queueName);
      this.containerClient = this.blobServiceClient.getContainerClient(this.config.containerName);
    } catch (error) {
      throw new AzureCQError(
        'Failed to initialize Azure Storage clients',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Execute Azure Storage operation with retry logic
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    allowRetry: boolean = true
  ): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        const result = await operation();
        
        // If we succeed after a retry, log it
        if (attempt > 1) {
          console.log(`Azure ${operationName} succeeded on attempt ${attempt}`);
        }
        
        return result;
        
      } catch (error) {
        lastError = error as Error;
        
        // Check if this is a retryable error
        if (!allowRetry || !this.isRetryableError(lastError) || attempt === this.retryConfig.maxAttempts) {
          console.error(`Azure ${operationName} failed on attempt ${attempt}:`, lastError.message);
          break;
        }
        
        // Calculate delay with exponential backoff and jitter
        const baseDelay = this.retryConfig.baseDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt - 1);
        const delayWithJitter = Math.min(baseDelay, this.retryConfig.maxDelayMs) * (0.5 + Math.random() * 0.5);
        
        console.warn(`Azure ${operationName} failed on attempt ${attempt}, retrying in ${Math.round(delayWithJitter)}ms:`, lastError.message);
        
        await new Promise(resolve => setTimeout(resolve, delayWithJitter));
        
        // For connection errors, try to reinitialize clients
        if (this.isConnectionError(lastError)) {
          try {
            this.initializeClients();
            console.log('Azure Storage clients reinitialized after connection error');
          } catch (reinitError) {
            console.warn('Failed to reinitialize Azure Storage clients:', reinitError);
          }
        }
      }
    }
    
    // All retries exhausted
    throw new AzureCQError(
      `Failed to execute Azure ${operationName} after ${this.retryConfig.maxAttempts} attempts`,
      ErrorCodes.AZURE_STORAGE_ERROR,
      lastError
    );
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    const errorCode = (error as any).code;
    
    // Network-related errors
    const networkErrors = [
      'econnreset',
      'enotfound',
      'etimedout',
      'econnrefused',
      'socket hang up',
      'network error',
      'request timeout'
    ];
    
    // Azure Storage specific retryable errors
    const azureRetryableErrors = [
      'InternalError',
      'ServerBusy',
      'ServiceUnavailable',
      'RequestTimeout',
      'OperationTimedOut'
    ];
    
    // HTTP status codes that are retryable
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    
    return (
      networkErrors.some(err => message.includes(err)) ||
      azureRetryableErrors.some(err => message.includes(err.toLowerCase()) || errorCode === err) ||
      retryableStatusCodes.some(code => message.includes(code.toString()) || (error as any).statusCode === code)
    );
  }

  /**
   * Check if error is connection-related
   */
  private isConnectionError(error: Error): boolean {
    const message = error.message.toLowerCase();
    const connectionErrors = [
      'econnreset',
      'enotfound',
      'etimedout',
      'econnrefused',
      'socket hang up',
      'network error'
    ];
    
    return connectionErrors.some(err => message.includes(err));
  }

  /**
   * Initialize Azure Storage resources with retry logic
   */
  async initialize(): Promise<void> {
    await this.executeWithRetry(async () => {
      // Create queue if it doesn't exist
      await this.queueClient.createIfNotExists();
      
      // Create blob container if it doesn't exist
      await this.containerClient.createIfNotExists();
    }, 'initialize');
  }

  /**
   * Enqueue a single message
   */
  async enqueueMessage(
    message: string | Buffer,
    metadata?: Record<string, any>,
    visibilityTimeoutSeconds?: number,
    timeToLiveSeconds?: number
  ): Promise<QueueMessage> {
    const messageId = uuidv4();
    const messageContent = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');
    
    let actualContent: string;
    let isUsingBlob = false;

    // Check if message is too large for inline storage
    if (messageContent.length > this.maxInlineMessageSize) {
      const blobName = `msg-${messageId}`;
      await this.storeLargeMessageInBlob(blobName, messageContent);
      actualContent = JSON.stringify({
        type: 'blob_reference',
        blobName,
        size: messageContent.length,
        metadata
      });
      isUsingBlob = true;
    } else {
      actualContent = JSON.stringify({
        type: 'inline',
        content: messageContent.toString('base64'),
        metadata
      });
    }

    try {
      const response = await this.executeWithRetry(async () => {
        return await this.queueClient.sendMessage(
          actualContent,
          {
            visibilityTimeout: visibilityTimeoutSeconds,
            messageTimeToLive: timeToLiveSeconds
          }
        );
      }, 'enqueueMessage');

      return {
        id: response.messageId,
        content: messageContent,
        metadata: metadata || {},
        dequeueCount: 0,
        insertedOn: response.insertedOn || new Date(),
        nextVisibleOn: response.nextVisibleOn || new Date(),
        popReceipt: response.popReceipt
      };
    } catch (error) {
      // Clean up blob if message enqueue failed
      if (isUsingBlob) {
        try {
          await this.deleteLargeMessageFromBlob(`msg-${messageId}`);
        } catch (cleanupError) {
          console.warn('Failed to cleanup blob after enqueue failure:', cleanupError);
        }
      }
      
      throw error; // Re-throw the AzureCQError from executeWithRetry
    }
  }

  /**
   * Enqueue multiple messages in batch
   */
  async enqueueMessageBatch(
    messages: Array<{
      content: string | Buffer;
      metadata?: Record<string, any>;
      visibilityTimeoutSeconds?: number;
      timeToLiveSeconds?: number;
    }>
  ): Promise<QueueMessage[]> {
    const results: QueueMessage[] = [];
    const concurrency = Math.min(64, messages.length);

    try {
      for (let i = 0; i < messages.length; i += concurrency) {
        const slice = messages.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          slice.map(msg =>
            this.enqueueMessage(
              msg.content,
              msg.metadata,
              msg.visibilityTimeoutSeconds,
              msg.timeToLiveSeconds
            )
          )
        );
        results.push(...batchResults);
      }

      return results;
    } catch (error) {
      throw new AzureCQError(
        'Failed to enqueue message batch',
        ErrorCodes.BATCH_OPERATION_FAILED,
        error as Error
      );
    }
  }

  /**
   * Dequeue messages
   */
  async dequeueMessages(
    maxMessages: number = 1,
    visibilityTimeoutSeconds?: number
  ): Promise<QueueMessage[]> {
    try {
      const response = await this.queueClient.receiveMessages({
        numberOfMessages: Math.min(maxMessages, 32), // Azure limit is 32
        visibilityTimeout: visibilityTimeoutSeconds
      });

      const messages: QueueMessage[] = [];
      
      for (const azureMessage of response.receivedMessageItems || []) {
        try {
          const parsedContent = JSON.parse(azureMessage.messageText);
          let actualContent: Buffer;

          if (parsedContent.type === 'blob_reference') {
            // Retrieve large message from blob
            actualContent = await this.retrieveLargeMessageFromBlob(parsedContent.blobName);
          } else if (parsedContent.type === 'inline') {
            // Decode inline message
            actualContent = Buffer.from(parsedContent.content, 'base64');
          } else {
            throw new Error('Unknown message type');
          }

          messages.push({
            id: azureMessage.messageId,
            content: actualContent,
            metadata: parsedContent.metadata || {},
            dequeueCount: azureMessage.dequeueCount || 0,
            insertedOn: azureMessage.insertedOn || new Date(),
            nextVisibleOn: azureMessage.nextVisibleOn || new Date(),
            popReceipt: azureMessage.popReceipt
          });
        } catch (parseError) {
          console.error('Failed to parse message:', parseError);
          // Skip malformed messages
          continue;
        }
      }

      return messages;
    } catch (error) {
      throw new AzureCQError(
        'Failed to dequeue messages',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Acknowledge (delete) a message
   */
  async acknowledgeMessage(messageId: string, popReceipt: string): Promise<void> {
    try {
      await this.queueClient.deleteMessage(messageId, popReceipt);
    } catch (error) {
      throw new AzureCQError(
        'Failed to acknowledge message',
        ErrorCodes.ACKNOWLEDGMENT_FAILED,
        error as Error
      );
    }
  }

  /**
   * Acknowledge multiple messages in batch
   */
  async acknowledgeMessageBatch(
    messages: Array<{ messageId: string; popReceipt: string }>
  ): Promise<Array<{ messageId: string; success: boolean; error?: string }>> {
    const results: Array<{ messageId: string; success: boolean; error?: string }> = [];
    const concurrency = Math.min(64, messages.length);

    for (let i = 0; i < messages.length; i += concurrency) {
      const slice = messages.slice(i, i + concurrency);
      const batch = await Promise.all(
        slice.map(async (msg) => {
          try {
            await this.acknowledgeMessage(msg.messageId, msg.popReceipt);
            return { messageId: msg.messageId, success: true };
          } catch (error) {
            return {
              messageId: msg.messageId,
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        })
      );
      results.push(...batch);
    }
    return results;
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<QueueStats> {
    try {
      const properties = await this.queueClient.getProperties();
      
      return {
        name: this.queueClient.name,
        messageCount: properties.approximateMessagesCount || 0,
        invisibleMessageCount: 0, // Azure doesn't provide this directly
        createdOn: new Date(), // Would need to be tracked separately
        lastModified: new Date()
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
   * Create a new queue
   */
  async createQueue(queueName: string): Promise<void> {
    try {
      const newQueueClient = this.queueServiceClient.getQueueClient(queueName);
      await newQueueClient.create();
    } catch (error) {
      throw new AzureCQError(
        `Failed to create queue: ${queueName}`,
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * Delete a queue
   */
  async deleteQueue(queueName: string): Promise<void> {
    try {
      const queueToDelete = this.queueServiceClient.getQueueClient(queueName);
      await queueToDelete.delete();
    } catch (error) {
      throw new AzureCQError(
        `Failed to delete queue: ${queueName}`,
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  /**
   * List all queues
   */
  async listQueues(): Promise<string[]> {
    try {
      const queues: string[] = [];
      for await (const queue of this.queueServiceClient.listQueues()) {
        queues.push(queue.name);
      }
      return queues;
    } catch (error) {
      throw new AzureCQError(
        'Failed to list queues',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  private async storeLargeMessageInBlob(blobName: string, content: Buffer): Promise<void> {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(content, content.length);
    } catch (error) {
      throw new AzureCQError(
        'Failed to store large message in blob',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  private async retrieveLargeMessageFromBlob(blobName: string): Promise<Buffer> {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      const response = await blockBlobClient.download();
      
      if (!response.readableStreamBody) {
        throw new Error('No readable stream from blob');
      }

      const chunks: Buffer[] = [];
      for await (const chunk of response.readableStreamBody) {
        chunks.push(Buffer.from(chunk));
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      throw new AzureCQError(
        'Failed to retrieve large message from blob',
        ErrorCodes.AZURE_STORAGE_ERROR,
        error as Error
      );
    }
  }

  private async deleteLargeMessageFromBlob(blobName: string): Promise<void> {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.delete();
    } catch (error) {
      // Non-critical error - log and continue
      console.warn('Failed to delete blob:', error);
    }
  }
}
