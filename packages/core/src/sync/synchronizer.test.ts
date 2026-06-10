import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileSynchronizer, SnapshotTooLargeError } from './synchronizer';

describe('FileSynchronizer snapshot safety', () => {
    let tempRoot: string;
    let originalHome: string | undefined;
    let homeDir: string;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-snapshot-'));
        homeDir = path.join(tempRoot, 'home');
        await fs.mkdir(homeDir, { recursive: true });
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;
    });

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it('fails with a clear limit before writing an oversized snapshot', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'const value = 1;');

        const synchronizer = new FileSynchronizer(project, [], ['.ts'], {
            maxSnapshotBytes: 64,
            snapshotBaseDir: path.join(homeDir, '.hitmux-context-engine', 'merkle')
        });

        await expect(synchronizer.initialize()).rejects.toBeInstanceOf(SnapshotTooLargeError);
        await expect(synchronizer.initialize()).rejects.toThrow('merkleSnapshotMaxBytes');
    });

    it('loads a saved snapshot in a new synchronizer without reporting unchanged files as added', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'const value = 1;');

        const firstSynchronizer = new FileSynchronizer(project, [], ['.ts']);
        await firstSynchronizer.initialize();

        const restartedSynchronizer = new FileSynchronizer(project, [], ['.ts']);
        await restartedSynchronizer.initialize();

        await expect(restartedSynchronizer.checkForChanges()).resolves.toEqual({
            added: [],
            removed: [],
            modified: []
        });
    });

    it('reuses mtime and size metadata instead of reading unchanged files during sync checks', async () => {
        const project = path.join(tempRoot, 'project-metadata');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'const value = 1;');

        const synchronizer = new FileSynchronizer(project, [], ['.ts']);
        await synchronizer.initialize();

        const hashFileSpy = jest.spyOn(synchronizer as any, 'hashFile');

        await expect(synchronizer.checkForChanges()).resolves.toEqual({
            added: [],
            removed: [],
            modified: []
        });
        expect(hashFileSpy).not.toHaveBeenCalled();

        hashFileSpy.mockRestore();
    });

    it('limits sync traversal by maxDepth', async () => {
        const project = path.join(tempRoot, 'project-depth');
        await fs.mkdir(path.join(project, 'src', 'nested'), { recursive: true });
        await fs.writeFile(path.join(project, 'root.ts'), 'root');
        await fs.writeFile(path.join(project, 'src', 'child.ts'), 'child');
        await fs.writeFile(path.join(project, 'src', 'nested', 'deep.ts'), 'deep');

        const synchronizer = new FileSynchronizer(project, [], ['.ts'], { maxDepth: 1 });
        const fileHashes = await (synchronizer as any).generateFileHashes(project) as Map<string, string>;

        expect(fileHashes.has('root.ts')).toBe(true);
        expect(fileHashes.has(path.join('src', 'child.ts'))).toBe(true);
        expect(fileHashes.has(path.join('src', 'nested', 'deep.ts'))).toBe(false);
    });
});

async function writeConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(homeDir, '.hitmux-context-engine');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.jsonc'), JSON.stringify(config), 'utf-8');
}
