# Classifier fixtures

Seer does **not** train an ML model on your Gmail.

It uses:

1. **Rules** (domains, noreply, marketing, actionable phrases from legacy Intel)
2. **Your sent history** (who you email — rebuilt live from Sent)
3. **Taught senders** (chips you tap in Triage)

## Get real samples to the agent

1. Sign in at https://seer-modern.vercel.app
2. Open **Settings → Download classifier samples**
3. Save `seer-classifier-samples.json` here (or share the file)
4. Optionally set `"expectedAction"` on rows that are wrong
5. Run:

```bash
npx tsx scripts/eval-classifier.mts fixtures/classifier/seer-classifier-samples.json
```

Exports include subject + snippet + predicted rule — **not** HTML bodies.
