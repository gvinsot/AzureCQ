/**
 * Message Acknowledgment Timeout example for AzureCQ
 * Demonstrates what happens when messages are not acknowledged within the visibility timeout
 */

import { AzureCQ, QueueConfiguration } from '../src';

async function acknowledgmentTimeoutExample(): Promise<void> {
  console.log('⏰ Message Acknowledgment Timeout Demo');

  const config: QueueConfiguration = {
    name: 'timeout-test',
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      keyPrefix: 'timeout:'
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'timeout-test',
      containerName: 'timeout-container'
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
    await queue.initialize();
    console.log('✅ Queue initialized');

    // Example 1: Normal Acknowledgment Timeout Behavior
    console.log('\n1️⃣  Basic Visibility Timeout Behavior');
    
    // Enqueue a test message
    const testMessage = await queue.enqueue('Timeout test message', {
      metadata: { scenario: 'visibility-timeout' }
    });
    console.log(`📝 Enqueued message: ${testMessage.id}`);

    // Dequeue with a short visibility timeout
    const shortTimeoutSeconds = 10; // 10 seconds
    console.log(`📥 Dequeuing with ${shortTimeoutSeconds}s visibility timeout...`);
    
    const dequeuedMessage = await queue.dequeue({ 
      visibilityTimeout: shortTimeoutSeconds 
    });

    if (dequeuedMessage) {
      console.log(`✅ Dequeued message: ${dequeuedMessage.id}`);
      console.log(`📊 Message details:`);
      console.log(`   - Dequeue count: ${dequeuedMessage.dequeueCount}`);
      console.log(`   - Next visible: ${dequeuedMessage.nextVisibleOn.toISOString()}`);
      console.log(`   - Pop receipt: ${dequeuedMessage.popReceipt?.substring(0, 20)}...`);

      console.log(`\n⏳ Waiting ${shortTimeoutSeconds + 2} seconds without acknowledging...`);
      console.log('   (Message will become visible again automatically)');
      
      // Wait longer than the visibility timeout
      await new Promise(resolve => setTimeout(resolve, (shortTimeoutSeconds + 2) * 1000));
      
      console.log(`✅ Timeout period elapsed - message should be visible again`);

      // Try to dequeue again - should get the same message with incremented dequeue count
      const retriedMessage = await queue.dequeue();
      
      if (retriedMessage) {
        console.log(`📥 Re-dequeued message: ${retriedMessage.id}`);
        console.log(`📊 Updated message details:`);
        console.log(`   - Dequeue count: ${retriedMessage.dequeueCount} (should be ${dequeuedMessage.dequeueCount + 1})`);
        console.log(`   - Next visible: ${retriedMessage.nextVisibleOn.toISOString()}`);
        console.log(`   - New pop receipt: ${retriedMessage.popReceipt?.substring(0, 20)}...`);
        
        // Clean up - acknowledge the retried message
        await queue.acknowledge(retriedMessage);
        console.log('✅ Acknowledged message after retry');
      } else {
        console.log('ℹ️  No message available (may still be processing in Azure Storage)');
      }
    }

    // Example 2: Visibility Timeout with Processing Simulation
    console.log('\n2️⃣  Processing Time vs Visibility Timeout');
    
    const processingMessage = await queue.enqueue('Long processing message', {
      metadata: { scenario: 'long-processing' }
    });
    console.log(`📝 Enqueued processing message: ${processingMessage.id}`);

    // Dequeue with a timeout shorter than our "processing" time
    const processingTimeout = 5; // 5 seconds timeout
    const actualProcessingTime = 8; // But we'll "process" for 8 seconds
    
    const processingDequeued = await queue.dequeue({ 
      visibilityTimeout: processingTimeout 
    });

    if (processingDequeued) {
      console.log(`📥 Dequeued for processing: ${processingDequeued.id}`);
      console.log(`⏰ Visibility timeout: ${processingTimeout}s, Processing time: ${actualProcessingTime}s`);
      
      console.log('🔄 Starting simulated processing...');
      const startTime = Date.now();
      
      // Simulate long processing
      await new Promise(resolve => setTimeout(resolve, actualProcessingTime * 1000));
      
      const endTime = Date.now();
      console.log(`⏱️  Processing completed in ${Math.round((endTime - startTime) / 1000)}s`);
      
      // Try to acknowledge - this might fail because visibility timeout expired
      try {
        const ackResult = await queue.acknowledge(processingDequeued);
        if (ackResult.success) {
          console.log('✅ Successfully acknowledged (pop receipt still valid)');
        } else {
          console.log('❌ Acknowledgment failed:', ackResult.error);
          console.log('   This happens when the visibility timeout has expired');
        }
      } catch (error) {
        console.log('❌ Acknowledgment threw error:', error.message);
        console.log('   Message visibility timeout expired during processing');
      }
    }

    // Example 3: Proper Timeout Handling with Enhanced Dequeue
    console.log('\n3️⃣  Proper Timeout Handling Pattern');
    
    const properMessage = await queue.enqueue('Properly handled message', {
      metadata: { scenario: 'proper-handling' }
    });
    console.log(`📝 Enqueued properly handled message: ${properMessage.id}`);

    // Use enhanced dequeue with automatic retry/timeout handling
    const { message, processor } = await queue.dequeueWithRetry({ 
      visibilityTimeout: 30 // Give enough time for processing
    });

    if (message) {
      console.log(`📥 Dequeued with enhanced handler: ${message.id}`);
      console.log(`⏰ Using 30s visibility timeout for safe processing`);
      
      await processor(async () => {
        console.log('🔄 Processing message with proper timeout handling...');
        
        // Simulate processing that fits within visibility timeout
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('✅ Processing completed within timeout window');
        // Automatic acknowledgment happens in the processor
      });
    }

    // Example 4: Multiple Timeout Scenarios
    console.log('\n4️⃣  Multiple Timeout Scenarios');
    
    const scenarios = [
      { name: 'Very Short Timeout', timeout: 1, processing: 3 },
      { name: 'Adequate Timeout', timeout: 10, processing: 5 },
      { name: 'Long Timeout', timeout: 60, processing: 2 }
    ];

    for (const scenario of scenarios) {
      console.log(`\n📋 Testing: ${scenario.name}`);
      
      const scenarioMessage = await queue.enqueue(`Message for ${scenario.name}`, {
        metadata: { 
          scenario: scenario.name.toLowerCase().replace(/\s+/g, '-'),
          timeout: scenario.timeout,
          processingTime: scenario.processing
        }
      });

      const dequeued = await queue.dequeue({ 
        visibilityTimeout: scenario.timeout 
      });

      if (dequeued) {
        console.log(`   📥 Dequeued: ${dequeued.id} (timeout: ${scenario.timeout}s)`);
        
        // Simulate processing
        console.log(`   🔄 Processing for ${scenario.processing}s...`);
        await new Promise(resolve => setTimeout(resolve, scenario.processing * 1000));
        
        // Try to acknowledge
        try {
          const ackResult = await queue.acknowledge(dequeued);
          console.log(`   ${ackResult.success ? '✅' : '❌'} Acknowledgment: ${ackResult.success ? 'Success' : ackResult.error}`);
        } catch (error) {
          console.log(`   ❌ Acknowledgment failed: ${error.message}`);
        }
      }
    }

    // Example 5: Monitoring Unacknowledged Messages
    console.log('\n5️⃣  Monitoring Unacknowledged Messages');
    
    // Create some unacknowledged messages
    const unackedMessages: import('../src').QueueMessage[] = [];
    for (let i = 1; i <= 3; i++) {
      const msg = await queue.enqueue(`Unacknowledged message ${i}`, {
        metadata: { monitoring: true, number: i }
      });
      unackedMessages.push(msg);
    }

    console.log(`📝 Created ${unackedMessages.length} messages for monitoring`);

    // Dequeue them with short timeouts and don't acknowledge
    const shortTimeout = 3;
    const dequeuedUnacked: import('../src').QueueMessage[] = [];
    
    for (let i = 0; i < unackedMessages.length; i++) {
      const msg = await queue.dequeue({ visibilityTimeout: shortTimeout });
      if (msg) {
        dequeuedUnacked.push(msg);
        console.log(`   📥 Dequeued ${msg.id} with ${shortTimeout}s timeout (not acknowledging)`);
      }
    }

    console.log(`⏳ Waiting ${shortTimeout + 2}s for timeouts to expire...`);
    await new Promise(resolve => setTimeout(resolve, (shortTimeout + 2) * 1000));

    // Check queue stats to see messages are visible again
    const stats = await queue.getStats();
    console.log(`📊 Queue stats after timeout:`);
    console.log(`   - Total messages: ${stats.messageCount}`);
    console.log(`   - Invisible messages: ${stats.invisibleMessageCount}`);
    console.log('   Messages should be visible again due to timeout expiry');

    // Clean up - dequeue and acknowledge all remaining messages
    console.log('\n🧹 Cleaning up remaining messages...');
    let cleanupCount = 0;
    while (true) {
      const batch = await queue.dequeueBatch({ maxMessages: 10 });
      if (batch.count === 0) break;
      
      await queue.acknowledgeBatch(batch.messages);
      cleanupCount += batch.count;
    }
    console.log(`✅ Cleaned up ${cleanupCount} messages`);

    console.log('\n✅ Acknowledgment timeout demo completed!');

  } catch (error) {
    console.error('❌ Acknowledgment timeout demo failed:', error);
    throw error;
  } finally {
    await queue.shutdown();
    console.log('🔚 Queue shutdown completed');
  }
}

