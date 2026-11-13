// ── External Dependencies & Registrations
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it, vi } from 'vitest';

// ── DPUse Framework
import type { ConnectorUtilities, StoreRecord } from '@dpuse/dpuse-shared';

// ── Local Framework
import { Connector } from '@/index';

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const PREVIEW_OPTIONS = { chunkSize: undefined, dataFormatId: undefined, encodingId: undefined, extension: undefined, mimeType: undefined, parserId: undefined, valueDelimiterId: undefined };
const READ_OPTIONS = { chunkSize: 2, dataFormatId: 'unknown' as const, encodingId: undefined, parserId: undefined, valueDelimiterId: undefined };

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const sqlite3 = await sqlite3InitModule();

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

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

    it('opens the store once for requests that arrive together', async () => {
        const connector = new Connector({} as never, []);
        const startStore = vi.fn(() => Promise.resolve({ storeStateId: 'ready' as const }));
        Object.assign(connector, { startStore });

        await Promise.all([connector.openStore(), connector.openStore()]);

        expect(startStore).toHaveBeenCalledOnce();
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

        it('opens a closed store before listing it', async () => {
            const connector = constructListingConnector({ '/default.sqlite3': ['orders'] });
            const { databases, poolUtility } = connector;
            connector.databases = new Map();
            connector.poolUtility = undefined;
            const openStore = vi.spyOn(connector, 'openStore').mockImplementation(() => {
                connector.databases = databases;
                connector.poolUtility = poolUtility;
                return Promise.resolve({ storeStateId: 'ready' });
            });

            const result = await connector.listNodes({ folderPath: '/default' });

            expect(openStore).toHaveBeenCalledOnce();
            expect(result.connectionNodeConfigs).toEqual([expect.objectContaining({ id: '/default/orders' })]);
        });

        it.each([
            { message: 'The store is open in another tab.', storeStateId: 'heldElsewhere' as const },
            { message: 'This browser gives no storage to keep the store in, as in some private windows.', storeStateId: 'unavailable' as const }
        ])('refuses to list when the store cannot be opened because it is $storeStateId', async ({ message, storeStateId }) => {
            const connector = new Connector({} as never, []);
            vi.spyOn(connector, 'openStore').mockResolvedValue({ storeStateId });

            await expect(connector.listNodes({ folderPath: '' })).rejects.toThrow(message);
        });
    });

    describe('findObject', () => {
        it('gives back the path of a table that is there, in the default database or another', async () => {
            const connector = constructListingConnector({ '/default.sqlite3': ['orders'], '/sales.sqlite3': ['returns'] });

            await expect(connector.findObject({ id: '/default/orders' })).resolves.toEqual({ path: '/default/orders' });
            await expect(connector.findObject({ id: '/sales/returns' })).resolves.toEqual({ path: '/sales/returns' });
        });

        it('gives no path for a table or database that is not there, without creating the database', async () => {
            const connector = constructListingConnector({ '/default.sqlite3': [] });

            await expect(connector.findObject({ id: '/default/missing' })).resolves.toEqual({ path: undefined });
            await expect(connector.findObject({ id: '/missing/orders' })).resolves.toEqual({ path: undefined });
            expect(connector.databases.has('missing')).toBe(false);
        });
    });

    describe('previewObject', () => {
        it('hands the sample and the types the table was created with to type inference, and reads it as a table', async () => {
            const { connector, inferDataTypes } = constructReadingConnector();
            connector.databases.get('default')?.exec(`CREATE TABLE events (c0 INTEGER, c1 DATE, c2 BOOLEAN, c3 TEXT); INSERT INTO events VALUES (1, 19786, 1, 'Ann'), (2, NULL, 0, 'Bo')`);

            const result = await connector.previewObject({ ...PREVIEW_OPTIONS, path: '/default/events' });

            expect(inferDataTypes).toHaveBeenCalledWith(
                [
                    [
                        { value: '1', valueWasQuoted: false },
                        { value: new Date(19_786 * DAY).toISOString(), valueWasQuoted: false },
                        { value: 'true', valueWasQuoted: false },
                        { value: 'Ann', valueWasQuoted: false }
                    ],
                    [
                        { value: '2', valueWasQuoted: false },
                        { value: null, valueWasQuoted: false },
                        { value: 'false', valueWasQuoted: false },
                        { value: 'Bo', valueWasQuoted: false }
                    ]
                ],
                false,
                [
                    { dataSubtypeId: 'integer', dataTypeId: 'numeric', label: undefined, name: 'c0' },
                    { dataSubtypeId: 'date', dataTypeId: 'temporal', label: undefined, name: 'c1' },
                    { dataSubtypeId: undefined, dataTypeId: 'boolean', label: undefined, name: 'c2' },
                    { dataSubtypeId: undefined, dataTypeId: 'string', label: undefined, name: 'c3' }
                ]
            );
            expect(result.contentAuditConfig).toEqual(expect.objectContaining({ byteCount: 0, columns: ['inferred'], isComplete: true, recordCount: 2 }));
            expect(result.readingConfig).toEqual(expect.objectContaining({ dataFormatId: 'unknown', hasHeaders: false, isDeclared: true }));
            expect(result.sampleConfig).toEqual(expect.objectContaining({ hasHeaders: false, text: undefined }));
        });

        it('fails with a clear message for a table that is not there', async () => {
            const { connector } = constructReadingConnector();

            await expect(connector.previewObject({ ...PREVIEW_OPTIONS, path: '/default/missing' })).rejects.toThrow("'/default/missing' does not exist.");
        });
    });

    describe('auditObjectContent', () => {
        it('audits every record a chunk at a time against the types the table was created with', async () => {
            const { auditRecords, connector, constructColumnAuditor } = constructReadingConnector();
            connector.databases.get('default')?.exec('CREATE TABLE amounts (c0 INTEGER); INSERT INTO amounts VALUES (1), (2), (3)');
            const chunk = vi.fn();

            const result = await connector.auditObjectContent({ ...READ_OPTIONS, byteLimit: undefined, hasHeaders: false, path: 'amounts', stopSignal: undefined, supportsTransferableStreams: false }, chunk);

            expect(constructColumnAuditor).toHaveBeenCalledWith(false, [{ dataSubtypeId: 'integer', dataTypeId: 'numeric', label: undefined, name: 'c0' }]);
            expect(auditRecords.mock.calls).toEqual([[[[{ value: '1', valueWasQuoted: false }], [{ value: '2', valueWasQuoted: false }]]], [[[{ value: '3', valueWasQuoted: false }]]]]);
            expect(chunk.mock.calls).toEqual([
                [2, 0],
                [1, 0]
            ]);
            expect(result).toEqual({ contentAuditConfig: expect.objectContaining({ columns: ['audited'], isComplete: true, recordCount: 3 }) as unknown, hasHeaders: false });
        });

        it('stops when asked, keeping what it has audited', async () => {
            const { connector } = constructReadingConnector();
            connector.databases.get('default')?.exec('CREATE TABLE amounts (c0 INTEGER); INSERT INTO amounts VALUES (1), (2), (3)');
            const stopController = new AbortController();
            stopController.abort();

            const result = await connector.auditObjectContent(
                { ...READ_OPTIONS, byteLimit: undefined, hasHeaders: false, path: 'amounts', stopSignal: stopController.signal, supportsTransferableStreams: false },
                vi.fn()
            );

            expect(result.contentAuditConfig).toEqual(expect.objectContaining({ isComplete: false, recordCount: 0 }));
        });
    });

    describe('retrieveRecords', () => {
        it('hands over every record typed, a chunk at a time, then the count', async () => {
            const { connector } = constructReadingConnector();
            connector.databases.get('default')?.exec('CREATE TABLE amounts (c0 INTEGER); INSERT INTO amounts VALUES (1), (2), (3)');

            const { chunks, summary } = await collectRetrieval(connector.retrieveRecords({ ...READ_OPTIONS, path: '/default/amounts' }));

            expect(chunks).toEqual([[[1], [2]], [[3]]]);
            expect(summary).toEqual({ recordCount: 3 });
        });

        it('stops when its request is aborted', async () => {
            const { connector } = constructReadingConnector();
            connector.databases.get('default')?.exec('CREATE TABLE amounts (c0 INTEGER); INSERT INTO amounts VALUES (1), (2), (3)');
            const abortController = new AbortController();
            abortController.abort(new Error('Aborted.'));

            await expect(collectRetrieval(connector.retrieveRecords({ ...READ_OPTIONS, path: 'amounts', signal: abortController.signal }))).rejects.toThrow('Aborted.');
        });
    });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// The pool keeps databases in the browser's private file system, so in-memory databases holding the tables given stand in
