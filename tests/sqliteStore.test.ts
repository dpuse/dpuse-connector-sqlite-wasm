// ── External Dependencies & Registrations
import { beforeEach, describe, expect, it } from 'vitest';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';

// ── DPUse Framework
import type { DataSubtypeId, DataTypeId, ObjectColumnConfig, QueryRecordsOptions, StoreRecord } from '@dpuse/dpuse-shared';

// ── Local Framework
import { dropStoreObject, ensureObjectsTable, loadStoreObject, queryStoreObject } from '@/sqliteStore';

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const sqlite3 = await sqlite3InitModule();

const COLUMN_CONFIGS = [
    constructColumnConfig('string'),
    constructColumnConfig('numeric', 'integer'),
    constructColumnConfig('numeric', 'decimal'),
    constructColumnConfig('boolean'),
    constructColumnConfig('temporal', 'date')
];
const RECORDS: StoreRecord[] = [
    ['North', 3, 1.5, true, new Date('2026-01-02')],
    ['South', 1, 2.5, false, new Date('2026-03-04')],
    ['North', 2, null, null, null],
    ['East_1', 4, 10, true, new Date('2026-05-06')]
];

function constructColumnConfig(dataTypeId: DataTypeId, dataSubtypeId?: DataSubtypeId): ObjectColumnConfig {
    return { dataSubtypeId, dataTypeId } as ObjectColumnConfig;
}

function constructQuery(options: Partial<QueryRecordsOptions>): QueryRecordsOptions {
    return { aggregates: [], filters: [], groupColumnIndexes: [], limit: 100, offset: 0, path: 'sales', sorts: [], ...options };
}

// A stream stands in for the engine's queue of chunks, as both are read with 'for await'.
function yieldChunks(chunks: StoreRecord[][], error?: Error): ReadableStream<StoreRecord[]> {
    return new ReadableStream({
        start(controller): void {
            for (const chunk of chunks) controller.enqueue(chunk);
            if (error) controller.error(error);
            else controller.close();
        }
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('sqliteStore', () => {
    let database: Database;

    beforeEach(async () => {
        database = new sqlite3.oo1.DB(':memory:');
        ensureObjectsTable(database);
        await loadStoreObject(database, 'sales', COLUMN_CONFIGS, yieldChunks([RECORDS.slice(0, 2), RECORDS.slice(2)]), new AbortController().signal);
    });

    it('loads records and returns them with their audited types', () => {
        const result = queryStoreObject(database, constructQuery({ sorts: [{ columnIndex: 1, directionId: 'ascending' }] }));

        expect(result.totalCount).toBe(4);
        expect(result.records[0]).toEqual(['South', 1, 2.5, false, new Date('2026-03-04')]);
        expect(result.records[1]).toEqual(['North', 2, null, null, null]);
    });

    it('pages through records and counts them all', () => {
        const result = queryStoreObject(database, constructQuery({ limit: 2, offset: 1, sorts: [{ columnIndex: 1, directionId: 'descending' }] }));

        expect(result.records.map((record) => record[1])).toEqual([3, 2]);
        expect(result.totalCount).toBe(4);
    });

    it('filters records, matching wildcard characters as written', () => {
        const startsWith = queryStoreObject(database, constructQuery({ filters: [{ columnIndex: 0, operatorId: 'startsWith', value: 'East_' }] }));
        const emptyResult = queryStoreObject(database, constructQuery({ filters: [{ columnIndex: 3, operatorId: 'isEmpty', value: null }] }));
        const combined = queryStoreObject(
            database,
            constructQuery({
                filters: [
                    { columnIndex: 0, operatorId: 'equals', value: 'North' },
                    { columnIndex: 4, operatorId: 'greaterThan', value: new Date('2026-01-01') }
                ]
            })
        );

        expect(startsWith.records.map((record) => record[0])).toEqual(['East_1']);
        expect(emptyResult.totalCount).toBe(1);
        expect(combined.records.map((record) => record[1])).toEqual([3]);
    });

    it('groups records, with aggregates after the group values', () => {
        const result = queryStoreObject(
            database,
            constructQuery({
                aggregates: [
                    { columnIndex: undefined, functionId: 'count' },
                    { columnIndex: 1, functionId: 'sum' },
                    { columnIndex: 4, functionId: 'maximum' }
                ],
                groupColumnIndexes: [0],
                sorts: [{ columnIndex: 0, directionId: 'ascending' }]
            })
        );

        expect(result.totalCount).toBe(3);
        expect(result.records).toEqual([
            ['East_1', 1, 4, new Date('2026-05-06')],
            ['North', 2, 5, new Date('2026-01-02')],
            ['South', 1, 1, new Date('2026-03-04')]
        ]);
    });

    it('refuses a column that does not exist', () => {
        expect(() => queryStoreObject(database, constructQuery({ sorts: [{ columnIndex: 9, directionId: 'ascending' }] }))).toThrow('Column 9 does not exist.');
        expect(() => queryStoreObject(database, constructQuery({ filters: [{ columnIndex: 0.5, operatorId: 'equals', value: 1 }] }))).toThrow('Column 0.5 does not exist.');
    });

    it('replaces an earlier load, and keeps it when a load fails', async () => {
        await loadStoreObject(database, 'sales', COLUMN_CONFIGS, yieldChunks([RECORDS.slice(0, 1)]), new AbortController().signal);
        const failingChunks = yieldChunks([RECORDS], new Error('Source failed.'));

        await expect(loadStoreObject(database, 'sales', COLUMN_CONFIGS, failingChunks, new AbortController().signal)).rejects.toThrow('Source failed.');
        expect(queryStoreObject(database, constructQuery({})).totalCount).toBe(1);
    });

    it('drops an object', () => {
        dropStoreObject(database, 'sales');

        expect(() => queryStoreObject(database, constructQuery({}))).toThrow("'sales' has not been loaded.");
    });
});
