// ── External Dependencies & Registrations
import type { BindableValue, Database } from '@sqlite.org/sqlite-wasm';

// ── DPUse Framework
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

// What the store keeps about each loaded object, to turn stored values back into their audited types.
interface StoredColumn {
    dataSubtypeId: DataSubtypeId | undefined;
    dataTypeId: DataTypeId;
    isDayNumber: boolean | undefined; // Set for a column of dates, each stored as a count of days. A column loaded before this holds milliseconds.
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Holds each object's audited column types. Named so it cannot clash with a data view's table, whose name is its path.
const OBJECTS_TABLE = '_dpuse_objects';

const LIKE_ESCAPE_SQL = String.raw`ESCAPE '\'`; // Lets a filter match '%' and '_' as written, not as wildcards.

const MILLISECONDS_PER_DAY = 86_400_000;

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ensureObjectsTable(database: Database): void {
    database.exec(`CREATE TABLE IF NOT EXISTS ${OBJECTS_TABLE} (path TEXT PRIMARY KEY, columns TEXT NOT NULL)`);
}

export function dropStoreObject(database: Database, path: string): void {
    database.transaction(() => {
        database.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(path)}`);
        database.exec({ sql: `DELETE FROM ${OBJECTS_TABLE} WHERE path = ?`, bind: [path] });
    });
}

// Replaces an object with the records given, in one transaction, so a failed or stopped load leaves the earlier one in
// place. 'signal' is checked between chunks.
export async function loadStoreObject(
    database: Database,
    path: string,
    columnConfigs: ObjectColumnConfig[],
    chunks: AsyncIterable<StoreRecord[]>,
    signal: AbortSignal
): Promise<number> {
    const storedColumns: StoredColumn[] = columnConfigs.map(({ dataSubtypeId, dataTypeId }) => ({
        dataSubtypeId,
        dataTypeId,
        isDayNumber: dataTypeId === 'temporal' && dataSubtypeId === 'date'
    }));
    const columnDefinitions = storedColumns.map((storedColumn, columnIndex) => `${columnName(columnIndex)} ${resolveColumnType(storedColumn)}`);
    const tableName = quoteIdentifier(path);
    let recordCount = 0;

    database.exec('BEGIN');
    try {
        database.exec(`DROP TABLE IF EXISTS ${tableName}`);
        database.exec(`CREATE TABLE ${tableName} (${columnDefinitions.join(', ')})`);
        database.exec({ sql: `INSERT OR REPLACE INTO ${OBJECTS_TABLE} (path, columns) VALUES (?, ?)`, bind: [path, JSON.stringify(storedColumns)] });
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

export function queryStoreObject(database: Database, options: QueryRecordsOptions): QueryRecordsResult {
    const storedColumns = retrieveStoredColumns(database, options.path);
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
// eslint-disable-next-line sonarjs/function-return-type -- A store value is one of several types, by its column.
function fromStoredValue(value: unknown, storedColumn: StoredColumn | undefined): StoreValue {
    if (value == null) return null;
    if (storedColumn?.dataTypeId === 'boolean') return value === 1 || value === 1n;
    if (storedColumn?.dataTypeId === 'temporal') return new Date(Number(value) * (storedColumn.isDayNumber === true ? MILLISECONDS_PER_DAY : 1));
    return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string' ? value : null;
}

function quoteIdentifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

function resolveColumnType(storedColumn: StoredColumn): string {
    switch (storedColumn.dataTypeId) {
        case 'boolean':
            return 'INTEGER';
        case 'numeric':
            return storedColumn.dataSubtypeId === 'decimal' ? 'REAL' : 'INTEGER';
        case 'temporal':
            return 'INTEGER';
        case 'string':
            return 'TEXT';
        case 'unknown':
            return 'BLOB'; // Every value of a column with no audited type is null.
    }
}

function retrieveStoredColumns(database: Database, path: string): StoredColumn[] {
    const columnsJSON = database.selectValue(`SELECT columns FROM ${OBJECTS_TABLE} WHERE path = ?`, [path]);
    if (columnsJSON == null) throw new Error(`'${path}' has not been loaded.`);
    return JSON.parse(columnsJSON as string) as StoredColumn[];
}

// eslint-disable-next-line sonarjs/function-return-type -- A bound value is one of several types, by its column.
function toBindableValue(value: StoreValue, storedColumn: StoredColumn | undefined): BindableValue {
    if (value instanceof Date) return storedColumn?.isDayNumber === true ? Math.floor(value.getTime() / MILLISECONDS_PER_DAY) : value.getTime();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}
