/**
 * Dead Letter Queue Integration Tests
 * End-to-end testing of DLQ workflows and edge cases
 */

import { AzureCQ } from '../azurecq';
import { QueueConfiguration, QueueMessage } from '../types';

// Mock dependencies
jest.mock('ioredis');
jest.mock('@azure/storage-queue');
jest.mock('@azure/storage-blob');

describe('DLQ Integration & Edge Cases', () => {
  let queue: AzureCQ;
  let mockRedis: any;
  let mockQueueClient: any;
  let mockContainerClient: any;
  let testConfig: QueueConfiguration;

  const createTestMessage = (overrides = {}): QueueMessage => ({
    id: `msg-${Date.now()}-${Math.random()}`,
    content: Buffer.from('Test message content'),
    metadata: { type: 'test', source: 'dlq-integration' },
    dequeueCount: 0,
    insertedOn: new Date(),
    nextVisibleOn: new Date(),
    popReceipt: `receipt-${Date.now()}`,
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Redis with enhanced functionality
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

    // Mock Queue Client with DLQ support
    mockQueueClient = {
      create: jest.fn().mockResolvedValue({}),
      createIfNotExists: jest.fn().mockResolvedValue({}),
      sendMessage: jest.fn(),
      receiveMessages: jest.fn(),
      peekMessages: jest.fn().mockResolvedValue({ peekedMessageItems: [] }),
      deleteMessage: jest.fn().mockResolvedValue({}),
      getProperties: jest.fn().mockResolvedValue({ approximateMessagesCount: 0 }),
      clearMessages: jest.fn().mockResolvedValue({})
    };

    // Mock Container Client
    const mockReadableStream = {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from('blob-content');
      }
    };
    mockContainerClient = {
      create: jest.fn().mockResolvedValue({}),
      createIfNotExists: jest.fn().mockResolvedValue({}),
      getBlockBlobClient: jest.fn().mockReturnValue({
        upload: jest.fn().mockResolvedValue({}),
        download: jest.fn().mockResolvedValue({ readableStreamBody: mockReadableStream }),
        delete: jest.fn().mockResolvedValue({})
      }),
      deleteBlob: jest.fn().mockResolvedValue({})
    };

    // Setup Azure SDK mocks
    const { QueueServiceClient } = require('@azure/storage-queue');
    const { BlobServiceClient } = require('@azure/storage-blob');
    const Redis = require('ioredis');

    Redis.mockImplementation(() => mockRedis);
    
    // Mock the static fromConnectionString methods
    QueueServiceClient.fromConnectionString = jest.fn().mockReturnValue({
      getQueueClient: jest.fn().mockReturnValue(mockQueueClient)
    });
    BlobServiceClient.fromConnectionString = jest.fn().mockReturnValue({
      getContainerClient: jest.fn().mockReturnValue(mockContainerClient)
    });

    testConfig = {
      name: 'dlq-integration-queue',
      redis: {
        host: 'localhost',
        port: 6379,
        keyPrefix: 'dlq-test:'
      },
      azure: {
        connectionString: 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net',
        queueName: 'dlq-integration-queue',
        containerName: 'dlq-integration-container'
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

  describe('Complete DLQ Lifecycle', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should complete full message processing failure to DLQ cycle', async () => {
      // Step 1: Enqueue original message
      mockQueueClient.sendMessage.mockResolvedValueOnce({
        messageId: 'original-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'original-receipt'
      });

      const originalMessage = await queue.enqueue('Test message that will fail', {
        metadata: { type: 'failing-test' }
      });

      expect(originalMessage.id).toBe('original-msg-123');

      // Step 2: Simulate message dequeue and processing failures
      const failingMessage = createTestMessage({
        id: 'original-msg-123',
        dequeueCount: 0,
        content: Buffer.from('Test message that will fail')
      });

      // First failure - should retry
      mockQueueClient.sendMessage.mockResolvedValueOnce({
        messageId: 'retry-1-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'retry-1-receipt'
      });

      let nackResult = await queue.nack({ ...failingMessage, dequeueCount: 1 }, {
        reason: 'First processing failure'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.sourceQueue).toBe('dlq-integration-queue');
      expect(nackResult.destinationQueue).toBe('dlq-integration-queue'); // Same queue for retry

      // Second failure - should retry again
      mockQueueClient.sendMessage.mockResolvedValueOnce({
        messageId: 'retry-2-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'retry-2-receipt'
      });

      nackResult = await queue.nack({ ...failingMessage, dequeueCount: 2 }, {
        reason: 'Second processing failure'
      });

      expect(nackResult.success).toBe(true);

      // Third failure - should move to DLQ
      mockQueueClient.sendMessage.mockResolvedValueOnce({
        messageId: 'dlq-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'dlq-receipt'
      });

      nackResult = await queue.nack({ ...failingMessage, dequeueCount: 3 }, {
        reason: 'Final processing failure - moving to DLQ'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.destinationQueue).toBe('dlq-integration-queue-dlq');

      // Verify DLQ message has proper metadata
      const dlqCall = mockQueueClient.sendMessage.mock.calls.find((call: unknown[]) => 
        String(call[0]).includes('"dlqReason":"Final processing failure - moving to DLQ"')
      );
      expect(dlqCall).toBeDefined();
      if (dlqCall) {
        expect(dlqCall[1]).toMatchObject({
          messageTimeToLive: 24 * 3600
        });
      }
    });

    it('should handle message recovery from DLQ back to main queue', async () => {
      // Step 1: Mock DLQ message retrieval
      const dlqMessage = createTestMessage({
        id: 'dlq-recovery-msg-123',
        originalQueueName: 'dlq-integration-queue',
        dlqReason: 'Processing timeout',
        dlqTimestamp: new Date('2023-01-01T12:00:00Z'),
        content: Buffer.from('Recovered message content')
      });

      mockQueueClient.receiveMessages.mockResolvedValueOnce({
        receivedMessageItems: [
          {
            messageId: dlqMessage.id,
            messageText: JSON.stringify({
              type: 'inline',
              content: dlqMessage.content.toString('base64'),
              metadata: {
                ...dlqMessage.metadata,
                originalQueueName: dlqMessage.originalQueueName,
                dlqReason: dlqMessage.dlqReason,
                dlqTimestamp: dlqMessage.dlqTimestamp?.toISOString()
              }
            }),
            dequeueCount: 0,
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: 'dlq-retrieval-receipt'
          }
        ]
      });

      // Step 2: Mock successful re-enqueue to main queue
      mockQueueClient.sendMessage.mockResolvedValueOnce({
        messageId: 'recovered-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'recovered-receipt'
      });

      // Step 3: Perform recovery
      const recoveryResult = await queue.moveFromDeadLetter(dlqMessage.id);

      expect(recoveryResult.success).toBe(true);
      expect(recoveryResult.sourceQueue).toBe('dlq-integration-queue-dlq');
      expect(recoveryResult.destinationQueue).toBe('dlq-integration-queue');

      // Just verify the recovery operation was successful
      // The exact content of re-enqueued message depends on implementation
      expect(mockQueueClient.sendMessage).toHaveBeenCalled();
    });
  });

  describe('DLQ Edge Cases and Boundary Conditions', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle message with exactly max delivery attempts', async () => {
      const boundaryMessage = createTestMessage({
        dequeueCount: testConfig.settings.deadLetter.maxDeliveryAttempts // Exactly at limit
      });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'boundary-dlq-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'boundary-dlq-receipt'
      });

      const nackResult = await queue.nack(boundaryMessage, {
        reason: 'Boundary test - at exact limit'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.destinationQueue).toBe('dlq-integration-queue-dlq');
    });

    it('should handle message with attempts just under limit', async () => {
      const justUnderMessage = createTestMessage({
        dequeueCount: testConfig.settings.deadLetter.maxDeliveryAttempts - 1
      });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'just-under-retry-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'just-under-receipt'
      });

      const nackResult = await queue.nack(justUnderMessage, {
        reason: 'Just under limit - should retry'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.destinationQueue).toBe('dlq-integration-queue'); // Retry in same queue

      // Should include visibility timeout for retry delay
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          visibilityTimeout: expect.any(Number)
        })
      );
    });

    it('should handle very large processing history', async () => {
      const largeHistory = Array.from({ length: 50 }, (_, i) => ({
        attemptNumber: i + 1,
        timestamp: new Date(Date.now() - (50 - i) * 60000), // 1 minute apart
        error: `Attempt ${i + 1} failed`,
        workerId: `worker-${i % 5}`
      }));

      const messageWithLargeHistory = createTestMessage({
        dequeueCount: 3,
        processingHistory: largeHistory
      });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'large-history-dlq-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'large-history-receipt'
      });

      const nackResult = await queue.nack(messageWithLargeHistory, {
        reason: 'Final failure with large history'
      });

      expect(nackResult.success).toBe(true);

      // Verify large history is preserved in DLQ
      const dlqCall = mockQueueClient.sendMessage.mock.calls[0];
      expect(String(dlqCall[0])).toContain('"processingHistory"');
      // History should contain all previous attempts plus the new one
      expect(String(dlqCall[0])).toContain('"attemptNumber":50'); // Previous attempts preserved
    });

    it('should handle messages with special characters and Unicode', async () => {
      const unicodeMessage = createTestMessage({
        id: 'unicode-msg-🚀-测试',
        content: Buffer.from('Message with Unicode: 🚀✨ 测试消息 العربية русский'),
        metadata: {
          type: 'unicode-test',
          description: 'Special chars: @#$%^&*()[]{}|\\:";\'<>?,./',
          unicode: '🌟💫⭐️🎯🔥'
        },
        dequeueCount: 3
      });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'unicode-dlq-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'unicode-dlq-receipt'
      });

      const nackResult = await queue.nack(unicodeMessage, {
        reason: 'Unicode handling test: 测试 🚀'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.messageId).toBe('unicode-msg-🚀-测试');

      // Verify Unicode content is properly handled in DLQ
      const dlqCall = mockQueueClient.sendMessage.mock.calls[0];
      expect(dlqCall[0]).toContain('Unicode handling test: 测试 🚀');
    });

    it('should handle extremely large messages in DLQ', async () => {
      const largeContent = Buffer.alloc(testConfig.settings.maxInlineMessageSize + 10000, 'L');
      const largeMessage = createTestMessage({
        content: largeContent,
        dequeueCount: 3
      });

      // Mock blob storage for large DLQ message
      const mockBlobClient = mockContainerClient.getBlockBlobClient();
      mockBlobClient.upload.mockResolvedValue({});

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'large-dlq-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'large-dlq-receipt'
      });

      const nackResult = await queue.nack(largeMessage, {
        reason: 'Large message processing failed'
      });

      expect(nackResult.success).toBe(true);

      // Verify blob storage was used for large DLQ message
      expect(mockBlobClient.upload).toHaveBeenCalledWith(
        largeContent,
        largeContent.length
      );
    });
  });

  describe('DLQ Batch Operations Under Stress', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle large batch DLQ operations', async () => {
      const batchSize = 100;
      const largeBatch = Array.from({ length: batchSize }, (_, i) => ({
        message: createTestMessage({ 
          id: `batch-msg-${i}`,
          content: Buffer.from(`Batch message ${i}`)
        }),
        reason: `Batch failure reason ${i}`
      }));

      // Mock successful DLQ enqueue for all messages
      mockQueueClient.sendMessage.mockImplementation(() => 
        Promise.resolve({
          messageId: `dlq-batch-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `dlq-batch-receipt-${Math.random()}`
        })
      );

      const batchResult = await queue.moveToDeadLetterBatch(largeBatch);

      expect(batchResult.success).toBe(true);
      expect(batchResult.successCount).toBe(batchSize);
      expect(batchResult.failureCount).toBe(0);
      expect(batchResult.results).toHaveLength(batchSize);
      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(batchSize);
    });

    it('should handle partial failures in large batches gracefully', async () => {
      const batchSize = 50;
      const mixedBatch = Array.from({ length: batchSize }, (_, i) => ({
        message: createTestMessage({ id: `mixed-msg-${i}` }),
        reason: `Mixed failure ${i}`
      }));

      // Mock mixed results: every 5th message fails
      let callCount = 0;
      mockQueueClient.sendMessage.mockImplementation(() => {
        callCount++;
        if (callCount % 5 === 0) {
          return Promise.reject(new Error(`Batch failure ${callCount}`));
        }
        return Promise.resolve({
          messageId: `dlq-mixed-${callCount}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `dlq-mixed-receipt-${callCount}`
        });
      });

      const batchResult = await queue.moveToDeadLetterBatch(mixedBatch);

      expect(batchResult.success).toBe(false); // Overall failure due to partial failures
      expect(batchResult.successCount).toBe(40); // 80% success rate
      expect(batchResult.failureCount).toBe(10); // 20% failure rate
      expect(batchResult.results).toHaveLength(batchSize);

      // Verify some succeeded and some failed
      const successes = batchResult.results.filter(r => r.success);
      const failures = batchResult.results.filter(r => !r.success);
      expect(successes).toHaveLength(40);
      expect(failures).toHaveLength(10);
    });
  });

  describe('DLQ Configuration Edge Cases', () => {
    it('should handle zero TTL configuration', async () => {
      const zeroTtlConfig = {
        ...testConfig,
        settings: {
          ...testConfig.settings,
          deadLetter: {
            ...testConfig.settings.deadLetter,
            messageTtl: 0 // Immediate expiry
          }
        }
      };

      const zeroTtlQueue = new AzureCQ(zeroTtlConfig);
      await zeroTtlQueue.initialize();

      const expiredMessage = createTestMessage({ dequeueCount: 3 });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'zero-ttl-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'zero-ttl-receipt'
      });

      const nackResult = await zeroTtlQueue.nack(expiredMessage, {
        reason: 'Zero TTL test'
      });

      expect(nackResult.success).toBe(true);

      // Verify zero TTL was passed to Azure
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messageTimeToLive: 0
        })
      );

      await zeroTtlQueue.shutdown();
    });

    it('should handle very high max delivery attempts', async () => {
      const highAttemptsConfig = {
        ...testConfig,
        settings: {
          ...testConfig.settings,
          deadLetter: {
            ...testConfig.settings.deadLetter,
            maxDeliveryAttempts: 1000 // Very high
          }
        }
      };

      const highAttemptsQueue = new AzureCQ(highAttemptsConfig);
      await highAttemptsQueue.initialize();

      const highAttemptMessage = createTestMessage({ dequeueCount: 999 });

      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'high-attempt-retry-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'high-attempt-receipt'
      });

      const nackResult = await highAttemptsQueue.nack(highAttemptMessage, {
        reason: 'High attempts test - should still retry'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.destinationQueue).toBe('dlq-integration-queue'); // Should still retry

      await highAttemptsQueue.shutdown();
    });
  });

  describe('DLQ Performance Under Load', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle rapid DLQ operations', async () => {
      const rapidMessages = Array.from({ length: 20 }, (_, i) => 
        createTestMessage({ 
          id: `rapid-${i}`,
          dequeueCount: 3 
        })
      );

      // Mock rapid DLQ responses
      mockQueueClient.sendMessage.mockImplementation(() => 
        Promise.resolve({
          messageId: `rapid-dlq-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `rapid-dlq-receipt-${Math.random()}`
        })
      );

      const start = Date.now();
      
      // Execute rapid NACK operations
      const promises = rapidMessages.map(msg => 
        queue.nack(msg, { reason: 'Rapid processing failure' })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - start;

      expect(results).toHaveLength(20);
      expect(results.every(r => r.success)).toBe(true);
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds

      console.log(`Rapid DLQ operations (${rapidMessages.length} messages) took ${duration}ms`);
    });
  });
});
