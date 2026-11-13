// ── External Dependencies & Registrations
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { OpfsSAHPoolDatabase, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

// ── DPUse Framework
import { acquireWebLock, normalizeToError, resolveRequestSignal, resolveStorePath } from '@dpuse/dpuse-shared';
import type {
    ConnectionNodeConfig,
    ConnectorInterface,
    ConnectorUtilities,
    DropObjectOptions,
    ListNodesOptions,
    ListNodesResult,
    LoadObjectRecordsOptions,
    LoadObjectRecordsResult,
    OpenStoreResult,
    QueryRecordsOptions,
    QueryRecordsResult,
    StoreRecord,
    ToolConfig
} from '@dpuse/dpuse-shared';

// ── Local Framework
import { dropStoreObject, listStoreObjectNames, loadStoreObject, queryStoreObject } from '@/sqliteStore';

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATABASE_FILE_PATTERN = /^\/([\w-]+)\.sqlite3$/u; // A database's file in the pool. Its journal, '….sqlite3-journal', does not match.
const DEFAULT_DATABASE_NAME = 'default'; // Used by a path that names no database, so 'orders' and '/default/orders' are the same table.
const FILES_PER_DATABASE = 2; // The database file, and the journal written beside it while a change is saved.
const LOCK_NAME = 'dpuse-connector-sqlite-wasm'; // Held by the one tab that has the store open.
const POOL_NAME = 'dpuse-connector-sqlite-wasm';

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
    pendingSqlite: Promise<Sqlite3Static> | undefined;
    poolUtility: SAHPoolUtil | undefined;
    releaseLock: (() => void) | undefined;

    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]) {
        this.connectorUtilities = connectorUtilities;
        this.databases = new Map();
        this.pendingSqlite = undefined;
        this.poolUtility = undefined;
        this.releaseLock = undefined;
        this.toolConfigs = toolConfigs;
    }

    // ── Operations ───────────────────────────────────────────────────────────────────────────────────────────────────

    // The pool keeps its files open until it is paused, which would stop another tab opening the store after this one
    // has closed it.
    closeStore(): Promise<void> {
        try {
            for (const database of this.databases.values()) database.close();
            this.databases.clear();
            if (this.poolUtility?.isPaused() === false) this.poolUtility.pauseVfs();
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(normalizeToError(error));
        } finally {
            this.releaseHeldLock();
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

    // Each database is a folder at the top, holding its tables. A database is found from its file in the pool, so one not
    // used since the store opened is listed too.
    async listNodes(options: ListNodesOptions): Promise<ListNodesResult> {
        try {
            await this.openStoreForListing();
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

    async openStore(): Promise<OpenStoreResult> {
        if (this.databases.size > 0) return { storeStateId: 'ready' };
        const releaseLock = await acquireWebLock(LOCK_NAME); // Held until the store closes.
        if (releaseLock == null) return { storeStateId: 'heldElsewhere' };
        this.releaseLock = releaseLock;
        try {
            const sqlite3 = await this.loadSqlite();
            const poolUtility = await this.establishPool(sqlite3);
            if (!poolUtility) {
                this.releaseHeldLock();
                return { storeStateId: 'unavailable' };
            }
            const defaultDatabase = new poolUtility.OpfsSAHPoolDb(`/${DEFAULT_DATABASE_NAME}.sqlite3`);
            this.databases.set(DEFAULT_DATABASE_NAME, defaultDatabase);
            return { storeStateId: 'ready' };
        } catch (error) {
            this.releaseHeldLock();
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

    // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

    // Opens a named database on first use. The pool holds a set number of files, so it is grown first when it has too
    // few free for another database.
    private async establishDatabase(path: string): Promise<{ database: OpfsSAHPoolDatabase; tableName: string }> {
        const poolUtility = this.establishOpenPool();
        const { databaseName = DEFAULT_DATABASE_NAME, tableName } = resolveStorePath(path);
        if (!this.databases.has(databaseName) && poolUtility.getCapacity() - poolUtility.getFileCount() < FILES_PER_DATABASE) await poolUtility.addCapacity(FILES_PER_DATABASE);
        return { database: this.openDatabase(databaseName), tableName };
    }

    private establishOpenPool(): SAHPoolUtil {
        if (this.poolUtility == null || this.databases.size === 0) throw new Error('The store is not open.');
        return this.poolUtility;
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

    // Items can be listed before any data view has opened the store, so listing opens it first. The store then stays open
    // until it is closed, as it does for a data view.
    private async openStoreForListing(): Promise<void> {
        const { storeStateId } = await this.openStore();
        if (storeStateId === 'heldElsewhere') throw new Error('The store is open in another tab.');
        if (storeStateId === 'unavailable') throw new Error('This browser gives no storage to keep the store in, as in some private windows.');
    }

    private releaseHeldLock(): void {
        this.releaseLock?.();
        this.releaseLock = undefined;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

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
