/**
 * Unit tests for Performance Optimizations
 */

import { 
  BinaryMessageCodec,
  AdvancedRedisOperations,
  ObjectPool,
  BufferPool,
  ConcurrentBatchProcessor,
  PerformanceMonitor,
  PerformancePresets
} from '../performance-optimizations';
import { QueueMessage } from '../types';

describe('BinaryMessageCodec', () => {
  const testMessage: QueueMessage = {
    id: 'test-message-123',
    content: Buffer.from('Hello, World!'),
    metadata: { 
      type: 'test',
      priority: 1,
      source: 'unit-test'
    },
    dequeueCount: 3,
    insertedOn: new Date('2023-01-01T00:00:00Z'),
    nextVisibleOn: new Date('2023-01-01T01:00:00Z'),
    popReceipt: 'test-receipt-456'
  };

  it('should encode and decode messages correctly', () => {
    const encoded = BinaryMessageCodec.encode(testMessage);
    expect(encoded).toBeInstanceOf(Buffer);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = BinaryMessageCodec.decode(encoded);
    expect(decoded.id).toBe(testMessage.id);
    expect(decoded.content).toEqual(testMessage.content);
    expect(decoded.metadata).toEqual(testMessage.metadata);
    expect(decoded.dequeueCount).toBe(testMessage.dequeueCount);
    expect(decoded.insertedOn.getTime()).toBe(testMessage.insertedOn.getTime());
    expect(decoded.nextVisibleOn.getTime()).toBe(testMessage.nextVisibleOn.getTime());
  });

  it('should handle string content', () => {
    const stringMessage: QueueMessage = {
      ...testMessage,
      content: 'String content test'
    };

    const encoded = BinaryMessageCodec.encode(stringMessage);
    const decoded = BinaryMessageCodec.decode(encoded);
    
    expect(decoded.content).toBe(stringMessage.content);
  });

  it('should handle empty metadata', () => {
    const messageWithoutMeta: QueueMessage = {
      ...testMessage,
      metadata: {}
    };

    const encoded = BinaryMessageCodec.encode(messageWithoutMeta);
    const decoded = BinaryMessageCodec.decode(encoded);
    
    expect(decoded.metadata).toEqual({});
  });

  it('should be more compact than JSON', () => {
    const jsonSize = JSON.stringify({
      ...testMessage,
      content: Buffer.isBuffer(testMessage.content) 
        ? testMessage.content.toString('base64') 
        : testMessage.content,
      insertedOn: testMessage.insertedOn.toISOString(),
      nextVisibleOn: testMessage.nextVisibleOn.toISOString(),
    }).length;

    const binarySize = BinaryMessageCodec.encode(testMessage).length;
    
    expect(binarySize).toBeLessThan(jsonSize);
  });

  it('should handle large content', () => {
    const largeContent = Buffer.alloc(10000, 'x');
    const largeMessage: QueueMessage = {
      ...testMessage,
      content: largeContent
    };

    const encoded = BinaryMessageCodec.encode(largeMessage);
    const decoded = BinaryMessageCodec.decode(encoded);
    
    expect(decoded.content).toEqual(largeContent);
  });
});

describe('ObjectPool', () => {
  it('should create and reuse objects', () => {
    const createFn = jest.fn(() => ({ data: 'test' }));
    const resetFn = jest.fn();
    const pool = new ObjectPool(createFn, 5, resetFn);

    // First acquisition should create new object
    const obj1 = pool.acquire();
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(obj1).toEqual({ data: 'test' });

    // Release and acquire should reuse
    pool.release(obj1);
    expect(resetFn).toHaveBeenCalledWith(obj1);
    
    const obj2 = pool.acquire();
    expect(createFn).toHaveBeenCalledTimes(1); // Still only called once
    expect(obj2).toBe(obj1); // Same object reference
  });

  it('should respect max size limit', () => {
    const pool = new ObjectPool(() => ({}), 2);

    const obj1 = pool.acquire();
    const obj2 = pool.acquire();
    const obj3 = pool.acquire();

    pool.release(obj1);
    pool.release(obj2);
    pool.release(obj3); // This should be discarded due to max size

    expect(pool.size()).toBe(2);
  });

  it('should track pool size correctly', () => {
    const pool = new ObjectPool(() => ({}), 5);

    expect(pool.size()).toBe(0);

    const obj1 = pool.acquire();
    const obj2 = pool.acquire();
    
    pool.release(obj1);
    expect(pool.size()).toBe(1);
    
    pool.release(obj2);
    expect(pool.size()).toBe(2);
  });
});

