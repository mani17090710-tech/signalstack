'use strict';
// AI labs SignalStack tracks as "official" sources.
//  hf      Hugging Face namespaces these labs publish under (each one was checked against the Hugging Face API).
//  gh      GitHub organisations whose repositories we treat as official.
//  mention Words that identify the lab or its model families in paper titles/abstracts (entity extraction).
// Only facts that were verified are listed. Anthropic publishes no models on Hugging Face, so it has no hf entry.
const COMPANIES = [
  { id: 'openai',    name: 'OpenAI',          or: ['openai'], hf: ['openai'],       gh: ['openai'],    site: 'https://openai.com',           mention: /\b(OpenAI|ChatGPT|GPT-\d[\w.-]*)/ },
  { id: 'anthropic', name: 'Anthropic',       or: ['anthropic'], hf: [],               gh: ['anthropics'], site: 'https://www.anthropic.com',   mention: /\b(Anthropic|Claude)\b/ },
  { id: 'google',    name: 'Google DeepMind', or: ['google'], hf: ['google'],       gh: [],            site: 'https://deepmind.google',      mention: /\b(DeepMind|Gemini|Gemma)\b/ },
  { id: 'meta',      name: 'Meta AI',         or: ['meta-llama'], hf: ['meta-llama'],   gh: [],            site: 'https://ai.meta.com',          mention: /\b(Llama|LLaMA|Meta AI)\b/ },
  { id: 'microsoft', name: 'Microsoft',       or: ['microsoft'], hf: ['microsoft'],    gh: [],            site: 'https://www.microsoft.com',    mention: /\b(Microsoft|Phi-\d)/ },
  { id: 'nvidia',    name: 'NVIDIA',          or: ['nvidia'], hf: ['nvidia'],       gh: [],            site: 'https://www.nvidia.com',       mention: /\b(NVIDIA|Nemotron)\b/ },
  { id: 'xai',       name: 'xAI',             or: ['x-ai'], hf: ['xai-org'],      gh: [],            site: 'https://x.ai',                 mention: /\b(xAI|Grok)\b/ },
  { id: 'deepseek',  name: 'DeepSeek',        or: ['deepseek'], hf: ['deepseek-ai'],  gh: [],            site: 'https://www.deepseek.com',     mention: /\bDeepSeek/ },
  { id: 'qwen',      name: 'Alibaba Qwen',   or: ['qwen'], hf: ['Qwen'],         gh: [],            site: '',                             mention: /\b(Qwen\d*|Alibaba)/ },
  { id: 'mistral',   name: 'Mistral AI',      or: ['mistralai'], hf: ['mistralai'],    gh: [],            site: 'https://mistral.ai',           mention: /\b(Mistral|Mixtral|Codestral)\b/ },
  { id: 'amazon',    name: 'Amazon',          or: ['amazon'],      hf: [], gh: [], site: 'https://aws.amazon.com/ai', mention: /\b(Amazon Nova|Amazon Titan)\b/ },
  { id: 'cohere',    name: 'Cohere',          or: ['cohere'],      hf: [], gh: [], site: 'https://cohere.com',       mention: /\b(Cohere|Command R)\b/ },
  { id: 'moonshot',  name: 'Moonshot AI',     or: ['moonshotai'],  hf: [], gh: [], site: 'https://www.moonshot.ai',  mention: /\b(Moonshot|Kimi)\b/ },
  { id: 'zai',       name: 'Z.ai (Zhipu)',    or: ['z-ai'],        hf: [], gh: [], site: 'https://z.ai',             mention: /\b(Zhipu|GLM-\d[\w.-]*)/ },
  { id: 'stepfun',   name: 'StepFun',         or: ['stepfun'],     hf: [], gh: [], site: 'https://www.stepfun.com',  mention: /\bStepFun\b/ },
  { id: 'minimax',   name: 'MiniMax',         or: ['minimax'],     hf: [], gh: [], site: 'https://www.minimax.io',   mention: /\bMiniMax\b/ },
];

const byId = Object.fromEntries(COMPANIES.map(c => [c.id, c]));
const byHandle = h => {
  const x = String(h || '').toLowerCase();
  return COMPANIES.find(c => c.hf.some(n => n.toLowerCase() === x)) || null;
};
// OpenRouter model ids look like "anthropic/claude-haiku-5.5"; the part before the slash names the lab.
const byOrPrefix = h => {
  const x = String(h || '').toLowerCase();
  return COMPANIES.find(c => (c.or || []).some(n => n.toLowerCase() === x)) || null;
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

module.exports = { COMPANIES, byId, byHandle, byOrPrefix, byGithubOwner, mentions };
