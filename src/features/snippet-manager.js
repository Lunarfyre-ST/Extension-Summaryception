import { getChat, getContext } from '../foundation/context.js';
import { resolveScIdsToIndices } from '../foundation/message-identity.js';
import { getChatStore } from '../foundation/chat-store.js';
import { buildPassageFromRangeWithStats } from '../core/chatutils.js';
import { buildPassageNameCensus } from '../core/refusal-guard.js';
import { commitSnippetMutation } from '../core/snippet-commit.js';
import { buildSnippetMetadataFromText } from '../core/snippet-metadata.js';
import { fingerprintSourceRange, getChatIdentity } from '../core/summarizer-snapshot.js';

/**
 * @typedef {{ status: 'ready', snippet: SummaryceptionSnippet, range: [number, number], context?: string }} RegenerationTarget
 * @typedef {{ status: 'missing' } | { status: 'unsupported' } | { status: 'busy' }} RegenerationUnavailable
 * @typedef {{ status: 'regenerated', range: [number, number] } | { status: 'empty-source' } | { status: 'unsupported' } | { status: 'failed' } | { status: 'aborted' } | { status: 'blocked' } | { status: 'stale' }} RegenerationRunResult
 * @typedef {{ status: 'regenerated', range: [number, number] } | { status: 'missing' | 'unsupported' | 'busy' | 'empty-source' | 'failed' | 'aborted' | 'blocked' | 'stale' }} RegenerateSnippetResult
 */

/**
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {{ status: 'found', text: string } | { status: 'missing', text: '' }}
 */
export function getSnippetTextAt(layerIndex, snippetIndex) {
    const snippet = getSnippetAt(getChatStore(), layerIndex, snippetIndex);
    if (!snippet) {
        return { status: 'missing', text: '' };
    }
    return { status: 'found', text: snippet.text };
}

/**
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} queue - Summarizer Queue whose busy state blocks regeneration.
 * @returns {RegenerationTarget | RegenerationUnavailable}
 */
export function getSnippetRegenerationTarget(layerIndex, snippetIndex, queue) {
    return resolveRegenerationTarget(
        getChatStore(),
        getChat(),
        { layerIndex, snippetIndex },
        { queue },
    );
}

/**
 * True for a contiguous Layer 0 source range. Also true while
 * summarization is busy, so the caller can report the busy status.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} queue - Summarizer Queue whose busy state blocks regeneration.
 * @returns {boolean}
 */
export function isRegenerationCandidate(layerIndex, snippetIndex, queue) {
    const target = resolveRegenerationTarget(
        getChatStore(),
        getChat(),
        { layerIndex, snippetIndex },
        {
            queue,
            includeContext: false,
        },
    );
    return target.status === 'ready' || target.status === 'busy';
}

/**
 * @param {SummaryceptionStore} store
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @param {string | undefined} expectedText
 * @returns {SummaryceptionSnippet | null | 'conflict'}
 */
function findEditedSnippet(store, layerIndex, snippetIndex, expectedText) {
    const snippet = getSnippetAt(store, layerIndex, snippetIndex);
    if (expectedText === undefined || snippet?.text === expectedText) {
        return snippet;
    }
    const matches = (store.layers[layerIndex] || []).filter(
        (candidate) => candidate?.text === expectedText,
    );
    return matches.length === 1 ? matches[0] : 'conflict';
}

/**
 * @param {ChatMessage[]} chat
 * @param {[number, number]} range
 * @returns {{ chatId: string, chatRef: ChatMessage[], fingerprint: string }}
 */
function captureRegenerationBasis(chat, range) {
    return {
        chatId: getChatIdentity(getContext()),
        chatRef: chat,
        fingerprint: fingerprintSourceRange(chat, range[0], range[1]),
    };
}

/**
 * @param {{ chatId: string, chatRef: ChatMessage[], fingerprint: string }} basis
 * @param {RegenerationTarget} target
 * @returns {boolean}
 */
