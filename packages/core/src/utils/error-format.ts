function stableStringify(value: unknown): string | undefined {
    try {
        return JSON.stringify(value, (_key, nestedValue) => {
            if (typeof nestedValue === 'bigint') {
                return nestedValue.toString();
            }
            if (nestedValue instanceof Error) {
                return {
                    name: nestedValue.name,
                    message: nestedValue.message,
                    stack: nestedValue.stack,
                };
            }
            return nestedValue;
        });
    } catch {
        return undefined;
    }
}

export function formatErrorDetails(error: unknown): string {
    if (error instanceof Error) {
        const details = stableStringify({
            name: error.name,
            message: error.message,
            ...((error as any).code !== undefined ? { code: (error as any).code } : {}),
            ...((error as any).status !== undefined ? { status: (error as any).status } : {}),
            ...((error as any).details !== undefined ? { details: (error as any).details } : {}),
            ...((error as any).reason !== undefined ? { reason: (error as any).reason } : {}),
        });
        return details && details !== '{}' ? `${error.message}; details=${details}` : error.message;
    }

    if (typeof error === 'object' && error !== null) {
        const details = stableStringify(error);
        return details && details !== '{}' ? details : Object.prototype.toString.call(error);
    }

    return String(error);
}

export function milvusOperationError(operation: string, context: Record<string, unknown>, error: unknown): Error {
    const contextDetails = stableStringify(context) || String(context);
    return new Error(`${operation} failed (${contextDetails}): ${formatErrorDetails(error)}`);
}
