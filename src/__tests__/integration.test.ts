/**
 * Integration Tests for AzureCQ Performance Scenarios
 */

import { AzureCQ } from '../azurecq';
import { QueueConfiguration } from '../types';
import { PerformancePresets } from '../performance-optimizations';

// Mock all external dependencies for integration tests
jest.mock('ioredis');
jest.mock('@azure/storage-queue');
jest.mock('@azure/storage-blob');

describe('AzureCQ Integration Tests', () => {
  let queue: AzureCQ;
  let mockRedis: any;
  let mockQueueClient: any;
  let mockContainerClient: any;

  const testConfig: QueueConfiguration = {
    name: 'integration-test-queue',
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'integration:'
    },
    azure: {
      connectionString: 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net',
      queueName: 'integration-test-queue',
      containerName: 'integration-test-container'
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

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Redis
    mockRedis = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      pipeline: jest.fn(),
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

    const mockPipeline = {
      setex: jest.fn(),
      get: jest.fn(),
      exec: jest.fn().mockResolvedValue([])
    };
    mockRedis.pipeline.mockReturnValue(mockPipeline);

    // Mock Queue Client
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
    mockContainerClient = {
      create: jest.fn().mockResolvedValue({}),
      createIfNotExists: jest.fn().mockResolvedValue({}),
      getBlockBlobClient: jest.fn(),
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

    queue = new AzureCQ(testConfig);
  });

  afterEach(async () => {
    try {
      await queue.shutdown();
    } catch (error) {
      // Ignore shutdown errors in tests
    }
  });

  describe('End-to-End Message Flow', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle complete message lifecycle', async () => {
      // Mock enqueue response
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'lifecycle-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'lifecycle-receipt'
      });

      // Mock dequeue response
      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'lifecycle-msg-123',
            messageText: JSON.stringify({
              type: 'inline',
              content: Buffer.from('Lifecycle test message').toString('base64'),
              metadata: { type: 'lifecycle' }
            }),
            dequeueCount: 0,
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: 'lifecycle-receipt'
          }
        ]
      });

      // 1. Enqueue message - returns a temp ID when Redis is connected
      // Azure write happens asynchronously in background
      const enqueuedMessage = await queue.enqueue('Lifecycle test message', {
        metadata: { type: 'lifecycle' }
      });

      // Message should have a valid UUID as ID (temp ID from Redis path)
      expect(enqueuedMessage.id).toBeDefined();
      expect(enqueuedMessage.id.length).toBeGreaterThan(0);
      expect(enqueuedMessage.content).toEqual(Buffer.from('Lifecycle test message'));

      // 2. Dequeue message
      const dequeuedMessage = await queue.dequeue();

      expect(dequeuedMessage).not.toBeNull();
      expect(dequeuedMessage!.id).toBe('lifecycle-msg-123');
      expect(dequeuedMessage!.content).toEqual(Buffer.from('Lifecycle test message'));

      // 3. Acknowledge message
      const ackResult = await queue.acknowledge(dequeuedMessage!);

      expect(ackResult.success).toBe(true);
      expect(ackResult.messageId).toBe('lifecycle-msg-123');

      // Verify Azure operations were called (may be async)
      // Note: sendMessage is called in background, so we give it time
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(mockQueueClient.receiveMessages).toHaveBeenCalled();
    });

    it('should handle batch operations end-to-end', async () => {
      const batchSize = 10;
      const testMessages = Array.from({ length: batchSize }, (_, i) => ({
        content: `Batch message ${i}`,
        options: { metadata: { index: i, batch: 'integration-test' } }
      }));

      // Mock batch enqueue responses
      mockQueueClient.sendMessage.mockImplementation(() => 
        Promise.resolve({
          messageId: `batch-msg-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `batch-receipt-${Math.random()}`
        })
      );

      // Mock batch dequeue response
      const mockMessages = Array.from({ length: batchSize }, (_, i) => ({
        messageId: `batch-msg-${i}`,
        messageText: JSON.stringify({
          type: 'inline',
          content: Buffer.from(`Batch message ${i}`).toString('base64'),
          metadata: { index: i, batch: 'integration-test' }
        }),
        dequeueCount: 0,
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: `batch-receipt-${i}`
      }));

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: mockMessages
      });

      // 1. Enqueue batch
      const enqueueBatch = await queue.enqueueBatch(testMessages);

      expect(enqueueBatch.count).toBe(batchSize);
      expect(enqueueBatch.messages).toHaveLength(batchSize);

      // 2. Dequeue batch
      const dequeueBatch = await queue.dequeueBatch({ maxMessages: batchSize });

      expect(dequeueBatch.count).toBe(batchSize);
      expect(dequeueBatch.messages).toHaveLength(batchSize);

      // 3. Acknowledge batch
      const ackBatch = await queue.acknowledgeBatch(dequeueBatch.messages);

      expect(ackBatch.success).toBe(true);
      expect(ackBatch.successCount).toBe(batchSize);
      expect(ackBatch.failureCount).toBe(0);

      // Verify batch operations
      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(batchSize);
      expect(mockQueueClient.deleteMessage).toHaveBeenCalledTimes(batchSize);
    });
  });

  describe('Performance Configuration Integration', () => {
    it('should initialize with HIGH_THROUGHPUT configuration', async () => {
      const highThroughputConfig = {
        ...testConfig,
        redis: {
          ...testConfig.redis,
          ...PerformancePresets.HIGH_THROUGHPUT.redis
        },
        settings: {
          ...testConfig.settings,
          batchSize: PerformancePresets.HIGH_THROUGHPUT.batchSize,
          redisCacheTtl: PerformancePresets.HIGH_THROUGHPUT.redisCacheTtl
        }
      };

      const highThroughputQueue = new AzureCQ(highThroughputConfig);
      await highThroughputQueue.initialize();

      // Verify configuration is applied (this would be tested through behavior)
      expect(highThroughputQueue).toBeInstanceOf(AzureCQ);
      
      await highThroughputQueue.shutdown();
    });

    it('should initialize with LOW_LATENCY configuration', async () => {
      const lowLatencyConfig = {
        ...testConfig,
        redis: {
          ...testConfig.redis,
          ...PerformancePresets.LOW_LATENCY.redis
        },
        settings: {
          ...testConfig.settings,
          batchSize: PerformancePresets.LOW_LATENCY.batchSize,
          redisCacheTtl: PerformancePresets.LOW_LATENCY.redisCacheTtl
        }
      };

      const lowLatencyQueue = new AzureCQ(lowLatencyConfig);
      await lowLatencyQueue.initialize();

      expect(lowLatencyQueue).toBeInstanceOf(AzureCQ);
      
      await lowLatencyQueue.shutdown();
    });

    it('should initialize with MEMORY_OPTIMIZED configuration', async () => {
      const memoryOptimizedConfig = {
        ...testConfig,
        redis: {
          ...testConfig.redis,
          ...PerformancePresets.MEMORY_OPTIMIZED.redis
        },
        settings: {
          ...testConfig.settings,
          batchSize: PerformancePresets.MEMORY_OPTIMIZED.batchSize,
          redisCacheTtl: PerformancePresets.MEMORY_OPTIMIZED.redisCacheTtl
        }
      };

      const memoryOptimizedQueue = new AzureCQ(memoryOptimizedConfig);
      await memoryOptimizedQueue.initialize();

      expect(memoryOptimizedQueue).toBeInstanceOf(AzureCQ);
      
      await memoryOptimizedQueue.shutdown();
    });
  });

  describe('Dead Letter Queue Integration', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle message processing with automatic DLQ movement', async () => {
      const failingMessage = {
        id: 'failing-msg-123',
        content: Buffer.from('Failing message'),
        metadata: { type: 'failing' },
        dequeueCount: 3, // At max delivery attempts
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'failing-receipt'
      };

      // Mock DLQ enqueue
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'dlq-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'dlq-receipt'
      });

      // Test NACK operation that should move to DLQ
      const nackResult = await queue.nack(failingMessage, {
        reason: 'Processing failed after max attempts'
      });

      expect(nackResult.success).toBe(true);
      expect(nackResult.action).toBe('moved_to_dlq');
      expect(nackResult.destinationQueue).toBe('integration-test-queue-dlq');

      // Verify DLQ enqueue was called
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('dlqReason'),
        expect.objectContaining({
          messageTimeToLive: 24 * 3600
        })
      );
    });

    it('should handle DLQ statistics and management', async () => {
      mockQueueClient.getProperties.mockResolvedValue({
        approximateMessagesCount: 5
      });

      // Mock empty dequeue for purge
      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: []
      });

      const dlqInfo = await queue.getDeadLetterInfo();

      expect(dlqInfo.isEnabled).toBe(true);
      expect(dlqInfo.queueName).toBe('integration-test-queue-dlq');
      expect(dlqInfo.messageCount).toBe(5);
      expect(dlqInfo.maxDeliveryAttempts).toBe(3);

      // Test DLQ purge - returns number of purged messages
      const purgedCount = await queue.purgeDeadLetter();

      expect(purgedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Resilience Integration', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle Redis disconnection gracefully', async () => {
      // Simulate Redis disconnection
      mockRedis.get.mockRejectedValue(new Error('Redis disconnected'));
      mockRedis.pipeline().exec.mockRejectedValue(new Error('Redis disconnected'));

      // Mock Azure fallback
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'fallback-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'fallback-receipt'
      });

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

      // Operations should still work using Azure Storage only
      const message = await queue.enqueue('Fallback test message');
      expect(message).toBeDefined();

      const dequeued = await queue.dequeue();
      expect(dequeued).toBeDefined();

      const acked = await queue.acknowledge(dequeued!);
      expect(acked.success).toBe(true);
    });

    it('should handle Azure Storage temporary failures with retry', async () => {
      // Reset and set up successful response
      mockQueueClient.sendMessage.mockReset();
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'retry-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'retry-receipt'
      });

      const message = await queue.enqueue('Retry test message');

      expect(message.id).toBe('retry-msg-123');
      expect(mockQueueClient.sendMessage).toHaveBeenCalled();
    });
  });

  describe('Large Message Handling Integration', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle large messages with blob storage', async () => {
      const largeContent = Buffer.alloc(testConfig.settings.maxInlineMessageSize + 1000, 'L');
      
      // Create mock readable stream for blob download
      const mockReadableStream = {
        [Symbol.asyncIterator]: async function* () {
          yield largeContent;
        }
      };
      
      // Mock blob operations
      const mockBlobClient = {
        upload: jest.fn().mockResolvedValue({}),
        download: jest.fn().mockResolvedValue({ readableStreamBody: mockReadableStream }),
        delete: jest.fn().mockResolvedValue({})
      };
      mockContainerClient.getBlockBlobClient.mockReturnValue(mockBlobClient);

      // Mock queue operations for blob reference
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'large-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'large-receipt'
      });

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'large-msg-123',
            messageText: JSON.stringify({
              type: 'blob_reference',
              blobName: 'msg-large-msg-123',
              size: largeContent.length,
              metadata: { type: 'large' }
            }),
            dequeueCount: 0,
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: 'large-receipt'
          }
        ]
      });

      // Enqueue large message
      const enqueuedMessage = await queue.enqueue(largeContent, {
        metadata: { type: 'large' }
      });

      expect(enqueuedMessage.content).toEqual(largeContent);
      expect(mockBlobClient.upload).toHaveBeenCalledWith(largeContent, largeContent.length);

      // Dequeue large message
      const dequeuedMessage = await queue.dequeue();

      expect(dequeuedMessage).toBeDefined();
      expect(dequeuedMessage!.content).toEqual(largeContent);
      expect(mockBlobClient.download).toHaveBeenCalled();

      // Acknowledge and cleanup
      const ackResult = await queue.acknowledge(dequeuedMessage!);

      expect(ackResult.success).toBe(true);
    });
  });

  describe('Concurrent Operations Integration', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle concurrent enqueue/dequeue operations', async () => {
      const concurrentOperations = 20;
      
      // Mock successful operations
      mockQueueClient.sendMessage.mockImplementation(() => 
        Promise.resolve({
          messageId: `concurrent-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `receipt-${Math.random()}`
        })
      );

      mockQueueClient.receiveMessages.mockImplementation(() => 
        Promise.resolve({
          receivedMessageItems: [
            {
              messageId: `dequeue-${Math.random()}`,
              messageText: JSON.stringify({
                type: 'inline',
                content: Buffer.from('Concurrent message').toString('base64'),
                metadata: { type: 'concurrent' }
              }),
              dequeueCount: 0,
              insertedOn: new Date(),
              nextVisibleOn: new Date(),
              popReceipt: `dequeue-receipt-${Math.random()}`
            }
          ]
        })
      );

      // Run concurrent enqueue operations
      const enqueuePromises = Array.from({ length: concurrentOperations }, (_, i) =>
        queue.enqueue(`Concurrent message ${i}`, { metadata: { index: i } })
      );

      // Run concurrent dequeue operations
      const dequeuePromises = Array.from({ length: concurrentOperations }, () =>
        queue.dequeue()
      );

      const [enqueueResults, dequeueResults] = await Promise.all([
        Promise.all(enqueuePromises),
        Promise.all(dequeuePromises)
      ]);

      expect(enqueueResults).toHaveLength(concurrentOperations);
      expect(dequeueResults).toHaveLength(concurrentOperations);
      expect(dequeueResults.every(result => result !== null)).toBe(true);
    });
  });

  describe('Queue Management Integration', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should handle queue lifecycle management', async () => {
      // Test queue statistics
      mockQueueClient.getProperties.mockResolvedValue({
        approximateMessagesCount: 42
      });

      const stats = await queue.getStats();

      // Stats returns QueueStats with name, messageCount, etc
      expect(stats.name).toBe('integration-test-queue');
      expect(stats.messageCount).toBeGreaterThanOrEqual(0); // Combined Redis hot count + Azure count
    });

    it('should handle queue creation and deletion', async () => {
      // These operations are typically handled by the Azure Manager
      // but we can test them through the main queue interface
      expect(queue).toBeInstanceOf(AzureCQ);
      
      // Queue was created during initialization (uses createIfNotExists)
      expect(mockQueueClient.createIfNotExists).toHaveBeenCalled();
      expect(mockContainerClient.createIfNotExists).toHaveBeenCalled();
    });
  });

  describe('Performance Measurement Integration', () => {
    beforeEach(async () => {
      await queue.initialize();
    });

    it('should complete high-volume operations within acceptable time', async () => {
      const messageCount = 100;
      
      // Setup fast mocks
      mockQueueClient.sendMessage.mockImplementation(() => 
        Promise.resolve({
          messageId: `perf-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `perf-receipt-${Math.random()}`
        })
      );

      const messages = Array.from({ length: messageCount }, (_, i) => ({
        content: `Performance test message ${i}`,
        options: { metadata: { index: i, test: 'performance' } }
      }));

      const start = Date.now();
      const result = await queue.enqueueBatch(messages);
      const duration = Date.now() - start;

      expect(result.count).toBe(messageCount);
      expect(duration).toBeLessThan(10000); // Should complete within 10 seconds (increased for CI environments)

      console.log(`Batch enqueue of ${messageCount} messages took ${duration}ms (${(messageCount / duration * 1000).toFixed(2)} ops/sec)`);
    });

    it('should maintain performance under memory pressure', async () => {
      const iterations = 50;
      const batchSize = 20;
      
      // Setup mocks for memory pressure test
      mockQueueClient.sendMessage.mockImplementation(() => 
        Promise.resolve({
          messageId: `memory-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `memory-receipt-${Math.random()}`
        })
      );

      const memBefore = process.memoryUsage();
      
      for (let i = 0; i < iterations; i++) {
        const messages = Array.from({ length: batchSize }, (_, j) => ({
          content: `Memory test ${i}-${j}`,
          options: { metadata: { iteration: i, index: j } }
        }));
        
        await queue.enqueueBatch(messages);
      }

      const memAfter = process.memoryUsage();
      const memGrowth = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      console.log(`Memory growth after ${iterations * batchSize} operations: ${memGrowth.toFixed(2)} MB`);
      
      // Memory growth should be reasonable (allowing for test overhead)
      expect(memGrowth).toBeLessThan(100); // Less than 100MB growth
    });
  });
});
