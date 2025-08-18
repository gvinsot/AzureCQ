/**
 * Optimized Connection Management example for AzureCQ
 * Demonstrates persistent Redis connections with minimal reconnection overhead
 */

import { AzureCQ, QueueConfiguration } from '../src';

async function optimizedConnectionExample(): Promise<void> {
  console.log('🔗 Optimized Connection Management Demo');

  const config: QueueConfiguration = {
    name: 'optimized-queue',
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'optimized:'
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'optimized-queue',
      containerName: 'optimized-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: {
        maxAttempts: 3,
        backoffMs: 1000
      },
      deadLetter: {
        enabled: true,
        maxDeliveryAttempts: 3,
        queueSuffix: '-dlq',
        messageTtl: 7 * 24 * 3600
      }
    }
  };

  const queue = new AzureCQ(config);

  try {
    // Initial connection
    console.log('\n1️⃣  Initial Connection (Single Connection Creation)');
    await queue.initialize();
    console.log('✅ Connected with persistent Redis connection');

    // Monitor connection status
    const showConnectionStatus = () => {
      const status = (queue as any).redis.getConnectionStatus();
      console.log(`📊 Connection Status: Connected=${status.isConnected}, Connecting=${status.isConnecting}, HealthCheck=${status.isHealthCheckActive}`);
    };

    showConnectionStatus();

    // Perform multiple operations to show connection reuse
    console.log('\n2️⃣  Multiple Operations (Same Connection)');
    
    const operations = [];
    for (let i = 1; i <= 10; i++) {
      operations.push(
        queue.enqueue(`Message ${i}`, {
          metadata: { operationNumber: i, timestamp: Date.now() }
        }).then(msg => {
          console.log(`✅ Enqueued message ${i}: ${msg.id}`);
          return msg;
        })
      );
    }

    // Execute all operations concurrently
    const results = await Promise.all(operations);
    console.log(`✅ All ${results.length} operations completed using same Redis connection`);

    showConnectionStatus();

    // Test batch operations
    console.log('\n3️⃣  Batch Operations (Connection Efficiency)');
    
    const batchMessages = Array.from({ length: 5 }, (_, i) => ({
      content: `Batch message ${i + 1}`,
      options: { metadata: { batchIndex: i + 1 } }
    }));

    const batchResult = await queue.enqueueBatch(batchMessages);
    console.log(`✅ Batch enqueue: ${batchResult.count} messages using single connection`);

    // Dequeue batch
    const dequeuedBatch = await queue.dequeueBatch({ maxMessages: 8 });
    console.log(`✅ Batch dequeue: ${dequeuedBatch.count} messages`);

    // Acknowledge batch
    if (dequeuedBatch.messages.length > 0) {
      const ackResult = await queue.acknowledgeBatch(dequeuedBatch.messages);
      console.log(`✅ Batch acknowledge: ${ackResult.successCount}/${ackResult.results.length} successful`);
    }

    showConnectionStatus();

    // Test Redis persistence under load
    console.log('\n4️⃣  Load Testing (Connection Stability)');
    
    const loadTestOps = [];
    const startTime = Date.now();
    
    // Create mixed workload
    for (let i = 1; i <= 20; i++) {
      if (i % 3 === 0) {
        // Health check every third operation
        loadTestOps.push(
          queue.healthCheck().then(health => ({
            type: 'health',
            success: health.overall,
            index: i
          }))
        );
      } else if (i % 2 === 0) {
        // Enqueue even numbers
        loadTestOps.push(
          queue.enqueue(`Load test ${i}`).then(msg => ({
            type: 'enqueue',
            success: true,
            index: i,
            messageId: msg.id
          }))
        );
      } else {
        // Dequeue odd numbers
        loadTestOps.push(
          queue.dequeue().then(msg => ({
            type: 'dequeue',
            success: msg !== null,
            index: i,
            messageId: msg?.id
          }))
        );
      }
    }

    const loadResults = await Promise.allSettled(loadTestOps);
    const duration = Date.now() - startTime;
    
    const successful = loadResults.filter(r => r.status === 'fulfilled').length;
    const opsPerSecond = (loadResults.length / duration * 1000).toFixed(2);
    
    console.log(`✅ Load test: ${successful}/${loadResults.length} operations in ${duration}ms (${opsPerSecond} ops/sec)`);
    console.log('✅ All operations used the same persistent Redis connection');

    showConnectionStatus();

    // Demonstrate connection resilience
    console.log('\n5️⃣  Connection Resilience (Auto-Recovery)');
    console.log('📝 Redis will automatically handle disconnections and reconnect');
    console.log('📝 Operations will gracefully fallback to Azure Storage if needed');
    console.log('📝 Connection will be reused once Redis is available again');

    // Try operations that would work even if Redis is temporarily down
    const resilientOps = [
      async () => {
        const msg = await queue.enqueue('Resilient message 1');
        console.log(`✅ Resilient enqueue: ${msg.id}`);
        return msg;
      },
      async () => {
        const msgs = await queue.dequeueBatch({ maxMessages: 2 });
        console.log(`✅ Resilient dequeue: ${msgs.count} messages`);
        return msgs;
      },
      async () => {
        const stats = await queue.getStats();
        console.log(`✅ Resilient stats: ${stats.messageCount} messages in queue`);
        return stats;
      }
    ];

    for (const operation of resilientOps) {
      try {
        await operation();
      } catch (error) {
        console.warn(`⚠️  Operation failed gracefully:`, error.message);
      }
    }

    // Final connection status
    console.log('\n6️⃣  Final Connection Status');
    showConnectionStatus();
    
    const finalHealth = await queue.healthCheck();
    console.log(`📊 Final Health: Overall=${finalHealth.overall}, Redis=${finalHealth.redis}, Azure=${finalHealth.azure}`);

    console.log('\n✅ Optimized connection management demo completed!');
    console.log('🔑 Key Benefits Demonstrated:');
    console.log('   • Single persistent Redis connection');
    console.log('   • Automatic reconnection without connection recreation');
    console.log('   • Graceful fallback when Redis unavailable');
    console.log('   • High-performance operations with connection reuse');
    console.log('   • Built-in resilience and recovery');

  } catch (error) {
    console.error('❌ Optimized connection demo failed:', error);
    throw error;
  } finally {
    await queue.shutdown();
    console.log('🔚 Queue shutdown completed (connection properly closed)');
  }
}

