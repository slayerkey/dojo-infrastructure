# Dojo role sync v33

`/memberroles` is sync-only. It never creates roles.

The command computes only the role changes that are actually needed, then queues those mutations in the Discord gateway Durable Object. The every-minute Worker cron applies a small batch at a time. If Discord returns HTTP 429, the job pauses for Discord's `retry_after` interval and resumes on a later cron pass instead of failing or hammering the API.

This exists because the initial bulk backfill can require many role additions/removals at once, which exceeds Discord's per-route rate limit even when the role logic is correct.
