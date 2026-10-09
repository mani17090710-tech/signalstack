'use strict';
// AI labs SignalStack tracks as "official" sources.
//  hf      Hugging Face namespaces these labs publish under (each one was checked against the Hugging Face API).
//  gh      GitHub organisations whose repositories we treat as official.
//  mention Words that identify the lab or its model families in paper titles/abstracts (entity extraction).
// Only facts that were verified are listed. Anthropic publishes no models on Hugging Face, so it has no hf entry.
const COMPANIES = [
  { id: 'openai',    name: 'OpenAI',          hf: ['openai'],       gh: ['openai'],    site: 'https://openai.com',           mention: /\b(OpenAI|ChatGPT|GPT-\d[\w.-]*)/ },
  { id: 'anthropic', name: 'Anthropic',       hf: [],               gh: ['anthropics'], site: 'https://www.anthropic.com',   mention: /\b(Anthropic|Claude)\b/ },
  { id: 'google',    name: 'Google DeepMind', hf: ['google'],       gh: [],            site: 'https://deepmind.google',      mention: /\b(DeepMind|Gemini|Gemma)\b/ },
  { id: 'meta',      name: 'Meta AI',         hf: ['meta-llama'],   gh: [],            site: 'https://ai.meta.com',          mention: /\b(Llama|LLaMA|Meta AI)\b/ },
  { id: 'microsoft', name: 'Microsoft',       hf: ['microsoft'],    gh: [],            site: 'https://www.microsoft.com',    mention: /\b(Microsoft|Phi-\d)/ },
  { id: 'nvidia',    name: 'NVIDIA',          hf: ['nvidia'],       gh: [],            site: 'https://www.nvidia.com',       mention: /\b(NVIDIA|Nemotron)\b/ },
  { id: 'xai',       name: 'xAI',             hf: ['xai-org'],      gh: [],            site: 'https://x.ai',                 mention: /\b(xAI|Grok)\b/ },
  { id: 'deepseek',  name: 'DeepSeek',        hf: ['deepseek-ai'],  gh: [],            site: 'https://www.deepseek.com',     mention: /\bDeepSeek/ },
  { id: 'qwen',      name: 'Alibaba Qwen',   hf: ['Qwen'],         gh: [],            site: '',                             mention: /\b(Qwen\d*|Alibaba)/ },
  { id: 'mistral',   name: 'Mistral AI',      hf: ['mistralai'],    gh: [],            site: 'https://mistral.ai',           mention: /\b(Mistral|Mixtral|Codestral)\b/ },
];

const byId = Object.fromEntries(COMPANIES.map(c => [c.id, c]));
const byHandle = h => {
  const x = String(h || '').toLowerCase();
  return COMPANIES.find(c => c.hf.some(n => n.toLowerCase() === x)) || null;
};
const byGithubOwner = o => {
  const x = String(o || '').toLowerCase();
  return COMPANIES.find(c => c.gh.some(n => n.toLowerCase() === x)) || null;
};
// Company ids mentioned in a piece of text.
const mentions = text => {
  const s = String(text || '');
  return COMPANIES.filter(c => c.mention.test(s)).map(c => c.id);
};

module.exports = { COMPANIES, byId, byHandle, byGithubOwner, mentions };
