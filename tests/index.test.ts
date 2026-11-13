import { Connector } from '@/index';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { StoreRecord } from '@dpuse/dpuse-shared';
import { describe, expect, it, vi } from 'vitest';

const sqlite3 = await sqlite3InitModule();

describe('Connector', () => {
    it('stops a load when its request is aborted, keeping the earlier one', async () => {
        const connector = new Connector({} as never, []);
        connector.poolUtility = { isPaused: (): boolean => true } as never;
        connector.databases.set('default', new sqlite3.oo1.DB(':memory:'));
        const abortController = new AbortController();
        abortController.abort(new Error('Aborted.'));
        const loadOptions = { columnConfigs: [{ dataSubtypeId: undefined, dataTypeId: 'numeric' as const, label: { en: 'Value' } }], path: 'sales' };

        await expect(connector.loadObjectRecords({ ...loadOptions, signal: abortController.signal }, yieldChunks([[[1]]]))).rejects.toThrow('Aborted.');
        await expect(connector.dropObject({ path: 'sales' })).resolves.toBeUndefined(); // The earlier state, with no table, is kept.
    });

    it('refuses store actions until the store is open', async () => {
        const connector = new Connector({} as never, []);
        const queryOptions = { aggregates: [], columnConfigs: [], filters: [], groupColumnIndexes: [], limit: 1, offset: 0, path: 'sales', sorts: [] };

        await expect(connector.queryRecords(queryOptions)).rejects.toThrow('The store is not open.');
        await expect(connector.dropObject({ path: 'sales' })).rejects.toThrow('The store is not open.');
    });

    it('opens a database named in the path on first use, growing the pool when it is full, and keeps the default for a bare name', async () => {
        const openedPaths: string[] = [];
        const addCapacity = vi.fn(() => Promise.resolve(8));
        // The pool keeps databases in the browser's private file system, so in-memory databases stand in for them.
        const poolUtility = {
            addCapacity,
            getCapacity: (): number => 6,
            getFileCount: (): number => 6,
            isPaused: (): boolean => true,
            OpfsSAHPoolDb: class extends sqlite3.oo1.DB {
                constructor(path: string) {
                    super(':memory:');
                    openedPaths.push(path);
                }
            }
        };
        const connector = new Connector({} as never, []);
        connector.poolUtility = poolUtility as never;
        connector.databases.set('default', new sqlite3.oo1.DB(':memory:'));
        const queryOptions = { aggregates: [], columnConfigs: [], filters: [], groupColumnIndexes: [], limit: 1, offset: 0, sorts: [] };

        await expect(connector.queryRecords({ ...queryOptions, path: '/sales/orders' })).rejects.toThrow("'orders' has not been loaded.");
        await expect(connector.queryRecords({ ...queryOptions, path: '/sales/returns' })).rejects.toThrow("'returns' has not been loaded.");
        await expect(connector.queryRecords({ ...queryOptions, path: 'orders' })).rejects.toThrow("'orders' has not been loaded.");

        expect(openedPaths).toEqual(['/sales.sqlite3']);
        expect(addCapacity).toHaveBeenCalledWith(2);
        await connector.closeStore();
        expect(connector.databases.size).toBe(0);
    });

    it('closes without error when the store was never opened', async () => {
        await expect(new Connector({} as never, []).closeStore()).resolves.toBeUndefined();
    });

    describe('listNodes', () => {
        it('lists each database, the default one included, as a folder at the top', async () => {
            const connector = constructListingConnector({ '/default.sqlite3': ['orders'], '/sales.sqlite3': ['returns', 'invoices'], '/empty.sqlite3': [] });

            const result = await connector.listNodes({ folderPath: '' });

            expect(result).toEqual({ cursor: undefined, connectionNodeConfigs: expect.any(Array) as unknown, isMore: false, totalCount: 3 });
            expect(result.connectionNodeConfigs.map(({ childCount, folderPath, id, name, typeId }) => ({ childCount, folderPath, id, name, typeId }))).toEqual([
                { childCount: 1, folderPath: '', id: 'default', name: 'default', typeId: 'folder' },
                { childCount: 0, folderPath: '', id: 'empty', name: 'empty', typeId: 'folder' },
                { childCount: 2, folderPath: '', id: 'sales', name: 'sales', typeId: 'folder' }
            ]);
        });

        it("lists the default database's tables at a path that reaches the same table as its bare name", async () => {
            const connector = constructListingConnector({ '/default.sqlite3': ['orders'] });
            const queryOptions = { aggregates: [], columnConfigs: [], filters: [], groupColumnIndexes: [], limit: 1, offset: 0, sorts: [] };

            const result = await connector.listNodes({ folderPath: '/default' });

            expect(result.connectionNodeConfigs).toEqual([expect.objectContaining({ folderPath: '/default', id: '/default/orders', name: 'orders', typeId: 'object' })]);
            await expect(connector.queryRecords({ ...queryOptions, path: '/default/orders' })).resolves.toEqual({ records: [], totalCount: 0 });
            await expect(connector.queryRecords({ ...queryOptions, path: 'orders' })).resolves.toEqual({ records: [], totalCount: 0 });
        });

        it("lists a database's tables, each identified by its path", async () => {
            const connector = constructListingConnector({ '/default.sqlite3': [], '/sales.sqlite3': ['returns', 'invoices'] });

            const result = await connector.listNodes({ folderPath: '/sales' });

            expect(result.connectionNodeConfigs).toEqual([
                expect.objectContaining({ extension: undefined, folderPath: '/sales', id: '/sales/invoices', label: 'invoices', name: 'invoices', typeId: 'object' }),
                expect.objectContaining({ extension: undefined, folderPath: '/sales', id: '/sales/returns', label: 'returns', name: 'returns', typeId: 'object' })
            ]);
            expect(result.totalCount).toBe(2);
        });

        it('lists only the empty default database in a new store', async () => {
            const connector = constructListingConnector({ '/default.sqlite3': [] });

            const result = await connector.listNodes({ folderPath: '' });

            expect(result.connectionNodeConfigs).toEqual([expect.objectContaining({ childCount: 0, id: 'default', typeId: 'folder' })]);
            expect(result.totalCount).toBe(1);
        });

        it('refuses a database with no file, without creating one', async () => {
            const connector = constructListingConnector({ '/default.sqlite3': [] });

            await expect(connector.listNodes({ folderPath: '/missing' })).rejects.toThrow("Database 'missing' does not exist.");
            expect(connector.databases.has('missing')).toBe(false);
        });

        it('refuses a folder path that does not name one database', async () => {
            const connector = constructListingConnector({ '/default.sqlite3': [] });

            await expect(connector.listNodes({ folderPath: '/sales/returns' })).rejects.toThrow("Encountered invalid folder path '/sales/returns'.");
        });

        it('refuses to list until the store is open', async () => {
            await expect(new Connector({} as never, []).listNodes({ folderPath: '' })).rejects.toThrow('The store is not open.');
        });
    });
});

// The pool keeps databases in the browser's private file system, so in-memory databases holding the tables given stand in
// for its files. A journal file sits beside one database, as it does while a change is saved.
function constructListingConnector(tableNamesByFilePath: Record<string, string[]>): Connector {
    const databasesByFilePath = new Map(
        Object.entries(tableNamesByFilePath).map(([filePath, tableNames]) => {
            const database = new sqlite3.oo1.DB(':memory:');
            for (const tableName of tableNames) database.exec(`CREATE TABLE "${tableName}" (c0 INTEGER)`);
            return [filePath, database];
        })
    );
    const poolUtility = {
        getFileNames: (): string[] => [...databasesByFilePath.keys(), '/sales.sqlite3-journal'],
        OpfsSAHPoolDb: function (filePath: string) {
            return databasesByFilePath.get(filePath);
        }
    };
    const connector = new Connector({} as never, []);
    connector.poolUtility = poolUtility as never;
    connector.databases.set('default', databasesByFilePath.get('/default.sqlite3') as never);
    return connector;
}

async function* yieldChunks(chunks: StoreRecord[][]): AsyncGenerator<StoreRecord[]> {
    for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
    }
}
