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
| Auto-create users | On to create a local account at first login. With it off, a login succeeds only for a user already linked to this provider, or linked by auto-link. |
| Auto-link existing accounts | Off, unless you trust the tenant and every local user's email matches their Entra UPN |

### Why `preferred_username`

Entra ID ID tokens do not include an `email_verified` claim. With the `email` claim and **Require email verified** on, LayerCove discards the email, so it cannot link accounts by email and auto-created users have no email. Two configurations keep the email:

- **`preferred_username`** (recommended). Entra usually fills it with the user's UPN, for example `user@contoso.com`, but it can also hold a phone number or another username. LayerCove uses it only if it is email-shaped and skips the `email_verified` check. `upn` behaves the same way.
- **`email` with Require email verified off.** LayerCove accepts the claim unless the token explicitly marks it unverified. Use this only when you control the tenant. LayerCove refuses to enable auto-link in this configuration.

## Session length

LayerCove exchanges the OIDC code for its own token at login, so Entra's token lifetime does not affect the LayerCove session. Set the session length under **Settings → Authentication → Users → Session Policy**. The default is 24 hours.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Entra redirects back and LayerCove shows "OIDC login failed" | The redirect URI registered in Azure does not exactly match the callback URL, or **External URL** is wrong. Check the scheme, host, port, and path. |
| A user is created with an empty email | `preferred_username` is missing or not email-shaped. Try the `upn` claim, or `email` with **Require email verified** off. |
| Login fails with no linked account | **Auto-create users** is off and no local account is linked to this identity. Turn on **Auto-create users**, or **Auto-link existing accounts** if the local email matches. |
| Azure reports "invalid client" | The client secret expired or was copied incorrectly. Create a new secret and update the provider. |
| A login links to the wrong local user | Turn off **Auto-link existing accounts** until every local email matches the user's Entra UPN. |
