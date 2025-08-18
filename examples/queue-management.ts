/**
 * Queue management example for AzureCQ
 */

import { QueueManager } from '../src';

async function queueManagementExample(): Promise<void> {
  // Initialize queue manager
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable is required');
  }

  const manager = new QueueManager(connectionString);

  try {
    console.log('🔧 Queue Management Operations:');

    // List existing queues
    console.log('\n📋 Listing existing queues...');
    const existingQueues = await manager.listQueues();
    console.log(`📋 Found ${existingQueues.length} existing queues:`);
    existingQueues.forEach((queue, index) => {
      console.log(`   ${index + 1}. ${queue}`);
    });

    // Create new queues
    console.log('\n➕ Creating new queues...');
    const newQueues = [
      'test-queue-1',
      'test-queue-2',
      'high-priority-queue',
      'low-priority-queue',
      'dead-letter-queue'
    ];

    for (const queueName of newQueues) {
      try {
        await manager.createQueue(queueName);
        console.log(`✅ Created queue: ${queueName}`);
      } catch (error) {
        console.log(`⚠️  Queue ${queueName} might already exist or creation failed`);
      }
    }

    // List queues again to see the new ones
    console.log('\n📋 Listing queues after creation...');
    const updatedQueues = await manager.listQueues();
    console.log(`📋 Total queues: ${updatedQueues.length}`);
    updatedQueues.forEach((queue, index) => {
      const isNew = newQueues.includes(queue);
      console.log(`   ${index + 1}. ${queue} ${isNew ? '🆕' : ''}`);
    });

    // Delete test queues (cleanup)
    console.log('\n🗑️  Cleaning up test queues...');
    const queuesToDelete = newQueues.filter(q => q.startsWith('test-queue-'));
    
    for (const queueName of queuesToDelete) {
      try {
        await manager.deleteQueue(queueName);
        console.log(`✅ Deleted queue: ${queueName}`);
      } catch (error) {
        console.log(`⚠️  Failed to delete queue ${queueName}:`, error);
      }
    }

    // Final queue list
    console.log('\n📋 Final queue list after cleanup...');
    const finalQueues = await manager.listQueues();
    console.log(`📋 Remaining queues: ${finalQueues.length}`);
    finalQueues.forEach((queue, index) => {
      console.log(`   ${index + 1}. ${queue}`);
    });

    console.log('\n✅ Queue management operations completed successfully!');

  } catch (error) {
    console.error('❌ Error during queue management operations:', error);
    throw error;
  }
}

// Example of queue lifecycle management
async function queueLifecycleExample(): Promise<void> {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable is required');
  }

  const manager = new QueueManager(connectionString);

  try {
    console.log('\n🔄 Queue Lifecycle Management Example:');

    const queueName = `lifecycle-demo-${Date.now()}`;
    
    // Step 1: Create queue
    console.log(`\n1️⃣  Creating queue: ${queueName}`);
    await manager.createQueue(queueName);
    console.log(`✅ Queue created: ${queueName}`);

    // Step 2: Verify queue exists
    console.log('\n2️⃣  Verifying queue exists...');
    const queues = await manager.listQueues();
    const queueExists = queues.includes(queueName);
    console.log(`✅ Queue exists: ${queueExists}`);

    // Step 3: Simulate queue usage (in a real scenario, you'd use AzureCQ here)
    console.log('\n3️⃣  Queue is ready for use...');
    console.log(`   - You can now create an AzureCQ instance with queueName: "${queueName}"`);
    console.log(`   - Messages can be enqueued and dequeued`);
    console.log(`   - Queue will persist messages until acknowledged`);

    // Step 4: Queue cleanup (delete)
    console.log('\n4️⃣  Cleaning up queue...');
    await manager.deleteQueue(queueName);
    console.log(`✅ Queue deleted: ${queueName}`);

    // Step 5: Verify queue is gone
    console.log('\n5️⃣  Verifying queue is deleted...');
    const remainingQueues = await manager.listQueues();
    const queueStillExists = remainingQueues.includes(queueName);
    console.log(`✅ Queue deleted: ${!queueStillExists}`);

    console.log('\n🎉 Queue lifecycle completed successfully!');

  } catch (error) {
    console.error('❌ Error during queue lifecycle management:', error);
    throw error;
  }
}

// Advanced queue management patterns
async function advancedQueuePatternsExample(): Promise<void> {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable is required');
  }

  const manager = new QueueManager(connectionString);

  try {
    console.log('\n🏗️  Advanced Queue Management Patterns:');

    // Pattern 1: Queue naming conventions
    console.log('\n1️⃣  Implementing queue naming conventions...');
    const environments = ['dev', 'staging', 'prod'];
    const services = ['user-service', 'order-service', 'notification-service'];
    const queueTypes = ['commands', 'events', 'deadletter'];

    const conventionQueues: string[] = [];
    
    for (const env of environments.slice(0, 1)) { // Only dev for demo
      for (const service of services.slice(0, 2)) { // Only first 2 services for demo
        for (const type of queueTypes) {
          const queueName = `${env}-${service}-${type}`;
          conventionQueues.push(queueName);
          
          try {
            await manager.createQueue(queueName);
            console.log(`✅ Created: ${queueName}`);
          } catch (error) {
            console.log(`⚠️  Skipped: ${queueName} (might exist)`);
          }
        }
      }
    }

    // Pattern 2: Queue organization by prefix
    console.log('\n2️⃣  Organizing queues by prefix...');
    const allQueues = await manager.listQueues();
    
    const queuesByPrefix: Record<string, string[]> = {};
    for (const queue of allQueues) {
      const prefix = queue.split('-')[0];
      if (!queuesByPrefix[prefix]) {
        queuesByPrefix[prefix] = [];
      }
      queuesByPrefix[prefix].push(queue);
    }

    console.log('📊 Queue organization by prefix:');
    for (const [prefix, queues] of Object.entries(queuesByPrefix)) {
      console.log(`   ${prefix}: ${queues.length} queues`);
      queues.slice(0, 3).forEach(q => console.log(`     - ${q}`));
      if (queues.length > 3) {
        console.log(`     ... and ${queues.length - 3} more`);
      }
    }

    // Pattern 3: Cleanup by pattern
    console.log('\n3️⃣  Cleaning up demo queues...');
    const demoQueues = allQueues.filter(q => 
      q.includes('dev-') || q.startsWith('lifecycle-') || q.startsWith('test-')
    );

    for (const queue of demoQueues.slice(0, 5)) { // Limit cleanup for safety
      try {
        await manager.deleteQueue(queue);
        console.log(`✅ Cleaned up: ${queue}`);
      } catch (error) {
        console.log(`⚠️  Failed to cleanup: ${queue}`);
      }
    }

    console.log('\n🎯 Advanced queue patterns demonstrated successfully!');

  } catch (error) {
    console.error('❌ Error during advanced queue patterns:', error);
    throw error;
  }
}

// Run examples
if (require.main === module) {
  async function runAllExamples(): Promise<void> {
    try {
      await queueManagementExample();
      await queueLifecycleExample();
      await advancedQueuePatternsExample();
      
      console.log('\n🎉 All queue management examples completed successfully!');
    } catch (error) {
      console.error('\n💥 Queue management examples failed:', error);
      throw error;
    }
  }

  runAllExamples()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { 
  queueManagementExample, 
  queueLifecycleExample, 
  advancedQueuePatternsExample 
};