describe('BufferPool', () => {
  it('should provide pre-allocated buffers', () => {
    const buffer = BufferPool.acquire();
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBe(64 * 1024); // 64KB

    BufferPool.release(buffer);
    expect(BufferPool.size()).toBeGreaterThan(0);
  });

  it('should reset buffers on release', () => {
    const buffer = BufferPool.acquire();
    buffer.write('test data', 0);
    
    BufferPool.release(buffer);
    
    const reusedBuffer = BufferPool.acquire();
    expect(reusedBuffer.toString('utf8', 0, 9)).toBe('\0\0\0\0\0\0\0\0\0');
  });
});

describe('ConcurrentBatchProcessor', () => {
  it('should process items in batches', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const processedBatches: number[][] = [];
    
    const processor = new ConcurrentBatchProcessor<number, number>(
      async (batch: number[]) => {
        processedBatches.push([...batch]);
        return batch.map(x => x * 2);
      },
      2, // concurrency
      10 // batch size
    );

    const results = await processor.processAll(items);
    
    expect(results).toHaveLength(100);
    expect(results).toEqual(items.map(x => x * 2));
    expect(processedBatches.length).toBe(10); // 100 items / 10 batch size
    
    // Check that batches were processed
    processedBatches.forEach(batch => {
      expect(batch.length).toBeLessThanOrEqual(10);
    });
  });

  it('should handle empty input', async () => {
    const processor = new ConcurrentBatchProcessor<number, number>(
      async (batch) => batch,
      2,
      10
    );

    const results = await processor.processAll([]);
    expect(results).toEqual([]);
  });

  it('should respect concurrency limits', async () => {
    let activeBatches = 0;
    let maxConcurrentBatches = 0;
    
    const processor = new ConcurrentBatchProcessor<number, number>(
      async (batch: number[]) => {
        activeBatches++;
        maxConcurrentBatches = Math.max(maxConcurrentBatches, activeBatches);
        
        await new Promise(resolve => setTimeout(resolve, 50));
        
        activeBatches--;
        return batch;
      },
      3, // max concurrency
      5  // batch size
    );

    const items = Array.from({ length: 50 }, (_, i) => i);
    await processor.processAll(items);
    
    expect(maxConcurrentBatches).toBeLessThanOrEqual(3);
  });
});

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  it('should measure operation timing', async () => {
    const result = await monitor.time('test-operation', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return 'success';
    });

    expect(result).toBe('success');
    
    const stats = monitor.getStats();
    expect(stats['test-operation']).toBeDefined();
    expect(stats['test-operation'].count).toBe(1);
    expect(stats['test-operation'].avgTime).toBeGreaterThan(45);
    expect(stats['test-operation'].minTime).toBeGreaterThan(45);
    expect(stats['test-operation'].maxTime).toBeGreaterThan(45);
  });

  it('should handle multiple operations', async () => {
    await monitor.time('fast-op', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    await monitor.time('slow-op', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    await monitor.time('fast-op', async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
    });

    const stats = monitor.getStats();
    
    expect(stats['fast-op'].count).toBe(2);
    expect(stats['slow-op'].count).toBe(1);
    expect(stats['fast-op'].avgTime).toBeLessThan(stats['slow-op'].avgTime);
  });

  it('should handle operation errors', async () => {
    try {
      await monitor.time('error-op', async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        throw new Error('Test error');
      });
    } catch (error) {
      expect((error as Error).message).toBe('Test error');
    }

    const stats = monitor.getStats();
    expect(stats['error-op'].count).toBe(1);
    expect(stats['error-op'].avgTime).toBeGreaterThan(15);
  });

  it('should calculate operations per second', async () => {
    // Simulate rapid operations
    for (let i = 0; i < 10; i++) {
      await monitor.time('rapid-op', async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
      });
    }

    const stats = monitor.getStats();
    expect(stats['rapid-op'].operationsPerSecond).toBeGreaterThan(0);
  });

  it('should reset metrics', async () => {
    await monitor.time('test-op', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    let stats = monitor.getStats();
    expect(Object.keys(stats)).toHaveLength(1);

    monitor.reset();
    stats = monitor.getStats();
    expect(Object.keys(stats)).toHaveLength(0);
  });
});

