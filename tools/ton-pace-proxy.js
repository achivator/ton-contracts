// Serializing pacing proxy for testnet.toncenter.com (keyless ~1 rps).
// Blueprint talks to 127.0.0.1:8787 and requests are spaced >= 1400ms apart.
const http = require('http');
const https = require('https');

const MIN = 1400;
let last = 0;
let chain = Promise.resolve();

function upstream(body) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'testnet.toncenter.com',
                path: '/api/v2/jsonRPC',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            },
        );
        req.on('error', reject);
        req.end(body);
    });
}

function paced(body) {
    chain = chain.then(async () => {
        const wait = Math.max(0, last + MIN - Date.now());
        if (wait) await new Promise((r) => setTimeout(r, wait));
        for (let i = 0; i < 4; i++) {
            last = Date.now();
            const res = await upstream(body);
            if (res.status !== 429) return res;
            await new Promise((r) => setTimeout(r, 1500));
        }
        return { status: 429, body: JSON.stringify({ ok: false, error: 'rate limited' }) };
    });
    return chain;
}

http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
        try {
            const out = await paced(body);
            res.writeHead(out.status, { 'content-type': 'application/json' });
            res.end(out.body);
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
    });
}).listen(8787, '127.0.0.1', () => console.log('pacing proxy on 127.0.0.1:8787'));
