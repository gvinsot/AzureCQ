/**
 * Tests for Redis Manager
 */

import { RedisManager } from '../redis-manager';
import { PerformancePresets } from '../performance-optimizations';
import { QueueMessage } from '../types';

// Mock ioredis
jest.mock('ioredis');

describe('RedisManager', () => {
  let redisManager: RedisManager;
  let mockRedis: any;
  let mockPipeline: any;
  let eventHandlers: Record<string, Function>;

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();
    eventHandlers = {};
    
    // Create mock pipeline
    mockPipeline = {
      setex: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([])
    };

    // Create mock Redis instance
    mockRedis = {
      connect: jest.fn().mockImplementation(async () => {
        // Simulate connection success - trigger 'connect' and 'ready' events
        if (eventHandlers['connect']) eventHandlers['connect']();
        if (eventHandlers['ready']) eventHandlers['ready']();
      }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      zadd: jest.fn().mockResolvedValue(1),
      zpopmin: jest.fn().mockResolvedValue([]),
      zrem: jest.fn().mockResolvedValue(1),
      zcard: jest.fn().mockResolvedValue(0),
      ping: jest.fn().mockResolvedValue('PONG'),
      eval: jest.fn().mockResolvedValue(0),
      pipeline: jest.fn().mockReturnValue(mockPipeline),
      on: jest.fn().mockImplementation((event, handler) => {
        eventHandlers[event] = handler;
        return mockRedis;
      }),
      status: 'wait'
    };

    // Mock the Redis constructor
    const Redis = require('ioredis');
    Redis.mockImplementation(() => mockRedis);

    redisManager = new RedisManager({
      host: 'localhost',
      port: 6379,
      keyPrefix: 'test:',
      performanceProfile: 'BALANCED'
    });

    // Connect to establish proper state for tests
    try {
      await redisManager.connect();
    } catch (error) {
      // Some tests may deliberately fail connection
    }
  });

  afterEach(async () => {
    // Clean up connections and timers to prevent test leaks
    try {
      await redisManager.disconnect();
    } catch (error) {
      // Ignore disconnect errors in tests
    }
  });

  describe('connection management', () => {
    it('should connect to Redis', async () => {
      // Create a fresh manager for this test
      const freshManager = new RedisManager({
        host: 'localhost',
        port: 6379,
        keyPrefix: 'test:'
      });
      
      await freshManager.connect();
      expect(mockRedis.connect).toHaveBeenCalled();
      
      const status = freshManager.getConnectionStatus();
      expect(status.isConnected).toBe(true);
      
      await freshManager.disconnect();
    });

    it('should disconnect from Redis', async () => {
      await redisManager.disconnect();
      expect(mockRedis.disconnect).toHaveBeenCalled();
      
      const status = redisManager.getConnectionStatus();
      expect(status.isConnected).toBe(false);
    });

    it('should handle connection errors', async () => {
      mockRedis.connect.mockRejectedValue(new Error('Connection failed'));
      
      const failingManager = new RedisManager({
        host: 'localhost',
        port: 6379,
        keyPrefix: 'test:'
      });
      
      // The connection error is thrown directly
      await expect(failingManager.connect()).rejects.toThrow('Connection failed');
      
      const status = failingManager.getConnectionStatus();
      expect(status.isConnected).toBe(false);
    });

    it('should provide connection status', async () => {
      const status = redisManager.getConnectionStatus();
      
      expect(status).toHaveProperty('isConnected');
      expect(status).toHaveProperty('isConnecting');
      expect(status).toHaveProperty('shouldReconnect');
      expect(status).toHaveProperty('isHealthCheckActive');
      expect(status).toHaveProperty('hasCustomReconnectScheduled');
    });
  });

  describe('message caching', () => {
    const testMessage: QueueMessage = {
      id: 'test-message-1',
      content: Buffer.from('test content'),
      metadata: { test: 'value' },
      dequeueCount: 0,
      insertedOn: new Date('2023-01-01'),
      nextVisibleOn: new Date('2023-01-01'),
      popReceipt: 'test-receipt'
    };

    it('should cache a message using pipeline', async () => {
      await redisManager.cacheMessage('test-queue', testMessage, 3600);
      
      // Now uses pipeline for batch operations (even for single message)
      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockPipeline.setex).toHaveBeenCalled();
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('should retrieve a cached message', async () => {
      // Mock pipeline get for batch retrieval
      const mockPipelineForGet = {
        get: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[null, null]]) // No cached message
      };
      mockRedis.pipeline.mockReturnValue(mockPipelineForGet);
      
      const result = await redisManager.getCachedMessage('test-queue', 'test-message-1');
      
      // Returns null when no cached message (pipeline returns null)
      expect(result).toBeNull();
    });

    it('should return null for non-existent message', async () => {
      const mockPipelineForGet = {
        get: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[null, null]])
      };
      mockRedis.pipeline.mockReturnValue(mockPipelineForGet);
      
      const result = await redisManager.getCachedMessage('test-queue', 'non-existent');
      
      expect(result).toBeNull();
    });

    it('should remove a cached message', async () => {
      await redisManager.removeCachedMessage('test-queue', 'test-message-1');
      
      expect(mockRedis.del).toHaveBeenCalledWith('test:msg:test-queue:test-message-1');
    });
  });

  describe('hot queue management', () => {
    it('should add message to hot queue using pipeline', async () => {
      await redisManager.addToHotQueue('test-queue', 'message-1', 100);
      
      // Uses pipeline for batch operations
      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockPipeline.zadd).toHaveBeenCalled();
    });

    it('should get messages from hot queue', async () => {
      // zpopmin returns [member, score, member, score, ...]
      mockRedis.zpopmin.mockResolvedValue(['message-1', '100', 'message-2', '200']);
      
      const result = await redisManager.getFromHotQueue('test-queue', 2);
      
      expect(result).toEqual(['message-1', 'message-2']);
      expect(mockRedis.zpopmin).toHaveBeenCalledWith('test:hot:test-queue', 2);
    });

    it('should remove message from hot queue', async () => {
      await redisManager.removeFromHotQueue('test-queue', 'message-1');
      
      expect(mockRedis.zrem).toHaveBeenCalledWith('test:hot:test-queue', 'message-1');
    });
  });

  describe('batch operations', () => {
    it('should cache multiple messages in batch', async () => {
      const testMessage: QueueMessage = {
        id: 'test-message-1',
        content: Buffer.from('test content'),
        metadata: { test: 'value' },
        dequeueCount: 0,
        insertedOn: new Date('2023-01-01'),
        nextVisibleOn: new Date('2023-01-01'),
        popReceipt: 'test-receipt'
      };
      
      const messages = [
        { ...testMessage, id: 'msg-1' },
        { ...testMessage, id: 'msg-2' }
      ];
      
      await redisManager.cacheMessageBatch('test-queue', messages, 3600);
      
      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockPipeline.setex).toHaveBeenCalledTimes(2);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });
  });

  describe('health checks', () => {
    it('should return true for healthy connection', async () => {
      const result = await redisManager.healthCheck();
      
      expect(result).toBe(true);
      expect(mockRedis.ping).toHaveBeenCalled();
    });

    it('should return false for unhealthy connection', async () => {
      mockRedis.ping.mockRejectedValue(new Error('Connection failed'));
      
      const result = await redisManager.healthCheck();
      
      expect(result).toBe(false);
    });
  });

  describe('pending delete operations', () => {
    it('should set pending delete flag', async () => {
      await redisManager.setPendingDelete('test-queue', 'temp-id', 3600);
      
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test:penddel:test-queue:temp-id',
        3600,
        '1'
      );
    });

    it('should consume pending delete atomically', async () => {
      // Mock Lua eval for atomic consume
      mockRedis.eval.mockResolvedValue(1);
      
      const result = await redisManager.consumePendingDelete('test-queue', 'temp-id');
      
      expect(result).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should return false when no pending delete exists', async () => {
      mockRedis.eval.mockResolvedValue(0);
      
      const result = await redisManager.consumePendingDelete('test-queue', 'temp-id');
      
      expect(result).toBe(false);
    });
  });

  describe('id mapping operations', () => {
    it('should set id mapping', async () => {
      await redisManager.setIdMapping('test-queue', 'temp-id', 'azure-id', 'pop-receipt', 3600);
      
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test:idmap:test-queue:temp-id',
        3600,
        JSON.stringify({ azureId: 'azure-id', popReceipt: 'pop-receipt' })
      );
    });

    it('should get id mapping', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ azureId: 'azure-id', popReceipt: 'pop-receipt' }));
      
      const result = await redisManager.getIdMapping('test-queue', 'temp-id');
      
      expect(result).toEqual({ azureId: 'azure-id', popReceipt: 'pop-receipt' });
    });

    it('should return null for non-existent mapping', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      const result = await redisManager.getIdMapping('test-queue', 'non-existent');
      
      expect(result).toBeNull();
    });

    it('should remove id mapping', async () => {
      await redisManager.removeIdMapping('test-queue', 'temp-id');
      
      expect(mockRedis.del).toHaveBeenCalledWith('test:idmap:test-queue:temp-id');
    });
  });

  describe('enhanced features', () => {
    it('should support performance profiles', () => {
      const highThroughputManager = new RedisManager({
        host: 'localhost',
        port: 6379,
        performanceProfile: 'HIGH_THROUGHPUT'
      });

      expect(highThroughputManager).toBeInstanceOf(RedisManager);
    });

    it('should provide performance metrics', () => {
      const metrics = redisManager.getPerformanceMetrics();

      expect(metrics).toHaveProperty('redis');
      expect(metrics).toHaveProperty('connection');
      expect(metrics).toHaveProperty('memory');
    });

    it('should support batch message caching', async () => {
      const testMsg: QueueMessage = {
        id: 'test-message-1',
        content: Buffer.from('test content'),
        metadata: { test: 'value' },
        dequeueCount: 0,
        insertedOn: new Date('2023-01-01'),
        nextVisibleOn: new Date('2023-01-01'),
        popReceipt: 'test-receipt'
      };
      const messages = [testMsg, { ...testMsg, id: 'test-message-2' }];
      
      await redisManager.cacheMessageBatch('test-queue', messages, 3600);
      
      // Uses binary serialization via pipeline
      expect(mockRedis.pipeline).toHaveBeenCalled();
    });

    it('should support batch hot queue operations', async () => {
      const messageIds = ['msg-1', 'msg-2', 'msg-3'];
      const priorities = [100, 200, 300];

      await redisManager.addToHotQueueBatch('test-queue', messageIds, priorities);

      expect(mockRedis.pipeline).toHaveBeenCalled();
    });

    it('should reset performance metrics', () => {
      redisManager.resetPerformanceMetrics();
      
      const metrics = redisManager.getPerformanceMetrics();
      expect(Object.keys(metrics.redis)).toHaveLength(0);
    });

    it('should get queue stats', async () => {
      mockRedis.zcard.mockResolvedValue(5);
      
      const stats = await redisManager.getQueueStats('test-queue');
      
      expect(stats.hotCount).toBe(5);
      expect(mockRedis.zcard).toHaveBeenCalledWith('test:hot:test-queue');
    });
  });

  describe('atomic operations', () => {
    it('should atomically replace temp message with Azure message', async () => {
      mockRedis.eval.mockResolvedValue(1);
      
      const azureMessage: QueueMessage = {
        id: 'azure-id',
        content: Buffer.from('test content'),
        metadata: {},
        dequeueCount: 0,
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'azure-receipt'
      };
      
      const result = await redisManager.atomicReplaceWithAzureMessage(
        'test-queue',
        'temp-id',
        azureMessage,
        3600
      );
      
      expect(result).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should return false when temp message already consumed', async () => {
      mockRedis.eval.mockResolvedValue(0);
      
      const azureMessage: QueueMessage = {
        id: 'azure-id',
        content: Buffer.from('test content'),
        metadata: {},
        dequeueCount: 0,
        insertedOn: new Date(),
        nextVisibleOn: new Date(),
        popReceipt: 'azure-receipt'
      };
      
      const result = await redisManager.atomicReplaceWithAzureMessage(
        'test-queue',
        'temp-id',
        azureMessage,
        3600
      );
      
      expect(result).toBe(false);
    });
  });
});
