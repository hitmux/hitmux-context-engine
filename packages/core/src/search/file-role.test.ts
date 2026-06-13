import {
    classifyFileRole,
    inferFileRoleIntent,
    isFileRoleExplicitlyRequested,
} from './file-role';

describe('file role classification and intent', () => {
    it('does not treat standalone config as explicit config intent', () => {
        const intent = inferFileRoleIntent('TowerRegistry config');

        expect(intent.preferredRoles.has('config')).toBe(false);
        expect(isFileRoleExplicitlyRequested('config', intent, 'src/config/towers.ts')).toBe(false);
        expect(isFileRoleExplicitlyRequested('implementation', intent, 'src/towers/towerRegistry.ts')).toBe(true);
    });

    it('treats config file wording and config extensions as explicit config intent', () => {
        const configFileIntent = inferFileRoleIntent('TowerRegistry config file');
        const jsonIntent = inferFileRoleIntent('TowerRegistry .json');

        expect(configFileIntent.preferredRoles.has('config')).toBe(true);
        expect(jsonIntent.preferredRoles.has('config')).toBe(true);
        expect(jsonIntent.explicitExtensions.has('.json')).toBe(true);
        expect(isFileRoleExplicitlyRequested('config', configFileIntent, 'src/config/towers.ts')).toBe(true);
        expect(isFileRoleExplicitlyRequested('config', jsonIntent, 'src/config/towers.json')).toBe(true);
    });

    it('classifies test docs style config and generated roles independently of query wording', () => {
        expect(classifyFileRole('src/towers/towerRegistry.test.ts')).toBe('test');
        expect(classifyFileRole('docs/towers/README.md')).toBe('docs');
        expect(classifyFileRole('src/styles/index.less')).toBe('style');
        expect(classifyFileRole('src/towers/config/factory.ts')).toBe('config');
        expect(classifyFileRole('src/generated/towers.ts')).toBe('generated');
        expect(classifyFileRole('src/towers/towerRegistry.ts')).toBe('implementation');
    });
});
