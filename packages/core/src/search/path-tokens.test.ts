import { extractPathTokens } from './path-tokens';

describe('path token extraction', () => {
    it('keeps compound basenames and adds structural CamelCase tokens', () => {
        expect(extractPathTokens('src/CMakeLists.txt')).toEqual([
            'src',
            'CMakeLists',
            'CMake',
            'Lists',
            'txt',
        ]);
        expect(extractPathTokens('relay/relayAdaptor.go')).toEqual([
            'relay',
            'relayAdaptor',
            'Adaptor',
            'go',
        ]);
    });
});
