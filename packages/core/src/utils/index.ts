export { ConfigManager, configManager } from './config-manager';
export type { HitmuxConfig, HitmuxConfigKey, EmbeddingProviderName } from './config-manager';
export type { CodebaseIdentityMode, CodebaseIdentityOptions, CodebaseIdentity } from './path-identity';
export { normalizeCodebaseIdentityPath, resolveCodebaseIdentity } from './path-identity';
export {
    applySystemProxyPolicy,
    closeProxyDispatcher,
    createSystemProxyDispatcher,
    getSystemProxyUrl,
    restoreProxyEnvironment,
    withSystemProxyPolicy
} from './proxy-env';
export type { ProxyEnvSnapshot } from './proxy-env';
