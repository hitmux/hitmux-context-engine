const HCE_DEBUG_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function isHceDebugEnabled(
    env: NodeJS.ProcessEnv | { HCE_DEBUG?: string } = process.env,
): boolean {
    const rawValue = env.HCE_DEBUG;
    if (rawValue === undefined) {
        return false;
    }

    const normalizedValue = rawValue.trim().toLowerCase();
    return (
        normalizedValue.length > 0 &&
        !HCE_DEBUG_DISABLED_VALUES.has(normalizedValue)
    );
}

export function debugLog(...args: unknown[]): void {
    if (isHceDebugEnabled()) {
        console.log(...args);
    }
}

export function debugWarn(...args: unknown[]): void {
    if (isHceDebugEnabled()) {
        console.warn(...args);
    }
}
