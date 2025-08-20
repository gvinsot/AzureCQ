/**
 * Performance comparison between AzureCQ and Azure Storage Queue directly
 * This example demonstrates the performance benefits of using Redis caching
 */

import { AzureCQ, QueueConfiguration } from '../src';
import { QueueServiceClient, QueueClient, StorageSharedKeyCredential } from '@azure/storage-queue';
import { BlobServiceClient } from '@azure/storage-blob';

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
  private blobServiceClient: BlobServiceClient;
  private connectionString: string;
  private readonly queueName = 'perf-comparison-v2-queue';
  private readonly azureDirectQueueName = 'perf-direct-queue';

  constructor() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
    this.connectionString = connectionString;
    
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
        containerName: 'perf-comparison-v2-container'
      },
      settings: {
        maxInlineMessageSize: 64 * 1024, // 64KB
        redisCacheTtl: 3600, // 1 hour
        batchSize: 64,
        hotPathDelayMs: 50, // 50ms hot path delay for immediate consumption detection
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
      this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
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

  private buildDirectMessageText(idx: number): string {
    const raw = `e2e message ${idx}`;
    const contentB64 = Buffer.from(raw).toString('base64');
    return JSON.stringify({ type: 'inline', content: contentB64, metadata: { idx } });
  }

  private buildCqBatch(start: number, count: number): Array<{ content: string; options?: any }> {
    const batch: Array<{ content: string; options?: any }> = [];
    for (let i = 0; i < count; i++) {
      const idx = start + i;
      batch.push({ content: `e2e message ${idx}`, options: { metadata: { idx } } });
    }
    return batch;
  }

  private extractIndexFromText(text: string): number | null {
    try {
      const parsed = JSON.parse(text);
      // For Azure Direct messages with new format
      if (parsed && parsed.metadata && typeof parsed.metadata.idx === 'number') {
        return parsed.metadata.idx;
      }
      // For Azure Direct messages with base64 content
      if (parsed && typeof parsed.content === 'string') {
        try {
          const decoded = Buffer.from(parsed.content, 'base64').toString('utf8');
          const m = decoded.match(/e2e message (\d+)/);
          if (m) return parseInt(m[1], 10);
        } catch {}
        // Also try direct pattern match on content
        const m = parsed.content.match(/e2e message (\d+)/);
        if (m) return parseInt(m[1], 10);
      }
    } catch {
      try {
        const decoded = Buffer.from(text, 'base64').toString('utf8');
        const m = decoded.match(/e2e message (\d+)/);
        if (m) return parseInt(m[1], 10);
      } catch {}
      const m = text.match(/e2e message (\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
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
    let nextIndex = 0;
    let processed = 0;
    const startTime = Date.now();

    const reserveEnqueueChunk = (max: number): { start: number; count: number } => {
      if (nextIndex >= totalMessages) return { start: -1, count: 0 };
      const start = nextIndex;
      const count = Math.min(max, totalMessages - nextIndex);
      nextIndex += count;
      enqueued = nextIndex;
      return { start, count };
    };

    const writeSamples: number[] = [];
    const readSamples: number[] = [];
    const counts = new Map<number, number>();

    const producerWorkers: Promise<void>[] = [];
    for (let p = 0; p < producerConcurrency; p++) {
      producerWorkers.push((async () => {
        while (true) {
          const { start, count: take } = reserveEnqueueChunk(batchSize);
          if (take <= 0) break;

          const writeStart = Date.now();
          if (approach === 'AzureCQ') {
            const batch = this.buildCqBatch(start, take);
            await this.azureCQ.enqueueBatch(batch);
          } else {
            const promises: Promise<any>[] = [];
            for (let i = 0; i < take; i++) {
              const text = this.buildDirectMessageText(start + i);
              promises.push(this.azureQueue.sendMessage(text));
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

            
            // Track indices for validation (prefer metadata when available)
            for (const m of result.messages) {
              const metaIdx = (m as any).metadata?.idx;
              if (typeof metaIdx === 'number') {
                counts.set(metaIdx, (counts.get(metaIdx) || 0) + 1);
                continue;
              }
              const text = m.content.toString();
              const idx = this.extractIndexFromText(text);
              if (idx !== null) counts.set(idx, (counts.get(idx) || 0) + 1);
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
            // Track indices for validation
            for (const item of items) {
              const idx = this.extractIndexFromText(item.messageText || '');
              if (idx !== null) counts.set(idx, (counts.get(idx) || 0) + 1);
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

    // Validation: exactly-once processing check
    let duplicates = 0;
    let missing = 0;
    let seen = 0;
    for (let i = 0; i < totalMessages; i++) {
      const c = counts.get(i) || 0;
      if (c === 0) missing++;
      if (c > 1) duplicates += (c - 1);
      if (c > 0) seen++;
    }
    if (missing === 0 && duplicates === 0) {
      console.log('✅ Exactly-once check passed: all messages processed once.');
    } else {
      console.warn(`⚠️ Exactly-once check failed: missing=${missing}, duplicates=${duplicates}`);
    }

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      operation: 'End-to-End',
      approach,
      totalMessages: seen,
      duration,
      messagesPerSecond: seen / duration,
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

  async resetEnvironment(): Promise<void> {
    console.log('🗑️ Resetting environment (deleting and recreating queues/containers)...');
    
    // Delete and recreate both queues and the blob container to start clean with proper waits
    const directQueue = this.queueServiceClient.getQueueClient(this.azureDirectQueueName);
    const mainQueue = this.queueServiceClient.getQueueClient(this.queueName);
    const container = this.blobServiceClient.getContainerClient('perf-comparison-container');

    try { await directQueue.delete(); } catch {}
    try { await mainQueue.delete(); } catch {}
    try { await container.delete(); } catch {}

    // Wait until deletions are fully completed (increased wait time)
    for (let i = 0; i < 200; i++) {
      const [dExists, mExists, cExists] = await Promise.all([
        directQueue.exists(),
        mainQueue.exists(),
        container.exists()
      ]);
      if (!dExists && !mExists && !cExists) break;
      await this.sleep(500); // Increased from 200ms to 500ms
    }

    // Create fresh resources
    await directQueue.create().catch(() => {});
    await mainQueue.create().catch(() => {});
    await container.create().catch(() => {});

    // Refresh client reference
    this.azureQueue = directQueue;

    // Clear Redis data to avoid stale messages from previous runs
    await this.clearRedisOnly();
    
    console.log('✅ Environment reset completed.');
  }

  async clearRedisOnly(): Promise<void> {
    if (this.azureCQ) {
      try {
        console.log('🗑️ Clearing Redis data between tests...');
        const redis = (this.azureCQ as any).redis;
        if (redis && redis.redis) {
          const keys = await redis.redis.keys('comparison:*');
          if (keys.length > 0) {
            // Delete keys in smaller batches to avoid stack overflow
            const batchSize = 100;
            for (let i = 0; i < keys.length; i += batchSize) {
              const batch = keys.slice(i, i + batchSize);
              await redis.redis.del(...batch);
            }
            console.log(`✅ Cleared ${keys.length} Redis keys`);
          }
        }
      } catch (error) {
        console.warn('⚠️ Failed to clear Redis data:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up...');
    
    await this.resetEnvironment();

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
    // Clean up before starting tests for a consistent baseline
    await comparison.resetEnvironment();
    await comparison.initialize();

    console.log('🏁 Starting Azure Storage Performance Comparison');
    console.log('================================================');

          const total = 10000;
    const producers = 8;
    const consumers = 8;
    const batchSize = 64;

    // End-to-end test for AzureCQ and Azure Direct
    const azureCqE2E = await comparison.testEndToEnd('AzureCQ', total, producers, consumers, batchSize);
    
    // Clear Redis between tests to ensure clean state
    await comparison.clearRedisOnly();
    
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
