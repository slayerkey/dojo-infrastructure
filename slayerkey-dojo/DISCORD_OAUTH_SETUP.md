# Training Dojo Discord OAuth setup

This is the replacement path for Whop's automatic Discord join experience.

## Goal

A member clicks one Dojo link, authorizes the Dojo Discord application, and the system:

1. learns their Discord user ID
2. verifies that exact Discord account belongs to a Whop user with current Training Dojo product access
3. adds them to the Discord server using Discord's `guilds.join` OAuth scope
4. adds the Training Dojo role
5. stores only the Whop user ID to Discord user ID mapping for future verification

No email scope is requested and no email address is needed.

## Current URLs

Connect URL:

`https://slayerkey-dojo.mystd.workers.dev/discord/connect`

Discord OAuth callback:

`https://slayerkey-dojo.mystd.workers.dev/discord/oauth/callback`

## One time Discord setup

In Discord Developer Portal for the existing Dojo Bot application:

1. Open OAuth2.
2. Add this exact Redirect URI:
   `https://slayerkey-dojo.mystd.workers.dev/discord/oauth/callback`
3. The Worker requests only these OAuth scopes:
   `identify guilds.join`
4. Do not add the `email` scope.
5. Make sure Dojo Bot has server permission to create invites and manage roles.
6. Keep the Dojo Bot role above the Training Dojo member role.

## One time Cloudflare setup

Add one Runtime Secret to the `slayerkey-dojo` Worker:

`DISCORD_CLIENT_SECRET`

Use the Client Secret from the Discord Developer Portal. Do not put it in GitHub or send it in chat.

The Worker health endpoint reports whether OAuth is configured:

`discord.oauth_join.configured`

## Whop verification behavior

The canonical verifier now prefers Whop's member access model rather than guessing access from recurring billing statuses.

Primary check:

`/members?company_id=...&product_ids=...&access_level=customer`

A `customer` access level means the Whop user currently has valid access to that product.

For an already known Whop user, the Worker also checks:

`/users/{user_id}/access/{product_id}`

This avoids treating a paid once or completed membership as invalid just because it is not a recurring `active` subscription.

Changing the dollar price or moving a member between plans under the same Whop product does not require a code change. The code is tied to the Training Dojo product ID, not the price.

Creating an entirely separate Whop product would require adding that product to the accepted access rules.

## Current identity requirement

This first OAuth version still expects the same Discord account to be connected on the member's Whop profile. That lets the Worker match:

Whop member -> connected Discord ID -> Discord OAuth user ID

This keeps the system email free and requires no custom customer database.

If we later want to remove the Whop connected Discord requirement entirely, the clean next version is to start the flow from an authenticated customer page inside Whop. Whop supplies an `x-whop-user-token` to customer app iframe requests, which can identify the Whop user before sending them through Discord OAuth. That would let the OAuth callback directly pair the authenticated Whop user with the authorized Discord account.

## Security and privacy

The Worker stores only the minimum persistent identity mapping:

`Whop user ID <-> Discord user ID`

It also stores timestamps and short lived OAuth state values.

The Discord user OAuth access token is used only during the callback to add the user to the guild and is not stored.

OAuth `state` values expire after 10 minutes and are deleted on use.

The Worker does not request Discord email access.

## Testing order

1. Keep Whop's native Discord automation enabled.
2. Add the Discord Redirect URI.
3. Add `DISCORD_CLIENT_SECRET` to Cloudflare.
4. Open `/health` and confirm `discord.oauth_join.configured` is `true`.
5. Use a test Whop member whose Discord account is connected on Whop.
6. Remove that test Discord account from the server if needed.
7. Open the Connect URL and authorize Dojo Bot.
8. Confirm Discord adds the account to the server and Dojo Bot adds the Training Dojo role.
9. Confirm the health endpoint and Discord audit log show the custom Dojo flow handling the user.
10. Only after this independent test succeeds should Whop's native Discord automation be disabled for a final cutover test.

## Existing fallback paths

Even after OAuth is enabled, keep these:

* automatic verification when Discord emits a member join event
* key reaction verification in the verification channel
* `/verify` for manual self service recovery
* `/verify-all` for owner audit and add only repair

Do not restore the old bulk destructive reconciliation logic.
