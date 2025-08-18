/**
 * Performance Improvements Demonstration for AzureCQ
 * Shows various optimization techniques and their impact
 */

import { AzureCQ, QueueConfiguration } from '../src';
import { 
  BinaryMessageCodec, 
  ConcurrentBatchProcessor, 
  PerformanceMonitor,
  PerformancePresets
} from '../src/performance-optimizations';

async function performanceComparisonExample(): Promise<void> {
  console.log('🚀 Performance Improvements Demonstration');

  // Base configuration
  const baseConfig: QueueConfiguration = {
    name: 'perf-test',
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'perf:'
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'perf-test',
      containerName: 'perf-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: { maxAttempts: 3, backoffMs: 1000 },
      deadLetter: {
        enabled: false, // Disable for pure performance testing
        maxDeliveryAttempts: 3,
        queueSuffix: '-dlq',
        messageTtl: 24 * 3600
      }
    }
  };

  console.log('\n📊 Performance Test Results:');

  // Test 1: Serialization Performance
  await testSerializationPerformance();
  
  // Test 2: Batch Operations Performance
  await testBatchOperationsPerformance(baseConfig);
  
  // Test 3: Concurrent Processing Performance
  await testConcurrentProcessingPerformance(baseConfig);
  
  // Test 4: Memory Optimization
  await testMemoryOptimization();
  
  // Test 5: Real-world Scenario Comparison
  await testRealWorldScenario(baseConfig);
}

async function testSerializationPerformance(): Promise<void> {
  console.log('\n1️⃣  Serialization Performance Test');
  
  const testMessage = {
    id: 'test-message-12345',
    content: Buffer.from('A'.repeat(1000)), // 1KB message
    metadata: { 
      type: 'performance-test',
      timestamp: Date.now(),
      source: 'test-suite',
      version: '1.0.0'
    },
    dequeueCount: 0,
    insertedOn: new Date(),
    nextVisibleOn: new Date(Date.now() + 60000),
    popReceipt: 'test-receipt-abc123'
  };

  const iterations = 10000;
  
  // Test JSON serialization
  console.log(`   Testing JSON serialization (${iterations} iterations)...`);
  const jsonStart = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const serialized = JSON.stringify({
      ...testMessage,
      content: testMessage.content.toString('base64'),
      insertedOn: testMessage.insertedOn.toISOString(),
      nextVisibleOn: testMessage.nextVisibleOn.toISOString(),
    });
    const parsed = JSON.parse(serialized);
    // Simulate reconstruction
    parsed.content = Buffer.from(parsed.content, 'base64');
    parsed.insertedOn = new Date(parsed.insertedOn);
    parsed.nextVisibleOn = new Date(parsed.nextVisibleOn);
  }
  const jsonTime = Number(process.hrtime.bigint() - jsonStart) / 1_000_000;

  // Test Binary serialization
  console.log(`   Testing Binary serialization (${iterations} iterations)...`);
  const binaryStart = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const serialized = BinaryMessageCodec.encode(testMessage as any);
    const parsed = BinaryMessageCodec.decode(serialized);
  }
  const binaryTime = Number(process.hrtime.bigint() - binaryStart) / 1_000_000;

  // Calculate sizes
  const jsonSize = JSON.stringify({
    ...testMessage,
    content: testMessage.content.toString('base64'),
    insertedOn: testMessage.insertedOn.toISOString(),
    nextVisibleOn: testMessage.nextVisibleOn.toISOString(),
  }).length;
  
  const binarySize = BinaryMessageCodec.encode(testMessage as any).length;

  console.log(`   📊 Results:`);
  console.log(`      JSON:   ${jsonTime.toFixed(2)}ms (${jsonSize} bytes)`);
  console.log(`      Binary: ${binaryTime.toFixed(2)}ms (${binarySize} bytes)`);
  console.log(`      Binary is ${(jsonTime / binaryTime).toFixed(1)}x faster`);
  console.log(`      Binary is ${((jsonSize - binarySize) / jsonSize * 100).toFixed(1)}% smaller`);
}

