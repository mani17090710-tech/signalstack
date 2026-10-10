# Hand-kept model list

`curated-models.json` lists closed or API-only models that are not yet in OpenRouter's catalogue. Each entry must
link to the lab's own announcement, so these are shown with the **Verified** badge. Add one object per model:

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
      "modality": "text+image->text",
      "summary": "One plain sentence taken from the announcement."
    }
  ]
}
```

Required: `id` (lab/name, lowercase), `name`, `company` (an id from `lib/companies.js`, such as `openai`, `anthropic`,
`google`, `xai`, `mistral`), `released` (YYYY-MM-DD) and `url` (https link to the announcement).
Optional: `context` (tokens), `price_in` and `price_out` (US dollars per 1M tokens), `modality`, `summary`.
Leave out anything the announcement does not state; it will show as "Not available from source".

Rules: an entry is skipped if OpenRouter already lists the same `id`. Invalid entries are skipped and reported in
Admin > Monitored sources. The file is re-read every ingestion cycle, so redeploy after editing it.