// Best practices example
async function timeoutBestPracticesExample(): Promise<void> {
  console.log('\n💡 Acknowledgment Timeout Best Practices');

  const config: QueueConfiguration = {
    name: 'best-practices',
    redis: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379'), password: process.env.REDIS_PASSWORD, keyPrefix: 'best:' },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      queueName: 'best-practices',
      containerName: 'best-practices-container'
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
        messageTtl: 7 * 24 * 3600
      }
    }
  };

  const queue = new AzureCQ(config);

  try {
    await queue.initialize();

    console.log('\n🎯 Best Practice Patterns:');

    // Best Practice 1: Appropriate Visibility Timeout
    console.log('\n1️⃣  Set Appropriate Visibility Timeouts');
    
    const taskMessage = await queue.enqueue('Task requiring 30s processing', {
      metadata: { estimatedProcessingTime: 30 }
    });

    // Rule: Visibility timeout should be 2-3x your expected processing time
    const expectedProcessingTime = 30;
    const safeVisibilityTimeout = expectedProcessingTime * 2; // 60 seconds
    
    console.log(`📝 Task estimated time: ${expectedProcessingTime}s`);
    console.log(`⏰ Safe visibility timeout: ${safeVisibilityTimeout}s (2x processing time)`);

    const taskDequeued = await queue.dequeue({ 
      visibilityTimeout: safeVisibilityTimeout 
    });

    if (taskDequeued) {
      // Simulate proper processing within timeout
      await new Promise(resolve => setTimeout(resolve, 2000)); // Quick simulation
      await queue.acknowledge(taskDequeued);
      console.log('✅ Message processed and acknowledged within safe timeout');
    }

    // Best Practice 2: Heartbeat Pattern for Long Processing
    console.log('\n2️⃣  Heartbeat Pattern for Long-Running Tasks');
    console.log('💡 For very long tasks, implement periodic lease renewal:');
    console.log('   - Use shorter visibility timeouts (e.g., 5-10 minutes)');
    console.log('   - Periodically extend the lease during processing');
    console.log('   - Azure Storage Queues support updateMessage for lease extension');

    // Best Practice 3: Error Handling
    console.log('\n3️⃣  Robust Error Handling');
    
    const errorTestMessage = await queue.enqueue('Message with error handling', {
      metadata: { shouldFail: true }
    });

    const { message: errorMessage, processor } = await queue.dequeueWithRetry({
      visibilityTimeout: 30
    });

    if (errorMessage) {
      await processor(async () => {
        console.log('🔄 Processing with error handling...');
        
        // Simulate processing that might fail
        const shouldFail = errorMessage.metadata?.shouldFail;
        if (shouldFail) {
          throw new Error('Simulated processing error');
        }
        
        console.log('✅ Processing succeeded');
      });
      
      console.log('✅ Error handled automatically (retry or DLQ)');
    }

    // Best Practice 4: Monitoring and Alerting
    console.log('\n4️⃣  Monitoring and Alerting Setup');
    
    const dlqInfo = await queue.getDeadLetterInfo();
    console.log(`📊 Monitoring metrics:`);
    console.log(`   - DLQ message count: ${dlqInfo.messageCount}`);
    
    if (dlqInfo.messageCount > 0) {
      console.log('🚨 Alert: Messages in DLQ require investigation');
    }

    const queueStats = await queue.getStats();
    console.log(`   - Total queue messages: ${queueStats.messageCount}`);
    console.log(`   - Invisible messages: ${queueStats.invisibleMessageCount}`);
    
    // Alert on high invisible message count (may indicate processing issues)
    const invisibleRatio = queueStats.invisibleMessageCount / (queueStats.messageCount || 1);
    if (invisibleRatio > 0.5) {
      console.log('⚠️  Warning: High invisible message ratio - check processing times');
    }

    console.log('\n💡 Key Takeaways:');
    console.log('   ✅ Set visibility timeout to 2-3x expected processing time');
    console.log('   ✅ Use dequeueWithRetry() for automatic error handling');
    console.log('   ✅ Monitor DLQ and invisible message counts');
    console.log('   ✅ Implement heartbeat pattern for very long tasks');
    console.log('   ✅ Always handle acknowledgment failures gracefully');

  } finally {
    await queue.shutdown();
  }
}

