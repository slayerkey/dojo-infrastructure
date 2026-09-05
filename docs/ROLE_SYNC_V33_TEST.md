## Manual test

1. Wait for Cloudflare Git Build to deploy `index-v33.js`.
2. Run `/memberroles` once.
3. The command should immediately return `Preparing a safe role sync…`, then update to either `Role sync complete` or `Role sync queued safely`.
4. Do not rerun it while queued. The cron processes up to four role mutations per minute.
5. If Discord rate-limits a mutation, the job pauses and resumes automatically on a later cron pass.
