'use strict';
// Model <-> paper links. A link exists only when a source states it; similar names never create one.
//   model_card_tag   the model's Hugging Face card lists the arXiv paper (claimed by the publisher when the card is on a lab's own account)
//   official_entry   the provider's own entry in data/curated-models.json lists the paper
//   abstract_link    the paper's abstract links to the model's Hugging Face page (claimed by the paper's authors)
const { canonKey, findAll } = require('./canon');
const nowIso = () => new Date().toISOString();

const HF_LINK = /huggingface\.co\/(?!datasets\/|spaces\/|papers\/|collections\/|docs\/|blog\/|models\b)([\w.-]+\/[\w.-]+)/gi;

function linkModelPapers(db) {
  const ins = db.prepare('insert or ignore into model_papers(model_id,arxiv_id,kind,claimed_by,url,created_at) values(?,?,?,?,?,?)');
  const official = db.prepare("select 1 from model_evidence where model_id=? and kind='publisher_namespace'");
  let n = 0;
  db.exec('begin');
  try {
    for (const m of db.prepare("select id,arxiv,url from models where arxiv is not null and arxiv!=''").all()) {
      const by = official.get(m.id) ? 'publisher' : 'community';
      for (const a of m.arxiv.split(',').filter(Boolean)) n += ins.run(m.id, a, 'model_card_tag', by, m.url, nowIso()).changes;
    }
    for (const p of db.prepare("select arxiv_id,url,abstract from papers where arxiv_id is not null and abstract like '%huggingface.co/%'").all()) {
      for (const hit of String(p.abstract).matchAll(HF_LINK)) {
        const name = hit[1].replace(/[.,;:)\]]+$/, '');
        for (const row of findAll(db, canonKey('', name)).slice(0, 1)) n += ins.run(row.id, p.arxiv_id, 'abstract_link', 'paper authors', p.url, nowIso()).changes;
      }
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return n;
}

module.exports = { linkModelPapers };
