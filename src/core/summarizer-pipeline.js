import { PROSE_DATE_FORMAT_RULE } from '../foundation/prompt-constants.js';
import {
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
    insertBeforeTrigger,
} from '../foundation/prompt-parts.js';
import { getName1 } from '../foundation/context.js';
import { isTraceEnabled, trace } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { appendLayer0PromptConstraints } from './layer0-compression.js';
import { resolveCallProfile } from './call-profile.js';
import { countTextTokens, formatTokenCount } from './token-count.js';

/**
 * @typedef {object} SummarizerPipelineInputRequest
 * @property {string} storyTxt - The story text to summarize
 * @property {string} contextStr - The accumulated context string
 * @property {import('./call-profile.js').SummarizerCallMetadata} [metadata] - Resolver input: call category plus provenance
 * @property {ExtensionSettings} [settings] - Effective settings override
 */

/**
 * Resolve the call profile once at dispatch and render its prompts. The
 * returned profile is frozen policy: the runner consumes it instead of
 * re-deriving per-attempt decisions from the live settings.
 * @param {SummarizerPipelineInputRequest} request
 * @returns {Promise<{ prompt: string, repairPrompt: string, profile: import('./call-profile.js').CallProfile }>}
 */
export async function buildSummarizerPipelineInput({
    storyTxt,
    contextStr,
    metadata = {},
    settings = getEffectiveSettings(),
}) {
    const call = await buildUsageMetadata(metadata, storyTxt);
    const profile = resolveCallProfile(settings, call);
    const prompt = buildSummarizerPrompt({
        template: profile.policy.userPromptTemplate,
        storyTxt,
        contextStr,
        settings,
        profile,
    });
    const repairPrompt = profile.policy.repairPromptTemplate
        ? buildSummarizerPrompt({
              template: profile.policy.repairPromptTemplate,
              storyTxt,
              contextStr,
              settings,
              profile,
          })
        : '';

    return {
        prompt,
        repairPrompt,
        profile,
    };
}

/**
 * @param {string} storyTxt - Story text
 * @param {string} contextStr - Context text
 * @returns {Promise<void>}
 */
export async function traceSummarizerInputTokens(storyTxt, contextStr) {
    if (!isTraceEnabled()) {
        return;
    }

    const [storyTokens, contextTokens] = await Promise.all([
        countTextTokens(storyTxt || ''),
        countTextTokens(contextStr || ''),
    ]);

    trace('  storyTxt tokens:', formatTokenCount(storyTokens));
    trace('  contextStr tokens:', formatTokenCount(contextTokens));
}

/**
 * Add usage-only details that should not affect prompt labels or routing.
 * @param {import('./call-profile.js').SummarizerCallMetadata} metadata - Call metadata
 * @param {string} storyTxt - Source text being summarized
 * @returns {Promise<import('./call-profile.js').SummarizerCallMetadata>}
 */
async function buildUsageMetadata(metadata = {}, storyTxt = '') {
    let usageMetadata = metadata;

    if (metadata.kind === 'promotion' && !Number.isFinite(Number(metadata.memoryTokensBefore))) {
        const memoryTokens = await countTextTokens(storyTxt || '');
        usageMetadata = {
            ...usageMetadata,
            memoryTokensBefore: memoryTokens.count,
            memoryTokensBeforeEstimated: memoryTokens.estimated,
        };
    }

    if (!hasSourceTokenMetadata(usageMetadata)) {
        const sourceTokens = await countTextTokens(storyTxt || '');
        usageMetadata = {
            ...usageMetadata,
            sourceTokensBefore: sourceTokens.count,
            sourceTokensBeforeEstimated: sourceTokens.estimated,
        };
    }

    return usageMetadata;
}

function hasSourceTokenMetadata(metadata = {}) {
    return (
        Number.isFinite(Number(metadata.sourceTokensBefore)) ||
        Number.isFinite(Number(metadata.regexStats?.finalTokens)) ||
        Number.isFinite(Number(metadata.memoryTokensBefore))
    );
}

/**
 * @param {object} p
 * @param {string} p.template - User prompt template
 * @param {string} p.storyTxt - Story text
 * @param {string} p.contextStr - Context text
 * @param {ExtensionSettings} p.settings - Active settings
 * @param {import('./call-profile.js').CallProfile} p.profile - Resolved call profile
 * @returns {string}
 */
function buildSummarizerPrompt({ template, storyTxt, contextStr, settings, profile }) {
    // replaceAll on purpose: every placeholder occurrence is replaced; user templates may repeat one.
    const prompt = adaptTimeInstructions(template, settings, profile)
        .replaceAll('{{player_name}}', getName1())
        .replaceAll('{{context_str}}', contextStr || '(none yet)')
        .replaceAll('{{story_txt}}', storyTxt);
    const constrained = appendLayer0PromptConstraints(prompt, settings, profile);
    if (
        !profile?.policy?.compression ||
        !settings.timeTrackingMode ||
        settings.timeTrackingMode === 'scene'
    )
        return constrained;
    return constrained
        .replace('current_date_time must be the scene time at the end of that message.\n', '')
        .replace(EXECUTION_TRIGGER_L0, EXECUTION_TRIGGER_PROMO);
}

/** Adapt the built-in temporal rules without changing saved prompt profiles. */
function adaptTimeInstructions(template, settings, profile) {
    if (
        !profile?.policy?.compression ||
        !settings.timeTrackingMode ||
        settings.timeTrackingMode === 'scene'
    )
        return template;
    let text = template
        .replaceAll(PROSE_DATE_FORMAT_RULE, '')
        .replace(
            'Output exactly one <narrative> envelope, followed by a current_date_time line:',
            'Output exactly one <narrative> envelope:',
        )
        .replace(/^Resolve any relative time reference in the passage.*$/gm, '')
        .replace(/^current_date_time: YYYY-MM-DD HH ddd\nUse 24-hour.*$/gm, '')
        .replace(/^End with the current_date_time line described in the output schema\.$/gm, '')
        .replace(/^Always include current_date_time.*$/gm, '')
        .replace(
            'Do not include prose, bullets, tables, duplicate section headers, markdown, or commentary after the current_date_time line.',
            'Do not include prose, bullets, tables, duplicate section headers, markdown, or commentary after the envelope.',
        )
        .replace(/^4\. \*\*Temporal Anchors:\*\*.*$/gm, '')
        .replace(/^Resolve every relative time word against the source snippets.*$/gm, '');
    const instruction =
        settings.timeTrackingMode === 'real'
            ? 'Chat-time anchors describe when messages were sent in the real world (UTC), not the time in the story. Never use them to infer scene dates. Do not output a current_date_time line.'
            : 'Do not track or infer scene dates or times and do not output a current_date_time line. Preserve story-relevant sequence and deadlines only when stated.';
    const trigger = profile?.policy?.promotionConstraints
        ? EXECUTION_TRIGGER_PROMO
        : EXECUTION_TRIGGER_L0;
    text = insertBeforeTrigger(text, instruction, trigger);
    return text;
}
