'use strict';
// "Why this matters": one or two plain sentences on an important signal, written by fixed rules from facts we hold (who published it, its size,
// adoption numbers, release type). It is not an AI-generated opinion, it never claims more than the data says, and it returns null when
// there is nothing solid to say. Callers show it only for signals scoring 60 or higher.

const compact = n => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.0', '') + 'k' : String(Math.round(n)));
const params = n => (n >= 1e9 ? +(n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? +(n / 1e6).toFixed(0) + 'M' : null);
const semver = tag => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(tag || ''));
  if (!m) return null;
  return +m[2] === 0 && (m[3] == null || +m[3] === 0) ? 'major release' : m[3] == null || +m[3] === 0 ? 'minor release' : 'patch release';
};

/**
 * @param {object} s { cat, score, companyName, tier, meta, mentionNames: string[], model?: { likes, downloads, param_count, ctx_tokens, adoption, hoursOld } }
 */
function matters(s) {
  if (!s || s.score < 60) return null;
  const m = s.model, lab = s.companyName;
  if (m && (s.cat === 'Model Release' || s.cat === 'Trending')) {
    const api = m.adoption === false;
    const size = +m.param_count > 0 ? `${params(m.param_count)} parameters` : +m.ctx_tokens > 0 ? `a ${compact(m.ctx_tokens)}-token context window` : '';
    const a = [];
    a.push(`${s.cat === 'Trending' ? 'A trending' : 'A new'} ${api ? 'model you can call through an API' : 'open-weight model you can download'}${lab ? ` from ${lab}` : ', from a community publisher'}${size ? `, with ${size}` : ''}.`);
    if (!api && (m.downloads >= 1000 || m.likes >= 100)) a.push(`It already has ${[m.downloads ? `${compact(m.downloads)} downloads` : '', m.likes ? `${compact(m.likes)} likes` : ''].filter(Boolean).join(' and ')}.`);
    else if (!api && m.hoursOld != null && m.hoursOld < 12) a.push('It is too new for adoption numbers.');
    if (lab && !api) a.push(`${lab} is a lab we track closely.`);
    return a.join(' ');
  }
  if (s.cat === 'Research') {
    const names = (s.mentionNames || []).filter(Boolean);
    if (!names.length) return null;
    return `A paper that names ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''} in its title or abstract${s.refLikes > 0 ? `; models that cite it have ${compact(s.refLikes)} likes in total` : ''}.`;
  }
  if (s.cat === 'Open Source') {
    const kind = semver(s.meta && s.meta.tag);
    if (!kind) return null;
    return `A ${kind} of ${(s.meta && s.meta.repo) || 'a tracked project'}. ${lab ? `It comes from ${lab}’s own repository.` : 'It is a widely used open-source AI project.'}`;
  }
  if (s.cat === 'Announcement') return s.tier === 'primary' && lab ? `An official announcement from ${lab}, published on its own channel.` : 'A post from a community feed we monitor; it is not an official statement.';
  return null;
}

module.exports = { matters };
