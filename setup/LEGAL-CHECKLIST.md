# Deploying this update + legal checklist

## A. Deploy (in this order)

1. **Supabase → SQL Editor:** run `4-legal.sql` once.
2. **Supabase → Edge Functions → Secrets:** add `TERMS_VERSION` = `1`.
   Also set `ALLOWED_ORIGIN` to your site's address (e.g. `https://jameswilson2127-gif.github.io`) instead of `*`.
3. **Edge Functions:** paste and redeploy `extract`, `generate`, `template` from the updated `fn-*.ts` files.
   Create a new function named **`account`** from `fn-account.ts` (turn off "Verify JWT", like the others).
4. **GitHub:** upload the changed site files: `index.html`, `app.js`, `doc.js`, `styles.css`, `config.js`,
   `admin.html`, `admin.css`, and the new `terms.html`, `privacy.html`, `legal.js`.
   Do step 1–3 first: the new site needs the `accept_terms` function to exist.

## B. Fill in before going public (`config.js`)

- `OPERATOR_NAME`: your full legal name (or company name). Shown in the Terms and Privacy Policy.
- `CONTACT_EMAIL`: currently your admin Gmail. Consider a separate support address.
- `JURISDICTION_CITY`: e.g. "New Delhi".

## C. Things the code cannot do for you

- **Gemini paid tier.** The Privacy Policy says you use Google's *paid* Gemini API. Make sure Cloud Billing
  is enabled on the API key's project. On the free tier Google may use the content to improve its products,
  and the policy would then be untrue.
- **Supabase region.** If you ever recreate the project, choose Mumbai (ap-south-1).
- **Breach response.** If you suspect a breach, report to CERT-In within 6 hours and notify affected users and
  the Data Protection Board as the DPDP Rules require. Keep the Supabase and Google keys secret; rotate them if leaked.
- **Changing the Terms or Privacy text.** Bump `TERMS_VERSION` in `config.js` **and** the `TERMS_VERSION` secret,
  and update `TERMS_UPDATED`. Every user then has to accept again.
- **Payments.** Razorpay needs Terms, Privacy and a refund/cancellation policy URL. Use `terms.html#payments`.
  Register for GST once turnover crosses the threshold.
- **Lawyer review.** These documents are a careful starting point, not legal advice. Have a health-tech or
  data-protection lawyer review them once before you scale.
- **Feature scope.** Don't add features that suggest diagnoses or treatment. That could make the app a regulated
  medical device under CDSCO's Medical Device Software guidance.

## What changed in this version

- Patient step collects only an optional name and admission/discharge dates. They stay on the device and are never sent.
  UHID, IPD number and custom ID fields are gone; they print as blank write-in lines. Age and sex come from the photos (review step).
- Each photo must be masked or marked "No IDs" before it can be read. Templates need an identifiers-removed confirmation.
- Server functions strip Aadhaar, ABHA, phone, e-mail and long ID-like numbers from inputs and outputs.
- Fixed a leak: malformed AI JSON could put patient text into error logs. Errors are now generic.
- Terms gate on first sign-in: six attestations, recorded with a version and timestamp, and enforced on the server.
- Print and Copy stay locked until the doctor ticks "I have verified this draft". The app offers to wipe the case after printing.
  Unfinished cases auto-expire from the browser after `CASE_TTL_MINUTES`.
- Account menu: Download my data (DPDP access) and Delete account (erasure; cancels the Razorpay subscription).
- Terms of Use, Privacy Policy, refund/cancellation terms, grievance contact.
- Google Fonts removed (one less third party seeing users' IPs). New design.

## AI model settings (Supabase → Edge Functions → Secrets)

| Secret | What it does | Suggested |
|---|---|---|
| `GEMINI_VISION_MODEL` | Model that reads the photos (handwriting). Most important for quality. | a full Flash model, e.g. `gemini-3.5-flash` |
| `GEMINI_TEXT_MODEL` | Model that writes the summary from the reviewed data. | `gemini-3.1-flash-lite` is fine; use Flash for better prose |
| `EXTRACT_THINKING_LEVEL` | Gemini 3 thinking for reading: `low` / `high` | `high` (default) |
| `GENERATE_THINKING_LEVEL` | Thinking for writing | `low` (default) |
| `PRICES_JSON` | USD per 1M tokens so the admin cost is right, e.g. `{"gemini-3.5-flash":[0.5,3]}` | copy from Google's pricing page |

If `GEMINI_VISION_MODEL` / `GEMINI_TEXT_MODEL` are not set, both use `GEMINI_MODEL`.

## Summary length (Concise / Standard / Detailed)

Run `6-length.sql`, then redeploy `extract`, `generate` and `admin`.
Detailed counts as 2 patients (Free and Pro). Reading-thinking per length can be tuned with secrets
(the old `EXTRACT_THINKING_LEVEL` is no longer used):

| Secret | Default |
|---|---|
| `EXTRACT_THINKING_CONCISE` | `low` |
| `EXTRACT_THINKING_STANDARD` | `low` |
| `EXTRACT_THINKING_DETAILED` | `high` |
