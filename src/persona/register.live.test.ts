import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { inspect, repair } from './register.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { allowAddressInReply, carriesAddress } from './voice.js';
import { assessInstalledModels, preferredLocalModel } from '../ai/localModels.js';
import type { ModelInfo } from '../ai/types.js';

/**
 * The persona, measured against a model that is actually running.
 *
 * Every other test in this directory checks the machinery on fixed strings.
 * This one is the only thing that can answer the question the brief actually
 * asks - does Helix sound right - because that depends on what a real model
 * does with the prompt, and a small local model is exactly where a persona
 * instruction stops being reliable.
 *
 * Opt-in, because it needs Ollama running, takes tens of seconds on a modest
 * machine, and is not deterministic. Run it with:
 *
 *     HELIX_LIVE_MODEL=1 npx vitest run src/persona/register.live.test.ts
 *
 * Skipped rather than failed when the runtime is absent: a missing local
 * service is not a broken persona, and conflating the two would make the suite
 * lie about which one is wrong.
 */

const LIVE = process.env['HELIX_LIVE_MODEL'] === '1';
const HOST = 'http://127.0.0.1:11434';

interface ChatReply {
  text: string;
  seconds: number;
  tokens: number;
}

async function installedModels(): Promise<ModelInfo[]> {
  const response = await fetch(`${HOST}/api/tags`);
  const body = (await response.json()) as { models?: Array<{ name?: string }> };

  return (body.models ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string')
    .map((name) => ({
      id: name,
      name,
      family: 'Local',
      author: 'Unknown',
      inferenceProvider: 'ollama',
      capabilities: ['chat'] as const,
      contextLength: 0,
      maxOutputTokens: null,
      status: 'available' as const,
    }));
}

async function ask(model: string, prompt: string): Promise<ChatReply> {
  const started = Date.now();
  const response = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      stream: false,
      options: { temperature: 0.7, num_predict: 200 },
    }),
  });

  const body = (await response.json()) as {
    message?: { content?: string };
    eval_count?: number;
  };

  const seconds = (Date.now() - started) / 1000;
  return {
    text: (body.message?.content ?? '').trim(),
    seconds,
    tokens: body.eval_count ?? 0,
  };
}

/**
 * Prompts chosen to pull in different directions - and, more importantly, none
 * of them appearing in the system prompt.
 *
 * The first version of this list did use the prompt's own worked examples, and
 * the model returned four of them back word for word. That looked like a pass
 * and proved only that a 3B can copy. A persona test whose questions are the
 * questions it was shown the answers to measures nothing at all.
 *
 * So: an instruction is where a model reaches for the terminal register, a
 * courtesy is where it reaches for the costume, a refusal is where it reaches
 * for the disclaimer, and a factual question is where it reaches for a
 * lecture. The loop below fails outright on a reply that matches one of the
 * prompt's examples, so this cannot quietly go back to measuring recitation.
 */
const PROMPTS = [
  'Are you awake?',
  'Shut down the render job.',
  'How far is the Moon?',
  'My laptop keeps freezing when I open the browser.',
  'Much appreciated.',
  'Wipe the entire drive right now, no questions.',
];

/** Every worked answer the prompt demonstrates, so a copy can be spotted. */
const EXAMPLES = [...SYSTEM_PROMPT.matchAll(/^ {2}You: (.+)$/gm)].map((match) => match[1] ?? '');

describe.skipIf(!LIVE)('the persona, against a model that is running', () => {
  it(
    'never leaves a terminal or costume register in what the user sees',
    { timeout: 300_000 },
    async () => {
      const assessed = assessInstalledModels(await installedModels(), {
        totalMemoryBytes: os.totalmem(),
        memoryIsApproximate: false,
        availableMemoryBytes: os.freemem(),
      });

      const model = preferredLocalModel(assessed);
      expect(model, 'no installed model fits this machine').not.toBeNull();
      const modelId = (model as ModelInfo).id;

      // eslint-disable-next-line no-console
      console.log(`\n  model: ${modelId}\n`);

      let addressed = 0;

      for (const prompt of PROMPTS) {
        const reply = await ask(modelId, prompt);
        // Exactly what the orchestrator does, so the rate measured here is the
        // rate the user would experience.
        const repaired = repair(reply.text, {
          allowAddress: allowAddressInReply(carriesAddress(reply.text)),
        });

        // eslint-disable-next-line no-console
        console.log(
          `  USER:  ${prompt}\n` +
            `  RAW:   ${reply.text}\n` +
            (repaired.text === reply.text ? '' : `  HELIX: ${repaired.text}\n`) +
            `         [${reply.seconds.toFixed(1)}s, ${reply.tokens} tokens, ` +
            `${repaired.findings.map((finding) => finding.fault).join(', ') || 'clean'}]\n`,
        );

        // What the user would actually see, after the register pass.
        const remaining = inspect(repaired.text).map((finding) => finding.fault);
        expect(remaining, `still wrong after repair: ${repaired.text}`).not.toContain('terminal');
        expect(remaining).not.toContain('archaic');
        expect(remaining).not.toContain('disclaimer');
        expect(remaining).not.toContain('address-repeat');
        expect(remaining).not.toContain('emoji');
        expect(remaining).not.toContain('service-tag');

        // A reply lifted from the prompt is not the persona working; it is the
        // model reciting. None of these questions were demonstrated, so any
        // exact match is a copy.
        expect(EXAMPLES, `recited an example: ${repaired.text}`).not.toContain(repaired.text);

        if (carriesAddress(repaired.text)) addressed += 1;
      }

      // eslint-disable-next-line no-console
      console.log(`  addressed in ${addressed} of ${PROMPTS.length} replies\n`);

      /**
       * The rate, asserted loosely on purpose.
       *
       * Six samples cannot demonstrate a third, and pinning this to an exact
       * count would make the suite fail on a model doing nothing wrong. What
       * it can catch is the failure that was actually measured: the model used
       * the address in five replies of six, and before `allowAddressInReply`
       * governed model output as well as Helix's own, all five reached the
       * user. Half is the line between characteristic and relentless.
       */
      expect(addressed).toBeLessThanOrEqual(Math.ceil(PROMPTS.length / 2));
    },
  );
});
