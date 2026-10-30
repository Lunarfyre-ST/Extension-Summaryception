import { resolveScIdsToIndices } from '../foundation/message-identity.js';
import { formatMessageSpeakerLine } from './chatutils.js';
import { collectSnippetSourceIds } from './snippet-provenance.js';
import { countTextTokens } from './token-count.js';

/**
 * Compare the current memory injection with its distinct original source messages.
 * @param {ChatMessage[]} chat
 * @param {Array<Array<SummaryceptionSnippet>>} layers
 * @param {import('./token-count.js').TokenCount} summaryTokens
 */
export async function measureSummaryEfficiency(chat, layers, summaryTokens) {
    const snippets = (layers || []).flat().filter(Boolean);
    const ids = collectSnippetSourceIds(layers);
    const indices = resolveScIdsToIndices(chat, ids);
    const complete =
        snippets.length > 0 &&
        snippets.every(
            (snippet) =>
                Array.isArray(snippet.sourceMessageIds) && snippet.sourceMessageIds.length > 0,
        ) &&
        ids.length > 0 &&
        indices.length === ids.length;
    if (!complete) return { original: null, summary: summaryTokens, efficiency: null };
    const originalText = indices
        .map((index) => {
            const message = chat[index];
            return formatMessageSpeakerLine(message, String(message.mes || '').trim());
        })
        .join('\n');
    const original = await countTextTokens(originalText);
    const efficiency = original.count > 0 ? (1 - summaryTokens.count / original.count) * 100 : null;
    return { original, summary: summaryTokens, efficiency };
}