// for its files. A journal file sits beside one database, as it does while a change is saved.
function constructListingConnector(tableNamesByFilePath: Record<string, string[]>, connectorUtilities = {} as ConnectorUtilities): Connector {
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
    const connector = new Connector(connectorUtilities, []);
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

// A store with an empty default database, and type inference and an auditor that record what they are handed.
function constructReadingConnector(): {
    auditRecords: ReturnType<typeof vi.fn>;
    connector: Connector;
    constructColumnAuditor: ReturnType<typeof vi.fn>;
    inferDataTypes: ReturnType<typeof vi.fn>;
} {
    const auditRecords = vi.fn();
    const constructColumnAuditor = vi.fn(() => ({ auditRecords, completeAudit: () => ({ columnConfigs: ['audited'], hasHeaders: false }) }));
    const inferDataTypes = vi.fn(() => ({ columnConfigs: ['inferred'], hasHeaders: false }));
    const connector = constructListingConnector({ '/default.sqlite3': [] }, { constructColumnAuditor, inferDataTypes } as unknown as ConnectorUtilities);
    return { auditRecords, connector, constructColumnAuditor, inferDataTypes };
}

async function collectRetrieval(retrieval: AsyncGenerator<{ records: unknown }, { recordCount: number }>): Promise<{ chunks: StoreRecord[][]; summary: { recordCount: number } }> {
    const chunks: StoreRecord[][] = [];
    for (;;) {
        const next = await retrieval.next();
        if (next.done === true) return { chunks, summary: next.value };
        chunks.push(next.value.records as StoreRecord[]);
    }
}
