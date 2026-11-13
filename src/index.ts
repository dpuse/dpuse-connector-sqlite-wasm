// ── External Dependencies & Registrations
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database, OpfsSAHPoolDatabase, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

// ── DPUse Framework
import { acquireWebLock, convertStoreRecordToParsedRecord, normalizeToError, resolveRequestSignal, resolveStorePath } from '@dpuse/dpuse-shared';
import type {
    AuditObjectContentOptions,
    AuditObjectContentResult,
    ColumnAuditConfig,
    ConnectionNodeConfig,
    ConnectorInterface,
    ConnectorUtilities,
    ContentAuditConfig,
    DeclaredColumnConfig,
    DropObjectOptions,
    FindObjectOptions,
    FindObjectResult,
    ListNodesOptions,
    ListNodesResult,
    LoadObjectRecordsOptions,
    LoadObjectRecordsResult,
    ObjectColumnConfig,
    OpenStoreResult,
    PreviewObjectOptions,
    PreviewObjectResult,
    QueryRecordsOptions,
    QueryRecordsResult,
    ReadingConfig,
    RetrieveRecordsChunk,
    RetrieveRecordsOptions,
    RetrieveRecordsSummary,
    StoreRecord,
    ToolConfig
} from '@dpuse/dpuse-shared';

