'use strict';
// AI labs SignalStack tracks as "official" sources.
//  hf      Hugging Face namespaces these labs publish under (each one was checked against the Hugging Face API).
//  gh      GitHub organisations whose repositories we treat as official.
//  domains Web domains the lab publishes official announcements and documentation on (used to check evidence links).
//  mention Words that identify the lab or its model families in paper titles/abstracts (entity extraction).
// Only facts that were verified are listed. Anthropic publishes no models on Hugging Face, so it has no hf entry.
const COMPANIES = [
  { id: 'openai',    name: 'OpenAI',          or: ['openai'], hf: ['openai'],       gh: ['openai'],    site: 'https://openai.com',           domains: ['openai.com'], mention: /\b(OpenAI|ChatGPT|GPT-\d[\w.-]*)/ },
  { id: 'anthropic', name: 'Anthropic',       or: ['anthropic'], hf: [],               gh: ['anthropics'], site: 'https://www.anthropic.com',   domains: ['anthropic.com', 'claude.com'], mention: /\b(Anthropic|Claude)\b/ },
  { id: 'google',    name: 'Google DeepMind', or: ['google'], hf: ['google'],       gh: [],            site: 'https://deepmind.google',      domains: ['deepmind.google', 'ai.google.dev', 'blog.google', 'google.com'], mention: /\b(DeepMind|Gemini|Gemma)\b/ },
  { id: 'meta',      name: 'Meta AI',         or: ['meta-llama', 'meta'], hf: ['meta-llama'],   gh: [],            site: 'https://ai.meta.com',          domains: ['ai.meta.com', 'llama.com', 'meta.com'], mention: /\b(Llama|LLaMA|Meta AI)\b/ },
  { id: 'microsoft', name: 'Microsoft',       or: ['microsoft'], hf: ['microsoft'],    gh: [],            site: 'https://www.microsoft.com',    domains: ['microsoft.com', 'azure.com'], mention: /\b(Microsoft|Phi-\d)/ },
  { id: 'nvidia',    name: 'NVIDIA',          or: ['nvidia'], hf: ['nvidia'],       gh: [],            site: 'https://www.nvidia.com',       domains: ['nvidia.com'], mention: /\b(NVIDIA|Nemotron)\b/ },
  { id: 'xai',       name: 'xAI',             or: ['x-ai'], hf: ['xai-org'],      gh: [],            site: 'https://x.ai',                 domains: ['x.ai'], mention: /\b(xAI|Grok)\b/ },
  { id: 'deepseek',  name: 'DeepSeek',        or: ['deepseek'], hf: ['deepseek-ai'],  gh: [],            site: 'https://www.deepseek.com',     domains: ['deepseek.com'], mention: /\bDeepSeek/ },
  { id: 'qwen',      name: 'Alibaba Qwen',   or: ['qwen'], hf: ['Qwen'],         gh: [],            site: '',                             domains: ['qwenlm.github.io', 'qwen.ai', 'alibabacloud.com'], mention: /\b(Qwen\d*|Alibaba)/ },
  { id: 'mistral',   name: 'Mistral AI',      or: ['mistralai'], hf: ['mistralai'],    gh: [],            site: 'https://mistral.ai',           domains: ['mistral.ai'], mention: /\b(Mistral|Mixtral|Codestral)\b/ },
  { id: 'amazon',    name: 'Amazon',          or: ['amazon'],      hf: [], gh: [], site: 'https://aws.amazon.com/ai', domains: ['aws.amazon.com', 'amazon.science'], mention: /\b(Amazon Nova|Amazon Titan)\b/ },
  { id: 'cohere',    name: 'Cohere',          or: ['cohere'],      hf: [], gh: [], site: 'https://cohere.com',       domains: ['cohere.com'], mention: /\b(Cohere|Command R)\b/ },
  { id: 'moonshot',  name: 'Moonshot AI',     or: ['moonshotai'],  hf: [], gh: [], site: 'https://www.moonshot.ai',  domains: ['moonshot.ai', 'kimi.com'], mention: /\b(Moonshot|Kimi)\b/ },
  { id: 'zai',       name: 'Z.ai (Zhipu)',    or: ['z-ai'],        hf: [], gh: [], site: 'https://z.ai',             domains: ['z.ai', 'zhipuai.cn', 'bigmodel.cn'], mention: /\b(Zhipu|GLM-\d[\w.-]*)/ },
  { id: 'stepfun',   name: 'StepFun',         or: ['stepfun'],     hf: [], gh: [], site: 'https://www.stepfun.com',  domains: ['stepfun.com'], mention: /\bStepFun\b/ },
  { id: 'minimax',   name: 'MiniMax',         or: ['minimax'],     hf: [], gh: [], site: 'https://www.minimax.io',   domains: ['minimax.io', 'minimaxi.com'], mention: /\bMiniMax\b/ },
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
// True when a link points at one of the lab's own domains (or a sub-domain of one).
const isOfficialUrl = (co, url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return !!co && (co.domains || []).some(d => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
};
const mentions = text => {
  const s = String(text || '');
  return COMPANIES.filter(c => c.mention.test(s)).map(c => c.id);
};

module.exports = { COMPANIES, byId, byHandle, byOrPrefix, byGithubOwner, mentions, isOfficialUrl };
