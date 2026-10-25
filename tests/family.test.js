'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parse, seriesOf } = require('../lib/family');

test('series and generation come from the model name', () => {
  assert.deepStrictEqual(parse('hf:Qwen/Qwen3-8B'), { series: 'Qwen', key: 'qwen', generation: 'Qwen3' });
  assert.strictEqual(parse('hf:Qwen/Qwen3-Coder-27B').generation, 'Qwen3 Coder');
  assert.strictEqual(parse('or:meta-llama/llama-3.1-70b-instruct').generation, 'llama 3.1');
  assert.strictEqual(parse('or:meta-llama/llama-3.1-70b-instruct').series, 'Llama');
  assert.strictEqual(parse('or:anthropic/claude-haiku-5.5').generation, 'claude haiku 5.5');
  assert.strictEqual(parse('hf:deepseek-ai/DeepSeek-V3.2').series, 'DeepSeek');
  assert.strictEqual(parse('or:openai/gpt-5').series, 'GPT');
  assert.strictEqual(parse('or:openai/o3-mini'), null, 'too short a name to call a series');
});

test('only a lab\'s own models are grouped, and a series needs two models', () => {
  const rows = [
    { id: 'hf:Qwen/Qwen3-8B', company_id: 'qwen', released_at: '2026-03-01' },
    { id: 'hf:Qwen/Qwen3-14B', company_id: 'qwen', released_at: '2026-03-02' },
    { id: 'hf:Qwen/Qwen3-Coder-27B', company_id: 'qwen', released_at: '2026-06-01' },
    { id: 'hf:someone/qwen-finetune', company_id: null, released_at: '2026-07-01' },
    { id: 'hf:Qwen/Lonely-1B', company_id: 'qwen', released_at: '2026-01-01' },
  ];
  const s = seriesOf(rows);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].key, 'qwen:qwen');
  assert.strictEqual(s[0].models.length, 3, 'the community fine-tune is not in the lab\'s series');
  assert.deepStrictEqual(s[0].generations.map(g => g.label), ['Qwen3', 'Qwen3 Coder'], 'generations run oldest to newest');
  assert.strictEqual(s[0].generations[0].models.length, 2);
});
