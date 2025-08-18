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

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create mock Redis instance
    mockRedis = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      zadd: jest.fn().mockResolvedValue(1),
      zpopmin: jest.fn(),
      zrem: jest.fn().mockResolvedValue(1),
      zcard: jest.fn().mockResolvedValue(0),
      ping: jest.fn().mockResolvedValue('PONG'),
      pipeline: jest.fn().mockReturnValue({
        setex: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([])
      }),
      on: jest.fn()
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
      
      await expect(failingManager.connect()).rejects.toThrow('Failed to connect to Redis');
      
      const status = failingManager.getConnectionStatus();
      expect(status.isConnected).toBe(false);
    });

    it('should provide connection status', async () => {
      const status = redisManager.getConnectionStatus();
      
      expect(status).toHaveProperty('isConnected');
      expect(status).toHaveProperty('reconnectAttempts');
      expect(status).toHaveProperty('maxReconnectAttempts');
      expect(status).toHaveProperty('isHealthCheckActive');
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

    it('should cache a message', async () => {
      await redisManager.cacheMessage('test-queue', testMessage, 3600);
      
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test:msg:test-queue:test-message-1',
        3600,
        expect.stringContaining('"id":"test-message-1"')
      );
    });

    it('should retrieve a cached message', async () => {
      const messageData = JSON.stringify({
        ...testMessage,
        content: testMessage.content.toString('base64'),
        insertedOn: testMessage.insertedOn.toISOString(),
        nextVisibleOn: testMessage.nextVisibleOn.toISOString()
      });
      
      mockRedis.get.mockResolvedValue(messageData);
      
      const result = await redisManager.getCachedMessage('test-queue', 'test-message-1');
      
      expect(result).toBeTruthy();
      expect(result?.id).toBe('test-message-1');
      expect(mockRedis.get).toHaveBeenCalledWith('test:msg:test-queue:test-message-1');
    });

    it('should return null for non-existent message', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      const result = await redisManager.getCachedMessage('test-queue', 'non-existent');
      
      expect(result).toBeNull();
    });

    it('should remove a cached message', async () => {
      await redisManager.removeCachedMessage('test-queue', 'test-message-1');
      
      expect(mockRedis.del).toHaveBeenCalledWith('test:msg:test-queue:test-message-1');
    });
  });

  describe('hot queue management', () => {
    it('should add message to hot queue', async () => {
      await redisManager.addToHotQueue('test-queue', 'message-1', 100);
      
      expect(mockRedis.zadd).toHaveBeenCalledWith('test:hot:test-queue', 100, 'message-1');
    });

    it('should get messages from hot queue', async () => {
      mockRedis.zpopmin.mockResolvedValue(['message-1', 'message-2']);
      
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
      
      const mockPipeline = {
        setex: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([])
      };
      mockRedis.pipeline.mockReturnValue(mockPipeline);
      
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

  describe('enhanced features', () => {
    beforeEach(async () => {
      try {
        await redisManager.connect();
      } catch (error) {
        // Ignore connection errors in tests
      }
    });

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
      const messages = [testMessage, { ...testMessage, id: 'test-message-2' }];
      
      await redisManager.cacheMessageBatch('test-queue', messages, 3600);
      
      // In the enhanced version, this uses binary serialization
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
  });
});
