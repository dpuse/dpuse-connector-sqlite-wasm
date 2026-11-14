// ── External Dependencies & Registrations
import type { BindableValue, Database } from '@sqlite.org/sqlite-wasm';

// ── DPUse Framework
import { constructStoreError } from '@dpuse/dpuse-shared';
import type {
    DataSubtypeId,
    DataTypeId,
    ObjectColumnConfig,
    QueryAggregate,
    QueryFilter,
    QueryRecordsOptions,
    QueryRecordsResult,
    QuerySort,
    StoreRecord,
    StoreValue
} from '@dpuse/dpuse-shared';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// How a column's values are stored, worked out from its type, to turn stored values back into that type.
interface StoredColumn {
    dataSubtypeId: DataSubtypeId | undefined;
    dataTypeId: DataTypeId;
    isDayNumber: boolean; // Set for a column of dates, each stored as a count of days.
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const LIKE_ESCAPE_SQL = String.raw`ESCAPE '\'`; // Lets a filter match '%' and '_' as written, not as wildcards.

const MILLISECONDS_PER_DAY = 86_400_000;

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function dropStoreObject(database: Database, path: string): void {
    database.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(path)}`);
}

export function countStoreObjectRecords(database: Database, tableName: string): number {
    return Number(database.selectValue(`SELECT count(*) FROM ${quoteIdentifier(tableName)}`) ?? 0);
}

// A table's columns, from the type each was created with, so a table read on its own gives back the types it was loaded
// with. A column is labelled with its name, because the store keeps no labels. Empty when there is no such table.
export function describeStoreObject(database: Database, tableName: string): ObjectColumnConfig[] {
    const columnRows = database.selectArrays('SELECT name, type FROM pragma_table_info(?)', [tableName]);
    return columnRows.map(([name, typeName]) => ({ ...identifyColumnType(typeof typeName === 'string' ? typeName : ''), label: { en: typeof name === 'string' ? name : '' } }));
}

// SQLite keeps its own tables beside the store's, under names starting 'sqlite_', which no store object can take.
export function listStoreObjectNames(database: Database): string[] {
    return database.selectValues(String.raw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY name`).map(String);
}

