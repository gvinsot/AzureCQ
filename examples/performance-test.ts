/**
 * Performance testing example for AzureCQ
 */

import { AzureCQ, QueueConfiguration } from '../src';

interface PerformanceMetrics {
  operation: string;
  totalMessages: number;
  duration: number;
  messagesPerSecond: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
}

class PerformanceTester {
  private queue: AzureCQ;
  private config: QueueConfiguration;

  constructor() {
    this.config = {
      name: 'performance-test-queue',
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        keyPrefix: 'perf-test:'
      },
      azure: {
        connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
        queueName: 'performance-test-queue',
        containerName: 'performance-test-container'
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

    this.queue = new AzureCQ(this.config);
  }

  async initialize(): Promise<void> {
    await this.queue.initialize();
    console.log('✅ Performance test queue initialized');
  }

  async shutdown(): Promise<void> {
    await this.queue.shutdown();
    console.log('✅ Performance test queue shutdown');
  }

  async testSingleEnqueue(messageCount: number): Promise<PerformanceMetrics> {
    console.log(`\n🚀 Testing single enqueue: ${messageCount} messages`);
    
    const latencies: number[] = [];
    const startTime = Date.now();

    for (let i = 0; i < messageCount; i++) {
      const messageStart = Date.now();
      
      await this.queue.enqueue(`Performance test message ${i}`, {
        metadata: { 
          testRun: 'single-enqueue',
          messageIndex: i,
          timestamp: new Date().toISOString()
        }
      });
      
      const messageEnd = Date.now();
      latencies.push(messageEnd - messageStart);

      if ((i + 1) % 100 === 0) {
        console.log(`   Progress: ${i + 1}/${messageCount} messages enqueued`);
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // seconds

    return {
      operation: 'Single Enqueue',
      totalMessages: messageCount,
      duration,
      messagesPerSecond: messageCount / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies)
    };
  }

  async testBatchEnqueue(messageCount: number, batchSize: number = 32): Promise<PerformanceMetrics> {
    console.log(`\n🚀 Testing batch enqueue: ${messageCount} messages in batches of ${batchSize}`);
    
    const latencies: number[] = [];
    const startTime = Date.now();
    let processedMessages = 0;

    for (let i = 0; i < messageCount; i += batchSize) {
      const currentBatchSize = Math.min(batchSize, messageCount - i);
      const batch: Array<{content: string; options?: any}> = [];

      for (let j = 0; j < currentBatchSize; j++) {
        batch.push({
          content: `Batch performance test message ${i + j}`,
          options: {
            metadata: {
              testRun: 'batch-enqueue',
              messageIndex: i + j,
              batchIndex: Math.floor(i / batchSize),
              timestamp: new Date().toISOString()
            }
          }
        });
      }

      const batchStart = Date.now();
      await this.queue.enqueueBatch(batch);
      const batchEnd = Date.now();
      
      latencies.push(batchEnd - batchStart);
      processedMessages += currentBatchSize;

      if (processedMessages % (batchSize * 10) === 0) {
        console.log(`   Progress: ${processedMessages}/${messageCount} messages enqueued`);
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // seconds

    return {
      operation: 'Batch Enqueue',
      totalMessages: messageCount,
      duration,
      messagesPerSecond: messageCount / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies)
    };
  }

  async testSingleDequeue(messageCount: number): Promise<PerformanceMetrics> {
    console.log(`\n🚀 Testing single dequeue: ${messageCount} messages`);
    
    const latencies: number[] = [];
    const startTime = Date.now();
    let processedMessages = 0;

    while (processedMessages < messageCount) {
      const messageStart = Date.now();
      
      const message = await this.queue.dequeue();
      
      if (message) {
        await this.queue.acknowledge(message);
        const messageEnd = Date.now();
        latencies.push(messageEnd - messageStart);
        processedMessages++;

        if (processedMessages % 100 === 0) {
          console.log(`   Progress: ${processedMessages}/${messageCount} messages dequeued`);
        }
      } else {
        // No more messages available
        break;
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // seconds

    return {
      operation: 'Single Dequeue',
      totalMessages: processedMessages,
      duration,
      messagesPerSecond: processedMessages / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
      minLatency: latencies.length > 0 ? Math.min(...latencies) : 0,
      maxLatency: latencies.length > 0 ? Math.max(...latencies) : 0
    };
  }

  async testBatchDequeue(messageCount: number, batchSize: number = 32): Promise<PerformanceMetrics> {
    console.log(`\n🚀 Testing batch dequeue: ${messageCount} messages in batches of ${batchSize}`);
    
    const latencies: number[] = [];
    const startTime = Date.now();
    let processedMessages = 0;

    while (processedMessages < messageCount) {
      const batchStart = Date.now();
      
      const batch = await this.queue.dequeueBatch({ maxMessages: batchSize });
      
      if (batch.messages.length > 0) {
        await this.queue.acknowledgeBatch(batch.messages);
        const batchEnd = Date.now();
        
        latencies.push(batchEnd - batchStart);
        processedMessages += batch.messages.length;

        if (processedMessages % (batchSize * 10) === 0) {
          console.log(`   Progress: ${processedMessages}/${messageCount} messages dequeued`);
        }
      } else {
        // No more messages available
        break;
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // seconds

    return {
      operation: 'Batch Dequeue',
      totalMessages: processedMessages,
      duration,
      messagesPerSecond: processedMessages / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
      minLatency: latencies.length > 0 ? Math.min(...latencies) : 0,
      maxLatency: latencies.length > 0 ? Math.max(...latencies) : 0
    };
  }

  async testLargeMessages(messageCount: number): Promise<PerformanceMetrics> {
    console.log(`\n🚀 Testing large messages: ${messageCount} messages (100KB each)`);
    
    const latencies: number[] = [];
    const startTime = Date.now();
    const largeContent = Buffer.alloc(100 * 1024, 'X'); // 100KB buffer

    // Enqueue large messages
    for (let i = 0; i < messageCount; i++) {
      const messageStart = Date.now();
      
      await this.queue.enqueue(largeContent, {
        metadata: { 
          testRun: 'large-messages',
          messageIndex: i,
          size: largeContent.length
        }
      });
      
      const messageEnd = Date.now();
      latencies.push(messageEnd - messageStart);

      console.log(`   Enqueued large message ${i + 1}/${messageCount}`);
    }

    // Dequeue and acknowledge large messages
    for (let i = 0; i < messageCount; i++) {
      const messageStart = Date.now();
      
      const message = await this.queue.dequeue();
      if (message) {
        await this.queue.acknowledge(message);
        const messageEnd = Date.now();
        latencies.push(messageEnd - messageStart);

        console.log(`   Processed large message ${i + 1}/${messageCount} (${message.content.length} bytes)`);
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // seconds

    return {
      operation: 'Large Messages',
      totalMessages: messageCount,
      duration,
      messagesPerSecond: messageCount / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies)
    };
  }

  printMetrics(metrics: PerformanceMetrics): void {
    console.log(`\n📊 ${metrics.operation} Performance Metrics:`);
    console.log(`   Total Messages: ${metrics.totalMessages}`);
    console.log(`   Duration: ${metrics.duration.toFixed(2)}s`);
    console.log(`   Throughput: ${metrics.messagesPerSecond.toFixed(2)} msgs/sec`);
    console.log(`   Avg Latency: ${metrics.avgLatency.toFixed(2)}ms`);
    console.log(`   Min Latency: ${metrics.minLatency.toFixed(2)}ms`);
    console.log(`   Max Latency: ${metrics.maxLatency.toFixed(2)}ms`);
  }
}

async function runPerformanceTests(): Promise<void> {
  const tester = new PerformanceTester();

  try {
    await tester.initialize();

    console.log('🏁 Starting AzureCQ Performance Tests');
    console.log('=====================================');

    // Test configuration
    const testMessageCount = 500; // Adjust based on your needs
    const batchSize = 32;

    // Test 1: Single message enqueue
    const singleEnqueueMetrics = await tester.testSingleEnqueue(testMessageCount);
    tester.printMetrics(singleEnqueueMetrics);

    // Test 2: Single message dequeue
    const singleDequeueMetrics = await tester.testSingleDequeue(testMessageCount);
    tester.printMetrics(singleDequeueMetrics);

    // Test 3: Batch enqueue
    const batchEnqueueMetrics = await tester.testBatchEnqueue(testMessageCount, batchSize);
    tester.printMetrics(batchEnqueueMetrics);

    // Test 4: Batch dequeue
    const batchDequeueMetrics = await tester.testBatchDequeue(testMessageCount, batchSize);
    tester.printMetrics(batchDequeueMetrics);

    // Test 5: Large messages (fewer messages due to size)
    const largeMessageMetrics = await tester.testLargeMessages(10);
    tester.printMetrics(largeMessageMetrics);

    // Summary comparison
    console.log('\n📈 Performance Summary Comparison:');
    console.log('=====================================');
    const allMetrics = [
      singleEnqueueMetrics,
      singleDequeueMetrics,
      batchEnqueueMetrics,
      batchDequeueMetrics,
      largeMessageMetrics
    ];

    allMetrics.forEach(metric => {
      console.log(`${metric.operation.padEnd(20)}: ${metric.messagesPerSecond.toFixed(2).padStart(8)} msgs/sec`);
    });

    // Performance insights
    console.log('\n💡 Performance Insights:');
    console.log('========================');
    
    const batchEnqueueSpeedup = batchEnqueueMetrics.messagesPerSecond / singleEnqueueMetrics.messagesPerSecond;
    const batchDequeueSpeedup = batchDequeueMetrics.messagesPerSecond / singleDequeueMetrics.messagesPerSecond;
    
    console.log(`🚀 Batch enqueue is ${batchEnqueueSpeedup.toFixed(1)}x faster than single enqueue`);
    console.log(`🚀 Batch dequeue is ${batchDequeueSpeedup.toFixed(1)}x faster than single dequeue`);
    console.log(`📦 Large message overhead: ${(largeMessageMetrics.avgLatency / singleEnqueueMetrics.avgLatency).toFixed(1)}x latency`);

  } catch (error) {
    console.error('❌ Performance test failed:', error);
    throw error;
  } finally {
    await tester.shutdown();
  }
}

// Run performance tests
if (require.main === module) {
  runPerformanceTests()
    .then(() => {
      console.log('\n🎉 Performance tests completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Performance tests failed:', error);
      process.exit(1);
    });
}

export { PerformanceTester, runPerformanceTests };



