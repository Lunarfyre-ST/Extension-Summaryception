import { describe, expect, it } from 'vitest';
import { measureSummaryEfficiency } from '../src/core/summary-efficiency.js';
import { installSummaryContext, makeMessages } from './test-helpers.js';

describe('summary efficiency', () => {
    it('deduplicates source messages across layers and compares the complete injected memory', async () => {
        const chat = makeMessages(3, { mes: 'hello' });
        installSummaryContext({ chat, getTokenCountAsync: async (text) => text.length });
        const result = await measureSummaryEfficiency(
            chat,
            [
                [{ sourceMessageIds: ['message-0', 'message-1'] }],
                [{ sourceMessageIds: ['message-0'] }],
            ],
            { count: 10, estimated: false },
        );
        expect(result.original.count).toBe('Assistant: hello\nAssistant: hello'.length);
        expect(result.efficiency).toBeCloseTo((1 - 10 / result.original.count) * 100);
    });

    it('does not claim a saving when sources are unavailable or provenance is missing', async () => {
        const chat = makeMessages(1);
        installSummaryContext({ chat });
        for (const layers of [
            [],
            [[{ sourceMessageIds: ['missing'] }]],
            [[{ text: 'Imported' }]],
        ]) {
            const result = await measureSummaryEfficiency(chat, layers, {
                count: 10,
                estimated: false,
            });
            expect(result.original).toBeNull();
            expect(result.efficiency).toBeNull();
        }
    });

    it('reports a negative saving when memory is larger than its sources', async () => {
        const chat = makeMessages(1, { mes: 'hello' });
        installSummaryContext({ chat, getTokenCountAsync: async (text) => text.length });
        const result = await measureSummaryEfficiency(
            chat,
            [[{ sourceMessageIds: ['message-0'] }]],
            { count: 32, estimated: false },
        );
        expect(result.efficiency).toBeLessThan(0);
    });
});
