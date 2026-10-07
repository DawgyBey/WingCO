# WingCO

Your wingman at work: a Chrome extension that turns raw, frustrated drafts into polite, professional
messages using a **Hugging Face** model, plus an optional anonymous team dashboard, Stripe billing and
"Unmask" links.

## 1. Run the backend
```bash
cd backend
cp .env.example .env      # then fill in GROQ_API_KEY, MASTER_KEY, UID_SALT
npm install
npm start                 # http://localhost:8000
curl localhost:8000/health
```
- `GROQ_API_KEY`: key from https://console.groq.com/keys. The default `GROQ_MODEL` is `openai/gpt-oss-120b`; choose a model enabled for your Groq account.
- Hugging Face remains available as a fallback: set `HUGGINGFACE_API_KEY` (with the **Inference Providers** permission) and optionally `HF_MODEL` to a chat model available on the router, such as `Qwen/Qwen3-8B`.
  If rewrites fail with 502, check the backend log: a wrong model name or missing permission shows up there.
- Reasoning models (Qwen3 etc.) are supported: `<think>` blocks are stripped. Raise `HF_MAX_TOKENS` if they get cut off.
- Generate secrets with `openssl rand -hex 24` for `MASTER_KEY` and `UID_SALT`.

## 2. Load the extension
`chrome://extensions` → Developer mode → Load unpacked → select `extension/`.
Type in any text box (or select text) and click the **WingCO** button. Pick a tone and recipient, then
**Replace**, **Copy** or **Retry**. `Esc` closes the panel.
To use a deployed backend, change `WINGCO_BASE` in `extension/config.js` and add the origin to `host_permissions` in `manifest.json`.

## 3. Team dashboard (B2B)
```bash
curl -X POST "localhost:8000/admin/orgs?name=Acme" -H "X-Master-Key: $MASTER_KEY"
```
Returns `org_code` (employees enter it in the extension popup) and `admin_token` (HR opens
http://localhost:8000/dashboard). Only anonymous aggregates are stored, and groups under 5 people are hidden.

### Company message review
Off by default. In the dashboard → **Settings & audit log**, an admin can turn on review. Then:
- Employees entering your company code see a notice in the extension popup and **must accept it to join**; the panel also shows a banner whenever their original will be saved.
- Only messages an employee actually **replaces** are stored (encrypted, auto-deleted after `RETENTION_DAYS`); previews are never stored.
- Admins read originals under **Message review**. Each opened original, deletion and setting change is recorded in the audit log. Admins can delete messages.
- Employees can set an optional display name; otherwise they appear as a numbered member (e.g. "Member 3fa91c").
Check local privacy and employment rules (e.g. GDPR, works councils) before turning it on.

## Free tier and paywall
Individual users (no paying plan) get `FREE_TRIES` rewrites in total (default **3**), then the extension shows an upgrade card that opens Stripe Checkout. Counts are stored in SQLite per client key and per network (`TRUST_PROXY=1` behind a reverse proxy), so reinstalling the extension doesn't reset them. Failed rewrites don't count. Stripe must be configured for the upgrade button to work.

## 4. Stripe billing (optional)
1. Create recurring prices for **Pro**, **Team** (per seat) and **Unmask**; put the IDs in `.env`.
2. Add a webhook to `https://YOUR_DOMAIN/stripe/webhook` for `customer.subscription.created/updated/deleted`
   (locally: `stripe listen --forward-to localhost:8000/stripe/webhook`) and set `STRIPE_WEBHOOK_SECRET`.
3. Enable the Customer Portal in Stripe.

Without Stripe the paywall still blocks, but the upgrade button can't complete checkout. For testing, `DEV_PRO_KEYS` and `DEV_UNMASK_KEYS` unlock features for free.

## Unmask
When the sender leaves "Add a polished by WingCO link" checked, the original is stored AES-256-GCM encrypted
(deleted after `RETENTION_DAYS`) and a link is appended to the message. Anyone can read the polished text;
viewers with an active Unmask subscription also see the original. The sender is warned in the panel and
can opt out. Back up `backend/.message_key` (or set `MESSAGE_KEY`): without it, stored originals can't be read.

## Troubleshooting
- **"Can't reach the WingCO server"**: backend isn't running, or `WINGCO_BASE` doesn't match its address.
- **"Hugging Face rejected the API key or model access"**: token lacks Inference Providers permission or the model needs access approval.
- **No WingCO button**: reload the extension, then refresh the page. It appears when a text field has text or text is selected.
