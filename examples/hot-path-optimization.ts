/**
 * Hot Path Optimization Example
 * Demonstrates how AzureCQ can skip Azure Storage writes for immediately consumed messages
 */

import { AzureCQ, QueueConfiguration } from '../src';

async function hotPathExample(): Promise<void> {
  console.log('🔥 Hot Path Optimization Example');
  console.log('================================\n');

  const configs = [
    {
      name: 'without-hot-path',
      hotPathDelayMs: 0, // Disabled
      description: 'Hot path disabled (always write to Azure)'
    },
    {
      name: 'with-hot-path-conservative',
      hotPathDelayMs: 100, // 100ms delay
      description: 'Conservative hot path (100ms delay)'
    },
    {
      name: 'with-hot-path-aggressive',
      hotPathDelayMs: 25, // 25ms delay
      description: 'Aggressive hot path (25ms delay)'
    }
  ];

  for (const configOption of configs) {
    console.log(`\n📊 Testing: ${configOption.description}`);
    console.log('─'.repeat(50));

    const config: QueueConfiguration = {
      name: `hot-path-${configOption.name}`,
      azure: {
        connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || 'UseDevelopmentStorage=true',
        queueName: `hot-path-${configOption.name}`,
        containerName: `hot-path-container-${configOption.name}`
      },
      redis: {
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        performanceProfile: 'HIGH_THROUGHPUT'
      },
      settings: {
        maxInlineMessageSize: 32000,
        redisCacheTtl: 3600,
        batchSize: 32,
        hotPathDelayMs: configOption.hotPathDelayMs, // Hot path configuration
        retry: {
          maxAttempts: 3,
          backoffMs: 1000
        },
        deadLetter: {
          enabled: false,
          maxDeliveryAttempts: 3,
          queueSuffix: '-dlq',
          messageTtl: 86400
        }
      }
    };

    const azureCQ = new AzureCQ(config);

    try {
      await azureCQ.initialize();
      console.log('✅ Queue initialized');

      // Test scenario: Fast producer + consumer
      const messageCount = 100;
      const startTime = Date.now();

      // Start consumer immediately (simulates high-throughput scenario)
      const consumerPromise = (async () => {
        let consumed = 0;
        while (consumed < messageCount) {
          const batch = await azureCQ.dequeueBatch({ maxMessages: 16 });
          if (batch.messages.length > 0) {
            await azureCQ.acknowledgeBatch(batch.messages);
            consumed += batch.messages.length;
          } else {
            await new Promise(resolve => setTimeout(resolve, 10)); // Short wait
          }
        }
        return consumed;
      })();

      // Start producer
      const producerPromise = (async () => {
        const batch = [];
        for (let i = 0; i < messageCount; i++) {
          batch.push({
            content: `Hot path test message ${i}`,
            options: { metadata: { index: i, config: configOption.name } }
          });
        }
        await azureCQ.enqueueBatch(batch);
        return messageCount;
      })();

      // Wait for both to complete
      const [produced, consumed] = await Promise.all([producerPromise, consumerPromise]);
      const duration = Date.now() - startTime;

      console.log(`📈 Results:`);
      console.log(`   Messages: ${produced} produced, ${consumed} consumed`);
      console.log(`   Duration: ${duration}ms`);
      console.log(`   Throughput: ${Math.round((consumed / duration) * 1000)} msgs/sec`);
      
      // Give time for hot path logs to appear
      await new Promise(resolve => setTimeout(resolve, 200));

      await azureCQ.shutdown();

    } catch (error) {
      console.error(`❌ Error in ${configOption.name}:`, error);
      await azureCQ.shutdown();
    }
  }

  console.log('\n🎉 Hot path optimization demonstration completed!');
  console.log('\n💡 Key Benefits:');
  console.log('   🚀 Reduced Azure Storage API calls for immediately consumed messages');
  console.log('   ⚡ Lower latency for high-throughput scenarios');
  console.log('   💰 Cost savings by reducing Azure operations');
  console.log('   🔧 Configurable delay to balance performance vs durability');
}

// Run the example
if (require.main === module) {
  hotPathExample()
    .then(() => {
      console.log('Example completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Example failed:', error);
      process.exit(1);
    });
}

export { hotPathExample };
