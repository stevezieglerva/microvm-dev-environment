const retryableNames = new Set([
  'ThrottlingException', 'TooManyRequestsException',
  'ServiceException', 'ResourceConflictException',
]);

function isRetryable(error) {
  return error.retryable === true || retryableNames.has(error.name);
}

function delayMs(attempt) {
  return Math.min(4000, 250 * (2 ** attempt));
}

module.exports = { isRetryable, delayMs };