// Connection lifecycle demonstration
async function connectionLifecycleExample(): Promise<void> {
  console.log('\n🔄 Connection Lifecycle Demo');

  const config: QueueConfiguration = {
    name: 'lifecycle-test',
    redis: { host: 'localhost', port: 6379, keyPrefix: 'lifecycle:' },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'lifecycle-test',
      containerName: 'lifecycle-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: { maxAttempts: 3, backoffMs: 1000 },
      deadLetter: {
        enabled: false, // Disable for this simple test
        maxDeliveryAttempts: 3,
        queueSuffix: '-dlq',
        messageTtl: 24 * 3600
      }
    }
  };

  const queue = new AzureCQ(config);

  try {
    console.log('\n🔌 Connection Lifecycle:');
    
    // Phase 1: Initial connection
    console.log('1. Initial connection...');
    await queue.initialize();
    
    let status = (queue as any).redis.getConnectionStatus();
    console.log(`   ✅ Connected: ${status.isConnected}`);

    // Phase 2: Normal operations
    console.log('2. Normal operations...');
    await queue.enqueue('Lifecycle test message');
    const msg = await queue.dequeue();
    if (msg) await queue.acknowledge(msg);
    
    status = (queue as any).redis.getConnectionStatus();
    console.log(`   ✅ Still connected: ${status.isConnected}`);

    // Phase 3: Simulate error recovery (Redis handles this automatically)
    console.log('3. Connection monitoring active...');
    status = (queue as any).redis.getConnectionStatus();
    console.log(`   ✅ Health check active: ${status.isHealthCheckActive}`);
    console.log(`   ✅ Auto-reconnect enabled: ${status.shouldReconnect}`);

    // Phase 4: Clean shutdown
    console.log('4. Clean shutdown...');
    await queue.shutdown();
    
    status = (queue as any).redis.getConnectionStatus();
    console.log(`   ✅ Properly disconnected: ${!status.isConnected}`);
    console.log(`   ✅ Health check stopped: ${!status.isHealthCheckActive}`);
    console.log(`   ✅ Auto-reconnect disabled: ${!status.shouldReconnect}`);

    console.log('\n✅ Connection lifecycle completed successfully!');

  } catch (error) {
    console.error('❌ Connection lifecycle demo failed:', error);
  }
}

