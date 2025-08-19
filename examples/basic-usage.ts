/**
 * Basic usage example for AzureCQ
 */

import { AzureCQ, QueueConfiguration } from '../src';

async function basicExample(): Promise<void> {
  // Configuration
  const config: QueueConfiguration = {
    name: 'example-queue',
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      keyPrefix: 'example:'
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'example-queue',
      containerName: 'example-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024, // 64KB
      redisCacheTtl: 3600, // 1 hour
      batchSize: 32,
      retry: {
        maxAttempts: 3,
        backoffMs: 1000
      },
      deadLetter: {
        enabled: true,
        maxDeliveryAttempts: 3,
        queueSuffix: '-dlq',
        messageTtl: 7 * 24 * 3600 // 7 days
      }
    }
  };

  // Initialize queue
  const queue = new AzureCQ(config);
  
  try {
    await queue.initialize();
    console.log('✅ AzureCQ initialized successfully');

    // Single message operations
    console.log('\n📝 Single Message Operations:');
    
    // Enqueue a message
    const message = await queue.enqueue('Hello, AzureCQ!', {
      metadata: { 
        timestamp: new Date().toISOString(),
        source: 'basic-example'
      },
      visibilityTimeout: 30
    });
    console.log(`✅ Enqueued message: ${message.id}`);

    // Dequeue the message
    const received = await queue.dequeue();
    if (received) {
      console.log(`✅ Dequeued message: ${received.id}`);
      console.log(`📄 Content: ${received.content.toString()}`);
      console.log(`📊 Metadata:`, received.metadata);

      // Acknowledge the message
      const ackResult = await queue.acknowledge(received);
      if (ackResult.success) {
        console.log(`✅ Acknowledged message: ${received.id}`);
      } else {
        console.error(`❌ Failed to acknowledge: ${ackResult.error}`);
      }
    }

    // Batch operations
    console.log('\n📦 Batch Operations:');
    
    // Enqueue multiple messages
    const batchMessages = [
      { content: 'Batch message 1', options: { metadata: { priority: 'high' } } },
      { content: 'Batch message 2', options: { metadata: { priority: 'medium' } } },
      { content: 'Batch message 3', options: { metadata: { priority: 'low' } } },
      { content: JSON.stringify({ data: 'structured data' }), options: { metadata: { type: 'json' } } },
      { content: Buffer.from('Binary data'), options: { metadata: { type: 'binary' } } }
    ];

    const batch = await queue.enqueueBatch(batchMessages);
    console.log(`✅ Enqueued batch: ${batch.count} messages (Batch ID: ${batch.batchId})`);

    // Dequeue multiple messages
    const receivedBatch = await queue.dequeueBatch({ maxMessages: 5 });
    console.log(`✅ Dequeued batch: ${receivedBatch.count} messages`);

    // Process and acknowledge messages
    const processedMessages = [];
    for (const msg of receivedBatch.messages) {
      console.log(`📄 Processing message ${msg.id}: ${msg.content.toString().substring(0, 50)}...`);
      
      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 100));
      
      processedMessages.push(msg);
    }

    // Acknowledge all processed messages
    const batchAck = await queue.acknowledgeBatch(processedMessages);
    console.log(`✅ Batch acknowledgment: ${batchAck.successCount}/${batchAck.results.length} successful`);

    // Large message handling
    console.log('\n📄 Large Message Handling:');
    
    const largeMessage = Buffer.alloc(100 * 1024, 'A'); // 100KB of 'A's
    const largeMessageQueued = await queue.enqueue(largeMessage, {
      metadata: { type: 'large-file', size: largeMessage.length }
    });
    console.log(`✅ Enqueued large message: ${largeMessageQueued.id} (${largeMessage.length} bytes)`);

    const receivedLarge = await queue.dequeue();
    if (receivedLarge) {
      console.log(`✅ Dequeued large message: ${receivedLarge.id} (${receivedLarge.content.length} bytes)`);
      
      // Verify content integrity
      const isContentValid = receivedLarge.content.equals(largeMessage);
      console.log(`✅ Content integrity: ${isContentValid ? 'VALID' : 'INVALID'}`);

      await queue.acknowledge(receivedLarge);
      console.log(`✅ Acknowledged large message: ${receivedLarge.id}`);
    }

    // Queue statistics
    console.log('\n📊 Queue Statistics:');
    const stats = await queue.getStats();
    console.log(`📊 Queue: ${stats.name}`);
    console.log(`📊 Message count: ${stats.messageCount}`);
    console.log(`📊 Invisible messages: ${stats.invisibleMessageCount}`);

    // Health check
    console.log('\n🏥 Health Check:');
    const health = await queue.healthCheck();
    console.log(`🏥 Overall health: ${health.overall ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);
    console.log(`🏥 Redis: ${health.redis ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);
    console.log(`🏥 Azure: ${health.azure ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);
    if (health.details) {
      console.log(`🏥 Details: ${health.details}`);
    }

  } catch (error) {
    console.error('❌ Error during example execution:', error);
  } finally {
    // Clean shutdown
    await queue.shutdown();
    console.log('\n🔚 AzureCQ shutdown completed');
  }
}

// Run the example
if (require.main === module) {
  basicExample()
    .then(() => {
      console.log('\n🎉 Basic example completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Basic example failed:', error);
      process.exit(1);
    });
}

export { basicExample };