// Configuration examples
function showTimeoutConfigurationExamples(): void {
  console.log('\n⚙️  Timeout Configuration Examples');

  console.log('\n🚀 High-Throughput Short Tasks:');
  console.log('```typescript');
  console.log('const message = await queue.dequeue({');
  console.log('  visibilityTimeout: 30  // 30 seconds for quick processing');
  console.log('});');
  console.log('```');

  console.log('\n📊 Data Processing Tasks:');
  console.log('```typescript');
  console.log('const message = await queue.dequeue({');
  console.log('  visibilityTimeout: 300  // 5 minutes for data processing');
  console.log('});');
  console.log('```');

  console.log('\n🔄 Long-Running Background Jobs:');
  console.log('```typescript');
  console.log('const message = await queue.dequeue({');
  console.log('  visibilityTimeout: 1800  // 30 minutes for background jobs');
  console.log('});');
  console.log('```');

  console.log('\n⚡ Batch Processing:');
  console.log('```typescript');
  console.log('const batch = await queue.dequeueBatch({');
  console.log('  maxMessages: 10,');
  console.log('  visibilityTimeout: 600  // 10 minutes for batch processing');
  console.log('});');
  console.log('```');
}

// Run all timeout examples
if (require.main === module) {
  async function runAllTimeoutExamples(): Promise<void> {
    try {
      await acknowledgmentTimeoutExample();
      await timeoutBestPracticesExample();
      showTimeoutConfigurationExamples();
      
      console.log('\n🎉 All acknowledgment timeout examples completed!');
    } catch (error) {
      console.error('\n💥 Acknowledgment timeout examples failed:', error);
      throw error;
    }
  }

  runAllTimeoutExamples()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { 
  acknowledgmentTimeoutExample, 
  timeoutBestPracticesExample,
  showTimeoutConfigurationExamples
};
