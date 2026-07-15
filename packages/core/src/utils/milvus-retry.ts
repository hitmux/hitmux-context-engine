const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 10_000;

export interface MilvusRetryOptions {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
    onRetry?: (input: {
        operation: string;
        attempt: number;
        maxAttempts: number;
        delayMs: number;
        error: unknown;
    }) => void;
}

function getErrorDetails(error: unknown): { message: string; code?: unknown } {
    if (error && typeof error === 'object') {
        const record = error as { message?: unknown; details?: unknown; code?: unknown };
        return {
            message: [record.message, record.details]
                .filter((value): value is string => typeof value === 'string')
                .join(' '),
            code: record.code,
        };
    }

    return { message: String(error) };
}

/**
 * Only retry failures that mean the request never had a usable transport.
 * Timeouts are deliberately excluded: their write outcome is ambiguous and
 * callers must switch to idempotent upsert semantics before replaying them.
 */
export function isRetryableMilvusConnectionError(error: unknown): boolean {
    const { message, code } = getErrorDetails(error);
    if (code === 14 || code === '14' || code === 'UNAVAILABLE') {
        return true;
    }

    return /\b(?:UNAVAILABLE|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)\b|no connection established|connection (?:is )?(?:closed|reset)|transport (?:is )?(?:closing|closed)/i
        .test(message);
}

export async function withMilvusConnectionRetry<T>(
    operation: string,
    run: (attempt: number) => Promise<T>,
    options: MilvusRetryOptions = {},
): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    const initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS));
    const maxDelayMs = Math.max(initialDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
    const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    let delayMs = initialDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await run(attempt);
        } catch (error) {
            if (attempt === maxAttempts || !isRetryableMilvusConnectionError(error)) {
                throw error;
            }

            options.onRetry?.({
                operation,
                attempt,
                maxAttempts,
                delayMs,
                error,
            });
            await sleep(delayMs);
            delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * 2));
        }
    }

    throw new Error(`Milvus retry exhausted for ${operation}`);
}
