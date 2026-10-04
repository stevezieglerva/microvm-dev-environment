const https = require('https');
const crypto = require('crypto');

function request(method, hostname, path) {
  return new Promise((resolve, reject) => {
    const region = process.env.AWS_REGION;
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const bodyHash = crypto.createHash('sha256').update('').digest('hex');
    const headers = {
      host: hostname, 'x-amz-date': stamp, 'x-amz-content-sha256': bodyHash,
    };
    if (process.env.AWS_SESSION_TOKEN) headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
    const keys = Object.keys(headers).sort();
    const canonical = keys.map(key => `${key}:${headers[key]}`).join('\n') + '\n';
    const signed = keys.join(';');
    const scope = `${stamp.slice(0, 8)}/${region}/lambda/aws4_request`;
    const canonicalRequest = [method, path, '', canonical, signed, bodyHash].join('\n');
    const hash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const sign = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
    const signingKey = sign(sign(sign(sign(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, stamp.slice(0, 8)), region), 'lambda'), 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope},SignedHeaders=${signed},Signature=${crypto.createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', stamp, scope, hash].join('\n')).digest('hex')}`;
    const req = https.request({ hostname, path, method, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => res.statusCode >= 400
        ? reject(Object.assign(new Error(`MicroVM API ${res.statusCode}`), { statusCode: res.statusCode }))
        : resolve(data ? JSON.parse(data) : {}));
    });
    req.on('error', reject);
    req.end();
  });
}

async function state(identifier) {
  try {
    const host = `lambda.${process.env.AWS_REGION}.amazonaws.com`;
    const result = await request('GET', host, `/2025-09-09/microvms/${encodeURIComponent(identifier)}`);
    return result.state || 'UNKNOWN';
  } catch (error) {
    if (error.statusCode === 404) return 'NOT_FOUND';
    throw error;
  }
}

module.exports = { state };
