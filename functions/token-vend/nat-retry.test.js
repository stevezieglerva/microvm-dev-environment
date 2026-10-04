const assert = require('assert/strict');
const { isRetryable, delayMs } = require('./nat-retry');

assert.equal(isRetryable({ retryable: true }), true);
assert.equal(isRetryable({ name: 'ThrottlingException' }), true);
assert.equal(isRetryable({ name: 'ValidationException' }), false);
assert.equal(delayMs(0), 250);
assert.equal(delayMs(6), 4000);
console.log('NAT retry policy tests passed');
