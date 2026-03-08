# How To Login To Slack (Automation Notes)

This document captures an automation flow for Slack login in this repo.

## Tools and Inputs

- Credentials source: `rbw` entry `slack.com`
  - Email: `rbw get slack.com --field username`
  - Password: `rbw get slack.com`
  - TOTP: `rbw code slack.com`
- 2captcha API key: `/run/secrets/api_keys/twocaptcha`
- IMAP secrets file (sops-encrypted): `secrets.yaml`
- Browser automation: `agent-browser`

## Environment Notes

On this host, Playwright's bundled browser fails to launch (NixOS dynamic linker issue). Use system Chromium:

```bash
AGENT_BROWSER_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium
```

Use that env var on every `agent-browser` command.

## Working End-to-End Flow

1. Start from generic Slack sign-in:

```bash
https://slack.com/signin#/signin
```

2. Enter email and submit.
3. Solve reCAPTCHA Enterprise (Slack blocks submit until challenge is satisfied).
4. Inject solved token and submit the form.
5. Slack advances to:

```bash
https://slack.com/signin#/confirmemail
```

6. Enter email confirmation code from inbox.
   - Code format is **alphanumeric**: `XXX-XXX` (not numeric-only).
7. Open the target workspace (`links-and-pics`) and continue in browser.
8. If Slack asks for account 2FA, enter `rbw code slack.com` (6 digits).
9. After reaching `app.slack.com/client/...`, export cookies for reuse.

## 2captcha Usage (What Worked)

Slack sign-in page uses reCAPTCHA Enterprise with this observed sitekey:

- `6LcRpcIrAAAAAFAe8rv1DygnSMeBZNtDL8rhu2Ze`

Create captcha task (2captcha v1 API):

```bash
KEY="$(tr -d '\n' </run/secrets/api_keys/twocaptcha)"
PAGE="https://slack.com/signin#/signin"
SITEKEY="6LcRpcIrAAAAAFAe8rv1DygnSMeBZNtDL8rhu2Ze"
PAGE_ENC="$(jq -rn --arg x "$PAGE" '$x|@uri')"

curl -sS "https://2captcha.com/in.php?key=$KEY&method=userrecaptcha&enterprise=1&googlekey=$SITEKEY&pageurl=$PAGE_ENC&json=1"
```

Poll result:

```bash
curl -sS "https://2captcha.com/res.php?key=$KEY&action=get&id=<REQUEST_ID>&json=1"
```

When ready, response has `status=1` and token in `request`.

## Token Injection Details

Passing token directly to callback is not enough. Slack callback reads token from `grecaptcha.enterprise.getResponse()` (fallback `grecaptcha.getResponse()`).

Observed callback path:

- `window.___grecaptcha_cfg.clients["0"].D.D.callback`

Observed submit sequence:

1. Set `textarea[name="g-recaptcha-response"]` to token.
2. Monkeypatch:
   - `window.grecaptcha.enterprise.getResponse = () => token`
   - `window.grecaptcha.getResponse = () => token`
3. Invoke callback at `window.___grecaptcha_cfg.clients["0"].D.D.callback()`.
4. Submit with `form.requestSubmit()`.

## IMAP Explainer (Fetch Slack Email Code)

Slack confirm-email step sends a code to inbox. This repo keeps IMAP creds in `secrets.yaml` encrypted with sops.

### 1) Decrypt IMAP settings

```bash
dec="$(sops decrypt --output-type json /home/chuck/git/slacks-chrome/secrets.yaml)"
imap_user="$(printf '%s' "$dec" | jq -r '.imap_user')"
imap_pass="$(printf '%s' "$dec" | jq -r '.imap_pass')"
imap_server="$(printf '%s' "$dec" | jq -r '.imap_server')"
```

### 2) Poll mailbox for incoming message

```bash
curl -sS --url "imaps://$imap_server/INBOX" --user "$imap_user:$imap_pass" -X 'SEARCH ALL'
```

If empty, repeat every few seconds until at least one ID appears.

### 3) Fetch latest message body

```bash
search="$(curl -sS --url "imaps://$imap_server/INBOX" --user "$imap_user:$imap_pass" -X 'SEARCH ALL' | tr -d '\r')"
ids="${search#* SEARCH }"
latest_id="${ids##* }"
curl -sS --url "imaps://$imap_server/INBOX" --user "$imap_user:$imap_pass" -X "FETCH $latest_id BODY[]" > /tmp/latest-slack-mail.eml
```

### 4) Extract Slack confirmation code

```bash
code="$(rg -o --no-filename 'confirmation code: [A-Z0-9]{3}-[A-Z0-9]{3}' /tmp/latest-slack-mail.eml | head -n 1 | cut -d' ' -f3)"
clean_code="${code/-/}"
```

`clean_code` is the 6-character value to type into Slack `#/confirmemail` boxes.

## Cookies for Reuse

After successful login, export cookies:

```bash
AGENT_BROWSER_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium \
  agent-browser --session slacklogin2 --json cookies get > /home/chuck/git/slacks-chrome/.slack-links-and-pics-cookies.json
chmod 600 /home/chuck/git/slacks-chrome/.slack-links-and-pics-cookies.json
```

To reuse cookies in a fresh session, open:

```bash
https://app.slack.com/client/T0DBFLVJP/C0DBFM0HH
```

This can avoid re-running full login.

## Troubleshooting Notes

- Generic sign-in can stall with disabled `Sign In With Email` if captcha token was not accepted.
- If message does not arrive, use Slack `Request a new code` and poll IMAP again.
- Workspace/password route for `links-and-pics` previously returned incorrect email/password with current vault credentials.
- Generic email-code route has worked in this environment.
