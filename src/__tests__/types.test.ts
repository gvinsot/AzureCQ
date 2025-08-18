/**
 * Tests for core types and interfaces
 */

import { AzureCQError, ErrorCodes } from '../types';

describe('AzureCQError', () => {
  it('should create error with message and code', () => {
    const error = new AzureCQError('Test error', ErrorCodes.QUEUE_NOT_FOUND);
    
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AzureCQError);
    expect(error.message).toBe('Test error');
    expect(error.code).toBe(ErrorCodes.QUEUE_NOT_FOUND);
    expect(error.name).toBe('AzureCQError');
    expect(error.cause).toBeUndefined();
  });

  it('should create error with cause', () => {
    const cause = new Error('Original error');
    const error = new AzureCQError('Wrapped error', ErrorCodes.REDIS_CONNECTION_ERROR, cause);
    
    expect(error.cause).toBe(cause);
  });

  it('should have all required error codes', () => {
    expect(ErrorCodes.QUEUE_NOT_FOUND).toBe('QUEUE_NOT_FOUND');
    expect(ErrorCodes.MESSAGE_NOT_FOUND).toBe('MESSAGE_NOT_FOUND');
    expect(ErrorCodes.INVALID_POP_RECEIPT).toBe('INVALID_POP_RECEIPT');
    expect(ErrorCodes.MESSAGE_TOO_LARGE).toBe('MESSAGE_TOO_LARGE');
    expect(ErrorCodes.REDIS_CONNECTION_ERROR).toBe('REDIS_CONNECTION_ERROR');
    expect(ErrorCodes.AZURE_STORAGE_ERROR).toBe('AZURE_STORAGE_ERROR');
    expect(ErrorCodes.ACKNOWLEDGMENT_FAILED).toBe('ACKNOWLEDGMENT_FAILED');
    expect(ErrorCodes.BATCH_OPERATION_FAILED).toBe('BATCH_OPERATION_FAILED');
  });
});