async function testBatchOperationsPerformance(config: QueueConfiguration): Promise<void> {
  console.log('\n2️⃣  Batch Operations Performance Test');

  const monitor = new PerformanceMonitor();
  const queue = new AzureCQ(config);

  try {
    await queue.initialize();

    const messageCount = 1000;
    const batchSize = 50;
    
    // Test 1: Individual Operations
    console.log(`   Testing ${messageCount} individual enqueue operations...`);
    const individualStart = Date.now();
    
    for (let i = 0; i < messageCount; i++) {
      await queue.enqueue(`Individual message ${i}`, {
        metadata: { type: 'individual', index: i }
      });
    }
    
    const individualTime = Date.now() - individualStart;
    const individualRate = (messageCount / individualTime * 1000).toFixed(2);

    // Test 2: Batch Operations
    console.log(`   Testing ${messageCount} messages in batches of ${batchSize}...`);
    const batchStart = Date.now();
    
    for (let i = 0; i < messageCount; i += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, messageCount - i) }, (_, j) => ({
        content: `Batch message ${i + j}`,
        options: { metadata: { type: 'batch', index: i + j } }
      }));
      
      await queue.enqueueBatch(batch);
    }
    
    const batchTime = Date.now() - batchStart;
    const batchRate = (messageCount / batchTime * 1000).toFixed(2);

    console.log(`   📊 Results:`);
    console.log(`      Individual: ${individualTime}ms (${individualRate} ops/sec)`);
    console.log(`      Batch:      ${batchTime}ms (${batchRate} ops/sec)`);
    console.log(`      Batch is ${(individualTime / batchTime).toFixed(1)}x faster`);

    // Clean up
    let cleaned = 0;
    while (true) {
      const batch = await queue.dequeueBatch({ maxMessages: 32 });
      if (batch.count === 0) break;
      await queue.acknowledgeBatch(batch.messages);
      cleaned += batch.count;
    }
    console.log(`   🧹 Cleaned up ${cleaned} messages`);

  } finally {
    await queue.shutdown();
  }
}

async function testConcurrentProcessingPerformance(config: QueueConfiguration): Promise<void> {
  console.log('\n3️⃣  Concurrent Processing Performance Test');

  const queue = new AzureCQ(config);

  try {
    await queue.initialize();

    const messageCount = 500;
    
    // Prepare test messages
    console.log(`   Preparing ${messageCount} test messages...`);
    const batchMessages = Array.from({ length: messageCount }, (_, i) => ({
      content: `Concurrent test message ${i}`,
      options: { metadata: { type: 'concurrent', index: i, size: 'medium' } }
    }));
    
    await queue.enqueueBatch(batchMessages);

    // Test 1: Sequential Processing
    console.log(`   Testing sequential processing...`);
    const sequentialStart = Date.now();
    let processedSequential = 0;
    
    while (processedSequential < messageCount) {
      const message = await queue.dequeue();
      if (message) {
        // Simulate processing
        await new Promise(resolve => setTimeout(resolve, 10)); // 10ms processing
        await queue.acknowledge(message);
        processedSequential++;
      } else {
        break;
      }
    }
    
    const sequentialTime = Date.now() - sequentialStart;

    // Re-enqueue for concurrent test
    await queue.enqueueBatch(batchMessages);

    // Test 2: Concurrent Processing
    console.log(`   Testing concurrent processing (4 workers)...`);
    const concurrentStart = Date.now();
    let processedConcurrent = 0;
    
    const processingPromises = Array.from({ length: 4 }, async () => {
      while (processedConcurrent < messageCount) {
        const batch = await queue.dequeueBatch({ maxMessages: 5 });
        if (batch.count === 0) break;
        
        // Simulate concurrent processing
        await Promise.all(batch.messages.map(async (message) => {
          await new Promise(resolve => setTimeout(resolve, 10)); // 10ms processing
          return message;
        }));
        
        await queue.acknowledgeBatch(batch.messages);
        processedConcurrent += batch.count;
      }
    });
    
    await Promise.all(processingPromises);
    const concurrentTime = Date.now() - concurrentStart;

    console.log(`   📊 Results:`);
    console.log(`      Sequential: ${sequentialTime}ms (${(messageCount / sequentialTime * 1000).toFixed(2)} ops/sec)`);
    console.log(`      Concurrent: ${concurrentTime}ms (${(messageCount / concurrentTime * 1000).toFixed(2)} ops/sec)`);
    console.log(`      Concurrent is ${(sequentialTime / concurrentTime).toFixed(1)}x faster`);

  } finally {
    await queue.shutdown();
  }
}

