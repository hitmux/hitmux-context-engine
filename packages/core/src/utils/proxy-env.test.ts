import assert from 'node:assert/strict';

import {
    applySystemProxyPolicy,
    closeProxyDispatcher,
    createSystemProxyDispatcher,
    getSystemProxyUrl,
    restoreProxyEnvironment,
    withSystemProxyPolicy
} from './proxy-env';

const TEST_PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'GRPC_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'grpc_proxy', 'no_proxy'] as const;

function captureTestProxyEnv(): Partial<Record<typeof TEST_PROXY_KEYS[number], string>> {
    const snapshot: Partial<Record<typeof TEST_PROXY_KEYS[number], string>> = {};
    for (const key of TEST_PROXY_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            snapshot[key] = value;
        }
    }
    return snapshot;
}

function restoreTestProxyEnv(snapshot: Partial<Record<typeof TEST_PROXY_KEYS[number], string>>): void {
    for (const key of TEST_PROXY_KEYS) {
        const value = snapshot[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function setProxyEnv(): void {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    process.env.GRPC_PROXY = 'http://127.0.0.1:7890';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    process.env.http_proxy = 'http://127.0.0.1:7890';
    process.env.https_proxy = 'http://127.0.0.1:7890';
    process.env.grpc_proxy = 'http://127.0.0.1:7890';
    process.env.no_proxy = 'localhost,127.0.0.1';
}

test('applySystemProxyPolicy clears proxy environment when disabled', () => {
    const original = captureTestProxyEnv();
    setProxyEnv();
    const previous = applySystemProxyPolicy(false);

    try {
        assert.equal(process.env.http_proxy, undefined);
        assert.equal(process.env.https_proxy, undefined);
        assert.equal(process.env.grpc_proxy, undefined);
        assert.equal(process.env.no_proxy, undefined);
    } finally {
        restoreProxyEnvironment(previous);
        restoreTestProxyEnv(original);
    }
});

test('withSystemProxyPolicy restores the previous proxy environment', async () => {
    const original = captureTestProxyEnv();
    setProxyEnv();
    const before = {
        http_proxy: process.env.http_proxy,
        https_proxy: process.env.https_proxy,
        grpc_proxy: process.env.grpc_proxy,
        no_proxy: process.env.no_proxy,
    };

    try {
        await withSystemProxyPolicy(false, async () => {
            assert.equal(process.env.http_proxy, undefined);
            assert.equal(process.env.https_proxy, undefined);
            assert.equal(process.env.grpc_proxy, undefined);
            assert.equal(process.env.no_proxy, undefined);
        });

        assert.deepEqual({
            http_proxy: process.env.http_proxy,
            https_proxy: process.env.https_proxy,
            grpc_proxy: process.env.grpc_proxy,
            no_proxy: process.env.no_proxy,
        }, before);
    } finally {
        restoreTestProxyEnv(original);
    }
});

test('createSystemProxyDispatcher uses current proxy environment for native fetch dispatch', async () => {
    const original = captureTestProxyEnv();
    setProxyEnv();

    try {
        const dispatcher = createSystemProxyDispatcher('https://openrouter.ai/api/v1/rerank', true);
        assert.ok(dispatcher);
        await closeProxyDispatcher(dispatcher);
    } finally {
        restoreTestProxyEnv(original);
    }
});

test('getSystemProxyUrl respects no_proxy bypass entries', () => {
    const original = captureTestProxyEnv();
    setProxyEnv();

    try {
        process.env.no_proxy = 'openrouter.ai';
        process.env.NO_PROXY = 'openrouter.ai';
        assert.equal(getSystemProxyUrl('https://openrouter.ai/api/v1/rerank'), undefined);
    } finally {
        restoreTestProxyEnv(original);
    }
});
