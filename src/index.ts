// ── External Dependencies & Registrations
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { OpfsSAHPoolDatabase, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

// ── DPUse Framework
import { normalizeToError } from '@dpuse/dpuse-shared';
import type {
    ConnectorConfig,
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
import { dropStoreObject, ensureObjectsTable, loadStoreObject, queryStoreObject } from '@/sqliteStore';

// ── Data
import config from '~/config.json';

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATABASE_PATH = '/dpuse-store.sqlite3';
const LOCK_NAME = 'dpuse-connector-sqlite-wasm'; // Held by the one tab that has the store open.
const POOL_NAME = 'dpuse-connector-sqlite-wasm';

// The package's own types declare no options, but its loader accepts Emscripten's 'locateFile'.
const initialiseSqliteModule = sqlite3InitModule as (moduleArgument: { locateFile: (path: string) => string }) => Promise<Sqlite3Static>;

// ── Connector ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Keeps data views in one SQLite database saved in the browser's private file system (OPFS). Only one tab can open the
// database, so opening takes a Web Lock first and closing releases it.
export class Connector implements ConnectorInterface {
    abortController: AbortController | undefined;
    readonly config: ConnectorConfig;
    connectorUtilities: ConnectorUtilities;
    database: OpfsSAHPoolDatabase | undefined;
    pendingSqlite: Promise<Sqlite3Static> | undefined;
    poolUtility: SAHPoolUtil | undefined;
    releaseLock: (() => void) | undefined;
    readonly toolConfigs;

    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]) {
        this.abortController = undefined;
        this.config = config as ConnectorConfig;
        this.connectorUtilities = connectorUtilities;
        this.database = undefined;
        this.pendingSqlite = undefined;
        this.poolUtility = undefined;
        this.releaseLock = undefined;
        this.toolConfigs = toolConfigs;
    }

    // ── Operations ───────────────────────────────────────────────────────────────────────────────────────────────────

    abortOperation(): void {
        if (!this.abortController) return;
        this.abortController.abort();
        this.abortController = undefined;
    }

    // The pool keeps its files open until it is paused, which would stop another tab opening the store after this one
    // has closed it.
    closeStore(): Promise<void> {
        try {
            this.database?.close();
            this.database = undefined;
            if (this.poolUtility?.isPaused() === false) this.poolUtility.pauseVfs();
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(normalizeToError(error));
        } finally {
            this.releaseHeldLock();
        }
    }

    dropObject(options: DropObjectOptions): Promise<void> {
        try {
            dropStoreObject(this.establishDatabase(), options.path);
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(normalizeToError(error));
        }
    }

    async loadObjectRecords(options: LoadObjectRecordsOptions, chunks: AsyncIterable<StoreRecord[]>): Promise<LoadObjectRecordsResult> {
        this.abortController = new AbortController();
        try {
            const recordCount = await loadStoreObject(this.establishDatabase(), options.path, options.columnConfigs, chunks, this.abortController.signal);
            return { recordCount };
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    async openStore(): Promise<OpenStoreResult> {
        if (this.database) return { storeStateId: 'ready' };
        if (!(await this.acquireLock())) return { storeStateId: 'heldElsewhere' };
        try {
            const sqlite3 = await this.loadSqlite();
            const poolUtility = await this.establishPool(sqlite3);
            if (!poolUtility) {
                this.releaseHeldLock();
                return { storeStateId: 'unavailable' };
            }
            this.database = new poolUtility.OpfsSAHPoolDb(DATABASE_PATH);
            ensureObjectsTable(this.database);
            return { storeStateId: 'ready' };
        } catch (error) {
            this.releaseHeldLock();
            throw normalizeToError(error);
        }
    }

    queryRecords(options: QueryRecordsOptions): Promise<QueryRecordsResult> {
        try {
            return Promise.resolve(queryStoreObject(this.establishDatabase(), options));
        } catch (error) {
            return Promise.reject(normalizeToError(error));
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

    // Asks for the lock without waiting, so a tab that cannot have it is told at once. The lock is held until
    // 'releaseHeldLock' is called.
    // A request that fails, e.g. where Web Locks are blocked, ends first and so rejects.
    async acquireLock(): Promise<boolean> {
        const lockAcquisition = Promise.withResolvers<boolean>();
        const lockRequest = navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
            if (lock == null) {
                lockAcquisition.resolve(false);
                return;
            }
            lockAcquisition.resolve(true);
            return new Promise<void>((release) => {
                this.releaseLock = release;
            });
        });
        const endedRequest = (async (): Promise<boolean> => {
            await lockRequest;
            return false;
        })();
        return await Promise.race([lockAcquisition.promise, endedRequest]);
    }

    establishDatabase(): OpfsSAHPoolDatabase {
        if (!this.database) throw new Error('The store is not open.');
        return this.database;
    }

    // Returns nothing when the browser gives no private file system, e.g. in some private windows.
    async establishPool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil | undefined> {
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
    loadSqlite(): Promise<Sqlite3Static> {
        this.pendingSqlite ??= this.initialiseSqlite();
        return this.pendingSqlite;
    }

    async initialiseSqlite(): Promise<Sqlite3Static> {
        try {
            return await initialiseSqliteModule({ locateFile: (path) => new URL(path, import.meta.url).href });
        } catch (error) {
            this.pendingSqlite = undefined;
            throw normalizeToError(error);
        }
    }

    releaseHeldLock(): void {
        this.releaseLock?.();
        this.releaseLock = undefined;
    }
}
