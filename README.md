# WingCO
## Run the backend
    source .venv/bin/activate
    cd backend && pip install -r requirements.txt
    # Add your HUGGINGFACE_API_KEY to backend/.env
    uvicorn main:app --env-file .env --reload --port 8000

Check the service is live:
    curl http://localhost:8000/health

Use PORT=... and BASE_URL=... if you need a custom local address without editing the app code.
## Load the extension
chrome://extensions → Developer mode → Load unpacked → select `extension/`
Click into any text box, then hit the ✨ WingCO button.
## B2B team dashboard
    export MASTER_KEY=some-secret UID_SALT=another-secret
    curl -X POST "localhost:8000/admin/orgs?name=Acme" -H "X-Master-Key: some-secret"
Returns `org_code` (give to employees, they enter it in the extension popup) and `admin_token`
(for HR/managers at http://localhost:8000/dashboard).

## Node backend (alternative to Python)
    cd backend-node && npm install
    ANTHROPIC_API_KEY=... MASTER_KEY=... UID_SALT=... npm start

Check the service is live:
    curl http://localhost:8000/health

Same endpoints and dashboard as the Python version; the extension works with either unchanged.

## Stripe billing (Node backend)
1. Stripe Dashboard → Products: create **Pro** (recurring, e.g. $6/mo) and **Team** (recurring, per seat, e.g. $5/seat/mo). Copy both price IDs.
2. Webhooks → add endpoint `https://YOUR_DOMAIN/stripe/webhook` with events `customer.subscription.created`, `.updated`, `.deleted`. Copy the signing secret.
   Local testing: `stripe listen --forward-to localhost:8000/stripe/webhook`
3. Fill in `backend-node/.env.example` values as environment variables.
4. Enable the Customer Portal in Stripe (Settings → Billing → Customer portal).
Individuals upgrade from the extension popup; company admins subscribe from /dashboard.

## Unmask (premium recipients see the original)
When a sender hits Replace with the "polished by WingCO" link checked, their original is stored
(AES-256-GCM encrypted, auto-deleted after `RETENTION_DAYS`) and a link is appended to the message.
Anyone opening `/m/<id>` sees the polished text; viewers with an active **Unmask** subscription also
see the original. The sender sees a warning in the panel first and can uncheck the link to keep the
original private, and can delete a stored message at any time.
- Encryption key: set `MESSAGE_KEY`, or leave it empty and a random key is created once in `.message_key`
  (back this file up: without it, stored originals cannot be read).
- Works on both backends. The Python backend supports the Unmask plan only; Pro/Team billing is in `backend-node`.
- Needs a recurring Stripe price (`STRIPE_PRICE_UNMASK`) plus the webhook from the Stripe section above.
