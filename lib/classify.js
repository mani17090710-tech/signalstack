'use strict';
// "AI classification" step of the pipeline. Everything here is rule-based and derived only from data the
// source actually returned (pipeline tag, tags, model name). Nothing is guessed or invented.

const set = a => new Set(a);
const VISION = set(['image-classification', 'object-detection', 'image-segmentation', 'depth-estimation', 'image-feature-extraction', 'zero-shot-image-classification', 'zero-shot-object-detection', 'mask-generation', 'keypoint-detection']);
const VIDEO = set(['text-to-video', 'image-to-video', 'video-text-to-text', 'video-classification', 'video-to-video']);
const AUDIO = set(['automatic-speech-recognition', 'text-to-speech', 'text-to-audio', 'audio-to-audio', 'audio-classification', 'voice-activity-detection', 'audio-text-to-text']);
const MULTI = set(['any-to-any', 'image-text-to-text', 'video-text-to-text', 'visual-question-answering', 'image-to-text', 'document-question-answering', 'audio-text-to-text']);
const IMAGEGEN = set(['text-to-image', 'image-to-image', 'unconditional-image-generation', 'text-to-3d', 'image-to-3d']);
const EMBED = set(['feature-extraction', 'sentence-similarity', 'text-ranking']);
const LANGUAGE = set(['text-generation', 'text2text-generation']);
const NLP = set(['fill-mask', 'question-answering', 'summarization', 'translation', 'text-classification', 'token-classification', 'zero-shot-classification', 'table-question-answering']);
const KNOWN_TASKS = new Set([...VISION, ...VIDEO, ...AUDIO, ...MULTI, ...IMAGEGEN, ...EMBED, ...LANGUAGE, ...NLP, 'reinforcement-learning', 'robotics', 'time-series-forecasting', 'tabular-classification', 'tabular-regression']);

const CATEGORY_LABELS = {
  reasoning: 'Reasoning', coding: 'Coding', vision: 'Vision', audio: 'Audio', video: 'Video', multimodal: 'Multimodal', agentic: 'Agentic',
};

function typeLabel(pipeline) {
  if (pipeline === 'any-to-any') return 'Multimodal';
  if (MULTI.has(pipeline)) return 'Vision-language';
  if (IMAGEGEN.has(pipeline)) return 'Image generation';
  if (pipeline === 'text-to-video' || pipeline === 'image-to-video' || pipeline === 'video-to-video') return 'Video generation';
  if (VIDEO.has(pipeline) || VISION.has(pipeline)) return 'Vision';
  if (AUDIO.has(pipeline)) return 'Speech and audio';
  if (EMBED.has(pipeline)) return 'Embedding';
  if (LANGUAGE.has(pipeline)) return 'Language model';
  if (NLP.has(pipeline)) return 'Language (NLP)';
  if (pipeline === 'robotics') return 'Robotics';
  if (pipeline === 'reinforcement-learning') return 'Reinforcement learning';
  if (pipeline === 'time-series-forecasting') return 'Time series';
  if (/^tabular-/.test(pipeline || '')) return 'Tabular';
  return 'Model';
}

// Pipeline tag: the source's own value, else the first tag that is a known task.
function pipelineOf(pipeline, tags) {
  if (pipeline) return String(pipeline);
  return (tags || []).find(t => KNOWN_TASKS.has(t)) || '';
}

// Hugging Face tags carry the license and the arXiv papers a model cites.
function tagInfo(tags) {
  let license = '';
  const arxiv = [];
  for (const t of tags || []) {
    let m;
    if ((m = /^license:(.+)$/.exec(t))) license = m[1];
    else if ((m = /^arxiv:(\d{4}\.\d{4,5})$/.exec(t)) && !arxiv.includes(m[1])) arxiv.push(m[1]);
  }
  return { license, arxiv };
}

function categorize({ name, pipeline, tags }) {
  const p = pipelineOf(pipeline, tags), n = String(name || ''), tg = new Set((tags || []).map(t => String(t).toLowerCase()));
  const cats = [];
  if (VISION.has(p) || IMAGEGEN.has(p) || MULTI.has(p) && p !== 'audio-text-to-text' || /\b(vision|vl)\b|[-_]vl[-_]|vision/i.test(n)) cats.push('vision');
  if (VIDEO.has(p) || /video/i.test(n)) cats.push('video');
  if (AUDIO.has(p) || /whisper|[-_]tts\b|speech|audio/i.test(n)) cats.push('audio');
  if (MULTI.has(p) || /omni|multimodal|vision-language/i.test(n)) cats.push('multimodal');
  if (/code|coder|codestral|starcoder|devstral|codex/i.test(n) || tg.has('code') || tg.has('coding')) cats.push('coding');
  if (/reason|thinking|(^|[-_/])r1([-_]|$)|qwq|prover|deepthink/i.test(n) || tg.has('reasoning')) cats.push('reasoning');
  if (/agent/i.test(n) || ['agent', 'agents', 'function-calling', 'tool-use', 'tool-calling'].some(t => tg.has(t))) cats.push('agentic');
  return { cats: [...new Set(cats)], type: typeLabel(p), pipeline: p };
}

function formatCount(n) {
  n = +n;
  if (!(n > 0)) return '';
  const f = (v, u) => String(+v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + u;
  if (n >= 1e12) return f(n / 1e12, 'T');
  if (n >= 1e9) return f(n / 1e9, 'B');
  return f(n / 1e6, 'M');
}

// Parameter count written in the model name, e.g. "Qwen3.8-27B", "bitnet-embedding-0.6b", "Foo-119B-A6B".
// This is a name-derived estimate; the exact number is used instead once the model page has been enriched.
function parseParams(name) {
  const s = String(name || '').split('/').pop();
  const m = /(?<![\w.])(\d+(?:\.\d+)?)\s?([bBmM])(?![a-zA-Z0-9])/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]), isB = m[2].toLowerCase() === 'b';
  if (isB ? !(v > 0 && v <= 2000) : !(v >= 10 && v < 1000)) return null;
  const count = v * (isB ? 1e9 : 1e6);
  const a = /-A(\d+(?:\.\d+)?)B(?![a-zA-Z0-9])/i.exec(s);
  return { count, label: formatCount(count), active: a ? a[1] + 'B' : null };
}

module.exports = { categorize, typeLabel, tagInfo, parseParams, formatCount, pipelineOf, CATEGORY_LABELS, KNOWN_TASKS };
