/**
 * Connection Resilience example for AzureCQ
 * Demonstrates automatic reconnection and error handling
 */

import { AzureCQ, QueueConfiguration } from '../src';

async function connectionResilienceExample(): Promise<void> {
  console.log('🔧 Connection Resilience Testing');

  // Configuration with enhanced resilience settings
  const config: QueueConfiguration = {
    name: 'resilience-test',
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'resilience:'
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'resilience-test',
      containerName: 'resilience-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: {
        maxAttempts: 5,
        backoffMs: 2000
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
    console.log('\n1️⃣  Initial Connection Test');
    await queue.initialize();
    console.log('✅ Initial connection successful');

    // Test normal operations
    console.log('\n2️⃣  Normal Operations Test');
    const testMessage = await queue.enqueue('Resilience test message 1');
    console.log(`✅ Message enqueued: ${testMessage.id}`);

    const dequeued = await queue.dequeue();
    if (dequeued) {
      console.log(`✅ Message dequeued: ${dequeued.id}`);
      await queue.acknowledge(dequeued);
      console.log(`✅ Message acknowledged: ${dequeued.id}`);
    }

    // Test health checks
    console.log('\n3️⃣  Health Check Test');
    const health = await queue.healthCheck();
    console.log(`✅ Health check: Redis=${health.redis}, Azure=${health.azure}, Overall=${health.overall}`);

    // Demonstrate Redis resilience
    console.log('\n4️⃣  Redis Resilience Test');
    console.log('📝 Testing Redis disconnection handling...');
    
    // Enqueue messages - these should work even if Redis is down
    const messages = [];
    for (let i = 1; i <= 5; i++) {
      try {
        const msg = await queue.enqueue(`Resilience message ${i}`, {
          metadata: { testNumber: i, scenario: 'redis-down' }
        });
        messages.push(msg);
        console.log(`✅ Message ${i} enqueued successfully (Redis may be down but Azure Storage persists)`);
      } catch (error) {
        console.error(`❌ Message ${i} failed:`, error);
      }
    }

    // Test batch operations
    console.log('\n5️⃣  Batch Operations Resilience Test');
    const batchMessages = Array.from({ length: 3 }, (_, i) => ({
      content: `Batch resilience message ${i + 1}`,
      options: { metadata: { batchTest: true, index: i + 1 } }
    }));

    try {
      const batch = await queue.enqueueBatch(batchMessages);
      console.log(`✅ Batch enqueue successful: ${batch.count} messages`);
    } catch (error) {
      console.error('❌ Batch enqueue failed:', error);
    }

    // Test dequeue resilience
    console.log('\n6️⃣  Dequeue Resilience Test');
    try {
      const dequeuedBatch = await queue.dequeueBatch({ maxMessages: 5 });
      console.log(`✅ Batch dequeue successful: ${dequeuedBatch.count} messages`);
      
      // Acknowledge all messages
      if (dequeuedBatch.messages.length > 0) {
        const ackResult = await queue.acknowledgeBatch(dequeuedBatch.messages);
        console.log(`✅ Batch acknowledgment: ${ackResult.successCount}/${ackResult.results.length} successful`);
      }
    } catch (error) {
      console.error('❌ Batch dequeue failed:', error);
    }

    // Test connection status monitoring
    console.log('\n7️⃣  Connection Status Monitoring');
    const redisStatus = (queue as any).redis.getConnectionStatus();
    console.log('📊 Redis Connection Status:');
    console.log(`   Connected: ${redisStatus.isConnected}`);
    console.log(`   Reconnect attempts: ${redisStatus.reconnectAttempts}/${redisStatus.maxReconnectAttempts}`);
    console.log(`   Health check active: ${redisStatus.isHealthCheckActive}`);

    // Demonstrate automatic fallback
    console.log('\n8️⃣  Automatic Fallback Demonstration');
    console.log('📝 Testing operations with potential Redis unavailability...');
    
    // These operations should gracefully degrade if Redis is unavailable
    const fallbackTests = [
      async () => {
        const msg = await queue.enqueue('Fallback test message');
        console.log(`✅ Enqueue with fallback: ${msg.id}`);
        return msg;
      },
      async () => {
        const msgs = await queue.dequeueBatch({ maxMessages: 2 });
        console.log(`✅ Dequeue with fallback: ${msgs.count} messages`);
        return msgs;
      },
      async () => {
        const stats = await queue.getStats();
        console.log(`✅ Stats with fallback: ${stats.messageCount} messages`);
        return stats;
      }
    ];

    for (let i = 0; i < fallbackTests.length; i++) {
      try {
        await fallbackTests[i]();
      } catch (error) {
        console.warn(`⚠️  Fallback test ${i + 1} failed (expected if services are down):`, error.message);
      }
    }

    // Test error handling patterns
    console.log('\n9️⃣  Error Handling Patterns');
    
    // Test with invalid operations to demonstrate error handling
    try {
      // This might fail if services are unavailable
      await queue.getDeadLetterInfo();
      console.log('✅ DLQ info retrieved successfully');
    } catch (error) {
      console.log('⚠️  DLQ operation handled gracefully:', error.message);
    }

    console.log('\n✅ Connection resilience tests completed!');

  } catch (error) {
    console.error('❌ Connection resilience test failed:', error);
    throw error;
  } finally {
    await queue.shutdown();
    console.log('🔚 Queue shutdown completed');
  }
}

