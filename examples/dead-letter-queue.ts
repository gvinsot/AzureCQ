/**
 * Dead Letter Queue example for AzureCQ
 * Demonstrates retry logic, DLQ handling, and message recovery
 */

import { AzureCQ, QueueConfiguration, QueueMessage } from '../src';

async function deadLetterQueueExample(): Promise<void> {
  // Configuration with DLQ enabled
  const config: QueueConfiguration = {
    name: 'order-processing',
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      keyPrefix: 'dlq-example:'
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'order-processing',
      containerName: 'order-processing-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: {
        maxAttempts: 3,
        backoffMs: 1000
      },
      // Dead Letter Queue Configuration
      deadLetter: {
        enabled: true,
        maxDeliveryAttempts: 3,
        queueSuffix: '-dlq',
        messageTtl: 7 * 24 * 3600 // 7 days
      }
    }
  };

  const queue = new AzureCQ(config);
  
  try {
    await queue.initialize();
    console.log('✅ AzureCQ with DLQ initialized successfully');

    // Example 1: Automatic retry and DLQ handling
    console.log('\n🔄 Example 1: Automatic Retry and DLQ Handling');
    
    // Enqueue a test message
    const testMessage = await queue.enqueue(JSON.stringify({
      orderId: 'order-12345',
      customerId: 'customer-67890',
      amount: 99.99,
      items: ['product-1', 'product-2']
    }), {
      metadata: { 
        type: 'order-processing',
        priority: 'high',
        source: 'web-app'
      }
    });
    
    console.log(`📝 Enqueued test message: ${testMessage.id}`);

    // Simulate processing with failures using the enhanced dequeue
    for (let attempt = 1; attempt <= 5; attempt++) {
      console.log(`\n🔍 Processing attempt ${attempt}:`);
      
      const { message, processor } = await queue.dequeueWithRetry();
      
      if (!message) {
        console.log('   No messages available');
        continue;
      }

      console.log(`   📥 Dequeued message: ${message.id} (attempt ${message.dequeueCount + 1})`);

      // Simulate processing with different outcomes
      await processor(async () => {
        if (attempt <= 3) {
          // Simulate failure for first 3 attempts
          throw new Error(`Simulated processing failure on attempt ${attempt}`);
        } else {
          // Success on later attempts (if message is recovered from DLQ)
          console.log('   ✅ Processing succeeded!');
        }
      });

      // Check if message went to DLQ
      if (attempt === 3) {
        console.log('   ⚠️  Message should now be in DLQ after max attempts');
        break;
      }
    }

    // Example 2: Manual DLQ operations
    console.log('\n📋 Example 2: Manual DLQ Operations');
    
    // Check DLQ status
    const dlqInfo = await queue.getDeadLetterInfo();
    console.log(`📊 DLQ Status:`);
    console.log(`   Queue: ${dlqInfo.queueName}`);
    console.log(`   Messages: ${dlqInfo.messageCount}`);
    console.log(`   Oldest: ${dlqInfo.oldestMessage?.toISOString()}`);
    console.log(`   Newest: ${dlqInfo.newestMessage?.toISOString()}`);

    // Example 3: Manual message manipulation
    console.log('\n🔧 Example 3: Manual Message Operations');
    
    // Enqueue a message that we'll manually move to DLQ
    const manualMessage = await queue.enqueue(JSON.stringify({
      orderId: 'manual-order-999',
      status: 'problematic'
    }), {
      metadata: { type: 'manual-test' }
    });

    console.log(`📝 Enqueued manual test message: ${manualMessage.id}`);

    // Dequeue it
    const dequeuedManual = await queue.dequeue();
    if (dequeuedManual) {
      console.log(`📥 Dequeued manual message: ${dequeuedManual.id}`);

      // Manually move to DLQ
      const moveResult = await queue.moveToDeadLetter(dequeuedManual, 'Manually moved for testing');
      
      if (moveResult.success) {
        console.log(`✅ Successfully moved message to DLQ: ${moveResult.messageId}`);
        console.log(`   From: ${moveResult.sourceQueue} → To: ${moveResult.destinationQueue}`);
      } else {
        console.error(`❌ Failed to move message to DLQ: ${moveResult.error}`);
      }
    }

    // Example 4: Message recovery from DLQ
    console.log('\n🔄 Example 4: Message Recovery from DLQ');
    
    // Get updated DLQ info
    const updatedDlqInfo = await queue.getDeadLetterInfo();
    console.log(`📊 Updated DLQ Status: ${updatedDlqInfo.messageCount} messages`);

    if (updatedDlqInfo.messageCount > 0) {
      // For demo, let's recover the first message (if we had message IDs)
      // In practice, you'd have the specific message ID you want to recover
      
      console.log('💡 To recover specific messages, you would use:');
      console.log('   await queue.moveFromDeadLetter(messageId)');
      console.log('   await queue.moveFromDeadLetterBatch([messageId1, messageId2])');
    }

    // Example 5: Batch DLQ operations
    console.log('\n📦 Example 5: Batch DLQ Operations');
    
    // Create multiple failing messages
    const batchMessages = [];
    for (let i = 1; i <= 3; i++) {
      const msg = await queue.enqueue(JSON.stringify({
        batchId: `batch-${i}`,
        data: `test-data-${i}`
      }));
      batchMessages.push(msg);
    }

    console.log(`📝 Enqueued ${batchMessages.length} test messages for batch operations`);

    // Dequeue and manually move them to DLQ as a batch
    const dequeuedBatch = await queue.dequeueBatch({ maxMessages: 3 });
    
    if (dequeuedBatch.messages.length > 0) {
      const batchMoveData = dequeuedBatch.messages.map(msg => ({
        message: msg,
        reason: 'Batch moved for testing'
      }));

      const batchMoveResult = await queue.moveToDeadLetterBatch(batchMoveData);
      
      console.log(`📊 Batch move results:`);
      console.log(`   Success: ${batchMoveResult.successCount}/${batchMoveResult.results.length}`);
      console.log(`   Failures: ${batchMoveResult.failureCount}`);
      
      batchMoveResult.results.forEach((result, index) => {
        const status = result.success ? '✅' : '❌';
        console.log(`   ${status} Message ${index + 1}: ${result.messageId}`);
      });
    }

    // Example 6: Advanced retry patterns
    console.log('\n🎯 Example 6: Advanced Retry Patterns');
    
    // Create a message for advanced retry demonstration
    const advancedMessage = await queue.enqueue(JSON.stringify({
      type: 'advanced-processing',
      complexity: 'high'
    }));

    const dequeuedAdvanced = await queue.dequeue();
    if (dequeuedAdvanced) {
      console.log(`📥 Processing advanced message: ${dequeuedAdvanced.id}`);

      // Use NACK with custom options
      const nackResult = await queue.nack(dequeuedAdvanced, {
        reason: 'Temporary service unavailable',
        retryDelaySeconds: 60, // Custom retry delay
        forceDlq: false // Don't force to DLQ, allow retry
      });

      if (nackResult.success) {
        console.log(`✅ Message scheduled for retry with custom delay`);
        console.log(`   Message will be retried in 60 seconds`);
      }
    }

    // Final DLQ status
    console.log('\n📊 Final DLQ Status:');
    const finalDlqInfo = await queue.getDeadLetterInfo();
    console.log(`   Total DLQ messages: ${finalDlqInfo.messageCount}`);
    
    // Cleanup option (commented out to preserve messages for inspection)
    // console.log('\n🧹 Cleaning up DLQ (optional):');
    // const purgedCount = await queue.purgeDeadLetter();
    // console.log(`   Purged ${purgedCount} messages from DLQ`);

    console.log('\n✅ Dead Letter Queue example completed successfully!');

  } catch (error) {
    console.error('❌ DLQ example failed:', error);
    throw error;
  } finally {
    await queue.shutdown();
    console.log('🔚 Queue shutdown completed');
  }
}

