## Codex Usage Window Efficiency

- Read only what you need with bounded ranges: `sed -n '1,120p' path/to/file`, `head -n 50 file.log`, `tail -n 80 file.log`, `ls src | head -n 50`.
- Use bounded search commands instead of full dumps: `rg "TODO" src --max-count 30`, `rg -n "error|warn" services --max-count 20`, `rg --files docs | head -n 40`.
- In SQL, pull summaries first: `SELECT event_name, COUNT(*) AS count FROM events WHERE ts >= NOW()-INTERVAL 1 DAY GROUP BY event_name ORDER BY count DESC LIMIT 10;`.
- Ask for top-N telemetry before full rows: `SELECT user_id, COUNT(*) AS calls FROM api_calls WHERE ts >= NOW()-INTERVAL 1 HOUR GROUP BY user_id ORDER BY calls DESC LIMIT 20;`.
- Avoid broad rescans after edits: `rg "FIXME" src --max-count 50` then refine with `rg -n "FIXME|TODO" src/auth --max-count 20` instead of repeating wide scans.
- Combine related checks in one pass: `rg -n "error|exception" service.log | head -n 30` and then `tail -n 30 service.log | sed -n '1,30p'` rather than multiple open-ended reads.
- Keep output bounded by default: `rg -n "timeout" logs/app.log | head -n 40`, `printf '%s\n' "$(git diff --stat)"`, `git log --oneline -n 12`.
- Skip raw logs unless explicitly needed: prefer `rg -n "panic" logs/ --max-count 40` or `tail -n 200 logs/error.log` over `cat logs/error.log`.
- Ask for exactly the metric you need first: use "top 10 slow queries", "top 10 error classes", "top 10 spikes", not "show me all rows".
- Keep context tight in follow-up turns: summarize previous findings in 3 bullets and request the next narrow question, e.g. "show the top 5 endpoints for query X for last 24h."
