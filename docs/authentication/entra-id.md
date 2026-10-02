# Microsoft Entra ID single sign-on

This guide connects LayerCove's OIDC login to Microsoft Entra ID (formerly Azure Active Directory).

## Prerequisites

- An Azure account allowed to register applications in Entra ID.
- LayerCove authentication enabled.
- **Settings → Network → External URL** set to the address users open, for example `https://layercove.example.com`. LayerCove builds the OIDC redirect URI from it.

## 1. Register the application

1. In the [Azure portal](https://portal.azure.com), open **Entra ID → App registrations → New registration**.
2. Enter a display name, for example `LayerCove`.
3. Under **Supported account types**, choose the option that matches your organization.
4. Add a **Web** redirect URI:

   ```
   https://<your-layercove-host>/api/v1/auth/oidc/callback
   ```

5. Click **Register**.

## 2. Create a client secret

1. In the app registration, open **Certificates & secrets → Client secrets → New client secret**.
2. Choose an expiry and click **Add**.
3. Copy the secret value now. Azure shows it only once.

## 3. Collect the values

| Value | Where to find it |
|---|---|
| Issuer URL | **Overview → Endpoints**: copy the *OpenID Connect metadata document* URL and remove `/.well-known/openid-configuration`. The result looks like `https://login.microsoftonline.com/<tenant-id>/v2.0`. |
| Client ID | **Overview → Application (client) ID** |
| Client secret | The value from step 2 |

## 4. Add the provider in LayerCove

In **Settings → Authentication → SSO / OIDC**, click **Add Provider** and fill in:

| Field | Value |
|---|---|
| Display Name | `Microsoft` or any label |
| Issuer URL | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Client ID | The application (client) ID |
| Client Secret | The secret value |
| Scopes | `openid email profile` |
| Email Claim | `preferred_username` |
| Require email verified | Off |
| Auto-link existing accounts | Off, unless you trust the tenant and every local user's email matches their Entra UPN |

### Why `preferred_username`

Entra ID ID tokens do not include an `email_verified` claim, so the `email` claim with **Require email verified** on rejects every login. Two configurations work:

- **`preferred_username`** (recommended). Entra fills it with the tenant-administered UPN, for example `user@contoso.com`. LayerCove checks that it is email-shaped and skips the `email_verified` check. `upn` behaves the same way.
- **`email` with Require email verified off.** LayerCove accepts the claim unless the token explicitly marks it unverified. Use this only when you control the tenant. LayerCove refuses to enable auto-link in this configuration.

## Session length

LayerCove exchanges the OIDC code for its own token at login, so Entra's token lifetime does not affect the LayerCove session. Set the session length under **Settings → Authentication → Users → Session Policy**. The default is 24 hours.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Entra redirects back and LayerCove shows "OIDC login failed" | The redirect URI registered in Azure does not exactly match the callback URL, or **External URL** is wrong. Check the scheme, host, port, and path. |
| A user is created with an empty email | Entra did not send `preferred_username`. Try the `email` claim with **Require email verified** off. |
| Azure reports "invalid client" | The client secret expired or was copied incorrectly. Create a new secret and update the provider. |
| A login links to the wrong local user | Turn off **Auto-link existing accounts** until every local email matches the user's Entra UPN. |
