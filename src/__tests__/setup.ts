/**
 * Jest Test Setup
 * Global configuration and utilities for all tests
 */

// Increase timeout for integration tests
jest.setTimeout(30000);

// Mock console methods for cleaner test output
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeAll(() => {
  // Suppress console output during tests unless explicitly needed
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
});

afterAll(() => {
  // Restore console methods
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});

// Global test utilities
global.testUtils = {
  // Create a test message with default values
  createTestMessage: (overrides = {}) => ({
    id: 'test-message-123',
    content: Buffer.from('Test message content'),
    metadata: { type: 'test' },
    dequeueCount: 0,
    insertedOn: new Date('2023-01-01T00:00:00Z'),
    nextVisibleOn: new Date('2023-01-01T01:00:00Z'),
    popReceipt: 'test-receipt-456',
    ...overrides
  }),

  // Create test configuration with defaults
  createTestConfig: (overrides = {}) => ({
    name: 'test-queue',
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'test:'
    },
    azure: {
      connectionString: 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net',
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
    },
    ...overrides
  }),

  // Wait for a specific amount of time
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),

  // Generate random test data
  generateRandomString: (length: number = 10) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  },

  // Create large test buffer
  createLargeBuffer: (size: number = 100000) => Buffer.alloc(size, 'x'),

  // Measure execution time
  measureTime: async <T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> => {
    const start = Date.now();
    const result = await fn();
    const duration = Date.now() - start;
    return { result, duration };
  },

  // Mock implementations for common Azure/Redis operations
  createMockRedis: () => ({
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
    eval: jest.fn().mockResolvedValue([]),
    on: jest.fn(),
    off: jest.fn()
  }),

  createMockAzureQueue: () => ({
    create: jest.fn().mockResolvedValue({}),
    sendMessage: jest.fn().mockResolvedValue({
      messageId: 'mock-message-id',
      insertedOn: new Date(),
      nextVisibleOn: new Date(),
      popReceipt: 'mock-receipt'
    }),
    receiveMessages: jest.fn().mockResolvedValue({
      receivedMessageItems: []
    }),
    deleteMessage: jest.fn().mockResolvedValue({}),
    getProperties: jest.fn().mockResolvedValue({
      approximateMessagesCount: 0
    }),
    clearMessages: jest.fn().mockResolvedValue({})
  }),

  createMockBlobContainer: () => ({
    create: jest.fn().mockResolvedValue({}),
    getBlockBlobClient: jest.fn().mockReturnValue({
      upload: jest.fn().mockResolvedValue({}),
      downloadToBuffer: jest.fn().mockResolvedValue(Buffer.from('mock-blob-content')),
      delete: jest.fn().mockResolvedValue({})
    }),
    deleteBlob: jest.fn().mockResolvedValue({})
  })
};

// Extend Jest matchers for custom assertions
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },

  toBeBuffer(received: any) {
    const pass = Buffer.isBuffer(received);
    if (pass) {
      return {
        message: () => `expected ${received} not to be a Buffer`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be a Buffer`,
        pass: false,
      };
    }
  },

  toHaveBeenCalledWithBuffer(received: jest.Mock, expected: Buffer) {
    const calls = received.mock.calls;
    const pass = calls.some((call: any[]) => 
      call.some((arg: any) => Buffer.isBuffer(arg) && arg.equals(expected))
    );
    
    if (pass) {
      return {
        message: () => `expected mock not to have been called with buffer`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected mock to have been called with buffer`,
        pass: false,
      };
    }
  }
});

// Performance testing utilities
global.perfUtils = {
  // Benchmark a function
  benchmark: async (name: string, fn: () => Promise<void>, iterations: number = 100) => {
    const times: number[] = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = process.hrtime.bigint();
      await fn();
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1_000_000); // Convert to milliseconds
    }
    
    const total = times.reduce((sum, time) => sum + time, 0);
    const average = total / iterations;
    const min = Math.min(...times);
    const max = Math.max(...times);
    
    return {
      name,
      iterations,
      total: total.toFixed(2),
      average: average.toFixed(2),
      min: min.toFixed(2),
      max: max.toFixed(2),
      opsPerSecond: (1000 / average).toFixed(2)
    };
  },

  // Memory usage tracking
  trackMemory: () => {
    const usage = process.memoryUsage();
    return {
      heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(2), // MB
      heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(2), // MB
      external: (usage.external / 1024 / 1024).toFixed(2), // MB
      rss: (usage.rss / 1024 / 1024).toFixed(2) // MB
    };
  }
};

// Type declarations for global utilities
declare global {
  var testUtils: {
    createTestMessage: (overrides?: any) => any;
    createTestConfig: (overrides?: any) => any;
    wait: (ms: number) => Promise<void>;
    generateRandomString: (length?: number) => string;
    createLargeBuffer: (size?: number) => Buffer;
    measureTime: <T>(fn: () => Promise<T>) => Promise<{ result: T; duration: number }>;
    createMockRedis: () => any;
    createMockAzureQueue: () => any;
    createMockBlobContainer: () => any;
  };

  var perfUtils: {
    benchmark: (name: string, fn: () => Promise<void>, iterations?: number) => Promise<any>;
    trackMemory: () => any;
  };

  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(floor: number, ceiling: number): R;
      toBeBuffer(): R;
      toHaveBeenCalledWithBuffer(expected: Buffer): R;
    }
  }
}

export {};
