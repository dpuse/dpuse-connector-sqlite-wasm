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

    it('sorts empty values last in either direction', () => {
        const ascending = queryStoreObject(database, constructQuery({ sorts: [{ columnIndex: 2, directionId: 'ascending' }] }));
        const descending = queryStoreObject(database, constructQuery({ sorts: [{ columnIndex: 2, directionId: 'descending' }] }));

        expect(ascending.records.map((record) => record[2])).toEqual([1.5, 2.5, 10, null]);
        expect(descending.records.map((record) => record[2])).toEqual([10, 2.5, 1.5, null]);
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

describe('sqliteStore temporal round trip', () => {
    const DAY = 86_400_000;
    const TEMPORAL_COLUMN_CONFIGS = [constructColumnConfig('temporal', 'date'), constructColumnConfig('temporal', 'time'), constructColumnConfig('temporal', 'dateTime')];
    let database: Database;

    function constructTemporalRecord(dayNumber: number, timeOfDay: number): StoreRecord {
        return [new Date(dayNumber * DAY), new Date(timeOfDay), new Date(dayNumber * DAY + timeOfDay)];
    }

    async function load(records: StoreRecord[]): Promise<void> {
        await loadStoreObject(database, 'dates', TEMPORAL_COLUMN_CONFIGS, yieldChunks([records]), new AbortController().signal);
    }

    function query(options: Partial<QueryRecordsOptions>): StoreRecord[] {
        return queryStoreObject(database, constructQuery({ path: 'dates', ...options })).records;
    }

    beforeEach(() => {
        database = new sqlite3.oo1.DB(':memory:');
        ensureObjectsTable(database);
    });

    it('returns every date, time and date-time exactly as loaded, across the whole calendar and day', async () => {
        const firstDay = Date.UTC(1000, 0, 1) / DAY;
        const lastDay = Date.UTC(9999, 11, 31) / DAY;
        const records: StoreRecord[] = [];
        for (let dayNumber = firstDay; dayNumber <= lastDay; dayNumber += 97) records.push(constructTemporalRecord(dayNumber, (dayNumber - firstDay) % DAY));
        records.push(constructTemporalRecord(0, 0), constructTemporalRecord(-1, DAY - 1), constructTemporalRecord(lastDay, DAY - 1));

        await load(records);

        expect(query({ limit: records.length })).toEqual(records);
    });

    it('stores a date as a whole number of days, and a date-time and a time as milliseconds', async () => {
        await load([constructTemporalRecord(19_786, 36_672_123)]);

        expect(database.selectArrays('SELECT c0, c1, c2 FROM dates')).toEqual([[19_786, 36_672_123, 19_786 * DAY + 36_672_123]]);
    });

    it('filters, sorts, groups and finds the earliest and latest date by the value loaded', async () => {
        await load([constructTemporalRecord(19_786, 3000), constructTemporalRecord(19_787, 2000), constructTemporalRecord(19_785, 1000), constructTemporalRecord(19_786, 4000)]);
        const targetDate = new Date(19_786 * DAY);

        expect(query({ filters: [{ columnIndex: 0, operatorId: 'equals', value: targetDate }] })).toHaveLength(2);
        expect(query({ filters: [{ columnIndex: 0, operatorId: 'greaterThan', value: targetDate }] })).toHaveLength(1);
        expect(query({ filters: [{ columnIndex: 1, operatorId: 'lessThan', value: new Date(2000) }] })).toHaveLength(1);
        expect(query({ filters: [{ columnIndex: 2, operatorId: 'greaterThanOrEquals', value: new Date(19_787 * DAY) }] })).toHaveLength(1);
        expect(query({ sorts: [{ columnIndex: 0, directionId: 'ascending' }] }).map((record) => record[0])).toEqual([
            new Date(19_785 * DAY),
            targetDate,
            targetDate,
            new Date(19_787 * DAY)
        ]);
        expect(
            query({
                aggregates: [{ columnIndex: undefined, functionId: 'count' }],
                groupColumnIndexes: [0],
                sorts: [{ columnIndex: 0, directionId: 'ascending' }]
            })
        ).toEqual([
            [new Date(19_785 * DAY), 1],
            [targetDate, 2],
            [new Date(19_787 * DAY), 1]
        ]);
        expect(
            query({
                aggregates: [
                    { columnIndex: 0, functionId: 'minimum' },
                    { columnIndex: 0, functionId: 'maximum' }
                ],
                groupColumnIndexes: [1],
                limit: 1,
                sorts: [{ columnIndex: 0, directionId: 'ascending' }]
            })
        ).toEqual([[new Date(1000), new Date(19_785 * DAY), new Date(19_785 * DAY)]]);
    });

    it('still reads a date column loaded before dates were stored as day numbers', async () => {
        await load([constructTemporalRecord(19_786, 0)]);
        database.exec({ sql: 'UPDATE dates SET c0 = ?', bind: [19_786 * DAY] });
        database.exec({
            sql: "UPDATE _dpuse_objects SET columns = ? WHERE path = 'dates'",
            bind: [JSON.stringify(TEMPORAL_COLUMN_CONFIGS.map(({ dataSubtypeId, dataTypeId }) => ({ dataSubtypeId, dataTypeId })))]
        });

        expect(query({})[0]?.[0]).toEqual(new Date(19_786 * DAY));
    });
});
