# Codex Pilot Share

Cloudflare Pages + Workers KV deployment for encrypted session sharing.

## Cloudflare bindings

部署前自行创建，绑定名按下表配置：

- Pages project: 自建项目名
- KV binding: `SHARES`
- Custom domain: 自备域名（可选）

The browser encrypts content with AES-256-GCM. The encryption key stays in the
URL fragment and is not sent to the server. KV records expire after 1, 7, or 30
days and can be revoked with a separate delete token stored in the creator's
browser.

The API also allows cross-origin requests from the Codex desktop renderer so
the injected session-share button can create links without sending plaintext.

## Limits

- Maximum plaintext length: 900,000 characters
- Maximum encrypted payload: approximately 1 MiB
- Allowed expiration: 1, 7, or 30 days
