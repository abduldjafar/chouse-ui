type: patch

### Fixed
- **Alert channel "Send test" now matches real delivery** — a Google Chat webhook saved under a *Slack* channel passed "Send test" but no real breach alert ever arrived (only the in-app feed showed it). The test sent a bare `{text}` body that both providers accept, while production delivery sends provider-specific payloads (Slack Block Kit `attachments` / Google Chat `cardsV2`), which Google Chat rejects with `400` for a Slack-shaped body. The test now sends the same payload shape as real delivery, so a mismatched channel fails the test instead of giving false confidence.

### Changed
- **Notification channel type is now editable, with a webhook URL/type guard** — a channel's type can be changed while editing (the webhook URL is preserved when switching between Slack and Google Chat), so a mis-typed channel can be corrected in place instead of being deleted and recreated. Saving is blocked with a clear warning when the webhook URL's domain clearly belongs to a different provider than the selected type (a `chat.googleapis.com` URL on a Slack channel, or a `hooks.slack.com` URL on a Google Chat channel).