function isRegenerationBasisCurrent(basis, target) {
    const chat = getChat();
    if (chat !== basis.chatRef || getChatIdentity(getContext()) !== basis.chatId) {
        return false;
    }
    if (!(getChatStore().layers[0] || []).includes(target.snippet)) {
        return false;
    }
    return fingerprintSourceRange(chat, target.range[0], target.range[1]) === basis.fingerprint;
}

/**
 * An editor opened on a snippet can outlive its index: a background commit or
 * promotion may shift the layer while the user types. `expectedText` is the
 * text the editor opened with; the edit lands only on the snippet that still
 * carries it, so it never overwrites a different snippet.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @param {string} text
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, expectedText?: string }} options
 * @returns {Promise<{ status: 'updated' | 'missing' | 'empty' | 'unchanged' | 'conflict' }>}
 */
export async function updateSnippetTextAt(layerIndex, snippetIndex, text, options) {
    if (options.expectedText !== undefined && String(text).trim() === options.expectedText) {
        return { status: 'unchanged' };
    }
    const store = getChatStore();
    const snippet = findEditedSnippet(store, layerIndex, snippetIndex, options.expectedText);
    if (snippet === 'conflict') {
        return { status: 'conflict' };
    }
    if (!snippet) {
        return { status: 'missing' };
    }

    const newText = String(text).trim();
    if (!newText) {
        return { status: 'empty' };
    }
    if (newText === snippet.text) {
        return { status: 'unchanged' };
    }

    await commitSnippetMutation(
        store,
        () => {
            snippet.text = newText;
            if (layerIndex === 0) {
                Object.assign(snippet, buildSnippetMetadataFromText(newText));
            }
        },
        { gate: options.gate },
    );
    return { status: 'updated' };
}

/**
 * Deletion also repairs any Layer 0 ghosting ownership.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate }} options
 * @returns {Promise<{ status: 'deleted', layerIndex: number } | { status: 'missing' }>}
 */
export async function deleteSnippetAt(layerIndex, snippetIndex, options) {
    const store = getChatStore();
    const layer = store.layers[layerIndex];
    if (!layer || !layer[snippetIndex]) {
        return { status: 'missing' };
    }

    await commitSnippetMutation(
        store,
        () => {
            layer.splice(snippetIndex, 1);
        },
        { gate: options.gate },
    );
    return { status: 'deleted', layerIndex };
}

/**
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @param {{ notify?: import('../core/notify.js').NotifyAdapter, gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue, dispatch: import('../core/summarizer-request.js').SummarizerDispatch['call'], withRun: import('../core/summarizer-usage.js').UsageLedger['withRun'] }} options - Regeneration notices, the Foreground Gate the commit crosses, the Summarizer Queue the run leases, the Summarizer Dispatch the request goes through, and the Usage Ledger scope the call records into.
 * @returns {Promise<RegenerateSnippetResult>}
 */
export async function regenerateSnippetAt(layerIndex, snippetIndex, options) {
    const { notify, gate, queue, dispatch, withRun } = options;
    const target = resolveRegenerationTarget(
        getChatStore(),
        getChat(),
        {
            layerIndex,
            snippetIndex,
        },
        { queue },
    );
    if (target.status !== 'ready') {
        return target;
    }

    const run = queue.beginRun('regeneration');
    try {
        return await withRun('snippet regeneration', async () => {
            return await regenerateSnippetWithTarget(target, notify, gate, dispatch);
        });
    } finally {
        run.end();
    }
}

/**
 * @param {RegenerationTarget} target
 * @param {import('../core/notify.js').NotifyAdapter | undefined} notify - Adapter for regeneration notices.
 * @param {import('../core/foreground-gate.js').ForegroundGate} gate - Foreground Gate the commit crosses.
 * @param {import('../core/summarizer-request.js').SummarizerDispatch['call']} dispatch - Summarizer Dispatch the request goes through.
 * @returns {Promise<RegenerationRunResult>}
 */
