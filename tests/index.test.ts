import { Connector } from '@/index';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { ensureObjectsTable } from '@/sqliteStore';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { StoreRecord } from '@dpuse/dpuse-shared';
import { describe, expect, it, vi } from 'vitest';

const sqlite3 = await sqlite3InitModule();

describe('Connector', () => {
    it('stops a load when its request is aborted, keeping the earlier one', async () => {
        const connector = new Connector({} as never, []);
        connector.poolUtility = { isPaused: (): boolean => true } as never;
        connector.databases.set('', new sqlite3.oo1.DB(':memory:'));
        const abortController = new AbortController();
        abortController.abort(new Error('Aborted.'));
        const loadOptions = { columnConfigs: [{ dataSubtypeId: undefined, dataTypeId: 'numeric' as const, label: { en: 'Value' } }], path: 'sales' };
        ensureObjectsTable(assertDatabase(connector));

        await expect(connector.loadObjectRecords({ ...loadOptions, signal: abortController.signal }, yieldChunks([[[1]]]))).rejects.toThrow('Aborted.');
        await expect(connector.dropObject({ path: 'sales' })).resolves.toBeUndefined(); // The earlier state, with no table, is kept.
    });

    it('refuses store actions until the store is open', async () => {
        const connector = new Connector({} as never, []);
        const queryOptions = { aggregates: [], filters: [], groupColumnIndexes: [], limit: 1, offset: 0, path: 'sales', sorts: [] };

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
        connector.databases.set('', new sqlite3.oo1.DB(':memory:'));
        const queryOptions = { aggregates: [], filters: [], groupColumnIndexes: [], limit: 1, offset: 0, sorts: [] };

        await expect(connector.queryRecords({ ...queryOptions, path: '/sales/orders' })).rejects.toThrow("'orders' has not been loaded.");
        await expect(connector.queryRecords({ ...queryOptions, path: '/sales/returns' })).rejects.toThrow("'returns' has not been loaded.");
        await expect(connector.queryRecords({ ...queryOptions, path: 'orders' })).rejects.toThrow('no such table');

        expect(openedPaths).toEqual(['/sales.sqlite3']);
        expect(addCapacity).toHaveBeenCalledWith(2);
        await connector.closeStore();
        expect(connector.databases.size).toBe(0);
    });

    it('closes without error when the store was never opened', async () => {
        await expect(new Connector({} as never, []).closeStore()).resolves.toBeUndefined();
    });
});

function assertDatabase(connector: Connector): Database {
    const database = connector.databases.get('');
    if (database == null) throw new Error('No default database.');
    return database;
}

async function* yieldChunks(chunks: StoreRecord[][]): AsyncGenerator<StoreRecord[]> {
    for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
    }
}
