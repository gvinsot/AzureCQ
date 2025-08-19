/**
 * Performance comparison between AzureCQ and Azure Storage Queue directly
 * This example demonstrates the performance benefits of using Redis caching
 */

import { AzureCQ, QueueConfiguration } from '../src';
import { QueueServiceClient, QueueClient, StorageSharedKeyCredential } from '@azure/storage-queue';

interface PerformanceResult {
  operation: string;
  approach: 'AzureCQ' | 'Azure Direct';
  totalMessages: number;
  duration: number;
  messagesPerSecond: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  avgWriteMs?: number;
  avgReadMs?: number;
}

class AzureStorageComparison {
  private azureCQ: AzureCQ;
  private azureQueue: QueueClient;
  private queueServiceClient: QueueServiceClient;
  private readonly queueName = 'perf-comparison-queue';
  private readonly azureDirectQueueName = 'perf-direct-queue';

  constructor() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
    
    // Validate connection string
    if (!connectionString) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable is required');
    }
    
    // Parse connection string for Azure SDK initialization
    const parseConnectionString = (connStr: string) => {
      const parts = connStr.split(';');
      const parsed: any = {};
      parts.forEach(part => {
        const [key, value] = part.split('=', 2);
        if (key && value) {
          parsed[key] = value;
        }
      });
      return parsed;
    };

    const connParts = parseConnectionString(connectionString);
    
    // Initialize AzureCQ
    const config: QueueConfiguration = {
      name: this.queueName,
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        keyPrefix: 'comparison:',
        performanceProfile: 'HIGH_THROUGHPUT'
      },
      azure: {
        connectionString,
        queueName: this.queueName,
        containerName: 'perf-comparison-container'
      },
      settings: {
        maxInlineMessageSize: 64 * 1024, // 64KB
        redisCacheTtl: 3600, // 1 hour
        batchSize: 64,
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

    this.azureCQ = new AzureCQ(config);

    // Initialize Azure Storage Queue directly
    try {
      if (connParts.QueueEndpoint) {
        // Azurite case - has explicit endpoints
        console.log('🔧 Initializing Azure Storage SDK with Azurite explicit endpoint');
        const credential = new StorageSharedKeyCredential(
          connParts.AccountName || 'devstoreaccount1',
          connParts.AccountKey || 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
        );
        this.queueServiceClient = new QueueServiceClient(connParts.QueueEndpoint, credential);
      } else if (connParts.AccountName && connParts.AccountKey) {
        // Real Azure Storage case - construct URL from account name
        console.log('🔧 Initializing Azure Storage SDK with real Azure Storage');
        const credential = new StorageSharedKeyCredential(connParts.AccountName, connParts.AccountKey);
        const endpointSuffix = connParts.EndpointSuffix || 'core.windows.net';
        const protocol = connParts.DefaultEndpointsProtocol || 'https';
        const queueUrl = `${protocol}://${connParts.AccountName}.queue.${endpointSuffix}`;
        this.queueServiceClient = new QueueServiceClient(queueUrl, credential);
      } else {
        // Fallback to connection string
        console.log('🔧 Initializing Azure Storage SDK with connection string');
        this.queueServiceClient = new QueueServiceClient(connectionString);
      }
      this.azureQueue = this.queueServiceClient.getQueueClient(this.azureDirectQueueName);
      console.log('✅ Azure Storage Queue client initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Azure Storage Queue client:', error);
      console.error('🔧 Connection string parts:', connParts);
      throw error;
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async testEndToEnd(
    approach: 'AzureCQ' | 'Azure Direct',
    totalMessages: number,
    producerConcurrency: number,
    consumerConcurrency: number,
    batchSize: number = 32
  ): Promise<PerformanceResult> {
    console.log(`\n🔄 Running end-to-end (${approach}) with ${producerConcurrency} producers + ${consumerConcurrency} consumers, total ${totalMessages} messages...`);

    let enqueued = 0;
    let processed = 0;
    const startTime = Date.now();

    const reserveEnqueueChunk = (max: number) => {
      if (enqueued >= totalMessages) return 0;
      const take = Math.min(max, totalMessages - enqueued);
      enqueued += take;
      return take;
    };

    const writeSamples: number[] = [];
    const readSamples: number[] = [];

    const producerWorkers: Promise<void>[] = [];
    for (let p = 0; p < producerConcurrency; p++) {
      producerWorkers.push((async () => {
        while (true) {
          const take = reserveEnqueueChunk(batchSize);
          if (take <= 0) break;

          const writeStart = Date.now();
          if (approach === 'AzureCQ') {
            const batch: Array<{ content: string; options?: any }> = [];
            for (let i = 0; i < take; i++) {
              batch.push({ content: `e2e message ${i}` });
            }
            await this.azureCQ.enqueueBatch(batch);
          } else {
            const promises: Promise<any>[] = [];
            for (let i = 0; i < take; i++) {
              const payload = Buffer.from(JSON.stringify({ content: `e2e message ${i}` })).toString('base64');
              promises.push(this.azureQueue.sendMessage(payload));
            }
            await Promise.all(promises);
          }
          const writeEnd = Date.now();
          writeSamples.push((writeEnd - writeStart) / Math.max(1, take));
        }
      })());
    }

    const reserveProcessed = (count: number) => {
      processed += count;
    };

    const consumerWorkers: Promise<void>[] = [];
    for (let c = 0; c < consumerConcurrency; c++) {
      consumerWorkers.push((async () => {
        while (true) {
          if (processed >= totalMessages) break;

          const readStart = Date.now();
          if (approach === 'AzureCQ') {
            const result = await this.azureCQ.dequeueBatch({ maxMessages: batchSize });
            if (result.messages.length === 0) {
              if (enqueued >= totalMessages) {
                // No more messages expected
                break;
              }
              await this.sleep(60);
              continue;
            }
            await this.azureCQ.acknowledgeBatch(result.messages);
            reserveProcessed(result.messages.length);
            const readEnd = Date.now();
            readSamples.push((readEnd - readStart) / Math.max(1, result.messages.length));
          } else {
            const response = await this.azureQueue.receiveMessages({ numberOfMessages: Math.min(batchSize, 32) });
            const items = response.receivedMessageItems || [];
            if (items.length === 0) {
              if (enqueued >= totalMessages) {
                break;
              }
              await this.sleep(60);
              continue;
            }
            await Promise.all(items.map(m => this.azureQueue.deleteMessage(m.messageId, m.popReceipt)));
            reserveProcessed(items.length);
            const readEnd = Date.now();
            readSamples.push((readEnd - readStart) / Math.max(1, items.length));
          }
        }
      })());
    }

    await Promise.all([...producerWorkers, ...consumerWorkers]);

    const duration = (Date.now() - startTime) / 1000;

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      operation: 'End-to-End',
      approach,
      totalMessages,
      duration,
      messagesPerSecond: totalMessages / duration,
      avgLatency: duration * 1000,
      minLatency: duration * 1000,
      maxLatency: duration * 1000,
      avgWriteMs: avg(writeSamples),
      avgReadMs: avg(readSamples)
    };
  }

  async initialize(): Promise<void> {
    console.log('🔧 Initializing comparison environment...');
    
    // Initialize AzureCQ
    await this.azureCQ.initialize();
    console.log('✅ AzureCQ initialized');

    // Initialize Azure Storage Queue
    await this.azureQueue.createIfNotExists();
    console.log('✅ Azure Storage Queue initialized');
  }

  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up...');
    
    // Clear AzureCQ queue
    try {
      let message = await this.azureCQ.dequeue();
      while (message) {
        await this.azureCQ.acknowledge(message);
        message = await this.azureCQ.dequeue();
      }
    } catch (error) {
      // Queue might be empty
    }

    // Clear Azure Storage Queue
    try {
      await this.azureQueue.clearMessages();
    } catch (error) {
      // Queue might be empty
    }

    await this.azureCQ.shutdown();
    console.log('✅ Cleanup completed');
  }

  async testAzureCQEnqueue(messageCount: number): Promise<PerformanceResult> {
    console.log(`\n🚀 Testing AzureCQ enqueue: ${messageCount} messages`);
    
    const latencies: number[] = [];
    const startTime = Date.now();

    for (let i = 0; i < messageCount; i++) {
      const messageStart = Date.now();
      
      await this.azureCQ.enqueue(`AzureCQ test message ${i}`, {
        metadata: { 
          testType: 'azureCQ-enqueue',
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
    const duration = (endTime - startTime) / 1000;

    return {
      operation: 'Enqueue',
      approach: 'AzureCQ',
      totalMessages: messageCount,
      duration,
      messagesPerSecond: messageCount / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies)
    };
  }

  async testAzureDirectEnqueue(messageCount: number): Promise<PerformanceResult> {
    console.log(`\n🚀 Testing Azure Storage Queue direct enqueue: ${messageCount} messages`);
    
    const latencies: number[] = [];
    const startTime = Date.now();

    for (let i = 0; i < messageCount; i++) {
      const messageStart = Date.now();
      
      const messageContent = JSON.stringify({
        content: `Azure Direct test message ${i}`,
        metadata: {
          testType: 'azure-direct-enqueue',
          messageIndex: i,
          timestamp: new Date().toISOString()
        }
      });
      
      await this.azureQueue.sendMessage(Buffer.from(messageContent).toString('base64'));
      
      const messageEnd = Date.now();
      latencies.push(messageEnd - messageStart);

      if ((i + 1) % 100 === 0) {
        console.log(`   Progress: ${i + 1}/${messageCount} messages enqueued`);
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    return {
      operation: 'Enqueue',
      approach: 'Azure Direct',
      totalMessages: messageCount,
      duration,
      messagesPerSecond: messageCount / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies)
    };
  }

  async testAzureCQDequeue(messageCount: number): Promise<PerformanceResult> {
    console.log(`\n🚀 Testing AzureCQ dequeue: ${messageCount} messages`);
    
    const latencies: number[] = [];
    const startTime = Date.now();
    let processedMessages = 0;

    while (processedMessages < messageCount) {
      const messageStart = Date.now();
      
      const message = await this.azureCQ.dequeue();
      
      if (message) {
        await this.azureCQ.acknowledge(message);
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
    const duration = (endTime - startTime) / 1000;

    return {
      operation: 'Dequeue',
      approach: 'AzureCQ',
      totalMessages: processedMessages,
      duration,
      messagesPerSecond: processedMessages / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
      minLatency: latencies.length > 0 ? Math.min(...latencies) : 0,
      maxLatency: latencies.length > 0 ? Math.max(...latencies) : 0
    };
  }

  async testAzureDirectDequeue(messageCount: number): Promise<PerformanceResult> {
    console.log(`\n🚀 Testing Azure Storage Queue direct dequeue: ${messageCount} messages`);
    
    const latencies: number[] = [];
    const startTime = Date.now();
    let processedMessages = 0;

    while (processedMessages < messageCount) {
      const messageStart = Date.now();
      
      const response = await this.azureQueue.receiveMessages({ numberOfMessages: 1 });
      
      if (response.receivedMessageItems && response.receivedMessageItems.length > 0) {
        const message = response.receivedMessageItems[0];
        
        // Acknowledge the message by deleting it
        await this.azureQueue.deleteMessage(message.messageId, message.popReceipt);
        
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
    const duration = (endTime - startTime) / 1000;

    return {
      operation: 'Dequeue',
      approach: 'Azure Direct',
      totalMessages: processedMessages,
      duration,
      messagesPerSecond: processedMessages / duration,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length || 0,
      minLatency: latencies.length > 0 ? Math.min(...latencies) : 0,
      maxLatency: latencies.length > 0 ? Math.max(...latencies) : 0
    };
  }

  async testBatchOperationsComparison(messageCount: number, batchSize: number = 32): Promise<PerformanceResult[]> {
    console.log(`\n📦 Testing batch operations comparison: ${messageCount} messages in batches of ${batchSize}`);
    
    // Test AzureCQ batch enqueue
    const azureCQBatchStart = Date.now();
    const azureCQBatch: Array<{content: string; options?: any}> = [];
    
    for (let i = 0; i < messageCount; i++) {
      azureCQBatch.push({
        content: `AzureCQ batch message ${i}`,
        options: {
          metadata: {
            testType: 'azureCQ-batch',
            messageIndex: i,
            timestamp: new Date().toISOString()
          }
        }
      });
    }

    await this.azureCQ.enqueueBatch(azureCQBatch);
    const azureCQBatchEnd = Date.now();
    const azureCQBatchDuration = (azureCQBatchEnd - azureCQBatchStart) / 1000;

    // Test Azure Storage Queue batch operations (simulate with multiple single operations)
    const azureDirectBatchStart = Date.now();
    const promises: Promise<any>[] = [];
    
    for (let i = 0; i < messageCount; i++) {
      const messageContent = JSON.stringify({
        content: `Azure Direct batch message ${i}`,
        metadata: {
          testType: 'azure-direct-batch',
          messageIndex: i,
          timestamp: new Date().toISOString()
        }
      });
      
      promises.push(this.azureQueue.sendMessage(Buffer.from(messageContent).toString('base64')));
    }

    await Promise.all(promises);
    const azureDirectBatchEnd = Date.now();
    const azureDirectBatchDuration = (azureDirectBatchEnd - azureDirectBatchStart) / 1000;

    return [
      {
        operation: 'Batch Enqueue',
        approach: 'AzureCQ',
        totalMessages: messageCount,
        duration: azureCQBatchDuration,
        messagesPerSecond: messageCount / azureCQBatchDuration,
        avgLatency: azureCQBatchDuration * 1000, // Convert to ms
        minLatency: azureCQBatchDuration * 1000,
        maxLatency: azureCQBatchDuration * 1000
      },
      {
        operation: 'Batch Enqueue',
        approach: 'Azure Direct',
        totalMessages: messageCount,
        duration: azureDirectBatchDuration,
        messagesPerSecond: messageCount / azureDirectBatchDuration,
        avgLatency: azureDirectBatchDuration * 1000, // Convert to ms
        minLatency: azureDirectBatchDuration * 1000,
        maxLatency: azureDirectBatchDuration * 1000
      }
    ];
  }

  printResult(result: PerformanceResult): void {
    console.log(`\n📊 ${result.approach} - ${result.operation} Performance:`);
    console.log(`   Total Messages: ${result.totalMessages}`);
    console.log(`   Duration: ${result.duration.toFixed(2)}s`);
    console.log(`   Throughput: ${result.messagesPerSecond.toFixed(2)} msgs/sec`);
    console.log(`   Avg Latency: ${result.avgLatency.toFixed(2)}ms`);
    console.log(`   Min Latency: ${result.minLatency.toFixed(2)}ms`);
    console.log(`   Max Latency: ${result.maxLatency.toFixed(2)}ms`);
    if (typeof result.avgWriteMs === 'number') {
      console.log(`   Avg Write: ${result.avgWriteMs.toFixed(2)}ms/msg`);
    }
    if (typeof result.avgReadMs === 'number') {
      console.log(`   Avg Read: ${result.avgReadMs.toFixed(2)}ms/msg`);
    }
  }

  printComparison(azureCQResult: PerformanceResult, azureDirectResult: PerformanceResult): void {
    const speedup = azureCQResult.messagesPerSecond / azureDirectResult.messagesPerSecond;
    const latencyImprovement = azureDirectResult.avgLatency / azureCQResult.avgLatency;
    
    console.log(`\n🏆 ${azureCQResult.operation} Comparison:`);
    console.log(`   AzureCQ: ${azureCQResult.messagesPerSecond.toFixed(2)} msgs/sec`);
    console.log(`   Azure Direct: ${azureDirectResult.messagesPerSecond.toFixed(2)} msgs/sec`);
    console.log(`   🚀 AzureCQ is ${speedup.toFixed(1)}x faster`);
    console.log(`   📈 Latency improvement: ${latencyImprovement.toFixed(1)}x better`);
  }
}

async function runPerformanceComparison(): Promise<void> {
  const comparison = new AzureStorageComparison();

  try {
    await comparison.initialize();

    console.log('🏁 Starting Azure Storage Performance Comparison');
    console.log('================================================');

    const total = 1000;
    const producers = 8;
    const consumers = 8;
    const batchSize = 64;

    // End-to-end test for AzureCQ and Azure Direct
    const azureCqE2E = await comparison.testEndToEnd('AzureCQ', total, producers, consumers, batchSize);
    const azureDirectE2E = await comparison.testEndToEnd('Azure Direct', total, producers, consumers, Math.min(batchSize, 32));

    comparison.printResult(azureCqE2E);
    comparison.printResult(azureDirectE2E);
    comparison.printComparison(azureCqE2E, azureDirectE2E);

    console.log('\n💡 Key Benefits of AzureCQ:');
    console.log('===========================');
    console.log('🎯 Redis caching reduces network round-trips');
    console.log('🎯 Intelligent message routing (small messages in Redis, large in Azure)');
    console.log('🎯 Batch operations with true batching support');
    console.log('🎯 Built-in retry and dead letter queue functionality');
    console.log('🎯 Consistent API across different storage backends');

  } catch (error) {
    console.error('❌ Performance comparison failed:', error);
    throw error;
  } finally {
    await comparison.cleanup();
  }
}

// Run performance comparison
if (require.main === module) {
  runPerformanceComparison()
    .then(() => {
      console.log('\n🎉 Performance comparison completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Performance comparison failed:', error);
      process.exit(1);
    });
}

export { AzureStorageComparison, runPerformanceComparison };