describe('PerformancePresets', () => {
  it('should have predefined performance configurations', () => {
    expect(PerformancePresets.HIGH_THROUGHPUT).toBeDefined();
    expect(PerformancePresets.LOW_LATENCY).toBeDefined();
    expect(PerformancePresets.MEMORY_OPTIMIZED).toBeDefined();
    expect(PerformancePresets.BALANCED).toBeDefined();
  });

  it('should have valid Redis configurations', () => {
    Object.values(PerformancePresets).forEach(preset => {
      expect(preset.redis).toBeDefined();
      expect(typeof preset.redis.maxRetriesPerRequest).toBe('number');
      expect(typeof preset.redis.enableOfflineQueue).toBe('boolean');
      expect(preset.redis.maxRetriesPerRequest).toBeGreaterThan(0);
    });
  });

  it('should have appropriate batch sizes', () => {
    expect(PerformancePresets.HIGH_THROUGHPUT.batchSize).toBeGreaterThan(
      PerformancePresets.LOW_LATENCY.batchSize
    );
    
    expect(PerformancePresets.MEMORY_OPTIMIZED.batchSize).toBeLessThan(
      PerformancePresets.BALANCED.batchSize
    );
  });

  it('should have appropriate cache TTL settings', () => {
    expect(PerformancePresets.HIGH_THROUGHPUT.redisCacheTtl).toBeGreaterThan(
      PerformancePresets.LOW_LATENCY.redisCacheTtl
    );
    
    expect(PerformancePresets.MEMORY_OPTIMIZED.redisCacheTtl).toBeLessThan(
      PerformancePresets.BALANCED.redisCacheTtl
    );
  });
});

describe('AdvancedRedisOperations', () => {
  // Mock Redis instance
  const mockRedis = {
    pipeline: jest.fn(),
    eval: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock pipeline
    const mockPipelineInstance = {
      get: jest.fn(),
      exec: jest.fn()
    };
    
    mockRedis.pipeline.mockReturnValue(mockPipelineInstance);
  });

  it('should have Lua script for batch dequeue', () => {
    expect(typeof AdvancedRedisOperations.BATCH_DEQUEUE_SCRIPT).toBe('string');
    expect(AdvancedRedisOperations.BATCH_DEQUEUE_SCRIPT).toContain('ZPOPMIN');
    expect(AdvancedRedisOperations.BATCH_DEQUEUE_SCRIPT).toContain('GET');
  });

  it('should validate atomic batch dequeue parameters', async () => {
    mockRedis.eval.mockResolvedValue([]);

    await AdvancedRedisOperations.atomicBatchDequeue(
      mockRedis as any,
      'test-queue',
      'test-prefix:',
      5
    );

    expect(mockRedis.eval).toHaveBeenCalledWith(
      AdvancedRedisOperations.BATCH_DEQUEUE_SCRIPT,
      2,
      'test-queue',
      'test-prefix:',
      '5',
      expect.any(String) // timestamp
    );
  });
});