async function regenerateSnippetWithTarget(target, notify, gate, dispatch) {
    const chat = getChat();
    const [rangeStart, rangeEnd] = target.range;
    const passage = await buildPassageFromRangeWithStats(chat, rangeStart, rangeEnd);
    if (!passage.text.trim()) {
        return { status: 'empty-source' };
    }
    const basis = captureRegenerationBasis(chat, target.range);

    const outcome = await dispatch({
        storyTxt: passage.text,
        contextStr: /** @type {string} */ (target.context),
        metadata: {
            kind: 'regenerate',
            sourceRange: target.range,
            regexStats: passage.stats,
            passageNames: buildPassageNameCensus(passage.text).join(', '),
        },
        notify,
    });

    if (outcome.status !== 'completed') {
        return { status: outcome.status };
    }
    const newSummary = outcome.text;
    // The request can take a while: a chat switch, a Clear, a delete, or an
    // edit of the source turns in the meantime makes the result stale.
    if (!isRegenerationBasisCurrent(basis, target)) {
        return { status: 'stale' };
    }

    await commitSnippetMutation(
        getChatStore(),
        () => {
            target.snippet.text = newSummary;
            target.snippet.timestamp = Date.now();
            target.snippet.regenerated = true;
            Object.assign(target.snippet, buildSnippetMetadataFromText(newSummary));
        },
        { gate },
    );
    return { status: 'regenerated', range: target.range };
}

/**
 * Single source of truth for regeneration targets, shared by the UI check
 * and the regeneration runner. A target is ready only for a contiguous
 * Layer 0 source range while no summarization is running.
 * @param {SummaryceptionStore} store
 * @param {ChatMessage[]} chat
 * @param {{ layerIndex: number, snippetIndex: number }} position
 * @param {{ queue: import('../core/summarizer-queue.js').SummarizerQueue, includeContext?: boolean }} options - The Summarizer Queue whose busy state blocks regeneration; skip context building for status-only callers.
 * @returns {RegenerationTarget | RegenerationUnavailable}
 */
function resolveRegenerationTarget(store, chat, position, { queue, includeContext = true }) {
    const { layerIndex, snippetIndex } = position;
    const snippet = getSnippetAt(store, layerIndex, snippetIndex);
    if (!snippet) {
        return { status: 'missing' };
    }
    const indices = Array.isArray(snippet.sourceMessageIds)
        ? resolveScIdsToIndices(chat, snippet.sourceMessageIds)
        : [];
    if (
        layerIndex !== 0 ||
        indices.length === 0 ||
        indices[indices.length - 1] - indices[0] + 1 !== indices.length
    ) {
        return { status: 'unsupported' };
    }
    if (queue.isBusy()) {
        return { status: 'busy' };
    }

    return {
        status: 'ready',
        snippet,
        range: /** @type {[number, number]} */ ([indices[0], indices[indices.length - 1]]),
        ...(includeContext
            ? { context: buildSnippetContext(store, layerIndex, snippetIndex) }
            : {}),
    };
}

function getSnippetAt(store, layerIndex, snippetIndex) {
    if (!Number.isInteger(layerIndex) || !Number.isInteger(snippetIndex)) {
        return null;
    }
    return store.layers[layerIndex]?.[snippetIndex] || null;
}

function buildSnippetContext(store, excludeLayerIndex, excludeSnippetIndex) {
    const contextParts = [];
    for (let i = store.layers.length - 1; i >= 0; i--) {
        const layer = store.layers[i];
        if (!layer) {
            continue;
        }
        collectLayerContext({
            contextParts,
            layer,
            layerIndex: i,
            excludeLayerIndex,
            excludeSnippetIndex,
        });
    }
    return contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';
}

function collectLayerContext({
    contextParts,
    layer,
    layerIndex,
    excludeLayerIndex,
    excludeSnippetIndex,
}) {
    for (let i = 0; i < layer.length; i++) {
        if (layerIndex === excludeLayerIndex && i === excludeSnippetIndex) {
            continue;
        }
        contextParts.push(layer[i].text);
    }
}
