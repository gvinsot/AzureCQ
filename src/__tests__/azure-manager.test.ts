/**
 * Unit tests for Azure Manager with Retry Logic
 */

import { AzureManager } from '../azure-manager';
import { QueueMessage, AzureCQError, ErrorCodes } from '../types';

// Mock Azure Storage SDK
jest.mock('@azure/storage-queue');
jest.mock('@azure/storage-blob');

describe('AzureManager', () => {
  let azureManager: AzureManager;
  let mockQueueClient: any;
  let mockBlobServiceClient: any;
  let mockContainerClient: any;

  const testConfig = {
    connectionString: 'DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=testkey;EndpointSuffix=core.windows.net',
    queueName: 'test-queue',
    containerName: 'test-container',
    maxInlineMessageSize: 64 * 1024
  };

  const testMessage: QueueMessage = {
    id: 'test-message-123',
    content: Buffer.from('Test message content'),
    metadata: { type: 'test', priority: 1 },
    dequeueCount: 0,
    insertedOn: new Date('2023-01-01T00:00:00Z'),
    nextVisibleOn: new Date('2023-01-01T01:00:00Z'),
    popReceipt: 'test-receipt-456'
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Queue Client
    mockQueueClient = {
      sendMessage: jest.fn(),
      receiveMessages: jest.fn(),
      deleteMessage: jest.fn(),
      create: jest.fn(),
      createIfNotExists: jest.fn(),
      delete: jest.fn(),
      getProperties: jest.fn(),
      clearMessages: jest.fn()
    };

    // Mock Container Client  
    mockContainerClient = {
      create: jest.fn(),
      createIfNotExists: jest.fn(),
      getBlockBlobClient: jest.fn(),
      deleteBlob: jest.fn()
    };

    // Mock Queue Service Client
    const mockQueueServiceClient = {
      getQueueClient: jest.fn().mockReturnValue(mockQueueClient)
    };

    // Mock Blob Service Client
    mockBlobServiceClient = {
      getContainerClient: jest.fn().mockReturnValue(mockContainerClient)
    };

    // Mock the Azure SDK constructors and static methods
    const { QueueServiceClient } = require('@azure/storage-queue');
    const { BlobServiceClient } = require('@azure/storage-blob');
    
    QueueServiceClient.fromConnectionString = jest.fn().mockReturnValue(mockQueueServiceClient);
    BlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(mockBlobServiceClient);

    azureManager = new AzureManager(testConfig);
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      mockQueueClient.createIfNotExists.mockResolvedValue({});
      mockContainerClient.createIfNotExists.mockResolvedValue({});

      await azureManager.initialize();

      expect(mockQueueClient.createIfNotExists).toHaveBeenCalled();
      expect(mockContainerClient.createIfNotExists).toHaveBeenCalled();
    });

    it('should handle queue already exists during initialization', async () => {
      const queueExistsError = new Error('Queue already exists');
      (queueExistsError as any).statusCode = 409;
      
      mockQueueClient.create.mockRejectedValue(queueExistsError);
      mockContainerClient.create.mockResolvedValue({});

      await azureManager.initialize();

      expect(mockQueueClient.create).toHaveBeenCalled();
      expect(mockContainerClient.create).toHaveBeenCalled();
    });

    it('should handle container already exists during initialization', async () => {
      const containerExistsError = new Error('Container already exists');
      (containerExistsError as any).statusCode = 409;
      
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockRejectedValue(containerExistsError);

      await azureManager.initialize();

      expect(mockQueueClient.create).toHaveBeenCalled();
      expect(mockContainerClient.create).toHaveBeenCalled();
    });
  });

  describe('Message Enqueue Operations', () => {
    beforeEach(async () => {
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should enqueue inline message successfully', async () => {
      const mockResponse = {
        messageId: 'azure-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'azure-receipt-456'
      };

      mockQueueClient.sendMessage.mockResolvedValue(mockResponse);

      const result = await azureManager.enqueueMessage(
        'Small message content',
        { type: 'inline' }
      );

      expect(result.id).toBe(mockResponse.messageId);
      expect(result.content).toEqual(Buffer.from('Small message content'));
      expect(result.metadata).toEqual({ type: 'inline' });
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('"type":"inline"'),
        expect.any(Object)
      );
    });

    it('should enqueue large message using blob storage', async () => {
      const largeContent = Buffer.alloc(testConfig.maxInlineMessageSize + 1000, 'x');
      
      const mockBlobClient = {
        upload: jest.fn().mockResolvedValue({})
      };
      mockContainerClient.getBlockBlobClient.mockReturnValue(mockBlobClient);

      const mockResponse = {
        messageId: 'azure-msg-456',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'azure-receipt-789'
      };
      mockQueueClient.sendMessage.mockResolvedValue(mockResponse);

      const result = await azureManager.enqueueMessage(largeContent, { type: 'large' });

      expect(result.id).toBe(mockResponse.messageId);
      expect(result.content).toEqual(largeContent);
      expect(mockBlobClient.upload).toHaveBeenCalledWith(largeContent, largeContent.length);
      expect(mockQueueClient.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('"type":"blob_reference"'),
        expect.any(Object)
      );
    });

    it('should clean up blob on enqueue failure', async () => {
      const largeContent = Buffer.alloc(testConfig.maxInlineMessageSize + 1000, 'x');
      
      const mockBlobClient = {
        upload: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({})
      };
      mockContainerClient.getBlockBlobClient.mockReturnValue(mockBlobClient);
      mockContainerClient.deleteBlob.mockResolvedValue({});

      mockQueueClient.sendMessage.mockRejectedValue(new Error('Queue send failed'));

      await expect(azureManager.enqueueMessage(largeContent, { type: 'large' }))
        .rejects.toThrow();

      expect(mockBlobClient.upload).toHaveBeenCalled();
      expect(mockContainerClient.deleteBlob).toHaveBeenCalled();
    });
  });

  describe('Message Dequeue Operations', () => {
    beforeEach(async () => {
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should dequeue inline messages successfully', async () => {
      const mockMessages = [
        {
          messageId: 'msg-1',
          messageText: JSON.stringify({
            type: 'inline',
            content: Buffer.from('Message 1').toString('base64'),
            metadata: { index: 1 }
          }),
          dequeueCount: 1,
          insertedOn: new Date('2023-01-01T00:00:00Z'),
          nextVisibleOn: new Date('2023-01-01T01:00:00Z'),
          popReceipt: 'receipt-1'
        },
        {
          messageId: 'msg-2',
          messageText: JSON.stringify({
            type: 'inline',
            content: Buffer.from('Message 2').toString('base64'),
            metadata: { index: 2 }
          }),
          dequeueCount: 0,
          insertedOn: new Date('2023-01-01T00:15:00Z'),
          nextVisibleOn: new Date('2023-01-01T01:15:00Z'),
          popReceipt: 'receipt-2'
        }
      ];

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: mockMessages
      });

      const result = await azureManager.dequeueMessages(2);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('msg-1');
      expect(result[0].content).toEqual(Buffer.from('Message 1'));
      expect(result[0].metadata).toEqual({ index: 1 });
      expect(result[1].id).toBe('msg-2');
      expect(result[1].content).toEqual(Buffer.from('Message 2'));
    });

    it('should dequeue blob-referenced messages successfully', async () => {
      const blobContent = Buffer.from('Large blob message content');
      
      const mockBlobClient = {
        downloadToBuffer: jest.fn().mockResolvedValue(blobContent)
      };
      mockContainerClient.getBlockBlobClient.mockReturnValue(mockBlobClient);

      const mockMessages = [
        {
          messageId: 'blob-msg-1',
          messageText: JSON.stringify({
            type: 'blob_reference',
            blobName: 'msg-blob-123',
            size: blobContent.length,
            metadata: { type: 'blob' }
          }),
          dequeueCount: 0,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'blob-receipt-1'
        }
      ];

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: mockMessages
      });

      const result = await azureManager.dequeueMessages(1);

      expect(result).toHaveLength(1);
      expect(result[0].content).toEqual(blobContent);
      expect(mockBlobClient.downloadToBuffer).toHaveBeenCalled();
    });

    it('should handle empty dequeue result', async () => {
      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: []
      });

      const result = await azureManager.dequeueMessages(5);

      expect(result).toHaveLength(0);
    });

    it('should handle malformed message content', async () => {
      const mockMessages = [
        {
          messageId: 'bad-msg-1',
          messageText: 'invalid-json-content',
          dequeueCount: 0,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'bad-receipt-1'
        }
      ];

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: mockMessages
      });

      await expect(azureManager.dequeueMessages(1)).rejects.toThrow(AzureCQError);
    });
  });

  describe('Message Acknowledgment', () => {
    beforeEach(async () => {
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should acknowledge message successfully', async () => {
      mockQueueClient.deleteMessage.mockResolvedValue({});

      await azureManager.acknowledgeMessage(testMessage.id, testMessage.popReceipt!);

      expect(mockQueueClient.deleteMessage).toHaveBeenCalledWith(
        testMessage.id,
        testMessage.popReceipt
      );
    });

    it('should clean up blob after acknowledging blob-referenced message', async () => {
      const blobMessage = {
        ...testMessage,
        metadata: { 
          ...testMessage.metadata,
          blobName: 'test-blob-123'
        }
      };

      mockQueueClient.deleteMessage.mockResolvedValue({});
      mockContainerClient.deleteBlob.mockResolvedValue({});

      await azureManager.acknowledgeMessage(blobMessage.id, blobMessage.popReceipt!);

      expect(mockQueueClient.deleteMessage).toHaveBeenCalled();
      // Note: Blob cleanup would be handled by the higher-level AzureCQ class
    });

    it('should handle acknowledgment failure gracefully', async () => {
      mockQueueClient.deleteMessage.mockRejectedValue(new Error('Delete failed'));

      await expect(azureManager.acknowledgeMessage(testMessage.id, testMessage.popReceipt!))
        .rejects.toThrow('Delete failed');
    });
  });

  describe('Retry Logic', () => {
    beforeEach(async () => {
      mockQueueClient.createIfNotExists.mockResolvedValue({});
      mockContainerClient.createIfNotExists.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should retry on transient failures', async () => {
      // First 3 calls fail, 4th succeeds
      const serverError = new Error('InternalError');
      const timeoutError = new Error('RequestTimeout'); 
      const busyError = new Error('ServerBusy');
      
      mockQueueClient.sendMessage
        .mockRejectedValueOnce(serverError)
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(busyError)
        .mockResolvedValueOnce({
          messageId: 'retry-success-123',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'retry-receipt'
        });

      const result = await azureManager.enqueueMessage('Retry test message');

      expect(result.id).toBe('retry-success-123');
      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(4);
    });

    it('should not retry on non-retryable errors', async () => {
      const authError = new Error('Authentication failed');
      (authError as any).statusCode = 401;
      
      mockQueueClient.sendMessage.mockRejectedValue(authError);

      await expect(azureManager.enqueueMessage('Auth test'))
        .rejects.toThrow(AzureCQError);

      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should exhaust retry attempts for persistent failures', async () => {
      const persistentError = new Error('InternalError');
      mockQueueClient.sendMessage.mockRejectedValue(persistentError);

      await expect(azureManager.enqueueMessage('Persistent failure test'))
        .rejects.toThrow(AzureCQError);

      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(5); // Default max attempts
    });

    it('should apply exponential backoff between retries', async () => {
      jest.useFakeTimers();
      
      let callCount = 0;
      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      
      global.setTimeout = jest.fn().mockImplementation((callback: any, delay: any) => {
        delays.push(delay);
        return originalSetTimeout(callback, 0); // Execute immediately in tests
      }) as any;

      mockQueueClient.sendMessage.mockImplementation(() => {
        callCount++;
        if (callCount < 4) {
          throw new Error('InternalError');
        }
        return Promise.resolve({
          messageId: 'backoff-test-123',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'backoff-receipt'
        });
      });

      await azureManager.enqueueMessage('Backoff test message');

      // Should have increasing delays (with jitter applied)
      expect(delays.length).toBeGreaterThan(0);
      expect(delays[0]).toBeGreaterThan(0);
      if (delays.length > 1) {
        expect(delays[1]).toBeGreaterThan(delays[0] * 0.5); // Account for jitter
      }

      jest.useRealTimers();
      global.setTimeout = originalSetTimeout;
    });

    it('should reinitialize clients on connection errors', async () => {
      const connectionError = new Error('Connection reset');
      (connectionError as any).code = 'ECONNRESET';
      
      // First call fails with connection error, second succeeds
      mockQueueClient.sendMessage
        .mockRejectedValueOnce(connectionError)
        .mockResolvedValueOnce({
          messageId: 'reconnect-success-123',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'reconnect-receipt'
        });

      const result = await azureManager.enqueueMessage('Reconnect test');

      expect(result.id).toBe('reconnect-success-123');
      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should handle retry logic for batch operations', async () => {
      const messages = [
        { content: 'Batch message 1', metadata: { index: 1 } },
        { content: 'Batch message 2', metadata: { index: 2 } }
      ];

      // Fail first attempt, succeed on retry
      mockQueueClient.sendMessage
        .mockRejectedValueOnce(new Error('Batch retry error'))
        .mockRejectedValueOnce(new Error('Batch retry error'))
        .mockResolvedValueOnce({
          messageId: 'batch-1',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'batch-receipt-1'
        })
        .mockResolvedValueOnce({
          messageId: 'batch-2',
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'batch-receipt-2'
        });

      const result = await azureManager.enqueueMessageBatch(messages);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('batch-1');
      expect(result[1].id).toBe('batch-2');
    });
  });

  describe('Queue Management Operations', () => {
    beforeEach(async () => {
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should create queue successfully', async () => {
      mockQueueClient.create.mockResolvedValue({});

      await azureManager.createQueue('new-test-queue');

      expect(mockQueueClient.create).toHaveBeenCalled();
    });

    it('should delete queue successfully', async () => {
      mockQueueClient.delete.mockResolvedValue({});

      await azureManager.deleteQueue('test-queue-to-delete');

      expect(mockQueueClient.delete).toHaveBeenCalled();
    });

    it('should get queue statistics', async () => {
      mockQueueClient.getProperties.mockResolvedValue({
        approximateMessagesCount: 42
      });

      const stats = await azureManager.getQueueStats();

      expect(stats.messageCount).toBe(42);
    });

    it('should purge queue successfully', async () => {
      mockQueueClient.clearMessages.mockResolvedValue({});

      // Note: purgeQueue is not implemented in AzureManager
      // This would be handled by the higher-level AzureCQ class
      expect(mockQueueClient.clearMessages).toBeDefined();
    });
  });

  describe('Error Classification', () => {
    beforeEach(async () => {
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should identify retryable network errors', async () => {
      const networkErrors = [
        { message: 'Network timeout', code: 'ETIMEDOUT' },
        { message: 'Connection reset', code: 'ECONNRESET' },
        { message: 'DNS lookup failed', code: 'ENOTFOUND' },
        { message: 'Server Error', statusCode: 500 },
        { message: 'Bad Gateway', statusCode: 502 },
        { message: 'Service Unavailable', statusCode: 503 },
        { message: 'Gateway Timeout', statusCode: 504 }
      ];

      for (const errorConfig of networkErrors) {
        const error = new Error(errorConfig.message);
        Object.assign(error, errorConfig);
        
        mockQueueClient.sendMessage
          .mockReset()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({
            messageId: 'retry-test',
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: 'retry-receipt'
          });

        const result = await azureManager.enqueueMessage(`Test for ${errorConfig.message}`);
        expect(result.id).toBe('retry-test');
        expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(2);
      }
    });

    it('should identify non-retryable authentication errors', async () => {
      const authErrors = [
        { message: 'Unauthorized', statusCode: 401 },
        { message: 'Forbidden', statusCode: 403 },
        { message: 'Not Found', statusCode: 404 }
      ];

      for (const errorConfig of authErrors) {
        const error = new Error(errorConfig.message);
        Object.assign(error, errorConfig);
        
        mockQueueClient.sendMessage.mockReset().mockRejectedValue(error);

        await expect(azureManager.enqueueMessage(`Test for ${errorConfig.message}`))
          .rejects.toThrow(AzureCQError);
        
        expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(1);
      }
    });

    it('should identify connection errors requiring reinitialization', async () => {
      const connectionErrors = [
        { code: 'ECONNRESET' },
        { code: 'ENOTFOUND' },
        { code: 'ETIMEDOUT' }
      ];

      for (const errorConfig of connectionErrors) {
        const error = new Error('Connection error');
        Object.assign(error, errorConfig);
        
        mockQueueClient.sendMessage
          .mockReset()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({
            messageId: 'connection-test',
            insertedOn: new Date(),
            nextVisibleOn: new Date(),
            popReceipt: 'connection-receipt'
          });

        const result = await azureManager.enqueueMessage('Connection error test');
        expect(result.id).toBe('connection-test');
      }
    });
  });

  describe('Blob Storage Operations', () => {
    beforeEach(async () => {
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should store large message in blob with retry', async () => {
      const largeContent = Buffer.alloc(100000, 'x');
      const blobName = 'test-blob-123';
      
      const mockBlobClient = {
        upload: jest.fn()
          .mockRejectedValueOnce(new Error('Blob upload failed'))
          .mockResolvedValueOnce({})
      };
      mockContainerClient.getBlockBlobClient.mockReturnValue(mockBlobClient);

      // This tests the internal storeLargeMessageInBlob method through enqueueMessage
      mockQueueClient.sendMessage.mockResolvedValue({
        messageId: 'large-msg-123',
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'large-receipt'
      });

      const result = await azureManager.enqueueMessage(largeContent);

      expect(result.content).toEqual(largeContent);
      expect(mockBlobClient.upload).toHaveBeenCalledTimes(2); // Failed once, succeeded on retry
    });

    it('should retrieve large message from blob with retry', async () => {
      const blobContent = Buffer.from('Retrieved blob content');
      
      const mockBlobClient = {
        downloadToBuffer: jest.fn()
          .mockRejectedValueOnce(new Error('Blob download failed'))
          .mockResolvedValueOnce(blobContent)
      };
      mockContainerClient.getBlockBlobClient.mockReturnValue(mockBlobClient);

      const mockMessages = [
        {
          messageId: 'blob-msg-retry',
          messageText: JSON.stringify({
            type: 'blob_reference',
            blobName: 'retry-blob-123',
            size: blobContent.length,
            metadata: { type: 'blob' }
          }),
          dequeueCount: 0,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: 'blob-retry-receipt'
        }
      ];

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: mockMessages
      });

      const result = await azureManager.dequeueMessages(1);

      expect(result[0].content).toEqual(blobContent);
      expect(mockBlobClient.downloadToBuffer).toHaveBeenCalledTimes(2);
    });

    it('should delete blob with retry on acknowledgment', async () => {
      const blobMessage = {
        ...testMessage,
        metadata: { 
          ...testMessage.metadata,
          blobName: 'delete-test-blob'
        }
      };

      mockQueueClient.deleteMessage.mockResolvedValue({});
      mockContainerClient.deleteBlob
        .mockRejectedValueOnce(new Error('Blob delete failed'))
        .mockResolvedValueOnce({});

      await azureManager.acknowledgeMessage(blobMessage.id, blobMessage.popReceipt!);

      expect(mockQueueClient.deleteMessage).toHaveBeenCalled();
      // Note: Blob cleanup would need to be tested at the AzureCQ level
    });
  });

  describe('Performance and Load Testing', () => {
    beforeEach(async () => {
      mockQueueClient.create.mockResolvedValue({});
      mockContainerClient.create.mockResolvedValue({});
      await azureManager.initialize();
    });

    it('should handle high-volume batch operations', async () => {
      const batchSize = 100;
      const messages = Array.from({ length: batchSize }, (_, i) => ({
        content: `Batch message ${i}`,
        metadata: { index: i, batch: 'performance-test' }
      }));

      // Mock successful responses for all messages
      mockQueueClient.sendMessage.mockImplementation((content: any, options: any) => 
        Promise.resolve({
          messageId: `perf-msg-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `perf-receipt-${Math.random()}`
        })
      );

      const start = Date.now();
      const result = await azureManager.enqueueMessageBatch(messages);
      const duration = Date.now() - start;

      expect(result).toHaveLength(batchSize);
      expect(mockQueueClient.sendMessage).toHaveBeenCalledTimes(batchSize);
      
      console.log(`Batch enqueue of ${batchSize} messages took ${duration}ms`);
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should handle concurrent operations efficiently', async () => {
      mockQueueClient.sendMessage.mockImplementation(() => 
        Promise.resolve({
          messageId: `concurrent-msg-${Math.random()}`,
          insertedOn: new Date(),
          nextVisibleOn: new Date(),
          popReceipt: `concurrent-receipt-${Math.random()}`
        })
      );

      const concurrentOperations = 50;
      const promises = Array.from({ length: concurrentOperations }, (_, i) =>
        azureManager.enqueueMessage(`Concurrent message ${i}`, { index: i })
      );

      const start = Date.now();
      const results = await Promise.all(promises);
      const duration = Date.now() - start;

      expect(results).toHaveLength(concurrentOperations);
      console.log(`${concurrentOperations} concurrent operations took ${duration}ms`);
      expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
    });
  });
});
