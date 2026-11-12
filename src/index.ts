// ── External Dependencies & Registrations
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { OpfsSAHPoolDatabase, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

// ── DPUse Framework
import { acquireWebLock, normalizeToError, resolveRequestSignal, resolveStorePath } from '@dpuse/dpuse-shared';
import type {
    ConnectorInterface,
    ConnectorUtilities,
    DropObjectOptions,
    LoadObjectRecordsOptions,
    LoadObjectRecordsResult,
    OpenStoreResult,
    QueryRecordsOptions,
    QueryRecordsResult,
    StoreRecord,
    ToolConfig
} from '@dpuse/dpuse-shared';

// ── Local Framework
import { dropStoreObject, loadStoreObject, queryStoreObject } from '@/sqliteStore';

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_DATABASE_PATH = '/dpuse-store.sqlite3'; // Used by a path that names no database.
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
    databases: Map<string, OpfsSAHPoolDatabase>; // By database name. The default database's name is ''.
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
            const defaultDatabase = new poolUtility.OpfsSAHPoolDb(DEFAULT_DATABASE_PATH);
            this.databases.set('', defaultDatabase);
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
        const poolUtility = this.poolUtility;
        if (poolUtility == null || this.databases.size === 0) throw new Error('The store is not open.');
        const { databaseName = '', tableName } = resolveStorePath(path);
        let database = this.databases.get(databaseName);
        if (database == null) {
            if (poolUtility.getCapacity() - poolUtility.getFileCount() < FILES_PER_DATABASE) await poolUtility.addCapacity(FILES_PER_DATABASE);
            database = new poolUtility.OpfsSAHPoolDb(`/${databaseName}.sqlite3`);
            this.databases.set(databaseName, database);
        }
        return { database, tableName };
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

    private releaseHeldLock(): void {
        this.releaseLock?.();
        this.releaseLock = undefined;
    }
}