// Replaces an object with the records given, in one transaction, so a failed or stopped load leaves the earlier one in
// place. 'signal' is checked between chunks. The columns' types are not kept, because every query brings them.
export async function loadStoreObject(
    database: Database,
    path: string,
    columnConfigs: ObjectColumnConfig[],
    chunks: AsyncIterable<StoreRecord[]>,
    signal: AbortSignal
): Promise<number> {
    const storedColumns = constructStoredColumns(columnConfigs);
    const columnDefinitions = storedColumns.map((storedColumn, columnIndex) => `${columnName(columnIndex)} ${resolveColumnType(storedColumn)}`);
    const tableName = quoteIdentifier(path);
    let recordCount = 0;

    database.exec('BEGIN');
    try {
        database.exec(`DROP TABLE IF EXISTS ${tableName}`);
        database.exec(`CREATE TABLE ${tableName} (${columnDefinitions.join(', ')})`);
        if (storedColumns.length > 0) {
            const statement = database.prepare(`INSERT INTO ${tableName} VALUES (${storedColumns.map(() => '?').join(', ')})`);
            try {
                for await (const records of chunks) {
                    signal.throwIfAborted();
                    for (const record of records) {
                        statement.bind(storedColumns.map((storedColumn, columnIndex) => toBindableValue(record[columnIndex] ?? null, storedColumn))).stepReset();
                    }
                    recordCount += records.length;
                }
            } finally {
                statement.finalize();
            }
        }
        database.exec('COMMIT');
        return recordCount;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

// Reads one chunk of a table's records in rowid order, each value as its column's type. A chunk starts after the last
// rowid of the one before, so a chunk far into the table is found as quickly as the first. Each read finishes before
// its records are used, so a load into the same database, which drops and creates tables, is never blocked by it.
export function readStoreObjectRecords(
    database: Database,
    tableName: string,
    columnConfigs: ObjectColumnConfig[],
    chunkSize: number,
    afterRowId: number | undefined
): { lastRowId: number | undefined; records: StoreRecord[] } {
    const storedColumns = constructStoredColumns(columnConfigs);
    const whereSql = afterRowId == null ? '' : ' WHERE rowid > ?';
    const values = afterRowId == null ? [chunkSize] : [afterRowId, chunkSize];
    const rows = database.selectArrays(`SELECT rowid, * FROM ${quoteIdentifier(tableName)}${whereSql} ORDER BY rowid LIMIT ?`, values);
    const lastRowId = rows.at(-1)?.[0];
    return {
        lastRowId: lastRowId == null ? undefined : Number(lastRowId),
        records: rows.map(([, ...storedValues]) => storedValues.map((value, columnIndex) => fromStoredValue(value, storedColumns[columnIndex])))
    };
}

// The query brings the columns the object was loaded with, so each stored value is read back as its column's type.
export function queryStoreObject(database: Database, options: QueryRecordsOptions): QueryRecordsResult {
    if (database.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [options.path]) == null) {
        throw constructStoreError('notLoaded', `'${options.path}' has not been loaded.`, 'dpuse-connector-sqlite-wasm.sqliteStore.queryStoreObject');
    }
    const storedColumns = constructStoredColumns(options.columnConfigs);
    const isGrouped = options.groupColumnIndexes.length > 0;
    const resultColumns = isGrouped ? constructGroupedResultColumns(storedColumns, options) : storedColumns.map((storedColumn, columnIndex) => ({ columnIndex, storedColumn }));
    const selections = isGrouped
        ? [...options.groupColumnIndexes.map((columnIndex) => columnName(columnIndex)), ...options.aggregates.map((aggregate) => constructAggregateSql(aggregate))]
        : storedColumns.map((_storedColumn, columnIndex) => columnName(columnIndex));
    if (selections.length === 0) return { records: [], totalCount: 0 };

    const whereParts = options.filters.map((filter) => constructFilterSql(filter, storedColumns));
    const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.map((part) => part.sql).join(' AND ')}` : '';
    const whereValues = whereParts.flatMap((part) => part.values);
    const groupSql = isGrouped ? ` GROUP BY ${options.groupColumnIndexes.map((columnIndex) => columnName(columnIndex)).join(', ')}` : '';
    const baseSql = `SELECT ${selections.join(', ')} FROM ${quoteIdentifier(options.path)}${whereSql}${groupSql}`;

    const orderSql = constructOrderSql(options.sorts, selections.length);
    const rows = database.selectArrays(`${baseSql}${orderSql} LIMIT ? OFFSET ?`, [...whereValues, options.limit, options.offset]);
    const totalCount = Number(database.selectValue(`SELECT count(*) FROM (${baseSql})`, whereValues.length > 0 ? whereValues : undefined) ?? 0); // SQLite refuses values for SQL with no parameters.

    return {
        records: rows.map((row) => row.map((value, resultIndex) => fromStoredValue(value, resultColumns[resultIndex]?.storedColumn))),
        totalCount
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Column positions come from the caller, so each is checked before it becomes part of the SQL.
function checkIndex(columnIndex: number, columnCount: number): number {
    if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= columnCount) throw new Error(`Column ${String(columnIndex)} does not exist.`);
    return columnIndex;
}

// Columns are named by position, because an audited column has a label but no id.
function columnName(columnIndex: number): string {
    return `c${String(columnIndex)}`;
}

function constructAggregateSql(aggregate: QueryAggregate): string {
    if (aggregate.functionId === 'count') return 'count(*)';
    if (aggregate.columnIndex == null) throw new Error(`Aggregate '${aggregate.functionId}' needs a column.`);
    const name = columnName(aggregate.columnIndex);
    switch (aggregate.functionId) {
        case 'average':
            return `avg(${name})`;
        case 'countDistinct':
            return `count(DISTINCT ${name})`;
        case 'maximum':
            return `max(${name})`;
        case 'minimum':
            return `min(${name})`;
        case 'sum':
            return `sum(${name})`;
    }
}

function constructFilterSql(filter: QueryFilter, storedColumns: StoredColumn[]): { sql: string; values: BindableValue[] } {
    const name = columnName(checkIndex(filter.columnIndex, storedColumns.length));
    const value = toBindableValue(filter.value, storedColumns[filter.columnIndex]);
    const text = escapeLikeText(String(filter.value ?? ''));
    switch (filter.operatorId) {
        case 'contains':
            return { sql: `${name} LIKE ? ${LIKE_ESCAPE_SQL}`, values: [`%${text}%`] };
        case 'endsWith':
            return { sql: `${name} LIKE ? ${LIKE_ESCAPE_SQL}`, values: [`%${text}`] };
        case 'equals':
            return { sql: `${name} IS ?`, values: [value] };
        case 'greaterThan':
            return { sql: `${name} > ?`, values: [value] };
        case 'greaterThanOrEquals':
            return { sql: `${name} >= ?`, values: [value] };
        case 'isEmpty':
            return { sql: `${name} IS NULL`, values: [] };
        case 'isNotEmpty':
            return { sql: `${name} IS NOT NULL`, values: [] };
        case 'lessThan':
            return { sql: `${name} < ?`, values: [value] };
        case 'lessThanOrEquals':
            return { sql: `${name} <= ?`, values: [value] };
        case 'notEquals':
            return { sql: `${name} IS NOT ?`, values: [value] };
        case 'startsWith':
            return { sql: `${name} LIKE ? ${LIKE_ESCAPE_SQL}`, values: [`${text}%`] };
    }
}

// A grouped result holds the group's values, then one value per aggregate. A minimum or maximum keeps its column's type,
// while counts, sums and averages are plain numbers.
function constructGroupedResultColumns(storedColumns: StoredColumn[], options: QueryRecordsOptions): { storedColumn: StoredColumn | undefined }[] {
    const groupColumns = options.groupColumnIndexes.map((columnIndex) => ({ storedColumn: storedColumns[checkIndex(columnIndex, storedColumns.length)] }));
    const aggregateColumns = options.aggregates.map((aggregate) => {
        if (aggregate.columnIndex != null) checkIndex(aggregate.columnIndex, storedColumns.length);
        const doesKeepColumnType = aggregate.functionId === 'maximum' || aggregate.functionId === 'minimum';
        return { storedColumn: doesKeepColumnType && aggregate.columnIndex != null ? storedColumns[aggregate.columnIndex] : undefined };
    });
    return [...groupColumns, ...aggregateColumns];
}

// Sorts name a position in the result, which SQL accepts as a 1-based column number. Empty values sort last, as in the
// DuckDB store.
function constructOrderSql(sorts: QuerySort[], resultColumnCount: number): string {
    if (sorts.length === 0) return '';
    const sortSql = sorts.map((sort) => `${String(checkIndex(sort.columnIndex, resultColumnCount) + 1)} ${sort.directionId === 'descending' ? 'DESC' : 'ASC'} NULLS LAST`);
    return ` ORDER BY ${sortSql.join(', ')}`;
}

function escapeLikeText(text: string): string {
    return text
        .replaceAll('\\', '\\\\')
        .replaceAll('%', String.raw`\%`)
        .replaceAll('_', String.raw`\_`);
}

// Booleans are stored as 1 and 0. A date is stored as a count of days since 1970, a date and time as milliseconds since
// 1970, and a time as milliseconds since midnight. All of them sort and compare correctly, and take the least space.
// SQLite returns a whole number as a bigint only when it is too large to be exact, so a column of whole numbers beyond
// ±2^53 turns its smaller values into bigints too, and holds one type throughout.
// eslint-disable-next-line sonarjs/function-return-type -- A store value is one of several types, by its column.
function fromStoredValue(value: unknown, storedColumn: StoredColumn | undefined): StoreValue {
    if (value == null) return null;
    if (storedColumn?.dataTypeId === 'boolean') return value === 1 || value === 1n;
    if (storedColumn?.dataTypeId === 'temporal') return new Date(Number(value) * (storedColumn.isDayNumber ? MILLISECONDS_PER_DAY : 1));
    if (typeof value === 'number' && storedColumn?.dataSubtypeId === 'bigint') return BigInt(value);
    return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string' ? value : null;
}

// The opposite of 'resolveColumnType'. A column of any other type, from a table the store did not create, has no known
// type, so its values are taken as SQLite gives them and their type is worked out from them.
function identifyColumnType(typeName: string): Pick<ObjectColumnConfig, 'dataSubtypeId' | 'dataTypeId'> {
    switch (typeName.toUpperCase()) {
        case 'BIGINT':
            return { dataSubtypeId: 'bigint', dataTypeId: 'numeric' };
        case 'BOOLEAN':
            return { dataSubtypeId: undefined, dataTypeId: 'boolean' };
        case 'DATE':
            return { dataSubtypeId: 'date', dataTypeId: 'temporal' };
        case 'INTEGER':
            return { dataSubtypeId: 'integer', dataTypeId: 'numeric' };
        case 'REAL':
            return { dataSubtypeId: 'decimal', dataTypeId: 'numeric' };
        case 'TEXT':
            return { dataSubtypeId: undefined, dataTypeId: 'string' };
        case 'TIME':
            return { dataSubtypeId: 'time', dataTypeId: 'temporal' };
        case 'TIMESTAMP':
            return { dataSubtypeId: 'dateTime', dataTypeId: 'temporal' };
        default:
            return { dataSubtypeId: undefined, dataTypeId: 'unknown' };
    }
}

function quoteIdentifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

// SQLite stores a value by the kind of type a column names, not the name itself, so 'BOOLEAN', 'DATE', 'TIME' and
// 'TIMESTAMP' store whole numbers just as 'INTEGER' does. The names say what each column holds, so
// 'describeStoreObject' can give the types back.
function resolveColumnType(storedColumn: StoredColumn): string {
    switch (storedColumn.dataTypeId) {
        case 'boolean':
            return 'BOOLEAN';
        case 'numeric':
            return resolveNumericColumnType(storedColumn);
        case 'temporal':
            return resolveTemporalColumnType(storedColumn);
        case 'string':
            return 'TEXT';
        case 'unknown':
            return 'BLOB'; // Every value of a column with no audited type is null.
    }
}

function resolveNumericColumnType(storedColumn: StoredColumn): string {
    if (storedColumn.dataSubtypeId === 'decimal') return 'REAL';
    return storedColumn.dataSubtypeId === 'bigint' ? 'BIGINT' : 'INTEGER';
}

function resolveTemporalColumnType(storedColumn: StoredColumn): string {
    if (storedColumn.dataSubtypeId === 'date') return 'DATE';
    return storedColumn.dataSubtypeId === 'time' ? 'TIME' : 'TIMESTAMP';
}

function constructStoredColumns(columnConfigs: ObjectColumnConfig[]): StoredColumn[] {
    return columnConfigs.map(({ dataSubtypeId, dataTypeId }) => ({ dataSubtypeId, dataTypeId, isDayNumber: dataTypeId === 'temporal' && dataSubtypeId === 'date' }));
}

// eslint-disable-next-line sonarjs/function-return-type -- A bound value is one of several types, by its column.
function toBindableValue(value: StoreValue, storedColumn: StoredColumn | undefined): BindableValue {
    if (value instanceof Date) return storedColumn?.isDayNumber === true ? Math.floor(value.getTime() / MILLISECONDS_PER_DAY) : value.getTime();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}
