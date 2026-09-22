# Web tool workflow

Discover schemas from the installed `web_image_bridge` server; do not translate CLI flags into invented MCP fields.
The packaged app derives all eight tools from the single versioned contract JSON.

| Tool | Purpose and recovery rule |
| --- | --- |
| `web_image_status` | Observe login, adapter, queue and verified capability state |
| `web_image_submit` | Durable admission; reuse the identical request ID and payload only for receipt replay |
| `web_image_get` | Read a Job by `job_id` or original `request_id` |
| `web_image_wait` | Observe after a revision; maximum `timeout_ms` is 30000 |
| `web_image_session` | Show/hide the existing page or transfer manual ownership with revision checks |
| `web_image_control` | Cancel local work, resume or reconcile using a fresh control request ID and current revision |
| `web_image_artifacts` | Verify and retrieve original file metadata for one Job |
| `web_image_export` | Durable copy into a registered `destination_dir`; keep the same export ID across retries |

`generate` may have reference inputs; `edit` needs one `edit_target`.
For follow-ups, include the completed parent's `session_id` and `parent_job_id` and reference its Artifact ID.
Input role and array order are distinct from the prompt and must agree with it. Read the schema for the source discriminator and permitted roles before constructing inputs.

`expected_output` controls validation, not a guaranteed web generation setting. Use `require_alpha` only when transparency is requested and `strict` only when that condition is mandatory.
`partial` can include usable original files together with unmet checks. Do not convert it into success or silently regenerate.

An app connection failure occurs before a domain response. Preserve the original request ID and query after reconnecting.
`unknown` means submission cannot be attributed safely; automatic resubmission is forbidden.
A canceled job may have `remote_may_continue: true`; this is not proof that the website stopped generation.