async function testMemoryOptimization(): Promise<void> {
  console.log('\n4️⃣  Memory Optimization Test');

  const iterations = 100000;
  
  // Test 1: Without object pooling
  console.log(`   Testing ${iterations} object creations without pooling...`);
  const beforeMem = process.memoryUsage();
  
  const withoutPoolingStart = Date.now();
  const objects: any[] = [];
  
  for (let i = 0; i < iterations; i++) {
    objects.push({
      id: `message-${i}`,
      content: Buffer.alloc(100),
      metadata: { index: i, type: 'test' },
      timestamp: new Date()
    });
  }
  
  const withoutPoolingTime = Date.now() - withoutPoolingStart;
  const afterMem = process.memoryUsage();
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
  
  const memoryUsed = (afterMem.heapUsed - beforeMem.heapUsed) / 1024 / 1024;

  console.log(`   📊 Results:`);
  console.log(`      Time: ${withoutPoolingTime}ms`);
  console.log(`      Memory used: ${memoryUsed.toFixed(2)} MB`);
  console.log(`      Objects created: ${objects.length}`);
  
  // Clear objects to free memory
  objects.length = 0;
  if (global.gc) {
    global.gc();
  }
}

async function testRealWorldScenario(config: QueueConfiguration): Promise<void> {
  console.log('\n5️⃣  Real-World Scenario Test');

  // Configure for high performance
  const highPerfConfig = {
    ...config,
    settings: {
      ...config.settings,
      batchSize: 64, // Larger batches
      redisCacheTtl: 1800 // 30 minutes
    }
  };

  const queue = new AzureCQ(highPerfConfig);

  try {
    await queue.initialize();

    const scenarios = [
      { name: 'Small Messages (1KB)', size: 1024, count: 1000 },
      { name: 'Medium Messages (10KB)', size: 10240, count: 500 },
      { name: 'Large Messages (50KB)', size: 51200, count: 100 },
    ];

    for (const scenario of scenarios) {
      console.log(`\n   Testing: ${scenario.name}`);
      
      // Generate test data
      const testData = 'x'.repeat(scenario.size);
      const messages = Array.from({ length: scenario.count }, (_, i) => ({
        content: `${testData}-${i}`,
        options: { 
          metadata: { 
            scenario: scenario.name,
            size: scenario.size,
            index: i 
          } 
        }
      }));

      // Enqueue performance
      const enqueueStart = Date.now();
      await queue.enqueueBatch(messages);
      const enqueueTime = Date.now() - enqueueStart;
      const enqueueRate = (scenario.count / enqueueTime * 1000).toFixed(2);

      // Dequeue performance
      const dequeueStart = Date.now();
      let dequeuedCount = 0;
      
      while (dequeuedCount < scenario.count) {
        const batch = await queue.dequeueBatch({ maxMessages: 20 });
        if (batch.count === 0) break;
        
        await queue.acknowledgeBatch(batch.messages);
        dequeuedCount += batch.count;
      }
      
      const dequeueTime = Date.now() - dequeueStart;
      const dequeueRate = (scenario.count / dequeueTime * 1000).toFixed(2);

      console.log(`      Enqueue: ${enqueueTime}ms (${enqueueRate} ops/sec)`);
      console.log(`      Dequeue: ${dequeueTime}ms (${dequeueRate} ops/sec)`);
      console.log(`      Total data: ${((scenario.size * scenario.count) / 1024 / 1024).toFixed(2)} MB`);
    }

    // Test mixed workload
    console.log(`\n   Testing mixed workload (concurrent enqueue/dequeue)...`);
    
    const mixedStart = Date.now();
    let enqueueCount = 0;
    let dequeueCount = 0;
    const targetOperations = 1000;

    const enqueueWorker = async () => {
      while (enqueueCount < targetOperations / 2) {
        const batch = Array.from({ length: 10 }, (_, i) => ({
          content: `Mixed workload message ${enqueueCount + i}`,
          options: { metadata: { type: 'mixed', batch: Math.floor(enqueueCount / 10) } }
        }));
        
        await queue.enqueueBatch(batch);
        enqueueCount += batch.length;
      }
    };

    const dequeueWorker = async () => {
      while (dequeueCount < targetOperations / 2) {
        const batch = await queue.dequeueBatch({ maxMessages: 8 });
        if (batch.count > 0) {
          await queue.acknowledgeBatch(batch.messages);
          dequeueCount += batch.count;
        } else {
          await new Promise(resolve => setTimeout(resolve, 10)); // Brief pause
        }
      }
    };

    await Promise.all([enqueueWorker(), dequeueWorker()]);
    const mixedTime = Date.now() - mixedStart;
    const mixedRate = (targetOperations / mixedTime * 1000).toFixed(2);

    console.log(`      Mixed workload: ${mixedTime}ms (${mixedRate} ops/sec)`);
    console.log(`      Enqueued: ${enqueueCount}, Dequeued: ${dequeueCount}`);

  } finally {
    await queue.shutdown();
  }
}

