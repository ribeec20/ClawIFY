AGENTS.md

## API & SDK Change Tracking

Any changes that add to or affect the API or SDK must be strictly tracked so that documentation can be updated. When making such changes, agents must:

1. Log every API/SDK-affecting change (new endpoints, modified request/response shapes, new SDK methods, changed signatures, removed or deprecated surfaces) in a dedicated tracking note before completing the task.
2. Flag the change clearly in commit messages and PR descriptions (e.g., prefix with `[API]` or `[SDK]`).
3. Do not consider an API/SDK-affecting task complete until the change has been recorded for documentation follow-up.