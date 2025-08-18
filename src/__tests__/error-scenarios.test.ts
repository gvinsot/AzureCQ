/**
 * Comprehensive Error Scenario Tests
 * Tests for Dead Letter Queue behavior, error handling, and failure scenarios
 */

import { AzureCQ } from '../azurecq';
import { QueueConfiguration, QueueMessage, AzureCQError, ErrorCodes } from '../types';

// Mock dependencies
jest.mock('ioredis');
jest.mock('@azure/storage-queue');
jest.mock('@azure/storage-blob');

describe('Error Scenarios & Dead Letter Queue Tests', () => {
  let queue: AzureCQ;
  let mockRedis: any;
  let mockQueueClient: any;
  let mockContainerClient: any;
  let testConfig: QueueConfiguration;

  const createTestMessage = (overrides = {}): QueueMessage => ({
    id: 'test-message-123',
    content: Buffer.from('Test message content'),
    metadata: { type: 'test', source: 'error-test' },
    dequeueCount: 0,
    insertedOn: new Date('2023-01-01T00:00:00Z'),
    nextVisibleOn: new Date('2023-01-01T01:00:00Z'),
    popReceipt: 'test-receipt-456',
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Redis
    mockRedis = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      pipeline: jest.fn().mockReturnValue({
        setex: jest.fn(),
        get: jest.fn(),
        exec: jest.fn().mockResolvedValue([])
      }),
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      zadd: jest.fn().mockResolvedValue(1),
      zpopmin: jest.fn().mockResolvedValue([]),
      zrem: jest.fn().mockResolvedValue(1),
      zcard: jest.fn().mockResolvedValue(0),
      on: jest.fn(),
      off: jest.fn()
    };

    // Mock Queue Client
    mockQueueClient = {
      create: jest.fn().mockResolvedValue({}),
      sendMessage: jest.fn(),
      receiveMessages: jest.fn(),
      deleteMessage: jest.fn().mockResolvedValue({}),
      getProperties: jest.fn().mockResolvedValue({ approximateMessagesCount: 0 }),
      clearMessages: jest.fn().mockResolvedValue({})
    };

    // Mock Container Client
    mockContainerClient = {
      create: jest.fn().mockResolvedValue({}),
      getBlockBlobClient: jest.fn().mockReturnValue({
        upload: jest.fn().mockResolvedValue({}),
        downloadToBuffer: jest.fn().mockResolvedValue(Buffer.from('blob-content')),
        delete: jest.fn().mockResolvedValue({})
      }),
      deleteBlob: jest.fn().mockResolvedValue({})
    };

    // Setup Azure SDK mocks
    const { QueueServiceClient } = require('@azure/storage-queue');
    const { BlobServiceClient } = require('@azure/storage-blob');
    const Redis = require('ioredis');

    Redis.mockImplementation(() => mockRedis);
    QueueServiceClient.mockImplementation(() => ({
      getQueueClient: jest.fn().mockReturnValue(mockQueueClient)
    }));
    BlobServiceClient.mockImplementation(() => ({
      getContainerClient: jest.fn().mockReturnValue(mockContainerClient)
    }));

    // Test configuration with DLQ enabled
    testConfig = {
      name: 'error-test-queue',
      redis: {
        host: 'localhost',
        port: 6379,
        keyPrefix: 'test:'
      },
      azure: {
        connectionString: 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net',
        queueName: 'error-test-queue',
        containerName: 'error-test-container'
      },
      settings: {
        maxInlineMessageSize: 64 * 1024,
        redisCacheTtl: 3600,
        batchSize: 32,
        retry: { maxAttempts: 3, backoffMs: 1000 },
        deadLetter: {
          enabled: true,
          maxDeliveryAttempts: 3,
          queueSuffix: '-dlq',
          messageTtl: 24 * 3600
        }
      }
    };

    queue = new AzureCQ(testConfig);
  });

  afterEach(async () => {
    try {
      await queue.shutdown();
    } catch (error) {
      // Ignore shutdown errors in tests
    }
  });

  describe('Dead Letter Queue - Message Processing Failures', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should move message to DLQ after max delivery attempts exceeded', async () => {
      const failingMessage = createTestMessage({ 
        dequeueCount: 3 // At max delivery attempts
      });

      // Mock DLQ enqueue success
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'dlq-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'dlq-receipt'
      });

      const nackResult = await queue.nack(failingMessage, {
        reason: 'Processing failed after max attempts'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.messageId).toBe(failingMessage.id);
      expect(nackResult.sourceQueue).toBe('error-test-queue');
      expect(nackResult.destinationQueue).toBe('error-test-queue-dlq');

      // Verify DLQ message was enqueued with proper metadata
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('"dlqReason":"Processing failed after max attempts"'),
        expect.objectContaining({
          messageTimeToLive: 24 * 3600
        })
      );
    });

    it('should retry message when under max delivery attempts', async () => {
      const retryableMessage = createTestMessage({ 
        dequeueCount: 1 // Under max attempts
      });

      // Mock retry enqueue success
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'retry-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'retry-receipt'
      });

      const nackResult = await queue.nack(retryableMessage, {
        reason: 'Temporary processing error'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.messageId).toBe(retryableMessage.id);

      // Verify message was re-enqueued with processing history
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('"processingHistory"'),
        expect.objectContaining({
          visibilityTimeout: expect.any(Number) // Should have retry delay
        })
      );
    });

    it('should force move to DLQ regardless of attempt count', async () => {
      const criticalFailureMessage = createTestMessage({ 
        dequeueCount: 1 // Under normal max attempts
      });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'force-dlq-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'force-dlq-receipt'
      });

      const nackResult = await queue.nack(criticalFailureMessage, {
        reason: 'Critical system error - cannot retry',
        forceDlq: true
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.destinationQueue).toBe('error-test-queue-dlq');

      // Should bypass retry and go straight to DLQ
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('"dlqReason":"Critical system error - cannot retry"'),
        expect.objectContaining({
          messageTimeToLive: 24 * 3600
        })
      );
    });

    it('should handle DLQ enqueue failures gracefully', async () => {
      const failingMessage = createTestMessage({ dequeueCount: 3 });

      // Mock DLQ enqueue failure
      mockQueueClient.sendMessage.mockRejectedValue(new Error('DLQ storage unavailable'));

      const nackResult = await queue.nack(failingMessage, {
        reason: 'Processing failed'
      });

      expect(nackResult.success).toBe(false);
      expect(nackResult.error).toContain('DLQ storage unavailable');
      expect(nackResult.messageId).toBe(failingMessage.id);
    });

    it('should preserve processing history across retries', async () => {
      const messageWithHistory = createTestMessage({
        dequeueCount: 2,
        processingHistory: [
          {
            attemptNumber: 1,
            timestamp: new Date('2023-01-01T00:30:00Z'),
            error: 'First failure',
            workerId: 'worker-1'
          },
          {
            attemptNumber: 2,
            timestamp: new Date('2023-01-01T01:00:00Z'),
            error: 'Second failure',
            workerId: 'worker-2'
          }
        ]
      });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'history-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'history-receipt'
      });

      await queue.nack(messageWithHistory, {
        reason: 'Third failure'
      });

      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringMatching(/"processingHistory":\[.*"attemptNumber":1.*"attemptNumber":2.*"attemptNumber":3/),
        expect.any(Object)
      );
    });
  });

  describe('Azure Storage Error Scenarios', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle Azure Storage service unavailable during enqueue', async () => {
      mockQueueClient.sendMessage.mockRejectedValue(new Error('Service unavailable'));

      await expect(queue.enqueue('Test message')).rejects.toThrow(AzureCQError);

      // Verify proper error classification
      try {
        await queue.enqueue('Test message');
      } catch (error) {
        expect(error).toBeInstanceOf(AzureCQError);
        expect((error as AzureCQError).code).toBe(ErrorCodes.AZURE_STORAGE_ERROR);
      }
    });

    it('should handle blob storage failures for large messages', async () => {
      const largeMessage = Buffer.alloc(testConfig.settings.maxInlineMessageSize + 1000, 'L');
      
      // Mock blob upload failure
      const mockBlobClient = mockContainerClient.getBlockBlobClient();
      mockBlobClient.upload.mockRejectedValue(new Error('Blob storage full'));

      await expect(queue.enqueue(largeMessage)).rejects.toThrow();

      // Verify cleanup attempt was made
      expect(mockContainerClient.deleteBlob).toHaveBeenCalled();
    });

    it('should handle message dequeue failures', async () => {
      mockQueueClient.receiveMessages.mockRejectedValue(new Error('Queue access denied'));

      const message = await queue.dequeue();
      
      // Should return null on Azure failure, not throw
      expect(message).toBeNull();
    });

    it('should handle acknowledgment failures', async () => {
      const testMessage = createTestMessage();
      mockQueueClient.deleteMessage.mockRejectedValue(new Error('Delete failed'));

      const ackResult = await queue.acknowledge(testMessage);

      expect(ackResult.success).toBe(false);
      expect(ackResult.error).toContain('Delete failed');
      expect(ackResult.messageId).toBe(testMessage.id);
    });
  });

  describe('Redis Connection Error Scenarios', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle Redis disconnection during message caching', async () => {
      // Simulate Redis failure
      mockRedis.pipeline().exec.mockRejectedValue(new Error('Redis connection lost'));

      // Mock successful Azure operation
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'redis-fail-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'redis-fail-receipt'
      });

      // Should succeed using Azure only (graceful degradation)
      const message = await queue.enqueue('Test message during Redis failure');

      expect(message).toBeDefined();
      expect(message.id).toBe('redis-fail-msg-123');
      expect(mockQueueClient.sendMessage).toHaveBeenCalled();
    });

    it('should handle Redis unavailable during hot queue operations', async () => {
      mockRedis.zadd.mockRejectedValue(new Error('Redis unavailable'));
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'hot-queue-fail-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'hot-queue-receipt'
      });

      // Should still succeed with Azure Storage
      const message = await queue.enqueue('Test message with hot queue failure');

      expect(message).toBeDefined();
      expect(mockQueueClient.sendMessage).toHaveBeenCalled();
    });

    it('should handle Redis failure during dequeue', async () => {
      mockRedis.zpopmin.mockRejectedValue(new Error('Redis connection error'));
      
      // Mock Azure dequeue success
      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'fallback-msg-123',
            messageText: JSON.stringify({
              type: 'inline',
              content: Buffer.from('Fallback message').toString('base64'),
              metadata: { type: 'fallback' }
            }),
            dequeueCount: 0,
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: 'fallback-receipt'
          }
        ]
      });

      const message = await queue.dequeue();

      expect(message).toBeDefined();
      expect(message!.content).toEqual(Buffer.from('Fallback message'));
    });
  });

  describe('DLQ Management Error Scenarios', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle DLQ retrieval failures', async () => {
      mockQueueClient.receiveMessages.mockRejectedValue(new Error('DLQ access failed'));

      const moveResult = await queue.moveFromDeadLetter('nonexistent-msg-123');

      expect(moveResult.success).toBe(false);
      expect(moveResult.error).toContain('DLQ access failed');
    });

    it('should handle DLQ purge failures', async () => {
      mockQueueClient.clearMessages.mockRejectedValue(new Error('Purge operation failed'));

      const purgeResult = await queue.purgeDeadLetter();

      expect(purgeResult).toBe(0); // Should return 0 on failure
    });

    it('should handle partial failures in batch DLQ operations', async () => {
      const messages = [
        { message: createTestMessage({ id: 'msg-1' }), reason: 'Error 1' },
        { message: createTestMessage({ id: 'msg-2' }), reason: 'Error 2' },
        { message: createTestMessage({ id: 'msg-3' }), reason: 'Error 3' }
      ];

      // Mock partial failure: first succeeds, second fails, third succeeds
      mockQueueClient.sendMessage
        .mockResolvedValueOnce({
          messageId: 'dlq-success-1',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'dlq-receipt-1'
        })
        .mockRejectedValueOnce(new Error('DLQ storage error'))
        .mockResolvedValueOnce({
          messageId: 'dlq-success-3',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'dlq-receipt-3'
        });

      const batchResult = await queue.moveToDeadLetterBatch(messages);

      expect(batchResult.success).toBe(false); // Overall failure due to partial failure
      expect(batchResult.successCount).toBe(2);
      expect(batchResult.failureCount).toBe(1);
      expect(batchResult.results).toHaveLength(3);
      expect(batchResult.results[0].success).toBe(true);
      expect(batchResult.results[1].success).toBe(false);
      expect(batchResult.results[2].success).toBe(true);
    });
  });

  describe('Message Processing Pipeline Failures', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle processing function exceptions with automatic DLQ', async () => {
      const poisonMessage = createTestMessage({
        id: 'poison-msg-123',
        dequeueCount: 3, // At max attempts
        content: Buffer.from('{"invalid": json}') // Malformed content
      });

      // Mock dequeue returning poison message
      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'poison-msg-123',
            messageText: JSON.stringify({
              type: 'inline',
              content: poisonMessage.content.toString('base64'),
              metadata: poisonMessage.metadata
            }),
            dequeueCount: 3,
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: 'poison-receipt'
          }
        ]
      });

      // Mock DLQ enqueue
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'dlq-poison-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'dlq-poison-receipt'
      });

      // Simulate processing function that always fails
      const processingFunction = jest.fn().mockRejectedValue(new Error('Cannot process malformed JSON'));

      const result = await queue.dequeueWithRetry(processingFunction);

      expect(result.processed).toBe(false);
      expect(result.movedToDlq).toBe(true);
      expect(result.error).toContain('Cannot process malformed JSON');

      // Verify poison message was moved to DLQ
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('"dlqReason"'),
        expect.objectContaining({
          messageTimeToLive: 24 * 3600
        })
      );
    });

    it('should handle timeout errors in message processing', async () => {
      const timeoutMessage = createTestMessage({
        dequeueCount: 2
      });

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: timeoutMessage.id,
            messageText: JSON.stringify({
              type: 'inline',
              content: timeoutMessage.content.toString('base64'),
              metadata: timeoutMessage.metadata
            }),
            dequeueCount: 2,
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: timeoutMessage.popReceipt
          }
        ]
      });

      // Mock retry enqueue
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'timeout-retry-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'timeout-retry-receipt'
      });

      // Simulate processing function that times out
      const timeoutFunction = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        throw new Error('Processing timeout');
      });

      const result = await queue.dequeueWithRetry(timeoutFunction);

      expect(result.processed).toBe(false);
      expect(result.retried).toBe(true);
      expect(result.error).toContain('Processing timeout');
    });
  });

  describe('Error Recovery and Resilience', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should recover from temporary Azure Storage outages', async () => {
      // First call fails, second succeeds
      mockQueueClient.sendMessage
        .mockRejectedValueOnce(new Error('Temporary outage'))
        .mockResolvedValueOnce({
          messageId: 'recovery-msg-123',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'recovery-receipt'
        });

      const message = await queue.enqueue('Recovery test message');

      expect(message.id).toBe('recovery-msg-123');
      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should handle concurrent failures across Redis and Azure', async () => {
      // Both Redis and Azure fail
      mockRedis.pipeline().exec.mockRejectedValue(new Error('Redis cluster down'));
      mockQueueClient.sendMessage.mockRejectedValue(new Error('Azure region unavailable'));

      await expect(queue.enqueue('Test during total outage')).rejects.toThrow(AzureCQError);
    });

    it('should maintain DLQ functionality during Redis failures', async () => {
      const failedMessage = createTestMessage({ dequeueCount: 3 });

      // Redis operations fail
      mockRedis.del.mockRejectedValue(new Error('Redis unreachable'));
      mockRedis.zrem.mockRejectedValue(new Error('Redis unreachable'));

      // But Azure DLQ should still work
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'dlq-redis-down-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'dlq-redis-down-receipt'
      });

      const nackResult = await queue.nack(failedMessage, {
        reason: 'Processing failed during Redis outage'
      });

      // DLQ should succeed despite Redis failure
      expect(nackResult.success).toBe(true);
      expect(nackResult.destinationQueue).toBe('error-test-queue-dlq');
    });
  });

  describe('DLQ Disabled Error Scenarios', () => {
    it('should throw error when DLQ operations attempted with DLQ disabled', async () => {
      const configWithoutDLQ = {
        ...testConfig,
        settings: {
          ...testConfig.settings,
          deadLetter: {
            ...testConfig.settings.deadLetter,
            enabled: false
          }
        }
      };

      const queueWithoutDLQ = new AzureCQ(configWithoutDLQ);
      await queueWithoutDLQ.initialize();

      const testMessage = createTestMessage();

      await expect(queueWithoutDLQ.nack(testMessage, { reason: 'Test' }))
        .rejects.toThrow('Dead letter queue is not enabled');

      await expect(queueWithoutDLQ.moveToDeadLetter(testMessage, 'Test'))
        .rejects.toThrow('Dead letter queue is not enabled');

      await queueWithoutDLQ.shutdown();
    });
  });

  describe('Large Message Error Scenarios', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle blob storage quota exceeded errors', async () => {
      const largeMessage = Buffer.alloc(testConfig.settings.maxInlineMessageSize + 1000, 'L');
      
      const mockBlobClient = mockContainerClient.getBlockBlobClient();
      mockBlobClient.upload.mockRejectedValue(new Error('Storage quota exceeded'));

      await expect(queue.enqueue(largeMessage)).rejects.toThrow();

      // Should attempt cleanup
      expect(mockContainerClient.deleteBlob).toHaveBeenCalled();
    });

    it('should handle blob corruption during retrieval', async () => {
      const corruptedBlobMessage = {
        messageId: 'corrupt-blob-msg',
        messageText: JSON.stringify({
          type: 'blob_reference',
          blobName: 'corrupt-blob-123',
          size: 1000,
          metadata: { type: 'corrupted' }
        }),
        dequeueCount: 0,
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'corrupt-receipt'
      };

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [corruptedBlobMessage]
      });

      const mockBlobClient = mockContainerClient.getBlockBlobClient();
      mockBlobClient.downloadToBuffer.mockRejectedValue(new Error('Blob data corrupted'));

      await expect(queue.dequeue()).rejects.toThrow(AzureCQError);
    });
  });
});
