# Conall auto-triage rules: spec v1 (for Seer)

The data lives in `seer_rules_spec.json`. The reference implementation is `triage_engine.py`, with tests in `test_triage_engine.py` and the backtest in `backtest.py`.

## Inputs per message
- sender address (lowercased)
- subject
- providerConversationId
- flagged
- categories
- receivedAt

Context:
- **always_keep**: the spec list plus `seer.triage_sender_rules` rows with kind=always_keep
- **correspondents**: every address he has sent to (outgoing to/cc in seer.messages)
- **replied_threads**: conversations that contain an outgoing message

## Domain and "automated"
- **Domain**: take the last 2 labels. Take the last 3 when the second-level label is `co` or `com` and the TLD has 2 letters.
- **Automated sender**: the local part matches `automated_local_part_regex`, is longer than 40 characters, or contains `=`.

## Match order (the first match wins)
1. **P0 keep**:
   - the sender is in always_keep
   - the message is flagged
   - a category contains "Respond"
2. **Actionable keep**:
   - Use `keep_in_inbox_exceptions` (domain plus subject keywords).
   - Also keep when the domain is in `actionable_domains` (DMV/IRS/FTB/SOS), or the subject matches `actionable_subject_regex` (signature requested, action required, renewal, past due, payment failed, deadline, approval, suspicious sign-in, RFQ, backup failed …).
   - Exclusions: subjects that match signed_doc, calendar-response prefixes, or `promo_guard`.
3. **save-doc**: the domain is in `esign_domains` and the subject matches `signed_doc_regex`. Keep it in the Inbox and flag it. The PDF gets saved to Drive before anyone archives it.
4. **Address rules**: exact sender. This includes automated senders inside allowlisted domains, such as clinops@ and admin@rditrials.com → archive, and global.mybuy@ and vendor.portal@roche.com → keep.
5. **Subject rules**, in list order:
   - `sender` restricts a rule to one exact address.
   - `scope: non-allowlisted senders` skips allowlisted and replied-to domains.
   - `defer_hours` means wait until the message is at least that old. This applies to verification codes, at 24h.
6. **Domain rules**.
7. **Allowlisted or replied-to domain** → keep. A corresponded sender → keep.
8. **Anything else** → unknown, and the AI classifier decides.

Values normalize like this: Delete* → delete; Archive*/Filtered → archive; Keep*/Inbox* → keep.

## Protections (applied after the match; they override everything)
If the result is delete or archive and any of the following holds, the result becomes **review**: the message stays put and a pending proposal carries the proposed action.
- The sender is a non-automated address he has sent to, or the message is in a thread he replied in.
- The sender is a non-automated address at an allowlisted or replied-to domain. Real people at rditrials.com and roche.com are covered here.
- The sender is a non-automated freemail address (gmail, outlook …).

## Policy decisions encoded
- **Archive only**: receipts and money alerts, Fireflies recaps, M365 quarantine notices, Accepted/Declined replies, OOO replies, Calendly, payroll. These never go to Deleted Items.
- **Delete**: newsletters, marketing, webinar pitches, routine app notifications, Canceled: notices, verification codes older than 24h.
- **Calendar invitations stay in the Inbox**, because they may need an RSVP.
- **Rules removed after the backtest**: domain `mostwantedenterprisesllc.com` and domain `roberthalf.com`. Each one hit a message he kept.

## Backtest (decisions.json, 3,130 decisions)
- Kept before 6:30 PM PT Oct 16: **0 of 247 would be deleted or archived.**
- 10 messages arrived after that cutoff and were still sitting untriaged in the Inbox. They would have been acted on: a DocuSign verify code, Lab Manager, quarantine, Salesforce sandbox, Beehiiv, a MS invoice, RB2B, Timeglass, Laserfiche errors, and an Upwork notice. All of them match his normal handling.
- His deletes:
  - 57.2% are caught exactly as delete (1002/1752).
  - A further 23% are archived instead, which is safe.
  - 80.5% are handled automatically in total.
- His archives: 19.2% are caught. Most of the rest are human threads, which the engine keeps on purpose.
- **26 messages he archived would be deleted** (archive→delete). Almost all are Fireflies "granted access/recording" notices and Vercel usage mails, which he split between archive and delete. All are recoverable. Run `backtest.py --verbose` to list them.

## Receipt guard
If a rule picks delete and the subject matches `receipt_guard_regex`, the result becomes archive. This keeps LinkedIn ad receipts and purchase confirmations out of Deleted Items.
