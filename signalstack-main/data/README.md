# Hand-kept model list

`curated-models.json` is the official list: closed or API-only models confirmed by the provider's own announcement or
documentation. This is the only path to the **Verified** badge for a closed model. Every link must be on the
provider's own domain (see `domains` in `lib/companies.js`); other links are rejected. Add one object per model:

```json
{
  "models": [
    {
      "id": "openai/gpt-example",
      "name": "GPT Example",
      "company": "openai",
      "released": "2026-10-10",
      "url": "https://openai.com/index/gpt-example/",
      "context": 400000,
      "price_in": 2.0,
      "price_out": 10.0,
      "docs_url": "https://platform.openai.com/docs/models/gpt-example",
      "provider_model_id": "gpt-example",
      "openrouter_id": "openai/gpt-example",
      "papers": ["2401.00001"],
      "capabilities": ["reasoning", "tool-use"],
      "modality": "text+image->text",
      "summary": "One plain sentence taken from the announcement."
    }
  ]
}
```

Required: `id` (lab/name, lowercase), `name`, `company` (an id from `lib/companies.js`, such as `openai`, `anthropic`,
`google`, `xai`, `mistral`), `released` (YYYY-MM-DD) and `url` (https link to the announcement).
Optional: `docs_url` (API documentation, official domain), `provider_model_id` (the ID used in the provider's API),
`openrouter_id` (links the OpenRouter listing to this entry), `papers` (arXiv ids the provider itself cites), `capabilities`,
`context` (tokens), `price_in` and `price_out` (US dollars per 1M tokens), `modality`, `summary`.
Leave out anything the announcement does not state; it will show as "Not available from source".

Rules: if OpenRouter or Hugging Face already lists the same model, the official facts are added to that one record
(no duplicate), and official context length and prices replace the catalogue's. Invalid entries are skipped and reported in
Admin > Monitored sources. The file is re-read every ingestion cycle, so redeploy after editing it.
