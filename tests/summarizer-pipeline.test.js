import { describe, expect, it } from 'vitest';

import { buildSummarizerPipelineInput } from '../src/core/summarizer-pipeline.js';
import { defaultSettings } from '../src/foundation/constants.js';
import { installSummaryContext } from './test-helpers.js';

describe('buildSummarizerPipelineInput', () => {
    it('routes the auditor call category to the auditor prompts with substitution', async () => {
        installSummaryContext();

        const request = await buildSummarizerPipelineInput({
            storyTxt: 'USER TURN',
            contextStr: 'PRIOR STATE',
            metadata: { kind: 'auditor' },
        });

        expect(request.profile.policy.systemPrompt).toBe(defaultSettings.auditorSystemPrompt);
        expect(request.prompt).toContain('PRIOR STATE');
        expect(request.prompt).toContain('USER TURN');
        expect(request.repairPrompt).toBe('');
    });
    it.each(['real', 'off'])('does not ask for scene time in %s mode', async (mode) => {
        installSummaryContext();
        const request = await buildSummarizerPipelineInput({
            storyTxt: 'Story',
            contextStr: '',
            metadata: { kind: 'layer0', sourceRange: [0, 2] },
            settings: { ...defaultSettings, timeTrackingMode: mode },
        });
        expect(request.prompt).not.toContain('current_date_time: YYYY-MM-DD');
        expect(request.prompt).not.toContain('scene time at the end');
        expect(request.prompt.toLowerCase()).toContain('do not output a current_date_time line');
        expect(request.prompt.trimEnd()).toMatch(/Now output exactly one <narrative> envelope/);
    });
});
