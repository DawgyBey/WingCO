# WingCO Setup and Testing

This guide runs the Python backend with Gemini and loads the Chrome extension locally.

## Requirements

- Python 3
- Google Chrome or Chromium
- A Hugging Face API key

## Configure the Python Backend

1. Check `backend/.env` and make sure `HUGGINGFACE_API_KEY` contains a valid Hugging Face API key. Set unique values for `MASTER_KEY` and `UID_SALT` if they are still placeholders. Keep this file private; it is excluded by `.gitignore`.
2. From the project root, create and activate the project virtual environment, then install the dependencies:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r backend/requirements.txt
   ```

   The virtual environment avoids installing packages into system-managed Python.

3. Start the API from the backend directory:

   ```bash
   cd backend
   uvicorn main:app --env-file .env --reload --port 8000
   ```

   Leave this terminal running. The `.env` file is loaded by Uvicorn before the app starts.

4. In Chrome, open `http://localhost:8000/docs`. The FastAPI documentation page should load while the backend is running.

## Load the Extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select the project's `extension` directory (the directory containing `manifest.json`).
5. Confirm that WingCO appears in the extensions list. Pin it from Chrome's extensions menu if you want its popup readily available.

The extension calls `http://localhost:8000`, so keep the Python backend running while testing it.

## Test a Rewrite in Chrome

1. Open a regular website with a text field, such as `https://www.google.com`. Do not use a `chrome://` page; Chrome does not run extensions on its internal pages.
2. Type a non-sensitive sample message into the search field, for example: `The report is late again. Please send the revised version by 3 PM.`
3. Click the **WingCO** button that appears beside the field.
4. Confirm that the rewrite appears in the panel. Change the tone or recipient to request another rewrite.
5. Try **Copy** or **Replace** to check those actions. The extension creates and stores its API client key locally on first use; no separate key entry is needed in the popup.

## Test the API Directly

With the backend running, use a terminal to send a test rewrite:

```bash
curl -i -X POST http://localhost:8000/rewrite \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: setup-test-client' \
  -d '{"text":"The report is late again. Please send the revised version by 3 PM.","tone":"diplomatic","recipient":"manager"}'
```

A successful request returns JSON containing `rewrite`, `remaining`, and `shared`. The text is sent to the configured Hugging Face model for processing, so use a sample rather than confidential workplace content.

## Troubleshooting

- **Can't reach WingCO server:** confirm Uvicorn is still running on port 8000, then reload the test webpage.
- **Hugging Face authentication or quota error:** check that `backend/.env` contains a valid `HUGGINGFACE_API_KEY`, then restart Uvicorn.
- **WingCO button is missing:** reload the extension on `chrome://extensions`, then reload the webpage. Check that the page has an editable text input or textarea.
- **System Python install is blocked:** activate `.venv` before running `pip install`; do not use system-wide pip or `--break-system-packages`.

The Python backend currently covers rewriting and the anonymized team dashboard. The popup's billing buttons are for the separate Node backend and are not part of this Python test flow.

## Test Unmask (Python backend)

1. `pip install -r backend/requirements.txt` again (adds `cryptography` and `stripe`), then restart Uvicorn.
2. Optional: add `DEV_UNMASK_KEYS=my-viewer` to `backend/.env` to unlock originals for free while testing. See `backend/.env.example` for the other new variables. A random encryption key is created in `backend/.message_key` on first run.
3. Reload the extension on `chrome://extensions`. Type a message, click **WingCO**, leave "Add polished by WingCO link" checked, and click **Replace**. The polished text now ends with a link.
4. Open the link. You'll see the polished message and a locked box. To see the unlock path without Stripe, run this in the page's DevTools console, then click **I've subscribed, refresh**:
   `localStorage.setItem("wingcoViewerKey", "my-viewer")`
5. Real payments need `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_UNMASK` (see the README).