// ── Local Framework
import { readStoreObjectRecords } from '@/sqliteStore';
import { countStoreObjectRecords, describeStoreObject, dropStoreObject, listStoreObjectNames, loadStoreObject, queryStoreObject } from '@/sqliteStore';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A table a source action reads, with its columns as they were created.
interface SourceTable {
    columnConfigs: ObjectColumnConfig[];
    database: Database;
    tableName: string;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATABASE_FILE_PATTERN = /^\/([\w-]+)\.sqlite3$/u; // A database's file in the pool. Its journal, '….sqlite3-journal', does not match.
const DEFAULT_CHUNK_SIZE = 10_000; // Records read at a time by an audit or a retrieve.
const DEFAULT_DATABASE_NAME = 'default'; // Used by a path that names no database, so 'orders' and '/default/orders' are the same table.
const FILES_PER_DATABASE = 2; // The database file, and the journal written beside it while a change is saved.
const LOCK_NAME = 'dpuse-connector-sqlite-wasm'; // Held by the one tab that has the store open.
const POOL_NAME = 'dpuse-connector-sqlite-wasm';
const PREVIEW_RECORD_COUNT = 50;

// The package's own types declare no options, but its loader accepts Emscripten's 'locateFile'.
const initialiseSqliteModule = sqlite3InitModule as (moduleArgument: { locateFile: (path: string) => string }) => Promise<Sqlite3Static>;

// ── Connector ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Keeps data views in SQLite databases saved in the browser's private file system (OPFS). A path '/database/table' names
// its database, and each database is a file of its own, opened on first use. Only one tab can open the store, so opening
// takes a Web Lock first and closing releases it, for every database at once.
export class Connector implements ConnectorInterface {
    private readonly connectorUtilities: ConnectorUtilities;
    private readonly toolConfigs;
    databases: Map<string, OpfsSAHPoolDatabase>; // By database name.
    pendingCloseStore: Promise<void> | undefined;
    pendingOpenStore: Promise<OpenStoreResult> | undefined;
    pendingSqlite: Promise<Sqlite3Static> | undefined;
    poolUtility: SAHPoolUtil | undefined;
    releaseLock: (() => Promise<void>) | undefined;

    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]) {
        this.connectorUtilities = connectorUtilities;
        this.databases = new Map();
        this.pendingCloseStore = undefined;
        this.pendingOpenStore = undefined;
        this.pendingSqlite = undefined;
        this.poolUtility = undefined;
        this.releaseLock = undefined;
        this.toolConfigs = toolConfigs;
    }

    // ── Operations ───────────────────────────────────────────────────────────────────────────────────────────────────

    // A table's columns have the types they were created with, so the audit counts values against them rather than
    // working types out. A table has no bytes, so 'byteLimit' does not apply, and the audit reads every record unless
    // 'stopSignal' fires.
    async auditObjectContent(options: AuditObjectContentOptions, chunk: (recordCount: number, byteCount: number) => void): Promise<AuditObjectContentResult> {
        const signal = resolveRequestSignal(options);
        try {
            const asAt = Date.now();
            const startedAt = performance.now();
            await this.openStoreForReading();
            const sourceTable = this.establishSourceTable(options.path);
            const columnAuditor = this.connectorUtilities.constructColumnAuditor(false, constructDeclaredColumnConfigs(sourceTable.columnConfigs));
            let recordCount = 0;
            let isComplete = true;
            const recordChunks = readRecordChunks(sourceTable, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
            for await (const records of recordChunks) {
                signal.throwIfAborted();
                if (options.stopSignal?.aborted === true) {
                    isComplete = false;
                    break;
                }
                columnAuditor.auditRecords(records.map((record) => convertStoreRecordToParsedRecord(record)));
                recordCount += records.length;
                chunk(records.length, 0);
            }
            const { columnConfigs } = columnAuditor.completeAudit();
            return { contentAuditConfig: constructContentAuditConfig(asAt, startedAt, columnConfigs, recordCount, isComplete), hasHeaders: false }; // A table's columns are named by the database, not by a header record.
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // The pool keeps its files open until it is paused, which would stop another tab opening the store after this one
    // has closed it. An open that arrives while a close is still releasing the lock, such as when a screen closes the
    // store and the next one opens it, waits for the close, so it does not find the lock still held.
    async closeStore(): Promise<void> {
        const pendingCloseStore = this.endStore();
        this.pendingCloseStore = pendingCloseStore;
        try {
            await pendingCloseStore;
        } finally {
            if (this.pendingCloseStore === pendingCloseStore) this.pendingCloseStore = undefined;
        }
    }

    async dropObject(options: DropObjectOptions): Promise<void> {
        try {
            const { database, tableName } = await this.establishDatabase(options.path);
            dropStoreObject(database, tableName);
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // An object's id is its path, so finding it only checks that it is there.
    async findObject(options: FindObjectOptions): Promise<FindObjectResult> {
        try {
            await this.openStoreForReading();
            return { path: this.findSourceTable(options.id) == null ? undefined : options.id };
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // Each database is a folder at the top, holding its tables. A database is found from its file in the pool, so one not
    // used since the store opened is listed too.
    async listNodes(options: ListNodesOptions): Promise<ListNodesResult> {
        try {
            await this.openStoreForReading();
            const connectionNodeConfigs = options.folderPath === '' ? this.listTopNodes() : this.listDatabaseNodes(options.folderPath);
            return { cursor: undefined, connectionNodeConfigs, isMore: false, totalCount: connectionNodeConfigs.length };
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    async loadObjectRecords(options: LoadObjectRecordsOptions, chunks: AsyncIterable<StoreRecord[]>): Promise<LoadObjectRecordsResult> {
        try {
            const { database, tableName } = await this.establishDatabase(options.path);
            const recordCount = await loadStoreObject(database, tableName, options.columnConfigs, chunks, resolveRequestSignal(options));
            return { recordCount };
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // Requests that arrive while the store is opening share the one open. A second open would find the lock taken by the
    // first and report the store as open in another tab.
    async openStore(): Promise<OpenStoreResult> {
        if (this.databases.size > 0) return { storeStateId: 'ready' };
        try {
            await this.pendingCloseStore;
        } catch {
            // A close that failed has still released the lock.
        }
        this.pendingOpenStore ??= this.startStore();
        try {
            return await this.pendingOpenStore;
        } finally {
            this.pendingOpenStore = undefined; // A failed open is forgotten, so the next request tries again.
        }
    }

    // A table's columns and their types come from the table itself, so nothing is detected and the user has nothing to
    // choose. The sample is shown as text, as a file's is.
    async previewObject(options: PreviewObjectOptions): Promise<PreviewObjectResult> {
        try {
            const asAt = Date.now();
            const startedAt = performance.now();
            await this.openStoreForReading();
            const { columnConfigs, database, tableName } = this.establishSourceTable(options.path);
            const { records } = readStoreObjectRecords(database, tableName, columnConfigs, PREVIEW_RECORD_COUNT, undefined);
            const totalCount = countStoreObjectRecords(database, tableName);
            const parsedRecords = records.map((record) => convertStoreRecordToParsedRecord(record));
            const inferenceSummary = this.connectorUtilities.inferDataTypes(parsedRecords, false, constructDeclaredColumnConfigs(columnConfigs));
            return {
                contentAuditConfig: constructContentAuditConfig(asAt, startedAt, inferenceSummary.columnConfigs, records.length, records.length === totalCount),
                readingConfig: constructReadingConfig(),
                sampleConfig: { hasHeaders: false, issues: [], parsedRecords, size: undefined, text: undefined }
            };
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    async queryRecords(options: QueryRecordsOptions): Promise<QueryRecordsResult> {
        try {
            const { database, tableName } = await this.establishDatabase(options.path);
            return queryStoreObject(database, { ...options, path: tableName });
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // Hands over each chunk typed, as the store holds it. Nothing more is read until the next chunk is asked for.
    async *retrieveRecords(options: RetrieveRecordsOptions): AsyncGenerator<RetrieveRecordsChunk, RetrieveRecordsSummary, undefined> {
        const signal = resolveRequestSignal(options);
        try {
            await this.openStoreForReading();
            const sourceTable = this.establishSourceTable(options.path);
            let recordCount = 0;
            const recordChunks = readRecordChunks(sourceTable, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
            for await (const records of recordChunks) {
                signal.throwIfAborted();
                yield { records, typeId: 'storeRecordArray' };
                recordCount += records.length;
            }
            return { recordCount };
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

    // Opens a named database on first use. The pool holds a set number of files, so it is grown first when it has too
    // few free for another database.
    private async establishDatabase(path: string): Promise<{ database: OpfsSAHPoolDatabase; tableName: string }> {
        const poolUtility = this.establishOpenPool();
        const { databaseName = DEFAULT_DATABASE_NAME, tableName } = resolveStorePath(path);
        if (!this.databases.has(databaseName) && poolUtility.getCapacity() - poolUtility.getFileCount() < FILES_PER_DATABASE) await poolUtility.addCapacity(FILES_PER_DATABASE);
        return { database: this.openDatabase(databaseName), tableName };
    }

    private async endStore(): Promise<void> {
        try {
            for (const database of this.databases.values()) database.close();
            this.databases.clear();
            if (this.poolUtility?.isPaused() === false) this.poolUtility.pauseVfs();
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            await this.releaseHeldLock();
        }
    }

    // Throws when there is no such table.
    private establishSourceTable(path: string): SourceTable {
        const sourceTable = this.findSourceTable(path);
        if (sourceTable == null) throw new Error(`'${path}' does not exist.`);
        return sourceTable;
    }

    private establishOpenPool(): SAHPoolUtil {
        if (this.poolUtility == null || this.databases.size === 0) throw new Error('The store is not open.');
        return this.poolUtility;
    }

    // A source action reads a table that is already there, so a database with no file is never opened, because opening it
    // would create it. Undefined when there is no such table.
    private findSourceTable(path: string): SourceTable | undefined {
        const { databaseName = DEFAULT_DATABASE_NAME, tableName } = resolveStorePath(path);
        if (!this.listDatabaseNames().includes(databaseName)) return undefined;
        const database = this.openDatabase(databaseName);
        const columnConfigs = describeStoreObject(database, tableName);
        return columnConfigs.length === 0 ? undefined : { columnConfigs, database, tableName };
    }

    // Returns nothing when the browser gives no private file system, e.g. in some private windows.
    private async establishPool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil | undefined> {
        try {
            if (this.poolUtility) return this.poolUtility.isPaused() ? await this.poolUtility.unpauseVfs() : this.poolUtility;
            this.poolUtility = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
            return this.poolUtility;
        } catch {
            return undefined;
        }
    }

    // Loads the '.wasm' file from beside this connector's own script, wherever that is served from. A failed load is
    // forgotten, so the next open tries again.
    private loadSqlite(): Promise<Sqlite3Static> {
        this.pendingSqlite ??= this.initialiseSqlite();
        return this.pendingSqlite;
    }

    private async initialiseSqlite(): Promise<Sqlite3Static> {
        try {
            return await initialiseSqliteModule({ locateFile: (path) => new URL(path, import.meta.url).href });
        } catch (error) {
            this.pendingSqlite = undefined;
            throw normalizeToError(error);
        }
    }

    // A folder path names one database, as '/database'. Listing never creates a database, so one with no file is refused.
    private listDatabaseNodes(folderPath: string): ConnectionNodeConfig[] {
        const databaseName = /^\/([\w-]+)$/u.exec(folderPath)?.[1];
        if (databaseName == null) throw new Error(`Encountered invalid folder path '${folderPath}'.`);
        if (!this.listDatabaseNames().includes(databaseName)) throw new Error(`Database '${databaseName}' does not exist.`);
        const database = this.openDatabase(databaseName);
        return listStoreObjectNames(database).map((tableName) => constructObjectNodeConfig(folderPath, tableName, `${folderPath}/${tableName}`));
    }

    private listDatabaseNames(): string[] {
        return this.establishOpenPool()
            .getFileNames()
            .map((fileName) => DATABASE_FILE_PATTERN.exec(fileName)?.[1])
            .filter((databaseName): databaseName is string => databaseName != null)
            .toSorted((left, right) => left.localeCompare(right));
    }

    private listTopNodes(): ConnectionNodeConfig[] {
        return this.listDatabaseNames().map((databaseName) => constructFolderNodeConfig(databaseName, listStoreObjectNames(this.openDatabase(databaseName)).length));
    }

    // Opens a database on first use. The default database is opened with the store.
    private openDatabase(databaseName: string): OpfsSAHPoolDatabase {
        const poolUtility = this.establishOpenPool();
        let database = this.databases.get(databaseName);
        if (database == null) {
            database = new poolUtility.OpfsSAHPoolDb(`/${databaseName}.sqlite3`);
            this.databases.set(databaseName, database);
        }
        return database;
    }

    // A connection's items can be listed and read before any data view has opened the store, so reading opens it first.
    // The store then stays open until it is closed, as it does for a data view.
    private async openStoreForReading(): Promise<void> {
        const { storeStateId } = await this.openStore();
        if (storeStateId === 'heldElsewhere') throw new Error('The store is open in another tab.');
        if (storeStateId === 'unavailable') throw new Error('This browser gives no storage to keep the store in, as in some private windows.');
    }

    // Resolves once the lock is free for the next open.
    private async releaseHeldLock(): Promise<void> {
        const releaseLock = this.releaseLock;
        this.releaseLock = undefined;
        await releaseLock?.();
    }

    // Waits for the lock, so the store is only ever opened by the tab that holds it.
    private async startStore(): Promise<OpenStoreResult> {
        const releaseLock = await acquireWebLock(LOCK_NAME); // Held until the store closes.
        if (releaseLock == null) return { storeStateId: 'heldElsewhere' };
        this.releaseLock = releaseLock;
        try {
            const sqlite3 = await this.loadSqlite();
            const poolUtility = await this.establishPool(sqlite3);
            if (!poolUtility) {
                await this.releaseHeldLock();
                return { storeStateId: 'unavailable' };
            }
            const defaultDatabase = new poolUtility.OpfsSAHPoolDb(`/${DEFAULT_DATABASE_NAME}.sqlite3`);
            this.databases.set(DEFAULT_DATABASE_NAME, defaultDatabase);
            return { storeStateId: 'ready' };
        } catch (error) {
            await this.releaseHeldLock();
            throw normalizeToError(error);
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// A table has no bytes, lines or comments, so only its records are counted.
function constructContentAuditConfig(asAt: number, startedAt: number, columnConfigs: ColumnAuditConfig[], recordCount: number, isComplete: boolean): ContentAuditConfig {
    return {
        asAt,
        byteCount: 0,
        columns: columnConfigs,
        commentLineCount: undefined,
        duration: performance.now() - startedAt,
        emptyLineCount: undefined,
        invalidFieldLengthCount: undefined,
        isComplete,
        lineCount: undefined,
        recordCount,
        sourceWaitDuration: undefined
    };
}

// A table's columns have types but no audited counts, so the preview and audit take the types rather than work them
// out. A column with no known type is left for them to work out.
function constructDeclaredColumnConfigs(columnConfigs: ObjectColumnConfig[]): DeclaredColumnConfig[] {
    return columnConfigs.map((columnConfig) => ({
        dataSubtypeId: columnConfig.dataSubtypeId,
        dataTypeId: columnConfig.dataTypeId === 'unknown' ? undefined : columnConfig.dataTypeId,
        label: undefined,
        name: columnConfig.label.en ?? ''
    }));
}

// A database's folder is named and identified by the database's name, which a path to one of its tables starts with.
function constructFolderNodeConfig(databaseName: string, childCount: number): ConnectionNodeConfig {
    return {
        childCount,
        description: '',
        extension: undefined,
        folderPath: '',
        icon: null,
        iconDark: null,
        id: databaseName,
        label: databaseName,
        lastModifiedAt: undefined,
        mimeType: undefined,
        name: databaseName,
        size: undefined,
        typeId: 'folder'
    };
}

// A table is identified by its path, as the other actions take it.
function constructObjectNodeConfig(folderPath: string, tableName: string, path: string): ConnectionNodeConfig {
    return {
        childCount: undefined,
        description: '',
        extension: undefined,
        folderPath,
        icon: null,
        iconDark: null,
        id: path,
        label: tableName,
        lastModifiedAt: undefined,
        mimeType: undefined,
        name: tableName,
        size: undefined,
        typeId: 'object'
    };
}

// A table is not a file, so it has no data format, encoding or delimiter, and its columns are named by the database.
function constructReadingConfig(): ReadingConfig {
    return {
        dataFormatId: 'unknown',
        encodingConfidenceLevel: undefined,
        encodingId: undefined,
        fileType: undefined,
        hasHeaders: false,
        isDeclared: true,
        parserId: undefined,
        recordDelimiterId: undefined,
        valueDelimiterId: undefined
    };
}

// Every record of a table, a chunk at a time, ending with the first chunk that is not full. SQLite reads without
// waiting, so each chunk waits for the worker's other messages first. Otherwise a request to stop or abort could not
// arrive until the whole table had been read.
async function* readRecordChunks(sourceTable: SourceTable, chunkSize: number): AsyncGenerator<StoreRecord[]> {
    let afterRowId: number | undefined;
    for (;;) {
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        const { lastRowId, records } = readStoreObjectRecords(sourceTable.database, sourceTable.tableName, sourceTable.columnConfigs, chunkSize, afterRowId);
        if (records.length > 0) yield records;
        if (lastRowId == null || records.length < chunkSize) return;
        afterRowId = lastRowId;
    }
}