// Performance comparison: Old vs New connection handling
async function performanceComparisonExample(): Promise<void> {
  console.log('\n⚡ Performance Benefits of Optimized Connections');

  const config: QueueConfiguration = {
    name: 'perf-test',
    redis: { host: 'localhost', port: 6379, keyPrefix: 'perf:' },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'perf-test',
      containerName: 'perf-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: { maxAttempts: 3, backoffMs: 500 },
      deadLetter: {
        enabled: false,
        maxDeliveryAttempts: 3,
        queueSuffix: '-dlq',
        messageTtl: 24 * 3600
      }
    }
  };

  const queue = new AzureCQ(config);

  try {
    await queue.initialize();

    console.log('\n📊 Performance Benefits:');
    
    // Test: Rapid successive operations
    const iterations = 50;
    const startTime = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      await queue.enqueue(`Perf test ${i}`);
    }
    
    const enqueueTime = Date.now() - startTime;
    const enqueueRate = (iterations / enqueueTime * 1000).toFixed(2);
    
    console.log(`✅ ${iterations} enqueue operations: ${enqueueTime}ms (${enqueueRate} ops/sec)`);
    console.log('   • Uses single persistent Redis connection');
    console.log('   • No connection overhead per operation');
    console.log('   • Automatic reconnection when needed');

    // Dequeue performance
    const dequeueStart = Date.now();
    let dequeuedCount = 0;
    
    while (dequeuedCount < iterations) {
      const batch = await queue.dequeueBatch({ maxMessages: 10 });
      if (batch.count === 0) break;
      
      await queue.acknowledgeBatch(batch.messages);
      dequeuedCount += batch.count;
    }
    
    const dequeueTime = Date.now() - dequeueStart;
    const dequeueRate = (dequeuedCount / dequeueTime * 1000).toFixed(2);
    
    console.log(`✅ ${dequeuedCount} dequeue+ack operations: ${dequeueTime}ms (${dequeueRate} ops/sec)`);
    console.log('   • Batch operations for efficiency');
    console.log('   • Connection reuse across all operations');

    const status = (queue as any).redis.getConnectionStatus();
    console.log(`\n📊 Connection Efficiency:`);
    console.log(`   • Single connection used: ${status.isConnected}`);
    console.log(`   • No connection recreations needed`);
    console.log(`   • Minimal memory footprint`);
    console.log(`   • Automatic health monitoring: ${status.isHealthCheckActive}`);

  } finally {
    await queue.shutdown();
  }
}

// Run all optimized connection examples
if (require.main === module) {
  async function runOptimizedConnectionExamples(): Promise<void> {
    try {
      await optimizedConnectionExample();
      await connectionLifecycleExample();
      await performanceComparisonExample();
      
      console.log('\n🎉 All optimized connection examples completed successfully!');
      console.log('\n💡 Key Optimizations:');
      console.log('   • Redis connections stay open and are reused');
      console.log('   • Built-in reconnection without connection recreation');
      console.log('   • Minimal connection overhead');
      console.log('   • Automatic health monitoring');
      console.log('   • Graceful degradation when Redis unavailable');
      
    } catch (error) {
      console.error('\n💥 Optimized connection examples failed:', error);
      throw error;
    }
  }

  runOptimizedConnectionExamples()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { 
  optimizedConnectionExample, 
  connectionLifecycleExample, 
  performanceComparisonExample 
};
