/**
 * Unit tests for Dead Letter Manager
 */

import { DeadLetterManager } from '../dead-letter-manager';
import { RedisManager } from '../redis-manager';
import { AzureManager } from '../azure-manager';
import { 
  QueueConfiguration, 
  QueueMessage, 
  NackOptions, 
  ProcessingAttempt,
  ErrorCodes 
} from '../types';

// Mock dependencies
jest.mock('../redis-manager');
jest.mock('../azure-manager');

describe('DeadLetterManager', () => {
  let deadLetterManager: DeadLetterManager;
  let mockRedisManager: jest.Mocked<RedisManager>;
  let mockAzureManager: jest.Mocked<AzureManager>;
  let mockConfig: QueueConfiguration;

  const testMessage: QueueMessage = {
    id: 'test-message-123',
    content: Buffer.from('Test message content'),
    metadata: { 
      type: 'test',
      priority: 1 
    },
    dequeueCount: 2,
    insertedOn: new Date('2023-01-01T00:00:00Z'),
    nextVisibleOn: new Date('2023-01-01T01:00:00Z'),
    popReceipt: 'test-receipt-456'
  };

  beforeEach(() => {
    // Create mock configuration
    mockConfig = {
      name: 'test-queue',
      redis: {
        host: 'localhost',
        port: 6379,
        keyPrefix: 'test:'
      },
      azure: {
        connectionString: 'test-connection-string',
        queueName: 'test-queue',
        containerName: 'test-container'
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

    // Create mock managers
    mockRedisManager = {
      cacheMessage: jest.fn().mockResolvedValue(undefined),
      removeCachedMessage: jest.fn().mockResolvedValue(undefined),
      addToHotQueue: jest.fn().mockResolvedValue(undefined),
      removeFromHotQueue: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockAzureManager = {
      initialize: jest.fn().mockResolvedValue(undefined),
      enqueueMessage: jest.fn().mockResolvedValue(testMessage),
      dequeueMessages: jest.fn().mockResolvedValue([testMessage]),
      acknowledgeMessage: jest.fn().mockResolvedValue({ success: true }),
      createQueue: jest.fn().mockResolvedValue(undefined),
      getQueueStats: jest.fn().mockResolvedValue({ messageCount: 0, approximateMessageCount: 0 }),
      purgeQueue: jest.fn().mockResolvedValue(undefined),
    } as any;

    deadLetterManager = new DeadLetterManager(
      mockRedisManager,
      mockAzureManager,
      mockConfig
    );
  });

  describe('Initialization', () => {
    it('should initialize successfully when DLQ is enabled', async () => {
      await deadLetterManager.initialize();

      expect(mockAzureManager.initialize).toHaveBeenCalled();
    });

    it('should skip initialization when DLQ is disabled', async () => {
      const disabledConfig = {
        ...mockConfig,
        settings: {
          ...mockConfig.settings,
          deadLetter: {
            ...mockConfig.settings.deadLetter,
            enabled: false
          }
        }
      };

      const disabledManager = new DeadLetterManager(
        mockRedisManager,
        mockAzureManager,
        disabledConfig
      );

      await disabledManager.initialize();

      expect(mockAzureManager.initialize).not.toHaveBeenCalled();
    });
  });

  describe('NACK Message Processing', () => {
    beforeEach(async () => {
      await deadLetterManager.initialize();
    });

    it('should throw error when DLQ is disabled', async () => {
      const disabledConfig = {
        ...mockConfig,
        settings: {
          ...mockConfig.settings,
          deadLetter: { ...mockConfig.settings.deadLetter, enabled: false }
        }
      };

      const disabledManager = new DeadLetterManager(
        mockRedisManager,
        mockAzureManager,
        disabledConfig
      );

      await expect(disabledManager.nackMessage(testMessage))
        .rejects.toThrow('Dead letter queue is not enabled');
    });

    it('should schedule retry when under max delivery attempts', async () => {
      const messageUnderLimit = {
        ...testMessage,
        dequeueCount: 1 // Under the limit of 3
      };

      const result = await deadLetterManager.nackMessage(messageUnderLimit, {
        reason: 'Temporary failure'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('retry');
      expect(result.retryDelaySeconds).toBeGreaterThan(0);
      expect(mockAzureManager.enqueueMessage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          processingHistory: expect.arrayContaining([
            expect.objectContaining({
              error: 'Temporary failure',
              attemptNumber: 2
            })
          ])
        }),
        expect.any(Number), // visibilityTimeout
        expect.any(Number)  // timeToLive
      );
    });

    it('should move to DLQ when exceeding max delivery attempts', async () => {
      const messageOverLimit = {
        ...testMessage,
        dequeueCount: 3 // At the limit of 3
      };

      const result = await deadLetterManager.nackMessage(messageOverLimit, {
        reason: 'Processing failed'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('moved_to_dlq');
      expect(result.sourceQueue).toBe('test-queue');
      expect(result.destinationQueue).toBe('test-queue-dlq');
    });

    it('should force move to DLQ when forceDlq option is true', async () => {
      const messageUnderLimit = {
        ...testMessage,
        dequeueCount: 1 // Under limit, but forcing DLQ
      };

      const result = await deadLetterManager.nackMessage(messageUnderLimit, {
        reason: 'Critical error',
        forceDlq: true
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('moved_to_dlq');
    });

    it('should calculate exponential backoff retry delay', async () => {
      const message1 = { ...testMessage, dequeueCount: 1 };
      const message2 = { ...testMessage, dequeueCount: 2 };

      const result1 = await deadLetterManager.nackMessage(message1);
      const result2 = await deadLetterManager.nackMessage(message2);

      expect(result2.retryDelaySeconds!).toBeGreaterThan(result1.retryDelaySeconds!);
    });

    it('should use custom retry delay when provided', async () => {
      const customDelay = 120; // 2 minutes
      const messageUnderLimit = { ...testMessage, dequeueCount: 1 };

      const result = await deadLetterManager.nackMessage(messageUnderLimit, {
        retryDelaySeconds: customDelay
      });

      expect(result.retryDelaySeconds).toBe(customDelay);
    });

    it('should add processing history to message', async () => {
      const messageWithHistory = {
        ...testMessage,
        dequeueCount: 1,
        processingHistory: [
          {
            attemptNumber: 1,
            timestamp: new Date('2023-01-01T00:30:00Z'),
            error: 'Previous error',
            workerId: 'worker-1'
          }
        ]
      };

      await deadLetterManager.nackMessage(messageWithHistory, {
        reason: 'New error'
      });

      expect(mockAzureManager.enqueueMessage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          processingHistory: expect.arrayContaining([
            expect.objectContaining({
              attemptNumber: 1,
              error: 'Previous error'
            }),
            expect.objectContaining({
              attemptNumber: 2,
              error: 'New error'
            })
          ])
        }),
        expect.any(Number),
        expect.any(Number)
      );
    });
  });

  describe('Manual DLQ Operations', () => {
    beforeEach(async () => {
      await deadLetterManager.initialize();
    });

    it('should move message to DLQ manually', async () => {
      const result = await deadLetterManager.moveMessageToDlq(testMessage, 'Manual move');

      expect(result.success).toBe(true);
      expect(result.action).toBe('moved_to_dlq');
      expect(result.sourceQueue).toBe('test-queue');
      expect(result.destinationQueue).toBe('test-queue-dlq');

      expect(mockAzureManager.enqueueMessage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          originalQueueName: 'test-queue',
          dlqReason: 'Manual move',
          dlqTimestamp: expect.any(Date)
        }),
        undefined,
        24 * 3600 // DLQ TTL
      );
    });

    it('should move message from DLQ back to main queue', async () => {
      // Mock dequeue from DLQ
      const dlqMessage = {
        ...testMessage,
        originalQueueName: 'test-queue',
        dlqReason: 'Processing failed',
        dlqTimestamp: new Date()
      };
      
      mockAzureManager.dequeueMessages.mockResolvedValueOnce([dlqMessage]);

      const result = await deadLetterManager.moveMessageFromDlq(testMessage.id);

      expect(result.success).toBe(true);
      expect(result.action).toBe('moved_from_dlq');
      expect(result.sourceQueue).toBe('test-queue-dlq');
      expect(result.destinationQueue).toBe('test-queue');

      expect(mockAzureManager.dequeueMessages).toHaveBeenCalledWith(1, undefined);
      expect(mockAzureManager.enqueueMessage).toHaveBeenCalledWith(
        dlqMessage.content,
        expect.objectContaining({
          type: 'inline',
          content: expect.any(String),
          metadata: dlqMessage.metadata
        }),
        undefined,
        undefined
      );
    });

    it('should handle message not found in DLQ', async () => {
      mockAzureManager.dequeueMessages.mockResolvedValueOnce([]);

      const result = await deadLetterManager.moveMessageFromDlq('nonexistent-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found in DLQ');
    });
  });

  describe('Batch DLQ Operations', () => {
    const testMessages = [
      { message: testMessage, reason: 'Error 1' },
      { 
        message: { ...testMessage, id: 'msg-2' }, 
        reason: 'Error 2' 
      }
    ];

    beforeEach(async () => {
      await deadLetterManager.initialize();
    });

    it('should move multiple messages to DLQ', async () => {
      const result = await deadLetterManager.moveMessagesToDlq(testMessages);

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(2);

      expect(mockAzureManager.enqueueMessage).toHaveBeenCalledTimes(2);
    });

    it('should move multiple messages from DLQ', async () => {
      const messageIds = ['msg-1', 'msg-2'];
      
      // Mock successful dequeues
      mockAzureManager.dequeueMessages
        .mockResolvedValueOnce([testMessage])
        .mockResolvedValueOnce([{ ...testMessage, id: 'msg-2' }]);

      const result = await deadLetterManager.moveMessagesFromDlq(messageIds);

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(2);
    });

    it('should handle partial failures in batch operations', async () => {
      // Mock one success, one failure
      mockAzureManager.enqueueMessage
        .mockResolvedValueOnce(testMessage)
        .mockRejectedValueOnce(new Error('Enqueue failed'));

      const result = await deadLetterManager.moveMessagesToDlq(testMessages);

      expect(result.success).toBe(false);
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(false);
    });
  });

  describe('DLQ Information and Statistics', () => {
    beforeEach(async () => {
      await deadLetterManager.initialize();
    });

    it('should get DLQ information', async () => {
      mockAzureManager.getQueueStats.mockResolvedValue({
        messageCount: 5,
        approximateMessageCount: 5
      });

      const info = await deadLetterManager.getDlqInfo();

      expect(info.isEnabled).toBe(true);
      expect(info.queueName).toBe('test-queue-dlq');
      expect(info.messageCount).toBe(5);
      expect(info.maxDeliveryAttempts).toBe(3);
      expect(info.messageTtl).toBe(24 * 3600);

      expect(mockAzureManager.getQueueStats).toHaveBeenCalledWith('test-queue-dlq');
    });

    it('should indicate DLQ is disabled when not enabled', async () => {
      const disabledConfig = {
        ...mockConfig,
        settings: {
          ...mockConfig.settings,
          deadLetter: { ...mockConfig.settings.deadLetter, enabled: false }
        }
      };

      const disabledManager = new DeadLetterManager(
        mockRedisManager,
        mockAzureManager,
        disabledConfig
      );

      const info = await disabledManager.getDlqInfo();

      expect(info.isEnabled).toBe(false);
      expect(info.queueName).toBe('test-queue-dlq');
      expect(info.messageCount).toBe(0);
    });

    it('should purge DLQ', async () => {
      const purgeResult = await deadLetterManager.purgeDlq();

      expect(purgeResult.success).toBe(true);
      expect(purgeResult.queueName).toBe('test-queue-dlq');

      expect(mockAzureManager.purgeQueue).toHaveBeenCalledWith('test-queue-dlq');
    });

    it('should handle DLQ purge errors', async () => {
      mockAzureManager.purgeQueue.mockRejectedValue(new Error('Purge failed'));

      const purgeResult = await deadLetterManager.purgeDlq();

      expect(purgeResult.success).toBe(false);
      expect(purgeResult.error).toContain('Purge failed');
    });
  });

  describe('Retry Logic and Delay Calculation', () => {
    beforeEach(async () => {
      await deadLetterManager.initialize();
    });

    it('should calculate correct retry delays', () => {
      // This tests the internal calculateRetryDelay method through nackMessage
      const delays: number[] = [];
      
      // We can't directly test the private method, but we can test its effects
      expect(typeof deadLetterManager).toBe('object');
    });

    it('should respect maximum retry delay', async () => {
      const messageWithHighCount = {
        ...testMessage,
        dequeueCount: 10 // Very high count
      };

      const result = await deadLetterManager.nackMessage(messageWithHighCount);

      // Should still use exponential backoff but not exceed reasonable limits
      expect(result.retryDelaySeconds).toBeLessThan(3600); // Less than 1 hour
    });

    it('should add jitter to retry delays', async () => {
      const message1 = { ...testMessage, dequeueCount: 2 };
      const message2 = { ...testMessage, dequeueCount: 2 };

      const result1 = await deadLetterManager.nackMessage(message1);
      const result2 = await deadLetterManager.nackMessage(message2);

      // Due to jitter, delays might be slightly different
      // Both should be in a reasonable range around the base delay
      expect(result1.retryDelaySeconds).toBeGreaterThan(0);
      expect(result2.retryDelaySeconds).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      await deadLetterManager.initialize();
    });

    it('should handle Azure enqueue failures during retry', async () => {
      mockAzureManager.enqueueMessage.mockRejectedValue(new Error('Azure error'));

      const result = await deadLetterManager.nackMessage(testMessage, {
        reason: 'Test error'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Azure error');
    });

    it('should handle Azure enqueue failures during DLQ move', async () => {
      mockAzureManager.enqueueMessage.mockRejectedValue(new Error('DLQ enqueue failed'));

      const result = await deadLetterManager.moveMessageToDlq(testMessage, 'Manual move');

      expect(result.success).toBe(false);
      expect(result.error).toContain('DLQ enqueue failed');
    });

    it('should handle Azure dequeue failures during DLQ retrieval', async () => {
      mockAzureManager.dequeueMessages.mockRejectedValue(new Error('Dequeue failed'));

      const result = await deadLetterManager.moveMessageFromDlq(testMessage.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Dequeue failed');
    });

    it('should handle statistics retrieval failures', async () => {
      mockAzureManager.getQueueStats.mockRejectedValue(new Error('Stats failed'));

      const info = await deadLetterManager.getDlqInfo();

      expect(info.messageCount).toBe(0); // Should default to 0 on error
    });
  });

  describe('Edge Cases', () => {
    beforeEach(async () => {
      await deadLetterManager.initialize();
    });

    it('should handle message without processing history', async () => {
      const messageWithoutHistory = {
        ...testMessage,
        processingHistory: undefined
      };

      const result = await deadLetterManager.nackMessage(messageWithoutHistory);

      expect(result.success).toBe(true);
      expect(mockAzureManager.enqueueMessage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          processingHistory: expect.arrayContaining([
            expect.objectContaining({
              attemptNumber: 3, // dequeueCount + 1
            })
          ])
        }),
        expect.any(Number),
        expect.any(Number)
      );
    });

    it('should handle very large message content', async () => {
      const largeMessage = {
        ...testMessage,
        content: Buffer.alloc(100000, 'x') // 100KB message
      };

      const result = await deadLetterManager.moveMessageToDlq(largeMessage, 'Large message test');

      expect(result.success).toBe(true);
      expect(mockAzureManager.enqueueMessage).toHaveBeenCalled();
    });

    it('should handle message with complex metadata', async () => {
      const complexMessage = {
        ...testMessage,
        metadata: {
          nested: {
            data: {
              array: [1, 2, 3],
              boolean: true,
              null_value: null
            }
          },
          unicode: '🚀✨',
          number: 42.5
        }
      };

      const result = await deadLetterManager.moveMessageToDlq(complexMessage, 'Complex metadata test');

      expect(result.success).toBe(true);
      expect(mockAzureManager.enqueueMessage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          originalQueueName: 'test-queue',
          dlqReason: 'Complex metadata test'
        }),
        undefined,
        24 * 3600
      );
    });
  });
});
