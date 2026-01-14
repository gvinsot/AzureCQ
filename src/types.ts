/**
 * Core types and interfaces for AzureCQ queue system
 */

export interface QueueMessage {
  /** Unique message identifier */
  id: string;
  /** Message payload */
  content: string | Buffer;
  /** Message metadata */
  metadata?: Record<string, any>;
  /** Number of times this message has been dequeued */
  dequeueCount: number;
  /** When the message was first enqueued */
  insertedOn: Date;
  /** When the message becomes visible for dequeue */
  nextVisibleOn: Date;
  /** Pop receipt for acknowledgment */
  popReceipt?: string;
  /** Original queue name (for DLQ messages) */
  originalQueueName?: string;
  /** Reason for being in DLQ */
  dlqReason?: string;
  /** When message was moved to DLQ */
  dlqTimestamp?: Date;
  /** Processing attempt history */
  processingHistory?: ProcessingAttempt[];
}

export interface QueueMessageBatch {
  /** Array of messages in the batch */
  messages: QueueMessage[];
  /** Batch metadata */
  batchId: string;
  /** Number of messages in batch */
  count: number;
}

export interface EnqueueOptions {
  /** Delay before message becomes visible (seconds) */
  visibilityTimeout?: number;
  /** Message time-to-live (seconds) */
  timeToLive?: number;
  /** Message metadata */
  metadata?: Record<string, any>;
}

export interface DequeueOptions {
  /** How long message stays invisible after dequeue (seconds) */
  visibilityTimeout?: number;
  /** Maximum number of messages to dequeue */
  maxMessages?: number;
}

export interface QueueConfiguration {
  /** Queue name */
  name: string;
  /** Redis connection configuration */
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
    performanceProfile?: 'HIGH_THROUGHPUT' | 'LOW_LATENCY' | 'MEMORY_OPTIMIZED' | 'BALANCED';
  };
  /** Azure Storage configuration */
  azure: {
    connectionString: string;
    queueName: string;
    containerName: string;
  };
  /** Performance and behavior settings */
  settings: {
    /** Max message size before using blob storage (bytes) */
    maxInlineMessageSize: number;
    /** Redis cache TTL for hot messages (seconds) */
    redisCacheTtl: number;
    /** Batch size for Azure Storage operations */
    batchSize: number;
    /** Hot path optimization - delay before Azure write (ms). Set to 0 for durability-critical scenarios */
    hotPathDelayMs?: number;
    /** 
     * If true, enqueue waits for Azure write confirmation before returning.
     * Slower but guarantees durability. Default: false (fire-and-forget for performance)
     */
    syncAzureWrites?: boolean;
    /** Retry configuration */
    retry: {
      maxAttempts: number;
      backoffMs: number;
    };
    /** Dead letter queue configuration */
    deadLetter: {
      /** Enable dead letter queue functionality */
      enabled: boolean;
      /** Maximum number of delivery attempts before sending to DLQ */
      maxDeliveryAttempts: number;
      /** Dead letter queue name suffix */
      queueSuffix: string;
      /** DLQ message TTL in seconds */
      messageTtl: number;
    };
  };
}

export interface QueueStats {
  /** Queue name */
  name: string;
  /** Approximate number of messages */
  messageCount: number;
  /** Number of messages currently invisible */
  invisibleMessageCount: number;
  /** Queue creation time */
  createdOn: Date;
  /** Last modified time */
  lastModified: Date;
}

export interface AcknowledgmentResult {
  /** Whether acknowledgment was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Message ID that was acknowledged */
  messageId: string;
}

export interface BatchAcknowledgmentResult {
  /** Overall batch acknowledgment success */
  success: boolean;
  /** Individual acknowledgment results */
  results: AcknowledgmentResult[];
  /** Batch ID */
  batchId: string;
  /** Number of successfully acknowledged messages */
  successCount: number;
  /** Number of failed acknowledgments */
  failureCount: number;
}

export class AzureCQError extends Error {
  constructor(
    message: string,
    public code: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'AzureCQError';
  }
}

export interface ProcessingAttempt {
  /** Attempt number */
  attemptNumber: number;
  /** Timestamp of attempt */
  timestamp: Date;
  /** Error message if failed */
  error?: string;
  /** Processing duration in milliseconds */
  durationMs?: number;
  /** Worker/instance that processed the message */
  workerId?: string;
}

export interface DeadLetterQueueInfo {
  /** Whether DLQ is enabled */
  isEnabled: boolean;
  /** DLQ name */
  queueName: string;
  /** Number of messages in DLQ */
  messageCount: number;
  /** Maximum delivery attempts before DLQ */
  maxDeliveryAttempts: number;
  /** Message TTL in DLQ (seconds) */
  messageTtl: number;
  /** Oldest message timestamp */
  oldestMessage?: Date;
  /** Newest message timestamp */
  newestMessage?: Date;
}

export interface MessageMoveResult {
  /** Whether the move was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Message ID that was moved */
  messageId: string;
  /** Source queue */
  sourceQueue: string;
  /** Destination queue */
  destinationQueue: string;
  /** Action taken (retry, moved_to_dlq, moved_from_dlq) */
  action?: 'retry' | 'moved_to_dlq' | 'moved_from_dlq';
  /** Retry delay in seconds (for retry actions) */
  retryDelaySeconds?: number;
}

export interface BatchMessageMoveResult {
  /** Overall batch move success */
  success: boolean;
  /** Individual move results */
  results: MessageMoveResult[];
  /** Number of successfully moved messages */
  successCount: number;
  /** Number of failed moves */
  failureCount: number;
}

export interface NackOptions {
  /** Reason for negative acknowledgment */
  reason?: string;
  /** Force move to DLQ regardless of attempt count */
  forceDlq?: boolean;
  /** Custom retry delay in seconds */
  retryDelaySeconds?: number;
}

export enum ErrorCodes {
  QUEUE_NOT_FOUND = 'QUEUE_NOT_FOUND',
  MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND',
  INVALID_POP_RECEIPT = 'INVALID_POP_RECEIPT',
  MESSAGE_TOO_LARGE = 'MESSAGE_TOO_LARGE',
  REDIS_CONNECTION_ERROR = 'REDIS_CONNECTION_ERROR',
  AZURE_STORAGE_ERROR = 'AZURE_STORAGE_ERROR',
  ACKNOWLEDGMENT_FAILED = 'ACKNOWLEDGMENT_FAILED',
  BATCH_OPERATION_FAILED = 'BATCH_OPERATION_FAILED',
  DEAD_LETTER_QUEUE_ERROR = 'DEAD_LETTER_QUEUE_ERROR',
  MESSAGE_MOVE_FAILED = 'MESSAGE_MOVE_FAILED',
}