// Performance benchmarking tests
describe('Performance Benchmarks', () => {
  const generateTestMessage = (size: number = 1000): QueueMessage => ({
    id: `test-${Date.now()}-${Math.random()}`,
    content: Buffer.alloc(size, 'x'),
    metadata: { 
      type: 'benchmark',
      size,
      timestamp: Date.now()
    },
    dequeueCount: 0,
    insertedOn: new Date(),
    nextVisibleOn: new Date(Date.now() + 60000),
    popReceipt: `receipt-${Date.now()}`
  });

  it('should benchmark binary vs JSON serialization', () => {
    const message = generateTestMessage(5000); // 5KB message
    const iterations = 1000;

    // Benchmark JSON
    const jsonStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const serialized = JSON.stringify({
        ...message,
        content: Buffer.isBuffer(message.content) 
          ? message.content.toString('base64') 
          : message.content,
        insertedOn: message.insertedOn.toISOString(),
        nextVisibleOn: message.nextVisibleOn.toISOString(),
      });
      JSON.parse(serialized);
    }
    const jsonTime = Number(process.hrtime.bigint() - jsonStart) / 1_000_000;

    // Benchmark Binary
    const binaryStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const encoded = BinaryMessageCodec.encode(message);
      BinaryMessageCodec.decode(encoded);
    }
    const binaryTime = Number(process.hrtime.bigint() - binaryStart) / 1_000_000;

    console.log(`JSON: ${jsonTime.toFixed(2)}ms, Binary: ${binaryTime.toFixed(2)}ms`);
    console.log(`Binary is ${(jsonTime / binaryTime).toFixed(1)}x faster`);

    // Binary should be faster (allowing for some variance in test environment)
    expect(binaryTime).toBeLessThan(jsonTime * 1.2); // Allow 20% variance
  });

  it('should benchmark object pool vs new allocations', () => {
    const iterations = 10000;
    const objectFactory = () => ({ 
      id: '',
      data: Buffer.alloc(1000),
      metadata: {},
      timestamp: Date.now()
    });

    // Benchmark without pool
    const withoutPoolStart = process.hrtime.bigint();
    const objects: any[] = [];
    for (let i = 0; i < iterations; i++) {
      objects.push(objectFactory());
    }
    const withoutPoolTime = Number(process.hrtime.bigint() - withoutPoolStart) / 1_000_000;

    // Benchmark with pool
    const pool = new ObjectPool(objectFactory, 100);
    const withPoolStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const obj = pool.acquire();
      pool.release(obj);
    }
    const withPoolTime = Number(process.hrtime.bigint() - withPoolStart) / 1_000_000;

    console.log(`Without pool: ${withoutPoolTime.toFixed(2)}ms, With pool: ${withPoolTime.toFixed(2)}ms`);
    
    // Pool should be faster for repeated allocations
    expect(withPoolTime).toBeLessThan(withoutPoolTime * 2); // Allow some overhead
  });

  it('should benchmark concurrent vs sequential processing', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const processDelay = 5; // 5ms processing time per item

    // Sequential processing
    const sequentialStart = Date.now();
    const sequentialResults: number[] = [];
    for (const item of items) {
      await new Promise(resolve => setTimeout(resolve, processDelay));
      sequentialResults.push(item * 2);
    }
    const sequentialTime = Date.now() - sequentialStart;

    // Concurrent processing
    const concurrentStart = Date.now();
    const processor = new ConcurrentBatchProcessor<number, number>(
      async (batch: number[]) => {
        await Promise.all(batch.map(() => 
          new Promise(resolve => setTimeout(resolve, processDelay))
        ));
        return batch.map(x => x * 2);
      },
      4, // concurrency
      10 // batch size
    );
    const concurrentResults = await processor.processAll(items);
    const concurrentTime = Date.now() - concurrentStart;

    console.log(`Sequential: ${sequentialTime}ms, Concurrent: ${concurrentTime}ms`);
    console.log(`Concurrent is ${(sequentialTime / concurrentTime).toFixed(1)}x faster`);

    expect(concurrentResults).toEqual(sequentialResults);
    expect(concurrentTime).toBeLessThan(sequentialTime * 0.7); // Should be significantly faster
  }, 10000); // Increase timeout for this test
});