// Performance tuning recommendations
function showPerformanceTuningTips(): void {
  console.log('\n💡 Performance Tuning Recommendations:');

  console.log('\n🚀 High Throughput Optimization:');
  console.log('   • Use larger batch sizes (32-64 messages)');
  console.log('   • Enable Redis auto-pipelining');
  console.log('   • Increase Redis cache TTL');
  console.log('   • Use concurrent processing workers');
  console.log('   • Consider binary serialization for large messages');

  console.log('\n⚡ Low Latency Optimization:');
  console.log('   • Use smaller batch sizes (8-16 messages)');
  console.log('   • Reduce Redis cache TTL');
  console.log('   • Minimize processing time per message');
  console.log('   • Use dedicated Redis instance');
  console.log('   • Optimize network proximity to Azure');

  console.log('\n💾 Memory Optimization:');
  console.log('   • Use object pooling for frequent allocations');
  console.log('   • Enable compression for large messages');
  console.log('   • Implement cache cleanup routines');
  console.log('   • Monitor and tune garbage collection');
  console.log('   • Use streaming for very large datasets');

  console.log('\n🔧 Configuration Examples:');
  
  console.log('\n   High Throughput Config:');
  console.log('   ```typescript');
  console.log('   settings: {');
  console.log('     batchSize: 64,');
  console.log('     redisCacheTtl: 1800,');
  console.log('     maxInlineMessageSize: 128 * 1024, // 128KB');
  console.log('   }');
  console.log('   ```');

  console.log('\n   Low Latency Config:');
  console.log('   ```typescript');
  console.log('   settings: {');
  console.log('     batchSize: 16,');
  console.log('     redisCacheTtl: 300,');
  console.log('     maxInlineMessageSize: 32 * 1024, // 32KB');
  console.log('   }');
  console.log('   ```');

  console.log('\n📊 Monitoring Metrics:');
  console.log('   • Operations per second (enqueue/dequeue)');
  console.log('   • Average response time');
  console.log('   • Memory usage and GC pressure');
  console.log('   • Redis connection health');
  console.log('   • Azure Storage latency');
  console.log('   • Message queue depths');
}

// Performance benchmarking tool
async function runPerformanceBenchmark(): Promise<void> {
  console.log('\n🏁 Performance Benchmark Suite');
  
  try {
    console.log('Starting comprehensive performance tests...');
    
    const startTime = Date.now();
    await performanceComparisonExample();
    const totalTime = Date.now() - startTime;
    
    console.log(`\n🎯 Benchmark completed in ${totalTime}ms`);
    showPerformanceTuningTips();
    
    console.log('\n🎉 Performance testing completed successfully!');
    console.log('\n🔗 Run individual tests:');
    console.log('   npm run performance  # Full benchmark suite');
    console.log('   npm run timeout      # Timeout behavior tests');
    console.log('   npm run resilience   # Connection resilience');
    console.log('   npm run optimized    # Optimized connections');
    
  } catch (error) {
    console.error('\n💥 Performance benchmark failed:', error);
    throw error;
  }
}

if (require.main === module) {
  runPerformanceBenchmark()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { 
  performanceComparisonExample,
  testSerializationPerformance,
  testBatchOperationsPerformance,
  testConcurrentProcessingPerformance,
  testMemoryOptimization,
  testRealWorldScenario,
  showPerformanceTuningTips
};
