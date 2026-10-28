import { Connector } from '@/index';
import { describe, expect, it } from 'vitest';

describe('Connector', () => {
    it('constructs with the static config and no active operation', () => {
        const connector = new Connector({} as never, []);
        expect(connector.config.id).toBe('dpuse-connector-sqlite-wasm');
        expect(connector.abortController).toBeUndefined();
    });

    it('abortOperation is a no-op when nothing is running', () => {
        const connector = new Connector({} as never, []);
        expect(() => {
            connector.abortOperation();
        }).not.toThrow();
        expect(connector.abortController).toBeUndefined();
    });

    it('refuses store actions until the store is open', async () => {
        const connector = new Connector({} as never, []);
        const queryOptions = { aggregates: [], filters: [], groupColumnIndexes: [], limit: 1, offset: 0, path: 'sales', sorts: [] };

        await expect(connector.queryRecords(queryOptions)).rejects.toThrow('The store is not open.');
        await expect(connector.dropObject({ path: 'sales' })).rejects.toThrow('The store is not open.');
    });

    it('closes without error when the store was never opened', async () => {
        await expect(new Connector({} as never, []).closeStore()).resolves.toBeUndefined();
    });
});
