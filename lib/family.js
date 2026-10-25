'use strict';
// Model series ("Llama", "DeepSeek", "Claude") and generations ("Llama 3.1", "Claude Haiku 5.5"), worked out from a model's name.
//
// This is a naming rule, not knowledge: the series is the leading word of the name and the generation is the name up to the first size or
// variant word. It only ever groups models that the same lab published, so a community fine-tune called "llama-something" is never placed in
// Meta's Llama series. Pages that show a series say that it is grouped by name.

const BRAND = { gpt: 'GPT', deepseek: 'DeepSeek', glm: 'GLM', qwen: 'Qwen', llama: 'Llama', gemma: 'Gemma', gemini: 'Gemini', claude: 'Claude', mistral: 'Mistral', mixtral: 'Mixtral', phi: 'Phi', grok: 'Grok', kimi: 'Kimi', nemotron: 'Nemotron', nova: 'Nova', titan: 'Titan', command: 'Command', minimax: 'MiniMax', step: 'Step' };
// Words that describe a size, a file format or a tuning, so they end the generation name.
const VARIANT = /^(\d+(\.\d+)?[bmk]|a\d+(\.\d+)?b|e\d+b|instruct|chat|base|it|pt|fp\d+|bf16|int\d+|gguf|awq|gptq|mlx|bnb|\d+bit|hf|preview|latest|exp|experimental|free|online|beta|extended|thinking|reasoner|\d{4})$/i;

// Reads the part after the lab prefix: "hf:Qwen/Qwen3-8B" and "or:meta-llama/llama-3.1-70b" both give the model's own name.
const tail = id => String(id || '').replace(/^(hf|or|cu):/, '').split('/').pop();

function parse(id) {
  const tokens = tail(id).split(/[-_ ]+/).filter(Boolean);
  const m = /^([A-Za-z]+)/.exec(tokens[0] || '');
  if (!m || m[1].length < 3) return null;
  const word = m[1].toLowerCase();
  const series = BRAND[word] || word[0].toUpperCase() + word.slice(1);
  const gen = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && VARIANT.test(tokens[i])) break;
    gen.push(tokens[i]);
  }
  return { series, key: word, generation: gen.join(' ') };
}

// Series that a lab has at least two models in, newest first. `models` are rows with id, company_id and a release date.
function seriesOf(models) {
  const groups = new Map();
  for (const m of models) {
    if (!m.company_id) continue;
    const p = parse(m.id); if (!p) continue;
    const key = m.company_id + ':' + p.key;
    if (!groups.has(key)) groups.set(key, { key, company_id: m.company_id, label: p.series, models: [] });
    groups.get(key).models.push({ ...m, generation: p.generation });
  }
  const date = m => m.released_at || m.rel || '';
  return [...groups.values()].filter(g => g.models.length >= 2).map(g => {
    g.models.sort((a, b) => (date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : 0));
    const gens = new Map();
    for (const m of g.models) { if (!gens.has(m.generation)) gens.set(m.generation, []); gens.get(m.generation).push(m); }
    g.generations = [...gens].map(([label, ms]) => ({ label, first: date(ms[0]) || null, last: date(ms[ms.length - 1]) || null, models: ms }));
    g.generations.sort((a, b) => (a.first || '') < (b.first || '') ? -1 : (a.first || '') > (b.first || '') ? 1 : 0);
    g.first = date(g.models[0]) || null; g.last = date(g.models[g.models.length - 1]) || null;
    return g;
  }).sort((a, b) => ((a.last || '') < (b.last || '') ? 1 : -1));
}

module.exports = { parse, seriesOf };