// Production patterns example
async function productionDlqPatterns(): Promise<void> {
  console.log('\n🏭 Production DLQ Patterns:');

  const config: QueueConfiguration = {
    name: 'production-orders',
    redis: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379'), password: process.env.REDIS_PASSWORD },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'production-orders',
      containerName: 'production-container'
    },
    settings: {
      maxInlineMessageSize: 64 * 1024,
      redisCacheTtl: 3600,
      batchSize: 32,
      retry: { maxAttempts: 3, backoffMs: 2000 },
      deadLetter: {
        enabled: true,
        maxDeliveryAttempts: 5, // More attempts for production
        queueSuffix: '-failed',
        messageTtl: 30 * 24 * 3600 // 30 days retention
      }
    }
  };

  const queue = new AzureCQ(config);
  await queue.initialize();

  try {
    // Pattern 1: Error-specific handling
    console.log('\n1️⃣  Error-specific handling:');
    
    const message = await queue.enqueue(JSON.stringify({ type: 'payment-processing' }));
    const dequeued = await queue.dequeue();
    
    if (dequeued) {
      // Simulate different error types
      const errorType = 'PAYMENT_GATEWAY_DOWN'; // Could be 'VALIDATION_ERROR', 'TIMEOUT', etc.
      
      switch (errorType) {
        case 'PAYMENT_GATEWAY_DOWN':
          // Temporary error - retry with longer delay
          await queue.nack(dequeued, {
            reason: 'Payment gateway temporarily unavailable',
            retryDelaySeconds: 300, // 5 minutes
            forceDlq: false
          });
          break;
          
        case 'VALIDATION_ERROR':
          // Permanent error - move to DLQ immediately
          await queue.nack(dequeued, {
            reason: 'Invalid payment data - manual review required',
            forceDlq: true
          });
          break;
          
        case 'TIMEOUT':
          // Default retry behavior
          await queue.nack(dequeued, {
            reason: 'Processing timeout'
          });
          break;
      }
      
      console.log(`   Handled ${errorType} appropriately`);
    }

    // Pattern 2: Monitoring and alerting
    console.log('\n2️⃣  Monitoring and alerting:');
    
    const dlqInfo = await queue.getDeadLetterInfo();
    
    // Alert if DLQ is growing too large
    if (dlqInfo.messageCount > 100) {
      console.log(`🚨 ALERT: DLQ has ${dlqInfo.messageCount} messages - investigate immediately`);
    }
    
    // Alert if messages are too old
    if (dlqInfo.oldestMessage) {
      const ageHours = (Date.now() - dlqInfo.oldestMessage.getTime()) / (1000 * 60 * 60);
      if (ageHours > 24) {
        console.log(`🚨 ALERT: Oldest DLQ message is ${ageHours.toFixed(1)} hours old`);
      }
    }
    
    console.log(`   DLQ monitoring: ${dlqInfo.messageCount} messages, oldest: ${dlqInfo.oldestMessage?.toISOString()}`);

    // Pattern 3: Automated recovery
    console.log('\n3️⃣  Automated recovery patterns:');
    console.log('   - Schedule periodic DLQ review jobs');
    console.log('   - Implement message classification for auto-recovery');
    console.log('   - Set up dashboards for DLQ metrics');
    console.log('   - Create alerts for DLQ thresholds');

  } finally {
    await queue.shutdown();
  }
}

// Run examples
if (require.main === module) {
  async function runAllDlqExamples(): Promise<void> {
    try {
      await deadLetterQueueExample();
      await productionDlqPatterns();
      
      console.log('\n🎉 All DLQ examples completed successfully!');
    } catch (error) {
      console.error('\n💥 DLQ examples failed:', error);
      throw error;
    }
  }

  runAllDlqExamples()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { deadLetterQueueExample, productionDlqPatterns };