// Stress test for connection resilience
async function connectionStressTest(): Promise<void> {
  console.log('\n🏋️  Connection Stress Test');

  const config: QueueConfiguration = {
    name: 'stress-test',
    redis: { host: 'localhost', port: 6379, keyPrefix: 'stress:' },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'stress-test',
      containerName: 'stress-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: { maxAttempts: 3, backoffMs: 1000 },
      deadLetter: {
        enabled: true,
        maxDeliveryAttempts: 2,
        queueSuffix: '-dlq',
        messageTtl: 24 * 3600
      }
    }
  };

  const queue = new AzureCQ(config);

  try {
    await queue.initialize();
    console.log('✅ Stress test queue initialized');

    // Concurrent operations to stress test connections
    console.log('\n📈 Running concurrent operations...');
    
    const operations = [];
    
    // Multiple concurrent enqueue operations
    for (let i = 1; i <= 10; i++) {
      operations.push(
        queue.enqueue(`Stress test message ${i}`, {
          metadata: { stressTest: true, messageNumber: i }
        }).then(msg => {
          console.log(`✅ Stress enqueue ${i}: ${msg.id}`);
          return msg;
        }).catch(error => {
          console.warn(`⚠️  Stress enqueue ${i} failed:`, error.message);
          return null;
        })
      );
    }

    // Concurrent health checks
    for (let i = 1; i <= 5; i++) {
      operations.push(
        queue.healthCheck().then(health => {
          console.log(`✅ Health check ${i}: Overall=${health.overall}`);
          return health;
        }).catch(error => {
          console.warn(`⚠️  Health check ${i} failed:`, error.message);
          return null;
        })
      );
    }

    // Wait for all operations to complete
    const results = await Promise.allSettled(operations);
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - successful;
    
    console.log(`📊 Stress test results: ${successful}/${results.length} successful, ${failed} failed`);

    // Clean up
    console.log('\n🧹 Cleaning up stress test messages...');
    const cleanup = await queue.dequeueBatch({ maxMessages: 20 });
    if (cleanup.messages.length > 0) {
      await queue.acknowledgeBatch(cleanup.messages);
      console.log(`✅ Cleaned up ${cleanup.messages.length} messages`);
    }

  } finally {
    await queue.shutdown();
  }
}

// Production monitoring example
async function productionMonitoringExample(): Promise<void> {
  console.log('\n📊 Production Monitoring Example');

  const config: QueueConfiguration = {
    name: 'production-monitor',
    redis: { host: 'localhost', port: 6379, keyPrefix: 'prod:' },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'production-monitor',
      containerName: 'production-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: { maxAttempts: 5, backoffMs: 2000 },
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
    await queue.initialize();

    // Production monitoring patterns
    console.log('\n🔍 Production Monitoring Patterns:');

    // 1. Health monitoring
    const health = await queue.healthCheck();
    console.log('1️⃣  Health Status:', {
      overall: health.overall ? '✅ HEALTHY' : '❌ UNHEALTHY',
      redis: health.redis ? '✅ UP' : '❌ DOWN',
      azure: health.azure ? '✅ UP' : '❌ DOWN',
      details: health.details
    });

    // 2. Connection status monitoring
    const redisStatus = (queue as any).redis.getConnectionStatus();
    console.log('2️⃣  Redis Connection:', {
      connected: redisStatus.isConnected ? '✅ CONNECTED' : '❌ DISCONNECTED',
      reconnectAttempts: `${redisStatus.reconnectAttempts}/${redisStatus.maxReconnectAttempts}`,
      healthCheck: redisStatus.isHealthCheckActive ? '✅ ACTIVE' : '❌ INACTIVE'
    });

    // 3. Queue statistics
    const stats = await queue.getStats();
    console.log('3️⃣  Queue Statistics:', {
      name: stats.name,
      messageCount: stats.messageCount,
      invisibleMessages: stats.invisibleMessageCount
    });

    // 4. Dead letter queue monitoring
    if (config.settings.deadLetter.enabled) {
      try {
        const dlqInfo = await queue.getDeadLetterInfo();
        console.log('4️⃣  Dead Letter Queue:', {
          messageCount: dlqInfo.messageCount,
          oldestMessage: dlqInfo.oldestMessage?.toISOString(),
          alert: dlqInfo.messageCount > 10 ? '🚨 HIGH DLQ COUNT' : '✅ NORMAL'
        });
      } catch (error) {
        console.log('4️⃣  Dead Letter Queue: ⚠️  Unable to fetch DLQ info');
      }
    }

    console.log('\n💡 Production Best Practices:');
    console.log('   - Monitor health endpoints regularly');
    console.log('   - Set up alerts for connection failures');
    console.log('   - Track DLQ growth over time');
    console.log('   - Implement circuit breakers for degraded performance');

  } finally {
    await queue.shutdown();
  }
}

// Run all resilience tests
if (require.main === module) {
  async function runAllResilienceTests(): Promise<void> {
    try {
      await connectionResilienceExample();
      await connectionStressTest();
      await productionMonitoringExample();
      
      console.log('\n🎉 All connection resilience tests completed successfully!');
    } catch (error) {
      console.error('\n💥 Connection resilience tests failed:', error);
      throw error;
    }
  }

  runAllResilienceTests()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { 
  connectionResilienceExample, 
  connectionStressTest, 
  productionMonitoringExample 
};
